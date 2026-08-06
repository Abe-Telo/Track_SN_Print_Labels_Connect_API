/**
 * Printer registry + print job queue (WiFi-first).
 *
 * Phones/console enqueue jobs; a Windows office agent polls and prints
 * to local/WiFi printers (Brother, Dymo, Zebra, etc.).
 *
 *   GET  /api/printers
 *   POST /api/printers
 *   PATCH /api/printers/:id
 *   DELETE /api/printers/:id
 *   POST /api/print/jobs
 *   GET  /api/print/jobs
 *   GET  /api/print/agent/poll          (agent token)
 *   POST /api/print/agent/complete     (agent token)
 *   GET  /api/print/agent/job/:id/pdf  (agent token)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJsonSync } = require('./atomic_json.js');

const ROOT = path.join(__dirname, '..');
const PRINTERS_PATH = path.join(ROOT, 'db', 'printers.json');
const JOBS_PATH = path.join(ROOT, 'db', 'print_jobs.json');
const AGENT_TOKEN_PATH = path.join(ROOT, 'db', 'print_agent_token.txt');

const ROLES = Object.freeze({
  shipping: 'ShipStation shipping label (4x6)',
  sticker: 'Device / serial sticker',
  regular: 'Packing slip / letter',
  ups: 'UPS / carrier label'
});

const BRANDS = ['brother', 'dymo', 'zebra', 'hp', 'epson', 'canon', 'other'];

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('printers loadJson', filePath, e.message);
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteJsonSync(filePath, data);
}

function ensureAgentToken() {
  try {
    if (fs.existsSync(AGENT_TOKEN_PATH)) {
      const existing = fs.readFileSync(AGENT_TOKEN_PATH, 'utf8').trim();
      if (existing) return existing;
    }
  } catch (e) { /* recreate */ }
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(AGENT_TOKEN_PATH), { recursive: true });
  fs.writeFileSync(AGENT_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  return token;
}

function agentTokenOk(req) {
  const expected = ensureAgentToken();
  const got = String(
    req.get('X-Print-Agent-Token')
    || req.query.token
    || (req.body && req.body.token)
    || ''
  ).trim();
  return got && got === expected;
}

function requireConsoleAuth(req, res, next) {
  if (!req.session || !req.session.loggedIn) {
    return res.status(401).json({ error: 'Login required' });
  }
  res.set('Cache-Control', 'no-store');
  next();
}

function defaultPrinters() {
  return {
    updatedAt: nowIso(),
    globalEnabled: true,
    discovered: [],
    discoveredAt: null,
    agentLastSeenAt: null,
    printers: [
      {
        id: 'prt-brother-shipping',
        name: 'Brother (shipping)',
        brand: 'brother',
        role: 'shipping',
        connection: 'wifi',
        windowsPrinterName: '',
        host: '',
        notes: 'WiFi 4x6 shipping labels — set Windows printer name from network search',
        enabled: true,
        createdAt: nowIso()
      },
      {
        id: 'prt-dymo-sticker',
        name: 'Dymo (sticker)',
        brand: 'dymo',
        role: 'sticker',
        connection: 'wifi',
        windowsPrinterName: '',
        host: '',
        notes: 'WiFi/label writer for serial stickers',
        enabled: true,
        createdAt: nowIso()
      },
      {
        id: 'prt-zebra-shipping',
        name: 'Zebra (shipping)',
        brand: 'zebra',
        role: 'shipping',
        connection: 'wifi',
        windowsPrinterName: '',
        host: '',
        notes: 'Optional Zebra WiFi — enable when available',
        enabled: false,
        createdAt: nowIso()
      },
      {
        id: 'prt-office-regular',
        name: 'Office (letter)',
        brand: 'other',
        role: 'regular',
        connection: 'wifi',
        windowsPrinterName: '',
        host: '',
        notes: 'Letter / packing slip / MS ship-out sheet — set Windows printer name from network search',
        enabled: true,
        createdAt: nowIso()
      }
    ]
  };
}

function loadPrinters() {
  const data = loadJson(PRINTERS_PATH, null);
  if (!data || !Array.isArray(data.printers)) {
    const seeded = defaultPrinters();
    saveJson(PRINTERS_PATH, seeded);
    return seeded;
  }
  if (typeof data.globalEnabled !== 'boolean') data.globalEnabled = true;
  if (!Array.isArray(data.discovered)) data.discovered = [];
  // Ensure an office/letter printer exists for MS ship-out sheets.
  if (!data.printers.some((p) => p && p.role === 'regular')) {
    data.printers.push({
      id: 'prt-office-regular',
      name: 'Office (letter)',
      brand: 'other',
      role: 'regular',
      connection: 'wifi',
      windowsPrinterName: '',
      host: '',
      notes: 'Letter / packing slip / MS ship-out sheet — set Windows printer name from network search',
      enabled: true,
      createdAt: nowIso()
    });
    savePrinters(data);
  }
  return data;
}

function savePrinters(data) {
  data.updatedAt = nowIso();
  saveJson(PRINTERS_PATH, data);
  return data;
}

function loadJobs() {
  const data = loadJson(JOBS_PATH, null);
  if (!data || !Array.isArray(data.jobs)) {
    const seeded = { updatedAt: nowIso(), jobs: [] };
    saveJson(JOBS_PATH, seeded);
    return seeded;
  }
  return data;
}

function saveJobs(data) {
  data.updatedAt = nowIso();
  // Keep last 200 jobs
  if (data.jobs.length > 200) data.jobs = data.jobs.slice(0, 200);
  saveJson(JOBS_PATH, data);
  return data;
}

/**
 * Queue a print job for the office agent.
 * @returns {{ ok: true, job } | { ok: false, error: string, status?: number, cooldown?: boolean, retryAfterSec?: number }}
 */
const PRINT_JOB_COOLDOWN_MS = 15000;
const printJobCooldownUntil = new Map();

function printJobCooldownKey(actor, printerId, pdfUrl) {
  return `${String(actor || 'console')}::${String(printerId || '')}::${String(pdfUrl || '')}`;
}

function enqueuePrintJob(opts = {}) {
  const store = loadPrinters();
  if (store.globalEnabled === false) {
    return { ok: false, status: 403, error: 'Printing is turned off globally. Enable it on the Printers page.' };
  }
  const printers = store.printers || [];
  let printer = null;
  if (opts.printerId) {
    printer = printers.find((p) => p.id === opts.printerId && p.enabled);
  } else if (opts.role) {
    // Prefer printers that already have a Windows name mapped (agent can actually print).
    printer = printers.find((p) => p.role === opts.role && p.enabled && String(p.windowsPrinterName || '').trim())
      || printers.find((p) => p.role === opts.role && p.enabled);
  }
  if (!printer) {
    return {
      ok: false,
      status: 400,
      error: opts.role
        ? `No enabled printer with role "${opts.role}". Configure one under Printers.`
        : 'No matching enabled printer. Configure one under Printers.'
    };
  }
  if (!String(printer.windowsPrinterName || '').trim()) {
    return {
      ok: false,
      status: 400,
      error: `Printer "${printer.name}" has no Windows printer name. Open Printers → pick it from Network search (or set Windows name), then try again.`
    };
  }

  const pdfUrl = String(opts.pdfUrl || '').trim();
  const tracking = String(opts.tracking || opts.trackingNumber || '').trim();
  const order = String(opts.order || opts.orderNumber || '').trim();
  const serial = String(opts.serial || opts.serialNumber || '').trim();
  if (!pdfUrl && !tracking && !order && !serial) {
    return { ok: false, status: 400, error: 'Provide pdfUrl, serial, tracking, or order' };
  }

  let resolvedPdf = pdfUrl;
  if (!resolvedPdf && serial) {
    resolvedPdf = `/api/device/shipping-label/${encodeURIComponent(serial)}/pdf`;
  } else if (!resolvedPdf && (tracking || order)) {
    const qs = new URLSearchParams();
    if (tracking) qs.set('tracking', tracking);
    if (order) qs.set('order', order);
    resolvedPdf = `/api/device/shipping-label-lookup/pdf?${qs.toString()}`;
  }

  const actor = opts.requestedBy || 'console';
  const coolKey = printJobCooldownKey(actor, printer.id, resolvedPdf);
  const until = printJobCooldownUntil.get(coolKey) || 0;
  const leftMs = until - Date.now();
  if (leftMs > 0) {
    const retryAfterSec = Math.max(1, Math.ceil(leftMs / 1000));
    return {
      ok: false,
      status: 429,
      cooldown: true,
      retryAfterSec,
      error: `Print already queued — wait ${retryAfterSec}s before printing again.`
    };
  }

  const job = {
    id: newId('job'),
    createdAt: nowIso(),
    status: 'queued',
    role: printer.role,
    printerId: printer.id,
    printerName: printer.name,
    windowsPrinterName: printer.windowsPrinterName || null,
    brand: printer.brand,
    connection: printer.connection,
    pdfUrl: resolvedPdf,
    serialNumber: serial || null,
    trackingNumber: tracking || null,
    orderNumber: order || null,
    requestedBy: actor,
    error: null,
    completedAt: null
  };

  const data = loadJobs();
  data.jobs.unshift(job);
  saveJobs(data);
  printJobCooldownUntil.set(coolKey, Date.now() + PRINT_JOB_COOLDOWN_MS);
  return { ok: true, job, cooldownSec: Math.round(PRINT_JOB_COOLDOWN_MS / 1000) };
}

function normalizePrinter(row, fallbackId) {
  const raw = row && typeof row === 'object' ? row : {};
  const brand = BRANDS.includes(String(raw.brand || '').toLowerCase())
    ? String(raw.brand).toLowerCase()
    : 'other';
  const role = ROLES[raw.role] ? raw.role : 'shipping';
  const windowsPrinterName = String(raw.windowsPrinterName || '').trim();
  const safeName = String(raw.driverFolderName || windowsPrinterName || raw.name || 'printer')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'printer';
  return {
    id: String(raw.id || fallbackId || newId('prt')),
    name: String(raw.name || 'Printer').trim() || 'Printer',
    brand,
    role,
    uses: Array.isArray(raw.uses)
      ? raw.uses.map((u) => String(u || '').trim()).filter(Boolean)
      : [],
    media: String(raw.media || '').trim() || null,
    connection: String(raw.connection || 'wifi').trim() || 'wifi',
    windowsPrinterName,
    host: String(raw.host || '').trim(),
    notes: String(raw.notes || '').trim(),
    enabled: raw.enabled !== false,
    driverName: String(raw.driverName || '').trim() || null,
    driverFolder: String(raw.driverFolder || `drivers\\${safeName}`).trim(),
    driverFolderName: safeName,
    driverExportOk: raw.driverExportOk === true,
    driverInfoPath: String(raw.driverInfoPath || `drivers\\${safeName}\\driver-info.json`).trim(),
    createdAt: raw.createdAt || nowIso(),
    updatedAt: nowIso()
  };
}

function setupPrinters(app) {
  ensureAgentToken();
  loadPrinters();
  loadJobs();

  app.get('/api/printers/meta', requireConsoleAuth, (req, res) => {
    const token = ensureAgentToken();
    res.json({
      ok: true,
      roles: Object.keys(ROLES).map((key) => ({ key, label: ROLES[key] })),
      brands: BRANDS,
      connections: ['wifi', 'usb', 'ethernet'],
      agentConfigured: !!token,
      agentToken: token,
      agentTokenPath: 'db/print_agent_token.txt',
      note: 'Paste this token into OrderAssistPrint/token.txt on the office print PC.'
    });
  });

  app.post('/api/printers/agent-token/rotate', requireConsoleAuth, (req, res) => {
    const token = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(path.dirname(AGENT_TOKEN_PATH), { recursive: true });
    fs.writeFileSync(AGENT_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
    res.json({
      ok: true,
      agentToken: token,
      note: 'Update token.txt on the print PC and restart the agent.'
    });
  });

  app.get('/api/printers', requireConsoleAuth, (req, res) => {
    const data = loadPrinters();
    res.json({
      ok: true,
      globalEnabled: data.globalEnabled !== false,
      agentLastSeenAt: data.agentLastSeenAt || null,
      discoveredAt: data.discoveredAt || null,
      discovered: data.discovered || [],
      printers: data.printers,
      updatedAt: data.updatedAt
    });
  });

  app.post('/api/printers/global', requireConsoleAuth, (req, res) => {
    const data = loadPrinters();
    data.globalEnabled = !!(req.body && req.body.enabled);
    savePrinters(data);
    res.json({ ok: true, globalEnabled: data.globalEnabled });
  });

  app.post('/api/printers/discover', requireConsoleAuth, (req, res) => {
    const data = loadPrinters();
    data.discoverRequestedAt = nowIso();
    savePrinters(data);
    res.json({
      ok: true,
      message: data.agentLastSeenAt
        ? 'Discovery requested. The office agent will refresh the network list on its next poll.'
        : 'Discovery requested. Start the Windows print agent on the office PC so it can scan WiFi printers.',
      agentLastSeenAt: data.agentLastSeenAt || null
    });
  });

  app.post('/api/printers/from-discovered', requireConsoleAuth, (req, res) => {
    const body = req.body || {};
    const winName = String(body.windowsPrinterName || body.name || '').trim();
    if (!winName) return res.status(400).json({ error: 'windowsPrinterName required' });
    const data = loadPrinters();
    const discovered = (data.discovered || []).find((d) =>
      String(d.name || '').toLowerCase() === winName.toLowerCase()
    );
    const existing = data.printers.find((p) =>
      String(p.windowsPrinterName || '').toLowerCase() === winName.toLowerCase()
    );
    if (existing) {
      return res.json({ ok: true, printer: existing, alreadyExists: true });
    }
    const guessedBrand = /brother/i.test(winName) ? 'brother'
      : /dymo/i.test(winName) ? 'dymo'
        : /zebra|zsb|zb[-_ ]/i.test(winName + ' ' + String((discovered && discovered.driverName) || '') + ' ' + String((discovered && discovered.brandHint) || '')) ? 'zebra'
          : 'other';
    const printer = normalizePrinter({
      name: winName,
      brand: body.brand || guessedBrand,
      role: body.role || (guessedBrand === 'dymo' ? 'sticker' : 'shipping'),
      connection: body.connection || (discovered && discovered.connection) || 'wifi',
      windowsPrinterName: winName,
      host: body.host || (discovered && discovered.host) || '',
      notes: body.notes || 'Added from network search',
      enabled: true,
      driverName: body.driverName || (discovered && discovered.driverName) || null,
      driverFolder: body.driverFolder || (discovered && discovered.driverFolder) || null,
      driverFolderName: body.driverFolderName || (discovered && discovered.driverFolderName) || null,
      driverExportOk: body.driverExportOk === true || !!(discovered && discovered.driverExportOk),
      driverInfoPath: body.driverInfoPath || (discovered && discovered.driverInfoPath) || null
    }, newId('prt'));
    data.printers.push(printer);
    savePrinters(data);
    res.json({ ok: true, printer });
  });

  app.post('/api/printers', requireConsoleAuth, (req, res) => {
    const data = loadPrinters();
    const printer = normalizePrinter(req.body || {}, newId('prt'));
    data.printers.push(printer);
    savePrinters(data);
    res.json({ ok: true, printer });
  });

  app.patch('/api/printers/:id', requireConsoleAuth, (req, res) => {
    const data = loadPrinters();
    const idx = data.printers.findIndex((p) => p.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Printer not found' });
    const merged = normalizePrinter({ ...data.printers[idx], ...(req.body || {}) }, data.printers[idx].id);
    merged.createdAt = data.printers[idx].createdAt;
    data.printers[idx] = merged;
    savePrinters(data);
    res.json({ ok: true, printer: merged });
  });

  app.delete('/api/printers/:id', requireConsoleAuth, (req, res) => {
    const data = loadPrinters();
    const before = data.printers.length;
    data.printers = data.printers.filter((p) => p.id !== req.params.id);
    if (data.printers.length === before) return res.status(404).json({ error: 'Printer not found' });
    savePrinters(data);
    res.json({ ok: true });
  });

  app.get('/api/print/jobs', requireConsoleAuth, (req, res) => {
    const data = loadJobs();
    res.json({ ok: true, count: data.jobs.length, jobs: data.jobs.slice(0, 50) });
  });

  app.post('/api/print/jobs', requireConsoleAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const result = enqueuePrintJob({
        ...body,
        requestedBy: (req.session && (req.session.username || req.session.user)) || 'console'
      });
      if (!result.ok) {
        return res.status(result.status || 400).json({
          error: result.error,
          cooldown: !!result.cooldown,
          retryAfterSec: result.retryAfterSec || undefined
        });
      }
      res.json({ ok: true, job: result.job, cooldownSec: result.cooldownSec || 15 });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not queue print job' });
    }
  });

  // --- Agent endpoints (token auth, no console session) ---

  app.get('/api/print/agent/config', (req, res) => {
    if (!agentTokenOk(req)) return res.status(401).json({ error: 'Bad agent token' });
    const store = loadPrinters();
    store.agentLastSeenAt = nowIso();
    savePrinters(store);
    res.json({
      ok: true,
      globalEnabled: store.globalEnabled !== false,
      discoverRequestedAt: store.discoverRequestedAt || null,
      printers: store.printers.filter((p) => p.enabled),
      note: 'Map windowsPrinterName to Get-Printer Name on this PC'
    });
  });

  app.post('/api/print/agent/discovered', (req, res) => {
    if (!agentTokenOk(req)) return res.status(401).json({ error: 'Bad agent token' });
    const body = req.body || {};
    const rows = Array.isArray(body.printers) ? body.printers : [];
    const store = loadPrinters();
    store.agentLastSeenAt = nowIso();
    store.discoveredAt = nowIso();
    store.discoverRequestedAt = null;
    store.discovered = rows.map((row) => ({
      name: String(row.name || '').trim(),
      driverName: String(row.driverName || row.DriverName || '').trim(),
      portName: String(row.portName || row.PortName || '').trim(),
      comment: String(row.comment || row.Comment || '').trim(),
      location: String(row.location || row.Location || '').trim(),
      brandHint: String(row.brandHint || '').trim().toLowerCase() || null,
      shared: !!row.shared,
      host: String(row.host || '').trim(),
      connection: /usb|dot4/i.test(String(row.portName || '')) ? 'usb'
        : /ip_|wif|wpd|tcp/i.test(String(row.portName || '')) ? 'wifi'
          : 'wifi',
      driverFolder: String(row.driverFolder || '').trim() || null,
      driverFolderName: String(row.driverFolderName || '').trim() || null,
      driverExportOk: row.driverExportOk === true,
      driverInfoPath: String(row.driverInfoPath || '').trim() || null
    })).filter((row) => row.name);
    savePrinters(store);
    res.json({ ok: true, count: store.discovered.length });
  });

  app.post('/api/print/agent/driver-map', (req, res) => {
    if (!agentTokenOk(req)) return res.status(401).json({ error: 'Bad agent token' });
    const body = req.body || {};
    const maps = Array.isArray(body.maps) ? body.maps : [];
    const store = loadPrinters();
    store.agentLastSeenAt = nowIso();
    let updated = 0;
    for (const map of maps) {
      const winName = String(map.windowsPrinterName || map.name || '').trim();
      if (!winName) continue;
      const idx = store.printers.findIndex((p) =>
        String(p.windowsPrinterName || '').toLowerCase() === winName.toLowerCase()
        || String(p.name || '').toLowerCase() === winName.toLowerCase()
      );
      if (idx < 0) continue;
      store.printers[idx] = normalizePrinter({
        ...store.printers[idx],
        driverName: map.driverName || store.printers[idx].driverName,
        driverFolder: map.driverFolder || store.printers[idx].driverFolder,
        driverFolderName: map.driverFolderName || store.printers[idx].driverFolderName,
        driverExportOk: map.driverExportOk === true,
        driverInfoPath: map.driverInfoPath || store.printers[idx].driverInfoPath
      }, store.printers[idx].id);
      store.printers[idx].createdAt = store.printers[idx].createdAt;
      updated += 1;
    }
    savePrinters(store);
    res.json({ ok: true, updated });
  });

  app.get('/api/print/agent/poll', (req, res) => {
    if (!agentTokenOk(req)) return res.status(401).json({ error: 'Bad agent token' });
    const store = loadPrinters();
    store.agentLastSeenAt = nowIso();
    const discoverRequested = !!store.discoverRequestedAt;
    savePrinters(store);

    if (store.globalEnabled === false) {
      return res.json({ ok: true, job: null, globalEnabled: false, discoverRequested });
    }

    const data = loadJobs();
    const job = data.jobs.find((j) => j.status === 'queued');
    if (!job) return res.json({ ok: true, job: null, globalEnabled: true, discoverRequested });
    job.status = 'printing';
    job.claimedAt = nowIso();
    saveJobs(data);
    res.json({
      ok: true,
      globalEnabled: true,
      discoverRequested,
      job: {
        id: job.id,
        windowsPrinterName: job.windowsPrinterName,
        brand: job.brand,
        role: job.role,
        pdfPath: `/api/print/agent/job/${encodeURIComponent(job.id)}/pdf`
      }
    });
  });

  app.get('/api/print/agent/job/:id/pdf', async (req, res) => {
    if (!agentTokenOk(req)) return res.status(401).json({ error: 'Bad agent token' });
    const data = loadJobs();
    const job = data.jobs.find((j) => j.id === req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    try {
      // Generated MS print PDFs (cropped 4x6 / office sheet) — serve from disk.
      if (job.pdfUrl && job.pdfUrl.includes('/android/ms-print/')) {
        const name = decodeURIComponent(String(job.pdfUrl).split('/android/ms-print/')[1] || '').split('?')[0];
        const { resolvePrintFile } = require('./ms_label_print');
        const full = resolvePrintFile(name);
        if (!full) return res.status(404).json({ error: 'Print file not found' });
        res.setHeader('Content-Type', 'application/pdf');
        return fs.createReadStream(full).pipe(res);
      }

      // Raw MS email labels — read from labels dir (avoids session-auth axios hop).
      if (job.pdfUrl && /\/api\/ms-email\/labels\//.test(job.pdfUrl)) {
        const id = decodeURIComponent(String(job.pdfUrl).split('/api/ms-email/labels/')[1] || '')
          .split('?')[0]
          .replace(/[^\w\-]/g, '');
        const labelsDir = path.join(ROOT, 'db', 'ms_email_inbox', 'labels');
        if (id && fs.existsSync(labelsDir)) {
          const files = fs.readdirSync(labelsDir).filter((f) => f.startsWith(`${id}_`) || f === `${id}.pdf`);
          if (files.length) {
            const file = files.sort((a, b) => b.length - a.length)[0];
            res.setHeader('Content-Type', 'application/pdf');
            return fs.createReadStream(path.join(labelsDir, file)).pipe(res);
          }
        }
      }

      const axios = require('axios');
      let fetchUrl = job.pdfUrl.startsWith('http')
        ? job.pdfUrl
        : `http://127.0.0.1:3000${job.pdfUrl}`;
      if (job.serialNumber && job.pdfUrl.includes('/api/device/shipping-label/')) {
        fetchUrl = `http://127.0.0.1:3000/android/label/${encodeURIComponent(job.serialNumber)}/pdf`;
      } else if (job.pdfUrl.includes('shipping-label-lookup')) {
        const qs = new URLSearchParams();
        if (job.trackingNumber) qs.set('tracking', job.trackingNumber);
        if (job.orderNumber) qs.set('order', job.orderNumber);
        fetchUrl = `http://127.0.0.1:3000/android/label-lookup/pdf?${qs.toString()}`;
      }
      const response = await axios.get(fetchUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        validateStatus: () => true
      });
      if (response.status >= 400) {
        return res.status(response.status).json({ error: 'Upstream PDF failed' });
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.send(Buffer.from(response.data));
    } catch (e) {
      res.status(500).json({ error: e.message || 'PDF fetch failed' });
    }
  });

  app.post('/api/print/agent/complete', (req, res) => {
    if (!agentTokenOk(req)) return res.status(401).json({ error: 'Bad agent token' });
    const body = req.body || {};
    const data = loadJobs();
    const job = data.jobs.find((j) => j.id === body.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.status = body.ok === false ? 'failed' : 'done';
    job.error = body.error || null;
    job.completedAt = nowIso();
    saveJobs(data);

    // Console bell + toast so operators see success/failure (not silent).
    try {
      const notif = require('./console_notifications');
      if (notif && typeof notif.pushNotification === 'function') {
        const who = job.printerName || job.windowsPrinterName || 'printer';
        const sn = job.serialNumber ? ` · ${job.serialNumber}` : '';
        if (job.status === 'done') {
          notif.pushNotification({
            type: 'print_done',
            severity: 'ok',
            title: `Printed on ${who}`,
            summary: `${job.role || 'job'}${sn} finished successfully.`,
            href: 'printers',
            meta: { jobId: job.id, printerId: job.printerId, serialNumber: job.serialNumber || null }
          });
        } else {
          notif.pushNotification({
            type: 'print_failed',
            severity: 'danger',
            title: `Print failed · ${who}`,
            summary: String(job.error || 'Unknown print error').slice(0, 240),
            href: 'printers',
            meta: { jobId: job.id, printerId: job.printerId, serialNumber: job.serialNumber || null }
          });
        }
      }
    } catch (e) {
      console.error('print complete notification', e.message);
    }

    res.json({ ok: true, job });
  });
}

module.exports = {
  setupPrinters,
  loadPrinters,
  enqueuePrintJob,
  ROLES
};
