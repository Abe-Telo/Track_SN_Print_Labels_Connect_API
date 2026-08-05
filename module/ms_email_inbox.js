/**
 * Microsoft returns mailbox watcher (GoDaddy cPanel / Dovecot IMAP).
 *
 * Runs INSIDE the tracking Node process on the server (not a separate AI
 * agent). On boot, setupMsEmailInbox(app) starts a timer that polls IMAP
 * every pollSeconds, parses mail, stores under db/ms_email_inbox/, and
 * best-effort updates open repair_needed.json tickets.
 *
 * Config (password NOT in git):
 *   /root/ssl/tracking_5.7/account/ms_returns_mail.json
 * Optional override: env MS_RETURNS_IMAP_PASSWORD
 *
 * APIs (console login): GET /api/ms-email/status · POST /api/ms-email/poll
 *   GET /api/ms-email/recent · POST /api/ms-email/reprocess
 */
const fs = require('fs');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { atomicWriteJsonSync } = require('./atomic_json.js');
let multer = null;
try {
  multer = require('multer');
} catch (e) {
  console.error('[ms_email] multer not loaded — EML upload API disabled', e.message);
}
let replyHooks = null;
try {
  replyHooks = require('./ms_email_replies.js');
} catch (e) {
  console.error('[ms_email] replies module not loaded', e.message);
}

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'account', 'ms_returns_mail.json');
const INBOX_DIR = path.join(ROOT, 'db', 'ms_email_inbox');
const STATE_PATH = path.join(INBOX_DIR, 'state.json');
const LABELS_DIR = path.join(INBOX_DIR, 'labels');
const REPAIR_NEEDED_PATH = path.join(ROOT, 'db', 'repair_needed.json');

let labelPrintHelpers = null;
try {
  labelPrintHelpers = require('./ms_label_print.js');
} catch (e) {
  console.error('[ms_email] ms_label_print not loaded', e.message);
}

/** MS subjects often use U+2009 thin space after case numbers. */
const WS = '[\\s\\u00a0\\u2007\\u2009\\u202f\\u3000]*';
const TRACKING_ID_RE = new RegExp(`TrackingID#${WS}(\\d{13,20})`, 'gi');
const SUPPORT_REQ_RE = new RegExp(
  `(?:support\\s+request\\s+number|case\\s+number(?:\\s+created(?:\\s+for[^:]*)?)?)${WS}(?:is)?${WS}[:#]?${WS}(\\d{16,20})`,
  'gi'
);
const CASE_HASH_RE = new RegExp(`\\bcase${WS}#${WS}(\\d{16,20})\\b`, 'gi');
const CASE_SUBJ_RE = new RegExp(`\\bCase${WS}(\\d{16,20})\\b`, 'gi');
const CASE_DOT_SUBJ_RE = /\.(\d{16,20})\s*$/;
const ORDER_BRACKET_RE = /\[Order\s+(20\d{8}|\d{10})\]/gi;
const ORDER_LABEL_RE = /\bOrder(?:\s*(?:number|No\.?|#))?\s*[:#]?\s*(20\d{8})\b/gi;
const SERVICE_ORDER_RE = /\b(?:Service\s+(?:Order|Request)|service\s+order)(?:\s+Number)?\s*[:#]?\s*(20\d{8})\b/gi;
const ORDER_LOOSE_RE = /(?:^|[^0-9])(20\d{8})(?![0-9])/g;
const UPS_RE = /\b(1Z[A-Z0-9]{16})\b/gi;
const USPS_RE = /\b((?:94|93|92|95|70|14|23|03)\d{18,22})\b/g;
const SERVICE_UPS_RE = /(?:Service\s+request|Order(?:\s+number)?)\s*[#:]?\s*(20\d{8})[^\n]{0,40}UPS\s*[:#]?\s*(1Z[A-Z0-9]{16})/gi;
// Surface serials: modern 14-char (0F/BK/0C/0D/0E/0B + 12), plus older labeled forms.
const SURFACE_SN_RE = /(?:^|[^A-Z0-9])((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})(?![A-Z0-9])/gi;
const SURFACE_SN_STRICT_RE = /^(?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}$/i;
const SURFACE_SN_LEGACY_RE = /^[0-9]{11,12}$/;
const DEVICE_BLOCK_RE = /Device\s+model\s*:\s*([^\n\r]+?)\s*Serial\s+Number\s*:\s*([0-9A-Za-z]{10,16})\s*Order\s+number\s*:\s*(20\d{8})/gi;
const CASES_PATH = path.join(INBOX_DIR, 'ms_cases.json');

/** Higher = further along MS pipeline. Email only advances, never regresses. */
const STATUS_RANK = Object.freeze({
  ms_waiting_case: 10,
  ms_case_created: 20,
  ms_waiting_approval: 25,
  ms_rejected: 25,
  ms_approved_ship_same: 30,
  ms_approved_ship_ae: 30,
  ms_ready_to_ship: 30,
  ms_same_unit: 30,
  ms_advanced_exchange: 30,
  ms_shipped_outbound: 40,
  ms_waiting_inbound: 40,
  ms_arrived_check: 50,
  ms_received_exchange: 50,
  ms_received_same: 50,
  resolved: 90,
  cannot_resolve: 90
});

let pollTimer = null;
let lastStatus = {
  enabled: false,
  ok: false,
  lastPollAt: null,
  lastError: null,
  lastSeenUid: 0,
  processed: 0
};

function ensureDirs() {
  if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR, { recursive: true });
  if (!fs.existsSync(path.join(INBOX_DIR, 'raw'))) {
    fs.mkdirSync(path.join(INBOX_DIR, 'raw'), { recursive: true });
  }
  if (!fs.existsSync(LABELS_DIR)) fs.mkdirSync(LABELS_DIR, { recursive: true });
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('ms_email_inbox loadJson', filePath, e.message);
    return fallback;
  }
}

function loadConfig() {
  const cfg = loadJson(CONFIG_PATH, null);
  if (!cfg || typeof cfg !== 'object') return null;
  const imap = (cfg.imap && typeof cfg.imap === 'object') ? cfg.imap : {};
  const smtp = (cfg.smtp && typeof cfg.smtp === 'object') ? cfg.smtp : {};
  const password = String(
    process.env.MS_RETURNS_IMAP_PASSWORD
      || cfg.password
      || ''
  ).trim();

  let host = String(
    imap.host
      || cfg.host
      || 'p3plzcpnl507148.prod.phx3.secureserver.net'
  ).trim();
  if (/^imap\.secureserver\.net$/i.test(host)) {
    host = 'p3plzcpnl507148.prod.phx3.secureserver.net';
  }

  const port = Number(imap.port || cfg.port || cfg.port_incoming || 993);
  const imapPort = port === 994 ? 993 : port;

  return {
    enabled: cfg.enabled !== false,
    user: String(cfg.user || 'ms-returns@orderassistnow.com').trim(),
    password,
    host,
    port: imapPort,
    tls: imap.tls != null ? !!imap.tls : (cfg.tls !== false),
    mailbox: String(imap.mailbox || cfg.mailbox || 'INBOX').trim(),
    pollSeconds: Math.max(60, Number(cfg.pollSeconds || 120)),
    markSeen: cfg.markSeen !== false,
    smtp: {
      enabled: smtp.enabled === true,
      host: String(smtp.host || 'mail.orderassistnow.com').trim(),
      port: Number(smtp.port || cfg.port_outgoing || cfg.port_ioutgoing || 465),
      tls: smtp.tls !== false
    }
  };
}

function loadState() {
  return loadJson(STATE_PATH, { lastUid: 0 });
}

function saveState(state) {
  atomicWriteJsonSync(STATE_PATH, state);
}

function serialKey(sn) {
  return String(sn || '').trim().toLowerCase();
}

/** Reject MIME/OCR junk that matches Surface length but is not a real SN. */
function isValidSurfaceSerial(sn) {
  const s = String(sn || '').trim().toUpperCase();
  if (SURFACE_SN_LEGACY_RE.test(s)) {
    // Older Surface numeric serials (11–12 digits). Reject tracking-like prefixes.
    if (/^(?:94|93|92|95|70|14|23|03)/.test(s)) return false;
    if (/^0+$/.test(s) || /^1+$/.test(s)) return false;
    return new Set(s.split('')).size >= 4;
  }
  if (!SURFACE_SN_STRICT_RE.test(s)) return false;
  if (/^0FZ/.test(s)) return false;
  // Low-entropy / dictionary-ish junk seen in OCR (e.g. 0F9ZREELNDAWC0)
  if (/(?:REEL|NDAW|XXXX|TEST|AAAA|0000|IIII)/i.test(s)) return false;
  const body = s.slice(2);
  const uniq = new Set(body.split(''));
  if (uniq.size < 5) return false;
  return true;
}

/** All SN identities on a ticket that can match inbound mail. */
function ticketSerialKeys(ticket) {
  const keys = new Set();
  for (const field of ['serialNumber', 'msDefectiveSerial', 'msReplacementSerial']) {
    const k = serialKey(ticket && ticket[field]);
    if (k) keys.add(k);
  }
  if (Array.isArray(ticket && ticket.msSerialHistory)) {
    for (const row of ticket.msSerialHistory) {
      const k = serialKey(row && (row.serial || row.sn));
      if (k) keys.add(k);
    }
  }
  return keys;
}

function pushSerialHistory(ticket, serial, role, at) {
  if (!ticket || !serial) return;
  const sn = String(serial).trim().toUpperCase();
  if (!isValidSurfaceSerial(sn)) return;
  if (!Array.isArray(ticket.msSerialHistory)) ticket.msSerialHistory = [];
  const last = ticket.msSerialHistory[ticket.msSerialHistory.length - 1];
  if (last && String(last.serial || '').toUpperCase() === sn && last.role === role) return;
  ticket.msSerialHistory.push({
    at: at || new Date().toISOString(),
    serial: sn,
    role: role || 'unknown'
  });
  if (ticket.msSerialHistory.length > 20) {
    ticket.msSerialHistory = ticket.msSerialHistory.slice(-20);
  }
}

/**
 * Split extracted TNs into inbound (MS→us) vs outbound/return-label (us→MS).
 */
function classifyTracking(subject, text, program, labels) {
  const blob = `${subject || ''}\n${text || ''}`;
  const low = blob.toLowerCase();
  const all = [];
  let m;
  UPS_RE.lastIndex = 0;
  while ((m = UPS_RE.exec(blob))) uniqPush(all, m[1].toUpperCase());
  USPS_RE.lastIndex = 0;
  while ((m = USPS_RE.exec(blob))) uniqPush(all, m[1]);

  const labelTns = [];
  for (const lab of labels || []) {
    if (lab && lab.trackingNumber) uniqPush(labelTns, String(lab.trackingNumber).toUpperCase());
  }

  const hasReturnLabelCue = !!(labels && labels.length)
    || /return\s+your\s+device|prepaid\s+(?:return\s+)?label|shipping\s*label|print\s+(?:the\s+)?label|return\s+service/i.test(low);
  const hasMsShippedCue = /has\s+been\s+shipped|device has shipped|your\s+(?:repaired|replaced|replacement)\s+device|on\s+its\s+way|track\s+package/i.test(low);
  const hasDeliveredCue = /has\s+been\s+delivered|package\s+has\s+been\s+delivered|order\s+is\s+complete|arriving\s+soon/i.test(low);

  const inbound = [];
  const outbound = [];
  const returnLabel = [];

  for (const tn of labelTns) {
    uniqPush(outbound, tn);
    uniqPush(returnLabel, tn);
  }

  for (const tn of all) {
    if (labelTns.includes(tn)) continue;
    if (hasReturnLabelCue && !hasMsShippedCue && program === 'same_unit_repair') {
      uniqPush(outbound, tn);
      uniqPush(returnLabel, tn);
    } else if (hasMsShippedCue || hasDeliveredCue || program === 'advanced_exchange') {
      uniqPush(inbound, tn);
    } else if (hasReturnLabelCue) {
      uniqPush(outbound, tn);
      uniqPush(returnLabel, tn);
    } else {
      // Default: MS shipment notices are inbound; bare TN without cues stays inbound
      uniqPush(inbound, tn);
    }
  }

  return { tracking: all, trackingInbound: inbound, trackingOutbound: outbound, returnLabelTracking: returnLabel };
}

/** Second SN mentioned as replacement / exchange unit (not a sibling defective). */
function extractReplacementSerials(blob, knownSerials) {
  const text = String(blob || '');
  const out = [];
  const patterns = [
    /replacement\s+(?:device|unit|serial(?:\s+number)?)\s*[:#]?\s*((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})/gi,
    /new\s+serial(?:\s+number)?\s*[:#]?\s*((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})/gi,
    /exchanged\s+for\s+(?:serial(?:\s+number)?\s*)?[:#]?\s*((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})/gi,
    /serial\s+number\s+of\s+the\s+replacement\s*[:#]?\s*((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})/gi,
    /replaced\s+with\s+device\s+((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})/gi
  ];
  const known = new Set((knownSerials || []).map((s) => String(s).toUpperCase()));
  for (const re of patterns) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const sn = String(m[1] || '').toUpperCase();
      if (!isValidSurfaceSerial(sn)) continue;
      if (known.has(sn)) continue;
      uniqPush(out, sn);
    }
  }
  return out;
}

function cleanCaseRegistryDevices(entry) {
  if (!entry || !Array.isArray(entry.devices)) return;
  const bySn = new Map();
  const kept = [];
  for (const d of entry.devices) {
    if (!d) continue;
    const sn = d.serialNumber ? String(d.serialNumber).toUpperCase() : null;
    const order = d.orderNumber ? String(d.orderNumber) : null;
    if (!sn && !order) continue;
    if (sn && !isValidSurfaceSerial(sn) && !/^[0-9A-Z]{8,20}$/i.test(sn)) continue;
    if (sn) {
      const prev = bySn.get(sn);
      if (prev) {
        if (!prev.orderNumber && order) prev.orderNumber = order;
        if (!prev.inboundTracking && d.inboundTracking) prev.inboundTracking = d.inboundTracking;
        if (!prev.outboundTracking && d.outboundTracking) prev.outboundTracking = d.outboundTracking;
        if (!prev.replacementSerial && d.replacementSerial) prev.replacementSerial = d.replacementSerial;
        if (!prev.model && d.model) prev.model = d.model;
        continue;
      }
      bySn.set(sn, d);
    }
    kept.push(d);
  }
  entry.devices = kept;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build searchable text from mailparser result + raw MIME (HTML often only in raw). */
function emailSearchText(parsedMail, sourceBuf) {
  const parts = [
    parsedMail.subject || '',
    parsedMail.text || '',
    stripHtml(parsedMail.html || '')
  ];
  if (parsedMail.attachments && Array.isArray(parsedMail.attachments)) {
    for (const att of parsedMail.attachments) {
      if (att.contentType && /text\//i.test(att.contentType) && att.content) {
        parts.push(String(att.content));
      }
    }
  }
  let blob = parts.join('\n');
  if (sourceBuf && sourceBuf.length) {
    // Prefer decoded-ish views: run stripHtml on full raw (may be large)
    const rawView = stripHtml(sourceBuf.toString('utf8'));
    if (rawView) blob += `\n${rawView}`;
  }
  return blob;
}

function uniqPush(arr, value) {
  const v = String(value || '').trim();
  if (!v || arr.includes(v)) return;
  arr.push(v);
}

/** Drop soft-wrap truncated case IDs that are prefixes of a longer real case. */
function normalizeCaseIds(cases) {
  const cleaned = [...new Set((cases || []).map((c) => String(c || '').trim()).filter((c) => /^\d{16,20}$/.test(c)))];
  cleaned.sort((a, b) => b.length - a.length || a.localeCompare(b));
  const out = [];
  for (const c of cleaned) {
    if (out.some((keep) => keep.startsWith(c) && keep !== c)) continue;
    out.push(c);
  }
  return out.sort();
}

/**
 * MS often sends structured "Order details" blocks — one per device.
 * A single case email can list several devices (each with its own order/SN).
 */
function extractDeviceBlocks(blob) {
  // Undo leftover quoted-printable soft wraps that survive raw MIME merge
  const cleaned = String(blob || '').replace(/=\r?\n/g, '').replace(/=\s+(?=[A-Z0-9])/g, '');
  const devices = [];
  const seen = new Set();
  let m;
  DEVICE_BLOCK_RE.lastIndex = 0;
  while ((m = DEVICE_BLOCK_RE.exec(cleaned))) {
    const serialNumber = String(m[2] || '').toUpperCase();
    if (!isValidSurfaceSerial(serialNumber)) continue;
    const orderNumber = m[3];
    const key = `${serialNumber}|${orderNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    devices.push({
      model: String(m[1] || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      serialNumber,
      orderNumber,
      inboundTracking: null
    });
  }

  // Flat agent table:
  //   Serial Number Device model Order Number
  //   005972510657 SURFACE LAPTOP 4 ... 2035693031
  {
    const flatRe = /((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})\s+(SURFACE[^\n\r]{3,120}?)\s+(20\d{8})/gi;
    let fm;
    while ((fm = flatRe.exec(cleaned))) {
      const serialNumber = String(fm[1] || '').toUpperCase();
      if (!isValidSurfaceSerial(serialNumber)) continue;
      const model = String(fm[2] || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const orderNumber = fm[3];
      const key = `${serialNumber}|${orderNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      devices.push({ model, serialNumber, orderNumber, inboundTracking: null });
    }
  }

  // "Order 2034970130 Original device SN1 replaced with device SN2"
  {
    const replRe = /Order\s+(20\d{8})\s+Original\s+device\s+((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})\s+replaced\s+with\s+device\s+((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})/gi;
    let rm;
    while ((rm = replRe.exec(cleaned))) {
      const orderNumber = rm[1];
      const defective = String(rm[2] || '').toUpperCase();
      const replacement = String(rm[3] || '').toUpperCase();
      for (const serialNumber of [defective, replacement]) {
        if (!isValidSurfaceSerial(serialNumber)) continue;
        const key = `${serialNumber}|${orderNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        devices.push({
          model: null,
          serialNumber,
          orderNumber,
          inboundTracking: null,
          role: serialNumber === replacement ? 'replacement' : 'defective'
        });
      }
    }
  }

  // Compact multi-device form:
  //   Serial Number: SN1 - SN2 - SN3
  //   Order number:\n204...\n204...
  if (!devices.length) {
    const snLine = cleaned.match(
      /Serial\s+Numbers?\s*:\s*((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}(?:\s*[-–,\/]\s*(?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12})+)/i
    );
    const orderBlock = cleaned.match(
      /Order\s+numbers?\s*:\s*([\s\S]{0,400}?)(?:\n\s*\n|You must ship|SHIP TO|If the devices|$)/i
    );
    const sns = [];
    const ords = [];
    if (snLine) {
      const chunk = snLine[1];
      const snRe = /(?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12}/gi;
      let sm;
      while ((sm = snRe.exec(chunk))) uniqPush(sns, sm[0].toUpperCase());
    }
    if (orderBlock) {
      const oRe = /(?:^|[^0-9])(20\d{8})(?![0-9])/g;
      let om;
      while ((om = oRe.exec(orderBlock[1]))) uniqPush(ords, om[1]);
    }
    if (sns.length >= 2 && ords.length && sns.length === ords.length) {
      for (let i = 0; i < sns.length; i += 1) {
        const key = `${sns[i]}|${ords[i]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        devices.push({
          model: null,
          serialNumber: sns[i],
          orderNumber: ords[i],
          inboundTracking: null
        });
      }
    } else if (sns.length >= 2 && ords.length === 1) {
      for (const sn of sns) {
        const key = `${sn}|${ords[0]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        devices.push({
          model: null,
          serialNumber: sn,
          orderNumber: ords[0],
          inboundTracking: null
        });
      }
    }
  }

  // Flattened HTML table rows: Model \n Order \n Serial (MS often swaps header order)
  {
    const tableRe = /(SURFACE[^\n\r]{5,140})\s*[\r\n]+\s*(20\d{8})\s*[\r\n]+\s*((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})/gi;
    let tm;
    while ((tm = tableRe.exec(cleaned))) {
      const model = String(tm[1] || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const orderNumber = tm[2];
      const serialNumber = String(tm[3] || '').toUpperCase();
      if (!isValidSurfaceSerial(serialNumber)) continue;
      const key = `${serialNumber}|${orderNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Replace a prior SN-only stub for this serial
      const stubIdx = devices.findIndex(
        (d) => d.serialNumber === serialNumber && !d.orderNumber
      );
      if (stubIdx >= 0) devices.splice(stubIdx, 1);
      devices.push({
        model,
        serialNumber,
        orderNumber,
        inboundTracking: null
      });
    }
  }

  // Agent freeform notes (common in case threads):
  //   Surface Laptop 2 - 1TB i7 16GB 024192394357 Wont Turn On
  //   Surface Laptop 4 - 15 in. i7/16/512 039535310457 Bottom screen flickering
  {
    const noteRe = /Surface[\w\s.\-\/()]{2,80}?\s+((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})(?![0-9A-Z])/gi;
    let nm;
    while ((nm = noteRe.exec(cleaned))) {
      const serialNumber = String(nm[1] || '').toUpperCase();
      if (!isValidSurfaceSerial(serialNumber)) continue;
      const model = String(nm[0] || '')
        .replace(new RegExp(`${serialNumber}.*$`, 'i'), '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
      const key = `${serialNumber}|`;
      if (devices.some((d) => d.serialNumber === serialNumber)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      devices.push({
        model: model || null,
        serialNumber,
        orderNumber: null,
        inboundTracking: null
      });
    }
  }

  // HTML / plain "Serial Number: 003647115266" (label emails, tables)
  {
    const snLabelRe = /Serial\s+Number\s*[:|]+\s*((?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}|[0-9]{11,12})/gi;
    let sm;
    while ((sm = snLabelRe.exec(cleaned))) {
      const serialNumber = String(sm[1] || '').toUpperCase();
      if (!isValidSurfaceSerial(serialNumber)) continue;
      if (devices.some((d) => d.serialNumber === serialNumber)) continue;
      const key = `${serialNumber}|`;
      if (seen.has(key)) continue;
      seen.add(key);
      devices.push({
        model: null,
        serialNumber,
        orderNumber: null,
        inboundTracking: null
      });
    }
  }

  SERVICE_UPS_RE.lastIndex = 0;
  while ((m = SERVICE_UPS_RE.exec(cleaned))) {
    const orderNumber = m[1];
    const inboundTracking = String(m[2] || '').toUpperCase();
    const hit = devices.find((d) => d.orderNumber === orderNumber);
    if (hit) hit.inboundTracking = inboundTracking;
    else if (!seen.has(`|${orderNumber}`)) {
      seen.add(`|${orderNumber}`);
      devices.push({
        model: null,
        serialNumber: null,
        orderNumber,
        inboundTracking
      });
    }
  }
  return devices;
}

function extractFields(subject, text) {
  // Normalize exotic unicode spaces so case/order regexes stay reliable.
  const blob = `${subject || ''}\n${text || ''}`.replace(/[\u00a0\u2007\u2009\u202f\u3000]/g, ' ');
  const cases = [];
  const orders = [];
  const serials = [];
  let m;

  TRACKING_ID_RE.lastIndex = 0;
  while ((m = TRACKING_ID_RE.exec(blob))) {
    if (m[1].length >= 16) uniqPush(cases, m[1]);
  }
  SUPPORT_REQ_RE.lastIndex = 0;
  while ((m = SUPPORT_REQ_RE.exec(blob))) uniqPush(cases, m[1]);
  CASE_HASH_RE.lastIndex = 0;
  while ((m = CASE_HASH_RE.exec(blob))) uniqPush(cases, m[1]);
  CASE_SUBJ_RE.lastIndex = 0;
  while ((m = CASE_SUBJ_RE.exec(blob))) uniqPush(cases, m[1]);
  const dotCase = String(subject || '').match(CASE_DOT_SUBJ_RE);
  if (dotCase) uniqPush(cases, dotCase[1]);

  ORDER_BRACKET_RE.lastIndex = 0;
  while ((m = ORDER_BRACKET_RE.exec(blob))) uniqPush(orders, m[1]);
  ORDER_LABEL_RE.lastIndex = 0;
  while ((m = ORDER_LABEL_RE.exec(blob))) uniqPush(orders, m[1]);
  SERVICE_ORDER_RE.lastIndex = 0;
  while ((m = SERVICE_ORDER_RE.exec(blob))) uniqPush(orders, m[1]);
  ORDER_LOOSE_RE.lastIndex = 0;
  while ((m = ORDER_LOOSE_RE.exec(blob))) {
    if (cases.some((c) => c.includes(m[1]))) continue;
    uniqPush(orders, m[1]);
  }

  SURFACE_SN_RE.lastIndex = 0;
  while ((m = SURFACE_SN_RE.exec(blob))) {
    const sn = m[1].toUpperCase();
    if (!isValidSurfaceSerial(sn)) continue;
    // Loose legacy digits are too noisy (SEMI tool IDs, phone fragments).
    // Only accept them from structured device/label parsers below.
    if (SURFACE_SN_LEGACY_RE.test(sn)) continue;
    uniqPush(serials, sn);
  }

  const devices = extractDeviceBlocks(blob);
  for (const d of devices) {
    if (d.serialNumber && isValidSurfaceSerial(d.serialNumber)) uniqPush(serials, d.serialNumber);
    else if (d.serialNumber && !isValidSurfaceSerial(d.serialNumber)) d.serialNumber = null;
    if (d.orderNumber) uniqPush(orders, d.orderNumber);
  }

  const normalizedCases = normalizeCaseIds(cases);
  // Drop SN false-positives that are prefixes of case IDs in the same mail
  // (e.g. 240822004001 carved out of TrackingID#2408220040011793).
  function snLooksLikeCaseFragment(sn) {
    const s = String(sn || '');
    return normalizedCases.some((c) => c === s || c.startsWith(s) || (s.length >= 10 && c.includes(s)));
  }
  for (let i = serials.length - 1; i >= 0; i -= 1) {
    if (snLooksLikeCaseFragment(serials[i])) serials.splice(i, 1);
  }
  for (const d of devices) {
    if (d.serialNumber && snLooksLikeCaseFragment(d.serialNumber)) d.serialNumber = null;
  }

  const replacementSerials = extractReplacementSerials(blob, serials);
  // Keep replacement SNs out of primary serials so they don't open sibling tickets
  const replSet = new Set(replacementSerials.map((s) => String(s).toUpperCase()));
  const primarySerials = serials.filter((s) => !replSet.has(String(s).toUpperCase()));
  // If email only named a replacement SN (rare), still keep it visible
  if (!primarySerials.length && replacementSerials.length) {
    for (const sn of replacementSerials) uniqPush(primarySerials, sn);
  }

  const low = blob.toLowerCase();
  let program = null;
  if (/advanced\s*exchange/.test(low)) {
    program = 'advanced_exchange';
  } else if (/same[-\s]?unit|mail[-\s]?in\s+repair/.test(low)) {
    program = 'same_unit_repair';
  } else if (/replacement\s+device|replacement\s+unit/.test(low)
    && !/has\s+been\s+delivered|arriving\s+soon|order\s+is\s+complete/.test(low)) {
    program = 'advanced_exchange';
  }

  // Provisional classify without labels (labels merged later)
  const tracked = classifyTracking(subject, text, program, []);
  for (const d of devices) {
    if (d.inboundTracking) uniqPush(tracked.trackingInbound, String(d.inboundTracking).toUpperCase());
  }

  let suggestStatus = null;
  if (/\b(not\s+eligible|warranty\s+(?:is\s+)?denied|claim\s+denied|case\s+was\s+rejected|fraudulent\s+claim)\b/.test(low)
    || /\b(rejected|denial)\b.{0,40}\b(warranty|claim|case)\b/.test(low)
    || /\b(warranty|claim|case)\b.{0,40}\b(rejected|denial)\b/.test(low)) {
    suggestStatus = 'ms_rejected';
  } else if (/has\s+been\s+delivered|package\s+has\s+been\s+delivered|delivered\s+to\s+(?:you|your)/.test(low)
    || /order\s+number[:\s]+\d+\s+should\s+be\s+arriving\s+soon/.test(low)
    || /should\s+be\s+arriving\s+soon/.test(low)) {
    suggestStatus = program === 'advanced_exchange' ? 'ms_received_exchange' : 'ms_arrived_check';
  } else if (program === 'advanced_exchange' && (tracked.trackingInbound.length || tracked.tracking.length)) {
    suggestStatus = 'ms_waiting_inbound';
  } else if (program === 'same_unit_repair' && (/label|prepaid|print|return\s+your\s+device/.test(low) || orders.length)) {
    suggestStatus = 'ms_approved_ship_same';
  } else if (/has\s+shipped|on\s+its\s+way|tracking\s+number/.test(low)
    && (tracked.trackingInbound.length || tracked.tracking.length)) {
    suggestStatus = 'ms_waiting_inbound';
  } else if (
    (/your\s+question\s+was\s+succe|case\s+(?:created|opened)|support\s+request|service\s+order/.test(low)
      || /TrackingID#/i.test(blob))
    && normalizedCases.length
  ) {
    suggestStatus = 'ms_case_created';
  }

  return {
    cases: normalizedCases,
    orders,
    tracking: tracked.tracking.slice(),
    trackingInbound: tracked.trackingInbound.slice(),
    trackingOutbound: tracked.trackingOutbound.slice(),
    returnLabelTracking: tracked.returnLabelTracking.slice(),
    program,
    suggestStatus,
    serials: primarySerials,
    replacementSerials,
    devices,
    labels: []
  };
}

function safeLabelFilename(name) {
  return String(name || 'ShippingLabel.pdf')
    .replace(/[^\w.\-()+\s]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'ShippingLabel.pdf';
}

function isShippingLabelAttachment(att) {
  if (!att) return false;
  const name = String(att.filename || '').toLowerCase();
  const type = String(att.contentType || '').toLowerCase();
  const isPdf = type.includes('pdf') || name.endsWith('.pdf');
  if (!isPdf) return false;
  // MS uses Order_Serial-ShippingLabel.pdf; also catch generic label PDFs
  if (/shipping\s*label|shippinglabel|return.?label|prepaid|postage|ups.?label/.test(name.replace(/[_\s-]+/g, ''))) {
    return true;
  }
  // Large PDF on a "return your device" mail is almost always the label
  const size = (att.content && att.content.length) || 0;
  return size > 20000;
}

function parseLabelFilename(filename) {
  const base = String(filename || '');
  let order = null;
  let serial = null;
  // 2046523028_0F3DGWV24493HJ-ShippingLabel.pdf
  // Also legacy: 2013106234_003647115266-ShippingLabel.pdf / 0B…
  const snPart = '((?:0F|BK|0C|0D|0E|0B)[0-9A-Za-z]{12}|[0-9]{11,12})';
  let m = base.match(new RegExp(`^(20\\d{8})_${snPart}[-_].*\\.pdf$`, 'i'));
  if (m) {
    const sn = m[2].toUpperCase();
    return { order: m[1], serial: isValidSurfaceSerial(sn) ? sn : null };
  }
  m = base.match(new RegExp(`${snPart}[-_]ShippingLabel\\.pdf$`, 'i'));
  if (m) {
    const sn = m[1].toUpperCase();
    if (isValidSurfaceSerial(sn)) serial = sn;
  }
  // Order-only / renamed: 2045417131.pdf, abe-2045880011.pdf
  m = base.match(/(?:^|[^0-9])(20\d{8})(?:[^0-9]|$)/);
  if (m) order = m[1];
  if (!serial) {
    m = base.match(new RegExp(snPart, 'i'));
    if (m) {
      const sn = m[1].toUpperCase();
      if (isValidSurfaceSerial(sn)) serial = sn;
    }
  }
  return { order, serial };
}

/**
 * Fill missing SN/order/TN from the label PDF itself (OCR).
 * MS letter PDFs are vector art — filename often has order+SN but not UPS TN.
 */
function enrichLabelFromPdfContent(lab, fullPath) {
  if (!lab) return lab;
  // Always OCR when tracking is missing (filename rarely includes the 1Z).
  if (lab.serialNumber && lab.orderNumber && lab.trackingNumber) return lab;
  if (!labelPrintHelpers || typeof labelPrintHelpers.extractShippingLabelIds !== 'function') {
    return lab;
  }
  try {
    const ocr = labelPrintHelpers.extractShippingLabelIds(fullPath);
    if (!lab.orderNumber && ocr.order) lab.orderNumber = ocr.order;
    if (!lab.serialNumber && ocr.serial) lab.serialNumber = ocr.serial;
    if (!lab.trackingNumber && ocr.tracking) lab.trackingNumber = ocr.tracking;
    lab.ocrScore = ocr.score || 0;
    lab.ocrSource = ocr.source || null;
  } catch (e) {
    console.error('[ms_email] label OCR', lab.id || lab.filename, e.message);
  }
  return lab;
}

/**
 * Save shipping-label PDF attachments from a parsed mail.
 * Returns label metadata objects (relative to INBOX_DIR/labels).
 */
function extractAndSaveLabels(parsedMail, uid) {
  ensureDirs();
  const labels = [];
  const atts = parsedMail.attachments || [];
  let idx = 0;
  for (const att of atts) {
    if (!isShippingLabelAttachment(att)) continue;
    if (!att.content || !att.content.length) continue;
    idx += 1;
    const original = safeLabelFilename(att.filename || `ShippingLabel-${uid}-${idx}.pdf`);
    const id = `lbl-u${uid}-${idx}`;
    const storedName = `${id}_${original}`;
    const fullPath = path.join(LABELS_DIR, storedName);
    fs.writeFileSync(fullPath, att.content);
    const fromName = parseLabelFilename(att.filename || original);
    const lab = {
      id,
      filename: original,
      storedName,
      uid: Number(uid),
      size: att.content.length,
      contentType: att.contentType || 'application/pdf',
      orderNumber: fromName.order,
      serialNumber: fromName.serial,
      trackingNumber: null,
      at: new Date().toISOString(),
      downloadPath: `/api/ms-email/labels/${encodeURIComponent(id)}`
    };
    enrichLabelFromPdfContent(lab, fullPath);
    labels.push(lab);
  }
  return labels;
}

/** Push SN/order/TN discovered on labels into the email field sets. */
function mergeLabelFieldsIntoParsed(fields) {
  if (!fields) return fields;
  if (!Array.isArray(fields.serials)) fields.serials = [];
  if (!Array.isArray(fields.orders)) fields.orders = [];
  if (!Array.isArray(fields.tracking)) fields.tracking = [];
  if (!Array.isArray(fields.trackingInbound)) fields.trackingInbound = [];
  if (!Array.isArray(fields.trackingOutbound)) fields.trackingOutbound = [];
  if (!Array.isArray(fields.returnLabelTracking)) fields.returnLabelTracking = [];
  if (!Array.isArray(fields.devices)) fields.devices = [];
  if (!Array.isArray(fields.replacementSerials)) fields.replacementSerials = [];

  for (const lab of fields.labels || []) {
    if (lab.serialNumber && isValidSurfaceSerial(lab.serialNumber)) {
      uniqPush(fields.serials, String(lab.serialNumber).toUpperCase());
    } else if (lab.serialNumber && !isValidSurfaceSerial(lab.serialNumber)) {
      lab.serialNumber = null;
    }
    if (lab.orderNumber) uniqPush(fields.orders, String(lab.orderNumber));
    // Prepaid MS return labels are outbound (us → MS)
    if (lab.trackingNumber) {
      const tn = String(lab.trackingNumber).toUpperCase();
      uniqPush(fields.tracking, tn);
      uniqPush(fields.trackingOutbound, tn);
      uniqPush(fields.returnLabelTracking, tn);
      lab.trackingDirection = 'outbound';
    }
    if (lab.serialNumber && lab.orderNumber) {
      const sn = String(lab.serialNumber).toUpperCase();
      const existing = fields.devices.find((d) => String(d.serialNumber || '').toUpperCase() === sn);
      if (existing) {
        if (!existing.orderNumber) existing.orderNumber = lab.orderNumber;
        if (!existing.outboundTracking && lab.trackingNumber) {
          existing.outboundTracking = lab.trackingNumber;
        }
      } else {
        fields.devices.push({
          serialNumber: sn,
          orderNumber: lab.orderNumber,
          inboundTracking: null,
          outboundTracking: lab.trackingNumber || null,
          model: null
        });
      }
    }
  }

  // Re-classify with labels so subject cues + label TNs land in the right buckets
  const reclass = classifyTracking(
    '',
    `${(fields.tracking || []).join(' ')}`,
    fields.program,
    fields.labels || []
  );
  // Prefer explicit outbound from labels; keep prior inbound from body
  for (const tn of reclass.trackingOutbound) uniqPush(fields.trackingOutbound, tn);
  for (const tn of reclass.returnLabelTracking) uniqPush(fields.returnLabelTracking, tn);
  // Drop outbound TNs from inbound list
  const outSet = new Set(fields.trackingOutbound.map(String));
  fields.trackingInbound = (fields.trackingInbound || []).filter((tn) => !outSet.has(String(tn)));
  if ((fields.labels || []).length && !fields.suggestStatus) {
    fields.suggestStatus = 'ms_approved_ship_same';
    if (!fields.program) fields.program = 'same_unit_repair';
  }
  return fields;
}

function canAdvanceStatus(fromStatus, toStatus) {
  if (!toStatus) return false;
  if (!fromStatus) return true;
  const a = STATUS_RANK[fromStatus] || 0;
  const b = STATUS_RANK[toStatus] || 0;
  // Allow lateral moves within same rank (e.g. rejected ↔ waiting approval)
  return b >= a && toStatus !== 'resolved' && toStatus !== 'cannot_resolve';
}

function isoDate(value) {
  if (!value) return null;
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch (_) {
    return null;
  }
}

function emailDateLabel(meta) {
  const emailAt = isoDate(meta && meta.emailDate);
  const processedAt = isoDate(meta && meta.processedAt) || new Date().toISOString();
  if (emailAt) {
    return `email ${emailAt.slice(0, 10)} · processed ${processedAt.slice(0, 19).replace('T', ' ')}Z`;
  }
  return `processed ${processedAt.slice(0, 19).replace('T', ' ')}Z`;
}

function pushEmailEvent(ticket, meta, changes) {
  if (!Array.isArray(ticket.msEmailEvents)) ticket.msEmailEvents = [];
  ticket.msEmailEvents.push({
    at: isoDate(meta && meta.processedAt) || new Date().toISOString(),
    emailDate: isoDate(meta && meta.emailDate),
    subject: String((meta && meta.subject) || '').slice(0, 300),
    from: String((meta && meta.from) || '').slice(0, 200),
    uid: meta && meta.uid != null ? Number(meta.uid) : null,
    changes: (changes || []).slice(0, 40)
  });
  // Keep last 40 events
  if (ticket.msEmailEvents.length > 40) {
    ticket.msEmailEvents = ticket.msEmailEvents.slice(-40);
  }
}

function mergeLabelsOntoTicket(ticket, labels, changes) {
  if (!labels || !labels.length) return;
  if (!Array.isArray(ticket.msShippingLabels)) ticket.msShippingLabels = [];
  for (const lab of labels) {
    const sameName = (x) => String(x.filename || '').toLowerCase() === String(lab.filename || '').toLowerCase();
    if (ticket.msShippingLabels.some((x) => x.id === lab.id || sameName(x))) continue;
    ticket.msShippingLabels.push({
      id: lab.id,
      filename: lab.filename,
      storedName: lab.storedName,
      uid: lab.uid,
      size: lab.size,
      at: lab.at,
      downloadPath: lab.downloadPath
    });
    changes.push(`label=${lab.filename}`);
  }
}

function inferStatusFromParsed(parsed, meta) {
  if (parsed.suggestStatus) return parsed.suggestStatus;
  if (parsed.labels && parsed.labels.length) return 'ms_approved_ship_same';
  if (/label|return your device/i.test((meta && meta.subject) || '')) return 'ms_approved_ship_same';
  if (parsed.cases && parsed.cases.length) return 'ms_case_created';
  return 'ms_waiting_case';
}

function loadCaseRegistry() {
  const data = loadJson(CASES_PATH, {});
  return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}

function saveCaseRegistry(reg) {
  if (reg && typeof reg === 'object') {
    for (const entry of Object.values(reg)) cleanCaseRegistryDevices(entry);
  }
  atomicWriteJsonSync(CASES_PATH, reg);
}

function ensureCaseEntry(reg, caseId) {
  const id = String(caseId || '').trim();
  if (!id) return null;
  if (!reg[id]) {
    reg[id] = {
      caseId: id,
      relatedCases: [],
      devices: [],
      orders: [],
      serials: [],
      tracking: [],
      events: [],
      updatedAt: null
    };
  }
  return reg[id];
}

function upsertCaseDevice(entry, device) {
  if (!entry || !device) return;
  const sn = device.serialNumber ? String(device.serialNumber).toUpperCase() : null;
  const order = device.orderNumber ? String(device.orderNumber) : null;
  let row = null;
  if (sn) row = entry.devices.find((d) => String(d.serialNumber || '').toUpperCase() === sn);
  if (!row && order) {
    // Prefer merging into an existing SN row for this order; else reuse empty-SN placeholder
    row = entry.devices.find((d) => String(d.orderNumber || '') === order && d.serialNumber)
      || entry.devices.find((d) => String(d.orderNumber || '') === order && !d.serialNumber);
  }
  if (!row) {
    row = {
      serialNumber: sn,
      orderNumber: order,
      inboundTracking: device.inboundTracking || null,
      model: device.model || null,
      program: device.program || null,
      labelFilenames: []
    };
    entry.devices.push(row);
  }
  if (sn) row.serialNumber = sn;
  if (order) row.orderNumber = order;
  if (device.inboundTracking) row.inboundTracking = device.inboundTracking;
  if (device.model) row.model = device.model;
  if (device.program) {
    // Prefer explicit same-unit / AE from order emails over weaker guesses
    const rank = { same_unit_repair: 3, advanced_exchange: 2 };
    const next = rank[device.program] || 1;
    const prev = rank[row.program] || 0;
    if (!row.program || next >= prev) row.program = device.program;
  }
  if (device.labelFilename) {
    if (!Array.isArray(row.labelFilenames)) row.labelFilenames = [];
    if (!row.labelFilenames.includes(device.labelFilename)) row.labelFilenames.push(device.labelFilename);
  }
  // Drop duplicate empty-SN placeholders for the same order once SN is known
  if (row.serialNumber && order) {
    entry.devices = entry.devices.filter((d) =>
      d === row || !(String(d.orderNumber || '') === order && !d.serialNumber)
    );
  }
}

/**
 * Persist case → devices / orders / tracking across emails.
 * One MS case can cover multiple devices (separate SNs + orders).
 */
function updateCaseRegistry(parsed, meta) {
  const reg = loadCaseRegistry();
  const now = isoDate(meta && meta.processedAt) || new Date().toISOString();
  const caseIds = normalizeCaseIds(parsed.cases || []);
  const primary = caseIds[0] || null;

  // Index orphan orders/serials under primary case when known; else under order-key buckets
  const targets = caseIds.length
    ? caseIds.map((id) => ensureCaseEntry(reg, id))
    : [];

  // Cross-link related cases mentioned together
  for (const a of caseIds) {
    const entry = ensureCaseEntry(reg, a);
    for (const b of caseIds) {
      if (a === b) continue;
      if (!entry.relatedCases.includes(b)) entry.relatedCases.push(b);
    }
  }

  const deviceList = [];
  if (parsed.devices && parsed.devices.length) {
    for (const d of parsed.devices) {
      deviceList.push({
        serialNumber: d.serialNumber,
        orderNumber: d.orderNumber,
        inboundTracking: d.inboundTracking,
        model: d.model,
        program: parsed.program || null
      });
    }
  } else {
    // Fall back: pair first SN/order/TN when only one of each
    const sn = (parsed.serials && parsed.serials[0]) || null;
    const order = (parsed.orders && parsed.orders[0]) || null;
    const tn = (parsed.tracking && parsed.tracking[0]) || null;
    if (sn || order) {
      deviceList.push({
        serialNumber: sn,
        orderNumber: order,
        inboundTracking: tn,
        model: null,
        program: parsed.program || null
      });
    }
  }

  for (const lab of parsed.labels || []) {
    deviceList.push({
      serialNumber: lab.serialNumber,
      orderNumber: lab.orderNumber,
      inboundTracking: null,
      model: null,
      program: parsed.program || null,
      labelFilename: lab.filename
    });
  }

  for (const entry of targets) {
    if (!entry) continue;
    for (const d of deviceList) upsertCaseDevice(entry, d);
    for (const o of parsed.orders || []) uniqPush(entry.orders, o);
    for (const s of parsed.serials || []) uniqPush(entry.serials, String(s).toUpperCase());
    for (const t of parsed.tracking || []) uniqPush(entry.tracking, t);
    entry.updatedAt = now;
    if (!Array.isArray(entry.events)) entry.events = [];
    entry.events.push({
      at: now,
      emailDate: isoDate(meta && meta.emailDate),
      uid: meta && meta.uid != null ? Number(meta.uid) : null,
      subject: String((meta && meta.subject) || '').slice(0, 300),
      orders: (parsed.orders || []).slice(0, 10),
      serials: (parsed.serials || []).slice(0, 10),
      tracking: (parsed.tracking || []).slice(0, 10)
    });
    if (entry.events.length > 50) entry.events = entry.events.slice(-50);
  }

  // Also index by order for emails that only have order # (delivery notices)
  if (!targets.length && (parsed.orders || []).length) {
    for (const order of parsed.orders) {
      // Find existing case that already knows this order
      let found = null;
      for (const id of Object.keys(reg)) {
        const e = reg[id];
        if ((e.orders || []).includes(order) || (e.devices || []).some((d) => d.orderNumber === order)) {
          found = e;
          break;
        }
      }
      if (found) {
        for (const d of deviceList) upsertCaseDevice(found, d);
        for (const t of parsed.tracking || []) uniqPush(found.tracking, t);
        found.updatedAt = now;
        found.events.push({
          at: now,
          emailDate: isoDate(meta && meta.emailDate),
          uid: meta && meta.uid != null ? Number(meta.uid) : null,
          subject: String((meta && meta.subject) || '').slice(0, 300),
          orders: (parsed.orders || []).slice(0, 10),
          serials: (parsed.serials || []).slice(0, 10),
          tracking: (parsed.tracking || []).slice(0, 10)
        });
        if (found.events.length > 50) found.events = found.events.slice(-50);
      } else {
        // Placeholder bucket keyed by order until a case ID arrives
        const key = `order:${order}`;
        const entry = ensureCaseEntry(reg, key);
        entry.caseId = null;
        entry.pendingOrder = order;
        for (const d of deviceList) upsertCaseDevice(entry, d);
        uniqPush(entry.orders, order);
        for (const s of parsed.serials || []) uniqPush(entry.serials, String(s).toUpperCase());
        for (const t of parsed.tracking || []) uniqPush(entry.tracking, t);
        entry.updatedAt = now;
      }
    }
  }

  // Merge order:* buckets into real cases when order matches
  for (const id of Object.keys(reg)) {
    if (!id.startsWith('order:')) continue;
    const pending = reg[id];
    const order = pending.pendingOrder || (pending.orders && pending.orders[0]);
    if (!order) continue;
    for (const realId of Object.keys(reg)) {
      if (realId.startsWith('order:')) continue;
      const real = reg[realId];
      if (!(real.orders || []).includes(order) && !(real.devices || []).some((d) => d.orderNumber === order)) continue;
      for (const d of pending.devices || []) upsertCaseDevice(real, d);
      for (const o of pending.orders || []) uniqPush(real.orders, o);
      for (const s of pending.serials || []) uniqPush(real.serials, s);
      for (const t of pending.tracking || []) uniqPush(real.tracking, t);
      real.events = [...(real.events || []), ...(pending.events || [])].slice(-50);
      real.updatedAt = now;
      delete reg[id];
      break;
    }
  }

  // Merge empty-SN placeholders into SN rows that share the same order
  for (const id of Object.keys(reg)) {
    const entry = reg[id];
    if (!entry || !Array.isArray(entry.devices)) continue;
    const byOrder = new Map();
    for (const d of entry.devices) {
      if (!d.orderNumber || !d.serialNumber) continue;
      byOrder.set(String(d.orderNumber), d);
    }
    entry.devices = entry.devices.filter((d) => {
      if (d.serialNumber || !d.orderNumber) return true;
      const keep = byOrder.get(String(d.orderNumber));
      if (!keep) return true;
      if (d.inboundTracking && !keep.inboundTracking) keep.inboundTracking = d.inboundTracking;
      if (d.model && !keep.model) keep.model = d.model;
      if (d.program && !keep.program) keep.program = d.program;
      return false;
    });
  }

  saveCaseRegistry(reg);
  return { registry: reg, primaryCase: primary };
}

function lookupRegistryByOrder(reg, order) {
  if (!order) return null;
  for (const id of Object.keys(reg)) {
    const e = reg[id];
    if ((e.orders || []).includes(order) || (e.devices || []).some((d) => d.orderNumber === order)) return e;
  }
  return null;
}

function siblingSerialsForCase(reg, caseId, selfSn) {
  const entry = reg[caseId];
  if (!entry) return [];
  const self = String(selfSn || '').toUpperCase();
  return (entry.devices || [])
    .map((d) => d.serialNumber)
    .filter((s) => s && String(s).toUpperCase() !== self)
    .map((s) => String(s).toUpperCase());
}

/**
 * Build per-device work items so multi-device cases don't cross-contaminate order/TN/SN.
 */
function buildWorkItems(parsed, registry) {
  const items = [];
  const labels = parsed.labels || [];
  const cases = normalizeCaseIds(parsed.cases || []);

  // Enrich cases from registry when email only has order
  const enrichedCases = cases.slice();
  for (const order of parsed.orders || []) {
    const hit = lookupRegistryByOrder(registry, order);
    if (hit && hit.caseId && /^\d{16,20}$/.test(String(hit.caseId))) {
      uniqPush(enrichedCases, hit.caseId);
    }
  }

  if (parsed.devices && parsed.devices.some((d) => d.serialNumber || d.orderNumber)) {
    for (const d of parsed.devices) {
      const sn = d.serialNumber ? String(d.serialNumber).toUpperCase() : null;
      let ownLabels = labels.filter((lab) => {
        if (sn && lab.serialNumber && String(lab.serialNumber).toUpperCase() === sn) return true;
        if (d.orderNumber && lab.orderNumber && String(lab.orderNumber) === String(d.orderNumber)) return true;
        return false;
      });
      // Single unlabeled/order-only PDF on a scoped device email → claim it
      if (!ownLabels.length && labels.length === 1 && (sn || d.orderNumber)) {
        const lab = labels[0];
        const labSn = lab.serialNumber ? String(lab.serialNumber).toUpperCase() : null;
        const labOrd = lab.orderNumber ? String(lab.orderNumber) : null;
        const snOk = !labSn || (sn && labSn === sn);
        const ordOk = !labOrd
          || (d.orderNumber && labOrd === String(d.orderNumber))
          || (parsed.orders || []).map(String).includes(labOrd);
        if (snOk && ordOk) ownLabels = [lab];
      }
      items.push({
        cases: enrichedCases,
        serials: sn ? [sn] : [],
        orders: d.orderNumber ? [d.orderNumber] : [],
        tracking: d.inboundTracking
          ? [d.inboundTracking]
          : ((parsed.tracking || []).length === 1 ? parsed.tracking.slice() : []),
        labels: ownLabels.length ? ownLabels : (sn || d.orderNumber ? [] : labels),
        model: d.model || null,
        program: parsed.program,
        suggestStatus: parsed.suggestStatus,
        scoped: true
      });
    }
  }

  // Labels not already covered
  for (const lab of labels) {
    const sn = lab.serialNumber ? String(lab.serialNumber).toUpperCase() : null;
    if (!sn) continue;
    if (items.some((it) => it.serials.includes(sn))) continue;
    items.push({
      cases: enrichedCases,
      serials: [sn],
      orders: lab.orderNumber ? [lab.orderNumber] : (parsed.orders || []).slice(0, 1),
      tracking: (parsed.tracking || []).length === 1 ? parsed.tracking.slice() : [],
      labels: [lab],
      model: null,
      program: parsed.program,
      suggestStatus: parsed.suggestStatus || 'ms_approved_ship_same',
      scoped: true
    });
  }

  if (!items.length) {
    const sns = (parsed.serials || []).map((s) => String(s).toUpperCase());
    const ords = (parsed.orders || []).map(String);
    const multi = sns.length > 1
      || ords.length > 1
      || enrichedCases.some((c) => (registry[c] && (registry[c].devices || []).length > 1));

    // Multi SN/order without device blocks: still one scoped item per SN (zip orders).
    if (multi && sns.length) {
      for (let i = 0; i < sns.length; i += 1) {
        const order = ords[i] || (ords.length === 1 ? ords[0] : null);
        items.push({
          cases: enrichedCases,
          serials: [sns[i]],
          orders: order ? [order] : [],
          tracking: (parsed.tracking || []).length === 1 ? parsed.tracking.slice() : [],
          labels: labels.filter((lab) => {
            if (lab.serialNumber && String(lab.serialNumber).toUpperCase() === sns[i]) return true;
            if (order && lab.orderNumber && String(lab.orderNumber) === order) return true;
            return false;
          }),
          model: null,
          program: parsed.program,
          suggestStatus: parsed.suggestStatus,
          scoped: true
        });
      }
    } else if (multi && ords.length && !sns.length) {
      // Order-only mail (often multi-order AE threads): keep each order scoped so
      // header order numbers can still soft-match / invent tickets.
      for (const order of ords) {
        items.push({
          cases: enrichedCases,
          serials: [],
          orders: [order],
          tracking: (parsed.tracking || []).length === 1 ? parsed.tracking.slice() : [],
          labels: labels.filter((lab) => lab.orderNumber && String(lab.orderNumber) === order),
          model: null,
          program: parsed.program,
          suggestStatus: parsed.suggestStatus,
          scoped: true
        });
      }
    } else {
      items.push({
        cases: enrichedCases,
        serials: multi ? [] : sns.slice(),
        orders: multi ? [] : ords.slice(),
        tracking: multi ? [] : (parsed.tracking || []).slice(),
        labels: multi ? [] : labels.slice(),
        model: null,
        program: parsed.program,
        suggestStatus: parsed.suggestStatus,
        scoped: false,
        caseOnly: multi || (!sns.length && !ords.length && !(labels || []).length)
      });
    }
  }

  // If order-only (delivery) and registry knows SN for that order, invent a scoped item
  if (!(parsed.serials || []).length && (parsed.orders || []).length) {
    let invented = 0;
    for (const order of parsed.orders) {
      const hit = lookupRegistryByOrder(registry, order);
      const dev = hit && (hit.devices || []).find((d) => d.orderNumber === order && d.serialNumber);
      if (!dev) continue;
      const sn = String(dev.serialNumber).toUpperCase();
      if (items.some((it) => it.serials.includes(sn))) {
        // Ensure order is on that item
        const it = items.find((x) => x.serials.includes(sn));
        uniqPush(it.orders, order);
        invented += 1;
        continue;
      }
      items.push({
        cases: hit.caseId && /^\d/.test(String(hit.caseId)) ? [hit.caseId] : enrichedCases,
        serials: [sn],
        orders: [order],
        tracking: (parsed.tracking || []).slice(),
        labels: [],
        model: dev.model || null,
        program: parsed.program || dev.program,
        suggestStatus: parsed.suggestStatus,
        scoped: true
      });
      invented += 1;
    }
    // Drop unscoped case-only fillers — they fan events to every sibling.
    if (invented) {
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const it = items[i];
        if (it.scoped) continue;
        if (it.caseOnly || (!(it.serials || []).length && !(it.orders || []).length)) {
          items.splice(i, 1);
        }
      }
    }
  }

  // Case-only mail on a known multi/single-device case: invent scoped items from registry SNs
  // so later re-link passes create/update per-device tickets instead of only case fan-out.
  if (!(parsed.serials || []).length && !(parsed.orders || []).length && enrichedCases.length) {
    let invented = 0;
    for (const caseId of enrichedCases) {
      const entry = registry[caseId];
      if (!entry) continue;
      for (const dev of entry.devices || []) {
        const sn = dev.serialNumber ? String(dev.serialNumber).toUpperCase() : null;
        if (!sn || !isValidSurfaceSerial(sn)) continue;
        if (items.some((it) => (it.serials || []).includes(sn))) {
          invented += 1;
          continue;
        }
        items.push({
          cases: [caseId],
          serials: [sn],
          orders: dev.orderNumber ? [String(dev.orderNumber)] : [],
          tracking: [],
          labels: [],
          model: dev.model || null,
          program: parsed.program || dev.program,
          suggestStatus: parsed.suggestStatus,
          scoped: true
        });
        invented += 1;
      }
    }
    if (invented) {
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const it = items[i];
        if (it.scoped) continue;
        if (it.caseOnly || (!(it.serials || []).length && !(it.orders || []).length)) {
          items.splice(i, 1);
        }
      }
    }
  }

  // Attach classified tracking to every work item
  for (const it of items) {
    const ownOut = [];
    for (const lab of it.labels || []) {
      if (lab.trackingNumber) uniqPush(ownOut, String(lab.trackingNumber).toUpperCase());
    }
    for (const tn of parsed.trackingOutbound || []) uniqPush(ownOut, String(tn).toUpperCase());
    for (const tn of parsed.returnLabelTracking || []) uniqPush(ownOut, String(tn).toUpperCase());
    const ownIn = [];
    for (const tn of parsed.trackingInbound || []) uniqPush(ownIn, String(tn).toUpperCase());
    // Device-level inbound from order↔UPS pairing
    if ((it.tracking || []).length === 1 && !ownOut.includes(String(it.tracking[0]).toUpperCase())) {
      uniqPush(ownIn, String(it.tracking[0]).toUpperCase());
    }
    it.trackingInbound = ownIn;
    it.trackingOutbound = ownOut;
    it.returnLabelTracking = ownOut.slice();
    if (!(it.tracking || []).length) {
      it.tracking = ownIn.length ? ownIn.slice() : ownOut.slice();
    }
  }

  return items;
}

function applyFieldsToTicket(t, parsed, meta, now, opts) {
  const changes = [];
  const options = opts || {};
  const allowDeviceFields = options.allowDeviceFields !== false;

  if (!String(t.serialNumber || '').trim() && parsed.serials && parsed.serials[0]) {
    const sn0 = String(parsed.serials[0]).trim().toUpperCase();
    if (isValidSurfaceSerial(sn0)) {
      t.serialNumber = sn0;
      changes.push(`serial=${t.serialNumber}`);
      pushSerialHistory(t, sn0, 'inventory', now);
    }
  }

  // Always allow case linkage + related cases
  if (!t.msCaseId && parsed.cases && parsed.cases[0]) {
    t.msCaseId = parsed.cases[0];
    changes.push(`case=${parsed.cases[0]}`);
  }
  if (parsed.cases && parsed.cases.length) {
    if (!Array.isArray(t.msRelatedCases)) t.msRelatedCases = [];
    for (const c of parsed.cases) {
      if (c && c !== t.msCaseId && !t.msRelatedCases.includes(c)) {
        t.msRelatedCases.push(c);
        changes.push(`relatedCase=${c}`);
      }
    }
  }

  if (allowDeviceFields) {
    if (parsed.orders && parsed.orders[0]) {
      const nextOrder = String(parsed.orders[0]);
      if (!t.msOrderNumber) {
        t.msOrderNumber = nextOrder;
        changes.push(`order=${nextOrder}`);
      } else if (String(t.msOrderNumber) !== nextOrder && (parsed.orders || []).length === 1) {
        changes.push(`order ${t.msOrderNumber}→${nextOrder}`);
        t.msOrderNumber = nextOrder;
      }
    }

    const inboundList = (parsed.trackingInbound && parsed.trackingInbound.length)
      ? parsed.trackingInbound
      : [];
    const outboundList = (parsed.trackingOutbound && parsed.trackingOutbound.length)
      ? parsed.trackingOutbound
      : (parsed.returnLabelTracking || []);
    // Legacy fallback: unclassified tracking[] only if nothing classified
    const legacyTracking = (!inboundList.length && !outboundList.length && parsed.tracking)
      ? parsed.tracking
      : [];

    if (inboundList[0] && t.inboundTracking !== inboundList[0]) {
      t.inboundTracking = inboundList[0];
      changes.push(`inbound=${inboundList[0]}`);
    } else if (legacyTracking[0] && !outboundList.length && t.inboundTracking !== legacyTracking[0]) {
      t.inboundTracking = legacyTracking[0];
      changes.push(`inbound=${legacyTracking[0]}`);
    }

    const outTn = outboundList[0] || null;
    if (outTn && t.outboundTracking !== outTn) {
      t.outboundTracking = outTn;
      changes.push(`outbound=${outTn}`);
    }
    if (outTn) {
      if (!t.msReturnLabelTracking || t.msReturnLabelTracking !== outTn) {
        t.msReturnLabelTracking = outTn;
      }
      if (!t.msDefectiveSerial && t.serialNumber && isValidSurfaceSerial(t.serialNumber)) {
        t.msDefectiveSerial = String(t.serialNumber).toUpperCase();
        pushSerialHistory(t, t.msDefectiveSerial, 'defective', now);
        changes.push(`defectiveSN=${t.msDefectiveSerial}`);
      }
    }

    const repl = (parsed.replacementSerials && parsed.replacementSerials[0])
      || (options.replacementSerial || null);
    if (repl && isValidSurfaceSerial(repl)) {
      const r = String(repl).toUpperCase();
      if (t.msReplacementSerial !== r) {
        t.msReplacementSerial = r;
        pushSerialHistory(t, r, 'replacement', now);
        changes.push(`replacementSN=${r}`);
      }
      if (!t.msDefectiveSerial && t.serialNumber && serialKey(t.serialNumber) !== serialKey(r)) {
        t.msDefectiveSerial = String(t.serialNumber).toUpperCase();
        pushSerialHistory(t, t.msDefectiveSerial, 'defective', now);
      }
      if (!t.msProgram) t.msProgram = 'advanced_exchange';
    }

    if (parsed.program && !t.msProgram) {
      t.msProgram = parsed.program;
      changes.push(`program=${parsed.program}`);
    } else if (parsed.program === 'same_unit_repair' && t.msProgram === 'advanced_exchange') {
      t.msProgram = 'same_unit_repair';
      changes.push('program→same_unit_repair');
    }
    if (parsed.model && !t.msDeviceModel) {
      t.msDeviceModel = parsed.model;
      changes.push(`model=${parsed.model}`);
    }
    if (parsed.labels && parsed.labels.length) {
      mergeLabelsOntoTicket(t, parsed.labels, changes);
      if (!parsed.suggestStatus && (/label|return your device/i.test(meta.subject || '') || parsed.labels.length)) {
        parsed.suggestStatus = 'ms_approved_ship_same';
        if (!parsed.program) parsed.program = 'same_unit_repair';
      }
    }
  }

  if (Array.isArray(options.siblingSerials) && options.siblingSerials.length) {
    if (!Array.isArray(t.msSiblingSerials)) t.msSiblingSerials = [];
    for (const sn of options.siblingSerials) {
      if (sn && !t.msSiblingSerials.includes(sn)) {
        t.msSiblingSerials.push(sn);
        changes.push(`siblingSN=${sn}`);
      }
    }
  }

  const nextStatus = parsed.suggestStatus;
  const statusOk = nextStatus && canAdvanceStatus(t.status, nextStatus) && t.status !== nextStatus
    && (allowDeviceFields || nextStatus === 'ms_case_created' || nextStatus === 'ms_waiting_approval' || nextStatus === 'ms_rejected');
  if (statusOk) {
    const prev = t.status;
    t.status = nextStatus;
    t.statusAt = now;
    if (!Array.isArray(t.statusHistory)) t.statusHistory = [];
    t.statusHistory.push({
      at: now,
      status: nextStatus,
      by: 'ms_email',
      note: `From email (${emailDateLabel(meta)}): ${meta.subject || '(no subject)'}`
    });
    changes.push(`status ${prev}→${nextStatus}`);
  }

  if (changes.length) {
    if (!Array.isArray(t.notes)) t.notes = [];
    t.notes.push({
      at: now,
      by: 'ms_email',
      text: `MS email [${emailDateLabel(meta)}] "${meta.subject || ''}" (${meta.from || ''}): ${changes.join('; ')}`
    });
    pushEmailEvent(t, meta, changes);
    t.vendorName = t.vendorName || 'Microsoft';
  }
  return changes;
}

function createTicketFromEmail(serialNumber, parsed, meta, now) {
  const status = inferStatusFromParsed(parsed, meta);
  const program = parsed.program
    || (status === 'ms_approved_ship_same' || status === 'ms_same_unit' ? 'same_unit_repair' : null)
    || (status === 'ms_approved_ship_ae' || status === 'ms_waiting_inbound' || status === 'ms_received_exchange'
      ? 'advanced_exchange' : null);
  const changes = [`created status=${status}`];
  if (parsed.cases && parsed.cases[0]) changes.push(`case=${parsed.cases[0]}`);
  if (parsed.orders && parsed.orders[0]) changes.push(`order=${parsed.orders[0]}`);

  const inbound = (parsed.trackingInbound && parsed.trackingInbound[0])
    || ((!parsed.trackingOutbound || !parsed.trackingOutbound.length) && parsed.tracking && parsed.tracking[0])
    || null;
  const outbound = (parsed.trackingOutbound && parsed.trackingOutbound[0])
    || (parsed.returnLabelTracking && parsed.returnLabelTracking[0])
    || null;
  if (inbound) changes.push(`inbound=${inbound}`);
  if (outbound) changes.push(`outbound=${outbound}`);
  if (parsed.labels && parsed.labels.length) {
    for (const lab of parsed.labels) changes.push(`label=${lab.filename}`);
  }

  const sn = String(serialNumber).trim().toUpperCase();
  const repl = (parsed.replacementSerials && parsed.replacementSerials[0]) || null;
  const ticket = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: now,
    serialNumber: sn,
    msDefectiveSerial: outbound ? sn : null,
    msReplacementSerial: repl && isValidSurfaceSerial(repl) ? String(repl).toUpperCase() : null,
    msSerialHistory: [],
    issue: `From MS email: ${String(meta.subject || 'Microsoft service mail').slice(0, 180)}`,
    status,
    statusAt: now,
    statusHistory: [{
      at: now,
      status,
      by: 'ms_email',
      note: `Opened from email (${emailDateLabel(meta)})`
    }],
    notes: [{
      at: now,
      by: 'ms_email',
      text: `Created from MS email [${emailDateLabel(meta)}] "${meta.subject || ''}" (${meta.from || ''}): ${changes.join('; ')}`
    }],
    reportedBy: 'ms_email',
    source: 'ms_email',
    msProgram: program,
    msCaseId: (parsed.cases && parsed.cases[0]) || null,
    msRelatedCases: (parsed.cases || []).filter((c, i) => i > 0),
    msOrderNumber: (parsed.orders && parsed.orders[0]) || null,
    inboundTracking: inbound,
    outboundTracking: outbound,
    msReturnLabelTracking: outbound,
    msDeviceModel: parsed.model || null,
    msSiblingSerials: [],
    vendorName: 'Microsoft',
    msShippingLabels: [],
    msEmailEvents: []
  };
  pushSerialHistory(ticket, sn, 'inventory', now);
  if (ticket.msDefectiveSerial) pushSerialHistory(ticket, ticket.msDefectiveSerial, 'defective', now);
  if (ticket.msReplacementSerial) pushSerialHistory(ticket, ticket.msReplacementSerial, 'replacement', now);
  mergeLabelsOntoTicket(ticket, parsed.labels || [], []);
  pushEmailEvent(ticket, meta, changes);
  return ticket;
}

/**
 * Match open tickets by serial / order / case, apply fields per-device when possible.
 * Maintains ms_cases.json so multi-device cases keep SN↔order↔TN straight.
 */
function applyToRepairTickets(parsed, meta) {
  const log = loadJson(REPAIR_NEEDED_PATH, []);
  if (!Array.isArray(log)) return { matched: 0, created: 0, ticketIds: [] };

  const closed = new Set(['resolved', 'cannot_resolve']);
  const now = new Date().toISOString();
  const processedMeta = {
    subject: (meta && meta.subject) || '',
    from: (meta && meta.from) || '',
    emailDate: (meta && meta.emailDate) || null,
    processedAt: now,
    uid: meta && meta.uid
  };

  const { registry } = updateCaseRegistry(parsed, processedMeta);
  const workItems = buildWorkItems(parsed, registry);

  let matched = 0;
  let created = 0;
  const touchedSerials = new Set();
  const ticketIds = new Set();

  function ticketRelatedCases(t) {
    const set = new Set();
    if (t.msCaseId) set.add(String(t.msCaseId));
    for (const c of t.msRelatedCases || []) if (c) set.add(String(c));
    return set;
  }

  function registryHasSerialOnCases(caseSet, sn) {
    if (!sn || !caseSet.size) return false;
    for (const c of caseSet) {
      const entry = registry[c];
      if (!entry) continue;
      if ((entry.devices || []).some((d) => serialKey(d.serialNumber) === sn)) return true;
      if ((entry.serials || []).some((s) => serialKey(s) === sn)) return true;
    }
    return false;
  }

  for (const item of workItems) {
    const snSet = new Set((item.serials || []).map((s) => String(s).toLowerCase()));
    const orderSet = new Set((item.orders || []).map(String));
    const caseSet = new Set((item.cases || []).map(String));
    const inboundSet = new Set((item.trackingInbound || item.tracking || []).map((t) => String(t).toUpperCase()));
    const outboundSet = new Set((item.trackingOutbound || item.returnLabelTracking || []).map((t) => String(t).toUpperCase()));
    const allowDeviceFields = !item.caseOnly;
    // Scoped order/SN work items must not fan out to siblings via bare case match.
    const scopedDeviceOnly = !!(item.scoped
      && ((item.serials && item.serials.length) || (item.orders && item.orders.length)));

    for (let i = 0; i < log.length; i++) {
      const t = log[i];
      if (!t) continue;
      const snKeys = ticketSerialKeys(t);
      const caseId = String(t.msCaseId || '');
      const orderId = String(t.msOrderNumber || '');
      const related = ticketRelatedCases(t);
      const wasClosed = closed.has(String(t.status || ''));
      const primarySn = serialKey(t.serialNumber);

      let hit = false;
      let deviceHit = false;
      // Order match is valid only when the email does not clearly belong to another
      // device/case (polluted fields.orders used to false-hit hundreds of tickets).
      const orderMatches = !!(orderId && orderSet.has(orderId));
      const snConflict = snSet.size > 0 && ![...snKeys].some((k) => snSet.has(k));
      const caseConflict = !!(caseId && caseSet.size > 0
        && !caseSet.has(caseId)
        && ![...related].some((c) => caseSet.has(c)));
      const orderHitOk = orderMatches && !snConflict && !caseConflict;

      if ([...snKeys].some((k) => snSet.has(k))) {
        hit = true;
        deviceHit = true;
      } else if (!wasClosed && orderHitOk) {
        hit = true;
        deviceHit = true;
      } else if (!wasClosed && t.inboundTracking && inboundSet.has(String(t.inboundTracking).toUpperCase())) {
        hit = true;
        deviceHit = true;
      } else if (!wasClosed && t.outboundTracking && outboundSet.has(String(t.outboundTracking).toUpperCase())) {
        hit = true;
        deviceHit = true;
      } else if (!wasClosed && t.msReturnLabelTracking
        && outboundSet.has(String(t.msReturnLabelTracking).toUpperCase())) {
        hit = true;
        deviceHit = true;
      } else if (!wasClosed && !scopedDeviceOnly && caseId && caseSet.has(caseId)) {
        hit = true;
        deviceHit = false;
      } else if (!wasClosed && !scopedDeviceOnly && [...related].some((c) => caseSet.has(c))) {
        hit = true;
        deviceHit = false;
      } else if (!wasClosed && !scopedDeviceOnly && primarySn && registryHasSerialOnCases(caseSet, primarySn)) {
        hit = true;
        deviceHit = true;
      } else if (wasClosed && orderHitOk) {
        // Completed MS orders: still attach mail to the resolved ticket timeline
        hit = true;
        deviceHit = true;
      } else if (wasClosed && !scopedDeviceOnly && caseId && caseSet.has(caseId)) {
        hit = true;
        deviceHit = false;
      } else if (wasClosed && !scopedDeviceOnly && [...related].some((c) => caseSet.has(c))) {
        hit = true;
        deviceHit = false;
      }
      if (!hit) continue;
      // Re-open resolved/cannot_resolve when a later MS email names this SN again
      let reopenFrom = null;
      if (wasClosed) {
        const snHit = [...snKeys].some((k) => snSet.has(k));
        if (deviceHit && snHit && (caseSet.size || orderSet.size || (item.labels || []).length)) {
          reopenFrom = String(t.status || 'resolved');
          t.status = item.suggestStatus || 'ms_case_created';
        }
        // else: soft-match closed ticket — attach events / fields, do not reopen
      }

      const siblings = [];
      for (const c of (item.cases || [])) {
        for (const s of siblingSerialsForCase(registry, c, t.serialNumber)) siblings.push(s);
      }

      const localParsed = {
        cases: (item.cases || []).slice(),
        orders: (item.orders || []).slice(),
        tracking: (item.tracking || []).slice(),
        trackingInbound: (item.trackingInbound || item.tracking || []).slice(),
        trackingOutbound: (item.trackingOutbound || item.returnLabelTracking || []).slice(),
        returnLabelTracking: (item.returnLabelTracking || []).slice(),
        serials: (item.serials || []).slice(),
        replacementSerials: (parsed.replacementSerials || []).filter((s) =>
          snSet.has(String(s).toLowerCase()) || !(item.serials || []).length
        ),
        labels: item.labels || [],
        program: item.program,
        suggestStatus: item.suggestStatus,
        model: item.model || null
      };

      const changes = applyFieldsToTicket(t, localParsed, processedMeta, now, {
        allowDeviceFields: allowDeviceFields && (deviceHit || ((item.serials || []).length + (item.orders || []).length) <= 1),
        siblingSerials: deviceHit ? siblings : []
      });
      if (reopenFrom) changes.push(`reopened from ${reopenFrom}`);
      const alreadyUid = processedMeta.uid != null
        && Array.isArray(t.msEmailEvents)
        && t.msEmailEvents.some((e) => Number(e.uid) === Number(processedMeta.uid));

      if (changes.length) {
        log[i] = t;
        matched += 1;
        ticketIds.add(t.id);
        for (const k of snKeys) touchedSerials.add(k);
        if (primarySn) touchedSerials.add(primarySn);
      } else if (!alreadyUid && (deviceHit || item.caseOnly || !scopedDeviceOnly)) {
        pushEmailEvent(t, processedMeta, ['matched — no new fields']);
        log[i] = t;
        matched += 1;
        ticketIds.add(t.id);
        for (const k of snKeys) touchedSerials.add(k);
      } else {
        if (deviceHit || alreadyUid) {
          matched += 1;
          ticketIds.add(t.id);
          for (const k of snKeys) touchedSerials.add(k);
        }
      }
    }

    // Auto-create from reliable serials on this work item (dedupe across SN roles)
    for (const snRaw of item.serials || []) {
      const sn = String(snRaw).toUpperCase();
      const key = serialKey(sn);
      if (!key || touchedSerials.has(key)) continue;
      if (!isValidSurfaceSerial(sn)) continue;

      // Prefer merging into an existing open ticket that already owns this SN in any role
      let mergeIdx = -1;
      for (let i = 0; i < log.length; i++) {
        const t = log[i];
        if (!t || closed.has(String(t.status || ''))) continue;
        if (ticketSerialKeys(t).has(key)) {
          mergeIdx = i;
          break;
        }
      }
      if (mergeIdx >= 0) {
        const t = log[mergeIdx];
        const scoped = {
          cases: item.cases || [],
          orders: item.orders || [],
          tracking: item.tracking || [],
          trackingInbound: item.trackingInbound || item.tracking || [],
          trackingOutbound: item.trackingOutbound || item.returnLabelTracking || [],
          returnLabelTracking: item.returnLabelTracking || [],
          serials: [sn],
          replacementSerials: parsed.replacementSerials || [],
          labels: item.labels || [],
          program: item.program,
          suggestStatus: item.suggestStatus,
          model: item.model
        };
        applyFieldsToTicket(t, scoped, processedMeta, now, { allowDeviceFields: true });
        log[mergeIdx] = t;
        matched += 1;
        ticketIds.add(t.id);
        touchedSerials.add(key);
        continue;
      }

      const hasAnchor = (item.labels && item.labels.length)
        || (item.orders && item.orders.length)
        || (item.cases && item.cases.length);
      if (!hasAnchor) continue;

      const scoped = {
        cases: item.cases || [],
        orders: item.orders || [],
        tracking: item.tracking || [],
        trackingInbound: item.trackingInbound || item.tracking || [],
        trackingOutbound: item.trackingOutbound || item.returnLabelTracking || [],
        returnLabelTracking: item.returnLabelTracking || [],
        serials: [sn],
        replacementSerials: parsed.replacementSerials || [],
        labels: item.labels || [],
        program: item.program,
        suggestStatus: item.suggestStatus,
        model: item.model
      };
      const ticket = createTicketFromEmail(sn, scoped, processedMeta, now);
      const siblings = [];
      for (const c of (item.cases || [])) {
        for (const s of siblingSerialsForCase(registry, c, sn)) siblings.push(s);
      }
      ticket.msSiblingSerials = siblings;
      backfillPriorEmailsOntoTicket(ticket, registry, item.cases || []);
      log.push(ticket);
      created += 1;
      matched += 1;
      ticketIds.add(ticket.id);
      touchedSerials.add(key);
    }
  }

  if (matched || created) atomicWriteJsonSync(REPAIR_NEEDED_PATH, log);
  return { matched, created, ticketIds: [...ticketIds] };
}

/**
 * When a ticket is created late, pull earlier case-only emails from the registry
 * (and uid-*.json) onto its timeline so the thread is complete.
 */
function backfillPriorEmailsOntoTicket(ticket, registry, caseIds) {
  if (!ticket) return;
  const existing = new Set(
    (ticket.msEmailEvents || [])
      .map((e) => (e && e.uid != null ? Number(e.uid) : null))
      .filter((n) => n != null)
  );
  const sn = String(ticket.serialNumber || '').toUpperCase();
  const order = ticket.msOrderNumber ? String(ticket.msOrderNumber) : null;
  const ids = normalizeCaseIds(caseIds || []).concat(ticket.msCaseId ? [ticket.msCaseId] : []);

  function acceptEvent(serials, orders) {
    const sns = (serials || []).map((s) => String(s).toUpperCase());
    const ords = (orders || []).map(String);
    if (sns.length && sn && sns.includes(sn)) return true;
    if (ords.length && order && ords.includes(order)) return true;
    // Case-level chatter with no device identity — include
    if (!sns.length && !ords.length) return true;
    // Event is for another device on the same case — skip
    if (sns.length && sn && !sns.includes(sn)) return false;
    if (ords.length && order && !ords.includes(order)) return false;
    return true;
  }

  for (const caseId of ids) {
    const entry = registry && registry[caseId];
    if (!entry || !Array.isArray(entry.events)) continue;
    for (const ev of entry.events) {
      if (!ev || ev.uid == null || existing.has(Number(ev.uid))) continue;
      if (!acceptEvent(ev.serials, ev.orders)) continue;
      pushEmailEvent(ticket, {
        uid: ev.uid,
        subject: ev.subject || '',
        from: ev.from || '',
        emailDate: ev.emailDate || ev.at || null,
        processedAt: new Date().toISOString()
      }, ['backfilled from case history']);
      existing.add(Number(ev.uid));
    }
  }

  // Also scan recent uid records for this case (covers registry gaps)
  try {
    const files = fs.readdirSync(INBOX_DIR).filter((f) => /^uid-\d+\.json$/.test(f));
    for (const file of files) {
      const rec = loadJson(path.join(INBOX_DIR, file), null);
      if (!rec || rec.uid == null || existing.has(Number(rec.uid))) continue;
      const f = rec.fields || {};
      const recCases = (f.cases || []).map(String);
      if (!ids.some((c) => recCases.includes(String(c)))) continue;
      if (!acceptEvent(f.serials, f.orders)) continue;
      pushEmailEvent(ticket, {
        uid: rec.uid,
        subject: rec.subject || '',
        from: rec.from || '',
        emailDate: rec.date || null,
        processedAt: new Date().toISOString()
      }, ['backfilled from unmatched case mail']);
      existing.add(Number(rec.uid));
      // Retroactively count as matched on the stored record
      rec.matchedTickets = Math.max(Number(rec.matchedTickets) || 0, 1);
      atomicWriteJsonSync(path.join(INBOX_DIR, file), rec);
    }
  } catch (e) {
    console.error('[ms_email] backfill scan', e.message);
  }
}

function recordPathForUid(uid) {
  return path.join(INBOX_DIR, `uid-${uid}.json`);
}

function rawPathForUid(uid) {
  return path.join(INBOX_DIR, 'raw', `uid-${uid}.eml`);
}

/** Allocate UIDs for file imports in a range that won't collide with IMAP UIDs. */
function nextImportUid() {
  const state = loadState();
  const floor = 1000000;
  let next = Number(state.nextImportUid) || floor;
  if (next < floor) next = floor;
  // Also stay above any existing import files
  try {
    const rawDir = path.join(INBOX_DIR, 'raw');
    if (fs.existsSync(rawDir)) {
      for (const f of fs.readdirSync(rawDir)) {
        const m = f.match(/^uid-(\d+)\.eml$/);
        if (!m) continue;
        const n = Number(m[1]);
        if (n >= floor && n >= next) next = n + 1;
      }
    }
  } catch (_) { /* ignore */ }
  state.nextImportUid = next + 1;
  saveState(state);
  return next;
}

/**
 * Ingest a raw RFC822/.eml buffer the same way IMAP downloads are processed.
 */
async function ingestEmlSource(source, uid, opts = {}) {
  ensureDirs();
  const buf = Buffer.isBuffer(source) ? source : Buffer.from(source || '');
  if (!buf.length) throw new Error('Empty email source');
  const parsedMail = await simpleParser(buf);
  const subject = String(parsedMail.subject || '');
  const from = parsedMail.from && parsedMail.from.text ? parsedMail.from.text : '';
  const text = emailSearchText(parsedMail, buf);
  const fields = extractFields(subject, text);
  fields.labels = extractAndSaveLabels(parsedMail, uid);
  mergeLabelFieldsIntoParsed(fields);
  const record = {
    id: `uid-${uid}`,
    uid: Number(uid),
    at: new Date().toISOString(),
    from,
    subject,
    date: parsedMail.date || null,
    fields,
    labels: fields.labels,
    preview: text.slice(0, 2000),
    imported: !!opts.imported,
    importFilename: opts.filename || null
  };

  fs.writeFileSync(rawPathForUid(uid), buf);
  atomicWriteJsonSync(recordPathForUid(uid), record);

  const apply = applyToRepairTickets(fields, {
    subject,
    from,
    emailDate: parsedMail.date || null,
    uid: Number(uid)
  });
  record.matchedTickets = apply.matched;
  record.createdTickets = apply.created || 0;
  record.matchedTicketIds = apply.ticketIds || [];
  atomicWriteJsonSync(recordPathForUid(uid), record);

  // Bulk historical imports skip reply/draft hooks (avoids thousands of drafts).
  if (!opts.skipReplyHooks && replyHooks && typeof replyHooks.afterEmailApplied === 'function') {
    try {
      await replyHooks.afterEmailApplied(record, apply.ticketIds || []);
    } catch (e) {
      console.error('[ms_email] afterEmailApplied', e.message);
    }
  }
  return { record, apply };
}

async function importEmlBuffers(files, opts = {}) {
  const results = [];
  let matched = 0;
  let created = 0;
  const skipReplyHooks = opts.skipReplyHooks === true;
  for (const file of files || []) {
    const name = String(file.originalname || file.filename || 'message.eml');
    const buf = file.buffer || file.content || null;
    if (!buf || !buf.length) {
      results.push({ filename: name, ok: false, error: 'empty file' });
      continue;
    }
    try {
      const uid = nextImportUid();
      const { record, apply } = await ingestEmlSource(buf, uid, {
        imported: true,
        filename: name,
        skipReplyHooks
      });
      matched += apply.matched || 0;
      created += apply.created || 0;
      results.push({
        filename: name,
        ok: true,
        uid,
        subject: record.subject,
        matched: apply.matched,
        created: apply.created,
        serials: (record.fields && record.fields.serials) || [],
        cases: (record.fields && record.fields.cases) || [],
        orders: (record.fields && record.fields.orders) || []
      });
    } catch (e) {
      results.push({ filename: name, ok: false, error: e.message || String(e) });
    }
  }
  return { ok: true, imported: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, matched, created, results };
}

async function processMessage(client, uid, cfg) {
  const downloaded = await client.download(uid, undefined, { uid: true });
  const chunks = [];
  for await (const chunk of downloaded.content) chunks.push(chunk);
  const source = Buffer.concat(chunks);
  const { record } = await ingestEmlSource(source, uid, { imported: false });

  if (cfg.markSeen) {
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
  }
  return record;
}

/** Re-parse every stored .eml and re-apply to repair tickets (no IMAP). */
function reprocessStoredMail() {
  ensureDirs();
  const rawDir = path.join(INBOX_DIR, 'raw');
  const files = fs.existsSync(rawDir)
    ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.eml'))
    : [];
  let processed = 0;
  let matched = 0;
  const results = [];

  for (const file of files) {
    const full = path.join(rawDir, file);
    const source = fs.readFileSync(full);
    // sync parse via mailparser is async — use deasync-free approach with require cache
    // We'll use a sync-ish path: simpleParser returns a promise; this function is async wrapper below
    results.push(full);
  }

  return { files: results.length, note: 'use reprocessStoredMailAsync' };
}

async function reprocessStoredMailAsync() {
  ensureDirs();
  const rawDir = path.join(INBOX_DIR, 'raw');
  const files = fs.existsSync(rawDir)
    ? fs.readdirSync(rawDir).filter((f) => f.endsWith('.eml')).sort()
    : [];
  let processed = 0;
  let matchedTotal = 0;
  let createdTotal = 0;
  const byUid = new Map();

  for (const file of files) {
    const full = path.join(rawDir, file);
    const source = fs.readFileSync(full);
    const uidMatch = file.match(/uid-(\d+)\.eml$/) || file.match(/-(\d+)\.eml$/);
    const uid = uidMatch ? Number(uidMatch[1]) : null;
    if (!uid) continue;
    const prev = byUid.get(uid);
    // Keep the largest raw (more complete MIME)
    if (prev && prev.source.length >= source.length) continue;
    byUid.set(uid, { uid, source });
  }

  for (const [uid, item] of [...byUid.entries()].sort((a, b) => a[0] - b[0])) {
    const parsedMail = await simpleParser(item.source);
    const subject = String(parsedMail.subject || '');
    const from = parsedMail.from && parsedMail.from.text ? parsedMail.from.text : '';
    const text = emailSearchText(parsedMail, item.source);
    const fields = extractFields(subject, text);
    fields.labels = extractAndSaveLabels(parsedMail, uid);
    mergeLabelFieldsIntoParsed(fields);
    const record = {
      id: `uid-${uid}`,
      uid,
      at: new Date().toISOString(),
      from,
      subject,
      date: parsedMail.date || null,
      fields,
      labels: fields.labels,
      preview: text.slice(0, 2000),
      reprocessed: true,
      imported: !!(loadJson(recordPathForUid(uid), {}) || {}).imported,
      importFilename: (loadJson(recordPathForUid(uid), {}) || {}).importFilename || null
    };
    fs.writeFileSync(rawPathForUid(uid), item.source);
    const apply = applyToRepairTickets(fields, {
      subject,
      from,
      emailDate: parsedMail.date || null,
      uid
    });
    record.matchedTickets = apply.matched;
    record.createdTickets = apply.created || 0;
    record.matchedTicketIds = apply.ticketIds || [];
    matchedTotal += apply.matched;
    createdTotal += apply.created || 0;
    atomicWriteJsonSync(recordPathForUid(uid), record);
    if (replyHooks && typeof replyHooks.afterEmailApplied === 'function') {
      try {
        await replyHooks.afterEmailApplied(record, apply.ticketIds || []);
      } catch (e) {
        console.error('[ms_email] afterEmailApplied', e.message);
      }
    }
    processed += 1;
  }

  // Drop legacy timestamped json duplicates (keep uid-*.json + case registry)
  for (const f of fs.readdirSync(INBOX_DIR)) {
    if (!f.endsWith('.json') || f === 'state.json' || f === 'ms_cases.json' || f.startsWith('uid-')) continue;
    if (f === 'drafts.json' || f === 'draft_training.json') continue;
    try { fs.unlinkSync(path.join(INBOX_DIR, f)); } catch (_) { /* ignore */ }
  }

  return { processed, matchedTotal, createdTotal, uniqueUids: byUid.size };
}

/**
 * Cross-email identity index: order/case → serials learned from any stored mail + labels.
 */
function buildInboxIdentityIndex() {
  ensureDirs();
  const orderToSerials = new Map();
  const caseToSerials = new Map();
  const caseToOrders = new Map();
  const orderToCases = new Map();

  function addMap(map, key, value) {
    if (!key || !value) return;
    const k = String(key);
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(String(value));
  }

  const files = fs.readdirSync(INBOX_DIR).filter((f) => /^uid-\d+\.json$/.test(f));
  for (const file of files) {
    const rec = loadJson(path.join(INBOX_DIR, file), null);
    if (!rec) continue;
    const f = rec.fields || {};
    const sns = [];
    for (const sn of f.serials || []) {
      if (isValidSurfaceSerial(sn)) sns.push(String(sn).toUpperCase());
    }
    for (const lab of f.labels || rec.labels || []) {
      if (lab && lab.serialNumber && isValidSurfaceSerial(lab.serialNumber)) {
        sns.push(String(lab.serialNumber).toUpperCase());
      }
      if (lab && lab.orderNumber && lab.serialNumber && isValidSurfaceSerial(lab.serialNumber)) {
        addMap(orderToSerials, lab.orderNumber, String(lab.serialNumber).toUpperCase());
      }
      if (lab && lab.orderNumber) {
        for (const c of f.cases || []) addMap(orderToCases, lab.orderNumber, c);
      }
    }
    for (const o of f.orders || []) {
      for (const sn of sns) addMap(orderToSerials, o, sn);
      for (const c of f.cases || []) {
        addMap(orderToCases, o, c);
        addMap(caseToOrders, c, o);
      }
    }
    for (const c of f.cases || []) {
      for (const sn of sns) addMap(caseToSerials, c, sn);
    }
  }

  // Registry fills gaps
  const registry = loadCaseRegistry();
  for (const [caseId, entry] of Object.entries(registry)) {
    for (const sn of entry.serials || []) {
      if (isValidSurfaceSerial(sn)) addMap(caseToSerials, caseId, String(sn).toUpperCase());
    }
    for (const o of entry.orders || []) addMap(caseToOrders, caseId, o);
    for (const dev of entry.devices || []) {
      if (dev.serialNumber && isValidSurfaceSerial(dev.serialNumber)) {
        addMap(caseToSerials, caseId, String(dev.serialNumber).toUpperCase());
        if (dev.orderNumber) {
          addMap(orderToSerials, dev.orderNumber, String(dev.serialNumber).toUpperCase());
          addMap(caseToOrders, caseId, dev.orderNumber);
          addMap(orderToCases, dev.orderNumber, caseId);
        }
      } else if (dev.orderNumber) {
        addMap(caseToOrders, caseId, dev.orderNumber);
        addMap(orderToCases, dev.orderNumber, caseId);
      }
    }
  }

  return { orderToSerials, caseToSerials, caseToOrders, orderToCases };
}

/**
 * Push known SN identities into a stored fields object before re-apply.
 *
 * IMPORTANT: never copy case→orders or order→cases graphs onto an email.
 * That was gluing unrelated MS orders (e.g. 2045771029) onto other threads
 * and exploding Repair Needed match / Reply-All Cc lists.
 */
function enrichFieldsFromIdentityIndex(fields, index) {
  if (!fields || !index) return { addedSerials: 0, addedOrders: 0, addedCases: 0 };
  if (!Array.isArray(fields.serials)) fields.serials = [];
  if (!Array.isArray(fields.orders)) fields.orders = [];
  if (!Array.isArray(fields.cases)) fields.cases = [];
  let addedSerials = 0;
  let addedOrders = 0;
  let addedCases = 0;

  const beforeSn = fields.serials.length;
  const beforeOrd = fields.orders.length;
  const beforeCase = fields.cases.length;
  const MAX_ORDER_SERIALS = 4;
  const MAX_CASE_SERIALS = 12;

  // From orders present in THIS email: add linked serials only when the map looks clean.
  for (const o of [...fields.orders]) {
    const sns = [...(index.orderToSerials.get(String(o)) || [])];
    if (sns.length > MAX_ORDER_SERIALS) continue; // polluted index entry — skip
    for (const sn of sns) {
      if (isValidSurfaceSerial(sn)) uniqPush(fields.serials, sn);
    }
    // Do NOT inject cases from order→cases (cross-case pollution).
  }
  // From cases present in THIS email: add linked serials only — never dump all case orders.
  for (const c of [...fields.cases]) {
    const sns = [...(index.caseToSerials.get(String(c)) || [])];
    if (sns.length <= MAX_CASE_SERIALS) {
      for (const sn of sns) {
        if (isValidSurfaceSerial(sn)) uniqPush(fields.serials, sn);
      }
    }
    // Intentionally no case→orders expansion.
  }
  // Labels already on the record (trusted — from PDF filename / OCR)
  for (const lab of fields.labels || []) {
    if (lab.serialNumber && isValidSurfaceSerial(lab.serialNumber)) {
      uniqPush(fields.serials, String(lab.serialNumber).toUpperCase());
    }
    if (lab.orderNumber && /^20\d{8}$/.test(String(lab.orderNumber))) {
      uniqPush(fields.orders, String(lab.orderNumber));
    }
  }

  addedSerials = fields.serials.length - beforeSn;
  addedOrders = fields.orders.length - beforeOrd;
  addedCases = fields.cases.length - beforeCase;
  return { addedSerials, addedOrders, addedCases };
}

/**
 * Sync stub — use scrubStoredMailFieldsAsync.
 */
function scrubStoredMailFields() {
  return { ok: false, error: 'use scrubStoredMailFieldsAsync' };
}

async function scrubStoredMailFieldsAsync(opts = {}) {
  ensureDirs();
  const files = fs.readdirSync(INBOX_DIR)
    .filter((f) => /^uid-\d+\.json$/.test(f))
    .sort((a, b) => Number((a.match(/\d+/) || [0])[0]) - Number((b.match(/\d+/) || [0])[0]));
  let processed = 0;
  let changed = 0;
  let ordersRemoved = 0;
  let skippedNoRaw = 0;
  const dryRun = opts.dryRun === true;
  const onlyPolluted = opts.onlyPolluted !== false;

  for (const file of files) {
    const full = path.join(INBOX_DIR, file);
    const record = loadJson(full, null);
    if (!record || record.uid == null) continue;
    const rawPath = rawPathForUid(record.uid);
    if (!fs.existsSync(rawPath)) {
      skippedNoRaw += 1;
      continue;
    }
    processed += 1;
    const prevOrders = (record.fields && record.fields.orders) || [];
    if (onlyPolluted && prevOrders.length <= 2) continue;

    let parsedMail;
    try {
      parsedMail = await simpleParser(fs.readFileSync(rawPath));
    } catch (_) {
      continue;
    }
    const subject = String(parsedMail.subject || record.subject || '');
    const text = emailSearchText(parsedMail, fs.readFileSync(rawPath));
    const fresh = extractFields(subject, text);
    const labels = (record.fields && record.fields.labels) || record.labels || [];
    fresh.labels = Array.isArray(labels) ? labels : [];
    mergeLabelFieldsIntoParsed(fresh);

    const before = JSON.stringify({
      cases: (record.fields && record.fields.cases) || [],
      orders: prevOrders,
      serials: (record.fields && record.fields.serials) || []
    });
    const after = JSON.stringify({
      cases: fresh.cases || [],
      orders: fresh.orders || [],
      serials: fresh.serials || []
    });
    if (before === after) continue;

    const removed = prevOrders.filter((o) => !(fresh.orders || []).includes(String(o)));
    ordersRemoved += removed.length;
    changed += 1;
    if (!dryRun) {
      record.fields = fresh;
      record.labels = fresh.labels;
      record.subject = subject || record.subject;
      record.scrubbedAt = new Date().toISOString();
      atomicWriteJsonSync(full, record);
    }
  }

  return { processed, changed, ordersRemoved, skippedNoRaw, dryRun };
}

/**
 * Fast re-link: re-apply stored uid-*.json fields (optionally enriched from sibling mail /
 * case registry) without re-downloading or re-OCR. Skips reply drafts by default.
 */
function relinkStoredMail(opts = {}) {
  ensureDirs();
  const unmatchedOnly = opts.unmatchedOnly !== false;
  const skipReplyHooks = opts.skipReplyHooks !== false;
  const index = buildInboxIdentityIndex();
  const files = fs.readdirSync(INBOX_DIR)
    .filter((f) => /^uid-\d+\.json$/.test(f))
    .sort((a, b) => {
      const na = Number((a.match(/\d+/) || [0])[0]);
      const nb = Number((b.match(/\d+/) || [0])[0]);
      return na - nb;
    });

  let processed = 0;
  let skipped = 0;
  let matchedTotal = 0;
  let createdTotal = 0;
  let newlyMatched = 0;
  let enriched = 0;

  for (const file of files) {
    const full = path.join(INBOX_DIR, file);
    const record = loadJson(full, null);
    if (!record || record.uid == null) {
      skipped += 1;
      continue;
    }
    const prevMatched = Number(record.matchedTickets) || 0;
    const prevCreated = Number(record.createdTickets) || 0;
    if (unmatchedOnly && (prevMatched > 0 || prevCreated > 0)) {
      skipped += 1;
      continue;
    }

    const fields = record.fields || {};
    // Ensure label array exists for merge helpers
    if (!Array.isArray(fields.labels) && Array.isArray(record.labels)) {
      fields.labels = record.labels;
    }
    const enrich = enrichFieldsFromIdentityIndex(fields, index);
    if (enrich.addedSerials || enrich.addedOrders || enrich.addedCases) enriched += 1;
    mergeLabelFieldsIntoParsed(fields);

    const apply = applyToRepairTickets(fields, {
      subject: record.subject || '',
      from: record.from || '',
      emailDate: record.date || null,
      uid: Number(record.uid)
    });

    record.fields = fields;
    record.matchedTickets = apply.matched;
    record.createdTickets = (Number(record.createdTickets) || 0) + (apply.created || 0);
    record.matchedTicketIds = apply.ticketIds || [];
    record.relinkedAt = new Date().toISOString();
    atomicWriteJsonSync(full, record);

    matchedTotal += apply.matched || 0;
    createdTotal += apply.created || 0;
    if ((apply.matched || apply.created) && prevMatched === 0 && prevCreated === 0) {
      newlyMatched += 1;
    }
    processed += 1;

    if (!skipReplyHooks && replyHooks && typeof replyHooks.afterEmailApplied === 'function') {
      try {
        // fire-and-forget sync path — afterEmailApplied is async; ignore for bulk
        Promise.resolve(replyHooks.afterEmailApplied(record, apply.ticketIds || [])).catch(() => {});
      } catch (_) { /* ignore */ }
    }
  }

  return {
    processed,
    skipped,
    matchedTotal,
    createdTotal,
    newlyMatched,
    enriched,
    indexOrders: index.orderToSerials.size,
    indexCases: index.caseToSerials.size
  };
}

/**
 * OCR any saved label PDF that still lacks SN or order, then merge into parent uid records.
 */
function enrichLabelsWithOcr(opts = {}) {
  ensureDirs();
  const force = opts.force === true;
  let scanned = 0;
  let updated = 0;
  let withIds = 0;
  const files = fs.existsSync(LABELS_DIR)
    ? fs.readdirSync(LABELS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'))
    : [];

  const byUid = new Map();
  for (const file of files) {
    scanned += 1;
    const full = path.join(LABELS_DIR, file);
    const m = file.match(/^lbl-u(\d+)-(\d+)_/);
    const uid = m ? Number(m[1]) : null;
    const fromName = parseLabelFilename(file);
    const lab = {
      id: m ? `lbl-u${uid}-${m[2]}` : file,
      filename: file.replace(/^lbl-u\d+-\d+_/, ''),
      storedName: file,
      uid,
      orderNumber: fromName.order,
      serialNumber: fromName.serial,
      trackingNumber: null
    };
    if (force || !lab.serialNumber || !lab.orderNumber) {
      enrichLabelFromPdfContent(lab, full);
    }
    if (lab.serialNumber || lab.orderNumber) withIds += 1;
    if (!uid) continue;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(lab);
  }

  for (const [uid, labs] of byUid.entries()) {
    const recPath = recordPathForUid(uid);
    const record = loadJson(recPath, null);
    if (!record) continue;
    if (!record.fields) record.fields = {};
    if (!Array.isArray(record.fields.labels)) record.fields.labels = [];
    let changed = false;
    for (const lab of labs) {
      let row = record.fields.labels.find((x) => x && (x.storedName === lab.storedName || x.id === lab.id));
      if (!row) {
        record.fields.labels.push({
          id: lab.id,
          filename: lab.filename,
          storedName: lab.storedName,
          uid,
          orderNumber: lab.orderNumber,
          serialNumber: lab.serialNumber,
          trackingNumber: lab.trackingNumber,
          downloadPath: `/api/ms-email/labels/${encodeURIComponent(lab.id)}`
        });
        changed = true;
        continue;
      }
      if (!row.orderNumber && lab.orderNumber) { row.orderNumber = lab.orderNumber; changed = true; }
      if (!row.serialNumber && lab.serialNumber) { row.serialNumber = lab.serialNumber; changed = true; }
      if (!row.trackingNumber && lab.trackingNumber) { row.trackingNumber = lab.trackingNumber; changed = true; }
    }
    if (changed) {
      mergeLabelFieldsIntoParsed(record.fields);
      record.labels = record.fields.labels;
      atomicWriteJsonSync(recPath, record);
      updated += 1;
    }
  }

  return { scanned, withIds, updatedRecords: updated };
}

async function pollOnce() {
  const cfg = loadConfig();
  lastStatus.lastPollAt = new Date().toISOString();
  if (!cfg) {
    lastStatus.enabled = false;
    lastStatus.ok = false;
    lastStatus.lastError = `Missing config ${CONFIG_PATH}`;
    return lastStatus;
  }
  lastStatus.enabled = !!cfg.enabled;
  if (!cfg.enabled) {
    lastStatus.ok = true;
    lastStatus.lastError = 'disabled';
    return lastStatus;
  }
  if (!cfg.password) {
    lastStatus.ok = false;
    lastStatus.lastError = 'Password not set (account/ms_returns_mail.json or MS_RETURNS_IMAP_PASSWORD)';
    return lastStatus;
  }

  ensureDirs();
  const state = loadState();
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tls,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const sinceUid = Number(state.lastUid || 0) + 1;
      const uidSet = new Set();

      const unseen = await client.search({ seen: false }, { uid: true });
      if (Array.isArray(unseen)) unseen.forEach((u) => uidSet.add(u));

      if (sinceUid > 1 && client.mailbox && client.mailbox.exists > 0) {
        const newer = await client.search({ uid: `${sinceUid}:*` }, { uid: true });
        if (Array.isArray(newer)) newer.forEach((u) => uidSet.add(u));
      }

      if (!state.lastUid && uidSet.size === 0 && client.mailbox && client.mailbox.exists > 0) {
        const all = await client.search({ all: true }, { uid: true });
        if (Array.isArray(all)) all.slice(-50).forEach((u) => uidSet.add(u));
      }

      const uids = [...uidSet].sort((a, b) => a - b);
      let maxUid = Number(state.lastUid || 0);
      for (const uid of uids) {
        await processMessage(client, uid, cfg);
        lastStatus.processed += 1;
        if (uid > maxUid) maxUid = uid;
      }
      if (client.mailbox && client.mailbox.uidNext) {
        const nextMinus = Number(client.mailbox.uidNext) - 1;
        if (nextMinus > maxUid) maxUid = nextMinus;
      }
      state.lastUid = maxUid;
      saveState(state);
      lastStatus.lastSeenUid = maxUid;
      lastStatus.ok = true;
      lastStatus.lastError = null;
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    lastStatus.ok = false;
    const detail = e.responseText || e.message || String(e);
    lastStatus.lastError = detail;
    console.error('[ms_email] poll failed', detail);
    try { await client.logout(); } catch (_) { /* ignore */ }
  }
  return lastStatus;
}

function startPolling() {
  const cfg = loadConfig();
  if (!cfg || !cfg.enabled) {
    console.log('[ms_email] watcher disabled (no config or enabled:false)');
    return;
  }
  if (pollTimer) clearInterval(pollTimer);
  const ms = (cfg.pollSeconds || 120) * 1000;
  console.log(`[ms_email] watching ${cfg.user} via ${cfg.host} every ${cfg.pollSeconds}s`);
  setTimeout(() => { pollOnce().catch(() => {}); }, 8000);
  pollTimer = setInterval(() => {
    pollOnce().catch(() => {});
  }, ms);
}

function setupMsEmailInbox(app) {
  ensureDirs();
  startPolling();

  if (replyHooks && typeof replyHooks.setupMsEmailReplyRoutes === 'function') {
    replyHooks.setupMsEmailReplyRoutes(app);
  }

  app.get('/api/ms-email/status', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const cfg = loadConfig();
    res.json({
      ok: true,
      configured: !!(cfg && cfg.password),
      user: cfg ? cfg.user : null,
      host: cfg ? `${cfg.host}:${cfg.port}` : null,
      mailbox: cfg ? cfg.mailbox : null,
      pollSeconds: cfg ? cfg.pollSeconds : null,
      smtp: cfg ? {
        enabled: cfg.smtp.enabled,
        host: `${cfg.smtp.host}:${cfg.smtp.port}`,
        note: cfg.smtp.enabled ? 'outgoing enabled' : 'reserved (disabled for now)'
      } : null,
      enabled: cfg ? cfg.enabled : false,
      status: lastStatus,
      configPath: CONFIG_PATH,
      passwordEnv: 'MS_RETURNS_IMAP_PASSWORD',
      inboxDir: INBOX_DIR,
      impl: 'server-side Node IMAP watcher in tracking process (not a separate AI agent)'
    });
  });

  app.post('/api/ms-email/poll', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    try {
      const status = await pollOnce();
      res.json({ ok: !status.lastError || status.lastError === 'disabled', status });
    } catch (e) {
      res.status(500).json({ error: e.message || 'poll failed' });
    }
  });

  app.post('/api/ms-email/reprocess', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    try {
      const result = await reprocessStoredMailAsync();
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message || 'reprocess failed' });
    }
  });

  /** Fast re-link stored mail using case/order/SN learned across the inbox (+ label filenames). */
  app.post('/api/ms-email/relink', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    try {
      const unmatchedOnly = !(req.body && req.body.all === true);
      const labelPass = enrichLabelsWithOcr({ force: false });
      const result = relinkStoredMail({ unmatchedOnly, skipReplyHooks: true });
      // Second pass: newly created tickets/SNs unlock more siblings
      const result2 = relinkStoredMail({ unmatchedOnly: true, skipReplyHooks: true });
      res.json({ ok: true, labels: labelPass, pass1: result, pass2: result2 });
    } catch (e) {
      console.error('/api/ms-email/relink', e);
      res.status(500).json({ error: e.message || 'relink failed' });
    }
  });

  /**
   * Import .eml / .msg-as-eml files directly (no IMAP forward).
   * Multipart field name: files (multiple allowed).
   */
  if (multer) {
    const emlUpload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 25 * 1024 * 1024, files: 50 },
      fileFilter: (req, file, cb) => {
        const name = String(file.originalname || '').toLowerCase();
        const ok = name.endsWith('.eml')
          || name.endsWith('.emltpl')
          || /message\/rfc822|application\/octet-stream|text\/plain/i.test(file.mimetype || '');
        cb(ok ? null : new Error('Only .eml files are accepted'), ok);
      }
    });

    app.post('/api/ms-email/import-eml', (req, res) => {
      if (!req.session || !req.session.loggedIn) {
        return res.status(401).json({ error: 'Login required' });
      }
      emlUpload.array('files', 50)(req, res, async (err) => {
        if (err) {
          return res.status(400).json({ error: err.message || 'upload failed' });
        }
        try {
          const files = Array.isArray(req.files) ? req.files : [];
          if (!files.length) {
            return res.status(400).json({ error: 'No .eml files uploaded (field name: files)' });
          }
          const result = await importEmlBuffers(files);
          res.json(result);
        } catch (e) {
          console.error('/api/ms-email/import-eml', e);
          res.status(500).json({ error: e.message || 'import failed' });
        }
      });
    });
  }

  app.get('/api/ms-email/recent', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    ensureDirs();
    const files = fs.readdirSync(INBOX_DIR)
      .filter((f) => f.endsWith('.json') && f !== 'state.json' && f !== 'ms_cases.json')
      .sort()
      .reverse()
      .slice(0, 40);
    const items = files.map((f) => loadJson(path.join(INBOX_DIR, f), null)).filter(Boolean);
    res.json({ ok: true, count: items.length, items });
  });

  app.get('/api/ms-email/cases', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const reg = loadCaseRegistry();
    const cases = Object.keys(reg).map((id) => reg[id]).sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    );
    res.json({ ok: true, count: cases.length, cases });
  });

  /** Case/order emails that never landed on a repair ticket — grouped 1 row per case/order. */
  app.get('/api/ms-email/unmatched', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    ensureDirs();
    const files = fs.readdirSync(INBOX_DIR)
      .filter((f) => /^uid-\d+\.json$/.test(f))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    const repairs = loadJson(REPAIR_NEEDED_PATH, []);
    const openWaiting = Array.isArray(repairs)
      ? repairs.filter((t) => t && !['resolved', 'cannot_resolve'].includes(String(t.status || ''))
        && (String(t.status || '').startsWith('ms_') || !t.msCaseId))
      : [];

    function suggestForRow(fields, subject) {
      const suggestions = [];
      const caseIds = (fields.cases || []).map(String);
      const subj = String(subject || '').toLowerCase();
      const titleBits = subj
        .replace(/fwd?:|re:|trackingid#\d+/gi, ' ')
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3)
        .slice(0, 8);

      for (const t of openWaiting) {
        let score = 0;
        const reasons = [];
        if (!t.msCaseId && caseIds.length) {
          score += 2;
          reasons.push('no case yet');
        }
        if (t.msCaseId && caseIds.includes(String(t.msCaseId))) {
          score += 10;
          reasons.push('same case');
        }
        const model = String(t.msDeviceModel || t.issue || '').toLowerCase();
        const hitWords = titleBits.filter((w) => model.includes(w));
        if (hitWords.length) {
          score += hitWords.length;
          reasons.push(`title~${hitWords.slice(0, 2).join(',')}`);
        }
        if (String(t.status || '') === 'ms_waiting_case') score += 1;
        if (score < 2) continue;
        suggestions.push({
          id: t.id,
          serialNumber: t.serialNumber,
          status: t.status,
          msCaseId: t.msCaseId || null,
          score,
          reason: reasons.join('; ')
        });
      }
      suggestions.sort((a, b) => b.score - a.score);
      return suggestions.slice(0, 5);
    }

    const items = [];
    for (const f of files.slice(0, 200)) {
      const rec = loadJson(path.join(INBOX_DIR, f), null);
      if (!rec) continue;
      const matched = Number(rec.matchedTickets) || 0;
      const created = Number(rec.createdTickets) || 0;
      if (matched > 0 || created > 0) continue;
      const fields = rec.fields || {};
      if (!(fields.cases || []).length && !(fields.orders || []).length && !(fields.serials || []).length) {
        continue;
      }
      items.push({
        uid: rec.uid,
        subject: rec.subject,
        from: rec.from,
        date: rec.date,
        at: rec.at,
        cases: fields.cases || [],
        orders: fields.orders || [],
        serials: fields.serials || [],
        tracking: fields.tracking || [],
        trackingInbound: fields.trackingInbound || [],
        trackingOutbound: fields.trackingOutbound || [],
        suggestStatus: fields.suggestStatus || null,
        program: fields.program || null,
        preview: (rec.preview || '').slice(0, 240),
        suggestions: suggestForRow(fields, rec.subject)
      });
    }

    // One group per primary case, else order, else single-email orphan
    const groupMap = new Map();
    for (const row of items) {
      const caseId = (row.cases || [])[0] ? String(row.cases[0]) : null;
      const orderId = (row.orders || [])[0] ? String(row.orders[0]) : null;
      let key;
      let kind;
      let label;
      if (caseId) {
        key = `case:${caseId}`;
        kind = 'case';
        label = caseId;
      } else if (orderId) {
        key = `order:${orderId}`;
        kind = 'order';
        label = orderId;
      } else {
        key = `uid:${row.uid}`;
        kind = 'email';
        label = String(row.uid);
      }
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          key,
          kind,
          label,
          cases: [],
          orders: [],
          serials: [],
          uids: [],
          emails: [],
          subject: row.subject,
          date: row.date,
          suggestions: row.suggestions || []
        });
      }
      const g = groupMap.get(key);
      g.uids.push(row.uid);
      g.emails.push({
        uid: row.uid,
        subject: row.subject,
        date: row.date
      });
      for (const c of row.cases || []) uniqPush(g.cases, String(c));
      for (const o of row.orders || []) uniqPush(g.orders, String(o));
      for (const s of row.serials || []) uniqPush(g.serials, String(s).toUpperCase());
      // Prefer newest subject/date (items already newest-first)
      if (!g.date || String(row.date || '') > String(g.date || '')) {
        g.date = row.date;
        g.subject = row.subject;
      }
      if ((row.suggestions || []).length > (g.suggestions || []).length) {
        g.suggestions = row.suggestions;
      }
    }

    const groups = [...groupMap.values()].sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || ''))
    );

    res.json({
      ok: true,
      count: items.length,
      groupCount: groups.length,
      items, // raw emails (compat)
      groups
    });
  });

  /** Manually attach a serial to unmatched mail → create/update ticket. */
  app.post('/api/ms-email/attach-serial', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    try {
      const body = req.body || {};
      const serialNumber = String(body.serialNumber || '').trim().toUpperCase();
      const uidList = Array.isArray(body.uids)
        ? body.uids.map((u) => Number(u)).filter((u) => u > 0)
        : (body.uid != null ? [Number(body.uid)] : []);
      if (!uidList.length || !serialNumber) {
        return res.status(400).json({ error: 'uid(s) and serialNumber required' });
      }
      if (!isValidSurfaceSerial(serialNumber) && !/^[0-9A-Z]{8,20}$/i.test(serialNumber)) {
        return res.status(400).json({ error: 'serialNumber looks invalid' });
      }

      let matched = 0;
      let created = 0;
      const ticketIds = new Set();
      for (const uid of uidList) {
        const record = loadJson(recordPathForUid(uid), null);
        if (!record) continue;
        if (!record.fields) record.fields = {};
        if (!Array.isArray(record.fields.serials)) record.fields.serials = [];
        if (!record.fields.serials.map((s) => String(s).toUpperCase()).includes(serialNumber)) {
          record.fields.serials.unshift(serialNumber);
        }
        const apply = applyToRepairTickets(record.fields, {
          subject: record.subject,
          from: record.from,
          emailDate: record.date || null,
          uid: record.uid
        });
        record.matchedTickets = apply.matched;
        record.createdTickets = apply.created || 0;
        record.matchedTicketIds = apply.ticketIds || [];
        record.attachedSerial = serialNumber;
        atomicWriteJsonSync(recordPathForUid(uid), record);
        matched += apply.matched;
        created += apply.created || 0;
        for (const id of apply.ticketIds || []) ticketIds.add(id);
        if (replyHooks && typeof replyHooks.afterEmailApplied === 'function') {
          try {
            await replyHooks.afterEmailApplied(record, apply.ticketIds || []);
          } catch (e) {
            console.error('[ms_email] afterEmailApplied attach', e.message);
          }
        }
      }
      res.json({
        ok: true,
        matched,
        created,
        uids: uidList,
        ticketIds: [...ticketIds]
      });
    } catch (e) {
      console.error('/api/ms-email/attach-serial', e);
      res.status(500).json({ error: e.message || 'attach failed' });
    }
  });

  /** Attach an unmatched case email to an existing open ticket (set case + backfill). */
  app.post('/api/ms-email/attach-case', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    try {
      const uid = Number((req.body || {}).uid);
      const ticketId = String((req.body || {}).ticketId || '').trim();
      const serialNumber = String((req.body || {}).serialNumber || '').trim().toUpperCase();
      if (!uid || (!ticketId && !serialNumber)) {
        return res.status(400).json({ error: 'uid and ticketId (or serialNumber) required' });
      }
      const record = loadJson(recordPathForUid(uid), null);
      if (!record) return res.status(404).json({ error: 'Email record not found' });
      const log = loadJson(REPAIR_NEEDED_PATH, []);
      if (!Array.isArray(log)) return res.status(500).json({ error: 'repair log missing' });

      let ticket = null;
      if (ticketId) ticket = log.find((t) => t && String(t.id) === ticketId);
      if (!ticket && serialNumber) {
        ticket = log.find((t) => t && ticketSerialKeys(t).has(serialKey(serialNumber))
          && !['resolved', 'cannot_resolve'].includes(String(t.status || '')));
      }
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

      if (!record.fields) record.fields = {};
      if (serialNumber) {
        if (!Array.isArray(record.fields.serials)) record.fields.serials = [];
        if (!record.fields.serials.map((s) => String(s).toUpperCase()).includes(serialNumber)) {
          record.fields.serials.unshift(serialNumber);
        }
      } else if (ticket.serialNumber) {
        if (!Array.isArray(record.fields.serials)) record.fields.serials = [];
        const sn = String(ticket.serialNumber).toUpperCase();
        if (!record.fields.serials.map((s) => String(s).toUpperCase()).includes(sn)) {
          record.fields.serials.unshift(sn);
        }
      }

      const apply = applyToRepairTickets(record.fields, {
        subject: record.subject,
        from: record.from,
        emailDate: record.date || null,
        uid: record.uid
      });
      // Ensure case lands even if apply was scoped oddly
      const cases = record.fields.cases || [];
      if (cases[0] && !ticket.msCaseId) {
        const fresh = loadJson(REPAIR_NEEDED_PATH, []);
        const idx = Array.isArray(fresh) ? fresh.findIndex((t) => t && t.id === ticket.id) : -1;
        if (idx >= 0) {
          fresh[idx].msCaseId = cases[0];
          atomicWriteJsonSync(REPAIR_NEEDED_PATH, fresh);
        }
      }

      record.matchedTickets = Math.max(Number(record.matchedTickets) || 0, apply.matched, 1);
      record.createdTickets = apply.created || 0;
      record.matchedTicketIds = apply.ticketIds || [ticket.id];
      record.attachedTicketId = ticket.id;
      atomicWriteJsonSync(recordPathForUid(uid), record);

      // Backfill other unmatched UIDs sharing this case
      let backfilled = 0;
      for (const c of cases) {
        const files2 = fs.readdirSync(INBOX_DIR).filter((f) => /^uid-\d+\.json$/.test(f));
        for (const f of files2) {
          const rec2 = loadJson(path.join(INBOX_DIR, f), null);
          if (!rec2 || Number(rec2.matchedTickets) > 0 || Number(rec2.createdTickets) > 0) continue;
          const cases2 = (rec2.fields && rec2.fields.cases) || [];
          if (!cases2.map(String).includes(String(c))) continue;
          if (!rec2.fields.serials) rec2.fields.serials = [];
          const sn = String(ticket.serialNumber || serialNumber || '').toUpperCase();
          if (sn && !rec2.fields.serials.map((s) => String(s).toUpperCase()).includes(sn)) {
            rec2.fields.serials.unshift(sn);
          }
          const a2 = applyToRepairTickets(rec2.fields, {
            subject: rec2.subject,
            from: rec2.from,
            emailDate: rec2.date || null,
            uid: rec2.uid
          });
          rec2.matchedTickets = Math.max(Number(rec2.matchedTickets) || 0, a2.matched, 1);
          rec2.createdTickets = a2.created || 0;
          rec2.matchedTicketIds = a2.ticketIds || [];
          atomicWriteJsonSync(path.join(INBOX_DIR, f), rec2);
          backfilled += 1;
        }
      }

      res.json({
        ok: true,
        matched: apply.matched,
        created: apply.created,
        ticketIds: apply.ticketIds || [ticket.id],
        backfilled
      });
    } catch (e) {
      console.error('/api/ms-email/attach-case', e);
      res.status(500).json({ error: e.message || 'attach-case failed' });
    }
  });

  app.get('/api/ms-email/labels/:id', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    ensureDirs();
    const id = String(req.params.id || '').replace(/[^\w\-]/g, '');
    if (!id) return res.status(400).json({ error: 'Missing label id' });
    const files = fs.readdirSync(LABELS_DIR).filter((f) => f.startsWith(`${id}_`) || f === `${id}.pdf`);
    if (!files.length) return res.status(404).json({ error: 'Label not found' });
    const file = files.sort((a, b) => b.length - a.length)[0];
    const full = path.join(LABELS_DIR, file);
    const downloadName = file.replace(new RegExp(`^${id}_`), '') || 'ShippingLabel.pdf';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${downloadName.replace(/"/g, '')}"`);
    fs.createReadStream(full).pipe(res);
  });
}

/** Promote replacement SN to inventory identity at check-in. */
function promoteReplacementSerial(ticket, confirmedSn, opts = {}) {
  if (!ticket) return { ok: false, error: 'no ticket' };
  const now = opts.at || new Date().toISOString();
  const confirmed = String(confirmedSn || ticket.msReplacementSerial || '').trim().toUpperCase();
  if (!confirmed) return { ok: false, error: 'replacement serial required' };
  if (!isValidSurfaceSerial(confirmed) && !/^[0-9A-Z]{8,20}$/i.test(confirmed)) {
    return { ok: false, error: 'invalid serial' };
  }
  const prev = String(ticket.serialNumber || '').toUpperCase();
  if (!ticket.msDefectiveSerial && prev && prev !== confirmed) {
    ticket.msDefectiveSerial = prev;
    pushSerialHistory(ticket, prev, 'defective', now);
  }
  ticket.msReplacementSerial = confirmed;
  pushSerialHistory(ticket, confirmed, 'replacement', now);
  if (prev !== confirmed) {
    ticket.serialNumber = confirmed;
    pushSerialHistory(ticket, confirmed, 'inventory', now);
  }
  if (!ticket.msProgram) ticket.msProgram = 'advanced_exchange';
  return { ok: true, serialNumber: ticket.serialNumber, msDefectiveSerial: ticket.msDefectiveSerial, msReplacementSerial: ticket.msReplacementSerial };
}

module.exports = {
  setupMsEmailInbox,
  pollOnce,
  loadConfig,
  extractFields,
  reprocessStoredMailAsync,
  relinkStoredMail,
  enrichLabelsWithOcr,
  buildInboxIdentityIndex,
  emailSearchText,
  isValidSurfaceSerial,
  ticketSerialKeys,
  promoteReplacementSerial,
  classifyTracking,
  ingestEmlSource,
  importEmlBuffers,
  applyToRepairTickets,
  parseLabelFilename,
  mergeLabelFieldsIntoParsed,
  scrubStoredMailFields,
  scrubStoredMailFieldsAsync,
  enrichFieldsFromIdentityIndex
};
