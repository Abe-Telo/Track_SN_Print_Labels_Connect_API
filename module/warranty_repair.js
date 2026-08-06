/**
 * Microsoft warranty cache + repair-needed reporting for OrderAssist Android / tools.
 *
 * Also hosts the Fast Scan background warranty queue:
 *   POST /android/warranty/queue
 *   GET  /android/warranty/status/:serialNumber
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { atomicWriteJsonSync } = require('./atomic_json.js');
const {
  appendNoteLog,
  appendDeviceHistory,
  inferTrackingStage,
  STAGES
} = require('./device_lifecycle');
const supplementalDevices = require('./supplemental_devices');

const ROOT = path.join(__dirname, '..');
const WARRANTY_CACHE_PATH = path.join(ROOT, 'db', 'warrantyCache.json');
const REPAIR_NEEDED_PATH = path.join(ROOT, 'db', 'repair_needed.json');
const WARRANTY_QUEUE_PATH = path.join(ROOT, 'db', 'warranty_queue.json');
const MS_DRAFTS_PATH = path.join(ROOT, 'db', 'ms_email_inbox', 'drafts.json');
const WARRANTY_SCRIPT = path.join(ROOT, 'scripts', 'bulk_refresh_warranty.py');
const WARRANTY_TIMEOUT_MS = 150000;
const RESULT_MARKER = '##RESULT##';
const QUEUE_MAX_DONE = 200;

/**
 * Structured repair workflow statuses.
 * Microsoft paths cover Advanced Exchange (replacement first) and same-unit repair.
 */
const REPAIR_STATUSES = Object.freeze({
  open: { label: 'Open / issue noted', group: 'intake', tone: 'warn', closed: false },
  diagnosing: { label: 'Diagnosing', group: 'intake', tone: 'warn', closed: false },
  parts_needed: { label: 'Parts needed', group: 'intake', tone: 'warn', closed: false },
  warranty_expired: { label: 'Warranty expired', group: 'intake', tone: 'danger', closed: false },

  vendor_return: { label: 'Sending back to vendor', group: 'external', tone: 'warn', closed: false },
  manufacturer_return: { label: 'Sending back to manufacturer', group: 'external', tone: 'warn', closed: false },

  ms_waiting_case: { label: 'Waiting to create MS support case', group: 'microsoft', tone: 'warn', closed: false },
  ms_case_created: { label: 'MS support case created', group: 'microsoft', tone: 'info', closed: false },
  ms_waiting_approval: { label: 'Waiting for MS approval (communicating)', group: 'microsoft', tone: 'warn', closed: false },
  ms_approved_ship_same: { label: 'Approved — waiting to ship (same-unit repair)', group: 'microsoft', tone: 'ok', closed: false },
  ms_approved_ship_ae: { label: 'Approved — waiting to ship (Advanced Exchange)', group: 'microsoft', tone: 'ok', closed: false },
  ms_rejected: { label: 'Microsoft rejected', group: 'microsoft', tone: 'danger', closed: false },
  ms_ready_to_ship: { label: 'Ready for shipment to Microsoft', group: 'microsoft', tone: 'info', closed: false },
  ms_advanced_exchange: { label: 'Microsoft Advanced Exchange', group: 'microsoft', tone: 'info', closed: false },
  ms_same_unit: { label: 'Microsoft same-unit repair', group: 'microsoft', tone: 'info', closed: false },
  ms_shipped_outbound: { label: 'Shipped to Microsoft — waiting', group: 'microsoft', tone: 'info', closed: false },
  ms_waiting_inbound: { label: 'Waiting for Microsoft inbound', group: 'microsoft', tone: 'info', closed: false },
  ms_received_exchange: { label: 'Received MS replacement', group: 'microsoft', tone: 'ok', closed: false },
  ms_received_same: { label: 'Received same unit from MS', group: 'microsoft', tone: 'ok', closed: false },
  /** Physically back from MS — operator must inspect, then Resolve. */
  ms_arrived_check: { label: 'Came back — physical check', group: 'arrived', tone: 'ok', closed: false },

  ready_restock: { label: 'Ready to restock', group: 'close', tone: 'ok', closed: false },
  resolved: { label: 'Issue resolved', group: 'close', tone: 'ok', closed: true },
  cannot_resolve: { label: 'Issue cannot be resolved', group: 'close', tone: 'danger', closed: true }
});

const MS_PROGRAMS = Object.freeze({
  advanced_exchange: {
    label: 'Advanced Exchange',
    hint: 'MS ships a refurbished replacement first (with return label in the box). You must ship the defective unit back within ~10–14 days.'
  },
  same_unit_repair: {
    label: 'Same-unit repair',
    hint: 'You ship first using the prepaid label from email / account.devices. MS repairs (or replaces) and ships the same serial back.'
  },
  other: {
    label: 'Other Microsoft program',
    hint: 'Case-by-case Microsoft repair / RMA path.'
  }
});

/**
 * Operator-facing Microsoft pipeline (tabs).
 * Existing status keys still stored; these map them into a clear stage.
 */
const MS_PIPELINE = Object.freeze({
  needs: {
    key: 'needs',
    label: 'Needs MS',
    short: 'Open a Microsoft case, then move to Talking to MS.',
    tone: 'warn'
  },
  todo: {
    key: 'todo',
    label: 'To do',
    short: 'Return queue for the team (Ezra & co): reset/restock, test & repair, or start Send to MS.',
    tone: 'warn'
  },
  talking: {
    key: 'talking',
    label: 'Talking to MS',
    short: 'Case open — proof, diagnostics, or fighting a rejection.',
    tone: 'info'
  },
  ship: {
    key: 'ship',
    label: 'Ship / labels',
    short: 'Approved. Print label (same-unit) or wait for AE box + return label.',
    tone: 'ok'
  },
  transit: {
    key: 'transit',
    label: 'In transit',
    short: 'Outbound and/or inbound tracking — waiting on the carrier.',
    tone: 'info'
  },
  checkin: {
    key: 'checkin',
    label: 'Check-in',
    short: 'Physically back — inspect, then mark completed.',
    tone: 'ok'
  },
  done: {
    key: 'done',
    label: 'Done',
    short: 'Closed tickets.',
    tone: 'ok'
  }
});

const STATUS_PIPELINE = Object.freeze({
  ms_waiting_case: 'needs',
  ms_case_created: 'talking',
  ms_waiting_approval: 'talking',
  ms_rejected: 'talking',
  ms_approved_ship_same: 'ship',
  ms_approved_ship_ae: 'ship',
  ms_ready_to_ship: 'ship',
  ms_advanced_exchange: 'ship',
  ms_same_unit: 'ship',
  ms_shipped_outbound: 'transit',
  ms_waiting_inbound: 'transit',
  ms_arrived_check: 'checkin',
  ms_received_exchange: 'checkin',
  ms_received_same: 'checkin',
  resolved: 'done',
  cannot_resolve: 'done',
  // Team return queue (Ezra): reset/restock, test & repair, parts, etc.
  open: 'todo',
  diagnosing: 'todo',
  parts_needed: 'todo',
  warranty_expired: 'todo',
  vendor_return: 'todo',
  manufacturer_return: 'todo',
  ready_restock: 'todo'
});

function repairPipelineForStatus(status) {
  const key = STATUS_PIPELINE[String(status || '').trim()] || 'todo';
  return MS_PIPELINE[key] || MS_PIPELINE.todo;
}

function nextActionForTicket(ticket) {
  const status = String((ticket && ticket.status) || 'open');
  const program = ticket && ticket.msProgram;
  const hasCase = !!(ticket && ticket.msCaseId);
  const hasOrder = !!(ticket && ticket.msOrderNumber);
  const hasOut = !!(ticket && ticket.outboundTracking);
  const hasIn = !!(ticket && ticket.inboundTracking);

  switch (status) {
    case 'ms_waiting_case':
      return {
        title: 'Open a Microsoft support / service case',
        detail: 'Use account.microsoft.com/devices or Surface support. Paste the case / service order ID here when you have it.'
      };
    case 'ms_case_created':
    case 'ms_waiting_approval':
      if (ticket && ticket.msNeedsReply) {
        return {
          title: 'Need a reply — Microsoft is waiting on you',
          detail: 'Open the ticket, review the newest MS email, and Send Email. The “Need a reply” badge clears after you send.'
        };
      }
      return {
        title: hasCase ? 'Keep talking to Microsoft until approved' : 'Paste the MS case ID, then keep communicating',
        detail: 'They may ask for proof of purchase, diagnostics, or photos. If they reject, set Rejected + reason and keep fighting from this tab.'
      };
    case 'ms_rejected':
      return {
        title: 'Fight the rejection or close it',
        detail: ticket && ticket.msRejectReason
          ? `Reason on file: ${ticket.msRejectReason}. Update notes with what you sent MS, or mark Cannot resolve.`
          : 'Pick a reject reason, add notes, keep lobbying MS — or close if it is final.'
      };
    case 'ms_approved_ship_same':
    case 'ms_same_unit':
      return {
        title: 'Same-unit: print prepaid label and ship your device',
        detail: hasOrder
          ? `Order ${ticket.msOrderNumber} on file. Print label from the service order email / account.devices, pack the unit, save outbound tracking.`
          : 'Paste the MS service order # when you have it, print the email label, ship, then save outbound tracking.'
      };
    case 'ms_approved_ship_ae':
    case 'ms_advanced_exchange':
      return {
        title: 'Advanced Exchange: wait for replacement + return label',
        detail: hasIn
          ? `Inbound TN ${ticket.inboundTracking} — when the box arrives, stick their return label on the defective unit and ship it out.`
          : 'Paste inbound tracking when MS emails it. Order # usually appears with the service order. Return label is in the AE box.'
      };
    case 'ms_ready_to_ship':
      return {
        title: 'Ready to ship — confirm program and tracking',
        detail: program === 'advanced_exchange'
          ? 'AE path: waiting on MS box / return label.'
          : 'Same-unit path: print label and add outbound tracking when shipped.'
      };
    case 'ms_shipped_outbound':
      return {
        title: hasOut ? 'Waiting for MS to receive / return your unit' : 'Add outbound tracking, then wait',
        detail: hasIn
          ? `Inbound ${ticket.inboundTracking} on file — move to Check-in when it arrives.`
          : 'When MS ships back (or AE ships to you), paste inbound tracking.'
      };
    case 'ms_waiting_inbound':
      return {
        title: 'Waiting on inbound package from Microsoft',
        detail: hasIn
          ? `Track ${ticket.inboundTracking}. When delivered, move to Check-in.`
          : 'Paste the inbound tracking number from the MS shipment email.'
      };
    case 'ms_arrived_check':
    case 'ms_received_exchange':
    case 'ms_received_same':
      return {
        title: 'Physically inspect, then mark completed',
        detail: ticket && ticket.msProgram === 'advanced_exchange'
          ? `Confirm replacement SN${ticket.msReplacementSerial ? ` (${ticket.msReplacementSerial})` : ''} vs defective ${ticket.msDefectiveSerial || ticket.serialNumber || ''}, then promote inventory SN at check-in.`
          : 'Power on, confirm repair/replacement, match serial if AE, then Mark completed.'
      };
    case 'resolved':
    case 'cannot_resolve':
      return { title: 'Closed', detail: '' };
    default:
      return {
        title: 'Finish the return process',
        detail: 'Reset & restock, test & repair, or move to Needs MS when it must go to Microsoft. Importing notes via the workstation script auto-completes this To do.'
      };
  }
}

/** Statuses closed automatically when workstation PowerShell imports notes. */
const AUTO_COMPLETE_ON_NOTES_STATUSES = Object.freeze([
  'open',
  'diagnosing',
  'parts_needed',
  'ready_restock',
  'warranty_expired',
  'vendor_return',
  'manufacturer_return'
]);

function shouldAutoCompleteRepairOnNotes(status) {
  return AUTO_COMPLETE_ON_NOTES_STATUSES.includes(String(status || '').trim());
}

/**
 * When the bench PowerShell script (or /update-device-details) imports notes,
 * close open "To do" return tickets for that serial. Does NOT close MS pipeline
 * tickets (Needs MS / Talking / Ship / Transit / Check-in).
 */
function autoCompleteRepairOnNotesImport(serialNumber, noteText, by) {
  const key = serialKey(serialNumber);
  if (!key) return { closed: 0, tickets: [] };

  const log = loadRepairTickets();
  const actor = cleanOptional(by) || 'notes_import';
  const note = cleanOptional(noteText);
  const at = nowIso();
  let closed = 0;
  const closedTickets = [];

  for (let i = 0; i < log.length; i++) {
    const ticket = normalizeRepairTicket(log[i]);
    if (serialKey(ticket.serialNumber) !== key) continue;
    if (isClosedRepairStatus(ticket.status)) continue;
    if (!shouldAutoCompleteRepairOnNotes(ticket.status)) continue;

    ticket.status = 'resolved';
    ticket.statusAt = at;
    ticket.resolvedAt = at;
    ticket.resolvedBy = actor;
    ticket.statusHistory = ticket.statusHistory || [];
    ticket.statusHistory.push({
      at,
      status: 'resolved',
      by: actor,
      note: 'Auto-completed when notes were imported (workstation / PowerShell)'
    });
    ticket.notes = ticket.notes || [];
    ticket.notes.push({
      at,
      by: actor,
      text: note
        ? `Notes import completed this To do: ${note}`
        : 'Notes import completed this To do.'
    });
    log[i] = normalizeRepairTicket(ticket);
    try {
      applyRepairToDevice(
        log[i],
        buildRepairNoteText(log[i], 'Completed via notes import'),
        'repair_resolved'
      );
    } catch (e) {
      console.error('autoCompleteRepairOnNotesImport device', e.message);
    }
    closed += 1;
    closedTickets.push(log[i].serialNumber);
  }

  if (closed) saveRepairTickets(log);
  return { closed, tickets: closedTickets };
}

function isWaitingCaseRepairTicket(row) {
  return repairPipelineForStatus(row && row.status).key === 'needs'
    && String((row && row.status) || '') === 'ms_waiting_case';
}

function isPipelineTicket(row, pipelineKey) {
  if (!row) return false;
  if (pipelineKey === 'done') return isClosedRepairStatus(row.status || 'open');
  if (isClosedRepairStatus(row.status || 'open')) return false;
  return repairPipelineForStatus(row.status).key === pipelineKey;
}

const MS_REJECT_REASONS = Object.freeze([
  'Fraud',
  'No proof of purchase',
  'Not responded on time',
  'Out of warranty',
  'Damage not covered',
  'Liquid damage',
  'Wrong serial number',
  'Banned / not eligible',
  'School lock / MDM',
  'Reported stolen',
  'Not accepted',
  'Unknown',
  'Other'
]);

const REPAIR_QUICK_TAGS = Object.freeze([
  'No power',
  'Screen issue',
  'Battery',
  'Keyboard / trackpad',
  'Ports / charging',
  'Cosmetic damage',
  'Overheating',
  'Boot / BIOS',
  'Liquid damage',
  'DOA',
  'Customer remorse',
  'Wrong item',
  'Other'
]);

function cleanOptional(value) {
  const s = String(value == null ? '' : value).trim();
  return s || null;
}

function isClosedRepairStatus(status) {
  const meta = REPAIR_STATUSES[String(status || '').trim()];
  return !!(meta && meta.closed);
}

function isOpenRepairTicket(row) {
  if (!row || typeof row !== 'object') return false;
  return !isClosedRepairStatus(row.status || 'open');
}

/** Units back from MS (or marked received) awaiting physical check before Resolve. */
function isArrivedRepairTicket(row) {
  if (!row || typeof row !== 'object') return false;
  if (isClosedRepairStatus(row.status || 'open')) return false;
  return repairPipelineForStatus(row.status).key === 'checkin';
}

function normalizeRepairStatus(value) {
  const key = String(value || '').trim();
  return REPAIR_STATUSES[key] ? key : 'open';
}

function normalizeMsProgram(value) {
  const key = String(value || '').trim();
  return MS_PROGRAMS[key] ? key : null;
}

function newRepairId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRepairTicket(row) {
  const raw = row && typeof row === 'object' ? row : {};
  const at = raw.at || nowIso();
  const status = normalizeRepairStatus(raw.status || 'open');
  const notes = Array.isArray(raw.notes)
    ? raw.notes.filter((n) => n && String(n.text || '').trim()).map((n) => ({
      at: n.at || at,
      by: cleanOptional(n.by),
      text: String(n.text || '').trim().slice(0, 4000)
    }))
    : [];
  const statusHistory = Array.isArray(raw.statusHistory)
    ? raw.statusHistory.filter((h) => h && h.status).map((h) => ({
      at: h.at || at,
      status: normalizeRepairStatus(h.status),
      by: cleanOptional(h.by),
      note: cleanOptional(h.note)
    }))
    : [];
  if (!statusHistory.length) {
    statusHistory.push({ at, status, by: cleanOptional(raw.reportedBy), note: 'Ticket opened' });
  }
  return {
    id: cleanOptional(raw.id) || `${at}:${String(raw.serialNumber || '').trim()}`,
    at,
    serialNumber: String(raw.serialNumber || '').trim(),
    issue: String(raw.issue || '').trim(),
    quickTag: cleanOptional(raw.quickTag),
    status,
    statusAt: raw.statusAt || at,
    statusHistory,
    notes,
    reportedBy: cleanOptional(raw.reportedBy),
    source: cleanOptional(raw.source) || 'unknown',
    msProgram: normalizeMsProgram(raw.msProgram),
    msCaseId: cleanOptional(raw.msCaseId),
    msRelatedCases: Array.isArray(raw.msRelatedCases)
      ? raw.msRelatedCases.map((c) => cleanOptional(c)).filter(Boolean).slice(0, 20)
      : [],
    msOrderNumber: cleanOptional(raw.msOrderNumber),
    msDeviceModel: cleanOptional(raw.msDeviceModel),
    msSiblingSerials: Array.isArray(raw.msSiblingSerials)
      ? raw.msSiblingSerials.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean).slice(0, 40)
      : [],
    msRejectReason: cleanOptional(raw.msRejectReason),
    outboundTracking: cleanOptional(raw.outboundTracking),
    inboundTracking: cleanOptional(raw.inboundTracking),
    msReturnLabelTracking: cleanOptional(raw.msReturnLabelTracking),
    msDefectiveSerial: cleanOptional(raw.msDefectiveSerial)
      ? String(raw.msDefectiveSerial).trim().toUpperCase()
      : null,
    msReplacementSerial: cleanOptional(raw.msReplacementSerial)
      ? String(raw.msReplacementSerial).trim().toUpperCase()
      : null,
    msSerialHistory: Array.isArray(raw.msSerialHistory)
      ? raw.msSerialHistory.filter((h) => h && (h.serial || h.sn)).map((h) => ({
        at: cleanOptional(h.at),
        serial: String(h.serial || h.sn || '').trim().toUpperCase(),
        role: cleanOptional(h.role) || 'unknown'
      })).slice(-20)
      : [],
    shippedAt: cleanOptional(raw.shippedAt),
    expectedBackAt: cleanOptional(raw.expectedBackAt),
    vendorName: cleanOptional(raw.vendorName),
    resolvedAt: cleanOptional(raw.resolvedAt),
    resolvedBy: cleanOptional(raw.resolvedBy),
    msShippingLabels: Array.isArray(raw.msShippingLabels)
      ? raw.msShippingLabels.filter((l) => l && (l.id || l.filename)).map((l) => ({
        id: cleanOptional(l.id),
        filename: cleanOptional(l.filename),
        storedName: cleanOptional(l.storedName),
        uid: l.uid != null ? Number(l.uid) : null,
        size: l.size != null ? Number(l.size) : null,
        at: cleanOptional(l.at),
        downloadPath: cleanOptional(l.downloadPath)
      }))
      : [],
    msEmailEvents: Array.isArray(raw.msEmailEvents)
      ? raw.msEmailEvents.filter((e) => e && (e.at || e.emailDate || e.subject)).map((e) => ({
        at: cleanOptional(e.at),
        emailDate: cleanOptional(e.emailDate),
        subject: cleanOptional(e.subject),
        from: cleanOptional(e.from),
        uid: e.uid != null ? Number(e.uid) : null,
        changes: Array.isArray(e.changes) ? e.changes.map((c) => String(c).slice(0, 200)).slice(0, 40) : []
      })).slice(-40)
      : [],
    // Turn-based: MS emailed us and we have not replied yet
    msNeedsReply: raw.msNeedsReply === true,
    msNeedsReplyUid: raw.msNeedsReplyUid != null ? Number(raw.msNeedsReplyUid) : null,
    msNeedsReplyAt: cleanOptional(raw.msNeedsReplyAt),
    msNeedsReplySubject: cleanOptional(raw.msNeedsReplySubject),
    msLastReplyAt: cleanOptional(raw.msLastReplyAt),
    msLastReplyDraftId: cleanOptional(raw.msLastReplyDraftId),
    // Operator briefing — first outbound to MS is often missing from inbox
    msCaseBriefing: cleanOptional(raw.msCaseBriefing)
      ? String(raw.msCaseBriefing).trim().slice(0, 4000)
      : null,
    msTroubleshootingNote: cleanOptional(raw.msTroubleshootingNote)
      ? String(raw.msTroubleshootingNote).trim().slice(0, 4000)
      : null
  };
}

function loadRepairTickets() {
  const log = loadJson(REPAIR_NEEDED_PATH, []);
  if (!Array.isArray(log)) throw new Error('repair_needed.json is not an array');
  return log.map(normalizeRepairTicket);
}

function saveRepairTickets(rows) {
  saveJson(REPAIR_NEEDED_PATH, rows.map(normalizeRepairTicket));
}

function repairStatusLabel(status) {
  const meta = REPAIR_STATUSES[normalizeRepairStatus(status)];
  return meta ? meta.label : 'Open / issue noted';
}

function buildRepairNoteText(ticket, extraNote) {
  const parts = [
    `REPAIR: ${repairStatusLabel(ticket.status).toUpperCase()}`,
    ticket.issue || null,
    ticket.quickTag ? `Tag: ${ticket.quickTag}` : null,
    ticket.msProgram && MS_PROGRAMS[ticket.msProgram]
      ? `MS program: ${MS_PROGRAMS[ticket.msProgram].label}`
      : null,
    ticket.msCaseId ? `MS case: ${ticket.msCaseId}` : null,
    ticket.msOrderNumber ? `MS order: ${ticket.msOrderNumber}` : null,
    ticket.status === 'ms_rejected' && ticket.msRejectReason
      ? `MS reject reason: ${ticket.msRejectReason}`
      : null,
    ticket.outboundTracking ? `Outbound TN: ${ticket.outboundTracking}` : null,
    ticket.inboundTracking ? `Inbound TN: ${ticket.inboundTracking}` : null,
    ticket.msDefectiveSerial ? `Defective SN: ${ticket.msDefectiveSerial}` : null,
    ticket.msReplacementSerial ? `Replacement SN: ${ticket.msReplacementSerial}` : null,
    ticket.vendorName ? `Vendor: ${ticket.vendorName}` : null,
    extraNote ? `Note: ${extraNote}` : null
  ].filter(Boolean);
  return parts.join(' · ').slice(0, 2000);
}

function applyRepairToDevice(ticket, noteText, historyType) {
  const found = findDeviceBySerial(ticket.serialNumber);
  if (!found) return false;
  const existing = found.device;
  const meta = {
    stage: inferTrackingStage(found.trackingItem),
    trackingNumber: found.trackingItem.trackingNumber,
    source: found.trackingItem.source || null,
    vendor: found.trackingItem.vendor || null
  };
  const closed = isClosedRepairStatus(ticket.status);
  const merged = {
    ...existing,
    repairNeeded: !closed,
    repairIssue: closed ? null : (ticket.issue || null),
    repairReportedAt: closed ? null : (ticket.at || null),
    repairStatus: ticket.status,
    repairStatusAt: ticket.statusAt || nowIso(),
    repairMsProgram: ticket.msProgram || null,
    repairMsCaseId: ticket.msCaseId || null,
    repairOutboundTracking: ticket.outboundTracking || null,
    repairInboundTracking: ticket.inboundTracking || null,
    repairResolvedAt: closed ? (ticket.resolvedAt || nowIso()) : null,
    notes: noteText
  };
  merged.deviceHistory = Array.isArray(existing.deviceHistory) ? existing.deviceHistory : [];
  merged.noteLog = Array.isArray(existing.noteLog) ? existing.noteLog : [];
  appendNoteLog(merged, noteText, {
    ...meta,
    reason: closed ? 'repair_resolved' : 'repair_needed'
  });
  appendDeviceHistory(merged, {
    type: historyType || (closed ? 'repair_resolved' : 'repair_needed'),
    stage: meta.stage || STAGES.INBOUND,
    trackingNumber: meta.trackingNumber,
    note: ticket.issue || noteText,
    reason: closed ? 'repair_resolved' : 'repair_status'
  }, { force: true });
  found.trackingItem.devices[found.deviceIndex] = merged;
  if (found.archived) global.saveArchivedTrackingData();
  else global.saveTrackingData();
  return true;
}

function nowIso() {
  return new Date().toISOString();
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('warranty_repair loadJson', filePath, e.message);
    return fallback;
  }
}

function saveJson(filePath, data) {
  atomicWriteJsonSync(filePath, data);
}

function serialKey(sn) {
  return String(sn || '').trim().toLowerCase();
}

function findDeviceBySerial(serial) {
  const key = serialKey(serial);
  if (!key) return null;

  function search(list, archived) {
    for (const trackingItem of list || []) {
      const devices = trackingItem.devices || [];
      for (let i = 0; i < devices.length; i++) {
        const d = devices[i];
        if (d && d.serialNumber && String(d.serialNumber).toLowerCase() === key) {
          return { trackingItem, deviceIndex: i, device: d, archived: !!archived };
        }
      }
    }
    return null;
  }

  return search(global.trackingData, false) || search(global.archivedTrackingData, true);
}

function buildMsWarranty(body, serialNumber) {
  return {
    serialNumber: serialNumber,
    deviceName: body.deviceName || null,
    imageUrl: body.imageUrl || null,
    standardWarrantyText: body.standardWarrantyText || null,
    expiresOn: body.expiresOn || null,
    summary: body.summary || null,
    status: body.status || null,
    checkedAt: body.checkedAt || nowIso(),
    message: body.message || null
  };
}

function isBlankField(value) {
  if (value == null) return true;
  const text = String(value).trim();
  if (!text) return true;
  if (text === '—' || text === '–' || text === '-') return true;
  return ['unknown', 'n/a', 'na', 'none', 'null', '?'].includes(text.toLowerCase());
}

/** Normalize RAM/storage display values to whole GB (e.g. "1TB" -> 1024, "16 GB" -> 16). */
function toGbNumber(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(TB|GB|G|T)?$/i);
  if (!match) {
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  let amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] || '').toUpperCase();
  if (unit === 'TB' || unit === 'T') amount *= 1024;
  return Math.round(amount);
}

function sameGb(a, b) {
  const left = toGbNumber(a);
  const right = toGbNumber(b);
  return left != null && right != null && left === right;
}

/** "Surface Pro 7 - i7/16/256 M1866" -> "Surface Pro 7" */
function modelFromDeviceName(deviceName) {
  const raw = String(deviceName || '').trim();
  if (!raw) return null;
  const base = raw.split(' - ')[0].trim();
  return base || raw;
}

/**
 * Pull RAM/storage (and a short CPU token when present) out of Microsoft device names.
 * Examples:
 *   "Surface Laptop 7 - Copilot+ PC - 15 in. Elite/16/1TB"
 *   "Surface Laptop 4 - 15 in. i7/32/1TB"
 *   "Surface Pro 9 - i7/16/512"
 *   "Surface Pro 4 - 256GB i5 8GB"
 */
function parseWarrantyHardware(deviceName) {
  const raw = String(deviceName || '').trim();
  const out = { ram: null, hd: null, cpuToken: null };
  if (!raw) return out;

  // Tier or CPU + ram + storage: Elite/16/1TB, Plus/16/512, i7/32/1TB, Ultra 5/16/512
  const slash = raw.match(
    /\b((?:Ultra\s*)?\d*|i\d+|R\d+|SQ\d+|[A-Za-z][A-Za-z0-9]*)\s*\/\s*(\d+)\s*\/\s*(\d+(?:\.\d+)?\s*(?:TB|GB)?)\b/i
  );
  if (slash) {
    const token = String(slash[1] || '').trim();
    const ram = Number(slash[2]);
    let hd = toGbNumber(slash[3]);
    // Bare "/1" or "/2" in this position means TB in MS marketing strings.
    if (hd != null && hd > 0 && hd <= 8 && !/TB|GB/i.test(slash[3])) {
      hd *= 1024;
    }
    if (ram > 0 && ram <= 128) out.ram = ram;
    if (hd != null && hd >= 64) out.hd = hd;
    // Intel/AMD tokens, or MS marketing tiers used when a full CPU string is absent.
    if (/^(?:i\d+|R\d+|SQ\d+|Ultra\s*\d+|Elite|Plus|X\s*Plus|X\s*Elite)$/i.test(token)) {
      out.cpuToken = token.replace(/\s+/g, ' ');
    }
    return out;
  }

  // Classic: "Surface Pro 4 - 256GB i5 8GB"
  const classic = raw.match(/(\d+)\s*GB\b.*?\b(\d+)\s*GB\b/i);
  if (classic) {
    const storage = Number(classic[1]);
    const ram = Number(classic[2]);
    if (storage >= 64) out.hd = storage;
    if (ram > 0 && ram <= 128) out.ram = ram;
  }

  const tb = raw.match(/\b(\d+(?:\.\d+)?)\s*TB\b/i);
  if (tb && out.hd == null) {
    out.hd = Math.round(Number(tb[1]) * 1024);
  }

  if (!out.cpuToken) {
    const cpuClassic = raw.match(/\b(i\d+|R\d+|SQ\d+|Ultra\s*\d+|Elite|Plus|X\s*Plus|X\s*Elite)\b/i);
    if (cpuClassic) {
      out.cpuToken = cpuClassic[1].replace(/\s+/g, ' ').trim();
    }
  }

  return out;
}

/**
 * Apply Microsoft warranty hardware onto the local device record.
 *
 * Warranty wins for model / RAM / HD when Microsoft publishes a clear value —
 * that corrects bad local reads (e.g. a plugged-in USB stick reported as HD).
 * Windows edition/version is ALWAYS left alone; that only comes from the device.
 */
function applyWarrantyGaps(device, warranty) {
  const next = { ...(device || {}) };
  const filled = [];
  if (!warranty || typeof warranty !== 'object') {
    return { device: next, filled };
  }

  // Never rewrite Windows from warranty — local WMI/scan is the source of truth
  // for Home vs Pro and build strings.
  const preservedWindows = next.windowsVersion;

  next.msWarranty = warranty;
  const deviceName = String(warranty.deviceName || '').trim();
  const hw = parseWarrantyHardware(deviceName);

  if (deviceName) {
    const model = modelFromDeviceName(deviceName);
    if (model && (isBlankField(next.model) || String(next.model).trim() !== model)) {
      // Prefer the short MS family name when local is blank or a different marketing string.
      if (isBlankField(next.model) || /microsoft\s+surface/i.test(String(next.model))) {
        next.model = model;
        filled.push('model');
      }
    }
  }

  if (hw.ram != null && (isBlankField(next.ram) || !sameGb(next.ram, hw.ram))) {
    next.ram = hw.ram;
    filled.push('ram');
  }

  if (hw.hd != null && (isBlankField(next.hd) || !sameGb(next.hd, hw.hd))) {
    next.hd = hw.hd;
    filled.push('hd');
  }

  // Only seed a short CPU token when local CPU is missing — never replace a full
  // local CPU string like "Snapdragon(R) X 12-core ..." with "i7".
  if (hw.cpuToken && isBlankField(next.cpu)) {
    next.cpu = hw.cpuToken;
    filled.push('cpu');
  }

  next.windowsVersion = preservedWindows;

  return { device: next, filled };
}

function emptyQueueState() {
  return { pending: [], running: null, recent: [] };
}

function loadQueueState() {
  const raw = loadJson(WARRANTY_QUEUE_PATH, null);
  if (!raw || typeof raw !== 'object') return emptyQueueState();
  return {
    pending: Array.isArray(raw.pending) ? raw.pending : [],
    running: raw.running && typeof raw.running === 'object' ? raw.running : null,
    recent: Array.isArray(raw.recent) ? raw.recent : []
  };
}

function saveQueueState(state) {
  saveJson(WARRANTY_QUEUE_PATH, {
    pending: state.pending || [],
    running: state.running || null,
    recent: (state.recent || []).slice(0, QUEUE_MAX_DONE),
    updatedAt: nowIso()
  });
}

function usableCachedWarranty(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const status = String(entry.status || '').toUpperCase();
  if (status === 'ERROR') return false;
  return !!(
    entry.deviceName
    || entry.expiresOn
    || entry.standardWarrantyText
    || entry.summary
    || status === 'IN_WARRANTY'
    || status === 'EXPIRED'
    || status === 'UNKNOWN'
  );
}

function findRecentJob(state, key) {
  return (state.recent || []).find((row) => serialKey(row.serialNumber) === key) || null;
}

function queuePosition(state, key) {
  if (state.running && serialKey(state.running.serialNumber) === key) return 0;
  const idx = (state.pending || []).findIndex((row) => serialKey(row.serialNumber) === key);
  return idx >= 0 ? idx + 1 : null;
}

/** Run the Microsoft warranty checker for one serial (same as device_single_update). */
function runWarrantyCheck(serialNumber) {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [WARRANTY_SCRIPT, '--serial', serialNumber, '--json', '--sleep-extra', '0'],
      { cwd: ROOT, timeout: WARRANTY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(error.killed ? 'Microsoft warranty lookup timed out' : error.message));
          return;
        }
        const line = String(stdout || '')
          .split('\n')
          .reverse()
          .find((l) => l.includes(RESULT_MARKER));
        if (!line) {
          reject(new Error(`Warranty lookup produced no result. ${String(stderr || '').slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(line.slice(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length).trim());
          resolve(Array.isArray(parsed) ? parsed[0] || null : parsed);
        } catch (e) {
          reject(new Error(`Could not parse warranty result: ${e.message}`));
        }
      }
    );
  });
}

function isCaptchaFailure(result) {
  const message = String((result && result.message) || '');
  return /captcha/i.test(message);
}

/**
 * Sequential background warranty worker for Fast Scan.
 * Concurrency 1 — Microsoft rate-limits hard.
 */
function createWarrantyQueueWorker() {
  let busy = false;
  let kickTimer = null;

  function persistPushRecent(state, job) {
    state.recent = [job].concat((state.recent || []).filter(
      (row) => serialKey(row.serialNumber) !== serialKey(job.serialNumber)
    )).slice(0, QUEUE_MAX_DONE);
  }

  async function processOne(job) {
    const sn = String(job.serialNumber || '').trim();
    let result = null;
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await runWarrantyCheck(sn);
        if (result && String(result.status || '').toUpperCase() === 'ERROR' && isCaptchaFailure(result)) {
          lastError = result.message || 'captcha';
          if (attempt === 0) continue;
        }
        break;
      } catch (e) {
        lastError = e.message || String(e);
        if (attempt === 0 && /captcha/i.test(lastError)) continue;
        break;
      }
    }

    const state = loadQueueState();
    state.running = null;

    if (result && String(result.status || '').toUpperCase() !== 'ERROR' && usableCachedWarranty(result)) {
      persistPushRecent(state, {
        serialNumber: sn,
        state: 'done',
        finishedAt: nowIso(),
        warranty: result,
        message: null
      });
    } else {
      const message = (result && result.message) || lastError || 'Warranty lookup failed';
      persistPushRecent(state, {
        serialNumber: sn,
        state: 'error',
        finishedAt: nowIso(),
        warranty: result || null,
        message
      });
    }

    saveQueueState(state);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      while (true) {
        const state = loadQueueState();
        // Re-queue a job that was mid-flight when the process restarted.
        if (state.running && state.running.serialNumber) {
          const sn = String(state.running.serialNumber).trim();
          if (sn && !(state.pending || []).some((row) => serialKey(row.serialNumber) === serialKey(sn))) {
            state.pending.unshift({
              serialNumber: sn,
              queuedAt: state.running.queuedAt || nowIso(),
              retries: state.running.retries || 0
            });
          }
          state.running = null;
          saveQueueState(state);
        }

        const next = (state.pending || [])[0];
        if (!next) break;

        state.pending = state.pending.slice(1);
        state.running = {
          serialNumber: next.serialNumber,
          queuedAt: next.queuedAt || nowIso(),
          startedAt: nowIso(),
          retries: next.retries || 0
        };
        saveQueueState(state);

        await processOne(state.running);
      }
    } catch (e) {
      console.error('warranty queue worker', e.message);
      try {
        const state = loadQueueState();
        if (state.running) {
          persistPushRecent(state, {
            serialNumber: state.running.serialNumber,
            state: 'error',
            finishedAt: nowIso(),
            warranty: null,
            message: e.message || 'worker failed'
          });
          state.running = null;
          saveQueueState(state);
        }
      } catch (inner) {
        console.error('warranty queue recover', inner.message);
      }
    } finally {
      busy = false;
    }
  }

  function kick() {
    if (kickTimer) return;
    kickTimer = setTimeout(() => {
      kickTimer = null;
      tick().catch((e) => console.error('warranty queue tick', e.message));
    }, 25);
  }

  function enqueue(serialNumber, force) {
    const sn = String(serialNumber || '').trim();
    if (!sn) {
      return { ok: false, error: 'serialNumber required' };
    }

    const key = serialKey(sn);
    const cache = loadJson(WARRANTY_CACHE_PATH, {});
    const cached = cache[key] || null;
    if (!force && usableCachedWarranty(cached)) {
      return {
        ok: true,
        state: 'done',
        position: null,
        cached: true,
        warranty: cached,
        serialNumber: sn
      };
    }

    const state = loadQueueState();
    if (state.running && serialKey(state.running.serialNumber) === key) {
      return {
        ok: true,
        state: 'running',
        position: 0,
        cached: false,
        serialNumber: sn
      };
    }

    const pendingIdx = (state.pending || []).findIndex((row) => serialKey(row.serialNumber) === key);
    if (pendingIdx >= 0) {
      return {
        ok: true,
        state: 'queued',
        position: pendingIdx + 1,
        cached: false,
        serialNumber: sn
      };
    }

    state.pending.push({ serialNumber: sn, queuedAt: nowIso(), retries: 0 });
    // Drop a stale recent error/done so status reflects the new job.
    state.recent = (state.recent || []).filter((row) => serialKey(row.serialNumber) !== key);
    saveQueueState(state);
    kick();

    return {
      ok: true,
      state: 'queued',
      position: state.pending.length,
      cached: false,
      serialNumber: sn
    };
  }

  function statusFor(serialNumber) {
    const sn = String(serialNumber || '').trim();
    if (!sn) return { ok: false, error: 'serialNumber required' };
    const key = serialKey(sn);
    const state = loadQueueState();

    if (state.running && serialKey(state.running.serialNumber) === key) {
      return {
        ok: true,
        serialNumber: sn,
        state: 'running',
        position: 0,
        warranty: null,
        message: null
      };
    }

    const pos = queuePosition(state, key);
    if (pos != null && pos > 0) {
      return {
        ok: true,
        serialNumber: sn,
        state: 'queued',
        position: pos,
        warranty: null,
        message: null
      };
    }

    const recent = findRecentJob(state, key);
    if (recent) {
      return {
        ok: true,
        serialNumber: sn,
        state: recent.state || 'done',
        position: null,
        warranty: recent.warranty || null,
        message: recent.message || null
      };
    }

    const cache = loadJson(WARRANTY_CACHE_PATH, {});
    const cached = cache[key] || null;
    if (usableCachedWarranty(cached)) {
      return {
        ok: true,
        serialNumber: sn,
        state: 'done',
        position: null,
        warranty: cached,
        message: null
      };
    }

    return {
      ok: true,
      serialNumber: sn,
      state: 'none',
      position: null,
      warranty: null,
      message: null
    };
  }

  // Resume any leftover pending jobs after process start.
  kick();

  return { enqueue, statusFor, kick };
}

function setupWarrantyRepair(app) {
  const warrantyQueue = createWarrantyQueueWorker();

  app.post('/android/warranty/queue', (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const serialNumber = String((req.body && req.body.serialNumber) || '').trim();
      const force = req.body && req.body.force === true;
      const result = warrantyQueue.enqueue(serialNumber, force);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error('/android/warranty/queue', e.message);
      return res.status(500).json({ ok: false, error: e.message || 'queue failed' });
    }
  });

  app.get('/android/warranty/status/:serialNumber', (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const result = warrantyQueue.statusFor(req.params.serialNumber);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    } catch (e) {
      console.error('/android/warranty/status', e.message);
      return res.status(500).json({ ok: false, error: e.message || 'status failed' });
    }
  });

  app.post('/save-warranty', (req, res) => {
    try {
      const body = req.body || {};
      const serialNumber = String(body.serialNumber || '').trim();
      if (!serialNumber) {
        return res.status(400).json({ error: 'serialNumber required' });
      }

      const entry = buildMsWarranty(body, serialNumber);
      const cache = loadJson(WARRANTY_CACHE_PATH, {});
      cache[serialKey(serialNumber)] = entry;
      saveJson(WARRANTY_CACHE_PATH, cache);

      let deviceUpdated = false;
      let filledFields = [];
      let found = findDeviceBySerial(serialNumber);
      let supplemental = false;
      if (!found) {
        // Repair / warranty-only serials live outside tracking batches.
        const device = supplementalDevices.ensureFromKnownSources(serialNumber);
        if (device) {
          found = { device, trackingItem: null, deviceIndex: -1, archived: false };
          supplemental = true;
        }
      }
      if (found) {
        const applied = applyWarrantyGaps(found.device, entry);
        applied.device.warrantyDeviceName = entry.deviceName || applied.device.warrantyDeviceName || null;
        applied.device.warrantyStatus = entry.status || applied.device.warrantyStatus || null;
        applied.device.warrantyExpiresOn = entry.expiresOn || applied.device.warrantyExpiresOn || null;
        applied.device.warrantyText = entry.standardWarrantyText || applied.device.warrantyText || null;
        filledFields = applied.filled;
        if (filledFields.length) {
          const meta = {
            stage: found.trackingItem ? inferTrackingStage(found.trackingItem) : STAGES.INBOUND,
            trackingNumber: found.trackingItem ? found.trackingItem.trackingNumber : null,
            source: found.trackingItem ? (found.trackingItem.source || null) : 'warranty_only',
            vendor: found.trackingItem ? (found.trackingItem.vendor || null) : null
          };
          appendDeviceHistory(applied.device, {
            type: 'warranty_backfill',
            stage: meta.stage || STAGES.INBOUND,
            trackingNumber: meta.trackingNumber,
            note: `Corrected from warranty: ${filledFields.join(', ')}`,
            reason: 'warranty_gap_fill'
          }, { force: true });
        }
        if (supplemental) {
          supplementalDevices.save(applied.device);
        } else {
          found.trackingItem.devices[found.deviceIndex] = applied.device;
          if (found.archived) {
            global.saveArchivedTrackingData();
          } else {
            global.saveTrackingData();
          }
        }
        deviceUpdated = true;
      }

      res.json({
        ok: true,
        deviceUpdated,
        filledFields,
        supplemental,
        warranty: entry
      });
    } catch (e) {
      console.error('/save-warranty', e);
      res.status(500).json({ error: e.message || 'save-warranty failed' });
    }
  });

  app.get('/warranty/:serialNumber', (req, res) => {
    try {
      const serialNumber = String(req.params.serialNumber || '').trim();
      if (!serialNumber) {
        return res.status(400).json({ error: 'serialNumber required' });
      }
      const cache = loadJson(WARRANTY_CACHE_PATH, {});
      const cached = cache[serialKey(serialNumber)] || null;
      const found = findDeviceBySerial(serialNumber);
      const onDevice = found && found.device.msWarranty ? found.device.msWarranty : null;
      res.json({
        serialNumber,
        cached,
        onDevice,
        warranty: onDevice || cached || null
      });
    } catch (e) {
      console.error('/warranty/:serialNumber', e);
      res.status(500).json({ error: e.message || 'warranty lookup failed' });
    }
  });

  app.post('/api/warranty/fill-gaps', (req, res) => {
    try {
      if (!req.session || !req.session.loggedIn) {
        return res.status(401).json({ error: 'Login required' });
      }
      if (req.get('x-requested-with') !== 'OrderAssistWarranty') {
        return res.status(403).json({ error: 'Invalid request' });
      }
      res.set('Cache-Control', 'no-store');

      const cache = loadJson(WARRANTY_CACHE_PATH, {});
      const fieldCounts = {};
      let updatedDevices = 0;
      let stillBlankModel = 0;
      let touchedActive = false;
      let touchedArchive = false;

      function blankModel(device) {
        return isBlankField(device && device.model);
      }

      function processList(list, archived) {
        for (const trackingItem of list || []) {
          const devices = trackingItem.devices || [];
          for (let i = 0; i < devices.length; i += 1) {
            const device = devices[i];
            if (!device) continue;
            const sn = String(device.serialNumber || '').trim();
            const onDevice = device.msWarranty && typeof device.msWarranty === 'object'
              ? device.msWarranty
              : null;
            const cached = sn ? cache[serialKey(sn)] : null;
            const warranty = (onDevice && onDevice.deviceName) ? onDevice
              : (cached && cached.deviceName) ? cached
              : onDevice || cached || null;

            if (!warranty) {
              if (blankModel(device)) stillBlankModel += 1;
              continue;
            }

            const applied = applyWarrantyGaps(device, warranty);
            if (!applied.filled.length) {
              if (blankModel(applied.device)) stillBlankModel += 1;
              continue;
            }

            if (applied.filled.length) {
              appendDeviceHistory(applied.device, {
                type: 'warranty_backfill',
                stage: inferTrackingStage(trackingItem) || STAGES.INBOUND,
                trackingNumber: trackingItem.trackingNumber,
                note: `Corrected from warranty: ${applied.filled.join(', ')}`,
                reason: 'warranty_gap_fill_api'
              }, { force: true });
            }

            trackingItem.devices[i] = applied.device;
            updatedDevices += 1;
            applied.filled.forEach((field) => {
              fieldCounts[field] = (fieldCounts[field] || 0) + 1;
            });
            if (archived) touchedArchive = true;
            else touchedActive = true;
            if (blankModel(applied.device)) stillBlankModel += 1;
          }
        }
      }

      processList(global.trackingData, false);
      processList(global.archivedTrackingData, true);

      if (touchedActive && typeof global.saveTrackingData === 'function') {
        global.saveTrackingData();
      }
      if (touchedArchive && typeof global.saveArchivedTrackingData === 'function') {
        global.saveArchivedTrackingData();
      }

      res.json({
        ok: true,
        updatedDevices,
        fieldCounts,
        stillBlankModel
      });
    } catch (e) {
      console.error('/api/warranty/fill-gaps', e);
      res.status(500).json({ error: e.message || 'fill-gaps failed' });
    }
  });

  function requireConsoleAuth(req, res, next) {
    if (!req.session || !req.session.loggedIn) {
      return res.status(401).json({ error: 'Login required' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  }

  function loadMsDraftsForReplyTurns() {
    try {
      const data = loadJson(MS_DRAFTS_PATH, []);
      return Array.isArray(data) ? data : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Ignore auto-receipts / our own mail when deciding whose turn it is.
   * Real “Need a reply” is only for Microsoft (or Abe-forwarded MS) messages.
   */
  function isIgnorableInboundForReplyTurn(from, subject, preview) {
    const fromText = String(from || '');
    const subj = String(subject || '');
    const prev = String(preview || '');
    const blob = `${fromText}\n${subj}\n${prev}`.toLowerCase();
    const addrMatch = fromText.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
    const addr = (addrMatch ? addrMatch[1] : fromText).toLowerCase();

    if (addr === 'orderassistnow@gmail.com') return true;
    if (addr === 'ms-returns@orderassistnow.com') return true;
    if (/@orderassistnow\.com$/i.test(addr) && /no-?reply|mailer|daemon|bounce/i.test(addr)) return true;
    if (/noreply@|no-reply@|mailer-daemon@|postmaster@/i.test(addr)) return true;
    if (/automated receipt|auto[- ]?reply|automatic reply|out of office/i.test(blob)) return true;
    // Service Team auto from our Gmail path
    if (/service team/i.test(blob) && /orderassistnow@gmail\.com/i.test(blob)) return true;
    return false;
  }

  /**
   * Turn-based: need a reply if newest *actionable* inbound MS email has no sent draft yet.
   */
  function ticketNeedsMsReply(ticket, drafts) {
    if (!ticket) return false;
    const closed = ticket.status === 'resolved' || ticket.status === 'cannot_resolve';
    if (closed) return false;

    const caseId = String(ticket.msCaseId || '').trim();
    const events = Array.isArray(ticket.msEmailEvents) ? ticket.msEmailEvents : [];
    let latestUid = null;
    let latestT = -1;
    let latestEvent = null;
    for (const e of events) {
      if (!e || e.uid == null) continue;
      if (isIgnorableInboundForReplyTurn(e.from, e.subject, '')) continue;
      const t = Date.parse(e.emailDate || e.at || '') || 0;
      const uid = Number(e.uid);
      if (!latestEvent || t > latestT || (t === latestT && uid > latestUid)) {
        latestUid = uid;
        latestT = t;
        latestEvent = e;
      }
    }

    // Stored flag pointed at an ignorable uid — ignore it
    if (ticket.msNeedsReplyUid != null) {
      const flagged = events.find((e) => e && Number(e.uid) === Number(ticket.msNeedsReplyUid));
      if (flagged && isIgnorableInboundForReplyTurn(flagged.from, flagged.subject, '')) {
        // fall through to latest actionable only
      } else if (!latestEvent && ticket.msNeedsReply === true) {
        // keep flag only if we have no events to recompute from
        latestUid = Number(ticket.msNeedsReplyUid);
      }
    }

    if (latestUid == null) return false;

    const replied = (drafts || []).some((d) => {
      if (!d || d.status !== 'sent') return false;
      if (Number(d.inReplyToUid) !== Number(latestUid)) return false;
      if (String(d.ticketId) === String(ticket.id)) return true;
      if (caseId && String(d.msCaseId || '').trim() === caseId) return true;
      return false;
    });
    return !replied;
  }

  function enrichRepairRow(row, index, drafts) {
    const ticket = normalizeRepairTicket(row);
    const serialNumber = ticket.serialNumber;
    const found = findDeviceBySerial(serialNumber);
    const device = found && found.device ? found.device : null;
    const tracking = found && found.trackingItem ? found.trackingItem : null;
    const statusMeta = REPAIR_STATUSES[ticket.status] || REPAIR_STATUSES.open;
    const msMeta = ticket.msProgram ? MS_PROGRAMS[ticket.msProgram] : null;
    const pipeline = repairPipelineForStatus(ticket.status);
    const needsReply = ticketNeedsMsReply(ticket, drafts);
    ticket.msNeedsReply = needsReply;
    if (!needsReply) {
      ticket.msNeedsReplyUid = null;
      ticket.msNeedsReplyAt = null;
      ticket.msNeedsReplySubject = null;
    }
    const nextAction = nextActionForTicket(ticket);
    const cache = loadJson(WARRANTY_CACHE_PATH, {}) || {};
    const wKey = serialKey(serialNumber);
    const warranty = (wKey && (cache[wKey] || cache[serialNumber])) || null;
    const warrantyExpires = (warranty && (warranty.expiresOn || warranty.standardWarrantyText))
      || (device && (device.warrantyExpiresOn || device.expiresOn))
      || null;
    const warrantyStatus = (warranty && warranty.status)
      || (device && device.warrantyStatus)
      || null;
    const warrantyDeviceName = warranty && warranty.deviceName ? warranty.deviceName : null;
    const warrantyStandardText = (warranty && warranty.standardWarrantyText) || null;
    const warrantySummary = (warranty && warranty.summary) || null;
    const model = (device && (device.model || device.modelDetails))
      || warrantyDeviceName
      || null;
    let cpu = (device && device.cpu) || null;
    let ram = (device && device.ram) || null;
    let hd = (device && device.hd) || null;
    if (warrantyDeviceName && (isBlankField(cpu) || isBlankField(ram) || isBlankField(hd))) {
      const hw = parseWarrantyHardware(warrantyDeviceName);
      if (isBlankField(cpu) && hw.cpuToken) cpu = hw.cpuToken;
      if (isBlankField(ram) && hw.ram != null) ram = hw.ram;
      if (isBlankField(hd) && hw.hd != null) hd = hw.hd;
    }
    return {
      id: ticket.id || index,
      at: ticket.at,
      serialNumber,
      issue: ticket.issue,
      quickTag: ticket.quickTag,
      status: ticket.status,
      statusLabel: statusMeta.label,
      statusTone: statusMeta.tone,
      statusGroup: statusMeta.group,
      pipeline: pipeline.key,
      pipelineLabel: pipeline.label,
      pipelineHint: pipeline.short,
      nextActionTitle: nextAction.title,
      nextActionDetail: nextAction.detail,
      statusAt: ticket.statusAt,
      statusHistory: ticket.statusHistory,
      notes: ticket.notes,
      reportedBy: ticket.reportedBy,
      source: ticket.source,
      msProgram: ticket.msProgram,
      msProgramLabel: msMeta ? msMeta.label : null,
      msProgramHint: msMeta ? msMeta.hint : null,
      msCaseId: ticket.msCaseId,
      msRelatedCases: Array.isArray(ticket.msRelatedCases) ? ticket.msRelatedCases : [],
      msOrderNumber: ticket.msOrderNumber,
      msDeviceModel: ticket.msDeviceModel || null,
      msSiblingSerials: Array.isArray(ticket.msSiblingSerials) ? ticket.msSiblingSerials : [],
      msRejectReason: ticket.msRejectReason,
      outboundTracking: ticket.outboundTracking,
      inboundTracking: ticket.inboundTracking,
      msShippingLabels: Array.isArray(ticket.msShippingLabels) ? ticket.msShippingLabels : [],
      msEmailEvents: Array.isArray(ticket.msEmailEvents) ? ticket.msEmailEvents : [],
      msNeedsReply: needsReply,
      msNeedsReplyUid: ticket.msNeedsReplyUid || null,
      msNeedsReplyAt: ticket.msNeedsReplyAt || null,
      msNeedsReplySubject: ticket.msNeedsReplySubject || null,
      msLastReplyAt: ticket.msLastReplyAt || null,
      msCaseBriefing: ticket.msCaseBriefing || null,
      msTroubleshootingNote: ticket.msTroubleshootingNote || null,
      shippedAt: ticket.shippedAt,
      expectedBackAt: ticket.expectedBackAt,
      vendorName: ticket.vendorName,
      resolvedAt: ticket.resolvedAt,
      resolvedBy: ticket.resolvedBy,
      closed: !!statusMeta.closed,
      warrantyStatus,
      warrantyExpires,
      warrantyStandardText,
      warrantySummary,
      warrantyDeviceName,
      model,
      cpu,
      ram,
      hd,
      sku: (device && device.sku) || null,
      deviceNotes: (device && device.notes) || null,
      trackingNumber: (tracking && tracking.trackingNumber) || null,
      stage: tracking ? inferTrackingStage(tracking) : null,
      archived: found ? !!found.archived : null,
      orderNumber: (device && (device.orderNumberPrimary || device.orderNumber || device.order_number)) || null,
      found: !!found
    };
  }

  // Green nav badges: counts of things waiting for a human.
  app.get('/api/nav-badges', requireConsoleAuth, (req, res) => {
    try {
      const repairOpen = loadRepairTickets().filter(isOpenRepairTicket).length;

      let feedbackNew = 0;
      try {
        const helpIndex = path.join(ROOT, 'db', 'pwa_help', 'index.jsonl');
        const overridesPath = path.join(ROOT, 'db', 'pwa_help', 'public_status.json');
        let overrides = {};
        try {
          overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8')) || {};
        } catch (e) { /* no overrides yet */ }
        const lines = fs.readFileSync(helpIndex, 'utf8').split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            const row = JSON.parse(line);
            const override = overrides[row.id] && typeof overrides[row.id] === 'object'
              ? overrides[row.id]
              : {};
            const status = String(override.status || row.status || 'submitted').trim().toLowerCase();
            if (status === 'submitted') feedbackNew += 1;
          } catch (e) { /* skip bad line */ }
        }
      } catch (e) {
        if (e.code !== 'ENOENT') console.error('/api/nav-badges feedback', e.message);
      }

      let ordersOpen = 0;
      let ordersProblems = 0;
      try {
        const ordersDash = require('./orders_dashboard');
        ordersOpen = Number(
          typeof ordersDash.countOrdersNeedingAttention === 'function'
            ? ordersDash.countOrdersNeedingAttention()
            : ordersDash.countOrderProblems()
        ) || 0;
        ordersProblems = Number(ordersDash.countOrderProblems()) || 0;
      } catch (e) {
        console.error('/api/nav-badges orders', e.message);
      }

      let printersQueued = 0;
      try {
        const jobsPath = path.join(ROOT, 'db', 'print_jobs.json');
        const jobsData = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
        const jobs = Array.isArray(jobsData) ? jobsData : (jobsData && jobsData.jobs) || [];
        printersQueued = jobs.filter((j) => j && (j.status === 'queued' || j.status === 'printing')).length;
      } catch (e) {
        if (e.code !== 'ENOENT') console.error('/api/nav-badges printers', e.message);
      }

      const badges = {
        repair: repairOpen,
        orders: ordersOpen,
        updates: feedbackNew,
        printers: printersQueued
      };
      const titles = {
        repair: `${repairOpen} open repair ticket${repairOpen === 1 ? '' : 's'}`,
        orders: ordersProblems
          ? `${ordersOpen} need attention (${ordersProblems} problem${ordersProblems === 1 ? '' : 's'})`
          : `${ordersOpen} awaiting shipment / need attention`,
        updates: `${feedbackNew} new app feedback`,
        printers: `${printersQueued} print job${printersQueued === 1 ? '' : 's'} queued`
      };

      res.json({
        ok: true,
        badges,
        titles,
        detail: {
          repairOpen,
          ordersOpen,
          ordersProblems,
          feedbackNew,
          printersQueued
        }
      });
    } catch (e) {
      console.error('/api/nav-badges', e);
      res.status(500).json({ error: e.message || 'badges failed' });
    }
  });

  app.get('/api/repair-needed/meta', requireConsoleAuth, (req, res) => {
    res.json({
      ok: true,
      statuses: Object.keys(REPAIR_STATUSES).map((key) => ({
        key,
        ...REPAIR_STATUSES[key],
        pipeline: STATUS_PIPELINE[key] || 'todo'
      })),
      pipelines: Object.keys(MS_PIPELINE).map((key) => ({
        key,
        ...MS_PIPELINE[key]
      })),
      msPrograms: Object.keys(MS_PROGRAMS).map((key) => ({
        key,
        ...MS_PROGRAMS[key]
      })),
      quickTags: REPAIR_QUICK_TAGS.slice(),
      msRejectReasons: MS_REJECT_REASONS.slice()
    });
  });

  app.get('/api/repair-needed', requireConsoleAuth, (req, res) => {
    try {
      const include = String(req.query.include || 'open').trim().toLowerCase();
      const log = loadRepairTickets();
      let rows = log;
      if (include === 'closed') rows = log.filter((row) => !isOpenRepairTicket(row));
      else if (include !== 'all') rows = log.filter(isOpenRepairTicket);

      const drafts = loadMsDraftsForReplyTurns();
      const items = rows
        .map((row, index) => enrichRepairRow(row, index, drafts))
        .sort((a, b) => {
          // Need-a-reply tickets float near the top within same statusAt bucket
          if (!!b.msNeedsReply !== !!a.msNeedsReply) return b.msNeedsReply ? 1 : -1;
          return String(b.statusAt || b.at || '').localeCompare(String(a.statusAt || a.at || ''));
        });
      res.json({
        ok: true,
        count: items.length,
        openCount: log.filter(isOpenRepairTicket).length,
        waitingCaseCount: log.filter(isWaitingCaseRepairTicket).length,
        arrivedCount: log.filter(isArrivedRepairTicket).length,
        closedCount: log.filter((row) => !isOpenRepairTicket(row)).length,
        needsReplyCount: items.filter((r) => r.msNeedsReply).length,
        items
      });
    } catch (e) {
      console.error('/api/repair-needed', e);
      res.status(500).json({ error: e.message || 'repair list failed' });
    }
  });

  app.post('/api/repair-needed/update', requireConsoleAuth, (req, res) => {
    try {
      const body = req.body || {};
      const serialNumber = String(body.serialNumber || '').trim();
      const at = String(body.at || '').trim();
      const ticketId = cleanOptional(body.id);
      if (!serialNumber && !ticketId) {
        return res.status(400).json({ error: 'serialNumber or id required' });
      }

      const log = loadRepairTickets();
      const key = serialKey(serialNumber);
      const index = log.findIndex((row) => {
        if (ticketId && row.id === ticketId) return true;
        if (!key) return false;
        const sameSerial = serialKey(row.serialNumber) === key;
        const sameAt = !at || String(row.at || '') === at;
        return sameSerial && sameAt;
      });
      if (index < 0) {
        return res.status(404).json({ error: 'Repair ticket not found' });
      }

      const ticket = normalizeRepairTicket(log[index]);
      const actor = cleanOptional(body.by)
        || cleanOptional(req.session && (req.session.username || req.session.user))
        || 'console';
      const note = cleanOptional(body.note);
      const nextStatus = body.status != null
        ? normalizeRepairStatus(body.status)
        : ticket.status;

      if (body.issue != null) ticket.issue = String(body.issue || '').trim().slice(0, 500) || ticket.issue;
      if (body.quickTag != null) ticket.quickTag = cleanOptional(body.quickTag);
      if (body.msProgram != null) ticket.msProgram = normalizeMsProgram(body.msProgram);
      if (body.msCaseId != null) ticket.msCaseId = cleanOptional(body.msCaseId);
      if (body.msOrderNumber != null) ticket.msOrderNumber = cleanOptional(body.msOrderNumber);
      if (body.outboundTracking != null) ticket.outboundTracking = cleanOptional(body.outboundTracking);
      if (body.inboundTracking != null) ticket.inboundTracking = cleanOptional(body.inboundTracking);
      if (body.msDefectiveSerial != null) {
        ticket.msDefectiveSerial = cleanOptional(body.msDefectiveSerial)
          ? String(body.msDefectiveSerial).trim().toUpperCase()
          : null;
      }
      if (body.msReplacementSerial != null) {
        ticket.msReplacementSerial = cleanOptional(body.msReplacementSerial)
          ? String(body.msReplacementSerial).trim().toUpperCase()
          : null;
      }
      if (body.shippedAt != null) ticket.shippedAt = cleanOptional(body.shippedAt);
      if (body.expectedBackAt != null) ticket.expectedBackAt = cleanOptional(body.expectedBackAt);
      if (body.vendorName != null) ticket.vendorName = cleanOptional(body.vendorName);
      if (body.msRejectReason != null) ticket.msRejectReason = cleanOptional(body.msRejectReason);
      if (body.msCaseBriefing != null) {
        ticket.msCaseBriefing = cleanOptional(body.msCaseBriefing)
          ? String(body.msCaseBriefing).trim().slice(0, 4000)
          : null;
      }
      if (body.msTroubleshootingNote != null) {
        ticket.msTroubleshootingNote = cleanOptional(body.msTroubleshootingNote)
          ? String(body.msTroubleshootingNote).trim().slice(0, 4000)
          : null;
      }

      // Auto-fill Microsoft program when picking AE / same-unit statuses.
      if (nextStatus === 'ms_advanced_exchange') ticket.msProgram = 'advanced_exchange';
      if (nextStatus === 'ms_same_unit') ticket.msProgram = 'same_unit_repair';
      if (nextStatus === 'ms_approved_ship_ae') ticket.msProgram = 'advanced_exchange';
      if (nextStatus === 'ms_approved_ship_same') ticket.msProgram = 'same_unit_repair';
      if (nextStatus === 'ms_received_exchange' && !ticket.msProgram) ticket.msProgram = 'advanced_exchange';
      if (nextStatus === 'ms_received_same' && !ticket.msProgram) ticket.msProgram = 'same_unit_repair';
      if (nextStatus === 'ms_arrived_check' && !ticket.msProgram) ticket.msProgram = 'same_unit_repair';
      if (nextStatus === 'ms_shipped_outbound' && !ticket.shippedAt) {
        ticket.shippedAt = nowIso().slice(0, 10);
      }

      // Check-in: confirm replacement SN and promote inventory identity
      const checkinStatuses = new Set(['ms_arrived_check', 'ms_received_exchange', 'ms_received_same']);
      if (
        (body.promoteReplacement === true || body.promoteReplacement === '1'
          || (checkinStatuses.has(nextStatus) && body.msReplacementSerial))
        && (body.msReplacementSerial || ticket.msReplacementSerial)
      ) {
        try {
          const inbox = require('./ms_email_inbox.js');
          if (typeof inbox.promoteReplacementSerial === 'function') {
            const promoted = inbox.promoteReplacementSerial(
              ticket,
              body.msReplacementSerial || ticket.msReplacementSerial,
              { at: nowIso() }
            );
            if (promoted && promoted.ok && note) {
              // keep user note; promotion also recorded in history
            } else if (promoted && promoted.ok) {
              ticket.notes.push({
                at: nowIso(),
                by: actor,
                text: `Promoted replacement SN ${promoted.msReplacementSerial} (defective ${promoted.msDefectiveSerial || 'n/a'})`
              });
            }
          }
        } catch (e) {
          console.error('promoteReplacementSerial', e.message);
        }
      }

      if (nextStatus !== ticket.status) {
        ticket.status = nextStatus;
        ticket.statusAt = nowIso();
        const historyNote = nextStatus === 'ms_rejected' && ticket.msRejectReason
          ? [`Reason: ${ticket.msRejectReason}`, note].filter(Boolean).join(' — ')
          : (note || null);
        ticket.statusHistory.push({
          at: ticket.statusAt,
          status: nextStatus,
          by: actor,
          note: historyNote
        });
      }

      if (note) {
        ticket.notes.push({ at: nowIso(), by: actor, text: note });
      }

      if (isClosedRepairStatus(ticket.status)) {
        ticket.resolvedAt = ticket.resolvedAt || nowIso();
        ticket.resolvedBy = actor;
      } else {
        ticket.resolvedAt = null;
        ticket.resolvedBy = null;
      }

      log[index] = normalizeRepairTicket(ticket);
      saveRepairTickets(log);

      const noteText = buildRepairNoteText(log[index], note);
      const deviceUpdated = applyRepairToDevice(
        log[index],
        noteText,
        isClosedRepairStatus(log[index].status) ? 'repair_resolved' : 'repair_status'
      );

      res.json({
        ok: true,
        ticket: enrichRepairRow(log[index], index),
        deviceUpdated
      });
    } catch (e) {
      console.error('/api/repair-needed/update', e);
      res.status(500).json({ error: e.message || 'update failed' });
    }
  });

  /**
   * Look up a serial for the Needs MS "Add" UI: in-system? + warranty snapshot.
   * Optionally runs a live Microsoft check when cache is empty (capped wait).
   */
  app.get('/api/repair-needed/lookup-sn', requireConsoleAuth, async (req, res) => {
    try {
      const serialNumber = String(req.query.serial || req.query.serialNumber || '').trim();
      if (!serialNumber) return res.status(400).json({ error: 'serialNumber required' });
      const live = String(req.query.live || '') === '1' || String(req.query.live || '') === 'true';

      const found = findDeviceBySerial(serialNumber);
      const device = found && found.device ? found.device : null;
      const cache = loadJson(WARRANTY_CACHE_PATH, {}) || {};
      const key = serialKey(serialNumber);
      let warranty = (device && device.msWarranty) || cache[key] || cache[serialNumber] || null;
      let warrantySource = warranty
        ? ((device && device.msWarranty) ? 'device' : 'cache')
        : null;
      let warrantyError = null;

      if ((!warranty || live) && typeof runWarrantyCheck === 'function') {
        try {
          const liveResult = await Promise.race([
            runWarrantyCheck(serialNumber),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Warranty lookup timed out')), 28000))
          ]);
          if (liveResult && (liveResult.deviceName || liveResult.status || liveResult.expiresOn)) {
            warranty = liveResult;
            warrantySource = 'live';
            cache[key] = { ...liveResult, checkedAt: nowIso() };
            saveJson(WARRANTY_CACHE_PATH, cache);
            if (device) {
              const applied = applyWarrantyGaps(device, liveResult);
              if (applied.filled.length && found) {
                found.trackingItem.devices[found.deviceIndex] = applied.device;
                if (found.archived && typeof global.saveArchivedTrackingData === 'function') {
                  global.saveArchivedTrackingData();
                } else if (!found.archived && typeof global.saveTrackingData === 'function') {
                  global.saveTrackingData();
                }
              }
            }
          }
        } catch (e) {
          warrantyError = e.message || 'warranty lookup failed';
        }
      }

      // Also nudge the Fast Scan queue for a fresher check later
      try {
        if (warrantyQueue && typeof warrantyQueue.enqueue === 'function') {
          warrantyQueue.enqueue(serialNumber, false);
        }
      } catch (_) { /* ignore */ }

      const openTicket = loadRepairTickets().find(
        (t) => serialKey(t.serialNumber) === key && isOpenRepairTicket(t)
      );

      res.json({
        ok: true,
        serialNumber,
        inSystem: !!found,
        archived: found ? !!found.archived : null,
        openTicket: openTicket
          ? {
            id: openTicket.id,
            status: openTicket.status,
            statusLabel: (REPAIR_STATUSES[openTicket.status] || {}).label || openTicket.status,
            pipeline: repairPipelineForStatus(openTicket.status).key
          }
          : null,
        device: device
          ? {
            serialNumber: device.serialNumber,
            model: device.model || device.modelDetails || null,
            sku: device.sku || null,
            orderNumber: device.orderNumberPrimary || device.orderNumber || device.order_number || null,
            notes: device.notes || null
          }
          : null,
        warranty: warranty
          ? {
            deviceName: warranty.deviceName || null,
            status: warranty.status || null,
            expiresOn: warranty.expiresOn || null,
            standardWarrantyText: warranty.standardWarrantyText || null,
            summary: warranty.summary || null
          }
          : null,
        warrantySource,
        warrantyError
      });
    } catch (e) {
      console.error('/api/repair-needed/lookup-sn', e);
      res.status(500).json({ error: e.message || 'lookup failed' });
    }
  });

  /**
   * Console "Add" on Needs MS: create/update ticket as ms_waiting_case with
   * warranty snapshot + in-system check.
   */
  app.post('/api/repair-needed/add-ms', requireConsoleAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const serialNumber = String(body.serialNumber || body.serial || '').trim();
      const issue = String(body.issue || '').trim() || 'Send to Microsoft (manual add)';
      const quickTag = cleanOptional(body.quickTag);
      const actor = (req.session && (req.session.username || req.session.user)) || 'console';
      if (!serialNumber) return res.status(400).json({ error: 'serialNumber required' });

      const at = nowIso();
      const found = findDeviceBySerial(serialNumber);
      const device = found && found.device ? found.device : null;
      const cache = loadJson(WARRANTY_CACHE_PATH, {}) || {};
      const key = serialKey(serialNumber);
      let warranty = (device && device.msWarranty) || cache[key] || cache[serialNumber] || null;
      let warrantyError = null;

      if (!warranty) {
        try {
          warranty = await Promise.race([
            runWarrantyCheck(serialNumber),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Warranty lookup timed out')), 28000))
          ]);
          if (warranty) {
            cache[key] = { ...warranty, checkedAt: at };
            saveJson(WARRANTY_CACHE_PATH, cache);
            if (device) {
              const applied = applyWarrantyGaps(device, warranty);
              if (applied.filled.length && found) {
                found.trackingItem.devices[found.deviceIndex] = applied.device;
                if (found.archived && typeof global.saveArchivedTrackingData === 'function') {
                  global.saveArchivedTrackingData();
                } else if (!found.archived && typeof global.saveTrackingData === 'function') {
                  global.saveTrackingData();
                }
              }
            }
          }
        } catch (e) {
          warrantyError = e.message || 'warranty lookup failed';
        }
      } else {
        try {
          if (warrantyQueue && typeof warrantyQueue.enqueue === 'function') {
            warrantyQueue.enqueue(serialNumber, false);
          }
        } catch (_) { /* ignore */ }
      }

      const warrantyNote = warranty
        ? [
          'Warranty snapshot',
          warranty.deviceName ? `model ${warranty.deviceName}` : null,
          warranty.status || null,
          warranty.expiresOn ? `expires ${warranty.expiresOn}` : (warranty.standardWarrantyText || null)
        ].filter(Boolean).join(' · ')
        : (warrantyError ? `Warranty lookup pending: ${warrantyError}` : 'Warranty not found yet');

      const log = loadRepairTickets();
      const openIndex = log.findIndex(
        (t) => serialKey(t.serialNumber) === key && isOpenRepairTicket(t)
      );

      let row;
      let index;
      let merged = false;
      if (openIndex >= 0) {
        merged = true;
        const ticket = normalizeRepairTicket(log[openIndex]);
        ticket.issue = issue;
        if (quickTag) ticket.quickTag = quickTag;
        ticket.vendorName = ticket.vendorName || 'Microsoft';
        if (ticket.status !== 'ms_waiting_case' && !String(ticket.status).startsWith('ms_')) {
          ticket.status = 'ms_waiting_case';
          ticket.statusAt = at;
          ticket.statusHistory.push({ at, status: 'ms_waiting_case', by: actor, note: 'Moved to Needs MS (manual add)' });
        } else if (ticket.status === 'ms_waiting_case') {
          ticket.statusHistory.push({ at, status: ticket.status, by: actor, note: 'Re-added from Needs MS' });
        }
        ticket.notes.push({ at, by: actor, text: issue });
        ticket.notes.push({ at, by: actor, text: warrantyNote });
        if (!found) {
          ticket.notes.push({ at, by: actor, text: 'Serial not found in tracking system — added as Needs MS anyway' });
        }
        log[openIndex] = normalizeRepairTicket(ticket);
        row = log[openIndex];
        index = openIndex;
      } else {
        row = normalizeRepairTicket({
          id: newRepairId(),
          at,
          serialNumber,
          issue,
          quickTag,
          status: 'ms_waiting_case',
          statusAt: at,
          statusHistory: [{ at, status: 'ms_waiting_case', by: actor, note: 'Needs MS — manual add' }],
          notes: [
            { at, by: actor, text: warrantyNote },
            ...(!found ? [{ at, by: actor, text: 'Serial not found in tracking system — added as Needs MS anyway' }] : [])
          ],
          reportedBy: actor,
          source: 'console_needs_ms',
          vendorName: 'Microsoft'
        });
        log.push(row);
        index = log.length - 1;
      }
      saveRepairTickets(log);

      const noteText = buildRepairNoteText(row);
      const deviceUpdated = applyRepairToDevice(row, noteText, 'repair_needed');

      res.json({
        ok: true,
        merged,
        inSystem: !!found,
        archived: found ? !!found.archived : null,
        warranty: warranty
          ? {
            deviceName: warranty.deviceName || null,
            status: warranty.status || null,
            expiresOn: warranty.expiresOn || null,
            standardWarrantyText: warranty.standardWarrantyText || null
          }
          : null,
        warrantyError,
        deviceUpdated,
        ticket: enrichRepairRow(row, index)
      });
    } catch (e) {
      console.error('/api/repair-needed/add-ms', e);
      res.status(500).json({ error: e.message || 'add-ms failed' });
    }
  });

  app.post('/api/repair-needed/resolve', requireConsoleAuth, (req, res) => {
    try {
      const body = req.body || {};
      const serialNumber = String(body.serialNumber || '').trim();
      const at = String(body.at || '').trim();
      const ticketId = cleanOptional(body.id);
      const outcome = String(body.outcome || 'resolved').trim() === 'cannot_resolve'
        ? 'cannot_resolve'
        : 'resolved';
      if (!serialNumber && !ticketId) {
        return res.status(400).json({ error: 'serialNumber or id required' });
      }

      const log = loadRepairTickets();
      const key = serialKey(serialNumber);
      const index = log.findIndex((row) => {
        if (ticketId && row.id === ticketId) return true;
        if (!key) return false;
        const sameSerial = serialKey(row.serialNumber) === key;
        const sameAt = !at || String(row.at || '') === at;
        return sameSerial && sameAt && isOpenRepairTicket(row);
      });
      if (index < 0) {
        return res.status(404).json({ error: 'Repair ticket not found' });
      }

      const actor = cleanOptional(body.by)
        || cleanOptional(req.session && (req.session.username || req.session.user))
        || 'console';
      const note = cleanOptional(body.note);
      const ticket = normalizeRepairTicket(log[index]);
      ticket.status = outcome;
      ticket.statusAt = nowIso();
      ticket.resolvedAt = ticket.statusAt;
      ticket.resolvedBy = actor;
      ticket.statusHistory.push({
        at: ticket.statusAt,
        status: outcome,
        by: actor,
        note: note || null
      });
      if (note) ticket.notes.push({ at: ticket.statusAt, by: actor, text: note });

      log[index] = normalizeRepairTicket(ticket);
      saveRepairTickets(log);

      const noteText = buildRepairNoteText(log[index], note);
      const stillOpen = log.some((row) =>
        serialKey(row.serialNumber) === serialKey(ticket.serialNumber) && isOpenRepairTicket(row));
      let deviceUpdated = false;
      if (!stillOpen) {
        deviceUpdated = applyRepairToDevice(log[index], noteText, 'repair_resolved');
      }

      res.json({
        ok: true,
        removed: log[index],
        remaining: log.filter(isOpenRepairTicket).length,
        deviceUpdated,
        stillOpen
      });
    } catch (e) {
      console.error('/api/repair-needed/resolve', e);
      res.status(500).json({ error: e.message || 'resolve failed' });
    }
  });

  app.post('/repair-needed', (req, res) => {
    try {
      const body = req.body || {};
      const serialNumber = String(body.serialNumber || '').trim();
      const issue = String(body.issue || '').trim();
      if (!serialNumber) {
        return res.status(400).json({ error: 'serialNumber required' });
      }
      if (!issue) {
        return res.status(400).json({ error: 'issue required' });
      }

      const at = nowIso();
      const reportedBy = cleanOptional(body.reportedBy) || cleanOptional(body.operator);
      const source = cleanOptional(body.source) || 'api';
      const quickTag = cleanOptional(body.quickTag);
      const status = normalizeRepairStatus(body.status || 'open');

      // One ticket per serial: if an open ticket exists, this report becomes
      // an update on it (history + note) instead of a duplicate ticket.
      const log = loadRepairTickets();
      const key = serialKey(serialNumber);
      const openIndex = log.findIndex(
        (t) => serialKey(t.serialNumber) === key && isOpenRepairTicket(t)
      );

      let row;
      let index;
      if (openIndex >= 0) {
        const ticket = normalizeRepairTicket(log[openIndex]);
        ticket.issue = issue;
        if (quickTag) ticket.quickTag = quickTag;
        if (body.msProgram != null) ticket.msProgram = normalizeMsProgram(body.msProgram);
        if (body.msCaseId != null) ticket.msCaseId = cleanOptional(body.msCaseId);
        if (body.outboundTracking != null) ticket.outboundTracking = cleanOptional(body.outboundTracking);
        if (body.inboundTracking != null) ticket.inboundTracking = cleanOptional(body.inboundTracking);
        if (body.vendorName != null) ticket.vendorName = cleanOptional(body.vendorName);
        if (body.status != null && status !== ticket.status) {
          ticket.status = status;
          ticket.statusAt = at;
          ticket.statusHistory.push({ at, status, by: reportedBy, note: 'Reported again' });
        }
        ticket.notes.push({ at, by: reportedBy, text: issue });
        log[openIndex] = normalizeRepairTicket(ticket);
        row = log[openIndex];
        index = openIndex;
      } else {
        row = normalizeRepairTicket({
          id: newRepairId(),
          at,
          serialNumber,
          issue,
          quickTag,
          status,
          statusAt: at,
          statusHistory: [{ at, status, by: reportedBy, note: 'Ticket opened' }],
          notes: [],
          reportedBy,
          source,
          msProgram: body.msProgram,
          msCaseId: body.msCaseId,
          outboundTracking: body.outboundTracking,
          inboundTracking: body.inboundTracking,
          vendorName: body.vendorName
        });
        log.push(row);
        index = log.length - 1;
      }
      saveRepairTickets(log);

      const noteText = buildRepairNoteText(row);
      const deviceUpdated = applyRepairToDevice(row, noteText, 'repair_needed');

      res.json({
        ok: true,
        deviceUpdated,
        merged: openIndex >= 0,
        repair: enrichRepairRow(row, index)
      });
    } catch (e) {
      console.error('/repair-needed', e);
      res.status(500).json({ error: e.message || 'repair-needed failed' });
    }
  });

  /**
   * Crop MS letter label → 4x6 (shipping printer) + one-page case sheet (regular printer).
   */
  app.post('/api/repair-needed/print-ms-label', requireConsoleAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const labelId = String(body.labelId || '').trim();
      const ticketId = cleanOptional(body.ticketId || body.id);
      const serialNumber = String(body.serialNumber || '').trim();
      // prepare = PDFs only; queue/both = try printers; label|sheet = one job
      const mode = String(body.mode || 'queue').trim().toLowerCase();
      if (!labelId) {
        return res.status(400).json({ error: 'labelId required' });
      }

      const { buildCroppedLabelPdf, buildDetailsSheetPdf, findLabelSourcePath } = require('./ms_label_print');
      const { enqueuePrintJob, loadPrinters } = require('./printers');
      const { collectSerialHistory } = require('./device_lifecycle');

      if (!findLabelSourcePath(labelId)) {
        return res.status(404).json({ error: 'MS shipping label PDF not found' });
      }

      function pickPrinterId(preferredRole, matchFn) {
        const store = loadPrinters();
        const enabled = (store.printers || []).filter((p) => p && p.enabled);
        const byRole = enabled.find((p) => p.role === preferredRole);
        if (byRole) return byRole.id;
        const matched = enabled.find(matchFn);
        return matched ? matched.id : null;
      }

      const shippingPrinterId = pickPrinterId('shipping', (p) =>
        /shipping|4\s*x\s*6|brother|zebra|label/i.test(`${p.name} ${p.notes} ${p.brand} ${p.role}`));
      const regularPrinterId = pickPrinterId('regular', (p) =>
        /office|letter|regular|sheet|laser|pc|specs/i.test(`${p.name} ${p.notes} ${p.role}`));

      const log = loadRepairTickets();
      const key = serialKey(serialNumber);
      let index = log.findIndex((row) => {
        if (ticketId && row.id === ticketId) return true;
        return false;
      });
      if (index < 0 && key) {
        index = log.findIndex((row) => {
          if (serialKey(row.serialNumber) !== key) return false;
          const labels = Array.isArray(row.msShippingLabels) ? row.msShippingLabels : [];
          return labels.some((lab) => lab && lab.id === labelId);
        });
      }
      if (index < 0 && key) {
        index = log.findIndex((row) => serialKey(row.serialNumber) === key && isOpenRepairTicket(row));
      }

      const enriched = index >= 0
        ? enrichRepairRow(log[index], index)
        : enrichRepairRow({
          serialNumber: serialNumber || labelId,
          issue: '',
          status: 'ms_ready_to_ship',
          msShippingLabels: [{ id: labelId }]
        }, 0);

      const labels = Array.isArray(enriched.msShippingLabels) ? enriched.msShippingLabels : [];
      const labelMeta = labels.find((lab) => lab && lab.id === labelId) || { id: labelId };

      // Attach office / customer ownership timeline for the 1-page specs sheet.
      try {
        const serialForHist = enriched.serialNumber || serialNumber || null;
        if (serialForHist) {
          enriched.lifecycle = collectSerialHistory(
            serialForHist,
            global.trackingData,
            global.archivedTrackingData
          );
        }
      } catch (histErr) {
        console.warn('print-ms-label lifecycle', histErr && histErr.message);
        enriched.lifecycle = { cycles: [], events: [] };
      }

      // Prefer ISO expiresOn for the sheet date line when cache has both.
      try {
        const cache = loadJson(WARRANTY_CACHE_PATH, {}) || {};
        const wKey = serialKey(enriched.serialNumber || serialNumber);
        const w = (wKey && (cache[wKey] || cache[enriched.serialNumber] || cache[serialNumber])) || null;
        if (w) {
          if (w.expiresOn) enriched.warrantyExpires = w.expiresOn;
          if (w.status) enriched.warrantyStatus = w.status;
          if (w.standardWarrantyText) enriched.warrantyStandardText = w.standardWarrantyText;
          if (w.summary) enriched.warrantySummary = w.summary;
          if (w.deviceName && !enriched.warrantyDeviceName) enriched.warrantyDeviceName = w.deviceName;
          if (w.checkedAt) enriched.warrantyCheckedAt = w.checkedAt;
          if (w.deviceName && (isBlankField(enriched.cpu) || isBlankField(enriched.ram) || isBlankField(enriched.hd))) {
            const hw = parseWarrantyHardware(w.deviceName);
            if (isBlankField(enriched.cpu) && hw.cpuToken) enriched.cpu = hw.cpuToken;
            if (isBlankField(enriched.ram) && hw.ram != null) enriched.ram = hw.ram;
            if (isBlankField(enriched.hd) && hw.hd != null) enriched.hd = hw.hd;
          }
        }
      } catch (_) { /* ignore */ }

      const needLabelPdf = mode !== 'sheet' && mode !== 'view-sheet';
      const needSheetPdf = mode !== 'label';
      const cropped = needLabelPdf ? await buildCroppedLabelPdf(labelId) : null;
      const sheet = needSheetPdf ? await buildDetailsSheetPdf(enriched, labelMeta) : null;

      const actor = cleanOptional(req.session && (req.session.username || req.session.user)) || 'console';
      const serial = enriched.serialNumber || serialNumber || null;
      const printerReady = {
        shipping: !!shippingPrinterId,
        regular: !!regularPrinterId
      };

      const payloadBase = {
        ok: true,
        labelPdf: cropped ? cropped.publicUrl : null,
        sheetPdf: sheet ? sheet.publicUrl : null,
        printerReady,
        device: {
          serialNumber: serial,
          model: enriched.model || enriched.msDeviceModel || enriched.warrantyDeviceName || null,
          warrantyDeviceName: enriched.warrantyDeviceName || null,
          cpu: enriched.cpu || null,
          ram: enriched.ram || null,
          hd: enriched.hd || null,
          warrantyExpires: enriched.warrantyExpires || null,
          warrantyStatus: enriched.warrantyStatus || null
        }
      };

      if (mode === 'prepare' || mode === 'view-sheet') {
        return res.json({
          ...payloadBase,
          prepared: true,
          queued: false,
          message: mode === 'view-sheet'
            ? 'Specs sheet ready'
            : 'PDFs ready — open or download; printers can be set up later',
          warnings: []
        });
      }

      const queueLabel = mode === 'label' || mode === 'queue' || mode === 'both' || !mode;
      const queueSheet = mode === 'sheet' || mode === 'queue' || mode === 'both' || !mode;

      let labelJob = { ok: false, error: 'skipped' };
      let sheetJob = { ok: false, error: 'skipped' };

      if (queueLabel && cropped) {
        labelJob = enqueuePrintJob({
          role: 'shipping',
          printerId: shippingPrinterId || undefined,
          pdfUrl: cropped.publicUrl,
          serialNumber: serial,
          orderNumber: enriched.msOrderNumber || labelMeta.orderNumber || null,
          requestedBy: actor
        });
      }
      if (queueSheet && sheet) {
        sheetJob = enqueuePrintJob({
          role: 'regular',
          printerId: regularPrinterId || undefined,
          pdfUrl: sheet.publicUrl,
          serialNumber: serial,
          orderNumber: enriched.msOrderNumber || labelMeta.orderNumber || null,
          requestedBy: actor
        });
      }

      const queued = [];
      if (labelJob.ok) queued.push(labelJob.job);
      if (sheetJob.ok) queued.push(sheetJob.job);

      const names = queued.map((j) => j.printerName || j.role).join(' + ');
      const warnings = [];
      if (queueLabel && !labelJob.ok) {
        warnings.push(labelJob.error || 'Label printer not ready');
      }
      if (queueSheet && !sheetJob.ok) {
        warnings.push(sheetJob.error || 'Office sheet printer not ready');
      }

      const cooldownHit = (labelJob && labelJob.cooldown) || (sheetJob && sheetJob.cooldown);
      const retryAfterSec = Math.max(
        Number(labelJob && labelJob.retryAfterSec) || 0,
        Number(sheetJob && sheetJob.retryAfterSec) || 0,
        15
      );

      if (cooldownHit && !queued.length) {
        return res.status(429).json({
          ok: false,
          cooldown: true,
          retryAfterSec,
          error: labelJob.error || sheetJob.error || `Print already queued — wait ${retryAfterSec}s`,
          labelPdf: payloadBase.labelPdf,
          sheetPdf: payloadBase.sheetPdf
        });
      }

      // Soft-fail: PDFs are still usable when the agent PC / printers are not installed yet.
      res.json({
        ...payloadBase,
        prepared: true,
        queued: queued.length > 0,
        message: queued.length
          ? `Queued: ${names}`
          : 'PDFs ready — printer not configured on this PC yet (use View / Download for now)',
        warnings,
        jobs: queued,
        cooldownSec: 15
      });
    } catch (e) {
      console.error('/api/repair-needed/print-ms-label', e);
      res.status(500).json({ error: e.message || 'print-ms-label failed' });
    }
  });
}

/**
 * Shared updater for console AI Ask / automation.
 * Updates MS fields on an open ticket (or a specific ticket id) and mirrors notes to the device.
 */
function updateRepairTicketFields(opts = {}) {
  const serialNumber = String(opts.serialNumber || '').trim();
  const ticketId = cleanOptional(opts.ticketId);
  const actor = cleanOptional(opts.by) || 'ai_ask';
  const note = cleanOptional(opts.note);
  if (!serialNumber && !ticketId) {
    return { ok: false, error: 'serialNumber or ticketId required' };
  }

  const log = loadRepairTickets();
  const key = serialKey(serialNumber);
  let index = -1;
  if (ticketId) {
    index = log.findIndex((row) => row && row.id === ticketId);
  }
  if (index < 0 && key) {
    // Prefer open ticket for this SN
    index = log.findIndex((row) => serialKey(row.serialNumber) === key && isOpenRepairTicket(row));
    if (index < 0) {
      index = log.findIndex((row) => serialKey(row.serialNumber) === key);
    }
  }
  if (index < 0) {
    return { ok: false, error: 'Repair ticket not found', serialNumber: serialNumber || null, ticketId };
  }

  const ticket = normalizeRepairTicket(log[index]);
  const before = {
    status: ticket.status,
    msProgram: ticket.msProgram,
    msOrderNumber: ticket.msOrderNumber,
    msCaseId: ticket.msCaseId,
    msDeviceModel: ticket.msDeviceModel || null
  };

  if (opts.msProgram != null) ticket.msProgram = normalizeMsProgram(opts.msProgram);
  if (opts.msCaseId != null) ticket.msCaseId = cleanOptional(opts.msCaseId);
  if (opts.msOrderNumber != null) ticket.msOrderNumber = cleanOptional(opts.msOrderNumber);
  if (opts.msDeviceModel != null) ticket.msDeviceModel = cleanOptional(opts.msDeviceModel);
  if (opts.outboundTracking != null) ticket.outboundTracking = cleanOptional(opts.outboundTracking);
  if (opts.inboundTracking != null) ticket.inboundTracking = cleanOptional(opts.inboundTracking);

  let nextStatus = ticket.status;
  if (opts.status != null && String(opts.status).trim()) {
    nextStatus = normalizeRepairStatus(opts.status);
  }

  // Auto-fill program from status when helpful
  if (nextStatus === 'ms_advanced_exchange' || nextStatus === 'ms_approved_ship_ae') {
    ticket.msProgram = ticket.msProgram || 'advanced_exchange';
  }
  if (nextStatus === 'ms_same_unit' || nextStatus === 'ms_approved_ship_same') {
    ticket.msProgram = ticket.msProgram || 'same_unit_repair';
  }
  if (opts.msProgram === 'same_unit_repair' || opts.msProgram === 'advanced_exchange') {
    ticket.msProgram = normalizeMsProgram(opts.msProgram);
  }

  if (nextStatus !== ticket.status) {
    ticket.status = nextStatus;
    ticket.statusAt = nowIso();
    ticket.statusHistory.push({
      at: ticket.statusAt,
      status: nextStatus,
      by: actor,
      note: note || null
    });
  }

  if (note) {
    ticket.notes.push({ at: nowIso(), by: actor, text: note });
  }

  if (isClosedRepairStatus(ticket.status)) {
    ticket.resolvedAt = ticket.resolvedAt || nowIso();
    ticket.resolvedBy = actor;
  } else {
    ticket.resolvedAt = null;
    ticket.resolvedBy = null;
  }

  log[index] = normalizeRepairTicket(ticket);
  saveRepairTickets(log);

  const noteText = buildRepairNoteText(log[index], note);
  const deviceUpdated = applyRepairToDevice(
    log[index],
    noteText,
    isClosedRepairStatus(log[index].status) ? 'repair_resolved' : 'repair_status'
  );

  return {
    ok: true,
    serialNumber: log[index].serialNumber,
    ticketId: log[index].id,
    before,
    after: {
      status: log[index].status,
      msProgram: log[index].msProgram,
      msOrderNumber: log[index].msOrderNumber,
      msCaseId: log[index].msCaseId,
      msDeviceModel: log[index].msDeviceModel || null
    },
    deviceUpdated: !!deviceUpdated,
    repairNeeded: `console:repair?ticket=${encodeURIComponent(log[index].id)}&serial=${encodeURIComponent(log[index].serialNumber || '')}`
  };
}

/**
 * Apply multiple SN → MS order mappings (e.g. SUR email with several Order details blocks).
 */
function applyMsOrderUpdates(updates, opts = {}) {
  const list = Array.isArray(updates) ? updates : [];
  const actor = cleanOptional(opts.by) || 'ai_ask';
  const defaultProgram = normalizeMsProgram(opts.msProgram) || 'same_unit_repair';
  const defaultStatus = opts.status != null
    ? normalizeRepairStatus(opts.status)
    : 'ms_approved_ship_same';
  const caseId = cleanOptional(opts.msCaseId);
  const results = [];

  for (const row of list.slice(0, 20)) {
    if (!row) continue;
    const sn = String(row.serialNumber || '').trim().toUpperCase();
    const order = cleanOptional(row.msOrderNumber);
    if (!sn || !order) {
      results.push({ ok: false, error: 'serialNumber and msOrderNumber required', row });
      continue;
    }
    const note = cleanOptional(row.note)
      || cleanOptional(opts.note)
      || `AI Ask: applied MS order ${order}${opts.programLabel ? ` (${opts.programLabel})` : ''}`;
    results.push(updateRepairTicketFields({
      serialNumber: sn,
      by: actor,
      note,
      msOrderNumber: order,
      msProgram: row.msProgram || defaultProgram,
      status: row.status || defaultStatus,
      msCaseId: row.msCaseId || caseId || undefined,
      msDeviceModel: row.msDeviceModel || undefined
    }));
  }

  return {
    ok: results.some((r) => r && r.ok),
    updated: results.filter((r) => r && r.ok).length,
    failed: results.filter((r) => !r || !r.ok).length,
    results
  };
}

module.exports = {
  setupWarrantyRepair,
  applyWarrantyGaps,
  parseWarrantyHardware,
  modelFromDeviceName,
  isBlankField,
  toGbNumber,
  isOpenRepairTicket,
  autoCompleteRepairOnNotesImport,
  shouldAutoCompleteRepairOnNotes,
  updateRepairTicketFields,
  applyMsOrderUpdates,
  REPAIR_STATUSES,
  MS_PROGRAMS,
  MS_PIPELINE
};
