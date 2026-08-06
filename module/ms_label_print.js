/**
 * MS email shipping-label print helpers.
 *
 * - Crop letter-sized Microsoft label PDFs down to 4x6 media for the shipping printer
 * - Build a single-page office sheet (SN, specs, issue, short case history)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const PDFDocument = require('pdfkit');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const LABELS_DIR = path.join(ROOT, 'db', 'ms_email_inbox', 'labels');
const PRINT_DIR = path.join(ROOT, 'db', 'ms_email_inbox', 'labels_print');
const TMP_DIR = path.join(PRINT_DIR, 'tmp');

const PT_4 = 288;
const PT_6 = 432;
const WHITE_THRESHOLD = 245;
const BBOX_PAD_PX = 12;
const RASTER_DPI = 150;

function ensureDirs() {
  for (const dir of [PRINT_DIR, TMP_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

function safeId(value) {
  return String(value || '').replace(/[^\w\-]/g, '');
}

/** Resolve on-disk source PDF for a label id (lbl-u...). */
function findLabelSourcePath(labelId) {
  const id = safeId(labelId);
  if (!id) return null;
  ensureDirs();
  if (!fs.existsSync(LABELS_DIR)) return null;
  // Only real PDFs - never .ocr.json sidecars (longer names used to win the sort).
  const files = fs.readdirSync(LABELS_DIR).filter((f) => {
    const lower = String(f).toLowerCase();
    if (!lower.endsWith('.pdf')) return false;
    if (lower.includes('.ocr.')) return false;
    return f.startsWith(`${id}_`) || f === `${id}.pdf`;
  });
  if (!files.length) return null;
  const file = files.sort((a, b) => a.length - b.length)[0];
  return path.join(LABELS_DIR, file);
}

function printFilePublicUrl(filename) {
  return `/android/ms-print/${encodeURIComponent(filename)}`;
}

function resolvePrintFile(filename) {
  const name = path.basename(String(filename || ''));
  if (!name || name !== String(filename || '') || name.includes('..')) return null;
  if (!/^[A-Za-z0-9._\-]+\.pdf$/i.test(name)) return null;
  const full = path.join(PRINT_DIR, name);
  if (!full.startsWith(PRINT_DIR)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

function contentBBox(png, threshold = WHITE_THRESHOLD, pad = BBOX_PAD_PX) {
  const { width, height, data } = png;
  const rowInk = new Array(height).fill(0);
  const colInk = new Array(width).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (width * y + x) << 2;
      if (data[i + 3] < 8) continue;
      if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) {
        rowInk[y] += 1;
        colInk[x] += 1;
      }
    }
  }

  // Prefer the densest contiguous ink band (the UPS label), not faint letter chrome.
  const rowThresh = Math.max(8, Math.floor(width * 0.04));
  const colThresh = Math.max(8, Math.floor(height * 0.04));
  const rowBands = [];
  let inBand = false;
  let start = 0;
  for (let y = 0; y < height; y += 1) {
    if (rowInk[y] >= rowThresh && !inBand) {
      inBand = true;
      start = y;
    } else if (rowInk[y] < rowThresh && inBand) {
      inBand = false;
      rowBands.push({ y0: start, y1: y - 1, ink: rowInk.slice(start, y).reduce((a, b) => a + b, 0) });
    }
  }
  if (inBand) {
    rowBands.push({
      y0: start,
      y1: height - 1,
      ink: rowInk.slice(start).reduce((a, b) => a + b, 0)
    });
  }

  let y0 = 0;
  let y1 = height - 1;
  if (rowBands.length) {
    rowBands.sort((a, b) => b.ink - a.ink);
    y0 = rowBands[0].y0;
    y1 = rowBands[0].y1;
  }

  let x0 = 0;
  let x1 = width - 1;
  let seen = false;
  for (let x = 0; x < width; x += 1) {
    let ink = 0;
    for (let y = y0; y <= y1; y += 1) {
      const i = (width * y + x) << 2;
      if (data[i + 3] < 8) continue;
      if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) ink += 1;
    }
    if (ink >= Math.max(4, Math.floor((y1 - y0 + 1) * 0.02))) {
      if (!seen) {
        x0 = x;
        seen = true;
      }
      x1 = x;
    }
  }
  if (!seen) {
    for (let x = 0; x < width; x += 1) {
      if (colInk[x] >= colThresh) {
        if (!seen) {
          x0 = x;
          seen = true;
        }
        x1 = x;
      }
    }
  }

  const x = Math.max(0, x0 - pad);
  const y = Math.max(0, y0 - pad);
  const right = Math.min(width, x1 + pad + 1);
  const bottom = Math.min(height, y1 + pad + 1);
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

function cropPng(png, box) {
  const out = new PNG({ width: box.w, height: box.h });
  PNG.bitblt(png, out, box.x, box.y, box.w, box.h, 0, 0);
  return out;
}

function rasterizePdfToPng(pdfPath, outPrefix, dpi = RASTER_DPI) {
  execFileSync(
    'pdftoppm',
    ['-png', '-r', String(dpi || RASTER_DPI), '-f', '1', '-l', '1', '-singlefile', pdfPath, outPrefix],
    { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }
  );
  const pngPath = `${outPrefix}.png`;
  if (!fs.existsSync(pngPath)) {
    throw new Error('pdftoppm did not produce a PNG');
  }
  return pngPath;
}

function writePdfWithImage(imagePath, pageSize, outPdfPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: pageSize,
      margin: 0,
      autoFirstPage: true
    });
    const stream = fs.createWriteStream(outPdfPath);
    doc.pipe(stream);
    const pageW = pageSize[0];
    const pageH = pageSize[1];
    const margin = 4;
    doc.image(imagePath, margin, margin, {
      fit: [pageW - margin * 2, pageH - margin * 2],
      align: 'center',
      valign: 'center'
    });
    doc.end();
    stream.on('finish', () => resolve(outPdfPath));
    stream.on('error', reject);
  });
}

/**
 * Build (or reuse cached) 4x6 PDF cropped from the MS letter label.
 * @returns {{ pdfPath: string, publicUrl: string, filename: string }}
 */
async function buildCroppedLabelPdf(labelId, opts = {}) {
  ensureDirs();
  const id = safeId(labelId);
  if (!id) throw new Error('labelId required');
  const source = findLabelSourcePath(id);
  if (!source) throw new Error('MS shipping label PDF not found');

  const filename = `${id}-4x6.pdf`;
  const outPdf = path.join(PRINT_DIR, filename);
  const force = opts.force === true;
  if (!force && fs.existsSync(outPdf)) {
    const srcM = fs.statSync(source).mtimeMs;
    const outM = fs.statSync(outPdf).mtimeMs;
    if (outM >= srcM) {
      return { pdfPath: outPdf, publicUrl: printFilePublicUrl(filename), filename };
    }
  }

  const prefix = path.join(TMP_DIR, `${id}-${Date.now()}`);
  const pngPath = rasterizePdfToPng(source, prefix);
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  const box = contentBBox(png);
  const cropped = cropPng(png, box);
  const croppedPath = `${prefix}-crop.png`;
  fs.writeFileSync(croppedPath, PNG.sync.write(cropped));

  const aspect = box.w / Math.max(1, box.h);
  // Prefer landscape 6x4 when the ink region is wider than tall (typical UPS strip).
  // Brother 4x6 media: short side 4", long side 6".
  const pageSize = aspect >= 0.95 ? [PT_6, PT_4] : [PT_4, PT_6];
  await writePdfWithImage(croppedPath, pageSize, outPdf);

  try {
    fs.unlinkSync(pngPath);
    fs.unlinkSync(croppedPath);
  } catch (e) { /* temp cleanup best-effort */ }

  return { pdfPath: outPdf, publicUrl: printFilePublicUrl(filename), filename };
}

function blank(value) {
  if (value == null) return true;
  const text = String(value).trim();
  return !text || text === '-' || text === '--';
}

function textOrDash(value) {
  if (blank(value)) return '-';
  return String(value).trim();
}

function ramHdLabel(value) {
  if (blank(value)) return '-';
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1024) {
    const tb = n / 1024;
    return Number.isInteger(tb) ? `${tb} TB` : `${tb.toFixed(1)} TB`;
  }
  if (Number.isFinite(n) && n > 0) return `${n} GB`;
  return String(value).trim();
}

function truncate(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
  return d.toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: '2-digit',
    hour: 'numeric',
    minute: '2-digit'
  });
}

/** Short date for the 1-page log (e.g. 8/3/2026). */
function formatShortDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
    return String(iso).slice(0, 10);
  }
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function formatWarrantyExpires(value) {
  if (blank(value)) return null;
  const raw = String(value).trim();
  // Already human text like "Expires Aug 24, 2027"
  if (/[A-Za-z]/.test(raw) && !/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
  const short = formatShortDate(raw);
  return short || raw;
}

function customerLineFromCycle(cycle) {
  if (!cycle) return null;
  const who = [cycle.shipToCompany, cycle.shipToName].filter((v) => !blank(v)).join(' / ');
  const place = [
    cycle.shipToAddress,
    [cycle.shipToCity, cycle.shipToState].filter(Boolean).join(', '),
    cycle.shipToPostal
  ].filter((v) => !blank(v)).join('  |  ');
  const phone = blank(cycle.shipToPhone) ? null : String(cycle.shipToPhone).trim();
  const bits = [];
  if (who) bits.push(who);
  if (place) bits.push(place);
  if (phone) bits.push(phone);
  return bits.length ? bits.join('  |  ') : null;
}

/**
 * Build a tight ownership / office timeline that fits on one letter page.
 */

/**
 * Build a tight ownership / office timeline that fits on one letter page.
 * Prefers tracking cycles + short MS milestones; skips long AI/repair note blobs.
 */
function buildCompactOwnershipLog(ticket, labelMeta = {}) {
  const lines = [];
  const push = (iso, text) => {
    const t = truncate(text, 108);
    if (!t) return;
    const d = formatShortDate(iso) || '-';
    const row = `${d}  ${t}`;
    if (!lines.includes(row)) lines.push(row);
  };

  const lifecycle = ticket && ticket.lifecycle;
  const cycles = lifecycle && Array.isArray(lifecycle.cycles) ? lifecycle.cycles : [];
  const events = lifecycle && Array.isArray(lifecycle.events) ? lifecycle.events : [];

  if (!blank(ticket && (ticket.warrantyStatus || ticket.warrantyExpires))) {
    const exp = formatWarrantyExpires(ticket.warrantyExpires || ticket.warrantyExpiresOn);
    push(
      ticket.warrantyCheckedAt || ticket.at,
      [
        'MS warranty',
        ticket.warrantyStatus || null,
        exp ? `exp ${exp}` : null
      ].filter(Boolean).join('  |  ')
    );
  }

  if (cycles.length) {
    cycles.forEach((cycle, idx) => {
      const firstAt = cycle.trackingDate || cycle.deviceDate || cycle.warehouseAt
        || (cycle.timeline && cycle.timeline[0] && cycle.timeline[0].at)
        || null;
      const tn = cycle.trackingNumber || null;
      const stage = cycle.stage || null;
      const vendor = cycle.vendor || cycle.inboundSource || null;
      const customer = customerLineFromCycle(cycle);
      const orderNo = cycle.orderNumber || null;
      const reason = cycle.returnReason || null;

      if (stage === 'return_rt' || /^(return|ret|rt)/i.test(String(tn || ''))) {
        push(firstAt, [
          'Return to office',
          tn ? `TN ${tn}` : null,
          reason ? `reason: ${truncate(reason, 40)}` : null,
          customer ? truncate(customer, 50) : null
        ].filter(Boolean).join('  |  '));
      } else {
        push(firstAt || cycle.deviceDate, [
          idx === 0 ? 'First in office' : `Inbound #${idx + 1}`,
          tn ? `TN ${tn}` : null,
          vendor ? `via ${vendor}` : null
        ].filter(Boolean).join('  |  '));
      }

      if (cycle.shipDate || (customer && stage === 'shipped')) {
        push(cycle.shipDate || firstAt, [
          'Sold to',
          customer || 'customer',
          orderNo ? `ord ${orderNo}` : null
        ].filter(Boolean).join('  |  '));
      } else if (customer && stage !== 'return_rt') {
        push(cycle.shipDate || firstAt, [
          'Customer',
          truncate(customer, 70),
          orderNo ? `ord ${orderNo}` : null
        ].filter(Boolean).join('  |  '));
      }
    });
  } else if (!blank(ticket && ticket.inboundTracking)) {
    push(ticket.at, `Inbound TN ${ticket.inboundTracking}`);
  }

  const eventLabel = {
    inbound_received: 'Package received',
    return_received: 'Return package received',
    device_scanned: 'Scanned in',
    warehouse_processed: 'Warehouse',
    shipped: 'Shipped to customer',
    return_visit: 'Return visit',
    return_reason: 'Return reason',
    repair_needed: 'Repair needed',
    repair_status: 'Repair update',
    repair_resolved: 'Repair resolved',
    warranty_backfill: 'Warranty specs filled'
  };
  for (const ev of events) {
    if (!ev || !ev.type) continue;
    if (/^ss_|note_logged|order_refresh/i.test(ev.type)) continue;
    const label = eventLabel[ev.type];
    if (!label) continue;
    push(ev.at, [
      label,
      ev.trackingNumber ? `TN ${ev.trackingNumber}` : null,
      ev.reason ? truncate(ev.reason, 36) : null
    ].filter(Boolean).join('  |  '));
  }

  const statusPretty = {
    ms_waiting_case: 'Waiting for MS case',
    ms_case_created: 'MS case created',
    ms_approved_ship_same: 'MS approved - ship same unit',
    ms_approved_ship_ae: 'MS approved - AE box',
    ms_rejected: 'MS rejected',
    ms_ready_to_ship: 'Ready to ship to MS',
    open: 'Repair opened',
    resolved: 'Resolved',
    cannot_resolve: 'Cannot resolve'
  };
  const statusHistory = Array.isArray(ticket && ticket.statusHistory) ? ticket.statusHistory : [];
  for (const row of statusHistory) {
    if (!row) continue;
    const raw = row.status || '';
    const label = statusPretty[raw] || null;
    if (!label) continue;
    push(row.at, label);
  }

  if (!blank(ticket && ticket.outboundTracking)) {
    push(ticket.shippedAt || ticket.statusAt || ticket.at, `Ship to MS  |  TN ${ticket.outboundTracking}`);
  } else if (/ship|approved/i.test(String((ticket && ticket.status) || ''))) {
    push(ticket.statusAt || ticket.at, 'Ship to MS (label ready)');
  }

  if (lines.length <= 12) return lines;
  const head = lines.slice(0, 5);
  const tail = lines.slice(-6);
  return [...head, `... ${lines.length - 11} more in History tab ...`, ...tail];
}

function warrantyDaysLeft(expiresOn) {
  if (blank(expiresOn)) return null;
  const d = Date.parse(String(expiresOn).slice(0, 10));
  if (!Number.isFinite(d)) return null;
  return Math.ceil((d - Date.now()) / 86400000);
}

/**
 * One-page letter PDF - Overview-style 2-column cards + compact history.
 */
function buildDetailsSheetPdf(ticket, labelMeta = {}) {
  ensureDirs();
  const id = safeId(labelMeta.id || ticket && ticket.id || 'sheet');
  const serial = String((ticket && ticket.serialNumber) || labelMeta.serialNumber || '').trim() || 'unknown';
  const filename = `${id}-sheet.pdf`;
  const outPdf = path.join(PRINT_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 28, bottom: 28, left: 36, right: 36 }
    });
    const stream = fs.createWriteStream(outPdf);
    doc.pipe(stream);

    const pageW = doc.page.width;
    const pageH = doc.page.height;
    const marginX = 36;
    const marginBottom = 28;
    const gap = 10;
    const colW = (pageW - marginX * 2 - gap) / 2;
    const leftX = marginX;
    const rightX = marginX + colW + gap;

    const kv = (x, y, w, label, value, opts = {}) => {
      if (blank(value) && !opts.showBlank) return 0;
      const labelW = opts.labelW || 58;
      doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
        .text(String(label).toUpperCase(), x, y, { width: labelW, lineBreak: false });
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 8.5).fillColor('#0f172a')
        .text(textOrDash(value), x + labelW, y, {
          width: w - labelW,
          height: opts.height || 11,
          ellipsis: true,
          lineBreak: false
        });
      return opts.rowH || 12;
    };

    const drawCard = (x, y, w, h, title, drawBody) => {
      doc.roundedRect(x, y, w, h, 6).lineWidth(0.6).strokeColor('#e2e8f0').stroke();
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a')
        .text(title.toUpperCase(), x + 8, y + 6, { width: w - 16 });
      drawBody(x + 8, y + 18, w - 16);
      return h;
    };

    let y = 28;

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text('MS ship-out  |  specs sheet', leftX, y);
    doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
      .text(`Printed ${formatWhen(new Date().toISOString())}   |   1 page   |   keep with device`, leftX + 210, y + 2, {
        width: pageW - marginX - (leftX + 210),
        align: 'right'
      });
    y += 16;
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#000').text(serial.toUpperCase(), leftX, y);
    y += 18;
    doc.font('Helvetica').fontSize(9).fillColor('#334155')
      .text(textOrDash(ticket.model || ticket.msDeviceModel || ticket.warrantyDeviceName), leftX, y, {
        width: pageW - marginX * 2,
        height: 12,
        ellipsis: true
      });
    y += 16;

    const program = ticket.msProgramLabel || ticket.msProgram || 'Microsoft';
    const wStatus = ticket.warrantyStatus || '-';
    const wExpiresRaw = ticket.warrantyExpires || ticket.warrantyExpiresOn || ticket.expiresOn || null;
    const wExpires = formatWarrantyExpires(wExpiresRaw) || '-';
    const daysLeft = warrantyDaysLeft(wExpiresRaw);
    const wExpiresLine = daysLeft == null ? wExpires : `${wExpires}  |  ${daysLeft}d left`;
    const wStandard = ticket.warrantyStandardText || null;
    const showStandard = !blank(wStandard)
      && !/^expires?\b/i.test(String(wStandard).trim());

    const cycle0 = ticket.lifecycle && Array.isArray(ticket.lifecycle.cycles)
      ? ticket.lifecycle.cycles[0]
      : null;
    const trackTn = ticket.inboundTracking
      || ticket.outboundTracking
      || (cycle0 && cycle0.trackingNumber)
      || ticket.trackingNumber
      || null;
    const trackStage = (cycle0 && cycle0.stage) || ticket.stage || null;
    const trackDate = (cycle0 && (cycle0.trackingDate || cycle0.deviceDate)) || null;
    const customer = customerLineFromCycle(cycle0);

    const cardH = 78;
    drawCard(leftX, y, colW, cardH, 'Specs', (bx, by, bw) => {
      let yy = by;
      yy += kv(bx, yy, bw, 'CPU', ticket.cpu);
      yy += kv(bx, yy, bw, 'RAM', ramHdLabel(ticket.ram));
      yy += kv(bx, yy, bw, 'HD', ramHdLabel(ticket.hd));
      yy += kv(bx, yy, bw, 'SKU', ticket.sku);
      yy += kv(bx, yy, bw, 'Windows', ticket.windows || ticket.os || null);
    });
    drawCard(rightX, y, colW, cardH, 'MS Warranty', (bx, by, bw) => {
      let yy = by;
      yy += kv(bx, yy, bw, 'Status', wStatus, { bold: true, showBlank: true });
      yy += kv(bx, yy, bw, 'Expires', wExpiresLine, { bold: true, showBlank: true, size: 9 });
      if (showStandard) yy += kv(bx, yy, bw, 'Standard', truncate(wStandard, 42));
      yy += kv(bx, yy, bw, 'Checked', formatShortDate(ticket.warrantyCheckedAt) || null);
      yy += kv(bx, yy, bw, 'Model', truncate(ticket.warrantyDeviceName || ticket.model, 40));
    });
    y += cardH + gap;

    drawCard(leftX, y, colW, cardH, 'MS Case / Order', (bx, by, bw) => {
      let yy = by;
      yy += kv(bx, yy, bw, 'Program', program);
      yy += kv(bx, yy, bw, 'Case', ticket.msCaseId);
      yy += kv(bx, yy, bw, 'Order', ticket.msOrderNumber || (labelMeta && labelMeta.orderNumber));
      yy += kv(bx, yy, bw, 'Out TN', ticket.outboundTracking);
      yy += kv(bx, yy, bw, 'Issue', truncate(ticket.issue || ticket.quickTag || '', 40));
    });
    drawCard(rightX, y, colW, cardH, 'Tracking', (bx, by, bw) => {
      let yy = by;
      yy += kv(bx, yy, bw, 'TN', trackTn);
      yy += kv(bx, yy, bw, 'Date', trackDate);
      yy += kv(bx, yy, bw, 'Stage', trackStage);
      const cyclesN = ticket.lifecycle && Array.isArray(ticket.lifecycle.cycles)
        ? ticket.lifecycle.cycles.length
        : null;
      yy += kv(bx, yy, bw, 'Cycles', cyclesN != null ? String(cyclesN) : null);
      yy += kv(bx, yy, bw, 'Customer', truncate(customer, 42));
    });
    y += cardH + gap;

    const issueH = 36;
    doc.roundedRect(leftX, y, pageW - marginX * 2, issueH, 6).lineWidth(0.6).strokeColor('#e2e8f0').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a').text('ISSUE', leftX + 8, y + 6);
    doc.font('Helvetica').fontSize(8.5).fillColor('#0f172a')
      .text(truncate(ticket.issue || ticket.quickTag || '-', 160), leftX + 8, y + 17, {
        width: pageW - marginX * 2 - 16,
        height: 14,
        ellipsis: true
      });
    y += issueH + gap;

    const histTop = y;
    const histH = Math.max(120, pageH - marginBottom - histTop);
    doc.roundedRect(leftX, histTop, pageW - marginX * 2, histH, 6).lineWidth(0.6).strokeColor('#e2e8f0').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a')
      .text('DEVICE HISTORY (COMPACT)', leftX + 8, histTop + 6);
    doc.font('Helvetica').fontSize(7).fillColor('#64748b')
      .text('Full timeline is on the History tab', leftX + 210, histTop + 7, {
        width: pageW - marginX * 2 - 218,
        align: 'right'
      });

    const logLines = buildCompactOwnershipLog(ticket, labelMeta);
    let hy = histTop + 20;
    const lineH = 10;
    const maxLines = Math.floor((histH - 28) / lineH);
    const shown = logLines.slice(0, maxLines);
    if (!shown.length) {
      doc.font('Helvetica').fontSize(8).fillColor('#64748b')
        .text('No tracking / customer history on file yet.', leftX + 8, hy);
    } else {
      for (const row of shown) {
        doc.font('Helvetica').fontSize(7.5).fillColor('#1e293b')
          .text(`*  ${row}`, leftX + 8, hy, {
            width: pageW - marginX * 2 - 16,
            height: lineH - 1,
            ellipsis: true,
            lineBreak: false
          });
        hy += lineH;
      }
    }

    doc.end();
    stream.on('finish', () => {
      resolve({ pdfPath: outPdf, publicUrl: printFilePublicUrl(filename), filename });
    });
    stream.on('error', reject);
  });
}

function rotatePng90CW(png) {
  const out = new PNG({ width: png.height, height: png.width });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const si = (png.width * y + x) << 2;
      const dx = png.height - 1 - y;
      const dy = x;
      const di = (out.width * dy + dx) << 2;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

/** Normalize OCR serial candidates (OFâ†’0F, OBâ†’0B, ]â†’J, etc.). */
function normalizeOcrSerialCandidate(raw) {
  let s = String(raw || '')
    .toUpperCase()
    .replace(/\]/g, 'J')
    .replace(/\[/g, 'I')
    .replace(/\|/g, 'I')
    .replace(/\$/g, 'S')
    .replace(/[^A-Z0-9]/g, '');
  if (/^OF[0-9A-Z]{12}$/.test(s)) s = `0F${s.slice(2)}`;
  if (/^OB[0-9A-Z]{12}$/.test(s)) s = `0B${s.slice(2)}`;
  if (/^OC[0-9A-Z]{12}$/.test(s)) s = `0C${s.slice(2)}`;
  if (/^OD[0-9A-Z]{12}$/.test(s)) s = `0D${s.slice(2)}`;
  if (/^OE[0-9A-Z]{12}$/.test(s)) s = `0E${s.slice(2)}`;
  if (/^(?:0F|BK|0C|0D|0E|0B)[0-9A-Z]{12}$/.test(s)) {
    if (/^0FZ/.test(s)) return null;
    if (/(?:REEL|NDAW|XXXX|TEST|AAA | 0000|IIII)/i.test(s)) return null;
    if (new Set(s.slice(2).split('')).size < 5) return null;
    return s;
  }
  // Legacy numeric Surface serials (11â€“12 digits) - reject tracking-like prefixes
  if (/^[0-9]{11,12}$/.test(s)) {
    if (/^(?:94|93|92|95|70|14|23|03)/.test(s)) return null;
    if (/^0+$/.test(s) || /^1+$/.test(s)) return null;
    if (new Set(s.split('')).size < 4) return null;
    return s;
  }
  return null;
}

function parseLabelOcrText(text) {
  const blob = String(text || '');
  const out = { order: null, serial: null, tracking: null, score: 0 };
  let m = blob.match(/Reference\s*No\.?\s*1\s*[:.]?\s*(20\d{8})/i);
  if (m) {
    out.order = m[1];
    out.score += 20;
  }
  m = blob.match(/Reference\s*No\.?\s*2\s*[:.]?\s*([^\n\r]{6,28})/i);
  if (m) {
    const sn = normalizeOcrSerialCandidate(m[1]);
    if (sn) {
      out.serial = sn;
      out.score += 30;
    } else {
      // Try sliding window over OCR junk on the same line (modern 14 + legacy 11â€“12)
      const cleaned = String(m[1]).toUpperCase().replace(/[^A-Z0-9\]\[]/g, '');
      for (const len of [14, 12, 11]) {
        for (let i = 0; i <= Math.max(0, cleaned.length - len); i += 1) {
          const sn2 = normalizeOcrSerialCandidate(cleaned.slice(i, i + len));
          if (sn2) {
            out.serial = sn2;
            out.score += 28;
            break;
          }
        }
        if (out.serial) break;
      }
      if (!out.serial) out.score += 4;
    }
  }
  // UPS labels often print "1Z W85 97X 84 2231 9826" with spaces.
  // Do not let [\s] eat following lines (BILLING/DESC) or the /^1Z…{16}$/ check fails.
  m = blob.match(/TRACKING\s*#?\s*[:.]?\s*(1Z[^\n\r]{10,40})/i)
    || blob.match(/\b(1Z(?:[ \t\-]*[A-Z0-9]){16})\b/i);
  if (m) {
    let tn = String(m[1]).replace(/[^A-Z0-9]/gi, '').toUpperCase();
    // Common OCR: letter O in place of zero inside the TN body
    if (tn.length > 18 && tn.startsWith('1Z')) tn = tn.slice(0, 18);
    if (/^1Z[A-Z0-9]{16}$/.test(tn)) {
      out.tracking = tn;
      out.score += 10;
    }
  }
  if (!out.order) {
    const orders = [];
    const re = /(?:^|[^0-9])(20\d{8})(?![0-9])/g;
    while ((m = re.exec(blob))) {
      // Skip timestamp-like values that appear as CreationDate (20YYMMDDHH)
      const v = m[1];
      const yy = Number(v.slice(2, 4));
      const mm = Number(v.slice(4, 6));
      const looksLikeDateTime = yy >= 20 && yy <= 30 && mm >= 1 && mm <= 12 && /^20\d{8}$/.test(v);
      // MS service orders are typically 204xxxxxxx - still allow any 20######## not looking like 20YYMMDD**
      if (looksLikeDateTime && Number(v.slice(6, 8)) <= 31) continue;
      orders.push(v);
    }
    if (orders.length) {
      out.order = orders[0];
      out.score += 8;
    }
  }
  if (!out.serial) {
    const re = /(?:^|[^A-Z0-9])((?:0F|OF|BK|0C|OC|0D|OD|0E|OE|0B|OB)[0-9A-Z\]\[]{10,14}|[0-9]{11,12})(?![A-Z0-9])/gi;
    while ((m = re.exec(blob))) {
      const sn = normalizeOcrSerialCandidate(m[1]);
      if (sn) {
        out.serial = sn;
        out.score += 20;
        break;
      }
    }
  }
  // Also try sliding 11â€“12 digit windows on Reference No. 2 leftovers
  if (!out.serial) {
    m = blob.match(/Reference\s*No\.?\s*2\s*[:.]?\s*([^\n\r]{6,40})/i);
    if (m) {
      const cleaned = String(m[1]).toUpperCase().replace(/[^A-Z0-9]/g, '');
      for (const len of [12, 11, 14]) {
        for (let i = 0; i <= Math.max(0, cleaned.length - len); i += 1) {
          const sn2 = normalizeOcrSerialCandidate(cleaned.slice(i, i + len));
          if (sn2) {
            out.serial = sn2;
            out.score += 26;
            break;
          }
        }
        if (out.serial) break;
      }
    }
  }
  if (/UPS\s+NEXT\s+DAY|RETURN\s+SERVICE|SHIP\s+TO:/i.test(blob)) out.score += 5;
  return out;
}

function tesseractStdout(pngPath, psm = 6) {
  return execFileSync('tesseract', [pngPath, 'stdout', '--psm', String(psm), '-l', 'eng'], {
    encoding: 'utf8',
    timeout: 90000,
    maxBuffer: 4 * 1024 * 1024
  });
}

/**
 * OCR a Microsoft shipping-label PDF for order / serial / UPS TN.
 * Caches beside the PDF as `<file>.ocr.json`. MS letter PDFs often need rotation.
 */
function extractShippingLabelIds(pdfPath, opts = {}) {
  const full = String(pdfPath || '');
  if (!full || !fs.existsSync(full)) {
    return { order: null, serial: null, tracking: null, score: 0, source: 'missing' };
  }
  const cachePath = `${full}.ocr.json`;
  const force = opts.force === true;
  if (!force && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached && typeof cached === 'object') return cached;
    } catch (_) { /* ignore */ }
  }

  ensureDirs();
  const tmpPrefix = path.join(TMP_DIR, `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let best = { order: null, serial: null, tracking: null, score: 0, source: 'ocr' };
  try {
    const pngPath = rasterizePdfToPng(full, tmpPrefix, opts.dpi || 220);
    let png = PNG.sync.read(fs.readFileSync(pngPath));
    // Prefer densest ink crop (UPS label), then try rotations.
    try {
      const box = contentBBox(png);
      if (box.w > 40 && box.h > 40 && (box.w * box.h) < (png.width * png.height * 0.95)) {
        png = cropPng(png, box);
      }
    } catch (_) { /* keep full page */ }

    for (let rot = 0; rot < 4; rot += 1) {
      if (rot > 0) png = rotatePng90CW(png);
      const rotPath = `${tmpPrefix}-r${rot}.png`;
      fs.writeFileSync(rotPath, PNG.sync.write(png));
      let text = '';
      try {
        text = tesseractStdout(rotPath, 6);
      } catch (e) {
        continue;
      }
      let parsed = parseLabelOcrText(text);
      if (!parsed.serial) {
        for (const psm of [4, 11]) {
          try {
            const alt = tesseractStdout(rotPath, psm);
            const p2 = parseLabelOcrText(alt);
            if ((p2.serial && !parsed.serial) || p2.score > parsed.score) {
              parsed = p2;
              text = alt;
            }
            if (parsed.serial) break;
          } catch (_) { /* ignore */ }
        }
      }
      parsed.rotation = rot * 90;
      parsed.source = 'ocr';
      if (parsed.score > best.score) {
        best = parsed;
        best.preview = String(text).slice(0, 800);
      }
      if (best.serial && best.order && best.score >= 50) break;
    }
  } catch (e) {
    best.error = e.message || String(e);
  } finally {
    try {
      for (const f of fs.readdirSync(TMP_DIR)) {
        if (f.startsWith(path.basename(tmpPrefix))) {
          try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (_) { /* ignore */ }
        }
      }
    } catch (_) { /* ignore */ }
  }

  try {
    atomicWriteOcrCache(cachePath, best);
  } catch (_) {
    try { fs.writeFileSync(cachePath, JSON.stringify(best, null, 2)); } catch (__) { /* ignore */ }
  }
  return best;
}

function atomicWriteOcrCache(cachePath, data) {
  const tmp = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, cachePath);
}

function setupMsLabelPrint(app) {
  ensureDirs();

  // Agent + localhost can fetch generated print PDFs without a console session.
  app.get('/android/ms-print/:filename', (req, res) => {
    try {
      const full = resolvePrintFile(req.params.filename);
      if (!full) return res.status(404).json({ error: 'Print file not found' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(full)}"`);
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      res.status(500).json({ error: e.message || 'print file failed' });
    }
  });
}

module.exports = {
  setupMsLabelPrint,
  buildCroppedLabelPdf,
  buildDetailsSheetPdf,
  findLabelSourcePath,
  resolvePrintFile,
  extractShippingLabelIds,
  parseLabelOcrText,
  normalizeOcrSerialCandidate,
  PRINT_DIR,
  LABELS_DIR
};
