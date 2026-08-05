/**
 * MS email replies: full thread view, attachment/image serving, and
 * draft replies with edit / AI improve / Approve / Reject.
 *
 * Primary draft writer is Cursor Agent AI — it reads the newest MS email and
 * case briefing and composes a real reply. Canned templates are fallback only
 * when AI is unavailable. Approval stays manual — no auto-send.
 *
 * Draft AI uses the server Cursor Agent CLI (logged-in account) — not OpenAI.
 * Mode is ask (read-only rewrite); model quality comes from --model.
 *
 * SMTP send runs only when account/ms_returns_mail.json has smtp.enabled=true.
 * Until then, Approve marks the draft approved_queued (ready to send later).
 */
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { simpleParser } = require('mailparser');
const { atomicWriteJsonSync } = require('./atomic_json.js');

/** Prefer actionable replies when several templates match the same email. */
const TEMPLATE_PRIORITY = Object.freeze({
  ai_reply: 200,
  provide_return_address: 100,
  answer_troubleshooting: 97,
  provide_documents: 95,
  provide_device_details: 90,
  keep_case_open: 80,
  ack_label_will_ship: 70,
  ack_delivery_checkin: 60,
  ack_case_update: 10
});

const ROOT = path.join(__dirname, '..');
const INBOX_DIR = path.join(ROOT, 'db', 'ms_email_inbox');
const RAW_DIR = path.join(INBOX_DIR, 'raw');
const ATT_DIR = path.join(INBOX_DIR, 'attachments');
const DRAFTS_PATH = path.join(INBOX_DIR, 'drafts.json');
const TRAINING_PATH = path.join(INBOX_DIR, 'draft_training.json');
const DRAFT_UPLOAD_DIR = path.join(INBOX_DIR, 'draft_uploads');
const AI_PROMPT_DIR = path.join(INBOX_DIR, 'ai_prompts');
const REPAIR_NEEDED_PATH = path.join(ROOT, 'db', 'repair_needed.json');
const CONFIG_PATH = path.join(ROOT, 'account', 'ms_returns_mail.json');
const RETURN_ADDRESS_PATH = path.join(ROOT, 'account', 'ms_return_address.json');

const CURSOR_AGENT_BIN = process.env.OA_CURSOR_AGENT || '/root/.local/bin/cursor-agent';
const CURSOR_TIMEOUT_MS = Number(process.env.OA_MS_EMAIL_AI_TIMEOUT_MS || 120000);
const CURSOR_WORKSPACE = process.env.OA_MS_EMAIL_AI_WORKSPACE || '/tmp/oa-ms-email-ai-workspace';
/** Prefer Auto (plan-safe). Override with OA_MS_EMAIL_MODEL when premium quota allows. */
const CURSOR_MODEL = process.env.OA_MS_EMAIL_MODEL || 'auto';

let multer = null;
try {
  multer = require('multer');
} catch (e) {
  console.error('[ms_email_replies] multer not loaded — draft file upload disabled', e.message);
}

/** Fallback if account/ms_return_address.json is missing. */
const DEFAULT_RETURN_ADDRESS = Object.freeze({
  organization: 'Digital Delivered Inc',
  street1: '3408 Ave N',
  street2: 'STE 33',
  city: 'Brooklyn',
  state: 'NY',
  postalCode: '11234',
  attention: 'Abe',
  email: 'Abe@visicllc.com',
  phone: '718 717 4431'
});

function ensureDirs() {
  for (const dir of [INBOX_DIR, RAW_DIR, ATT_DIR, DRAFT_UPLOAD_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('ms_email_replies loadJson', filePath, e.message);
    return fallback;
  }
}

function loadDrafts() {
  const data = loadJson(DRAFTS_PATH, []);
  return Array.isArray(data) ? data : [];
}

function saveDrafts(rows) {
  ensureDirs();
  atomicWriteJsonSync(DRAFTS_PATH, rows);
}

function loadTraining() {
  const data = loadJson(TRAINING_PATH, []);
  return Array.isArray(data) ? data : [];
}

function saveTraining(rows) {
  ensureDirs();
  atomicWriteJsonSync(TRAINING_PATH, rows);
}

function loadConfig() {
  return loadJson(CONFIG_PATH, null);
}

function loadReturnAddress() {
  const raw = loadJson(RETURN_ADDRESS_PATH, null);
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RETURN_ADDRESS };
  return {
    organization: String(raw.organization || DEFAULT_RETURN_ADDRESS.organization).trim(),
    street1: String(raw.street1 || DEFAULT_RETURN_ADDRESS.street1).trim(),
    street2: String(raw.street2 || DEFAULT_RETURN_ADDRESS.street2).trim(),
    city: String(raw.city || DEFAULT_RETURN_ADDRESS.city).trim(),
    state: String(raw.state || DEFAULT_RETURN_ADDRESS.state).trim(),
    postalCode: String(raw.postalCode || DEFAULT_RETURN_ADDRESS.postalCode).trim(),
    attention: String(raw.attention || DEFAULT_RETURN_ADDRESS.attention).trim(),
    email: String(raw.email || DEFAULT_RETURN_ADDRESS.email).trim(),
    phone: String(raw.phone || DEFAULT_RETURN_ADDRESS.phone).trim()
  };
}

/** Multi-line block for MS reply drafts. */
function formatReturnAddressBlock(addr) {
  const a = addr || loadReturnAddress();
  const lines = [
    `Organization Name: ${a.organization}`,
    `Shipping Address: ${a.street1}, ${a.city}, ${a.state}, ${a.postalCode}`,
    a.street2 ? `STE: ${a.street2.replace(/^STE:?\s*/i, '')}` : null,
    `Attention: ${a.attention}`,
    `Email: ${a.email}`,
    `Phone Number: ${a.phone}`
  ].filter(Boolean);
  return lines.join('\n');
}

function msAsksForAddress(text) {
  const low = String(text || '').toLowerCase();
  return /shipping address|return address|mailing address|your address|provide.{0,40}address|confirm.{0,40}address|ship.?to address|where (?:should|do|can).{0,40}(?:ship|send)|address (?:to|for) (?:ship|return|send)|please (?:send|provide|share).{0,30}address/.test(low);
}

function msAsksForDocuments(text) {
  const low = String(text || '').toLowerCase();
  return /proof of purchase|proof-of-purchase|purchase (?:receipt|invoice)|invoice|receipt|upload.{0,40}(?:document|file|pdf|photo)|attach.{0,40}(?:document|proof|invoice|receipt|photo)|provide.{0,40}(?:document|proof|invoice|receipt)|send.{0,40}(?:proof|invoice|receipt|photo of)|documentation (?:required|needed)/.test(low);
}

/** MS is asking warehouse-style diagnostic questions (updates, UEFI, MSDT, wipe, battery, etc.). */
function msAsksForTroubleshooting(text) {
  const low = String(text || '').toLowerCase();
  const cues = [
    /have you tried/,
    /have you checked/,
    /do you see any (?:error|messages?)/,
    /would you kindly share the following information/,
    /please share (?:with me )?the following information/,
    /in order to document this case/,
    /to properly isolate your issue/,
    /surface diagnostic toolkit|msdt/,
    /\buefi\b/,
    /device manager/,
    /wiping your surface|wipe your surface|factory reset|reimage/,
    /download drivers and firmware for surface/,
    /power supply|charger|battery icon|smart charging|power mode/,
    /does the device turn off after removing/,
    /how long does the battery/
  ];
  let hits = 0;
  for (const re of cues) {
    if (re.test(low)) hits += 1;
  }
  return hits >= 2;
}

/**
 * Pull the actual questions MS asked (so we never answer a different checklist).
 */
function extractMsTroubleshootingQuestions(bodyText) {
  const text = String(bodyText || '').replace(/\r/g, '\n');
  // Prefer the region after "share the following information" / similar
  let region = text;
  const start = text.search(
    /(?:share the following information|to properly isolate|in order to document|would you kindly|please (?:answer|confirm|provide) the following)[^\n]*\n/i
  );
  if (start >= 0) region = text.slice(start);
  const end = region.search(
    /\n\s*(?:if you have any questions|best regards|thank you(?: again)?[!,.]?\s*\n|sincerely|please [“"]?reply all)/i
  );
  if (end > 80) region = region.slice(0, end);

  const lines = region.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const questions = [];
  let buf = '';
  const flush = () => {
    const q = buf.replace(/\s+/g, ' ').trim();
    buf = '';
    if (q.length < 12) return;
    if (!/[?]/.test(q) && !/^(?:does|do|is|are|have|has|can|could|would|how|what|when|where|please|confirm|kindly)\b/i.test(q)) {
      return;
    }
    // Drop signature / boilerplate
    if (/best regards|advocate engineer|working hours|reply all|v-[a-z0-9]+@microsoft/i.test(q)) return;
    questions.push(q.replace(/^[0-9]+[.)]\s*/, '').slice(0, 400));
  };

  for (const line of lines) {
    if (/^(?:from|to|cc|date|subject)\b/i.test(line)) continue;
    if (/^dear\b|^hello\b|^hi\b|^thank you for contacting/i.test(line)) continue;
    const startsQ = /^(?:\d+[.)]\s+|[-*•]\s+|(?:does|do|is|are|have|has|can|could|would|how|what)\b)/i.test(line)
      || /\?\s*$/.test(line);
    if (startsQ && buf) flush();
    if (startsQ || buf) {
      buf = buf ? `${buf} ${line}` : line;
      if (/\?\s*$/.test(line) || /learn\s*$/i.test(line)) flush();
    }
  }
  flush();

  // Dedupe near-duplicates
  const out = [];
  const seen = new Set();
  for (const q of questions) {
    const cleaned = q
      .replace(/<https?:\/\/[^>]+>/gi, '')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\s*<\s*$/g, '')
      .replace(/\s*&\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const key = cleaned.toLowerCase().slice(0, 80);
    if (cleaned.length < 12 || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned.slice(0, 320));
  }
  return out.slice(0, 12);
}

function classifyIssueKind(ticket, bodyText) {
  const blob = `${(ticket && ticket.issue) || ''}\n${bodyText || ''}`.toLowerCase();
  if (/batter|charge|charging|power.?supply|won'?t hold|does not hold|dead battery/.test(blob)) return 'battery';
  if (/touch|digitizer|screen|display|lcd|black screen/.test(blob)) return 'touch_display';
  if (/keyboard|key(s)? (not|won'?t)|type cover/.test(blob)) return 'keyboard';
  if (/wifi|wireless|bluetooth|network/.test(blob)) return 'wifi';
  if (/audio|speaker|microphone|sound/.test(blob)) return 'audio';
  return 'hardware';
}

function answerOneMsQuestion(question, issueKind, issue) {
  const q = String(question || '').toLowerCase();
  const issueLabel = issue || 'the reported hardware fault';

  // --- Battery / power questions (Opal-style) ---
  if (/turn off after removing|after removing the power|unplug/.test(q) && /power|supply|charger|battery|turn off/.test(q)) {
    return 'Yes — once the charger/PSU is removed, the device does not sustain normal operation on battery as expected for this fault. The battery issue still persists.';
  }
  if (/tip lit|solid white|known-good power|another.{0,20}power supply|charger works/.test(q)
    || (/charger connected/.test(q) && /tip|white|power supply/.test(q))) {
    return 'Yes — we verified charging hardware: the charger tip indicates power as expected, and behavior was checked with a known-good Surface power supply. The battery still will not hold a proper charge.';
  }
  // Power mode BEFORE battery-icon — MS power-mode steps also say “battery icon on the taskbar”
  if (/power mode/.test(q) || (/settings\s*>\s*system\s*>\s*power/.test(q) && /recommended/.test(q))) {
    return 'Yes — Power mode was checked/set to Recommended (Settings > System > Power & battery / taskbar battery). The battery issue still persists.';
  }
  if (/hover over the battery|plugged in, charging|plugged in, not charging/.test(q)
    || (/battery icon/.test(q) && /plugged in|charging|hover/.test(q))) {
    return 'When hovering the battery icon we see charging status that does not match healthy battery behavior for this unit (charge does not hold / does not behave normally). The issue still persists.';
  }
  if (/how long does the battery|battery charge last|battery life|how long.{0,40}charge/.test(q)) {
    return 'Battery runtime is abnormal / does not hold a usable charge under normal warehouse checks — far below expected Surface Pro battery life. This matches the reported “battery does not hold” fault.';
  }
  if (/smart charging|stop charging at around 80|below 20%/.test(q)) {
    return 'Yes — we checked Battery Smart Charging. This is not a Smart Charging / 80% limit behavior; the battery still fails to hold a normal charge after the suggested discharge/recharge check.';
  }
  if (/reimage|data eraser|recovery tool|surface recovery/.test(q)) {
    return 'Yes — imaging / recovery steps were completed as part of our warehouse process where applicable (including Surface recovery tooling when needed). The battery issue still persists after reimage/recovery.';
  }

  // --- Updates + MSDT often asked together ---
  if (/windows updates|up to date with windows/.test(q) && /diagnostic toolkit|msdt|surface diagnostic/.test(q)) {
    if (issueKind === 'battery') {
      return 'Yes — Windows Update / Surface drivers & firmware are current, and we ran the Microsoft Surface Diagnostic Toolkit for Business (battery/power-related checks). Results were abnormal / consistent with a battery fault. The issue still persists.';
    }
    return `Yes — Windows Update / Surface drivers & firmware are current, and we ran MSDT for this symptom (${issueLabel}). Results were abnormal / failed. The issue still persists.`;
  }
  if (/windows updates|up to date with windows|drivers and firmware|download drivers/.test(q)) {
    return 'Yes — Windows Update and Surface drivers/firmware were checked and applied. The issue still persists.';
  }
  if (/surface diagnostic toolkit|msdt|diagnostic tool/.test(q)) {
    if (issueKind === 'battery') {
      return 'Yes — we ran the Microsoft Surface Diagnostic Toolkit for Business (including battery/power-related checks available in the toolkit). Results were abnormal / consistent with a battery fault. The issue still persists.';
    }
    if (issueKind === 'touch_display') {
      return 'Yes — we ran MSDT including touch/display tests. Results were abnormal / failed and match the reported touch/display issue.';
    }
    return `Yes — we ran the Microsoft Surface Diagnostic Toolkit for Business for this symptom (${issueLabel}). Results were abnormal / failed. The issue still persists.`;
  }
  if (/\buefi\b|volume-up|volume up \+ power/.test(q)) {
    return 'Yes — booted to UEFI (Volume-up + Power) and tested. The fault still presents at UEFI level where applicable (points away from a simple OS-only issue).';
  }
  if (/device manager/.test(q)) {
    return 'Yes — Device Manager was reviewed. No software-only fix resolved the fault; findings remain consistent with a hardware defect for this symptom.';
  }
  if (/wiping|wipe your|factory reset|reset your surface/.test(q)) {
    return 'Yes — wipe/reset was completed as part of our standard warehouse process where applicable. The issue still persists after wipe.';
  }
  if (/error code|do you see any error/.test(q)) {
    return 'No separate actionable OS error code resolved the case; the hardware symptom remains as reported.';
  }

  // Fallback: still answer THIS question, never a different topic
  return `Yes — completed on our side as part of warehouse troubleshooting for “${issueLabel}”. The issue still persists after this check.`;
}

/**
 * Point-by-point answers to the questions MS actually asked in the newest email.
 * Default stance: warehouse already completed standard steps; issue persists.
 */
function buildTroubleshootingAnswers(ticket, bodyText) {
  const issue = String((ticket && ticket.issue) || '')
    .replace(/^From MS email:\s*/i, '')
    .slice(0, 180) || 'the reported hardware fault';
  const note = String((ticket && (ticket.msTroubleshootingNote || ticket.msCaseBriefing)) || '').trim();
  const issueKind = classifyIssueKind(ticket, bodyText);
  const questions = extractMsTroubleshootingQuestions(bodyText);

  const lines = [
    'We have already completed the requested troubleshooting on our side. Answers to your questions below:',
    ''
  ];

  if (questions.length) {
    questions.forEach((q, i) => {
      const ans = answerOneMsQuestion(q, issueKind, issue);
      lines.push(`${i + 1}) ${q}`);
      lines.push(`   ${ans}`);
      lines.push('');
    });
  } else {
    // No clear question list parsed — still avoid the old touch-only script
    const low = String(bodyText || '').toLowerCase();
    const fallbackQs = [];
    if (/turn off after removing|power supply/.test(low)) fallbackQs.push('Does the device turn off after removing the power supply unit?');
    if (/tip lit|charger|known-good/.test(low)) fallbackQs.push('Charger tip / known-good power supply checks?');
    if (/battery icon|plugged in/.test(low)) fallbackQs.push('Battery icon charging status?');
    if (/windows updates|diagnostic toolkit|msdt/.test(low)) fallbackQs.push('Windows updates / Surface Diagnostic Toolkit?');
    if (/how long does the battery|battery charge last/.test(low)) fallbackQs.push('How long does the battery charge last?');
    if (/power mode/.test(low)) fallbackQs.push('Power mode set to Recommended?');
    if (/reimage|recovery|data eraser/.test(low)) fallbackQs.push('Reimage / Surface Recovery / Data Eraser?');
    if (/smart charging/.test(low)) fallbackQs.push('Battery Smart Charging checked?');
    if (/uefi/.test(low)) fallbackQs.push('UEFI test?');
    if (/device manager/.test(low)) fallbackQs.push('Device Manager reviewed?');
    if (/wiping|wipe your|factory reset/.test(low)) fallbackQs.push('Wipe / reset completed?');
    const use = fallbackQs.length ? fallbackQs : [
      'Standard warehouse troubleshooting for this symptom completed?'
    ];
    use.forEach((q, i) => {
      lines.push(`${i + 1}) ${q}`);
      lines.push(`   ${answerOneMsQuestion(q, issueKind, issue)}`);
      lines.push('');
    });
  }

  lines.push(`Reported issue on our side: ${issue}.`);
  if (note) {
    lines.push(`Additional warehouse notes: ${note.slice(0, 500)}`);
  }
  lines.push('Please proceed with the warranty service offer / next repair steps.');
  return lines.join('\n');
}

function pushConsoleNotification(payload) {
  try {
    const notif = require('./console_notifications.js');
    if (notif && typeof notif.pushNotification === 'function') {
      return notif.pushNotification(payload);
    }
  } catch (e) {
    console.error('[ms_email_replies] notify', e.message);
  }
  return null;
}

/**
 * Stage-aware case context for AI — what was already discussed / done.
 * First outbound to MS is often NOT in the inbox (MS won't quote it), so
 * msCaseBriefing / issue / troubleshooting notes are critical.
 */
function buildTicketStageContext(ticket) {
  if (!ticket) return '(no ticket)';
  const siblings = ticketsForSameCase(ticket);
  const lines = [];
  lines.push(`Pipeline status: ${ticket.status || 'unknown'}`);
  lines.push(`Serial (this ticket): ${ticket.serialNumber || '(unknown — may still need to be confirmed to MS)'}`);
  lines.push(`MS case: ${ticket.msCaseId || '(none yet)'}`);
  if (siblings.length > 1) {
    lines.push(`Devices on this MS case (${siblings.length}):`);
    for (const t of siblings) {
      const issue = String(t.issue || '').replace(/^From MS email:\s*/i, '').slice(0, 160);
      lines.push(`- ${t.serialNumber || '(no SN)'} · ${t.status || '?'}${issue ? ` · ${issue}` : ''}`);
    }
  }
  lines.push(`MS order: ${ticket.msOrderNumber || '(none yet)'}`);
  lines.push(`MS program: ${ticket.msProgram || ticket.msProgramLabel || '(unknown)'}`);
  lines.push(`Model / device: ${ticket.msDeviceModel || ticket.warrantyDeviceName || ticket.model || '(unknown)'}`);
  if (ticket.warrantyExpires) lines.push(`Warranty expires: ${ticket.warrantyExpires}`);
  lines.push('');
  lines.push('DEVICE ISSUE (what is wrong):');
  lines.push(String(ticket.issue || '(not recorded yet — ask operator)').slice(0, 1200));
  lines.push('');
  lines.push('CASE BRIEFING (what we already told MS / first contact — often NOT in the email thread):');
  lines.push(String(ticket.msCaseBriefing || '(empty — operator should fill: first message to MS was issue-only / SN follow-up)')
    .slice(0, 2000));
  lines.push('');
  lines.push('TROUBLESHOOTING ALREADY DONE (assume complete unless briefing says otherwise):');
  lines.push(String(ticket.msTroubleshootingNote
    || 'Assume warehouse already completed standard Surface troubleshooting for this symptom. Do not ask MS to walk us through basic steps we already did. Instead state what we tested and ask MS for next warranty action (advanced diagnostics / RMA / replacement).')
    .slice(0, 2000));

  const notes = Array.isArray(ticket.notes) ? ticket.notes.slice(-8) : [];
  if (notes.length) {
    lines.push('');
    lines.push('OPERATOR NOTES (recent):');
    for (const n of notes) {
      lines.push(`- [${n.at || ''}] ${n.by || ''}: ${String(n.text || '').slice(0, 300)}`);
    }
  }
  const hist = Array.isArray(ticket.statusHistory) ? ticket.statusHistory.slice(-8) : [];
  if (hist.length) {
    lines.push('');
    lines.push('STATUS HISTORY (recent):');
    for (const h of hist) {
      lines.push(`- [${h.at || ''}] ${h.status || ''}${h.note ? ` — ${String(h.note).slice(0, 200)}` : ''}`);
    }
  }
  const events = Array.isArray(ticket.msEmailEvents) ? ticket.msEmailEvents.slice(-10) : [];
  if (events.length) {
    lines.push('');
    lines.push('EMAIL EVENTS ALREADY APPLIED TO TICKET:');
    for (const e of events) {
      lines.push(`- [${e.emailDate || e.at || ''}] ${e.subject || ''} (${(e.changes || []).join(', ')})`);
    }
  }
  if (ticket.outboundTracking) lines.push(`Outbound TN: ${ticket.outboundTracking}`);
  if (ticket.inboundTracking) lines.push(`Inbound TN: ${ticket.inboundTracking}`);
  if (siblings.length > 1) {
    lines.push('');
    lines.push('IMPORTANT: This MS case covers multiple devices. Replies to MS must list EVERY serial on the case, not only the ticket currently open.');
  }
  return lines.join('\n');
}

/** All open Repair Needed tickets sharing this MS case number. */
function ticketsForSameCase(ticket) {
  if (!ticket) return [];
  const caseId = String(ticket.msCaseId || '').trim();
  const log = loadJson(REPAIR_NEEDED_PATH, []);
  const closed = new Set(['resolved', 'cannot_resolve']);
  if (!caseId || !Array.isArray(log)) {
    return closed.has(String(ticket.status || '')) ? [] : [ticket];
  }
  const siblings = log.filter((t) => {
    if (!t || closed.has(String(t.status || ''))) return false;
    return String(t.msCaseId || '').trim() === caseId;
  });
  if (!siblings.length) return closed.has(String(ticket.status || '')) ? [] : [ticket];
  siblings.sort((a, b) => String(a.serialNumber || '').localeCompare(String(b.serialNumber || ''), undefined, { sensitivity: 'base' }));
  return siblings;
}

/**
 * Plain-text block listing every device on the case for MS replies.
 * Single-device cases keep the short one-liner format.
 */
function formatCaseDevicesBlock(ticket, opts = {}) {
  const includeIssue = opts.includeIssue !== false;
  const includeModel = !!opts.includeModel;
  const siblings = ticketsForSameCase(ticket);
  if (!siblings.length) {
    const sn = ticket && ticket.serialNumber ? String(ticket.serialNumber) : '';
    return sn ? `Device serial: ${sn}\n` : '';
  }
  if (siblings.length === 1) {
    const t = siblings[0];
    const sn = t.serialNumber || '';
    const issue = includeIssue
      ? String(t.issue || '').replace(/^From MS email:\s*/i, '').slice(0, 240)
      : '';
    const model = includeModel ? (t.warrantyDeviceName || t.msDeviceModel || t.model || '') : '';
    let out = '';
    if (sn) out += `Device serial: ${sn}\n`;
    if (model) out += `Model: ${model}\n`;
    if (issue) out += `Issue: ${issue}\n`;
    return out;
  }
  const lines = [`Devices on this case (${siblings.length}):`];
  siblings.forEach((t, idx) => {
    const sn = t.serialNumber || '(unknown SN)';
    const model = t.warrantyDeviceName || t.msDeviceModel || t.model || '';
    const issue = includeIssue
      ? String(t.issue || '').replace(/^From MS email:\s*/i, '').slice(0, 180)
      : '';
    lines.push(`${idx + 1}) Serial: ${sn}${model ? ` · Model: ${model}` : ''}`);
    if (issue) lines.push(`   Issue: ${issue}`);
  });
  return `${lines.join('\n')}\n`;
}

function recentTrainingExamples(limit = 6) {
  const rows = loadTraining().filter((r) => r && (r.decision === 'approve' || r.decision === 'reject'));
  const slice = rows.slice(-Math.max(1, limit));
  if (!slice.length) return '(none yet)';
  return slice.map((r) => {
    const body = String(r.body || '').replace(/\s+/g, ' ').slice(0, 280);
    return `[${r.decision}] ${r.templateKey || ''} reason=${r.reason || ''}\nSubject: ${r.subject || ''}\nBody: ${body}`;
  }).join('\n\n');
}

function safeDraftId(id) {
  return String(id || '').replace(/[^\w\-]/g, '');
}

function listDraftUploads(draftId) {
  ensureDirs();
  const id = safeDraftId(draftId);
  if (!id) return [];
  const dir = path.join(DRAFT_UPLOAD_DIR, id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f && !f.startsWith('.'))
    .map((filename) => {
      const full = path.join(dir, filename);
      let size = 0;
      try { size = fs.statSync(full).size; } catch (_) { /* ignore */ }
      return {
        id: filename,
        filename: filename.replace(/^\d+_/, ''),
        size,
        downloadPath: `/api/ms-email/drafts/${encodeURIComponent(id)}/files/${encodeURIComponent(filename)}`
      };
    });
}

function draftUploadPaths(draftId) {
  return listDraftUploads(draftId).map((f) => ({
    filename: f.filename,
    path: path.join(DRAFT_UPLOAD_DIR, safeDraftId(draftId), f.id),
    contentType: undefined
  })).filter((f) => fs.existsSync(f.path));
}

function safeName(name) {
  return String(name || 'attachment')
    .replace(/[^\w.\-()+\s]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120) || 'attachment';
}

function isoNow() {
  return new Date().toISOString();
}

/**
 * Save every attachment (images, PDFs, etc.) for thread viewing.
 * Shipping labels remain available via the labels API too.
 */
function extractAndSaveAllAttachments(parsedMail, uid) {
  ensureDirs();
  const out = [];
  const atts = parsedMail.attachments || [];
  let idx = 0;
  for (const att of atts) {
    if (!att || !att.content || !att.content.length) continue;
    idx += 1;
    const original = safeName(att.filename || `part-${idx}`);
    const id = `att-u${uid}-${idx}`;
    const storedName = `${id}_${original}`;
    const fullPath = path.join(ATT_DIR, storedName);
    fs.writeFileSync(fullPath, att.content);
    const cid = att.contentId ? String(att.contentId).replace(/^<|>$/g, '') : null;
    out.push({
      id,
      filename: original,
      storedName,
      uid: Number(uid),
      size: att.content.length,
      contentType: att.contentType || 'application/octet-stream',
      contentId: cid,
      related: !!att.related,
      at: isoNow(),
      downloadPath: `/api/ms-email/attachments/${encodeURIComponent(id)}`
    });
  }
  return out;
}

function listUidRecords() {
  ensureDirs();
  return fs.readdirSync(INBOX_DIR)
    .filter((f) => /^uid-\d+\.json$/.test(f))
    .map((f) => loadJson(path.join(INBOX_DIR, f), null))
    .filter(Boolean)
    .sort((a, b) => Number(a.uid || 0) - Number(b.uid || 0));
}

function ticketIdentity(ticket) {
  const cases = new Set();
  const orders = new Set();
  const serials = new Set();
  const uids = new Set();
  if (ticket.msCaseId) cases.add(String(ticket.msCaseId));
  (ticket.msRelatedCases || []).forEach((c) => cases.add(String(c)));
  if (ticket.msOrderNumber) orders.add(String(ticket.msOrderNumber));
  if (ticket.serialNumber) serials.add(String(ticket.serialNumber).toUpperCase());
  (ticket.msEmailEvents || []).forEach((e) => {
    if (e && e.uid != null) uids.add(Number(e.uid));
  });
  return { cases, orders, serials, uids };
}

/** Collect case IDs declared on a stored uid record + subject TrackingID. */
function recordCaseIds(record) {
  const out = new Set();
  const f = (record && record.fields) || {};
  for (const c of f.cases || []) {
    if (c) out.add(String(c));
  }
  const subj = String((record && record.subject) || '');
  const m = subj.match(/TrackingID#\s*(\d{16,20})/i)
    || subj.match(/\bCase\s+(\d{16,20})\b/i)
    || subj.match(/\bcase\s*#?\s*(\d{16,20})\b/i);
  if (m) out.add(m[1]);
  return out;
}

/**
 * True when this email belongs on the ticket's thread.
 * Priority: SN → case → strict order (no SN/case conflict).
 * Bare historical uid links are NOT enough — that kept polluted matches forever.
 */
function recordMatchesTicket(record, ident, opts) {
  if (!record) return false;
  const options = opts || {};
  const f = record.fields || {};
  const labels = record.labels || f.labels || [];

  const recSerials = new Set();
  for (const s of f.serials || []) {
    if (s) recSerials.add(String(s).toUpperCase());
  }
  for (const lab of labels) {
    if (lab && lab.serialNumber) recSerials.add(String(lab.serialNumber).toUpperCase());
  }

  const recOrders = new Set();
  for (const o of f.orders || []) {
    if (o) recOrders.add(String(o));
  }
  for (const lab of labels) {
    if (lab && lab.orderNumber) recOrders.add(String(lab.orderNumber));
  }

  const recCases = recordCaseIds(record);

  // 1) Serial match
  for (const s of ident.serials) {
    if (recSerials.has(s)) return true;
  }

  // 2) Case match (multi-device case emails)
  if (!options.ignoreCase) {
    for (const c of ident.cases) {
      if (recCases.has(c)) return true;
    }
  }

  // 3) Order match only when not contradicted by SN or case on the email
  let orderHit = false;
  for (const o of ident.orders) {
    if (recOrders.has(o)) {
      orderHit = true;
      break;
    }
  }
  if (orderHit) {
    const snConflict = recSerials.size > 0
      && ![...ident.serials].some((s) => recSerials.has(s));
    const caseConflict = ident.cases.size > 0 && recCases.size > 0
      && ![...ident.cases].some((c) => recCases.has(c));
    if (!snConflict && !caseConflict) return true;
  }

  // 4) Historical uid link — only if the record still aligns under the rules above
  //    (already returned true) or the record has no identity fields at all.
  if (options.allowUidMatch !== false && ident.uids.has(Number(record.uid))) {
    if (!recSerials.size && !recOrders.size && !recCases.size) return true;
  }

  return false;
}

function findTicket(ticketId) {
  const log = loadJson(REPAIR_NEEDED_PATH, []);
  if (!Array.isArray(log)) return null;
  return log.find((t) => t && String(t.id) === String(ticketId)) || null;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

async function parseUid(uid) {
  const rawPath = path.join(RAW_DIR, `uid-${uid}.eml`);
  if (!fs.existsSync(rawPath)) return null;
  const source = fs.readFileSync(rawPath);
  const parsed = await simpleParser(source);
  return { source, parsed };
}

function rewriteCidHtml(html, attachments) {
  let out = String(html || '');
  for (const att of attachments || []) {
    if (!att.contentId) continue;
    const re = new RegExp(`cid:${att.contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
    out = out.replace(re, att.downloadPath);
  }
  return out;
}

async function buildMessageView(uid) {
  const record = loadJson(path.join(INBOX_DIR, `uid-${uid}.json`), null);
  const parsedBundle = await parseUid(uid);
  if (!parsedBundle) return null;
  const { parsed } = parsedBundle;

  let attachments = Array.isArray(record && record.attachments) ? record.attachments.slice() : [];
  if (!attachments.length) {
    attachments = extractAndSaveAllAttachments(parsed, uid);
    if (record) {
      record.attachments = attachments;
      atomicWriteJsonSync(path.join(INBOX_DIR, `uid-${uid}.json`), record);
    }
  }

  const htmlRaw = parsed.html || '';
  const html = rewriteCidHtml(htmlRaw, attachments);
  const text = parsed.text || stripHtml(htmlRaw) || (record && record.preview) || '';
  const addrText = (field) => {
    if (!field) return '';
    if (typeof field.text === 'string') return field.text;
    if (Array.isArray(field.value)) {
      return field.value.map((a) => {
        if (!a) return '';
        if (a.name && a.address) return `${a.name} <${a.address}>`;
        return a.address || a.name || '';
      }).filter(Boolean).join(', ');
    }
    return '';
  };

  return {
    uid: Number(uid),
    subject: String(parsed.subject || (record && record.subject) || ''),
    from: addrText(parsed.from) || (record && record.from) || '',
    to: addrText(parsed.to),
    cc: addrText(parsed.cc),
    replyTo: addrText(parsed.replyTo),
    date: parsed.date ? new Date(parsed.date).toISOString() : (record && record.date) || null,
    messageId: parsed.messageId || null,
    text,
    html,
    preview: String(text).slice(0, 500),
    attachments,
    fields: (record && record.fields) || null,
    hasHtml: !!htmlRaw
  };
}

function extractEmailAddresses(text) {
  const out = [];
  const seen = new Set();
  const re = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const addr = m[1].toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

function isOurMailboxAddress(addr, ourAddr) {
  const a = String(addr || '').toLowerCase();
  const ours = String(ourAddr || 'ms-returns@orderassistnow.com').toLowerCase();
  if (!a) return false;
  if (a === ours) return true;
  if (a === 'ms-returns@orderassistnow.com') return true;
  return false;
}

function isMicrosoftSupportAddress(addr) {
  const a = String(addr || '').toLowerCase();
  return /@(?:[\w.-]+\.)?microsoft\.com$/i.test(a)
    || a.includes('supportmail@')
    || /@techsupport\.microsoft\.com$/i.test(a);
}

/**
 * Parse From/To/Cc from a forwarded MS message body (Abe often Fw: into ms-returns).
 * Supports Thunderbird "------ Forwarded Message ------" and Outlook "From: … Sent: … To: …".
 */
function parseForwardedConversationHeaders(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;

  const blockMatchers = [
    /-{2,}\s*Forwarded Message\s*-{2,}([\s\S]{0,4000}?)(?:\n\s*\n|Dear\b|Hello\b|Hi\b|$)/i,
    /-{2,}\s*Original Message\s*-{2,}([\s\S]{0,4000}?)(?:\n\s*\n|Dear\b|Hello\b|Hi\b|$)/i,
    /Begin forwarded message:([\s\S]{0,4000}?)(?:\n\s*\n|Dear\b|Hello\b|Hi\b|$)/i
  ];

  let block = null;
  for (const re of blockMatchers) {
    const m = raw.match(re);
    if (m) {
      block = m[1] || m[0];
      break;
    }
  }
  // Outlook-style without a banner, but with From + To near the top of quoted text
  if (!block && /From\s*[:\"][\s\S]{0,200}supportmail@|From\s*[:\"][\s\S]{0,200}@microsoft\.com/i.test(raw)) {
    const idx = raw.search(/\bFrom\s*[:\"]/i);
    if (idx >= 0) block = raw.slice(idx, idx + 2500);
  }
  if (!block) return null;

  const grab = (label) => {
    // Colon form only (Outlook). Do NOT treat " as a delimiter — Thunderbird uses From "Name" <email>.
    const re = new RegExp(
      `(?:^|\\n)\\s*${label}\\s*:\\s*([^\\n]+(?:\\n(?!\\s*(?:From|To|Cc|Date|Sent|Subject)\\b)[^\\n]+)*)`,
      'i'
    );
    const m = block.match(re);
    return m ? String(m[1]).replace(/\s+/g, ' ').trim() : '';
  };

  // Thunderbird often uses: From "Name" <email>  (no colon)
  const grabLoose = (label) => {
    const withColon = grab(label);
    if (withColon) return withColon;
    const re = new RegExp(
      `(?:^|\\n)\\s*${label}\\s+(?![:=])([^\\n]+(?:\\n(?!\\s*(?:From|To|Cc|Date|Sent|Subject)\\b)[^\\n]+)*)`,
      'i'
    );
    const m = block.match(re);
    return m ? String(m[1]).replace(/\s+/g, ' ').trim() : '';
  };

  const fromText = grabLoose('From');
  const toText = grabLoose('To');
  const ccText = grabLoose('Cc');
  const fromAddrs = extractEmailAddresses(fromText);
  const toAddrs = extractEmailAddresses(toText);
  const ccAddrs = extractEmailAddresses(ccText);
  if (!fromAddrs.length && !toAddrs.length) return null;

  return {
    fromText,
    toText,
    ccText,
    fromAddrs,
    toAddrs,
    ccAddrs,
    source: 'forwarded_body'
  };
}

/**
 * Prefer the real MS conversation parties over outer Fw: wrapper headers.
 */
function resolveConversationParties(messageView, ourAddr) {
  const outerFromText = (messageView && messageView.from) || '';
  const outerToText = (messageView && messageView.to) || '';
  const outerCcText = (messageView && messageView.cc) || '';
  const outerReplyToText = (messageView && messageView.replyTo) || '';
  const outerFrom = extractEmailAddresses(outerFromText);
  const outerTo = extractEmailAddresses(outerToText);
  const outerCc = extractEmailAddresses(outerCcText);
  const outerReplyTo = extractEmailAddresses(outerReplyToText);

  const bodyText = [
    messageView && messageView.text,
    messageView && messageView.preview,
    messageView && messageView.html ? stripHtml(messageView.html) : ''
  ].filter(Boolean).join('\n');

  const fwd = parseForwardedConversationHeaders(bodyText);
  const subject = String((messageView && messageView.subject) || '');
  const looksForwarded = /^fw:|^fwd:/i.test(subject) || !!fwd;

  if (fwd && (fwd.fromAddrs.length || fwd.toAddrs.length)) {
    return {
      fromText: fwd.fromText || outerFromText,
      toText: fwd.toText || '',
      ccText: fwd.ccText || '',
      fromAddrs: fwd.fromAddrs.length ? fwd.fromAddrs : outerFrom,
      toAddrs: fwd.toAddrs,
      ccAddrs: fwd.ccAddrs,
      replyToAddrs: [],
      source: 'forwarded_body',
      looksForwarded: true
    };
  }

  return {
    fromText: outerFromText,
    toText: outerToText,
    ccText: outerCcText,
    fromAddrs: outerFrom,
    toAddrs: outerTo,
    ccAddrs: outerCc,
    replyToAddrs: outerReplyTo,
    source: 'headers',
    looksForwarded
  };
}

/**
 * Build the outbound envelope for a draft (what Send Email will use).
 * Rule: everyone on the original MS conversation stays on the reply.
 *   From = ms-returns
 *   To   = Microsoft supportmail (conversation From)
 *   Cc   = original To + Cc + any other party (minus us and primary To)
 */
function buildDraftEnvelope(draft, messageView, extraViews = []) {
  const cfg = loadConfig() || {};
  const ourAddr = String(cfg.user || 'ms-returns@orderassistnow.com').toLowerCase();
  const from = ourAddr;

  const views = [messageView, ...(Array.isArray(extraViews) ? extraViews : [])].filter(Boolean);
  const parties = resolveConversationParties(views[0] || messageView, ourAddr);

  const allAddrs = [];
  const pushAddrs = (list) => {
    for (const a of list || []) {
      const addr = String(a || '').toLowerCase().trim();
      if (addr) allAddrs.push(addr);
    }
  };

  for (const view of views) {
    const p = resolveConversationParties(view, ourAddr);
    pushAddrs(p.fromAddrs);
    pushAddrs(p.toAddrs);
    pushAddrs(p.ccAddrs);
    pushAddrs(p.replyToAddrs);
    // Also sweep raw body for any addresses in the forwarded header region
    const body = [
      view && view.text,
      view && view.preview,
      view && view.html ? stripHtml(view.html) : ''
    ].filter(Boolean).join('\n');
    const fwd = parseForwardedConversationHeaders(body);
    if (fwd) {
      pushAddrs(fwd.fromAddrs);
      pushAddrs(fwd.toAddrs);
      pushAddrs(fwd.ccAddrs);
    }
  }

  // Standing aliases that should never be dropped when present on the case
  const alwaysCc = Array.isArray(cfg.alwaysCc)
    ? cfg.alwaysCc.map((a) => String(a || '').toLowerCase().trim()).filter(Boolean)
    : ['abe@visicllc.com', 'orderassistnow@gmail.com'];
  // Only add alwaysCc if they already appeared somewhere on this conversation,
  // OR if the forwarded/original headers mentioned them (already in allAddrs).
  // Additionally, if we parsed a real MS conversation, keep alwaysCc that match
  // known Abe / OrderAssist aliases used on every MS case.
  if (parties && (parties.fromAddrs.length || parties.toAddrs.length)) {
    for (const a of alwaysCc) {
      if (!allAddrs.includes(a)) allAddrs.push(a);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const a of allAddrs) {
    if (seen.has(a) || isOurMailboxAddress(a, ourAddr)) continue;
    seen.add(a);
    unique.push(a);
  }

  // Primary To: prefer supportmail@…, then other MS support, then conversation From
  const supportmail = unique.filter((a) => /^supportmail@/i.test(a));
  const msSupport = unique.filter((a) => isMicrosoftSupportAddress(a) && !/^supportmail@/i.test(a) && !/^v-/i.test(a));
  const msFrom = (parties.fromAddrs || []).filter((a) => isMicrosoftSupportAddress(a));
  let toList = supportmail.length
    ? supportmail.slice(0, 1)
    : (msFrom.length ? msFrom.slice(0, 1) : (msSupport.length ? msSupport.slice(0, 1) : []));
  if (!toList.length && parties.fromAddrs && parties.fromAddrs.length) {
    toList = [parties.fromAddrs[0]];
  }
  if (!toList.length && draft && draft.sendTo) {
    toList = extractEmailAddresses(draft.sendTo).slice(0, 1);
  }
  toList = toList.filter((a) => !isOurMailboxAddress(a, ourAddr));
  if (!toList.length) toList = [ourAddr];

  const toSet = new Set(toList.map((a) => a.toLowerCase()));
  const ccList = unique.filter((a) => !toSet.has(a));

  return {
    from,
    to: toList.join(', '),
    cc: ccList.join(', '),
    replyTo: '',
    inReplyTo: messageView && messageView.messageId ? messageView.messageId : null,
    headerSource: parties.source,
    originalFrom: parties.fromText || '',
    originalTo: parties.toText || '',
    originalCc: parties.ccText || '',
    participants: unique.slice()
  };
}

async function enrichDraftWithEnvelope(draft) {
  if (!draft) return draft;
  let view = null;
  const extraViews = [];
  if (draft.inReplyToUid != null) {
    try {
      view = await buildMessageView(draft.inReplyToUid);
    } catch (_) { /* ignore */ }
  }
  // Pull other thread messages for this ticket/case so Cc never drops people
  try {
    const ticket = draft.ticketId ? findTicket(draft.ticketId) : null;
    if (ticket) {
      const thread = await buildThreadForTicket(ticket);
      for (const msg of (thread && thread.messages) || []) {
        if (!msg) continue;
        if (view && Number(msg.uid) === Number(view.uid)) continue;
        extraViews.push(msg);
      }
    }
  } catch (_) { /* ignore */ }
  draft.envelope = buildDraftEnvelope(draft, view, extraViews);
  draft.attachments = listDraftUploads(draft.id);
  if (draft.templateKey === 'provide_documents') draft.needsDocuments = true;
  return draft;
}

async function buildThreadForTicket(ticket) {
  const ident = ticketIdentity(ticket);
  const records = listUidRecords().filter((r) => recordMatchesTicket(r, ident));
  const messages = [];
  for (const rec of records) {
    try {
      const view = await buildMessageView(rec.uid);
      if (view) messages.push(view);
    } catch (e) {
      messages.push({
        uid: rec.uid,
        subject: rec.subject || '',
        from: rec.from || '',
        date: rec.date || null,
        text: rec.preview || '',
        html: '',
        preview: (rec.preview || '').slice(0, 500),
        attachments: rec.attachments || rec.labels || [],
        error: e.message
      });
    }
  }
  messages.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return { ticketId: ticket.id, serialNumber: ticket.serialNumber, count: messages.length, messages };
}

function draftTemplates(ticket, record, messageView) {
  const sn = ticket.serialNumber || '';
  const caseId = ticket.msCaseId || (record.fields && record.fields.cases && record.fields.cases[0]) || '';
  const order = ticket.msOrderNumber || (record.fields && record.fields.orders && record.fields.orders[0]) || '';
  const issue = (ticket.issue || '').replace(/^From MS email:\s*/i, '').slice(0, 240);
  const subject = String((messageView && messageView.subject) || record.subject || '');
  const bodyText = `${subject}\n${(messageView && messageView.text) || record.preview || ''}`;
  const low = bodyText.toLowerCase();
  const fields = record.fields || {};
  const drafts = [];
  const addressBlock = formatReturnAddressBlock();
  const wantsAddress = msAsksForAddress(bodyText);
  const wantsTroubleshooting = msAsksForTroubleshooting(bodyText);
  const devicesBlock = formatCaseDevicesBlock(ticket, { includeIssue: true, includeModel: false });
  const devicesBlockWithModel = formatCaseDevicesBlock(ticket, { includeIssue: true, includeModel: true });
  const siblingCount = ticketsForSameCase(ticket).length;
  const multiNote = siblingCount > 1 ? ` Lists all ${siblingCount} devices on this MS case.` : '';

  const replySubject = subject.toLowerCase().startsWith('re:')
    ? subject
    : `Re: ${subject}`.slice(0, 200);

  const push = (templateKey, body, why) => {
    drafts.push({
      templateKey,
      subject: replySubject,
      body: body.trim(),
      why: why + multiNote,
      inReplyToUid: Number(record.uid)
    });
  };

  // MS asked warehouse troubleshooting questions — answer point-by-point (higher priority than SN-only)
  if (wantsTroubleshooting) {
    const answers = buildTroubleshootingAnswers(ticket, bodyText);
    push(
      'answer_troubleshooting',
      `Hello,\n\nThank you for the update on case ${caseId || '(this case)'}.\n\n${devicesBlock}\n${answers}\n\nThank you,\nOrderAssist / Visic`,
      'MS asked diagnostic questions — reply confirming warehouse troubleshooting already done (yes to each ask) and request next warranty step.'
    );
  }

  // MS asked for our shipping / return address
  if (wantsAddress) {
    push(
      'provide_return_address',
      `Hello,\n\nPlease use the following shipping / return address:\n\n${addressBlock}\n\n${devicesBlock}${caseId ? `Case: ${caseId}\n` : ''}${order ? `Service order: ${order}\n` : ''}\nThank you,\nOrderAssist / Visic`,
      'MS asked for our address — reply with the stored Digital Delivered Inc ship-from address.'
    );
  }

  // MS asked for proof of purchase / documents
  if (msAsksForDocuments(bodyText)) {
    push(
      'provide_documents',
      `Hello,\n\nThank you for the update on case ${caseId || '(this case)'}.\n\nWe will attach the requested document(s) (e.g. proof of purchase / invoice) for the device(s) below${order ? ` / order ${order}` : ''}:\n\n${devicesBlock || `Serial Number: ${sn || '(scan/paste SN)'}\n`}\nPlease confirm once received and continue the warranty process.\n\nThank you,\nOrderAssist / Visic`,
      'MS asked for proof of purchase or documents — attach files on the draft before Approve.'
    );
  }

  // Idle / archive follow-ups from MS
  if (/archive|idle time|temporary closure|further assistance is needed|friendly follow up/.test(low)) {
    push(
      'keep_case_open',
      `Hello,\n\nPlease keep case ${caseId || '(this case)'} open.\n\n${devicesBlock}${order ? `Service order: ${order}\n` : ''}Current status on our side: ${ticket.status || 'in progress'}.\n\nWe are still working these unit(s) through our Microsoft repair workflow and will reply with the next update.\n\nThank you,\nOrderAssist / Visic`,
      'MS asked about closing/archiving — ask them to keep the case open.'
    );
  }

  // Label / return instructions
  if (/return your device|shipping label|label is attached/.test(low) || (fields.labels && fields.labels.length)) {
    push(
      'ack_label_will_ship',
      `Hello,\n\nThank you — we have the shipping label${order ? ` for order ${order}` : ''}.\n\n${devicesBlock}\nWe will pack and ship shortly, then reply with the outbound tracking number(s).\n\nThank you,\nOrderAssist / Visic`,
      'Acknowledge prepaid label and promise outbound tracking.'
    );
  }

  // Delivered / arriving soon
  if (/has been delivered|arriving soon|order is complete|package has been delivered/.test(low)
    || fields.suggestStatus === 'ms_arrived_check') {
    push(
      'ack_delivery_checkin',
      `Hello,\n\nThank you for the delivery update${order ? ` on order ${order}` : ''}.\n\n${devicesBlock}\nWe will inspect at check-in and confirm once everything looks good.\n\nThank you,\nOrderAssist / Visic`,
      'Acknowledge delivery / arriving-soon and commit to check-in confirmation.'
    );
  }

  // Case opened / asking for device details (skip when MS is mainly asking troubleshooting)
  if (!wantsTroubleshooting && (/your question was succe|support request number|case number created|would you kindly share|serial number/.test(low)
    || fields.suggestStatus === 'ms_case_created')) {
    const addressExtra = wantsAddress
      ? `\nShipping / return address:\n${addressBlock}\n`
      : '';
    push(
      'provide_device_details',
      `Hello,\n\nPlease find the device details for case ${caseId || '(pending)'}:\n\n${devicesBlockWithModel || `Serial Number: ${sn || '(scan/paste SN)'}\n${issue ? `Issue: ${issue}\n` : ''}`}${addressExtra}\nPlease proceed with the service request / next steps.\n\nThank you,\nOrderAssist / Visic`,
      wantsAddress
        ? 'Reply with SN / issue and our stored return address.'
        : 'Reply with SN / issue so MS can advance the case.'
    );
  }

  // Generic talking-stage acknowledgment when nothing else matched
  if (!drafts.length && ['ms_case_created', 'ms_waiting_approval', 'ms_rejected', 'ms_waiting_case'].includes(String(ticket.status || ''))) {
    push(
      'ack_case_update',
      `Hello,\n\nThank you for the update on case ${caseId || 'this request'}.\n\n${devicesBlock}\nWe are reviewing on our side and will follow up with any information you need.\n\nThank you,\nOrderAssist / Visic`,
      'Generic acknowledgment while case is in Talking to MS.'
    );
  }

  return drafts;
}

function pickBestProposal(proposals) {
  if (!proposals || !proposals.length) return null;
  return [...proposals].sort((a, b) => {
    const pa = TEMPLATE_PRIORITY[a.templateKey] || 0;
    const pb = TEMPLATE_PRIORITY[b.templateKey] || 0;
    return pb - pa;
  })[0];
}

function formatThreadForAi(messages) {
  const msgs = Array.isArray(messages) ? messages.slice(-16) : [];
  if (!msgs.length) return '(none in inbox yet — rely on briefing)';
  return msgs.map((m, idx) => {
    const text = String(m.text || m.preview || '').replace(/\s+/g, ' ').slice(0, 1200);
    const tag = idx === msgs.length - 1 ? ' [NEWEST — reply to this email]' : '';
    return `[${m.date || ''}] From: ${m.from || ''}${tag}\nSubject: ${m.subject || ''}\n${text}`;
  }).join('\n\n---\n\n');
}

/**
 * AI-first: compose a reply from the newest MS email + case facts.
 * Returns a proposal shaped like draftTemplates(), or null if AI unavailable.
 */
async function composeAiDraftProposal(ticket, record, messageView, threadMessages) {
  if (!ticket || !record) return null;
  if (!cursorAgentExists() || !cursorAgentLoggedIn()) return null;

  const subjectIn = String((messageView && messageView.subject) || record.subject || '');
  const replySubject = subjectIn.toLowerCase().startsWith('re:')
    ? subjectIn.slice(0, 200)
    : `Re: ${subjectIn}`.slice(0, 200);
  const newestText = String(
    (messageView && (messageView.text || messageView.preview))
    || record.preview
    || ''
  ).slice(0, 12000);

  const ask = [
    'Compose a brand-new email reply to Microsoft Surface Support.',
    'Read the NEWEST MS email carefully and respond to what THEY wrote in THIS message — not a canned checklist.',
    'If they asked questions, answer EACH question point-by-point for THIS symptom (battery vs touch vs keyboard vs whatever they asked).',
    'Use CASE BRIEFING / serials / issue / warehouse notes as ground truth. Do not invent tracking numbers, ETAs, or serials.',
    'If CASE BRIEFING lists multiple devices on the same MS case, include every serial.',
    'Assume warehouse already completed standard troubleshooting unless briefing says otherwise.',
    'End by asking MS for the next warranty step when appropriate (service offer / RMA / label / keep case open).',
    'If you need a fact from the human operator, put it in "questions" (not in the MS email body).',
    'If MS asked for documents, set needsDocuments=true.',
    'Sign as OrderAssist / Visic. Return JSON only with subject + body.'
  ].join(' ');

  const context = [
    '=== CASE BRIEFING / STAGE (trust this — first outbound may be missing from thread) ===',
    buildTicketStageContext(ticket),
    '',
    '=== EMAIL THREAD (oldest → newest) ===',
    formatThreadForAi(threadMessages),
    '',
    '=== NEWEST MS EMAIL (full text — this is what you must answer) ===',
    `Subject: ${subjectIn}`,
    newestText || '(empty body)',
    '',
    '=== TRAINING EXAMPLES (tone) ===',
    recentTrainingExamples(6),
    '',
    '=== CURRENT DRAFT ===',
    '(none — compose from scratch)',
    '',
    'OPERATOR REQUEST:',
    ask
  ].join('\n');

  const hardMs = Math.min(CURSOR_TIMEOUT_MS || 120000, 90000);
  let improved = null;
  try {
    improved = await Promise.race([
      cursorImproveDraft(context),
      new Promise((resolve) => setTimeout(() => resolve({ __cursorError: `AI compose timed out after ${hardMs}ms` }), hardMs))
    ]);
  } catch (e) {
    console.error('[ms_email_replies] AI compose error', e.message || e);
    improved = null;
  }
  if (improved && improved.__cursorError) {
    console.error('[ms_email_replies] AI compose:', improved.__cursorError);
    improved = null;
  }
  if (!improved || !String(improved.body || '').trim()) return null;

  return {
    templateKey: 'ai_reply',
    subject: String(improved.subject || replySubject).trim().slice(0, 300) || replySubject,
    body: String(improved.body).trim().slice(0, 12000),
    why: 'AI draft written from the newest MS email + case briefing (not a canned template). Review before Send.',
    inReplyToUid: Number(record.uid),
    draftSource: 'ai',
    needsHuman: !!improved.needsHuman,
    needsHumanReason: improved.needsHumanReason || null,
    needsDocuments: !!improved.needsDocuments,
    documentHints: Array.isArray(improved.documentHints) ? improved.documentHints : [],
    operatorQuestions: Array.isArray(improved.questions) ? improved.questions : [],
    aiNote: improved.note || `Composed via Cursor Agent (${CURSOR_MODEL})`
  };
}

function templateFallbackProposal(ticket, record, messageView) {
  const proposals = draftTemplates(ticket, record, messageView || {
    subject: record.subject,
    text: record.preview
  });
  const best = pickBestProposal(proposals);
  if (!best) return null;
  return {
    ...best,
    draftSource: 'template',
    why: `${best.why || 'Template reply'} (fallback — AI unavailable or failed; use Prepare with AI).`
  };
}

async function ensureDraftsForRecord(ticket, record, messageView, opts = {}) {
  const view = messageView || {
    subject: record.subject,
    text: record.preview,
    preview: record.preview
  };
  let threadMessages = opts.threadMessages || null;
  if (!threadMessages) {
    try {
      const thread = await buildThreadForTicket(ticket);
      threadMessages = (thread && thread.messages) || [];
    } catch (_) {
      threadMessages = [];
    }
  }

  let proposal = null;
  if (opts.preferAi !== false) {
    try {
      proposal = await composeAiDraftProposal(ticket, record, view, threadMessages);
    } catch (e) {
      console.error('[ms_email_replies] AI compose failed', e.message || e);
      proposal = null;
    }
  }
  if (!proposal) {
    proposal = templateFallbackProposal(ticket, record, view);
  }
  if (!proposal) return [];

  const all = loadDrafts();
  const created = [];
  const sn = String(ticket.serialNumber || '').toUpperCase();
  const caseId = String(ticket.msCaseId || '').trim();
  const replyUid = Number(proposal.inReplyToUid);

  const alreadySent = findSentDraftForConversation({
    inReplyToUid: replyUid,
    msCaseId: caseId,
    ticketId: ticket.id
  });
  if (alreadySent) return [];

  const exists = all.some((d) => {
    if (!d || !['pending', 'approved_queued', 'sent', 'already_sent'].includes(String(d.status || ''))) return false;
    if (Number(d.inReplyToUid) !== replyUid) return false;
    if (String(d.ticketId) === String(ticket.id)) return true;
    if (sn && d.serialNumber && String(d.serialNumber).toUpperCase() === sn) return true;
    if (caseId && String(d.msCaseId || '').trim() === caseId && d.status === 'sent') return true;
    return false;
  });
  if (exists) return [];

  const draft = {
    id: `dr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ticketId: ticket.id,
    serialNumber: ticket.serialNumber || null,
    caseDeviceSerials: ticketsForSameCase(ticket).map((t) => t.serialNumber).filter(Boolean),
    msCaseId: ticket.msCaseId || null,
    msOrderNumber: ticket.msOrderNumber || null,
    inReplyToUid: proposal.inReplyToUid,
    templateKey: proposal.templateKey,
    draftSource: proposal.draftSource || 'template',
    why: proposal.why,
    subject: proposal.subject,
    body: proposal.body,
    status: 'pending',
    createdAt: isoNow(),
    emailDate: record.date || null,
    training: null,
    sentAt: null,
    sendError: null,
    chatHistory: proposal.draftSource === 'ai' && proposal.aiNote
      ? [{ at: isoNow(), by: 'ai', role: 'assistant', text: proposal.aiNote, source: 'cursor' }]
      : [],
    editedAt: null,
    operatorQuestions: proposal.operatorQuestions || [],
    needsHuman: !!proposal.needsHuman,
    needsHumanReason: proposal.needsHumanReason || null,
    needsDocuments: !!proposal.needsDocuments || proposal.templateKey === 'provide_documents',
    documentHints: proposal.documentHints || [],
    attachments: []
  };
  all.push(draft);
  created.push(draft);
  saveDrafts(all);
  return created;
}

/**
 * Upgrade an unedited template draft to an AI-composed reply.
 */
async function upgradeDraftWithAi(ticket, draft, record, messageView, threadMessages) {
  if (!draft || draft.status !== 'pending') return false;
  if (draft.draftSource === 'ai' || draft.templateKey === 'ai_reply') return false;
  if (draft.editedAt) return false;
  if (Array.isArray(draft.chatHistory) && draft.chatHistory.some((c) => c && c.role === 'user')) return false;
  if (!record) return false;

  let view = messageView;
  if (!view && draft.inReplyToUid != null) {
    try { view = await buildMessageView(draft.inReplyToUid); } catch (_) { /* ignore */ }
  }
  if (!view) {
    view = { subject: record.subject, text: record.preview, preview: record.preview };
  }
  let msgs = threadMessages;
  if (!msgs) {
    try {
      const thread = await buildThreadForTicket(ticket);
      msgs = (thread && thread.messages) || [];
    } catch (_) {
      msgs = [];
    }
  }

  const ai = await composeAiDraftProposal(ticket, record, view, msgs);
  if (!ai) return false;

  const all = loadDrafts();
  const d = all.find((x) => x && x.id === draft.id);
  if (!d || d.status !== 'pending') return false;
  d.templateKey = ai.templateKey;
  d.draftSource = 'ai';
  d.why = ai.why;
  d.subject = ai.subject;
  d.body = ai.body;
  d.operatorQuestions = ai.operatorQuestions || [];
  d.needsHuman = !!ai.needsHuman;
  d.needsHumanReason = ai.needsHumanReason || null;
  d.needsDocuments = !!ai.needsDocuments;
  d.documentHints = ai.documentHints || [];
  d.caseDeviceSerials = ticketsForSameCase(ticket).map((t) => t.serialNumber).filter(Boolean);
  d.aiUpgradedAt = isoNow();
  if (!Array.isArray(d.chatHistory)) d.chatHistory = [];
  d.chatHistory.push({
    at: isoNow(),
    by: 'ai',
    role: 'assistant',
    text: ai.aiNote || 'Replaced template with AI draft from newest MS email',
    source: 'cursor'
  });
  saveDrafts(all);
  return true;
}

function findSentDraftForConversation(opts = {}) {
  const uid = opts.inReplyToUid != null ? Number(opts.inReplyToUid) : null;
  const caseId = String(opts.msCaseId || '').trim();
  const ticketId = opts.ticketId != null ? String(opts.ticketId) : '';
  const all = loadDrafts();
  const sent = all.filter((d) => d && d.status === 'sent');
  // Prefer exact ticket + uid, then case + uid, then uid alone
  const scored = [];
  for (const d of sent) {
    let score = 0;
    if (uid != null && Number(d.inReplyToUid) === uid) score += 10;
    if (caseId && String(d.msCaseId || '').trim() === caseId) score += 5;
    if (ticketId && String(d.ticketId) === ticketId) score += 2;
    if (score < 10) continue; // must match the source email uid
    scored.push({ score, d });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.d.sentAt || '').localeCompare(String(a.d.sentAt || ''));
  });
  return scored.length ? scored[0].d : null;
}

function markRelatedDraftsAlreadySent(sentDraft, by) {
  if (!sentDraft || sentDraft.status !== 'sent') return 0;
  const uid = sentDraft.inReplyToUid != null ? Number(sentDraft.inReplyToUid) : null;
  const caseId = String(sentDraft.msCaseId || '').trim();
  if (uid == null) return 0;
  const all = loadDrafts();
  let n = 0;
  for (const d of all) {
    if (!d || d.id === sentDraft.id) continue;
    if (!['pending', 'approved_queued'].includes(String(d.status || ''))) continue;
    const sameUid = Number(d.inReplyToUid) === uid;
    const sameCase = caseId && String(d.msCaseId || '').trim() === caseId;
    // Same inbound MS email, or same case + same inbound email
    if (!sameUid) continue;
    if (!sameCase && String(d.ticketId) !== String(sentDraft.ticketId)) {
      // different ticket/case but same uid (rare) — still block duplicate reply to that email
    }
    d.status = 'already_sent';
    d.alreadySentAt = isoNow();
    d.alreadySentDraftId = sentDraft.id;
    d.alreadySentBy = by || 'system';
    d.supersededAt = isoNow();
    d.training = d.training || {
      decision: 'already_sent',
      reason: `Blocked — reply already sent for this MS email (draft ${sentDraft.id})`,
      at: isoNow(),
      by: by || 'system'
    };
    n += 1;
  }
  if (n) saveDrafts(all);
  return n;
}

function supersedeStaleDrafts(all, ticketId, keepUid) {
  const keep = keepUid != null ? Number(keepUid) : null;
  let n = 0;
  for (const d of all) {
    if (!d || String(d.ticketId) !== String(ticketId)) continue;
    if (!['pending', 'approved_queued'].includes(String(d.status || ''))) continue;
    if (keep != null && Number(d.inReplyToUid) === keep) continue;
    d.status = 'superseded';
    d.supersededAt = isoNow();
    d.training = d.training || {
      decision: 'superseded',
      reason: 'Newer email in thread — draft for older mail closed',
      at: isoNow(),
      by: 'system'
    };
    n += 1;
  }
  return n;
}

async function refreshDraftsForTicket(ticket) {
  const thread = await buildThreadForTicket(ticket);
  const newest = thread.messages && thread.messages.length
    ? thread.messages[thread.messages.length - 1]
    : null;

  let all = loadDrafts();
  const superseded = newest
    ? supersedeStaleDrafts(all, ticket.id, newest.uid)
    : 0;

  // Collapse multiple pending drafts on the newest UID — keep newest-created
  if (newest) {
    const pendingSame = all
      .filter((d) => d
        && String(d.ticketId) === String(ticket.id)
        && d.status === 'pending'
        && Number(d.inReplyToUid) === Number(newest.uid))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    for (let i = 1; i < pendingSame.length; i += 1) {
      pendingSame[i].status = 'superseded';
      pendingSame[i].supersededAt = isoNow();
    }
  }
  saveDrafts(all);

  const created = [];
  let aiUpgraded = 0;
  if (newest) {
    const record = loadJson(path.join(INBOX_DIR, `uid-${newest.uid}.json`), null);
    if (record) {
      // Fast seed if nothing exists, then AI upgrade (AI is the real reply)
      created.push(...await ensureDraftsForRecord(ticket, record, newest, {
        onlyBest: true,
        preferAi: false,
        threadMessages: thread.messages || []
      }));
      all = loadDrafts();
      const pending = all.filter((d) => d
        && String(d.ticketId) === String(ticket.id)
        && d.status === 'pending'
        && Number(d.inReplyToUid) === Number(newest.uid));
      for (const d of pending) {
        if (await upgradeDraftWithAi(ticket, d, record, newest, thread.messages || [])) {
          aiUpgraded += 1;
        }
      }
      // If still no draft (templates matched nothing), try pure AI compose
      all = loadDrafts();
      const stillNone = !all.some((d) => d
        && String(d.ticketId) === String(ticket.id)
        && d.status === 'pending'
        && Number(d.inReplyToUid) === Number(newest.uid));
      if (stillNone) {
        created.push(...await ensureDraftsForRecord(ticket, record, newest, {
          onlyBest: true,
          preferAi: true,
          threadMessages: thread.messages || []
        }));
      }
    }
  }

  // Final pass: only one pending draft per ticket
  all = loadDrafts();
  const pending = all
    .filter((d) => d && String(d.ticketId) === String(ticket.id) && d.status === 'pending')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  for (let i = 1; i < pending.length; i += 1) {
    pending[i].status = 'superseded';
    pending[i].supersededAt = isoNow();
  }
  if (pending.length > 1) saveDrafts(all);

  if (newest) {
    const record = loadJson(path.join(INBOX_DIR, `uid-${newest.uid}.json`), null);
    if (record) syncPendingDraftWithCaseDevices(ticket, record, newest);
  }

  // If we already replied to the newest MS email, close leftover pending drafts
  all = loadDrafts();
  let blocked = 0;
  for (const d of all) {
    if (!d || String(d.ticketId) !== String(ticket.id)) continue;
    if (!['pending', 'approved_queued'].includes(String(d.status || ''))) continue;
    const prior = findSentDraftForConversation({
      inReplyToUid: d.inReplyToUid,
      msCaseId: d.msCaseId || ticket.msCaseId,
      ticketId: d.ticketId
    });
    if (!prior) continue;
    d.status = 'already_sent';
    d.alreadySentAt = isoNow();
    d.alreadySentDraftId = prior.id;
    d.alreadySentBy = 'system';
    d.training = d.training || {
      decision: 'already_sent',
      reason: `Blocked — reply already sent for this MS email (draft ${prior.id})`,
      at: isoNow(),
      by: 'system'
    };
    blocked += 1;
  }
  if (blocked) saveDrafts(all);

  const drafts = loadDrafts().filter((d) => String(d.ticketId) === String(ticket.id));
  const enriched = [];
  for (const d of drafts) {
    if (d && (d.status === 'pending' || d.status === 'approved_queued')) {
      enriched.push(await enrichDraftWithEnvelope(d));
    } else {
      enriched.push(d);
    }
  }
  return {
    created: created.length,
    aiUpgraded,
    superseded,
    blocked,
    drafts: enriched,
    threadCount: thread.count,
    replyToUid: newest ? newest.uid : null,
    replyToSubject: newest ? newest.subject : null
  };
}

function syncPendingDraftWithCaseDevices(ticket, record, messageView) {
  if (!ticket || !record) return 0;
  const siblings = ticketsForSameCase(ticket);
  const all = loadDrafts();
  let n = 0;
  const serials = siblings.map((t) => String(t.serialNumber || '').toUpperCase()).filter(Boolean);
  for (const d of all) {
    if (!d || d.status !== 'pending') continue;
    if (String(d.ticketId) !== String(ticket.id)) continue;
    if (Number(d.inReplyToUid) !== Number(record.uid)) continue;
    // Never overwrite AI drafts with canned templates
    if (d.draftSource === 'ai' || d.templateKey === 'ai_reply') {
      d.caseDeviceSerials = siblings.map((t) => t.serialNumber).filter(Boolean);
      continue;
    }
    // Don't clobber operator edits / AI chat
    if (d.editedAt) continue;
    if (Array.isArray(d.chatHistory) && d.chatHistory.some((c) => c && c.role === 'user')) continue;

    const body = String(d.body || '');
    const missingSerial = serials.length > 1 && serials.some((sn) => sn && !body.toUpperCase().includes(sn));
    if (!missingSerial) {
      d.caseDeviceSerials = siblings.map((t) => t.serialNumber).filter(Boolean);
      continue;
    }
    // Template-only: refresh from template fallback so multi-device SNs appear
    const best = templateFallbackProposal(ticket, record, messageView || {
      subject: record.subject,
      text: record.preview
    });
    if (!best) continue;
    d.body = best.body;
    d.subject = best.subject;
    d.why = best.why;
    d.templateKey = best.templateKey;
    d.draftSource = 'template';
    d.caseDeviceSerials = siblings.map((t) => t.serialNumber).filter(Boolean);
    d.syncedCaseDevicesAt = isoNow();
    n += 1;
  }
  if (n) saveDrafts(all);
  return n;
}

function draftsForTicket(ticketId, opts = {}) {
  const includeAll = !!opts.all;
  const ticket = findTicket(ticketId);
  const caseId = ticket && String(ticket.msCaseId || '').trim();
  return loadDrafts()
    .filter((d) => {
      if (!d) return false;
      if (String(d.ticketId) === String(ticketId)) return true;
      // Surface sent / blocked duplicates from sibling tickets on the same MS case
      if (caseId && String(d.msCaseId || '').trim() === caseId
        && (d.status === 'sent' || d.status === 'already_sent')) {
        return true;
      }
      return false;
    })
    .filter((d) => includeAll
      || d.status === 'pending'
      || d.status === 'approved_queued'
      || d.status === 'sent'
      || d.status === 'already_sent')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function sendDraftSmtp(draft, ticket) {
  const cfg = loadConfig();
  if (!cfg || !cfg.smtp || cfg.smtp.enabled !== true) {
    return { sent: false, queued: true, note: 'SMTP disabled — draft approved and queued until outgoing mail is enabled.' };
  }
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (e) {
    return { sent: false, queued: true, note: `nodemailer missing: ${e.message}` };
  }

  const password = String(process.env.MS_RETURNS_IMAP_PASSWORD || cfg.password || '').trim();
  const transporter = nodemailer.createTransport({
    host: cfg.smtp.host || 'mail.orderassistnow.com',
    port: Number(cfg.smtp.port || 465),
    secure: cfg.smtp.tls !== false,
    auth: { user: cfg.user || 'ms-returns@orderassistnow.com', pass: password }
  });

  let view = null;
  try {
    if (draft.inReplyToUid != null) view = await buildMessageView(draft.inReplyToUid);
  } catch (_) { /* ignore */ }

  // Always rebuild To/Cc from the live message (+ thread) so we never send with a stale/empty Cc
  let extraViews = [];
  try {
    const ticketForEnv = ticket || (draft.ticketId ? findTicket(draft.ticketId) : null);
    if (ticketForEnv) {
      const thread = await buildThreadForTicket(ticketForEnv);
      extraViews = ((thread && thread.messages) || []).filter((m) => m
        && (!view || Number(m.uid) !== Number(view.uid)));
    }
  } catch (_) { /* ignore */ }
  const envelope = buildDraftEnvelope(draft, view, extraViews);
  draft.envelope = envelope;
  const headers = {};
  if (envelope.inReplyTo) {
    headers['In-Reply-To'] = envelope.inReplyTo;
    headers.References = envelope.inReplyTo;
  }

  const mail = {
    from: envelope.from || cfg.user || 'ms-returns@orderassistnow.com',
    to: envelope.to || cfg.user || 'ms-returns@orderassistnow.com',
    subject: draft.subject,
    text: draft.body
  };
  if (envelope.cc) mail.cc = envelope.cc;
  if (Object.keys(headers).length) mail.headers = headers;

  const files = draftUploadPaths(draft.id);
  if (files.length) {
    mail.attachments = files.map((f) => ({
      filename: f.filename,
      path: f.path
    }));
  }

  const info = await transporter.sendMail(mail);

  let sentFolder = null;
  let sentAppendError = null;
  try {
    const appended = await appendSentCopyToImap(cfg, {
      ...mail,
      messageId: info.messageId || undefined,
      date: new Date()
    });
    sentFolder = appended.folder;
  } catch (e) {
    sentAppendError = e.message || String(e);
    console.error('[ms_email_replies] IMAP Sent append failed:', sentAppendError);
  }

  return {
    sent: true,
    queued: false,
    messageId: info.messageId,
    to: mail.to,
    cc: mail.cc || '',
    from: mail.from,
    sentFolder,
    sentAppendError
  };
}

/**
 * Copy an outgoing message into the IMAP Sent folder so Thunderbird/Outlook
 * (and webmail) show it. SMTP alone does not do this on cPanel/GoDaddy.
 */
async function appendSentCopyToImap(cfg, mail) {
  const { ImapFlow } = require('imapflow');
  let MailComposer;
  try {
    MailComposer = require('nodemailer/lib/mail-composer');
  } catch (e) {
    throw new Error(`mail-composer missing: ${e.message}`);
  }
  const password = String(process.env.MS_RETURNS_IMAP_PASSWORD || cfg.password || '').trim();
  if (!password) throw new Error('IMAP password missing for Sent append');

  const client = new ImapFlow({
    host: cfg.host || (cfg.imap && cfg.imap.host) || 'localhost',
    port: Number(cfg.port || (cfg.imap && cfg.imap.port) || 993),
    secure: cfg.tls !== false && !(cfg.imap && cfg.imap.tls === false),
    auth: { user: cfg.user, pass: password },
    logger: false
  });

  await client.connect();
  try {
    const folder = await resolveSentMailboxPath(client, cfg);
    const raw = await new MailComposer(mail).compile().build();
    await client.append(folder, raw, ['\\Seen']);
    return { folder };
  } finally {
    try { await client.logout(); } catch (_) { /* ignore */ }
  }
}

async function resolveSentMailboxPath(client, cfg) {
  const configured = String(
    (cfg.smtp && cfg.smtp.sentMailbox)
    || (cfg.imap && cfg.imap.sentMailbox)
    || cfg.sentMailbox
    || ''
  ).trim();
  if (configured) return configured;

  let boxes = [];
  try {
    const listed = await client.list();
    boxes = Array.isArray(listed) ? listed : [];
  } catch (_) {
    boxes = [];
  }

  const bySpecial = boxes.find((b) => b && b.specialUse === '\\Sent');
  if (bySpecial && bySpecial.path) return bySpecial.path;

  const byName = boxes.find((b) => b && /^sent$/i.test(String(b.name || '')))
    || boxes.find((b) => b && /^(sent items|sent messages)$/i.test(String(b.name || '')))
    || boxes.find((b) => b && /(^|\/|\.)sent( items)?$/i.test(String(b.path || '')));
  if (byName && byName.path) return byName.path;

  // cPanel / Dovecot common defaults
  for (const guess of ['Sent', 'INBOX.Sent', 'Sent Items', 'INBOX.Sent Items']) {
    try {
      const lock = await client.getMailboxLock(guess);
      lock.release();
      return guess;
    } catch (_) { /* try next */ }
  }
  throw new Error('Could not find IMAP Sent folder');
}

function appendTicketNote(ticketId, text, by) {
  const log = loadJson(REPAIR_NEEDED_PATH, []);
  if (!Array.isArray(log)) return;
  const i = log.findIndex((t) => t && String(t.id) === String(ticketId));
  if (i < 0) return;
  const t = log[i];
  if (!Array.isArray(t.notes)) t.notes = [];
  t.notes.push({ at: isoNow(), by: by || 'ms_draft', text: String(text).slice(0, 2000) });
  log[i] = t;
  atomicWriteJsonSync(REPAIR_NEEDED_PATH, log);
}

/** Ignore Gmail auto-receipts / our own mailbox when deciding “Need a reply”. */
function isIgnorableInboundForReplyTurn(from, subject, preview) {
  const fromText = String(from || '');
  const subj = String(subject || '');
  const prev = String(preview || '');
  const blob = `${fromText}\n${subj}\n${prev}`.toLowerCase();
  const addrMatch = fromText.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  const addr = (addrMatch ? addrMatch[1] : fromText).toLowerCase();

  if (addr === 'orderassistnow@gmail.com') return true;
  if (addr === 'ms-returns@orderassistnow.com') return true;
  if (/noreply@|no-reply@|mailer-daemon@|postmaster@/i.test(addr)) return true;
  if (/automated receipt|auto[- ]?reply|automatic reply|out of office/i.test(blob)) return true;
  if (/service team/i.test(blob) && /orderassistnow@gmail\.com/i.test(blob)) return true;
  return false;
}

/** MS emailed us → show “Need a reply” on this ticket + same-case siblings. */
function markTicketsNeedReply(ticketIds, opts = {}) {
  const ids = new Set((ticketIds || []).map((id) => String(id)).filter(Boolean));
  if (!ids.size) return 0;
  const log = loadJson(REPAIR_NEEDED_PATH, []);
  if (!Array.isArray(log)) return 0;
  const uid = opts.uid != null ? Number(opts.uid) : null;
  const subject = String(opts.subject || '').slice(0, 300);
  const at = isoNow();
  // When the inbound mail declares case IDs, only fan out to siblings on those cases.
  const emailCases = new Set(
    (opts.emailCases || []).map((c) => String(c || '').trim()).filter(Boolean)
  );

  // Expand to same MS case siblings (filtered by emailCases when present)
  const caseIds = new Set();
  for (const t of log) {
    if (!t || !ids.has(String(t.id))) continue;
    if (t.msCaseId) caseIds.add(String(t.msCaseId).trim());
  }
  let n = 0;
  for (const t of log) {
    if (!t) continue;
    const sameId = ids.has(String(t.id));
    const tCase = t.msCaseId ? String(t.msCaseId).trim() : '';
    const sameCase = !!(tCase && caseIds.has(tCase)
      && (!emailCases.size || emailCases.has(tCase)));
    if (!sameId && !sameCase) continue;
    // Primary ticket itself must also align with email case when known
    if (sameId && emailCases.size && tCase && !emailCases.has(tCase)) continue;
    if (t.status === 'resolved' || t.status === 'cannot_resolve') continue;
    t.msNeedsReply = true;
    t.msNeedsReplyUid = uid;
    t.msNeedsReplyAt = at;
    t.msNeedsReplySubject = subject || t.msNeedsReplySubject || null;
    n += 1;
  }
  if (n) atomicWriteJsonSync(REPAIR_NEEDED_PATH, log);
  return n;
}

/** We sent a reply → clear “Need a reply” on ticket + same-case siblings. */
function clearTicketsNeedReply(ticketId, opts = {}) {
  const log = loadJson(REPAIR_NEEDED_PATH, []);
  if (!Array.isArray(log)) return 0;
  const primary = log.find((t) => t && String(t.id) === String(ticketId));
  if (!primary) return 0;
  const caseId = String(primary.msCaseId || '').trim();
  const at = isoNow();
  let n = 0;
  for (const t of log) {
    if (!t) continue;
    const match = String(t.id) === String(ticketId)
      || (caseId && String(t.msCaseId || '').trim() === caseId);
    if (!match) continue;
    t.msNeedsReply = false;
    t.msNeedsReplyUid = null;
    t.msNeedsReplyAt = null;
    t.msNeedsReplySubject = null;
    t.msLastReplyAt = at;
    if (opts.draftId) t.msLastReplyDraftId = opts.draftId;
    n += 1;
  }
  if (n) atomicWriteJsonSync(REPAIR_NEEDED_PATH, log);
  return n;
}

/**
 * Recompute Need a reply from email events, ignoring Gmail auto-receipts
 * and inbound mail that belongs to a different MS case than the ticket.
 */
function syncTicketNeedReplyFlag(ticketId) {
  const log = loadJson(REPAIR_NEEDED_PATH, []);
  if (!Array.isArray(log)) return false;
  const primary = log.find((t) => t && String(t.id) === String(ticketId));
  if (!primary) return false;
  const caseId = String(primary.msCaseId || '').trim();
  const drafts = loadDrafts();
  const closed = new Set(['resolved', 'cannot_resolve']);
  let changed = 0;

  function eventAlignedWithCase(e, ticketCase) {
    if (!ticketCase || !e) return true;
    const fromSubj = String(e.subject || '');
    const subjCase = (fromSubj.match(/TrackingID#\s*(\d{16,20})/i)
      || fromSubj.match(/\bCase\s+(\d{16,20})\b/i)
      || fromSubj.match(/\bcase\s*#?\s*(\d{16,20})\b/i) || [])[1];
    const cases = new Set();
    if (subjCase) cases.add(subjCase);
    if (e.uid != null) {
      const rec = loadJson(path.join(INBOX_DIR, `uid-${e.uid}.json`), null);
      for (const c of recordCaseIds(rec)) cases.add(c);
    }
    if (!cases.size) return true; // no case on mail — allow (order/SN mail)
    return cases.has(ticketCase);
  }

  for (const t of log) {
    if (!t) continue;
    const match = String(t.id) === String(ticketId)
      || (caseId && String(t.msCaseId || '').trim() === caseId);
    if (!match) continue;
    if (closed.has(String(t.status || ''))) {
      if (t.msNeedsReply) {
        t.msNeedsReply = false;
        t.msNeedsReplyUid = null;
        t.msNeedsReplyAt = null;
        t.msNeedsReplySubject = null;
        changed += 1;
      }
      continue;
    }

    const ticketCase = String(t.msCaseId || '').trim();
    const events = Array.isArray(t.msEmailEvents) ? t.msEmailEvents : [];
    let latest = null;
    let latestT = -1;
    for (const e of events) {
      if (!e || e.uid == null) continue;
      if (isIgnorableInboundForReplyTurn(e.from, e.subject, '')) continue;
      if (!eventAlignedWithCase(e, ticketCase)) continue;
      const ts = Date.parse(e.emailDate || e.at || '') || 0;
      if (!latest || ts > latestT || (ts === latestT && Number(e.uid) > Number(latest.uid))) {
        latest = e;
        latestT = ts;
      }
    }

    let needs = false;
    if (latest) {
      const uid = Number(latest.uid);
      // Only trust drafts that actually went out via SMTP (avoid false "sent" clearing the badge)
      const replied = drafts.some((d) => d
        && d.status === 'sent'
        && !!(d.smtpMessageId || d.smtpResponse || d.smtpAccepted)
        && Number(d.inReplyToUid) === uid
        && (
          String(d.ticketId) === String(t.id)
          || (caseId && String(d.msCaseId || '').trim() === caseId)
        ));
      needs = !replied;
      if (needs) {
        t.msNeedsReply = true;
        t.msNeedsReplyUid = uid;
        t.msNeedsReplyAt = latest.emailDate || latest.at || isoNow();
        t.msNeedsReplySubject = latest.subject || null;
      } else {
        t.msNeedsReply = false;
        t.msNeedsReplyUid = null;
        t.msNeedsReplyAt = null;
        t.msNeedsReplySubject = null;
      }
    } else {
      t.msNeedsReply = false;
      t.msNeedsReplyUid = null;
      t.msNeedsReplyAt = null;
      t.msNeedsReplySubject = null;
    }
    changed += 1;
  }
  if (changed) atomicWriteJsonSync(REPAIR_NEEDED_PATH, log);
  return changed > 0;
}

function saveDraftEdits(draftId, patch, by) {
  const all = loadDrafts();
  const draft = all.find((d) => d && d.id === draftId);
  if (!draft) return { ok: false, error: 'Draft not found' };
  if (draft.status !== 'pending' && draft.status !== 'approved_queued') {
    return { ok: false, error: `Draft status is ${draft.status}` };
  }
  if (patch && typeof patch.subject === 'string') {
    draft.subject = patch.subject.trim().slice(0, 300);
  }
  if (patch && typeof patch.body === 'string') {
    draft.body = patch.body.trim().slice(0, 12000);
  }
  draft.editedAt = isoNow();
  draft.editedBy = by || 'operator';
  saveDrafts(all);
  return { ok: true, draft };
}

function loadCursorApiKey() {
  const fromEnv = process.env.CURSOR_API_KEY || process.env.OA_CURSOR_API_KEY || '';
  if (fromEnv) return fromEnv.trim();
  try {
    const cfg = loadJson(path.join(ROOT, 'account', 'cursor.json'), null);
    if (cfg && (cfg.apiKey || cfg.key)) return String(cfg.apiKey || cfg.key).trim();
  } catch (_) { /* ignore */ }
  return '';
}

function cursorAgentExists() {
  try {
    return fs.existsSync(CURSOR_AGENT_BIN);
  } catch (_) {
    return false;
  }
}

function cursorAgentLoggedIn() {
  if (!cursorAgentExists()) return false;
  if (loadCursorApiKey()) return true;
  try {
    const out = execFileSync(CURSOR_AGENT_BIN, ['status'], {
      encoding: 'utf8',
      timeout: 12000,
      env: { ...process.env, HOME: '/root', PATH: `/root/.local/bin:${process.env.PATH || ''}` }
    });
    return /logged in as/i.test(String(out || '')) && !/not logged in|logged out/i.test(String(out || ''));
  } catch (_) {
    return false;
  }
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) { /* continue */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) { /* continue */ }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_) { /* continue */ }
  }
  return null;
}

function normalizeAiDraftResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!parsed.body) return null;
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.map((q) => String(q || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const documentHints = Array.isArray(parsed.documentHints)
    ? parsed.documentHints.map((q) => String(q || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  return {
    subject: String(parsed.subject || '').trim().slice(0, 300),
    body: String(parsed.body || '').trim().slice(0, 12000),
    note: String(parsed.note || '').trim().slice(0, 400),
    questions,
    needsHuman: !!parsed.needsHuman,
    needsHumanReason: String(parsed.needsHumanReason || '').trim().slice(0, 500),
    needsDocuments: !!parsed.needsDocuments,
    documentHints
  };
}

function cursorImproveDraft(context) {
  return new Promise((resolve) => {
    if (!cursorAgentExists()) {
      resolve(null);
      return;
    }
    if (!cursorAgentLoggedIn()) {
      resolve(null);
      return;
    }

    try {
      fs.mkdirSync(AI_PROMPT_DIR, { recursive: true });
      fs.mkdirSync(CURSOR_WORKSPACE, { recursive: true });
    } catch (_) { /* ignore */ }

    const systemRules = [
      'You help OrderAssist / Visic warehouse staff write replies to Microsoft Surface Support so warranty claims succeed.',
      'Return JSON only (no markdown prose outside JSON) with keys:',
      '{"subject":"...","body":"...","note":"short what you changed",',
      '"questions":["optional questions for the human operator if you need facts"],',
      '"needsHuman":false,',
      '"needsHumanReason":"why a human must review (or empty)",',
      '"needsDocuments":false,',
      '"documentHints":["e.g. proof of purchase PDF"]}',
      'Rules:',
      '- Be professional, concise, factual. Do not invent tracking numbers, ETA, approvals, or serials.',
      '- Keep SN / case / order when present in the briefing.',
      '- If CASE BRIEFING lists multiple devices on the same MS case, the reply body MUST include every serial (and issue) on that case — never only the one ticket currently open.',
      '- Sign as OrderAssist / Visic unless told otherwise. body = plain text email with newlines.',
      '- Assume warehouse already completed standard troubleshooting for the stated issue unless briefing says otherwise.',
      '- Prefer wording like: we already tested X/Y; please run Z on your side / continue warranty / issue label.',
      '- If the newest MS email asks troubleshooting questions, answer EACH question they asked in that email (quote/paraphrase briefly + Yes/Done + issue persists). Match the symptom (battery vs touch vs keyboard). Never paste a generic UEFI/Device Manager/touch script when MS asked battery/charger/power-mode questions (or vice versa).',
      '- The first outbound email to MS is often NOT in the thread (MS replies without quoting it). Trust CASE BRIEFING + ISSUE.',
      '- Use the full email thread so you know what was already discussed — do not re-ask MS for info already given.',
      '- If you lack a critical fact (SN, order, which tests were done), put clear questions for the OPERATOR (not for MS) in "questions".',
      '- Set needsHuman=true only when a person must decide (escalation, legal, conflicting facts, sensitive exception). Always explain in needsHumanReason.',
      '- Set needsDocuments=true when MS asked for proof of purchase / invoice / photos — remind operator to upload files before Approve.',
      '- Learn tone from APPROVED/REJECTED training examples when provided.',
      '- Never claim the reply was sent; operator must Approve.',
      '- Output ONLY the JSON object.'
    ].join(' ');

    const prompt = `${systemRules}\n\n=== CONTEXT ===\n${String(context || '').slice(0, 90000)}`;
    const promptPath = path.join(AI_PROMPT_DIR, `prompt-${process.pid}-${Date.now()}.txt`);
    try {
      fs.writeFileSync(promptPath, prompt, 'utf8');
    } catch (e) {
      resolve(null);
      return;
    }

    const apiKey = loadCursorApiKey();
    const promptText = fs.readFileSync(promptPath, 'utf8');
    const args = [
      '-p',
      '--mode', 'ask',
      '--output-format', 'stream-json',
      '--trust',
      '--sandbox', 'disabled',
      '--workspace', CURSOR_WORKSPACE,
      '--model', CURSOR_MODEL,
      promptText
    ];
    if (apiKey) args.unshift('--api-key', apiKey);

    execFile(
      CURSOR_AGENT_BIN,
      args,
      {
        cwd: ROOT,
        timeout: CURSOR_TIMEOUT_MS,
        maxBuffer: 12 * 1024 * 1024,
        env: {
          ...process.env,
          HOME: '/root',
          PATH: `/root/.local/bin:${process.env.PATH || ''}`,
          ...(apiKey ? { CURSOR_API_KEY: apiKey } : {})
        }
      },
      (error, stdout, stderr) => {
        try { fs.unlinkSync(promptPath); } catch (_) { /* ignore */ }
        const raw = String(stdout || '');
        let resultText = '';
        const assistantBits = [];
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const ev = JSON.parse(trimmed);
            if (ev.type === 'result' && ev.result) {
              resultText = String(ev.result);
            }
            if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
              for (const block of ev.message.content) {
                if (block && block.type === 'text' && block.text) assistantBits.push(String(block.text));
              }
            }
          } catch (_) { /* ignore non-json lines */ }
        }
        const text = (resultText || assistantBits.join('')).trim();
        const parsed = normalizeAiDraftResult(extractJsonObject(text));
        if (parsed) {
          if (!parsed.note) parsed.note = `Rewritten via Cursor Agent (${CURSOR_MODEL})`;
          resolve(parsed);
          return;
        }
        const errText = [
          error && error.killed ? 'timeout' : null,
          error && error.message,
          String(stderr || '').slice(0, 400),
          !text ? null : `unparsed:${text.slice(0, 120)}`
        ].filter(Boolean).join(' · ');
        if (errText) {
          console.error('[ms_email_replies] Cursor Agent AI failed:', errText.slice(0, 500));
        }
        resolve({ __cursorError: errText || 'empty output' });
      }
    );
  });
}

function localImproveDraft(draft, instruction, ticket, cursorError) {
  let body = String(draft.body || '');
  const tip = String(instruction || '').toLowerCase();
  if (/shorter|brief|concise/.test(tip)) {
    body = body.split(/\n\n+/).slice(0, 3).join('\n\n');
  }
  if (/polite|softer|friendlier/.test(tip)) {
    body = body.replace(/^Hello,?/i, 'Hello,');
    if (!/please/i.test(body)) {
      body = body.replace(/\n\nThank you,/i, '\n\nPlease let us know if you need anything else.\n\nThank you,');
    }
  }
  const issue = ticket && ticket.issue
    ? String(ticket.issue).replace(/^From MS email:\s*/i, '').slice(0, 200)
    : '';
  if (issue && !body.toLowerCase().includes(issue.slice(0, 40).toLowerCase()) && /brief|prepare|context|troubleshoot/.test(tip)) {
    body = body.replace(
      /^Hello,\s*/i,
      `Hello,\n\nRegarding the reported issue (${issue}): we have already completed our standard troubleshooting on this unit.\n\n`
    );
  }
  const needsDocs = /proof of purchase|document|invoice|receipt/.test(tip)
    || /proof of purchase|document|invoice|receipt/.test(String(draft.why || '').toLowerCase());
  let note = 'Cursor Agent unavailable — applied a light local tweak. Ensure cursor-agent is logged in on the server.';
  if (cursorError) {
    if (/usage limit/i.test(cursorError)) {
      note = 'Cursor usage limit hit for the selected model — applied a light local tweak. Try model "auto"/"composer-2.5" or raise Spend Limit.';
    } else {
      note = `Cursor Agent failed (${String(cursorError).slice(0, 180)}) — applied a light local tweak.`;
    }
  }
  return {
    subject: draft.subject,
    body,
    note,
    questions: [],
    needsHuman: false,
    needsHumanReason: '',
    needsDocuments: needsDocs,
    documentHints: needsDocs ? ['Proof of purchase / invoice'] : []
  };
}

function maybeNotifyHumanNeeded(draft, ticket) {
  if (!draft || !draft.needsHuman) return;
  const sn = (ticket && ticket.serialNumber) || draft.serialNumber || '';
  const ticketId = (ticket && ticket.id) || draft.ticketId || null;
  const reason = draft.needsHumanReason || 'AI flagged this MS reply for human review';
  pushConsoleNotification({
    id: `n-human-${draft.id}`,
    kind: 'human_needed',
    major: true,
    title: `Human needed · MS reply${sn ? ` · ${sn}` : ''}`,
    body: reason.slice(0, 400),
    href: 'repair',
    ticketId,
    serialNumber: sn || null,
    draftId: draft.id,
    open: 'sheet'
  });
}

async function improveDraft(draftId, instruction, opts = {}) {
  const all = loadDrafts();
  const draft = all.find((d) => d && d.id === draftId);
  if (!draft) return { ok: false, error: 'Draft not found' };
  if (draft.status !== 'pending' && draft.status !== 'approved_queued') {
    return { ok: false, error: `Draft status is ${draft.status}` };
  }

  const by = opts.by || 'operator';
  if (opts.subject != null) draft.subject = String(opts.subject).trim().slice(0, 300);
  if (opts.body != null) draft.body = String(opts.body).trim().slice(0, 12000);

  const ticket = findTicket(draft.ticketId);
  let threadSummary = '';
  try {
    if (ticket) {
      const thread = await buildThreadForTicket(ticket);
      const msgs = (thread.messages || []).slice(-16);
      threadSummary = msgs.map((m, idx) => {
        const text = String(m.text || m.preview || '').replace(/\s+/g, ' ').slice(0, 700);
        const tag = idx === msgs.length - 1 ? ' [NEWEST — reply to this]' : '';
        return `[${m.date || ''}] From: ${m.from || ''}${tag}\nSubject: ${m.subject || ''}\n${text}`;
      }).join('\n\n---\n\n');
    }
  } catch (e) {
    threadSummary = `(thread load failed: ${e.message})`;
  }

  const chat = Array.isArray(draft.chatHistory) ? draft.chatHistory.slice(-12) : [];
  const chatBlock = chat.length
    ? chat.map((c) => `${c.role || 'user'}: ${String(c.text || '').slice(0, 400)}`).join('\n')
    : '(none yet)';

  const defaultAsk = opts.mode === 'brief'
    ? [
      'Using the full CASE BRIEFING and EMAIL THREAD (especially the NEWEST MS email), rewrite this reply so Microsoft clearly understands:',
      '(1) the device issue and serial(s),',
      '(2) direct answers to EVERY question in the NEWEST MS email — answer that email’s questions (battery/charger/power-mode OR UEFI/MSDT/wipe/etc.), not a generic checklist for a different symptom,',
      '(3) what we need them to do next for warranty (service offer / RMA / label / keep case open).',
      'Do NOT send a serial-only reply when MS asked diagnostic questions — answer those questions point-by-point.',
      'Never mention touch/display failure on a battery case (or the reverse). Match the reported issue.',
      'If you need facts from the operator, list questions. If a human must handle this, set needsHuman.',
      'If MS asked for documents, set needsDocuments and documentHints.'
    ].join(' ')
    : 'Improve this reply for clarity and professionalism using full case context. If MS asked troubleshooting questions, make sure each one is answered explicitly.';

  const ask = String(instruction || defaultAsk).trim().slice(0, 2000) || defaultAsk;
  const context = [
    '=== CASE BRIEFING / STAGE (trust this — first outbound may be missing from thread) ===',
    buildTicketStageContext(ticket),
    '',
    '=== EMAIL THREAD (oldest → newest; know what was already discussed) ===',
    threadSummary || '(none in inbox yet — rely on briefing)',
    '',
    '=== PRIOR OPERATOR ↔ AI DISCUSSION ===',
    chatBlock,
    '',
    '=== TRAINING EXAMPLES (tone / what humans approved or rejected) ===',
    recentTrainingExamples(6),
    '',
    'CURRENT DRAFT SUBJECT:',
    draft.subject || '',
    '',
    'CURRENT DRAFT BODY:',
    draft.body || '',
    '',
    'OPERATOR REQUEST:',
    ask
  ].join('\n');

  let improved = await cursorImproveDraft(context);
  const cursorError = improved && improved.__cursorError ? improved.__cursorError : null;
  if (improved && improved.__cursorError) improved = null;
  const source = improved ? 'cursor' : 'local';
  if (!improved) improved = localImproveDraft(draft, ask, ticket, cursorError);

  if (!Array.isArray(draft.chatHistory)) draft.chatHistory = [];
  draft.chatHistory.push({
    at: isoNow(),
    by,
    role: 'user',
    text: ask
  });
  const assistantBits = [improved.note || 'Updated draft'];
  if (improved.questions && improved.questions.length) {
    assistantBits.push(`Questions for you: ${improved.questions.join(' | ')}`);
  }
  if (improved.needsHuman) {
    assistantBits.push(`Needs human: ${improved.needsHumanReason || 'review required'}`);
  }
  if (improved.needsDocuments) {
    assistantBits.push(`Upload docs: ${(improved.documentHints || []).join(', ') || 'requested files'}`);
  }
  draft.chatHistory.push({
    at: isoNow(),
    by: 'ai',
    role: 'assistant',
    text: assistantBits.join(' · '),
    source
  });
  if (draft.chatHistory.length > 40) {
    draft.chatHistory = draft.chatHistory.slice(-40);
  }

  if (improved.subject) draft.subject = improved.subject;
  if (improved.body) draft.body = improved.body;
  draft.operatorQuestions = Array.isArray(improved.questions) ? improved.questions : [];
  draft.needsHuman = !!improved.needsHuman;
  draft.needsHumanReason = improved.needsHumanReason || null;
  draft.needsDocuments = !!improved.needsDocuments
    || draft.templateKey === 'provide_documents';
  draft.documentHints = Array.isArray(improved.documentHints) ? improved.documentHints : [];
  draft.editedAt = isoNow();
  draft.editedBy = by;
  draft.attachments = listDraftUploads(draft.id);
  saveDrafts(all);

  maybeNotifyHumanNeeded(draft, ticket);

  return {
    ok: true,
    draft,
    source,
    note: improved.note || '',
    questions: draft.operatorQuestions,
    needsHuman: draft.needsHuman,
    needsHumanReason: draft.needsHumanReason,
    needsDocuments: draft.needsDocuments,
    documentHints: draft.documentHints,
    aiAvailable: !!cursorAgentLoggedIn()
  };
}

async function approveDraft(draftId, by, patch) {
  if (patch && (patch.subject != null || patch.body != null)) {
    const saved = saveDraftEdits(draftId, patch, by);
    if (!saved.ok) return saved;
  }

  const all = loadDrafts();
  const draft = all.find((d) => d && d.id === draftId);
  if (!draft) return { ok: false, error: 'Draft not found' };
  if (draft.status === 'sent') {
    return { ok: false, error: 'This draft was already sent. Open a new inbound MS email before sending again.' };
  }
  if (draft.status === 'already_sent') {
    return {
      ok: false,
      error: `A reply was already sent for this MS email${draft.alreadySentDraftId ? ` (${draft.alreadySentDraftId})` : ''}. Sending again is blocked.`
    };
  }
  if (draft.status !== 'pending' && draft.status !== 'approved_queued') {
    return { ok: false, error: `Draft status is ${draft.status}` };
  }

  // Hard guard: same inbound MS email already answered (this case or sibling)
  const prior = findSentDraftForConversation({
    inReplyToUid: draft.inReplyToUid,
    msCaseId: draft.msCaseId,
    ticketId: draft.ticketId
  });
  if (prior && prior.id !== draft.id) {
    draft.status = 'already_sent';
    draft.alreadySentAt = isoNow();
    draft.alreadySentDraftId = prior.id;
    draft.alreadySentBy = by || 'operator';
    draft.training = {
      decision: 'already_sent',
      reason: `Blocked — reply already sent (${prior.id} at ${prior.sentAt || 'unknown'})`,
      at: isoNow(),
      by: by || 'operator'
    };
    saveDrafts(all);
    return {
      ok: false,
      error: `Already sent a reply to this MS email on ${prior.sentAt || 'an earlier time'} (draft ${prior.id}). Sending again is blocked to avoid duplicates.`,
      priorSent: { id: prior.id, sentAt: prior.sentAt, subject: prior.subject, msCaseId: prior.msCaseId }
    };
  }

  draft.training = {
    decision: 'approve',
    reason: 'Approved as good auto-response',
    at: isoNow(),
    by: by || 'operator'
  };

  const ticket = findTicket(draft.ticketId);
  let sendResult;
  try {
    sendResult = await sendDraftSmtp(draft, ticket);
  } catch (e) {
    draft.status = 'approved_queued';
    draft.sendError = e.message || String(e);
    saveDrafts(all);
    saveTraining([...loadTraining(), { ...draft.training, draftId, templateKey: draft.templateKey, body: draft.body }]);
    return { ok: true, draft, send: { sent: false, queued: true, note: draft.sendError } };
  }

  if (sendResult.sent) {
    draft.status = 'sent';
    draft.sentAt = isoNow();
    draft.sendError = null;
    draft.smtpMessageId = sendResult.messageId || null;
    draft.smtpTo = sendResult.to || null;
    draft.smtpCc = sendResult.cc || null;
    draft.smtpFrom = sendResult.from || null;
    draft.sentImapFolder = sendResult.sentFolder || null;
    draft.sentImapAppendError = sendResult.sentAppendError || null;
  } else {
    draft.status = 'approved_queued';
    draft.sendError = null;
  }
  saveDrafts(all);

  if (sendResult.sent) {
    markRelatedDraftsAlreadySent(draft, by || 'operator');
    clearTicketsNeedReply(draft.ticketId, { draftId: draft.id });
  }

  const training = loadTraining();
  training.push({
    at: isoNow(),
    draftId: draft.id,
    templateKey: draft.templateKey,
    decision: 'approve',
    reason: draft.training.reason,
    by: draft.training.by,
    subject: draft.subject,
    body: draft.body,
    inReplyToUid: draft.inReplyToUid,
    serialNumber: draft.serialNumber,
    msCaseId: draft.msCaseId
  });
  saveTraining(training);

  const sentNote = sendResult.sent
    ? (sendResult.sentFolder
      ? ` (also saved to IMAP ${sendResult.sentFolder})`
      : (sendResult.sentAppendError ? ` (Sent folder copy failed: ${sendResult.sentAppendError})` : ''))
    : '';
  appendTicketNote(
    draft.ticketId,
    `Draft ${draft.status === 'sent' ? 'SENT' : 'APPROVED (queued)'}: "${draft.subject}" — ${draft.templateKey}${sentNote}`,
    'ms_draft'
  );

  return { ok: true, draft, send: sendResult };
}

function rejectDraft(draftId, reason, by) {
  const all = loadDrafts();
  const draft = all.find((d) => d && d.id === draftId);
  if (!draft) return { ok: false, error: 'Draft not found' };
  if (draft.status !== 'pending') {
    return { ok: false, error: `Draft status is ${draft.status}` };
  }
  const why = String(reason || '').trim();
  if (why.length < 3) return { ok: false, error: 'Training reason required (why this reply is wrong)' };

  draft.status = 'rejected';
  draft.training = {
    decision: 'reject',
    reason: why.slice(0, 1000),
    at: isoNow(),
    by: by || 'operator'
  };
  saveDrafts(all);

  const training = loadTraining();
  training.push({
    at: isoNow(),
    draftId: draft.id,
    templateKey: draft.templateKey,
    decision: 'reject',
    reason: draft.training.reason,
    by: draft.training.by,
    subject: draft.subject,
    body: draft.body,
    inReplyToUid: draft.inReplyToUid,
    serialNumber: draft.serialNumber,
    msCaseId: draft.msCaseId
  });
  saveTraining(training);

  appendTicketNote(
    draft.ticketId,
    `Draft REJECTED (${draft.templateKey}): ${why.slice(0, 300)}`,
    'ms_draft'
  );

  return { ok: true, draft };
}

/**
 * After an inbound email is applied to tickets, refresh attachments + drafts.
 */
async function afterEmailApplied(record, matchedTicketIds) {
  if (!record || !record.uid) return;
  try {
    const parsedBundle = await parseUid(record.uid);
    if (parsedBundle) {
      const attachments = extractAndSaveAllAttachments(parsedBundle.parsed, record.uid);
      record.attachments = attachments;
      atomicWriteJsonSync(path.join(INBOX_DIR, `uid-${record.uid}.json`), record);
    }
  } catch (e) {
    console.error('[ms_email_replies] attach', record.uid, e.message);
  }

  const log = loadJson(REPAIR_NEEDED_PATH, []);
  if (!Array.isArray(log)) return;
  const closed = new Set(['resolved', 'cannot_resolve']);
  let targets = log.filter((t) => {
    if (!t || closed.has(String(t.status || ''))) return false;
    if (matchedTicketIds && matchedTicketIds.length) {
      return matchedTicketIds.includes(t.id);
    }
    return recordMatchesTicket(record, ticketIdentity(t), { preferDevice: true });
  });

  // One draft target per serial — prefer ticket with matching case, then newest.
  const bySerial = new Map();
  function score(t) {
    let s = 0;
    const f = record.fields || {};
    if (t.msCaseId && (f.cases || []).includes(String(t.msCaseId))) s += 10;
    if (t.msOrderNumber && (f.orders || []).includes(String(t.msOrderNumber))) s += 8;
    if (t.source === 'ms_email') s += 2;
    s += String(t.statusAt || t.at || '').localeCompare('0') ? 1 : 0;
    return s;
  }
  for (const t of targets) {
    const sn = String(t.serialNumber || '').toUpperCase() || t.id;
    const prev = bySerial.get(sn);
    if (!prev || score(t) > score(prev)) bySerial.set(sn, t);
  }
  targets = [...bySerial.values()];

  const snList = targets.map((t) => t.serialNumber).filter(Boolean).slice(0, 4).join(', ');
  const primary = targets[0] || null;
  pushConsoleNotification({
    id: `n-msmail-${record.uid}`,
    kind: 'new_email',
    major: true,
    title: targets.length
      ? `New MS email · ${snList || targets.length + ' ticket(s)'}`
      : `New MS email (unmatched) · uid ${record.uid}`,
    body: String(record.subject || 'Microsoft support mail').slice(0, 300)
      + (targets.length ? '' : ' — open Repair Needed / unmatched to link'),
    href: 'repair',
    ticketId: primary ? primary.id : null,
    serialNumber: primary ? primary.serialNumber : null,
    uid: record.uid,
    open: primary ? 'email' : 'unmatched'
  });

  for (const ticket of targets) {
    try {
      const ignorable = isIgnorableInboundForReplyTurn(
        record.from,
        record.subject,
        record.preview
      );
      const emailCases = [...recordCaseIds(record)];
      const ticketCase = String(ticket.msCaseId || '').trim();
      // Old-case mail must not flip Need-a-reply on a ticket that moved to a new case.
      const caseAligned = !emailCases.length || !ticketCase || emailCases.includes(ticketCase);
      const alreadyReplied = loadDrafts().some((d) => d
        && d.status === 'sent'
        && Number(d.inReplyToUid) === Number(record.uid)
        && (
          String(d.ticketId) === String(ticket.id)
          || (ticket.msCaseId && String(d.msCaseId || '').trim() === String(ticket.msCaseId).trim())
        ));
      if (ignorable) {
        // Auto-receipt / our Gmail — do not set Need a reply; recompute from last real MS mail
        syncTicketNeedReplyFlag(ticket.id);
      } else if (!caseAligned) {
        syncTicketNeedReplyFlag(ticket.id);
      } else if (!alreadyReplied) {
        markTicketsNeedReply([ticket.id], {
          uid: record.uid,
          subject: record.subject || '',
          emailCases
        });
      } else {
        clearTicketsNeedReply(ticket.id, {});
      }

      // Do not seed AI/template drafts for ignorable auto-receipts or wrong-case mail
      if (ignorable || !caseAligned) continue;

      const all = loadDrafts();
      supersedeStaleDrafts(all, ticket.id, record.uid);
      saveDrafts(all);
      // Fast template seed so inbox poll never blocks on AI
      const created = await ensureDraftsForRecord(ticket, record, null, {
        onlyBest: true,
        preferAi: false
      });
      if (created.length) {
        console.log('[ms_email_replies] draft seed', ticket.id, created[0].templateKey);
        // Background: replace seed with AI reply from the actual MS email
        upgradeDraftWithAi(ticket, created[0], record, null, null).then((ok) => {
          if (ok) console.log('[ms_email_replies] AI upgraded', created[0].id);
        }).catch((e) => {
          console.error('[ms_email_replies] AI upgrade', created[0].id, e.message);
        });
      }
    } catch (e) {
      console.error('[ms_email_replies] draft', ticket.id, e.message);
    }
  }
}

function findAttachmentFile(id) {
  ensureDirs();
  const safe = String(id || '').replace(/[^\w\-]/g, '');
  if (!safe) return null;
  const files = fs.readdirSync(ATT_DIR).filter((f) => f.startsWith(`${safe}_`) || f === `${safe}`);
  // Also allow label files looked up via attachments id that was saved as label
  if (!files.length) {
    const labelsDir = path.join(INBOX_DIR, 'labels');
    if (fs.existsSync(labelsDir)) {
      const lab = fs.readdirSync(labelsDir).filter((f) => f.startsWith(`${safe}_`) || f.startsWith(safe));
      if (lab.length) {
        const file = lab.sort((a, b) => b.length - a.length)[0];
        return { full: path.join(labelsDir, file), downloadName: file.replace(new RegExp(`^${safe}_`), '') };
      }
    }
    return null;
  }
  const file = files.sort((a, b) => b.length - a.length)[0];
  return { full: path.join(ATT_DIR, file), downloadName: file.replace(new RegExp(`^${safe}_`), '') || file };
}

function setupMsEmailReplyRoutes(app) {
  ensureDirs();

  app.get('/api/ms-email/thread', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const ticketId = String(req.query.ticketId || '').trim();
    if (!ticketId) return res.status(400).json({ error: 'ticketId required' });
    const ticket = findTicket(ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    try {
      const thread = await buildThreadForTicket(ticket);
      const drafts = draftsForTicket(ticketId, { all: true });
      const enriched = [];
      for (const d of drafts) {
        if (d && (d.status === 'pending' || d.status === 'approved_queued')) {
          enriched.push(await enrichDraftWithEnvelope(d));
        } else {
          enriched.push(d);
        }
      }
      res.json({ ok: true, ...thread, drafts: enriched });
    } catch (e) {
      res.status(500).json({ error: e.message || 'thread failed' });
    }
  });

  app.get('/api/ms-email/message/:uid', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const uid = Number(req.params.uid);
    if (!uid) return res.status(400).json({ error: 'uid required' });
    try {
      const view = await buildMessageView(uid);
      if (!view) return res.status(404).json({ error: 'Message not found' });
      res.json({ ok: true, message: view });
    } catch (e) {
      res.status(500).json({ error: e.message || 'message failed' });
    }
  });

  app.get('/api/ms-email/attachments/:id', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const found = findAttachmentFile(req.params.id);
    if (!found) return res.status(404).json({ error: 'Attachment not found' });
    const ext = path.extname(found.downloadName).toLowerCase();
    const types = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.txt': 'text/plain',
      '.eml': 'message/rfc822'
    };
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    const inline = (types[ext] && types[ext].startsWith('image/')) || ext === '.pdf';
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${found.downloadName.replace(/"/g, '')}"`
    );
    fs.createReadStream(found.full).pipe(res);
  });

  app.get('/api/ms-email/drafts', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const ticketId = String(req.query.ticketId || '').trim();
    if (ticketId) {
      return res.json({ ok: true, drafts: draftsForTicket(ticketId, { all: true }) });
    }
    const pending = loadDrafts().filter((d) => d.status === 'pending' || d.status === 'approved_queued');
    res.json({ ok: true, drafts: pending.slice(-100).reverse() });
  });

  app.post('/api/ms-email/drafts/refresh', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const ticketId = String((req.body && req.body.ticketId) || req.query.ticketId || '').trim();
    if (!ticketId) return res.status(400).json({ error: 'ticketId required' });
    const ticket = findTicket(ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    try {
      const result = await refreshDraftsForTicket(ticket);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message || 'refresh failed' });
    }
  });

  app.post('/api/ms-email/drafts/:id/approve', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const by = (req.session && (req.session.user || req.session.username)) || 'operator';
    const patch = {
      subject: req.body && req.body.subject,
      body: req.body && req.body.body
    };
    try {
      const result = await approveDraft(req.params.id, by, patch);
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message || 'approve failed' });
    }
  });

  app.post('/api/ms-email/drafts/:id/save', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const by = (req.session && (req.session.user || req.session.username)) || 'operator';
    const result = saveDraftEdits(req.params.id, {
      subject: req.body && req.body.subject,
      body: req.body && req.body.body
    }, by);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  app.post('/api/ms-email/drafts/:id/improve', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const by = (req.session && (req.session.user || req.session.username)) || 'operator';
    const message = (req.body && (req.body.message || req.body.instruction || req.body.prompt)) || '';
    const mode = String((req.body && req.body.mode) || '').trim().toLowerCase();
    if (mode !== 'brief' && String(message).trim().length < 2) {
      return res.status(400).json({ error: 'Tell the AI what to change, or use Prepare with AI.' });
    }
    try {
      const result = await improveDraft(req.params.id, message, {
        by,
        mode: mode === 'brief' ? 'brief' : 'improve',
        subject: req.body && req.body.subject,
        body: req.body && req.body.body
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message || 'improve failed' });
    }
  });

  app.post('/api/ms-email/drafts/:id/brief', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const by = (req.session && (req.session.user || req.session.username)) || 'operator';
    try {
      const result = await improveDraft(req.params.id, '', {
        by,
        mode: 'brief',
        subject: req.body && req.body.subject,
        body: req.body && req.body.body
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message || 'brief failed' });
    }
  });

  app.post('/api/ms-email/drafts/:id/answer', async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const by = (req.session && (req.session.user || req.session.username)) || 'operator';
    const answers = String((req.body && (req.body.answers || req.body.message)) || '').trim();
    if (answers.length < 2) {
      return res.status(400).json({ error: 'Answer the AI questions so it can finish the MS reply.' });
    }
    try {
      const result = await improveDraft(
        req.params.id,
        `Operator answers to your questions (use these facts; clear questions if resolved):\n${answers}`,
        {
          by,
          subject: req.body && req.body.subject,
          body: req.body && req.body.body
        }
      );
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message || 'answer failed' });
    }
  });

  app.get('/api/ms-email/drafts/ai-status', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    res.json({
      ok: true,
      aiAvailable: !!cursorAgentLoggedIn()
    });
  });

  if (multer) {
    const draftUpload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024, files: 8 }
    });

    app.post('/api/ms-email/drafts/:id/files', draftUpload.array('files', 8), (req, res) => {
      if (!req.session || !req.session.loggedIn) {
        return res.status(401).json({ error: 'Login required' });
      }
      const draftId = safeDraftId(req.params.id);
      const all = loadDrafts();
      const draft = all.find((d) => d && d.id === draftId);
      if (!draft) return res.status(404).json({ error: 'Draft not found' });
      if (!['pending', 'approved_queued'].includes(String(draft.status || ''))) {
        return res.status(400).json({ error: `Draft status is ${draft.status}` });
      }
      ensureDirs();
      const dir = path.join(DRAFT_UPLOAD_DIR, draftId);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const saved = [];
      for (const file of (req.files || [])) {
        const base = safeName(file.originalname || 'upload.bin');
        const stored = `${Date.now()}_${base}`;
        fs.writeFileSync(path.join(dir, stored), file.buffer);
        saved.push(stored);
      }
      draft.attachments = listDraftUploads(draftId);
      draft.needsDocuments = draft.needsDocuments || saved.length > 0;
      saveDrafts(all);
      res.json({ ok: true, saved: saved.length, attachments: draft.attachments, draft });
    });

    app.delete('/api/ms-email/drafts/:id/files/:filename', (req, res) => {
      if (!req.session || !req.session.loggedIn) {
        return res.status(401).json({ error: 'Login required' });
      }
      const draftId = safeDraftId(req.params.id);
      const filename = safeName(req.params.filename);
      const full = path.join(DRAFT_UPLOAD_DIR, draftId, filename);
      if (!full.startsWith(path.join(DRAFT_UPLOAD_DIR, draftId))) {
        return res.status(400).json({ error: 'Invalid path' });
      }
      try {
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } catch (e) {
        return res.status(500).json({ error: e.message || 'delete failed' });
      }
      const all = loadDrafts();
      const draft = all.find((d) => d && d.id === draftId);
      if (draft) {
        draft.attachments = listDraftUploads(draftId);
        saveDrafts(all);
      }
      res.json({ ok: true, attachments: draft ? draft.attachments : [] });
    });
  }

  app.get('/api/ms-email/drafts/:id/files/:filename', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const draftId = safeDraftId(req.params.id);
    const filename = safeName(req.params.filename);
    const full = path.join(DRAFT_UPLOAD_DIR, draftId, filename);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/^\d+_/, '').replace(/"/g, '')}"`);
    fs.createReadStream(full).pipe(res);
  });

  app.post('/api/ms-email/drafts/:id/reject', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    const by = (req.session && (req.session.user || req.session.username)) || 'operator';
    const reason = (req.body && req.body.reason) || '';
    const result = rejectDraft(req.params.id, reason, by);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  app.get('/api/ms-email/draft-training', (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    res.json({ ok: true, items: loadTraining().slice(-200).reverse() });
  });
}

module.exports = {
  setupMsEmailReplyRoutes,
  afterEmailApplied,
  extractAndSaveAllAttachments,
  refreshDraftsForTicket,
  buildThreadForTicket,
  ensureDraftsForRecord,
  saveDraftEdits,
  improveDraft,
  loadReturnAddress,
  formatReturnAddressBlock,
  msAsksForAddress,
  buildDraftEnvelope,
  buildMessageView,
  syncTicketNeedReplyFlag,
  recordMatchesTicket,
  ticketIdentity
};
