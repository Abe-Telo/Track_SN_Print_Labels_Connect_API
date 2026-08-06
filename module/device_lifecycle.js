/**
 * Device lifecycle helpers for OrderAssist Tracking.
 * Stages:
 *   inbound     - real carrier tracking / box received (source/vendor matters)
 *   warehouse   - processed, still in stock (OPTIONAL; often skipped)
 *   shipped     - sold / shipped to client
 *   return_rt   - customer return via RT / Ret_* buckets
 *
 * Safe rules:
 * - Never delete history
 * - Infer stage for old records at read time
 * - Append-only deviceHistory events on write
 */

const fs = require('fs');
const path = require('path');

const STAGES = Object.freeze({
  INBOUND: 'inbound',
  WAREHOUSE: 'warehouse',
  SHIPPED: 'shipped',
  RETURN_RT: 'return_rt'
});

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function isReturnTrackingNumber(trackingNumber) {
  const t = String(trackingNumber || '').trim();
  if (!t) return false;
  // Anything starting with RT / Ret / Return is a return bucket
  // (RTl7, RTl5, RTpro5, ReturnLaptop7, Ret_1, etc.)
  return /^(return|ret|rt)/i.test(t);
}

function inferTrackingStage(trackingEntry = {}) {
  if (trackingEntry.stage && Object.values(STAGES).includes(trackingEntry.stage)) {
    return trackingEntry.stage;
  }
  if (isReturnTrackingNumber(trackingEntry.trackingNumber)) {
    return STAGES.RETURN_RT;
  }
  return STAGES.INBOUND;
}

function ensureDeviceHistory(device) {
  if (!device || typeof device !== 'object') return [];
  if (!Array.isArray(device.deviceHistory)) {
    device.deviceHistory = [];
  }
  return device.deviceHistory;
}

function appendDeviceHistory(device, event, options = {}) {
  if (!device || !event || !event.type) return device;
  const history = ensureDeviceHistory(device);
  const entry = {
    at: event.at || nowIso(),
    type: event.type,
    stage: event.stage || null,
    trackingNumber: event.trackingNumber || null,
    orderNumber: event.orderNumber || null,
    source: event.source || null,
    vendor: event.vendor || null,
    reason: event.reason || null,
    note: event.note || null
  };

  // return_visit always records (same RT tracking can happen many times)
  const force = !!(options && options.force) || entry.type === 'return_visit';
  if (!force) {
    const day = String(entry.at).slice(0, 10);
    const dup = history.some((h) =>
      h &&
      h.type === entry.type &&
      String(h.trackingNumber || '') === String(entry.trackingNumber || '') &&
      String(h.at || '').slice(0, 10) === day &&
      String(h.reason || '') === String(entry.reason || '') &&
      String(h.note || '') === String(entry.note || '')
    );
    if (dup) return device;
  }

  history.push(entry);
  if (entry.type === 'return_visit') {
    device.returnVisitCount = history.filter((h) => h && h.type === 'return_visit').length;
    device.lastReturnAt = entry.at;
  }
  return device;
}

function appendReturnVisit(device, meta = {}) {
  if (!device) return device;
  appendDeviceHistory(device, {
    type: 'return_visit',
    stage: meta.stage || STAGES.RETURN_RT,
    trackingNumber: meta.trackingNumber || null,
    source: meta.source || null,
    vendor: meta.vendor || null,
    reason: meta.reason || null,
    note: meta.note || null
  }, { force: true });
  return device;
}

function getReturnVisits(device, trackingNumber = null) {
  const history = Array.isArray(device && device.deviceHistory) ? device.deviceHistory : [];
  return history
    .filter((h) => h && h.type === 'return_visit' && (!trackingNumber || h.trackingNumber === trackingNumber))
    .sort((a, b) => (Date.parse(a.at || 0) || 0) - (Date.parse(b.at || 0) || 0));
}

function appendNoteLog(device, text, meta = {}) {
  const noteText = (text == null ? '' : String(text)).trim();
  if (!device || !noteText) return device;
  if (!Array.isArray(device.noteLog)) device.noteLog = [];
  const last = device.noteLog.length ? device.noteLog[device.noteLog.length - 1] : null;
  if (last && String(last.text || '').trim() === noteText) {
    return device; // identical back-to-back note
  }
  const entry = {
    at: nowIso(),
    text: noteText,
    trackingNumber: meta.trackingNumber || null,
    stage: meta.stage || null
  };
  device.noteLog.push(entry);
  appendDeviceHistory(device, {
    type: 'note_logged',
    stage: entry.stage,
    trackingNumber: entry.trackingNumber,
    note: noteText,
    reason: meta.reason || null,
    source: meta.source || null,
    vendor: meta.vendor || null
  });
  return device;
}

function buildSyntheticHistoryFromRecord(device, trackingEntry, trackingSource) {
  const events = [];
  const stage = inferTrackingStage(trackingEntry);
  const trackDate = trackingEntry.date || null;
  const trackNo = trackingEntry.trackingNumber || null;
  const source = trackingEntry.source || trackingEntry.vendorSource || null;
  const vendor = trackingEntry.vendor || trackingEntry.supplier || null;

  if (trackDate || trackNo) {
    const isReturn = stage === STAGES.RETURN_RT;
    // Return buckets (RT*, Ret_*) are long-lived: the bucket's date is when
    // the bucket was created, not when this unit came back. Use the device's
    // own scan date for the received event so the timeline matches reality.
    const receivedDate = (isReturn && device && device.deviceDate)
      ? device.deviceDate
      : trackDate;
    events.push({
      at: receivedDate ? `${receivedDate}T00:00:00.000Z` : null,
      type: isReturn ? 'return_received' : 'inbound_received',
      stage,
      trackingNumber: trackNo,
      source,
      vendor,
      note: trackingSource ? `from ${trackingSource}` : null
    });
  }

  if (device && device.deviceDate) {
    events.push({
      at: `${device.deviceDate}T00:00:00.000Z`,
      type: 'device_scanned',
      stage,
      trackingNumber: trackNo,
      source,
      vendor
    });
  }

  if (device && (device.shipDate || /ship/i.test(String(device.orderstatus || device.orderStatus || '')))) {
    events.push({
      at: device.shipDate ? `${device.shipDate}T00:00:00.000Z` : null,
      type: 'shipped',
      stage: STAGES.SHIPPED,
      trackingNumber: trackNo,
      orderNumber: device.OrderNumber || device.orderNumber || null,
      note: device.orderstatus || device.orderStatus || null
    });
  }

  if (device && device.Return_Reason) {
    events.push({
      at: null,
      type: 'return_reason',
      stage: STAGES.RETURN_RT,
      trackingNumber: trackNo,
      reason: device.Return_Reason
    });
  }

  if (device && device.warehouseAt) {
    events.push({
      at: device.warehouseAt,
      type: 'warehouse_processed',
      stage: STAGES.WAREHOUSE,
      trackingNumber: trackNo
    });
  }

  // ShipStation + local note fields. Prefer values on the device; fill gaps
  // from the orders cache so History stays complete even before a persist sync.
  const ss = resolveShipStationNoteFields(device);
  const orderNumber = (device && (device.OrderNumber || device.orderNumber)) || null;
  function pushSs(type, text) {
    const note = String(text || '').trim();
    if (!note) return;
    events.push({
      at: null,
      type,
      stage,
      trackingNumber: trackNo,
      orderNumber,
      note
    });
  }
  pushSs('ss_note_from_buyer', ss.customerNotes);
  pushSs('ss_note_to_buyer', ss.notesToBuyer);
  pushSs('ss_gift_note', ss.giftMessage);
  pushSs('ss_internal_note', ss.internalNotes);
  pushSs('ss_custom_field_1', ss.customField1);
  pushSs('ss_custom_field_2', ss.customField2);
  pushSs('ss_custom_field_3', ss.customField3);
  // Explicit return note field (Return_Reason already emits return_reason above)
  if (ss.returnNote && String(ss.returnNote).trim() !== String((device && device.Return_Reason) || '').trim()) {
    pushSs('ss_return_note', ss.returnNote);
  }

  // Legacy aliases kept for older clients / cached event types
  // (ss_customer_note was the previous buyer/return combined label)

  // Legacy note: saved before note logging existed, so it has text but no
  // timestamp. Surface it in the timeline as an undated note event.
  const legacyNote = String((device && device.notes) || '').trim();
  const hasNoteLog = Array.isArray(device && device.noteLog) && device.noteLog.length > 0;
  if (legacyNote && !hasNoteLog) {
    events.push({
      at: null,
      type: 'note_logged',
      stage,
      trackingNumber: trackNo,
      note: legacyNote
    });
  }

  return events;
}

/** Join ShipStation labelMessages into a single "Note to Buyer" string. */
function labelMessagesToText(lm) {
  if (!lm) return '';
  if (typeof lm === 'string') return lm.trim();
  return [lm.reference1, lm.reference2, lm.reference3, lm.Reference1, lm.Reference2, lm.Reference3]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' · ');
}

/**
 * Resolve ShipStation note fields for history. Device values win; orders
 * cache fills blanks so the History tab isn't empty when sync hasn't run yet.
 */
function resolveShipStationNoteFields(device) {
  const fields = {
    customerNotes: (device && device.customerNotes) || null,
    internalNotes: (device && device.internalNotes) || null,
    giftMessage: (device && device.giftMessage) || null,
    notesToBuyer: (device && (device.notesToBuyer || device.noteToBuyer)) || null,
    returnNote: (device && (device.returnNote || device.ReturnNote)) || null,
    customField1: (device && device.customField1) || null,
    customField2: (device && device.customField2) || null,
    customField3: (device && device.customField3) || null
  };
  const on = String((device && (device.OrderNumber || device.orderNumber)) || '').trim();
  if (!on) return fields;
  try {
    const cachePath = path.join(__dirname, '../db/shipstation_orders_cache.json');
    if (!fs.existsSync(cachePath)) return fields;
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    for (const o of Object.values(cache.orders || {})) {
      if (String(o.orderNumber || '').trim() !== on) continue;
      const fill = (key, value) => {
        if (String(fields[key] || '').trim()) return;
        const v = String(value || '').trim();
        if (v) fields[key] = v;
      };
      fill('customerNotes', o.customerNotes);
      fill('internalNotes', o.internalNotes);
      fill('giftMessage', o.giftMessage);
      fill('notesToBuyer', o.notesToBuyer || labelMessagesToText(o.labelMessages));
      fill('returnNote', o.returnNote);
      fill('customField1', o.customField1);
      fill('customField2', o.customField2);
      fill('customField3', o.customField3);
    }
  } catch (_) {
    // History should still render without the cache.
  }
  return fields;
}

function mergeHistory(explicitHistory, syntheticHistory) {
  const out = [];
  const seen = new Set();
  function key(e) {
    return [
      e.type || '',
      e.trackingNumber || '',
      String(e.at || '').slice(0, 19),
      e.orderNumber || '',
      e.reason || '',
      e.note || ''
    ].join('|');
  }
  for (const e of [...(explicitHistory || []), ...(syntheticHistory || [])]) {
    if (!e) continue;
    const k = key(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => {
    const da = Date.parse(a.at || 0) || 0;
    const db = Date.parse(b.at || 0) || 0;
    return da - db;
  });
  return out;
}

function buildTrackingHistoryItem(device, trackingEntry, trackingSource) {
  const stage = inferTrackingStage(trackingEntry);
  const explicit = Array.isArray(device.deviceHistory) ? device.deviceHistory : [];
  const synthetic = buildSyntheticHistoryFromRecord(device, trackingEntry, trackingSource);
  const noteEvents = (Array.isArray(device.noteLog) ? device.noteLog : []).map((n) => ({
    at: n.at || null,
    type: 'note_logged',
    stage: n.stage || inferTrackingStage(trackingEntry),
    trackingNumber: n.trackingNumber || trackingEntry.trackingNumber || null,
    note: n.text || null
  }));
  const timeline = mergeHistory(explicit, [...synthetic, ...noteEvents]);

  return {
    stage,
    sourceLabel: trackingSource,
    trackingNumber: trackingEntry.trackingNumber || null,
    trackingDate: trackingEntry.date || null,
    trackingStatus: trackingEntry.status || null,
    quantity: trackingEntry.quantity,
    remaining: trackingEntry.remaining,
    inboundSource: trackingEntry.source || trackingEntry.vendorSource || null,
    vendor: trackingEntry.vendor || trackingEntry.supplier || null,
    deviceDate: device.deviceDate || null,
    warehouseAt: device.warehouseAt || null,
    shipDate: device.shipDate || null,
    orderNumber: device.OrderNumber || device.orderNumber || null,
    orderStatus: device.orderstatus || device.orderStatus || null,
    returnReason: device.Return_Reason || null,
    notApprovedReason: device.notApprovedReason || null,
    notes: device.notes || null,
    customerNotes: device.customerNotes || null,
    internalNotes: device.internalNotes || null,
    giftMessage: device.giftMessage || null,
    notesToBuyer: device.notesToBuyer || null,
    returnNote: device.returnNote || null,
    customField1: device.customField1 || null,
    customField2: device.customField2 || null,
    customField3: device.customField3 || null,
    shipToName: device.name || null,
    shipToCompany: device.company || null,
    shipToPhone: device.phone || device.Phone || device.phoneNumber || null,
    shipToAddress: [device.street1 || device.Street1 || device.address1,
      device.street2 || device.Street2 || device.address2].filter(Boolean).join(', ') || null,
    shipToCity: device.city || null,
    shipToState: device.state || null,
    shipToPostal: device.postalCode || device.zip || device.postal || null,
    timeline,
    noteLog: Array.isArray(device.noteLog) ? device.noteLog : [],
    returnVisits: getReturnVisits(device, trackingEntry.trackingNumber),
    returnVisitCount: getReturnVisits(device, trackingEntry.trackingNumber).length
  };
}

function collectSerialHistory(serialNumber, trackingData, archivedTrackingData) {
  const serialNumberLower = String(serialNumber || '').toLowerCase();
  const sources = [
    { label: 'active', data: trackingData || [] },
    { label: 'archived', data: archivedTrackingData || [] }
  ];
  const items = [];

  sources.forEach((source) => {
    (source.data || []).forEach((trackingEntry) => {
      (trackingEntry.devices || []).forEach((device) => {
        if (!device.serialNumber || String(device.serialNumber).toLowerCase() !== serialNumberLower) {
          return;
        }
        items.push(buildTrackingHistoryItem(device, trackingEntry, source.label));
      });
    });
  });

  items.sort((a, b) => {
    const da = Date.parse(a.trackingDate || a.deviceDate || a.shipDate || 0) || 0;
    const db = Date.parse(b.trackingDate || b.deviceDate || b.shipDate || 0) || 0;
    return da - db;
  });

  // Flat event timeline across all cycles
  const allEvents = [];
  items.forEach((item, idx) => {
    (item.timeline || []).forEach((ev) => {
      allEvents.push({
        cycle: idx + 1,
        stage: item.stage,
        inboundSource: item.inboundSource,
        vendor: item.vendor,
        ...ev
      });
    });
  });

  // MS emails use emailDate (when MS sent mail), not when we processed/imported them.
  for (const ev of collectMsRepairEmailEvents(serialNumber)) {
    allEvents.push({
      cycle: items.length || 1,
      stage: ev.stage || 'microsoft',
      inboundSource: null,
      vendor: 'Microsoft',
      ...ev
    });
  }

  allEvents.sort((a, b) => (Date.parse(a.at || 0) || 0) - (Date.parse(b.at || 0) || 0));

  return { cycles: items, events: allEvents };
}

/**
 * Pull MS ↔ warehouse email milestones for this SN from repair tickets.
 * Prefer emailDate so History shows when MS actually mailed, not import time.
 */
function collectMsRepairEmailEvents(serialNumber) {
  const sn = String(serialNumber || '').trim().toUpperCase();
  if (!sn) return [];
  const events = [];
  const seen = new Set();
  try {
    const repairPath = path.join(__dirname, '../db/repair_needed.json');
    if (!fs.existsSync(repairPath)) return [];
    const log = JSON.parse(fs.readFileSync(repairPath, 'utf8'));
    for (const t of (Array.isArray(log) ? log : [])) {
      if (!t || String(t.serialNumber || '').trim().toUpperCase() !== sn) continue;
      for (const e of (Array.isArray(t.msEmailEvents) ? t.msEmailEvents : [])) {
        if (!e) continue;
        const at = e.emailDate || e.at;
        if (!at) continue;
        const subject = String(e.subject || '').slice(0, 300);
        const key = `${e.uid || ''}|${at}|${subject}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push({
          at,
          type: 'ms_email',
          stage: 'microsoft',
          trackingNumber: t.outboundTracking || t.inboundTracking || null,
          orderNumber: t.msOrderNumber || null,
          note: subject || 'MS email',
          reason: Array.isArray(e.changes) && e.changes.length
            ? e.changes.map((c) => String(c)).slice(0, 8).join('; ')
            : (t.msCaseId ? `case ${t.msCaseId}` : null),
          source: 'ms_email',
          vendor: 'Microsoft'
        });
      }
    }
  } catch (_) {
    // History should still render without repair tickets.
  }
  return events;
}

module.exports = {
  STAGES,
  todayIsoDate,
  nowIso,
  isReturnTrackingNumber,
  inferTrackingStage,
  ensureDeviceHistory,
  appendDeviceHistory,
  appendNoteLog,
  appendReturnVisit,
  getReturnVisits,
  buildTrackingHistoryItem,
  collectSerialHistory,
  collectMsRepairEmailEvents,
  labelMessagesToText,
  resolveShipStationNoteFields
};
