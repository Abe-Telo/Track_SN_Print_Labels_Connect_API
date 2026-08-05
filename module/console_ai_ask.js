/**
 * Console "AI Ask" — chat assistant for OrderAssist Tracking data.
 *
 * Prefers the server Cursor Agent CLI (logged-in account) over OpenAI.
 * Default: read tools (lookup SN, repairs, orders, warranty cache, stats).
 * Safe writes (explicit allow-list): refresh warranty; update repair tickets /
 * apply MS SUR/AE order numbers when the operator asks to update the case.
 * All questions + tool traces stored for future product recommendations.
 *
 * Keep SAFE_WRITE_TOOLS tight — only console-safe mutations.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile, execFileSync } = require('child_process');
const { atomicWriteJsonSync } = require('./atomic_json.js');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');
const ASK_DIR = path.join(DB_DIR, 'console_ai_ask');
const SESSIONS_DIR = path.join(ASK_DIR, 'sessions');
const INDEX_PATH = path.join(ASK_DIR, 'sessions_index.json');
const QUESTIONS_PATH = path.join(ASK_DIR, 'questions.jsonl');
const MEMORY_PATH = path.join(ASK_DIR, 'learned_memory.json');
const REPAIR_PATH = path.join(DB_DIR, 'repair_needed.json');
const WARRANTY_CACHE_PATH = path.join(DB_DIR, 'warrantyCache.json');
const ORDERS_CACHE_PATH = path.join(DB_DIR, 'shipstation_orders_cache.json');
const CHANGELOG_PATH = path.join(DB_DIR, 'console_changelog.json');
const TRACKING_PATH = path.join(DB_DIR, 'trackingData.json');
const ARCHIVED_PATH = path.join(DB_DIR, 'archivedTrackingData.json');
const WARRANTY_SCRIPT = path.join(ROOT, 'scripts', 'bulk_refresh_warranty.py');
const RESULT_MARKER = '===RESULT_JSON===';
const CURSOR_AGENT_BIN = process.env.OA_CURSOR_AGENT
  || '/root/.local/bin/cursor-agent';
const CURSOR_TIMEOUT_MS = Number(process.env.OA_CURSOR_TIMEOUT_MS || 90000);
const CURSOR_WORKSPACE = process.env.OA_CURSOR_WORKSPACE
  || '/tmp/oa-ai-ask-workspace';
/** Keep chat sessions / question logs this long (ms). Crucial learned memory is kept longer. */
const RETENTION_MS = Number(process.env.OA_AI_ASK_RETENTION_MS || (183 * 24 * 60 * 60 * 1000)); // ~6 months
const CRUCIAL_RETENTION_MS = Number(process.env.OA_AI_ASK_CRUCIAL_RETENTION_MS || (730 * 24 * 60 * 60 * 1000)); // ~2 years

/** Tools the model may call. Only listed write tools may mutate data. */
const SAFE_WRITE_TOOLS = new Set([
  'refresh_warranty',
  'update_repair_ticket',
  'apply_ms_order_updates'
]);

let warrantyRepairApi = null;
function getWarrantyRepairApi() {
  if (warrantyRepairApi) return warrantyRepairApi;
  try {
    warrantyRepairApi = require('./warranty_repair.js');
  } catch (e) {
    warrantyRepairApi = {};
  }
  return warrantyRepairApi;
}

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'system_overview',
      description: 'High-level counts: open repairs by pipeline, order cache size, warranty cache size.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lookup_serial',
      description: 'Find a device by serial number in tracking (active + archived) and related repair ticket / warranty cache.',
      parameters: {
        type: 'object',
        properties: {
          serialNumber: { type: 'string', description: 'Device serial number' }
        },
        required: ['serialNumber'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lookup_order',
      description: 'Look up a ShipStation/order cache entry by order number and related devices.',
      parameters: {
        type: 'object',
        properties: {
          orderNumber: { type: 'string' }
        },
        required: ['orderNumber'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_repairs',
      description: 'Search open or all Microsoft/repair tickets by serial, case, order, issue text, or pipeline tab.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free text: SN, case, order, issue fragment' },
          pipeline: {
            type: 'string',
            description: 'Optional: needs|talking|ship|transit|checkin|todo|done|open'
          },
          limit: { type: 'integer', description: 'Max rows (default 15, max 40)' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_repair_ticket',
      description: 'Get one repair ticket by id or serial (prefers open ticket).',
      parameters: {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          serialNumber: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_warranty_cached',
      description: 'Read cached Microsoft warranty for a serial (no live network call).',
      parameters: {
        type: 'object',
        properties: {
          serialNumber: { type: 'string' }
        },
        required: ['serialNumber'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'refresh_warranty',
      description: 'SAFE WRITE: live Microsoft warranty check for one serial and update cache/device gaps. Use only when user asks to refresh/update warranty.',
      parameters: {
        type: 'object',
        properties: {
          serialNumber: { type: 'string' }
        },
        required: ['serialNumber'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_repair_ticket',
      description: 'SAFE WRITE: update one Repair needed ticket (MS order #, program SUR/AE, status, case, model, note). Use when the operator asks to update a case/ticket.',
      parameters: {
        type: 'object',
        properties: {
          serialNumber: { type: 'string' },
          ticketId: { type: 'string' },
          msOrderNumber: { type: 'string' },
          msCaseId: { type: 'string' },
          msProgram: {
            type: 'string',
            description: 'same_unit_repair | advanced_exchange'
          },
          status: {
            type: 'string',
            description: 'e.g. ms_approved_ship_same when SUR orders exist and labels are pending'
          },
          msDeviceModel: { type: 'string' },
          note: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'apply_ms_order_updates',
      description: 'SAFE WRITE: apply several Serial→MS order mappings at once (typical SUR/AE email with multiple Order details). Sets program + waiting-to-ship status unless overridden.',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                serialNumber: { type: 'string' },
                msOrderNumber: { type: 'string' },
                msDeviceModel: { type: 'string' }
              },
              required: ['serialNumber', 'msOrderNumber'],
              additionalProperties: false
            }
          },
          msCaseId: { type: 'string' },
          msProgram: { type: 'string' },
          status: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['updates'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_orders',
      description: 'Search cached ShipStation orders by order number, ShipStation orderId, name, email, or tracking fragment. Prefer this for marketplace/ShipStation numbers (not only 20xxxxxxxx MS ids).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_changelog',
      description: 'Recent console History & Changes entries.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_ask_insights',
      description: 'Summarize what operators have been asking AI Ask recently (for product recommendations).',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'How many recent questions to scan (default 40)' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_shipping_labels',
      description: 'List shipping label PDFs for a repair ticket/serial with direct download URLs (/api/ms-email/labels/...).',
      parameters: {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          serialNumber: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_ms_emails',
      description: 'MS email thread history for a ticket/serial/case (subjects, dates, previews). Does not send mail.',
      parameters: {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          serialNumber: { type: 'string' },
          caseId: { type: 'string' },
          limit: { type: 'integer', description: 'Max messages (default 25, max 60)' }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lookup_tracking',
      description: 'Resolve a carrier tracking number against repair tickets / order cache and return UPS (or carrier) track URLs.',
      parameters: {
        type: 'object',
        properties: {
          trackingNumber: { type: 'string' }
        },
        required: ['trackingNumber'],
        additionalProperties: false
      }
    }
  }
];

const MS_INBOX_DIR = path.join(DB_DIR, 'ms_email_inbox');
const PIPE_LABELS = Object.freeze({
  needs: 'Needs',
  talking: 'Talking',
  ship: 'Ship',
  transit: 'Transit',
  checkin: 'Check-in',
  todo: 'To do',
  done: 'Done'
});

function ensureDirs() {
  for (const dir of [DB_DIR, ASK_DIR, SESSIONS_DIR, CURSOR_WORKSPACE]) {
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
    console.error('[ai_ask] load', filePath, e.message);
    return fallback;
  }
}

function saveJson(filePath, data) {
  ensureDirs();
  atomicWriteJsonSync(filePath, data);
}

function isoNow() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadOpenAiKey() {
  const fromEnv = process.env.OPENAI_API_KEY || process.env.OA_OPENAI_API_KEY || '';
  if (fromEnv) return fromEnv;
  try {
    const cfg = loadJson(path.join(ROOT, 'account', 'openai.json'), null);
    if (cfg && (cfg.apiKey || cfg.key)) return String(cfg.apiKey || cfg.key).trim();
  } catch (_) { /* ignore */ }
  return '';
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

function cursorAgentStatus() {
  if (!cursorAgentExists()) {
    return { available: false, loggedIn: false, error: 'cursor-agent binary not found' };
  }
  try {
    const out = execFileSync(CURSOR_AGENT_BIN, ['status'], {
      encoding: 'utf8',
      timeout: 12000,
      env: { ...process.env, HOME: '/root', PATH: `/root/.local/bin:${process.env.PATH || ''}` }
    });
    const text = String(out || '');
    const loggedIn = /logged in as/i.test(text) && !/not logged in|logged out/i.test(text);
    const emailMatch = text.match(/logged in as\s+(\S+)/i);
    return {
      available: true,
      loggedIn,
      email: emailMatch ? emailMatch[1] : null,
      raw: text.trim().slice(0, 300)
    };
  } catch (e) {
    return {
      available: true,
      loggedIn: !!loadCursorApiKey(),
      error: e.message || String(e)
    };
  }
}

function aiProviderStatus() {
  const cursor = cursorAgentStatus();
  const openai = !!loadOpenAiKey();
  const cursorReady = !!(cursor.loggedIn || loadCursorApiKey());
  return {
    aiAvailable: cursorReady || openai,
    provider: cursorReady ? 'cursor' : (openai ? 'openai' : 'none'),
    cursor: {
      binary: CURSOR_AGENT_BIN,
      exists: !!cursor.available,
      loggedIn: !!cursor.loggedIn,
      email: cursor.email || null,
      apiKeyConfigured: !!loadCursorApiKey(),
      error: cursor.error || null
    },
    openaiConfigured: openai
  };
}

function requireAuth(req, res) {
  if (!req.session || !req.session.loggedIn) {
    res.status(401).json({ error: 'Login required' });
    return false;
  }
  return true;
}

function actorOf(req) {
  return (req.session && (req.session.username || req.session.user)) || 'console';
}

function loadIndex() {
  const data = loadJson(INDEX_PATH, []);
  return Array.isArray(data) ? data : [];
}

function saveIndex(rows) {
  saveJson(INDEX_PATH, rows.slice(0, 2000));
}

function sessionPath(id) {
  const safe = String(id || '').replace(/[^\w\-]/g, '');
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

function loadSession(id) {
  return loadJson(sessionPath(id), null);
}

function saveSession(session) {
  if (!session || !session.id) return;
  saveJson(sessionPath(session.id), session);
  const index = loadIndex().filter((r) => r && r.id !== session.id);
  index.unshift({
    id: session.id,
    title: session.title || 'Chat',
    updatedAt: session.updatedAt || isoNow(),
    createdAt: session.createdAt,
    createdBy: session.createdBy,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    archived: !!session.archived,
    archivedAt: session.archivedAt || null
  });
  saveIndex(index);
  // Opportunistic prune (cheap; skip if we pruned recently)
  maybePruneRetention();
}

function setSessionArchived(id, archived) {
  const session = loadSession(id);
  if (!session) return { ok: false, error: 'Session not found' };
  session.archived = !!archived;
  session.archivedAt = archived ? isoNow() : null;
  session.updatedAt = isoNow();
  saveSession(session);
  return { ok: true, session: { id: session.id, archived: session.archived, archivedAt: session.archivedAt } };
}

function deleteSessionFully(id) {
  const safe = String(id || '').replace(/[^\w\-]/g, '');
  if (!safe) return { ok: false, error: 'Invalid id' };
  const full = sessionPath(safe);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (e) {
    return { ok: false, error: e.message || 'delete failed' };
  }
  saveIndex(loadIndex().filter((r) => r && r.id !== safe));
  return { ok: true };
}

function loadLearnedMemory() {
  const data = loadJson(MEMORY_PATH, { items: [] });
  const items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
  return { items };
}

function saveLearnedMemory(store) {
  saveJson(MEMORY_PATH, {
    updatedAt: isoNow(),
    items: Array.isArray(store.items) ? store.items.slice(0, 2000) : []
  });
}

function listActiveMemories(limit = 60) {
  const cutoffNormal = Date.now() - RETENTION_MS;
  const cutoffCrucial = Date.now() - CRUCIAL_RETENTION_MS;
  const items = loadLearnedMemory().items.filter((m) => {
    if (!m || !m.text) return false;
    const t = Date.parse(m.updatedAt || m.at || 0) || 0;
    if (m.crucial) return t >= cutoffCrucial || !t;
    return t >= cutoffNormal || !t;
  });
  // Crucial first, then newest
  items.sort((a, b) => {
    if (!!b.crucial !== !!a.crucial) return b.crucial ? 1 : -1;
    return String(b.updatedAt || b.at || '').localeCompare(String(a.updatedAt || a.at || ''));
  });
  return items.slice(0, Math.max(1, Math.min(200, limit)));
}

function addLearnedMemory(opts = {}) {
  const text = String(opts.text || '').trim().slice(0, 2000);
  if (text.length < 3) return { ok: false, error: 'text required' };
  const store = loadLearnedMemory();
  const item = {
    id: opts.id || newId('mem'),
    at: isoNow(),
    updatedAt: isoNow(),
    kind: String(opts.kind || 'learned').slice(0, 40),
    crucial: !!opts.crucial,
    text,
    source: String(opts.source || 'operator').slice(0, 40),
    sessionId: opts.sessionId || null,
    by: opts.by || 'console'
  };
  // Dedupe near-identical text
  const norm = text.toLowerCase().replace(/\s+/g, ' ');
  store.items = store.items.filter((m) => {
    const other = String(m.text || '').toLowerCase().replace(/\s+/g, ' ');
    return other !== norm;
  });
  store.items.unshift(item);
  saveLearnedMemory(store);
  return { ok: true, item };
}

function deleteLearnedMemory(id) {
  const store = loadLearnedMemory();
  const before = store.items.length;
  store.items = store.items.filter((m) => m && m.id !== id);
  saveLearnedMemory(store);
  return { ok: true, removed: before - store.items.length };
}

function formatMemoryBlock(limit = 40) {
  const items = listActiveMemories(limit);
  if (!items.length) return '(none yet)';
  return items.map((m) => {
    const tag = m.crucial ? 'CRUCIAL' : (m.kind || 'learned');
    return `- [${tag}] ${m.text}`;
  }).join('\n');
}

/** Capture operator intent like "remember that…" into durable memory. */
function maybeCaptureMemoryFromMessage(message, meta = {}) {
  const text = String(message || '').trim();
  const m = text.match(/^(?:please\s+)?(?:remember(?:\s+that)?|note(?:\s+that)?|always|never|we\s+prefer|training\s*:\s*|learn\s*:\s*|save\s+memory\s*:\s*)\s*(.+)$/i);
  if (!m) return null;
  let body = String(m[1] || '').trim();
  // Strip leading "that "
  body = body.replace(/^that\s+/i, '').trim();
  if (body.length < 5) return null;
  const crucial = /crucial|important|always|never|must\b/i.test(text);
  const kind = /training/i.test(text) ? 'training' : (/prefer|always|never/i.test(text) ? 'preference' : 'learned');
  return addLearnedMemory({
    text: body.slice(0, 2000),
    kind,
    crucial,
    source: 'chat',
    sessionId: meta.sessionId || null,
    by: meta.by || 'console'
  });
}

let lastPruneAt = 0;
function maybePruneRetention(force) {
  const now = Date.now();
  if (!force && now - lastPruneAt < 6 * 60 * 60 * 1000) return; // at most every 6h
  lastPruneAt = now;
  try {
    pruneOldSessions();
    pruneOldQuestions();
    pruneOldMemories();
  } catch (e) {
    console.error('[ai_ask] prune', e.message);
  }
}

function pruneOldSessions() {
  const cutoff = Date.now() - RETENTION_MS;
  ensureDirs();
  let index = loadIndex();
  const keep = [];
  for (const row of index) {
    const t = Date.parse(row && (row.updatedAt || row.createdAt) || 0) || 0;
    if (t && t < cutoff) {
      try {
        const full = sessionPath(row.id);
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } catch (_) { /* ignore */ }
    } else {
      keep.push(row);
    }
  }
  // Also sweep orphan session files
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!/^ask-[\w\-]+\.json$/.test(f)) continue;
      const full = path.join(SESSIONS_DIR, f);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (st.mtimeMs < cutoff) {
        const id = f.replace(/\.json$/, '');
        if (!keep.some((r) => r.id === id)) {
          try { fs.unlinkSync(full); } catch (_) { /* ignore */ }
        }
      }
    }
  } catch (_) { /* ignore */ }
  saveIndex(keep);
}

function pruneOldQuestions() {
  if (!fs.existsSync(QUESTIONS_PATH)) return;
  const cutoffIso = new Date(Date.now() - RETENTION_MS).toISOString();
  try {
    const lines = fs.readFileSync(QUESTIONS_PATH, 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter((line) => {
      try {
        const row = JSON.parse(line);
        return !row.at || String(row.at) >= cutoffIso;
      } catch (_) {
        return false;
      }
    });
    if (kept.length !== lines.length) {
      fs.writeFileSync(QUESTIONS_PATH, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
    }
  } catch (e) {
    console.error('[ai_ask] prune questions', e.message);
  }
}

function pruneOldMemories() {
  const cutoffNormal = Date.now() - RETENTION_MS;
  const cutoffCrucial = Date.now() - CRUCIAL_RETENTION_MS;
  const store = loadLearnedMemory();
  store.items = store.items.filter((m) => {
    if (!m) return false;
    const t = Date.parse(m.updatedAt || m.at || 0) || 0;
    if (!t) return true;
    if (m.crucial) return t >= cutoffCrucial;
    return t >= cutoffNormal;
  });
  saveLearnedMemory(store);
}

function appendQuestionLog(entry) {
  ensureDirs();
  try {
    fs.appendFileSync(QUESTIONS_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (e) {
    console.error('[ai_ask] questions log', e.message);
  }
}

function readRecentQuestions(limit = 40) {
  if (!fs.existsSync(QUESTIONS_PATH)) return [];
  try {
    const lines = fs.readFileSync(QUESTIONS_PATH, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(200, limit))).map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean).reverse();
  } catch (_) {
    return [];
  }
}

function serialKey(sn) {
  return String(sn || '').trim().toUpperCase();
}

function findDeviceBySerial(serialNumber) {
  const key = serialKey(serialNumber);
  if (!key) return null;
  const sources = [
    { archived: false, data: loadJson(TRACKING_PATH, []) },
    { archived: true, data: loadJson(ARCHIVED_PATH, []) }
  ];
  for (const src of sources) {
    const list = Array.isArray(src.data) ? src.data : [];
    for (const item of list) {
      const devices = Array.isArray(item && item.devices) ? item.devices : [];
      for (let i = 0; i < devices.length; i += 1) {
        const d = devices[i];
        if (!d) continue;
        const sn = serialKey(d.serialNumber || d.serial || d.SN);
        if (sn === key) {
          return {
            archived: src.archived,
            trackingItem: item,
            deviceIndex: i,
            device: d,
            trackingNumber: item.trackingNumber || item.TrackingNumber || null
          };
        }
      }
    }
  }
  // Supplemental
  try {
    const supp = loadJson(path.join(DB_DIR, 'supplemental_devices.json'), []);
    const hit = (Array.isArray(supp) ? supp : []).find((d) => serialKey(d && d.serialNumber) === key);
    if (hit) return { archived: null, supplemental: true, device: hit };
  } catch (_) { /* ignore */ }
  return null;
}

function repairPipeline(status) {
  const s = String(status || '');
  if (s === 'resolved' || s === 'cannot_resolve') return 'done';
  if (/waiting_case|needs/.test(s) || s === 'open') return 'needs';
  if (/case_created|waiting_approval|rejected|talking/.test(s)) return 'talking';
  if (/ready_to_ship|approved_ship|label/.test(s)) return 'ship';
  if (/shipped|waiting_inbound|transit|in_transit/.test(s)) return 'transit';
  if (/arrived|received|check/.test(s)) return 'checkin';
  if (/todo|bench|restock/.test(s)) return 'todo';
  return 'todo';
}

function slimDevice(d) {
  if (!d) return null;
  return {
    serialNumber: d.serialNumber || d.serial || null,
    model: d.model || d.modelDetails || d.warrantyDeviceName || null,
    sku: d.sku || null,
    orderNumber: d.orderNumberPrimary || d.orderNumber || d.order_number || d.OrderNumber || null,
    cpu: d.cpu || null,
    ram: d.ram || null,
    hd: d.hd || null,
    warrantyStatus: d.warrantyStatus || (d.msWarranty && d.msWarranty.status) || null,
    warrantyExpires: d.warrantyExpiresOn || d.expiresOn || (d.msWarranty && d.msWarranty.expiresOn) || null,
    notes: d.notes ? String(d.notes).slice(0, 400) : null
  };
}

function carrierTrackUrl(tn) {
  const t = String(tn || '').trim();
  if (!t) return null;
  if (/^1Z[A-Z0-9]{16}$/i.test(t) || /^1Z/i.test(t)) {
    return `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}`;
  }
  if (/^\d{12,22}$/.test(t)) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}`;
  }
  return `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}`;
}

function slimLabel(l) {
  if (!l || !(l.id || l.filename)) return null;
  const id = l.id || null;
  const downloadPath = l.downloadPath
    || (id ? `/api/ms-email/labels/${encodeURIComponent(id)}` : null);
  return {
    id,
    filename: l.filename || null,
    downloadPath,
    downloadUrl: downloadPath || null,
    trackingNumber: l.trackingNumber || null,
    trackUrl: carrierTrackUrl(l.trackingNumber),
    orderNumber: l.orderNumber || null,
    serialNumber: l.serialNumber || null,
    carrier: l.carrier || null,
    direction: l.direction || l.kind || l.labelType || null
  };
}

function consoleRepairHref(ticket) {
  if (!ticket || !ticket.id) return 'console:repair';
  const parts = [`ticket=${encodeURIComponent(ticket.id)}`];
  if (ticket.serialNumber) parts.push(`serial=${encodeURIComponent(ticket.serialNumber)}`);
  return `console:repair?${parts.join('&')}`;
}

function buildTicketLinks(t) {
  if (!t) return null;
  const labels = (Array.isArray(t.msShippingLabels) ? t.msShippingLabels : [])
    .map(slimLabel)
    .filter(Boolean);
  const links = {
    repairNeeded: consoleRepairHref(t),
    repairNeededLabel: 'Open in Repair needed',
    inboundTrackUrl: carrierTrackUrl(t.inboundTracking),
    outboundTrackUrl: carrierTrackUrl(t.outboundTracking),
    labelDownloads: labels.map((l) => ({
      filename: l.filename,
      url: l.downloadUrl,
      markdown: l.downloadUrl
        ? `[${l.filename || l.id || 'Label PDF'}](${l.downloadUrl})`
        : null
    })).filter((x) => x.url)
  };
  return links;
}

function slimRepair(t) {
  if (!t) return null;
  const labels = (Array.isArray(t.msShippingLabels) ? t.msShippingLabels : [])
    .map(slimLabel)
    .filter(Boolean);
  const pipe = repairPipeline(t.status);
  return {
    id: t.id,
    serialNumber: t.serialNumber,
    status: t.status,
    pipeline: pipe,
    pipelineLabel: PIPE_LABELS[pipe] || pipe,
    issue: String(t.issue || '').slice(0, 400),
    msCaseId: t.msCaseId || null,
    msOrderNumber: t.msOrderNumber || null,
    msProgram: t.msProgram || null,
    outboundTracking: t.outboundTracking || null,
    inboundTracking: t.inboundTracking || null,
    warrantyExpires: t.warrantyExpires || null,
    msCaseBriefing: t.msCaseBriefing ? String(t.msCaseBriefing).slice(0, 500) : null,
    labelCount: labels.length,
    shippingLabels: labels,
    links: buildTicketLinks(t),
    statusAt: t.statusAt || t.at || null
  };
}

function findRepairTicket(args) {
  const repairs = loadJson(REPAIR_PATH, []);
  const list = Array.isArray(repairs) ? repairs : [];
  let ticket = null;
  if (args.ticketId) {
    ticket = list.find((t) => t && String(t.id) === String(args.ticketId)) || null;
  }
  if (!ticket && args.serialNumber) {
    const key = serialKey(args.serialNumber);
    const open = list.filter((t) => serialKey(t.serialNumber) === key
      && !['resolved', 'cannot_resolve'].includes(String(t.status || '')));
    ticket = open[0] || list.find((t) => serialKey(t.serialNumber) === key) || null;
  }
  if (!ticket && args.caseId) {
    const c = String(args.caseId);
    ticket = list.find((t) => t && String(t.msCaseId || '') === c) || null;
  }
  return ticket;
}

function slimOrder(o) {
  if (!o) return null;
  const items = Array.isArray(o.items)
    ? o.items.slice(0, 6).map((it) => ({
      sku: it.sku || null,
      name: it.name ? String(it.name).slice(0, 120) : null,
      quantity: it.quantity != null ? it.quantity : null
    }))
    : [];
  return {
    orderNumber: o.orderNumber || o.orderKey || null,
    orderId: o.orderId != null ? String(o.orderId) : null,
    orderStatus: o.orderStatus || null,
    orderDate: o.orderDate || null,
    shipDate: o.shipDate || null,
    customerEmail: o.customerEmail || null,
    billToName: (o.billTo && o.billTo.name) || o.billToName || null,
    shipToName: (o.shipTo && o.shipTo.name) || o.shipToName || null,
    shipToCity: (o.shipTo && o.shipTo.city) || null,
    shipToState: (o.shipTo && o.shipTo.state) || null,
    trackingNumber: o.trackingNumber || null,
    accountId: o.accountId || null,
    amountPaid: o.amountPaid != null ? o.amountPaid : (o.orderTotal || null),
    items
  };
}

function toolSystemOverview() {
  const repairs = loadJson(REPAIR_PATH, []);
  const open = (Array.isArray(repairs) ? repairs : []).filter((t) => {
    const s = String(t && t.status || '');
    return s !== 'resolved' && s !== 'cannot_resolve';
  });
  const byPipe = {};
  for (const t of open) {
    const p = repairPipeline(t.status);
    byPipe[p] = (byPipe[p] || 0) + 1;
  }
  const orders = loadJson(ORDERS_CACHE_PATH, { orders: {} });
  const orderCount = orders && orders.orders ? Object.keys(orders.orders).length : 0;
  const wCache = loadJson(WARRANTY_CACHE_PATH, {});
  return {
    openRepairs: open.length,
    repairsByPipeline: byPipe,
    repairsByPipelineLabeled: Object.fromEntries(
      Object.entries(byPipe).map(([k, v]) => [PIPE_LABELS[k] || k, v])
    ),
    consoleLinks: {
      repairNeeded: 'console:repair',
      orders: 'console:orders',
      dashboard: 'console:dashboard'
    },
    ordersInCache: orderCount,
    warrantyCacheEntries: wCache && typeof wCache === 'object' ? Object.keys(wCache).length : 0,
    askSessions: loadIndex().length
  };
}

function toolLookupSerial(args) {
  const sn = String(args.serialNumber || '').trim();
  const found = findDeviceBySerial(sn);
  const repairs = loadJson(REPAIR_PATH, []);
  const key = serialKey(sn);
  const tickets = (Array.isArray(repairs) ? repairs : [])
    .filter((t) => serialKey(t && t.serialNumber) === key)
    .map(slimRepair);
  const cache = loadJson(WARRANTY_CACHE_PATH, {}) || {};
  const warranty = cache[key] || cache[sn] || null;
  return {
    found: !!found,
    archived: found ? found.archived : null,
    supplemental: !!(found && found.supplemental),
    trackingNumber: found ? found.trackingNumber : null,
    device: found ? slimDevice(found.device) : null,
    repairTickets: tickets.slice(0, 8),
    warrantyCached: warranty
      ? {
        deviceName: warranty.deviceName || null,
        status: warranty.status || null,
        expiresOn: warranty.expiresOn || null,
        checkedAt: warranty.checkedAt || null
      }
      : null
  };
}

function toolLookupOrder(args) {
  const orderNumber = String(args.orderNumber || '').trim();
  const data = loadJson(ORDERS_CACHE_PATH, { orders: {} });
  const orders = data.orders || {};
  const matches = [];
  for (const row of Object.values(orders)) {
    if (!row) continue;
    const on = String(row.orderNumber || '').trim();
    const oid = row.orderId != null ? String(row.orderId).trim() : '';
    if (on === orderNumber || oid === orderNumber) matches.push(row);
  }
  matches.sort((a, b) => {
    const score = (o) => (o.trackingNumber ? 4 : 0) + (o.shipDate ? 2 : 0) + (o.orderStatus === 'shipped' ? 1 : 0);
    return score(b) - score(a);
  });
  const order = matches[0] || null;
  const devices = [];
  const seenSn = new Set();
  if (orderNumber) {
    for (const src of [TRACKING_PATH, ARCHIVED_PATH]) {
      const list = loadJson(src, []);
      for (const item of (Array.isArray(list) ? list : [])) {
        for (const d of (item.devices || [])) {
          const on = String(
            d.orderNumberPrimary || d.orderNumber || d.order_number || d.OrderNumber || ''
          ).trim();
          if (on !== orderNumber) continue;
          const sn = String(d.serialNumber || '').trim().toUpperCase();
          if (sn && seenSn.has(sn)) continue;
          if (sn) seenSn.add(sn);
          devices.push(slimDevice(d));
        }
      }
    }
  }
  return {
    found: !!order || devices.length > 0,
    order: slimOrder(order),
    matchingOrders: matches.slice(0, 5).map(slimOrder),
    devices: devices.slice(0, 20),
    consoleLinks: {
      orders: 'console:orders',
      repairNeeded: devices.length ? 'console:repair' : null
    }
  };
}

function toolSearchRepairs(args) {
  const q = String(args.query || '').trim().toLowerCase();
  const pipeline = String(args.pipeline || '').trim().toLowerCase();
  const limit = Math.min(40, Math.max(1, Number(args.limit) || 15));
  const repairs = loadJson(REPAIR_PATH, []);
  let rows = Array.isArray(repairs) ? repairs.slice() : [];
  if (pipeline === 'open') {
    rows = rows.filter((t) => !['resolved', 'cannot_resolve'].includes(String(t.status || '')));
  } else if (pipeline === 'done') {
    rows = rows.filter((t) => ['resolved', 'cannot_resolve'].includes(String(t.status || '')));
  } else if (pipeline) {
    rows = rows.filter((t) => repairPipeline(t.status) === pipeline);
  }
  if (q) {
    rows = rows.filter((t) => {
      const blob = [
        t.serialNumber, t.issue, t.msCaseId, t.msOrderNumber, t.status,
        t.msCaseBriefing, t.outboundTracking, t.inboundTracking
      ].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }
  rows.sort((a, b) => String(b.statusAt || b.at || '').localeCompare(String(a.statusAt || a.at || '')));
  return { count: rows.length, items: rows.slice(0, limit).map(slimRepair) };
}

function toolGetRepair(args) {
  const ticket = findRepairTicket(args);
  if (!ticket) return { found: false };
  return {
    found: true,
    ticket: {
      ...slimRepair(ticket),
      notes: (ticket.notes || []).slice(-8).map((n) => ({
        at: n.at, by: n.by, text: String(n.text || '').slice(0, 400)
      })),
      statusHistory: (ticket.statusHistory || []).slice(-12).map((h) => ({
        at: h.at, status: h.status, note: h.note ? String(h.note).slice(0, 200) : null
      })),
      msTroubleshootingNote: ticket.msTroubleshootingNote
        ? String(ticket.msTroubleshootingNote).slice(0, 800)
        : null,
      msEmailEventCount: Array.isArray(ticket.msEmailEvents) ? ticket.msEmailEvents.length : 0
    }
  };
}

function toolGetShippingLabels(args) {
  const ticket = findRepairTicket(args);
  if (!ticket) return { found: false, labels: [], note: 'No repair ticket for that serial/id' };
  const labels = (Array.isArray(ticket.msShippingLabels) ? ticket.msShippingLabels : [])
    .map(slimLabel)
    .filter(Boolean);
  return {
    found: true,
    ticketId: ticket.id,
    serialNumber: ticket.serialNumber,
    status: ticket.status,
    inboundTracking: ticket.inboundTracking || null,
    outboundTracking: ticket.outboundTracking || null,
    inboundTrackUrl: carrierTrackUrl(ticket.inboundTracking),
    outboundTrackUrl: carrierTrackUrl(ticket.outboundTracking),
    labelCount: labels.length,
    labels,
    downloadMarkdown: labels.map((l) => (
      l.downloadUrl ? `- [${l.filename || l.id}](${l.downloadUrl})` : null
    )).filter(Boolean),
    links: buildTicketLinks(ticket),
    note: labels.length
      ? 'Use downloadUrl paths as markdown links — they open/download the PDF while logged into the console.'
      : 'No label PDFs on file for this ticket yet.'
  };
}

function recordMatchesKeys(record, keys) {
  if (!record || !keys.length) return false;
  const f = record.fields || {};
  const parts = [
    record.subject,
    record.preview,
    record.from,
    ...(f.cases || []),
    ...(f.orders || []),
    ...(f.serials || []),
    ...((record.labels || f.labels || []).map((l) => [
      l && l.serialNumber, l && l.orderNumber, l && l.trackingNumber, l && l.filename
    ].filter(Boolean).join(' ')))
  ].join(' ').toUpperCase();
  return keys.some((k) => k && parts.includes(String(k).toUpperCase()));
}

function toolGetMsEmails(args) {
  const ticket = findRepairTicket(args);
  const limit = Math.min(60, Math.max(5, Number(args.limit) || 25));
  const keys = [];
  if (args.caseId) keys.push(String(args.caseId));
  if (args.serialNumber) keys.push(String(args.serialNumber).toUpperCase());
  if (ticket) {
    if (ticket.msCaseId) keys.push(String(ticket.msCaseId));
    if (ticket.msOrderNumber) keys.push(String(ticket.msOrderNumber));
    if (ticket.serialNumber) keys.push(String(ticket.serialNumber).toUpperCase());
    (ticket.msRelatedCases || []).forEach((c) => keys.push(String(c)));
  }
  const uniqKeys = [...new Set(keys.filter(Boolean))];
  if (!uniqKeys.length) {
    return { found: false, count: 0, messages: [], error: 'Need ticketId, serialNumber, or caseId' };
  }

  let files = [];
  try {
    if (fs.existsSync(MS_INBOX_DIR)) {
      files = fs.readdirSync(MS_INBOX_DIR).filter((f) => /^uid-\d+\.json$/.test(f));
    }
  } catch (e) {
    return { found: false, count: 0, messages: [], error: e.message };
  }

  const hits = [];
  for (const file of files) {
    const rec = loadJson(path.join(MS_INBOX_DIR, file), null);
    if (!recordMatchesKeys(rec, uniqKeys)) continue;
    const f = rec.fields || {};
    const atts = (rec.attachments || []).slice(0, 6).map((a) => ({
      id: a.id || null,
      filename: a.filename || a.name || null,
      downloadPath: a.downloadPath
        || (a.id ? `/api/ms-email/attachments/${encodeURIComponent(a.id)}` : null)
    }));
    const labs = (rec.labels || f.labels || []).slice(0, 6).map(slimLabel).filter(Boolean);
    hits.push({
      uid: rec.uid,
      date: rec.date || null,
      subject: String(rec.subject || '').slice(0, 200),
      from: String(rec.from || '').slice(0, 120),
      preview: String(rec.preview || '').slice(0, 400),
      cases: f.cases || [],
      orders: f.orders || [],
      serials: f.serials || [],
      attachments: atts,
      labels: labs,
      consoleMessage: `/api/ms-email/message/${encodeURIComponent(rec.uid)}`
    });
  }
  hits.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const messages = hits.slice(0, limit);
  return {
    found: messages.length > 0 || !!ticket,
    ticketId: ticket ? ticket.id : null,
    serialNumber: ticket ? ticket.serialNumber : (args.serialNumber || null),
    matchedKeys: uniqKeys,
    count: hits.length,
    shown: messages.length,
    messages,
    links: ticket ? buildTicketLinks(ticket) : {
      repairNeeded: 'console:repair'
    },
    note: hits.length
      ? 'Email summaries from MS inbox store. Open Repair needed → Email history for the full thread UI.'
      : 'No matching MS emails found in the local inbox store for those keys.'
  };
}

function toolLookupTracking(args) {
  const tn = String(args.trackingNumber || '').trim();
  if (!tn) return { found: false, error: 'trackingNumber required' };
  const repairs = loadJson(REPAIR_PATH, []);
  const list = Array.isArray(repairs) ? repairs : [];
  const tickets = list.filter((t) => {
    const blob = [
      t.inboundTracking, t.outboundTracking,
      ...(Array.isArray(t.msShippingLabels) ? t.msShippingLabels.map((l) => l && l.trackingNumber) : [])
    ].join(' ').toUpperCase();
    return blob.includes(tn.toUpperCase());
  }).map(slimRepair);
  const ordersData = loadJson(ORDERS_CACHE_PATH, { orders: {} });
  const orderHits = Object.values(ordersData.orders || {})
    .filter((o) => String(o.trackingNumber || '').toUpperCase().includes(tn.toUpperCase()))
    .slice(0, 8)
    .map(slimOrder);
  return {
    found: tickets.length > 0 || orderHits.length > 0,
    trackingNumber: tn,
    trackUrl: carrierTrackUrl(tn),
    repairTickets: tickets.slice(0, 10),
    orders: orderHits,
    links: {
      track: carrierTrackUrl(tn),
      repairNeeded: tickets[0] ? consoleRepairHref(tickets[0]) : 'console:repair'
    }
  };
}

function toolWarrantyCached(args) {
  const sn = String(args.serialNumber || '').trim();
  const key = serialKey(sn);
  const cache = loadJson(WARRANTY_CACHE_PATH, {}) || {};
  const warranty = cache[key] || cache[sn] || null;
  return { found: !!warranty, serialNumber: sn, warranty: warranty || null };
}

function runWarrantyCheck(serialNumber) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(WARRANTY_SCRIPT)) {
      reject(new Error('Warranty script missing'));
      return;
    }
    execFile(
      'python3',
      [WARRANTY_SCRIPT, '--serial', serialNumber, '--json', '--sleep-extra', '0'],
      { cwd: ROOT, timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(error.killed ? 'Warranty lookup timed out' : error.message));
          return;
        }
        const line = String(stdout || '')
          .split('\n')
          .reverse()
          .find((l) => l.includes(RESULT_MARKER));
        if (!line) {
          reject(new Error(`No warranty result. ${String(stderr || '').slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length).trim());
          resolve(Array.isArray(parsed) ? parsed[0] || null : parsed);
        } catch (e) {
          reject(new Error(`Parse warranty failed: ${e.message}`));
        }
      }
    );
  });
}

async function toolRefreshWarranty(args) {
  const sn = String(args.serialNumber || '').trim();
  if (!sn) return { ok: false, error: 'serialNumber required' };
  const result = await runWarrantyCheck(sn);
  if (!result) return { ok: false, error: 'No result' };
  if (result.status === 'ERROR') {
    return { ok: false, error: result.message || 'Microsoft warranty lookup failed', warranty: result };
  }
  const cache = loadJson(WARRANTY_CACHE_PATH, {}) || {};
  const key = serialKey(sn);
  cache[key] = { ...result, checkedAt: isoNow() };
  saveJson(WARRANTY_CACHE_PATH, cache);
  return {
    ok: true,
    serialNumber: sn,
    warranty: {
      deviceName: result.deviceName || null,
      status: result.status || null,
      expiresOn: result.expiresOn || null
    },
    note: 'Warranty cache updated. Device field fill may also run via warranty save hooks.'
  };
}

function toolUpdateRepairTicket(args) {
  const api = getWarrantyRepairApi();
  if (typeof api.updateRepairTicketFields !== 'function') {
    return { ok: false, error: 'updateRepairTicketFields not available' };
  }
  return api.updateRepairTicketFields({
    serialNumber: args.serialNumber,
    ticketId: args.ticketId,
    msOrderNumber: args.msOrderNumber,
    msCaseId: args.msCaseId,
    msProgram: args.msProgram,
    status: args.status,
    msDeviceModel: args.msDeviceModel,
    note: args.note,
    by: 'ai_ask'
  });
}

function toolApplyMsOrderUpdates(args) {
  const api = getWarrantyRepairApi();
  if (typeof api.applyMsOrderUpdates !== 'function') {
    return { ok: false, error: 'applyMsOrderUpdates not available' };
  }
  const updates = Array.isArray(args.updates) ? args.updates : [];
  return api.applyMsOrderUpdates(updates, {
    by: 'ai_ask',
    msCaseId: args.msCaseId,
    msProgram: args.msProgram || 'same_unit_repair',
    status: args.status || 'ms_approved_ship_same',
    note: args.note || null,
    programLabel: /advanced/i.test(String(args.msProgram || '')) ? 'AE' : 'SUR'
  });
}

function orderSearchTokens(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const tokens = new Set();
  tokens.add(q.toLowerCase());
  for (const id of extractOrdersFromText(q)) tokens.add(String(id).toLowerCase());
  for (const m of q.matchAll(/\b(\d{7,12})\b/g)) tokens.add(m[1]);
  // Drop huge noisy full-sentence tokens that will never match a field blob
  return [...tokens]
    .map((t) => String(t || '').trim().toLowerCase())
    .filter((t) => t && (t.length <= 40 || /^\d{7,12}$/.test(t) || /^[a-z0-9\-]{5,20}$/i.test(t)));
}

function toolSearchOrders(args) {
  const tokens = orderSearchTokens(args.query);
  const limit = Math.min(30, Math.max(1, Number(args.limit) || 12));
  const data = loadJson(ORDERS_CACHE_PATH, { orders: {} });
  const rows = Object.values(data.orders || {});
  const scored = [];
  for (const o of rows) {
    if (!o) continue;
    const fields = {
      orderNumber: String(o.orderNumber || '').toLowerCase(),
      orderId: o.orderId != null ? String(o.orderId).toLowerCase() : '',
      email: String(o.customerEmail || '').toLowerCase(),
      tracking: String(o.trackingNumber || '').toLowerCase(),
      bill: String((o.billTo && o.billTo.name) || '').toLowerCase(),
      ship: String((o.shipTo && o.shipTo.name) || '').toLowerCase(),
      status: String(o.orderStatus || '').toLowerCase()
    };
    const blob = Object.values(fields).join(' ');
    let score = 0;
    for (const t of tokens) {
      if (!t) continue;
      if (fields.orderNumber === t || fields.orderId === t) score += 100;
      else if (fields.orderNumber.includes(t) || fields.orderId.includes(t)) score += 40;
      else if (fields.tracking === t || fields.tracking.includes(t)) score += 30;
      else if (blob.includes(t)) score += 10;
    }
    if (score > 0) scored.push({ score, o });
  }
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, limit).map((x) => slimOrder(x.o));
  return {
    count: hits.length,
    queryTokens: tokens.slice(0, 12),
    items: hits
  };
}

function toolChangelog(args) {
  const limit = Math.min(30, Math.max(1, Number(args.limit) || 10));
  const items = loadJson(CHANGELOG_PATH, []);
  return {
    items: (Array.isArray(items) ? items : []).slice(0, limit).map((e) => ({
      at: e.at,
      title: e.title,
      summary: e.summary,
      major: !!e.major,
      href: e.href || null
    }))
  };
}

function toolAskInsights(args) {
  const limit = Math.min(80, Math.max(10, Number(args.limit) || 40));
  const rows = readRecentQuestions(limit);
  const themes = {};
  for (const r of rows) {
    const text = String(r.question || '').toLowerCase();
    const keys = [];
    if (/warrant|expir/.test(text)) keys.push('warranty');
    if (/repair|ms |microsoft|case|label/.test(text)) keys.push('repair_ms');
    if (/order|shipstation|ship/.test(text)) keys.push('orders');
    if (/serial|sn |device/.test(text)) keys.push('devices');
    if (/how many|count|overview|stats/.test(text)) keys.push('stats');
    if (!keys.length) keys.push('other');
    for (const k of keys) themes[k] = (themes[k] || 0) + 1;
  }
  return {
    scanned: rows.length,
    themes,
    recent: rows.slice(0, 15).map((r) => ({
      at: r.at,
      by: r.by,
      question: String(r.question || '').slice(0, 200),
      tools: r.tools || []
    }))
  };
}

async function executeTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'system_overview': return toolSystemOverview();
    case 'lookup_serial': return toolLookupSerial(a);
    case 'lookup_order': return toolLookupOrder(a);
    case 'search_repairs': return toolSearchRepairs(a);
    case 'get_repair_ticket': return toolGetRepair(a);
    case 'get_shipping_labels': return toolGetShippingLabels(a);
    case 'get_ms_emails': return toolGetMsEmails(a);
    case 'lookup_tracking': return toolLookupTracking(a);
    case 'get_warranty_cached': return toolWarrantyCached(a);
    case 'refresh_warranty': return toolRefreshWarranty(a);
    case 'update_repair_ticket': return toolUpdateRepairTicket(a);
    case 'apply_ms_order_updates': return toolApplyMsOrderUpdates(a);
    case 'search_orders': return toolSearchOrders(a);
    case 'get_changelog': return toolChangelog(a);
    case 'list_ask_insights': return toolAskInsights(a);
    default:
      return { error: `Unknown or disabled tool: ${name}` };
  }
}

function extractSerialsFromText(text) {
  const serials = new Set();
  const snRe = /\b((?:0F|OF|0B|OB|0C|OC|0D|OD|0E|OE|BK)[0-9A-Z]{10,14}|[0-9]{11,12})\b/gi;
  let m;
  while ((m = snRe.exec(String(text || '')))) {
    const sn = String(m[1]).toUpperCase().replace(/^OF/, '0F').replace(/^OB/, '0B');
    if (sn.length >= 11) serials.add(sn);
  }
  return serials;
}

/** ShipStation orderNumber, ShipStation orderId, and MS-style 20xxxxxxxx. */
function extractOrdersFromText(text) {
  const set = new Set();
  const raw = String(text || '');
  let m;
  const labeled = /\border(?:\s*(?:number|no\.?|#))?\s*[#:]?\s*([A-Za-z0-9\-]{5,20})\b/gi;
  while ((m = labeled.exec(raw))) {
    const v = String(m[1] || '').trim();
    if (/^\d{6,14}$/.test(v) || /^[A-Za-z0-9\-]{6,20}$/.test(v)) set.add(v);
  }
  const ms = /\b(20\d{8})\b/g;
  while ((m = ms.exec(raw))) set.add(m[1]);
  // Bare numeric IDs when the question is about an order / ShipStation
  if (/\b(order|shipstation|\bss\b)\b/i.test(raw)) {
    const bare = /\b(\d{7,12})\b/g;
    while ((m = bare.exec(raw))) {
      const n = m[1];
      // Skip compact dates like 20260803
      if (/^(19|20)\d{6}$/.test(n)) continue;
      set.add(n);
    }
  }
  return set;
}

function extractTrackingFromText(text) {
  const set = new Set();
  const re = /\b(1Z[A-Z0-9]{16})\b/gi;
  let m;
  while ((m = re.exec(String(text || '')))) set.add(String(m[1]).toUpperCase());
  return set;
}

/**
 * Pull Serial Number + Order number (+ optional Device model) blocks from MS emails.
 */
function extractMsSerialOrderPairs(text) {
  const raw = String(text || '');
  const pairs = [];
  const seen = new Set();

  const blockRe = /(?:Device model:\s*([^\r\n]+)\s*)?Serial Number:\s*([0-9A-Za-z]+)\s*Order number:\s*(\d{7,12})/gi;
  let m;
  while ((m = blockRe.exec(raw))) {
    const sn = String(m[2] || '').trim().toUpperCase().replace(/^OF/, '0F');
    const order = String(m[3] || '').trim();
    const model = String(m[1] || '').trim() || null;
    const key = `${sn}|${order}`;
    if (!sn || !order || seen.has(key)) continue;
    seen.add(key);
    pairs.push({ serialNumber: sn, msOrderNumber: order, msDeviceModel: model });
  }

  // Fallback: nearby Serial … Order lines if labels vary
  if (!pairs.length) {
    const loose = /Serial(?:\s*Number)?\s*[:#]?\s*([0-9A-Za-z]{11,18})[\s\S]{0,120}?Order(?:\s*(?:number|no\.?|#))?\s*[:#]?\s*(\d{7,12})/gi;
    while ((m = loose.exec(raw))) {
      const sn = String(m[1] || '').trim().toUpperCase().replace(/^OF/, '0F');
      const order = String(m[2] || '').trim();
      const key = `${sn}|${order}`;
      if (!sn || !order || seen.has(key)) continue;
      seen.add(key);
      pairs.push({ serialNumber: sn, msOrderNumber: order, msDeviceModel: null });
    }
  }

  return pairs;
}

function detectMsProgramFromText(text) {
  const t = String(text || '');
  if (/advanced\s*exchange|\bAE\b/i.test(t)) return 'advanced_exchange';
  if (/same\s*unit\s*repair|\bSUR\b/i.test(t)) return 'same_unit_repair';
  return null;
}

function wantsRepairTicketWrite(text) {
  const low = String(text || '').toLowerCase();
  if (/update (the )?(case|ticket|tickets|orders?|console)|please update|apply (the )?(update|orders?|sur)|set (the )?(ms )?order|write (the )?order|save (the )?order|put (the )?order|fill (in )?(the )?order/.test(low)) {
    return true;
  }
  // MS SUR/AE email paste + clear ask to act
  if (extractMsSerialOrderPairs(text).length && /(please|update|apply|set|save|write|put)\b/.test(low)) {
    return true;
  }
  if (/new update from microsoft/.test(low) && extractMsSerialOrderPairs(text).length) {
    return true;
  }
  return false;
}

async function gatherContextForQuestion(userText, history) {
  const text = String(userText || '');
  const low = text.toLowerCase();
  const toolsUsed = [];
  const bundles = [];

  const histBlob = (history || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-8)
    .map((m) => String(m.content || ''))
    .join('\n');

  const serials = extractSerialsFromText(text);
  const followUp = /\b(that|this|above|the sn|the serial|shipping label|label pdf|pdf|emails?|thread|trace|what happened)\b/i.test(text)
    || (/label|pdf|download|email|mail|thread|track/i.test(low) && !serials.size);
  if (!serials.size && followUp) {
    for (const sn of extractSerialsFromText(histBlob)) serials.add(sn);
  }

  const orders = extractOrdersFromText(text);
  if (!orders.size && followUp) {
    for (const id of extractOrdersFromText(histBlob)) orders.add(id);
  }

  const cases = new Set();
  const caseRe = /\b(2[0-9]{15})\b/g;
  let m;
  while ((m = caseRe.exec(text))) cases.add(m[1]);
  if (!cases.size && followUp) {
    while ((m = caseRe.exec(histBlob))) cases.add(m[1]);
  }

  const trackings = extractTrackingFromText(text);
  if (!trackings.size && followUp) {
    for (const tn of extractTrackingFromText(histBlob)) trackings.add(tn);
  }

  const wantsOverview = /how many|overview|stats|summary|open repair|by stage|pipeline/.test(low);
  const wantsRepairs = /repair|ms |microsoft|label|ticket|warranty claim|case|trace|what happened/.test(low)
    || cases.size > 0;
  const wantsOrders = /order|shipstation|shipment/.test(low) || orders.size > 0;
  const wantsWarranty = /warrant|expir|refresh warranty|update warranty|check warranty/.test(low);
  const wantsInsights = /people ask|what.*(asked|asking)|insights|recommendation/.test(low);
  const wantsChangelog = /changelog|history|what changed|recent change/.test(low);
  const wantsRefresh = /refresh warranty|update warranty|live warranty|recheck warranty|pull warranty/.test(low);
  const wantsLabels = /label|pdf|download.*ship|shipping label|print label/.test(low);
  const wantsEmails = /email|e-mail|mail thread|inbox|ms mail|what.*(said|wrote)|track emails/.test(low);
  const wantsTrace = /full trace|what happened|timeline|history for|status history/.test(low);
  const wantsTicketWrite = SAFE_WRITE_TOOLS.has('apply_ms_order_updates') && wantsRepairTicketWrite(text);
  const msOrderPairs = extractMsSerialOrderPairs(text);
  const msProgramGuess = detectMsProgramFromText(text) || 'same_unit_repair';
  const caseFromText = [...cases][0] || null;
  for (const pair of msOrderPairs) {
    if (pair && pair.serialNumber) serials.add(pair.serialNumber);
    if (pair && pair.msOrderNumber) orders.add(pair.msOrderNumber);
  }

  // Apply MS SUR/AE order numbers before answering when the operator asked to update.
  if (wantsTicketWrite && msOrderPairs.length && SAFE_WRITE_TOOLS.has('apply_ms_order_updates')) {
    toolsUsed.push('apply_ms_order_updates');
    const writeResult = await executeTool('apply_ms_order_updates', {
      updates: msOrderPairs,
      msCaseId: caseFromText || undefined,
      msProgram: msProgramGuess,
      status: msProgramGuess === 'advanced_exchange' ? 'ms_approved_ship_ae' : 'ms_approved_ship_same',
      note: `AI Ask: applied MS ${msProgramGuess === 'advanced_exchange' ? 'AE' : 'SUR'} order(s) from operator paste`
    });
    bundles.push({
      tool: 'apply_ms_order_updates',
      args: { updates: msOrderPairs, msProgram: msProgramGuess },
      result: writeResult
    });
    // Re-read tickets so the answer shows post-write state
    for (const pair of msOrderPairs.slice(0, 10)) {
      toolsUsed.push('get_repair_ticket');
      bundles.push({
        tool: 'get_repair_ticket',
        args: { serialNumber: pair.serialNumber },
        result: await executeTool('get_repair_ticket', { serialNumber: pair.serialNumber })
      });
    }
  }

  if (wantsOverview || (!serials.size && !orders.size && !cases.size && /repair|open/.test(low))) {
    toolsUsed.push('system_overview');
    bundles.push({ tool: 'system_overview', result: await executeTool('system_overview', {}) });
  }

  for (const sn of [...serials].slice(0, 6)) {
    toolsUsed.push('lookup_serial');
    bundles.push({
      tool: 'lookup_serial',
      args: { serialNumber: sn },
      result: await executeTool('lookup_serial', { serialNumber: sn })
    });
    toolsUsed.push('get_repair_ticket');
    bundles.push({
      tool: 'get_repair_ticket',
      args: { serialNumber: sn },
      result: await executeTool('get_repair_ticket', { serialNumber: sn })
    });
    if (wantsLabels || wantsTrace || /ship|label|pdf|download/.test(low) || followUp) {
      toolsUsed.push('get_shipping_labels');
      bundles.push({
        tool: 'get_shipping_labels',
        args: { serialNumber: sn },
        result: await executeTool('get_shipping_labels', { serialNumber: sn })
      });
    }
    if (wantsEmails || wantsTrace) {
      toolsUsed.push('get_ms_emails');
      bundles.push({
        tool: 'get_ms_emails',
        args: { serialNumber: sn, limit: 30 },
        result: await executeTool('get_ms_emails', { serialNumber: sn, limit: 30 })
      });
    }
    if (wantsWarranty && !wantsRefresh) {
      toolsUsed.push('get_warranty_cached');
      bundles.push({
        tool: 'get_warranty_cached',
        args: { serialNumber: sn },
        result: await executeTool('get_warranty_cached', { serialNumber: sn })
      });
    }
    if (wantsRefresh && SAFE_WRITE_TOOLS.has('refresh_warranty')) {
      toolsUsed.push('refresh_warranty');
      bundles.push({
        tool: 'refresh_warranty',
        args: { serialNumber: sn },
        result: await executeTool('refresh_warranty', { serialNumber: sn })
      });
    }
  }

  for (const orderNumber of [...orders].slice(0, 5)) {
    toolsUsed.push('lookup_order');
    const orderResult = await executeTool('lookup_order', { orderNumber });
    bundles.push({
      tool: 'lookup_order',
      args: { orderNumber },
      result: orderResult
    });
    // Follow linked devices / tracking so "what happened to my order" has a full picture
    for (const d of (orderResult && orderResult.devices) || []) {
      const sn = String(d && d.serialNumber || '').trim();
      if (!sn || serials.has(sn.toUpperCase())) continue;
      serials.add(sn.toUpperCase());
      toolsUsed.push('lookup_serial');
      bundles.push({
        tool: 'lookup_serial',
        args: { serialNumber: sn },
        result: await executeTool('lookup_serial', { serialNumber: sn })
      });
      toolsUsed.push('get_repair_ticket');
      bundles.push({
        tool: 'get_repair_ticket',
        args: { serialNumber: sn },
        result: await executeTool('get_repair_ticket', { serialNumber: sn })
      });
    }
    const tn = orderResult && orderResult.order && orderResult.order.trackingNumber;
    if (tn && !trackings.has(String(tn).toUpperCase())) {
      toolsUsed.push('lookup_tracking');
      bundles.push({
        tool: 'lookup_tracking',
        args: { trackingNumber: tn },
        result: await executeTool('lookup_tracking', { trackingNumber: tn })
      });
    }
  }

  for (const tn of [...trackings].slice(0, 5)) {
    toolsUsed.push('lookup_tracking');
    bundles.push({
      tool: 'lookup_tracking',
      args: { trackingNumber: tn },
      result: await executeTool('lookup_tracking', { trackingNumber: tn })
    });
  }

  if ((wantsRepairs || cases.size) && !serials.size) {
    const query = [...cases][0] || text.slice(0, 80);
    toolsUsed.push('search_repairs');
    bundles.push({
      tool: 'search_repairs',
      args: { query, limit: 15 },
      result: await executeTool('search_repairs', {
        query,
        pipeline: /done|resolved/.test(low) ? 'done' : (/open|stage|how many/.test(low) ? 'open' : undefined),
        limit: 15
      })
    });
    if (wantsEmails && [...cases][0]) {
      toolsUsed.push('get_ms_emails');
      bundles.push({
        tool: 'get_ms_emails',
        args: { caseId: [...cases][0], limit: 25 },
        result: await executeTool('get_ms_emails', { caseId: [...cases][0], limit: 25 })
      });
    }
  }

  if (wantsOrders && !orders.size) {
    const tokens = orderSearchTokens(text);
    const q = tokens.find((t) => /^\d{7,12}$/.test(t))
      || tokens.sort((a, b) => b.length - a.length)[0]
      || text.replace(/order(s)?/ig, '').trim().slice(0, 60)
      || '20';
    toolsUsed.push('search_orders');
    bundles.push({
      tool: 'search_orders',
      args: { query: q },
      result: await executeTool('search_orders', { query: q, limit: 12 })
    });
  }

  if (wantsInsights) {
    toolsUsed.push('list_ask_insights');
    bundles.push({ tool: 'list_ask_insights', result: await executeTool('list_ask_insights', { limit: 40 }) });
  }

  if (wantsChangelog) {
    toolsUsed.push('get_changelog');
    bundles.push({ tool: 'get_changelog', result: await executeTool('get_changelog', { limit: 10 }) });
  }

  if (!bundles.length) {
    toolsUsed.push('system_overview');
    bundles.push({ tool: 'system_overview', result: await executeTool('system_overview', {}) });
  }

  return { toolsUsed: [...new Set(toolsUsed)], bundles };
}

function formatLocalAnswer(bundles) {
  const lines = ['Here is what I found in Tracking (AI wording unavailable — raw data):', ''];
  for (const b of bundles) {
    lines.push(`### ${b.tool}${b.args ? ` ${JSON.stringify(b.args)}` : ''}`);
    lines.push('```');
    lines.push(JSON.stringify(b.result, null, 2).slice(0, 3500));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n').slice(0, 12000);
}

function buildCursorPrompt(systemPrompt, history, userText, contextBundles) {
  const hist = (history || [])
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls))
    .slice(-8)
    .map((m) => `${m.role.toUpperCase()}: ${String(m.content || '').slice(0, 1500)}`)
    .join('\n\n');
  const ctx = contextBundles.map((b) => (
    `TOOL ${b.tool}${b.args ? ` ARGS=${JSON.stringify(b.args)}` : ''}\n${JSON.stringify(b.result).slice(0, 12000)}`
  )).join('\n\n---\n\n');

  return [
    systemPrompt,
    '',
    'You are running via Cursor Agent on the OrderAssist server.',
    'Use ONLY the TOOL RESULTS below as facts. Do not invent data.',
    'Honor LEARNED MEMORY / TRAINING preferences when they do not conflict with live tool facts.',
    'If apply_ms_order_updates / update_repair_ticket results show ok:true, those console writes already happened — report them as done.',
    'Do not tell the operator to switch to Agent mode or update tickets manually when write tool results already succeeded.',
    'ALWAYS include clickable markdown links when tool results provide them:',
    '- Label PDFs: [filename](/api/ms-email/labels/ID)',
    '- UPS/carrier: [tracking](https://www.ups.com/track?tracknum=...)',
    '- Console pages: [Open in Repair needed](console:repair?ticket=ID&serial=SN)',
    'Never say you cannot show a PDF if downloadUrl / downloadMarkdown is present — paste those links.',
    'Never say you cannot track emails if get_ms_emails returned messages — summarize them and link Repair needed.',
    'Answer the operator clearly and concisely.',
    '',
    '=== LEARNED MEMORY / TRAINING (durable across chats, ~6 months; crucial longer) ===',
    formatMemoryBlock(40),
    '',
    '=== TOOL RESULTS ===',
    ctx || '(none)',
    '',
    hist ? `=== RECENT CHAT ===\n${hist}\n` : '',
    '=== CURRENT QUESTION ===',
    userText
  ].join('\n');
}

function cursorAgentComplete(prompt) {
  return new Promise((resolve) => {
    if (!cursorAgentExists()) {
      resolve({ error: 'cursor-agent not installed' });
      return;
    }
    ensureDirs();
    const promptPath = path.join(ASK_DIR, `prompt-${process.pid}-${Date.now()}.txt`);
    try {
      fs.writeFileSync(promptPath, String(prompt || '').slice(0, 100000), 'utf8');
    } catch (e) {
      resolve({ error: `Could not write prompt file: ${e.message}` });
      return;
    }

    const apiKey = loadCursorApiKey();
    const promptText = fs.readFileSync(promptPath, 'utf8');
    // stream-json is reliable with login auth; plain text mode often hangs on this host.
    const args = [
      '-p',
      '--mode', 'ask',
      '--output-format', 'stream-json',
      '--trust',
      '--sandbox', 'disabled',
      '--workspace', CURSOR_WORKSPACE,
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
        if (text) {
          resolve({ text, provider: 'cursor' });
          return;
        }
        const errBits = [
          error && error.killed ? 'Cursor Agent timed out' : null,
          error && error.message,
          String(stderr || '').slice(0, 400),
          raw ? `raw:${raw.slice(0, 200)}` : null
        ].filter(Boolean).join(' · ');
        resolve({ error: errBits || 'Cursor Agent returned empty output' });
      }
    );
  });
}

function openaiComplete(messages) {
  const apiKey = loadOpenAiKey();
  if (!apiKey) return Promise.resolve({ error: 'OpenAI API key not configured' });

  const payload = JSON.stringify({
    model: process.env.OA_OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    messages
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.error) {
            resolve({ error: data.error.message || 'OpenAI error' });
            return;
          }
          const content = data.choices && data.choices[0]
            && data.choices[0].message && data.choices[0].message.content;
          resolve({ text: String(content || '').trim(), provider: 'openai' });
        } catch (e) {
          resolve({ error: e.message || 'parse failed' });
        }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(60000, () => {
      req.destroy();
      resolve({ error: 'OpenAI timeout' });
    });
    req.write(payload);
    req.end();
  });
}

const SYSTEM_PROMPT = [
  'You are AI Ask for the OrderAssist Tracking Console (warehouse / Microsoft Surface warranty ops).',
  'Answer using the provided tool results — do not invent serials, cases, orders, tracking numbers, or warranty dates.',
  'Honor LEARNED MEMORY / TRAINING notes from operators (preferences, corrections, “always/never” rules).',
  'Default stance: prefer cached warranty unless the operator asked to refresh live.',
  'SAFE WRITES are enabled for: refresh_warranty, update_repair_ticket, apply_ms_order_updates.',
  'When TOOL RESULTS include apply_ms_order_updates or update_repair_ticket with ok:true, report what was WRITTEN (do not say you are read-only or ask the operator to do it manually).',
  'If the operator pasted an MS SUR/AE email and asked to update the case, confirm each serial → MS order # / status that was saved.',
  'Do not claim you can send email to Microsoft or delete tickets — those permissions are not enabled.',
  'Be concise and practical. Use short markdown when helpful (bullets, bold labels, tables).',
  'ALWAYS add internal links from tool results: Repair needed (console:repair?ticket=…), label PDF download paths (/api/ms-email/labels/…), and carrier track URLs.',
  'When shipping labels exist, include a markdown download link for each PDF — do not only tell the user to open Repair needed.',
  'When MS emails exist, summarize the thread (newest first) and link console:repair for the full UI.',
  'If data is missing, say what was checked and still link the relevant console page.',
  'When listing multiple devices/tickets, keep lists short.'
].join(' ');

function collectLinksFooter(bundles) {
  const lines = [];
  const seen = new Set();
  const push = (line) => {
    if (!line || seen.has(line)) return;
    seen.add(line);
    lines.push(line);
  };
  for (const b of bundles || []) {
    const r = b && b.result;
    if (!r) continue;
    const links = r.links || (r.ticket && r.ticket.links) || null;
    if (links) {
      if (links.repairNeeded) {
        push(`- [Open in Repair needed](${links.repairNeeded})`);
      }
      if (links.inboundTrackUrl) {
        push(`- [Track inbound ${r.inboundTracking || r.ticket && r.ticket.inboundTracking || ''}](${links.inboundTrackUrl})`.replace(/\s+/g, ' ').trim());
      }
      if (links.outboundTrackUrl) {
        push(`- [Track outbound ${r.outboundTracking || r.ticket && r.ticket.outboundTracking || ''}](${links.outboundTrackUrl})`.replace(/\s+/g, ' ').trim());
      }
      (links.labelDownloads || []).forEach((l) => {
        if (l && l.url) push(`- [Download ${l.filename || 'label PDF'}](${l.url})`);
      });
    }
    (r.downloadMarkdown || []).forEach((md) => push(md.startsWith('-') ? md : `- ${md}`));
    (r.labels || []).forEach((l) => {
      if (l && l.downloadUrl) push(`- [Download ${l.filename || l.id}](${l.downloadUrl})`);
    });
    if (r.trackUrl && r.trackingNumber) {
      push(`- [Track ${r.trackingNumber}](${r.trackUrl})`);
    }
    if (r.consoleLinks) {
      if (r.consoleLinks.repairNeeded) push(`- [Repair needed](${r.consoleLinks.repairNeeded})`);
      if (r.consoleLinks.orders) push(`- [Orders](${r.consoleLinks.orders})`);
      if (r.consoleLinks.dashboard) push(`- [Dashboard](${r.consoleLinks.dashboard})`);
    }
  }
  return lines.slice(0, 20);
}

function ensureAnswerHasLinks(text, bundles) {
  const body = String(text || '').trim();
  const footer = collectLinksFooter(bundles);
  if (!footer.length) return body;
  const hasAny = footer.some((line) => {
    const m = line.match(/\(([^)]+)\)/);
    return m && body.includes(m[1]);
  });
  if (hasAny) return body;
  return `${body}\n\n### Links\n${footer.join('\n')}`;
}

async function runAssistantTurn(session, userText, by) {
  if (!Array.isArray(session.messages)) session.messages = [];
  if (!Array.isArray(session.toolTrace)) session.toolTrace = [];

  session.messages.push({
    role: 'user',
    content: String(userText || '').slice(0, 8000),
    at: isoNow(),
    by
  });

  const memCapture = maybeCaptureMemoryFromMessage(userText, {
    sessionId: session.id,
    by
  });
  if (memCapture && memCapture.ok) {
    session.toolTrace.push({
      at: isoNow(),
      name: 'learned_memory_saved',
      args: { id: memCapture.item.id, crucial: !!memCapture.item.crucial },
      resultPreview: memCapture.item.text
    });
  }

  const gathered = await gatherContextForQuestion(userText, session.messages);
  for (const b of gathered.bundles) {
    session.toolTrace.push({
      at: isoNow(),
      name: b.tool,
      args: b.args || {},
      resultPreview: JSON.stringify(b.result).slice(0, 1500)
    });
  }

  const providerInfo = aiProviderStatus();
  let finalText = '';
  let provider = 'none';

  if (providerInfo.provider === 'cursor' || cursorAgentExists()) {
    const prompt = buildCursorPrompt(SYSTEM_PROMPT, session.messages, userText, gathered.bundles);
    const cursorResult = await cursorAgentComplete(prompt);
    if (cursorResult.text) {
      finalText = cursorResult.text;
      provider = 'cursor';
    } else if (cursorResult.error) {
      session.toolTrace.push({
        at: isoNow(),
        name: 'cursor_agent',
        args: {},
        resultPreview: cursorResult.error
      });
    }
  }

  if (!finalText && loadOpenAiKey()) {
    const contextBlock = gathered.bundles.map((b) => (
      `${b.tool}${b.args ? ` ${JSON.stringify(b.args)}` : ''}: ${JSON.stringify(b.result).slice(0, 5000)}`
    )).join('\n\n');
    const messages = [
      { role: 'system', content: `${SYSTEM_PROMPT}\n\nLEARNED MEMORY:\n${formatMemoryBlock(40)}` },
      ...session.messages
        .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls))
        .slice(-10)
        .map((m) => ({ role: m.role, content: String(m.content || '') })),
      {
        role: 'user',
        content: `TOOL RESULTS:\n${contextBlock}\n\nAnswer the latest operator question using only these facts (and learned memory preferences).`
      }
    ];
    const result = await openaiComplete(messages);
    if (result.text) {
      finalText = result.text;
      provider = 'openai';
    } else if (result.error) {
      session.toolTrace.push({
        at: isoNow(),
        name: 'openai',
        args: {},
        resultPreview: result.error
      });
    }
  }

  if (!finalText) {
    finalText = formatLocalAnswer(gathered.bundles);
    if (providerInfo.provider === 'none') {
      finalText += '\n\n_Note: Cursor Agent login or CURSOR_API_KEY / openai.json needed for full AI wording._';
    } else {
      finalText += '\n\n_Note: Cursor Agent did not return a reply (network/timeout). Showing raw tool results._';
    }
    provider = 'local';
  }

  finalText = ensureAnswerHasLinks(finalText, gathered.bundles);

  session.messages.push({
    role: 'assistant',
    content: finalText,
    at: isoNow(),
    provider
  });

  if (!session.title || session.title === 'New chat') {
    session.title = String(userText).replace(/\s+/g, ' ').trim().slice(0, 60) || 'Chat';
  }
  session.updatedAt = isoNow();
  saveSession(session);

  appendQuestionLog({
    at: isoNow(),
    sessionId: session.id,
    by,
    question: String(userText).slice(0, 1000),
    tools: gathered.toolsUsed,
    provider,
    answerPreview: finalText.slice(0, 500)
  });

  return {
    ok: true,
    sessionId: session.id,
    reply: finalText,
    toolsUsed: gathered.toolsUsed,
    provider,
    title: session.title,
    memorySaved: !!(memCapture && memCapture.ok),
    memoryItem: (memCapture && memCapture.ok) ? memCapture.item : null
  };
}

function publicMessages(session) {
  return (session.messages || [])
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls))
    .map((m) => ({
      role: m.role,
      content: m.content,
      at: m.at,
      by: m.by || null
    }));
}

function setupConsoleAiAsk(app) {
  ensureDirs();
  maybePruneRetention(false);

  app.get('/api/console/ai-ask/status', (req, res) => {
    if (!requireAuth(req, res)) return;
    const status = aiProviderStatus();
    res.json({
      ok: true,
      aiAvailable: status.aiAvailable,
      provider: status.provider,
      cursor: status.cursor,
      openaiConfigured: status.openaiConfigured,
      retentionDays: Math.round(RETENTION_MS / (24 * 60 * 60 * 1000)),
      memoryCount: listActiveMemories(500).length,
      safeWriteTools: [...SAFE_WRITE_TOOLS],
      readTools: TOOL_DEFS.map((t) => t.function.name).filter((n) => !SAFE_WRITE_TOOLS.has(n))
    });
  });

  app.get('/api/console/ai-ask/sessions', (req, res) => {
    if (!requireAuth(req, res)) return;
    maybePruneRetention(false);
    const includeArchived = String(req.query.archived || '') === '1'
      || String(req.query.archived || '').toLowerCase() === 'true';
    const onlyArchived = String(req.query.onlyArchived || '') === '1'
      || String(req.query.onlyArchived || '').toLowerCase() === 'true';
    let sessions = loadIndex();
    if (onlyArchived) {
      sessions = sessions.filter((s) => s && s.archived);
    } else if (!includeArchived) {
      sessions = sessions.filter((s) => s && !s.archived);
    }
    res.json({
      ok: true,
      sessions: sessions.slice(0, 200),
      archivedCount: loadIndex().filter((s) => s && s.archived).length
    });
  });

  app.post('/api/console/ai-ask/sessions/:id/archive', (req, res) => {
    if (!requireAuth(req, res)) return;
    const archived = !(req.body && (req.body.archived === false || req.body.unarchive === true));
    const result = setSessionArchived(req.params.id, archived);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  });

  app.post('/api/console/ai-ask/sessions/:id/unarchive', (req, res) => {
    if (!requireAuth(req, res)) return;
    const result = setSessionArchived(req.params.id, false);
    if (!result.ok) return res.status(404).json(result);
    res.json(result);
  });

  app.delete('/api/console/ai-ask/sessions/:id', (req, res) => {
    if (!requireAuth(req, res)) return;
    const result = deleteSessionFully(req.params.id);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  app.get('/api/console/ai-ask/sessions/:id', (req, res) => {
    if (!requireAuth(req, res)) return;
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({
      ok: true,
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        archived: !!session.archived,
        messages: publicMessages(session)
      }
    });
  });

  app.post('/api/console/ai-ask/sessions', (req, res) => {
    if (!requireAuth(req, res)) return;
    const by = actorOf(req);
    const session = {
      id: newId('ask'),
      title: 'New chat',
      createdAt: isoNow(),
      updatedAt: isoNow(),
      createdBy: by,
      archived: false,
      messages: [],
      toolTrace: []
    };
    saveSession(session);
    res.json({ ok: true, session: { id: session.id, title: session.title, messages: [] } });
  });

  app.get('/api/console/ai-ask/memory', (req, res) => {
    if (!requireAuth(req, res)) return;
    res.json({
      ok: true,
      retentionDays: Math.round(RETENTION_MS / (24 * 60 * 60 * 1000)),
      items: listActiveMemories(Number(req.query.limit) || 100)
    });
  });

  app.post('/api/console/ai-ask/memory', (req, res) => {
    if (!requireAuth(req, res)) return;
    const body = req.body || {};
    const result = addLearnedMemory({
      text: body.text || body.memory || body.note,
      kind: body.kind || 'learned',
      crucial: !!(body.crucial || body.important),
      source: 'operator',
      by: actorOf(req)
    });
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  app.delete('/api/console/ai-ask/memory/:id', (req, res) => {
    if (!requireAuth(req, res)) return;
    res.json(deleteLearnedMemory(String(req.params.id || '')));
  });

  app.post('/api/console/ai-ask/chat', async (req, res) => {
    if (!requireAuth(req, res)) return;
    const by = actorOf(req);
    const body = req.body || {};
    const message = String(body.message || body.text || '').trim();
    if (message.length < 1) return res.status(400).json({ error: 'message required' });
    if (message.length > 8000) return res.status(400).json({ error: 'message too long' });

    let session = body.sessionId ? loadSession(body.sessionId) : null;
    if (!session) {
      session = {
        id: newId('ask'),
        title: 'New chat',
        createdAt: isoNow(),
        updatedAt: isoNow(),
        createdBy: by,
        messages: [],
        toolTrace: []
      };
    }

    try {
      const result = await runAssistantTurn(session, message, by);
      const fresh = loadSession(session.id);
      res.json({
        ...result,
        messages: publicMessages(fresh || session),
        aiAvailable: true
      });
    } catch (e) {
      console.error('[ai_ask] chat', e);
      res.status(500).json({ error: e.message || 'chat failed' });
    }
  });

  app.get('/api/console/ai-ask/insights', (req, res) => {
    if (!requireAuth(req, res)) return;
    res.json({ ok: true, ...toolAskInsights({ limit: Number(req.query.limit) || 50 }) });
  });
}

module.exports = {
  setupConsoleAiAsk,
  SAFE_WRITE_TOOLS
};
