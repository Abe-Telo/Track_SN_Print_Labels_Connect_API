/**
 * Microsoft & repair queue — pipeline tabs matching the real MS warranty flow.
 */
(function () {
  let busy = false;
  let items = [];
  let meta = { statuses: [], msPrograms: [], quickTags: [], pipelines: [], msRejectReasons: [] };
  let filterText = '';
  let mainTab = 'needs';
  let activeTicket = null;

  const PIPELINE_HINTS = {
    needs: 'Open an MS case (or wait for email autofill). Paste the case ID, then move to Talking.',
    talking: 'Review the full MS email chain. Approve or reject draft replies (with a training reason). Case/order still autofill from mail.',
    ship: 'Print / download the MS label from email, pack, then mark Shipped outbound (or Waiting inbound for AE).',
    transit: 'Packages moving. Emails fill inbound TN. When it arrives physically → Check-in.',
    checkin: 'Unit is back. Inspect, then Mark completed.',
    todo: 'Bench / restock queue (not MS). PowerShell notes import auto-completes these.',
    done: 'Closed tickets.'
  };

  /** Stage-focused Update sheet: only the fields + moves that matter here. */
  const STAGE_SHEET = {
    needs: {
      heading: 'Needs MS',
      fields: ['msCaseId', 'note'],
      actions: [
        { status: 'ms_case_created', label: 'Case created → Talking to MS', primary: true, require: 'msCaseId' }
      ]
    },
    talking: {
      heading: 'Talking to MS',
      fields: ['msCaseId', 'msOrderNumber', 'msRejectReason', 'note'],
      actions: [
        { status: 'ms_approved_ship_same', label: 'Approved — same-unit → Ship', primary: true },
        { status: 'ms_approved_ship_ae', label: 'Approved — AE → Ship', primary: true },
        { status: 'ms_waiting_approval', label: 'Still waiting on MS' },
        { status: 'ms_rejected', label: 'MS rejected' }
      ]
    },
    ship: {
      heading: 'Ship / labels',
      fields: ['msProgram', 'msOrderNumber', 'outboundTracking', 'inboundTracking', 'note'],
      actions: [
        { status: 'ms_shipped_outbound', label: 'Shipped outbound → In transit', primary: true },
        { status: 'ms_waiting_inbound', label: 'Waiting inbound from MS → In transit', primary: true }
      ]
    },
    transit: {
      heading: 'In transit',
      fields: ['outboundTracking', 'inboundTracking', 'expectedBackAt', 'note'],
      actions: [
        { status: 'ms_arrived_check', label: 'Arrived → Check-in', primary: true }
      ]
    },
    checkin: {
      heading: 'Check-in',
      fields: ['msDefectiveSerial', 'msReplacementSerial', 'promoteReplacement', 'note'],
      actions: [
        { resolve: 'resolved', label: 'Mark completed', primary: true },
        { status: 'ms_received_exchange', label: 'Received AE replacement' },
        { resolve: 'cannot_resolve', label: 'Cannot resolve' }
      ]
    },
    todo: {
      heading: 'To do (bench)',
      fields: ['note'],
      actions: [
        { status: 'ms_waiting_case', label: 'Send to Needs MS', primary: true }
      ]
    },
    done: {
      heading: 'Done',
      fields: ['note'],
      actions: []
    }
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function setHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function message(text, tone) {
    const el = document.getElementById('repairMessage');
    if (!el) return;
    if (!text) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'block';
    el.style.padding = '0.65rem 0.8rem';
    el.style.borderRadius = '8px';
    el.style.border = tone === 'error' ? '1px solid #fecaca' : '1px solid #bbf7d0';
    el.style.background = tone === 'error' ? '#fef2f2' : '#f0fdf4';
    el.style.color = tone === 'error' ? '#991b1b' : '#166534';
    el.textContent = text;
  }

  /** Seconds the Print buttons stay locked after a successful queue. */
  const PRINT_COOLDOWN_SEC = 15;
  const printCooldownUntil = Object.create(null);
  const printCooldownTimers = Object.create(null);
  const printBusyKeys = Object.create(null);

  function printCooldownKey(labelId, mode) {
    return `${String(labelId || '')}::${String(mode || 'queue')}`;
  }

  function printCooldownLeftSec(key) {
    const until = printCooldownUntil[key] || 0;
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  function syncPrintCooldownButtons(labelId) {
    const id = String(labelId || '');
    const buttons = Array.from(document.querySelectorAll('[data-print-both]'))
      .filter((btn) => String(btn.getAttribute('data-print-both') || '') === id);
    buttons.forEach((btn) => {
      const mode = btn.getAttribute('data-print-mode') || 'queue';
      const key = printCooldownKey(labelId, mode);
      const left = printCooldownLeftSec(key);
      const base = btn.getAttribute('data-print-label') || btn.textContent.replace(/\s*\(\d+s\)\s*$/, '').trim();
      if (!btn.getAttribute('data-print-label')) btn.setAttribute('data-print-label', base);
      if (left > 0 || printBusyKeys[key]) {
        btn.disabled = true;
        btn.textContent = left > 0 ? `${base} (${left}s)` : base;
      } else {
        btn.disabled = false;
        btn.textContent = base;
      }
    });
  }

  function startPrintCooldown(labelId, mode, sourceBtn) {
    const key = printCooldownKey(labelId, mode);
    printCooldownUntil[key] = Date.now() + (PRINT_COOLDOWN_SEC * 1000);
    if (printCooldownTimers[key]) clearInterval(printCooldownTimers[key]);
    const tick = () => {
      syncPrintCooldownButtons(labelId);
      if (printCooldownLeftSec(key) <= 0) {
        clearInterval(printCooldownTimers[key]);
        delete printCooldownTimers[key];
        syncPrintCooldownButtons(labelId);
      }
    };
    tick();
    printCooldownTimers[key] = setInterval(tick, 250);
    if (sourceBtn && !sourceBtn.getAttribute('data-print-label')) {
      sourceBtn.setAttribute('data-print-label', sourceBtn.textContent.trim());
    }
  }

  function formatWhen(value) {
    const raw = String(value || '');
    if (!raw) return '—';
    return raw.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  }

  function openDevice(serialNumber) {
    if (!serialNumber) return;
    if (typeof window.loadModalData_API_Local === 'function') {
      window.loadModalData_API_Local(serialNumber);
      return;
    }
    alert('Device details are still loading. Please try again.');
  }

  function statusBadge(row) {
    const tone = row.statusTone || 'warn';
    return `<span class="repair-badge ${escapeHtml(tone)}">${escapeHtml(row.statusLabel || row.status || 'Open')}</span>`;
  }

  /** Compact warranty countdown badge — e.g. 260D / 0D / EXP. Critical for MS eligibility. */
  function warrantyDaysBadge(row) {
    let info = (window.OAWarranty && window.OAWarranty.warrantyCountdown)
      ? window.OAWarranty.warrantyCountdown({
        status: row.warrantyStatus,
        expiresOn: row.warrantyExpires
      })
      : null;
    // Local fallback when warranty_display.js is not loaded — never show bare "Exp"
    // (that looked like Expired even for 2027 dates).
    if (!info && row.warrantyExpires) {
      const m = String(row.warrantyExpires).match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) {
        const exp = new Date(`${m[1]}T12:00:00`);
        const today = new Date();
        const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const expDay = new Date(exp.getFullYear(), exp.getMonth(), exp.getDate());
        const days = Math.round((expDay - todayDay) / 86400000);
        if (Number.isFinite(days)) {
          if (days < 0 || /EXPIRED/i.test(String(row.warrantyStatus || ''))) {
            info = { expired: true, days, date: m[1], daysBadge: 'EXP', daysBadgeTone: 'danger', lineLabel: `Expired · was ${m[1]}` };
          } else {
            const urgent = days <= 30;
            const critical = days <= 14;
            info = {
              expired: false,
              days,
              date: m[1],
              daysBadge: `${days}D`,
              daysBadgeTone: critical ? 'danger' : (urgent ? 'warn' : 'ok'),
              lineLabel: `Expires ${m[1]} · ${days} day${days === 1 ? '' : 's'} left`
            };
          }
        }
      }
    }
    if (!info) {
      return `<span class="repair-badge repair-exp-badge muted" title="Warranty expiry unknown — confirm before sending to MS">?</span>`;
    }
    const tone = info.daysBadgeTone || info.chipTone || 'muted';
    const label = info.daysBadge || info.chipLabel || '?';
    const title = info.expired
      ? `Warranty expired${info.date ? ` (${info.date})` : ''} — cannot send to MS`
      : (info.days != null
        ? `${info.days} day${info.days === 1 ? '' : 's'} until warranty expires${info.date ? ` (${info.date})` : ''} — must ship to MS before then`
        : (info.lineLabel || 'Warranty expiry unknown'));
    return `<span class="repair-badge repair-exp-badge ${escapeHtml(tone)}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
  }

  function pipelineOf(row) {
    if (row.closed) return 'done';
    return row.pipeline || 'todo';
  }

  function filteredItems() {
    let list = items.filter((row) => pipelineOf(row) === mainTab);
    const q = filterText.trim().toLowerCase();
    if (!q) return list;
    return list.filter((row) => {
      const hay = [
        row.serialNumber,
        row.issue,
        row.quickTag,
        row.status,
        row.statusLabel,
        row.model,
        row.sku,
        row.trackingNumber,
        row.orderNumber,
        row.msCaseId,
        row.msOrderNumber,
        row.msProgramLabel,
        row.outboundTracking,
        row.inboundTracking,
        row.vendorName,
        row.msRejectReason,
        row.warrantyStatus,
        row.nextActionTitle
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }

  function syncTabUi() {
    document.querySelectorAll('[data-repair-tab]').forEach((btn) => {
      const on = btn.dataset.repairTab === mainTab;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const hint = document.getElementById('repairPipelineHint');
    if (hint) hint.textContent = PIPELINE_HINTS[mainTab] || '';
    const addBtn = document.getElementById('repairAddNeedsMs');
    if (addBtn) addBtn.hidden = mainTab !== 'needs';
  }

  function renderTabCounts(list) {
    const counts = { todo: 0, needs: 0, talking: 0, ship: 0, transit: 0, checkin: 0, done: 0 };
    list.forEach((row) => {
      const p = pipelineOf(row);
      if (counts[p] != null) counts[p] += 1;
    });
    const map = {
      todo: 'repairTabTodoCount',
      needs: 'repairTabNeedsCount',
      talking: 'repairTabTalkingCount',
      ship: 'repairTabShipCount',
      transit: 'repairTabTransitCount',
      checkin: 'repairTabCheckinCount',
      done: 'repairTabDoneCount'
    };
    Object.keys(map).forEach((key) => {
      const el = document.getElementById(map[key]);
      if (el) el.textContent = String(counts[key] || 0);
    });
  }

  function renderKpis(list) {
    const openMs = list.filter((r) => !r.closed && r.pipeline && r.pipeline !== 'todo').length;
    const needsReply = list.filter((r) => !r.closed && r.msNeedsReply).length;
    const needs = list.filter((r) => pipelineOf(r) === 'needs').length;
    const talking = list.filter((r) => pipelineOf(r) === 'talking').length;
    const ship = list.filter((r) => pipelineOf(r) === 'ship').length;
    const transit = list.filter((r) => pipelineOf(r) === 'transit').length;
    const checkin = list.filter((r) => pipelineOf(r) === 'checkin').length;
    setHtml('repairKpis', `
      <div class="repair-kpi ${needsReply ? 'danger' : (openMs ? 'ok' : 'ok')}">
        <div class="label">Need a reply</div>
        <div class="value">${escapeHtml(needsReply)}</div>
      </div>
      <div class="repair-kpi ${openMs ? 'danger' : 'ok'}">
        <div class="label">Open MS path</div>
        <div class="value">${escapeHtml(openMs)}</div>
      </div>
      <div class="repair-kpi">
        <div class="label">Needs case</div>
        <div class="value">${escapeHtml(needs)}</div>
      </div>
      <div class="repair-kpi info">
        <div class="label">Talking / ship</div>
        <div class="value">${escapeHtml(talking + ship)}</div>
      </div>
    `);
  }

  function trackLink(tn, label) {
    if (!tn) return null;
    return `${label} <a href="https://www.ups.com/track?tracknum=${encodeURIComponent(tn)}" target="_blank" rel="noopener">${escapeHtml(tn)}</a>`;
  }

  function renderList() {
    const list = filteredItems();
    const countEl = document.getElementById('repairCountLabel');
    if (countEl) countEl.textContent = `${list.length} shown`;
    renderTabCounts(items);

    if (!items.length) {
      setHtml('repairList', '<div class="repair-empty">No repair tickets yet.</div>');
      return;
    }
    if (!list.length) {
      setHtml('repairList', '<div class="repair-empty">Nothing in this stage right now.</div>');
      return;
    }

    const rows = list.map((row) => {
      const modelLine = row.model
        ? escapeHtml(row.model)
        : '<span class="repair-muted">Model unknown</span>';
      const warrantyInfo = (window.OAWarranty && window.OAWarranty.warrantyCountdown)
        ? window.OAWarranty.warrantyCountdown({
          status: row.warrantyStatus,
          expiresOn: row.warrantyExpires
        })
        : null;
      const warranty = warrantyInfo && warrantyInfo.lineLabel
        ? escapeHtml(warrantyInfo.lineLabel)
        : [
          row.warrantyStatus && !/EXPIRED/i.test(row.warrantyStatus)
            ? escapeHtml(String(row.warrantyStatus).replace(/_/g, ' '))
            : null,
          row.warrantyExpires && /^\d{4}-\d{2}-\d{2}/.test(String(row.warrantyExpires))
            ? `expires ${escapeHtml(String(row.warrantyExpires).slice(0, 10))}`
            : null
        ].filter(Boolean).join(' · ');
      const shipBits = [
        row.msProgramLabel ? escapeHtml(row.msProgramLabel) : null,
        row.msCaseId ? `Case ${escapeHtml(row.msCaseId)}` : null,
        row.msOrderNumber ? `Order ${escapeHtml(row.msOrderNumber)}` : null,
        row.status === 'ms_rejected' && row.msRejectReason
          ? `Rejected: ${escapeHtml(row.msRejectReason)}`
          : null,
        trackLink(row.outboundTracking, 'Out'),
        trackLink(row.inboundTracking, 'In'),
        row.vendorName ? escapeHtml(row.vendorName) : null
      ].filter(Boolean).join(' · ');
      const next = row.nextActionTitle
        ? `<div class="repair-next"><strong>Next:</strong> ${escapeHtml(row.nextActionTitle)}</div>`
        : '';
      const labels = Array.isArray(row.msShippingLabels) ? row.msShippingLabels : [];
      const labelChip = labels.length
        ? `<button type="button" class="repair-badge ok" data-label-gallery="${escapeHtml(row.id)}" title="View labels, specs, PDF, print">`
          + `${labels.length} label${labels.length > 1 ? 's' : ''}</button>`
        : '';
      const emailNote = lastEmailNote(row);
      const hasEmailTrail = !!(emailNote || row.msCaseId || row.msOrderNumber
        || (Array.isArray(row.msEmailEvents) && row.msEmailEvents.length));
      const emailChip = hasEmailTrail
        ? `<button type="button" class="repair-badge info" data-email-history="${escapeHtml(row.id)}" title="${escapeHtml(emailNote || 'Open MS email history')}">Email</button>`
        : '';
      const needReplyChip = row.msNeedsReply
        ? `<span class="repair-badge danger" title="${escapeHtml(row.msNeedsReplySubject || 'Microsoft emailed — your turn to reply')}">Need a reply</span>`
        : '';
      const completeLabel = mainTab === 'checkin' ? 'Mark completed' : 'Resolved';
      return `<tr${row.msNeedsReply ? ' class="repair-row-needs-reply"' : ''}>
        <td>
          <button type="button" class="repair-serial" data-serial="${escapeHtml(row.serialNumber)}">${escapeHtml(row.serialNumber || '—')}</button>
          <div class="repair-muted">${formatWhen(row.statusAt || row.at)}</div>
          <div style="margin-top:0.35rem;">${warrantyDaysBadge(row)} ${statusBadge(row)} ${needReplyChip} ${emailChip} ${labelChip}</div>
        </td>
        <td>
          <div>${modelLine}</div>
          ${warranty ? `<div class="repair-muted">${warranty}</div>` : ''}
          ${shipBits ? `<div class="repair-muted">${shipBits}</div>` : ''}
          ${next}
        </td>
        <td>
          <div class="repair-issue">${escapeHtml(row.issue || '—')}</div>
          ${row.quickTag ? `<div class="repair-muted">${escapeHtml(row.quickTag)}</div>` : ''}
          ${!row.found ? '<div style="margin-top:0.35rem;"><span class="repair-badge warn">Not in tracking</span></div>' : ''}
        </td>
        <td>
          <div class="repair-actions">
            <button type="button" class="btn btn-secondary" data-open="${escapeHtml(row.serialNumber)}">Open</button>
            <button type="button" class="btn" data-manage-id="${escapeHtml(row.id)}" data-manage-at="${escapeHtml(row.at || '')}" data-manage-serial="${escapeHtml(row.serialNumber)}">Update</button>
            ${!row.closed ? `<button type="button" class="btn btn-secondary" data-resolve-id="${escapeHtml(row.id)}" data-resolve-serial="${escapeHtml(row.serialNumber)}" data-resolve-at="${escapeHtml(row.at || '')}">${completeLabel}</button>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');

    setHtml('repairList', `
      <div class="repair-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Serial / status</th>
              <th>Device &amp; next step</th>
              <th>Issue</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  }

  function statusOptions(selected) {
    const groups = {
      intake: 'Bench / intake',
      microsoft: 'Microsoft detail',
      arrived: 'Check-in',
      external: 'Vendor',
      close: 'Close-out'
    };
    const byGroup = {};
    (meta.statuses || []).forEach((status) => {
      const g = status.group || 'intake';
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(status);
    });
    return Object.keys(groups).map((group) => {
      const rows = byGroup[group] || [];
      if (!rows.length) return '';
      return `<optgroup label="${escapeHtml(groups[group])}">`
        + rows.map((status) => `<option value="${escapeHtml(status.key)}"${status.key === selected ? ' selected' : ''}>${escapeHtml(status.label)}</option>`).join('')
        + '</optgroup>';
    }).join('');
  }

  function rejectReasonOptions(selected) {
    const reasons = meta.msRejectReasons || [];
    return ['<option value="">—</option>'].concat(reasons.map((reason) => (
      `<option value="${escapeHtml(reason)}" ${reason === selected ? 'selected' : ''}>${escapeHtml(reason)}</option>`
    ))).join('');
  }

  function msProgramOptions(selected) {
    return ['<option value="">—</option>'].concat((meta.msPrograms || []).map((program) => (
      `<option value="${escapeHtml(program.key)}"${program.key === selected ? ' selected' : ''}>${escapeHtml(program.label)}</option>`
    ))).join('');
  }

  function closeSheet() {
    activeTicket = null;
    const backdrop = document.getElementById('repairSheetBackdrop');
    if (backdrop) backdrop.hidden = true;
    setHtml('repairSheetBody', '');
  }

  function closeAddSheet() {
    const backdrop = document.getElementById('repairAddBackdrop');
    if (backdrop) backdrop.hidden = true;
  }

  function openAddSheet() {
    const backdrop = document.getElementById('repairAddBackdrop');
    const serial = document.getElementById('repairAddSerial');
    const issue = document.getElementById('repairAddIssue');
    const preview = document.getElementById('repairAddPreview');
    const status = document.getElementById('repairAddStatus');
    if (serial) serial.value = '';
    if (issue) issue.value = '';
    if (preview) {
      preview.hidden = true;
      preview.innerHTML = '';
    }
    if (status) status.textContent = '';
    if (backdrop) backdrop.hidden = false;
    setTimeout(() => serial?.focus(), 50);
  }

  function renderAddPreview(data) {
    const preview = document.getElementById('repairAddPreview');
    if (!preview) return;
    if (!data) {
      preview.hidden = true;
      preview.innerHTML = '';
      return;
    }
    const bits = [];
    bits.push(data.inSystem
      ? `<div class="ok">In system${data.archived ? ' (archived)' : ''}</div>`
      : '<div class="warn">Not in tracking system — can still add</div>');
    if (data.device) {
      bits.push(`<div><strong>Model:</strong> ${escapeHtml(data.device.model || '—')}`
        + (data.device.sku ? ` · SKU ${escapeHtml(data.device.sku)}` : '')
        + (data.device.orderNumber ? ` · Order ${escapeHtml(data.device.orderNumber)}` : '')
        + '</div>');
    }
    if (data.warranty) {
      const wInfo = (window.OAWarranty && window.OAWarranty.warrantyCountdown)
        ? window.OAWarranty.warrantyCountdown({
          status: data.warranty.status,
          expiresOn: data.warranty.expiresOn
        })
        : null;
      bits.push(`<div><strong>Warranty:</strong> ${escapeHtml((wInfo && wInfo.lineLabel) || data.warranty.status || '—')}`
        + (data.warranty.deviceName ? ` · ${escapeHtml(data.warranty.deviceName)}` : '')
        + (data.warrantySource ? ` <span class="repair-muted">(${escapeHtml(data.warrantySource)})</span>` : '')
        + '</div>');
    } else {
      bits.push(`<div class="warn">No warranty data yet${data.warrantyError ? ` — ${escapeHtml(data.warrantyError)}` : ''}</div>`);
    }
    if (data.openTicket) {
      bits.push(`<div class="warn">Already open: ${escapeHtml(data.openTicket.statusLabel || data.openTicket.status)} (${escapeHtml(data.openTicket.pipeline || '')})</div>`);
    }
    preview.innerHTML = bits.join('');
    preview.hidden = false;
  }

  async function lookupAddSerial(opts = {}) {
    const serial = (document.getElementById('repairAddSerial')?.value || '').trim();
    const status = document.getElementById('repairAddStatus');
    if (!serial) {
      if (status) status.textContent = 'Enter or scan a serial first.';
      return null;
    }
    if (status) status.textContent = opts.live ? 'Looking up + checking Microsoft warranty…' : 'Looking up…';
    try {
      const qs = new URLSearchParams({ serialNumber: serial });
      if (opts.live) qs.set('live', '1');
      const response = await fetch(`/api/repair-needed/lookup-sn?${qs}`, {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `Lookup failed (${response.status})`);
      renderAddPreview(data);
      if (status) status.textContent = '';
      return data;
    } catch (error) {
      if (status) status.textContent = error.message || 'Lookup failed';
      renderAddPreview(null);
      return null;
    }
  }

  async function submitAddNeedsMs() {
    if (busy) return;
    const serial = (document.getElementById('repairAddSerial')?.value || '').trim();
    const issue = (document.getElementById('repairAddIssue')?.value || '').trim();
    const status = document.getElementById('repairAddStatus');
    if (!serial) {
      if (status) status.textContent = 'Enter or scan a serial first.';
      document.getElementById('repairAddSerial')?.focus();
      return;
    }
    busy = true;
    if (status) status.textContent = 'Adding — fetching warranty if needed…';
    try {
      const response = await fetch('/api/repair-needed/add-ms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          serialNumber: serial,
          issue: issue || undefined
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `Add failed (${response.status})`);
      const where = data.inSystem ? 'in system' : 'not in system';
      const w = data.warranty
        ? ` · warranty ${((window.OAWarranty && window.OAWarranty.warrantyCountdown)
          ? window.OAWarranty.warrantyCountdown({
            status: data.warranty.status,
            expiresOn: data.warranty.expiresOn
          }).lineLabel
          : `${data.warranty.status || 'ok'}${data.warranty.expiresOn ? ` exp ${String(data.warranty.expiresOn).slice(0, 10)}` : ''}`)}`
        : '';
      message(`${serial} → Needs MS (${where})${w}${data.merged ? ' · updated existing ticket' : ''}.`);
      closeAddSheet();
      mainTab = 'needs';
      await loadRepairs({ quiet: true });
      syncTabUi();
      if (data.ticket) openManageSheet(data.ticket);
    } catch (error) {
      if (status) status.textContent = error.message || 'Add failed';
      message(error.message || 'Add failed', 'error');
    } finally {
      busy = false;
    }
  }

  function lastEmailNote(ticket) {
    const events = Array.isArray(ticket.msEmailEvents) ? ticket.msEmailEvents : [];
    if (events.length) {
      const e = events[events.length - 1];
      const when = e.emailDate
        ? `Email ${formatWhen(e.emailDate)} · processed ${formatWhen(e.at)}`
        : formatWhen(e.at);
      return {
        at: e.at,
        text: `${when} — ${e.subject || 'MS email'}${(e.changes && e.changes.length) ? `: ${e.changes.join('; ')}` : ''}`,
        by: 'ms_email'
      };
    }
    const notes = Array.isArray(ticket.notes) ? ticket.notes : [];
    for (let i = notes.length - 1; i >= 0; i -= 1) {
      if (notes[i] && notes[i].by === 'ms_email') return notes[i];
    }
    const hist = Array.isArray(ticket.statusHistory) ? ticket.statusHistory : [];
    for (let i = hist.length - 1; i >= 0; i -= 1) {
      if (hist[i] && hist[i].by === 'ms_email') {
        return { at: hist[i].at, text: hist[i].note || 'Updated from MS email', by: 'ms_email' };
      }
    }
    return null;
  }

  function emailEventsHtml(ticket) {
    const events = Array.isArray(ticket.msEmailEvents) ? ticket.msEmailEvents.slice() : [];
    if (!events.length) return '';
    const rows = events.slice().reverse().slice(0, 20).map((e) => {
      const emailWhen = e.emailDate ? `Email ${escapeHtml(formatWhen(e.emailDate))}` : 'Email date unknown';
      const procWhen = e.at ? `processed ${escapeHtml(formatWhen(e.at))}` : '';
      const changes = (e.changes && e.changes.length)
        ? `<div class="repair-muted">${escapeHtml(e.changes.join('; '))}</div>`
        : '';
      return `<div class="repair-history-item"><strong>${emailWhen}</strong>`
        + (procWhen ? ` · ${procWhen}` : '')
        + (e.subject ? `<div>${escapeHtml(e.subject)}</div>` : '')
        + changes
        + '</div>';
    }).join('');
    return `<div>
      <div class="repair-optgroup-label">MS email timeline</div>
      <div class="repair-history">${rows}</div>
    </div>`;
  }

  function draftCardsHtml(drafts, threadMeta) {
    const list = drafts || [];
    const pending = list.filter((d) => d.status === 'pending' || d.status === 'approved_queued');
    const sent = list
      .filter((d) => d.status === 'sent')
      .sort((a, b) => String(b.sentAt || b.createdAt || '').localeCompare(String(a.sentAt || a.createdAt || '')))
      .slice(0, 5);
    const blocked = list
      .filter((d) => d.status === 'already_sent')
      .sort((a, b) => String(b.alreadySentAt || b.createdAt || '').localeCompare(String(a.alreadySentAt || a.createdAt || '')))
      .slice(0, 3);
    if (!pending.length && !sent.length && !blocked.length) {
      return `<div class="repair-optgroup-label">Suggested reply to MS</div>
        <div class="repair-muted">No pending draft. Use “Refresh drafts” after new mail — AI writes a reply from the newest MS email (templates only if AI is down). Fill Case briefing so AI knows what you already told MS.</div>`;
    }
    const replyHint = threadMeta && threadMeta.replyToSubject
      ? `<div class="repair-muted" style="margin-bottom:0.5rem;">Replying to newest: <em>${escapeHtml(threadMeta.replyToSubject)}</em>${threadMeta.replyToUid != null ? ` (uid ${escapeHtml(threadMeta.replyToUid)})` : ''}</div>`
      : '';
    const sentBanner = sent.length
      ? `<div class="repair-sent-banner" role="status">
          <strong>Email already sent</strong> for this case
          ${sent[0].sentAt ? ` on ${escapeHtml(formatWhen(sent[0].sentAt))}` : ''}.
          Do not send again unless Microsoft sent a <em>new</em> email.
          ${sent[0].subject ? `<div class="repair-muted" style="margin-top:0.25rem;">Last subject: ${escapeHtml(sent[0].subject)}</div>` : ''}
        </div>`
      : '';
    const sentCards = sent.map((d) => `
      <div class="repair-draft-card repair-draft-card--sent" data-draft-id="${escapeHtml(d.id)}">
        <div class="repair-draft-sent-badge">SENT</div>
        <div class="repair-draft-meta">
          <strong>${escapeHtml(d.templateKey || 'draft')}</strong>
          · sent${d.sentAt ? ` ${escapeHtml(formatWhen(d.sentAt))}` : ''}
          ${d.inReplyToUid != null ? `· reply-to uid ${escapeHtml(d.inReplyToUid)}` : ''}
        </div>
        <div class="repair-draft-subject">${escapeHtml(d.subject || '')}</div>
        <pre class="repair-draft-body">${escapeHtml(d.body || '')}</pre>
        <div class="repair-muted">This reply was already emailed to MS. Send Email is disabled for this draft.</div>
      </div>`).join('');
    const blockedCards = blocked.map((d) => `
      <div class="repair-draft-card repair-draft-card--blocked" data-draft-id="${escapeHtml(d.id)}">
        <div class="repair-draft-sent-badge repair-draft-sent-badge--blocked">ALREADY SENT</div>
        <div class="repair-draft-meta">
          <strong>${escapeHtml(d.templateKey || 'draft')}</strong>
          · blocked — duplicate of a sent reply
          ${d.alreadySentDraftId ? ` (${escapeHtml(d.alreadySentDraftId)})` : ''}
        </div>
        <div class="repair-draft-subject">${escapeHtml(d.subject || '')}</div>
        <div class="repair-muted">Sending is blocked so you do not email MS twice for the same inbound message.</div>
      </div>`).join('');
    if (!pending.length) {
      return `<div class="repair-optgroup-label">Suggested reply to MS</div>
        ${sentBanner}
        ${sentCards}
        ${blockedCards}
        <div class="repair-muted" style="margin-top:0.5rem;">No new pending draft. Refresh after Microsoft sends another email.</div>`;
    }
    return `<div class="repair-optgroup-label">Suggested reply to MS</div>
      ${sentBanner}
      ${sentCards}
      ${blockedCards}
      ${replyHint}
      <div class="repair-muted" style="margin-bottom:0.55rem;">AI draft from the newest MS email + case briefing (not a canned template). Review To/Cc, edit if needed, then Send Email. Templates are used only when AI is unavailable.</div>
      ${pending.map((d) => {
        const chat = Array.isArray(d.chatHistory) ? d.chatHistory.slice(-8) : [];
        const chatHtml = chat.length
          ? `<div class="repair-draft-chat-log">${chat.map((c) => `
              <div class="repair-draft-chat-item repair-draft-chat-${escapeHtml(c.role || 'user')}">
                <strong>${escapeHtml(c.role === 'assistant' ? 'AI' : 'You')}:</strong>
                ${escapeHtml(c.text || '')}
              </div>`).join('')}</div>`
          : '';
        const questions = Array.isArray(d.operatorQuestions) ? d.operatorQuestions.filter(Boolean) : [];
        const questionsHtml = questions.length
          ? `<div class="repair-draft-questions">
              <div class="repair-draft-questions-title">AI needs answers from you</div>
              <ul>${questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>
              <label class="repair-field">
                <span>Your answers</span>
                <textarea data-draft-answers="${escapeHtml(d.id)}" rows="3" placeholder="Answer each question so AI can finish the MS reply…"></textarea>
              </label>
              <div class="repair-actions">
                <button type="button" class="btn" data-draft-answer="${escapeHtml(d.id)}">Send answers to AI</button>
              </div>
            </div>`
          : '';
        const humanHtml = d.needsHuman
          ? `<div class="repair-draft-human">Human review needed${d.needsHumanReason ? `: ${escapeHtml(d.needsHumanReason)}` : ''}. Also flagged in the top bell.</div>`
          : '';
        const atts = Array.isArray(d.attachments) ? d.attachments : [];
        const docsNeeded = d.needsDocuments || d.templateKey === 'provide_documents';
        const docsHtml = `
          <div class="repair-draft-docs">
            <div class="repair-optgroup-label" style="margin-top:0.35rem;">${docsNeeded ? 'Documents for MS (required)' : 'Attachments (optional)'}</div>
            ${docsNeeded ? `<div class="repair-muted">${escapeHtml((d.documentHints || []).join(' · ') || 'Proof of purchase / invoice / photos MS requested')}</div>` : ''}
            <div class="repair-draft-att-list" data-draft-att-list="${escapeHtml(d.id)}">
              ${atts.length
                ? atts.map((a) => `<a class="repair-att-chip" href="${escapeHtml(a.downloadPath || '#')}" target="_blank" rel="noopener">${escapeHtml(a.filename || a.id)}</a>`).join('')
                : '<span class="repair-muted">No files attached yet</span>'}
            </div>
            <input type="file" multiple hidden data-draft-file-input="${escapeHtml(d.id)}" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.heic,image/*,application/pdf">
            <div class="repair-actions" style="margin-top:0.35rem;">
              <button type="button" class="btn btn-secondary" data-draft-upload="${escapeHtml(d.id)}">Upload files…</button>
            </div>
          </div>`;
        return `
        <div class="repair-draft-card" data-draft-id="${escapeHtml(d.id)}">
          <div class="repair-draft-meta">
            <strong>${escapeHtml(d.templateKey || 'draft')}</strong>
            · ${escapeHtml(d.status)}
            · ${escapeHtml((d.draftSource === 'ai' || d.templateKey === 'ai_reply') ? 'AI' : 'template')}
            ${d.emailDate ? `· email ${escapeHtml(formatWhen(d.emailDate))}` : ''}
            ${d.inReplyToUid != null ? `· reply-to uid ${escapeHtml(d.inReplyToUid)}` : ''}
          </div>
          ${d.why ? `<div class="repair-muted">${escapeHtml(d.why)}</div>` : ''}
          ${Array.isArray(d.caseDeviceSerials) && d.caseDeviceSerials.length > 1
            ? `<div class="repair-muted">Case devices: ${escapeHtml(d.caseDeviceSerials.join(', '))}</div>`
            : ''}
          ${humanHtml}
          ${(() => {
            const env = d.envelope || {};
            const rows = [
              ['From', env.from],
              ['To', env.to],
              ['Cc', env.cc],
              ['Email From', env.originalFrom],
              ['Email To', env.originalTo],
              ['Email Cc', env.originalCc]
            ].filter(([, v]) => v && String(v).trim());
            if (!rows.length) return '';
            const sourceNote = env.headerSource === 'forwarded_body'
              ? '<div class="repair-muted" style="margin:0.2rem 0 0.35rem;">To/Cc taken from the forwarded Microsoft message (not the Fw: wrapper).</div>'
              : '';
            return `<div class="repair-draft-envelope">
              <div class="repair-draft-envelope-title">Will send as (everyone on the ticket)</div>
              ${sourceNote}
              ${rows.map(([k, v]) => `
                <div class="repair-draft-envelope-row">
                  <span class="repair-draft-envelope-key">${escapeHtml(k)}</span>
                  <span class="repair-draft-envelope-val">${escapeHtml(v)}</span>
                </div>`).join('')}
              <div class="repair-muted" style="margin-top:0.35rem;">To = Microsoft · Cc = everyone else from the original email (Abe, OrderAssist, MS agent, etc.).</div>
            </div>`;
          })()}
          ${d.status === 'pending' ? `
            <label class="repair-field" style="margin-top:0.45rem;">
              <span>Subject</span>
              <input type="text" class="repair-draft-subject-input" data-draft-subject="${escapeHtml(d.id)}" value="${escapeHtml(d.subject || '')}" />
            </label>
            <label class="repair-field">
              <span>Body (edit before sending)</span>
              <textarea class="repair-draft-body-input" data-draft-body="${escapeHtml(d.id)}" rows="10">${escapeHtml(d.body || '')}</textarea>
            </label>
            ${docsHtml}
            ${questionsHtml}
            <div class="repair-draft-ai">
              <div class="repair-optgroup-label" style="margin-top:0.35rem;">Discuss with AI</div>
              ${chatHtml}
              <label class="repair-field">
                <span>Tell the AI how to improve (or what we already tested)</span>
                <textarea data-draft-ai-msg="${escapeHtml(d.id)}" rows="2" placeholder="e.g. We already ran Surface diagnostic + battery reset. Ask MS to escalate for motherboard. Keep case open."></textarea>
              </label>
              <div class="repair-actions" style="margin-top:0.35rem;">
                <button type="button" class="btn" data-draft-brief="${escapeHtml(d.id)}">Prepare with AI</button>
                <button type="button" class="btn btn-secondary" data-draft-improve="${escapeHtml(d.id)}">Improve with AI</button>
                <button type="button" class="btn btn-secondary" data-draft-save="${escapeHtml(d.id)}">Save edits</button>
              </div>
            </div>
            <div class="repair-actions" style="margin-top:0.65rem;">
              <button type="button" class="btn" data-draft-approve="${escapeHtml(d.id)}">Send Email</button>
              <button type="button" class="btn btn-secondary" data-draft-reject="${escapeHtml(d.id)}">Reject</button>
            </div>
            <div class="repair-muted" style="margin-top:0.35rem;">Send Email uses the To/Cc above. If SMTP is off, it queues the reply until outgoing mail is enabled.</div>
            <label class="repair-field" style="margin-top:0.5rem;">
              <span>Reject training reason (required to reject)</span>
              <textarea data-draft-reason="${escapeHtml(d.id)}" placeholder="e.g. Too vague — should include outbound TN promise and warehouse ship day"></textarea>
            </label>
          ` : `
            <div class="repair-draft-subject">${escapeHtml(d.subject || '')}</div>
            <pre class="repair-draft-body">${escapeHtml(d.body || '')}</pre>
            <div class="repair-muted">Approved — queued until SMTP outgoing is enabled.</div>
            <div class="repair-actions" style="margin-top:0.5rem;">
              <button type="button" class="btn" data-draft-approve="${escapeHtml(d.id)}">Send Email</button>
            </div>
          `}
        </div>`;
      }).join('')}`;
  }

  function attachmentChipsHtml(atts) {
    const list = Array.isArray(atts) ? atts : [];
    if (!list.length) return '';
    return `<div class="repair-att-row">${list.map((a) => {
      const href = a.downloadPath || `/api/ms-email/attachments/${encodeURIComponent(a.id)}`;
      const isImg = /image\//i.test(a.contentType || '') || /\.(png|jpe?g|gif|webp)$/i.test(a.filename || '');
      if (isImg) {
        return `<a class="repair-att-chip" href="${escapeHtml(href)}" target="_blank" rel="noopener">
          <img class="repair-att-thumb" src="${escapeHtml(href)}" alt="${escapeHtml(a.filename || 'image')}" loading="lazy" />
          <span>${escapeHtml(a.filename || 'image')}</span>
        </a>`;
      }
      return `<a class="repair-att-chip" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(a.filename || a.id)}</a>`;
    }).join('')}</div>`;
  }

  function formatSpecGb(value) {
    if (value == null || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    if (n >= 1024 && n % 1024 === 0) return `${n / 1024} TB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} TB`;
    return `${n} GB`;
  }

  function deviceSpecsHtml(ticket) {
    const warrantyInfo = (window.OAWarranty && window.OAWarranty.warrantyCountdown)
      ? window.OAWarranty.warrantyCountdown({
        status: ticket.warrantyStatus,
        expiresOn: ticket.warrantyExpires
      })
      : null;
    const expiry = warrantyInfo && warrantyInfo.lineLabel
      ? warrantyInfo.lineLabel
      : (ticket.warrantyExpires
        ? String(ticket.warrantyExpires).slice(0, 10)
        : (ticket.warrantyStatus || '—'));
    const deviceName = ticket.warrantyDeviceName || ticket.model || ticket.msDeviceModel || '—';
    const model = ticket.model || ticket.msDeviceModel || ticket.warrantyDeviceName || '—';
    return `<div class="repair-specs-card">
      <div class="repair-specs-title">Device &amp; warranty</div>
      <div class="repair-specs-grid">
        <div class="repair-specs-item"><span>Serial</span><strong>${escapeHtml(ticket.serialNumber || '—')}</strong></div>
        <div class="repair-specs-item"><span>Device name</span><strong>${escapeHtml(deviceName)}</strong></div>
        <div class="repair-specs-item"><span>Model</span><strong>${escapeHtml(model)}</strong></div>
        <div class="repair-specs-item"><span>Processor</span><strong>${escapeHtml(ticket.cpu || '—')}</strong></div>
        <div class="repair-specs-item"><span>RAM</span><strong>${escapeHtml(formatSpecGb(ticket.ram))}</strong></div>
        <div class="repair-specs-item"><span>HD</span><strong>${escapeHtml(formatSpecGb(ticket.hd))}</strong></div>
        <div class="repair-specs-item"><span>Warranty</span><strong>${escapeHtml(expiry)}</strong></div>
      </div>
    </div>`;
  }

  function closeOverlay() {
    const backdrop = document.getElementById('repairOverlayBackdrop');
    if (backdrop) backdrop.hidden = true;
    const body = document.getElementById('repairOverlayBody');
    if (body) body.innerHTML = '';
  }

  function openOverlay(title, html) {
    const backdrop = document.getElementById('repairOverlayBackdrop');
    const titleEl = document.getElementById('repairOverlayTitle');
    const body = document.getElementById('repairOverlayBody');
    if (titleEl) titleEl.textContent = title || 'Details';
    if (body) body.innerHTML = html || '';
    if (backdrop) backdrop.hidden = false;
  }

  async function openEmailHistoryOverlay(ticket) {
    if (!ticket) return;
    openOverlay(
      `Email history · ${ticket.serialNumber || ''}`,
      `${deviceSpecsHtml(ticket)}
       <div class="repair-muted" style="margin-bottom:0.65rem;">Full MS ↔ you thread (newest first).</div>
       <div id="repairOverlayThread" class="repair-overlay-thread"><div class="repair-muted">Loading emails…</div></div>`
    );
    const threadEl = document.getElementById('repairOverlayThread');
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timeoutId = setTimeout(() => {
      try { controller && controller.abort(); } catch (_) { /* ignore */ }
    }, 25000);
    try {
      const response = await fetch(`/api/ms-email/thread?ticketId=${encodeURIComponent(ticket.id)}`, {
        credentials: 'same-origin',
        signal: controller ? controller.signal : undefined
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Thread failed (${response.status})`);
      }
      const messages = data.messages || [];
      if (threadEl) {
        threadEl.innerHTML = threadHtml(messages);
        fillMailFrames(threadEl, messages);
        // Open all messages in the history box so the back-and-forth is visible
        threadEl.querySelectorAll('details.repair-thread-msg').forEach((el) => { el.open = true; });
      }
    } catch (error) {
      if (threadEl) {
        const aborted = error && (error.name === 'AbortError' || /aborted/i.test(String(error.message || '')));
        const msg = aborted
          ? 'Timed out loading email history. Try again — if it keeps hanging, the inbox may be busy.'
          : (error.message || 'Could not load email history');
        threadEl.innerHTML = `<div class="repair-muted">${escapeHtml(msg)}</div>`;
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Prefer labels whose SN matches this ticket; fall back to all if none are SN-scoped. */
  function labelsForTicket(ticket) {
    const all = Array.isArray(ticket.msShippingLabels) ? ticket.msShippingLabels : [];
    const sn = String(ticket.serialNumber || '').trim().toUpperCase();
    if (!sn || !all.length) return all;
    const matched = all.filter((lab) => {
      const labSn = String(lab.serialNumber || '').trim().toUpperCase();
      if (labSn) return labSn === sn;
      // Filename / storedName often embeds SN (e.g. 2046_0F3DGWV24493HJ-ShippingLabel.pdf)
      const hay = `${lab.filename || ''} ${lab.storedName || ''}`.toUpperCase();
      return hay.includes(sn);
    });
    return matched.length ? matched : all;
  }

  function labelGalleryHtml(ticket) {
    const labels = labelsForTicket(ticket);
    if (!labels.length) {
      return `${deviceSpecsHtml(ticket)}
        <div class="repair-muted">No shipping label PDFs on this ticket yet.</div>`;
    }
    return `${deviceSpecsHtml(ticket)}
      <p class="repair-muted" style="margin:0 0 0.75rem;">
        Printers may not be installed on this PC yet — View / Download always work; Print queues when the agent is ready.
      </p>
      <div class="repair-label-gallery">${labels.map((lab) => {
        const href = lab.downloadPath || `/api/ms-email/labels/${encodeURIComponent(lab.id)}`;
        const meta = [
          lab.size ? `${Math.round(lab.size / 1024)} KB` : null,
          lab.at ? formatWhen(lab.at) : null,
          lab.serialNumber ? `SN ${lab.serialNumber}` : null,
          lab.orderNumber ? `Order ${lab.orderNumber}` : null,
          lab.trackingNumber ? `TN ${lab.trackingNumber}` : null
        ].filter(Boolean).join(' · ');
        return `<div class="repair-label-card" data-label-card="${escapeHtml(lab.id)}">
          <div class="repair-label-card-head">
            <div>
              <strong>${escapeHtml(lab.filename || 'ShippingLabel.pdf')}</strong>
              <div class="repair-muted">${escapeHtml(meta || 'MS shipping label')}</div>
            </div>
            <div class="repair-actions">
              <a class="btn btn-secondary" href="${escapeHtml(href)}" target="_blank" rel="noopener">View PDF</a>
              <a class="btn btn-secondary" href="${escapeHtml(href)}" download="${escapeHtml(lab.filename || 'ShippingLabel.pdf')}">Download</a>
              <button type="button" class="btn btn-secondary" data-view-specs="${escapeHtml(lab.id)}"
                data-print-serial="${escapeHtml(ticket.serialNumber || '')}" data-print-ticket="${escapeHtml(ticket.id || '')}">View specs</button>
              <button type="button" class="btn" data-print-mode="label" data-print-both="${escapeHtml(lab.id)}"
                data-print-serial="${escapeHtml(ticket.serialNumber || '')}" data-print-ticket="${escapeHtml(ticket.id || '')}">Print label</button>
              <button type="button" class="btn btn-secondary" data-print-mode="sheet" data-print-both="${escapeHtml(lab.id)}"
                data-print-serial="${escapeHtml(ticket.serialNumber || '')}" data-print-ticket="${escapeHtml(ticket.id || '')}">Print specs</button>
            </div>
          </div>
          <iframe class="repair-pdf-frame" src="${escapeHtml(href)}" title="Label PDF"></iframe>
          <div class="repair-printer-note" data-print-status="${escapeHtml(lab.id)}" hidden></div>
        </div>`;
      }).join('')}</div>`;
  }

  function openLabelGalleryOverlay(ticket) {
    if (!ticket) return;
    openOverlay(`Labels · ${ticket.serialNumber || ''}`, labelGalleryHtml(ticket));
    const body = document.getElementById('repairOverlayBody');
    body?.querySelectorAll('[data-print-both]').forEach((btn) => {
      btn.addEventListener('click', () => printMsLabelBoth(
        btn.dataset.printBoth,
        btn.dataset.printSerial,
        btn.dataset.printTicket,
        btn.dataset.printMode || 'queue',
        btn
      ));
    });
    body?.querySelectorAll('[data-view-specs]').forEach((btn) => {
      btn.addEventListener('click', () => viewMsSpecsSheet(
        btn.dataset.viewSpecs,
        btn.dataset.printSerial,
        btn.dataset.printTicket,
        btn
      ));
    });
  }

  function threadHtml(messages) {
    if (!messages || !messages.length) {
      return `<div class="repair-optgroup-label">MS email chain</div>
        <div class="repair-muted">No matching emails in ms-returns yet for this ticket’s case / order / SN.</div>`;
    }
    return `<div class="repair-optgroup-label">MS email chain (${messages.length})</div>
      <div class="repair-thread">${messages.slice().reverse().map((m) => `
        <details class="repair-thread-msg" ${messages.length <= 3 ? 'open' : ''}>
          <summary>
            <strong>${escapeHtml(m.subject || '(no subject)')}</strong>
            <span class="repair-muted"> · ${escapeHtml(formatWhen(m.date))} · ${escapeHtml(m.from || '')}</span>
          </summary>
          <div class="repair-thread-from repair-muted">To: ${escapeHtml(m.to || '—')} · uid ${escapeHtml(m.uid)}</div>
          ${attachmentChipsHtml(m.attachments)}
          ${m.html
            ? `<iframe class="repair-mail-frame" data-mail-uid="${escapeHtml(m.uid)}" title="Email body" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>`
            : `<pre class="repair-draft-body">${escapeHtml(m.text || m.preview || '')}</pre>`}
        </details>
      `).join('')}</div>`;
  }

  function fillMailFrames(root, messages) {
    if (!root) return;
    const byUid = new Map((messages || []).map((m) => [String(m.uid), m]));
    root.querySelectorAll('iframe[data-mail-uid]').forEach((frame) => {
      const msg = byUid.get(String(frame.getAttribute('data-mail-uid')));
      if (msg && msg.html) frame.srcdoc = wrapMailHtml(msg.html);
    });
  }

  function wrapMailHtml(html) {
    // Keep relative attachment URLs working inside srcdoc by leaving paths as-is (same origin).
    return `<!doctype html><html><head><meta charset="utf-8">
      <style>body{font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#0f172a;margin:12px;word-break:break-word;}
      img{max-width:100%;height:auto;} a{color:#1d4ed8;}</style></head><body>${html}</body></html>`;
  }

  async function loadMsThreadAndDrafts(ticket) {
    const draftsEl = document.getElementById('repairMsDrafts');
    const threadEl = document.getElementById('repairMsThread');
    if (!ticket || !ticket.id) {
      if (draftsEl) draftsEl.innerHTML = '';
      if (threadEl) threadEl.innerHTML = '';
      return;
    }
    try {
      if (draftsEl) {
        draftsEl.innerHTML = '<div class="repair-muted">Refreshing… AI is rewriting the draft from the newest MS email (up to ~90s). If AI fails, the template seed stays until you try again.</div>';
      }
      // Refresh drafts from newest mail only, then load thread+drafts together
      const refreshRes = await fetch('/api/ms-email/drafts/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ ticketId: ticket.id })
      }).catch(() => null);
      const refreshData = refreshRes ? await refreshRes.json().catch(() => ({})) : {};

      const response = await fetch(`/api/ms-email/thread?ticketId=${encodeURIComponent(ticket.id)}`, {
        credentials: 'same-origin',
        signal: AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Thread failed (${response.status})`);
      }
      const threadMeta = {
        replyToUid: refreshData.replyToUid != null ? refreshData.replyToUid : (data.messages && data.messages.length ? data.messages[data.messages.length - 1].uid : null),
        replyToSubject: refreshData.replyToSubject || (data.messages && data.messages.length ? data.messages[data.messages.length - 1].subject : null)
      };
      if (draftsEl) {
        draftsEl.innerHTML = draftCardsHtml(data.drafts || [], threadMeta)
          + `<div class="repair-actions" style="margin-top:0.4rem;">
              <button type="button" class="btn btn-secondary" id="repairDraftsRefresh">Refresh drafts</button>
            </div>`;
        document.getElementById('repairDraftsRefresh')?.addEventListener('click', () => loadMsThreadAndDrafts(ticket));
        bindDraftActions(ticket);
        const draftFocus = window.__oaRepairDraftFocus;
        if (draftFocus) {
          window.__oaRepairDraftFocus = null;
          const card = draftsEl.querySelector(`[data-draft-id="${CSS.escape ? CSS.escape(String(draftFocus)) : String(draftFocus)}"]`);
          if (card) {
            card.classList.add('is-notif-focus');
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }
      if (threadEl) {
        threadEl.innerHTML = threadHtml(data.messages || []);
        fillMailFrames(threadEl, data.messages || []);
      }
    } catch (error) {
      if (draftsEl) draftsEl.innerHTML = `<div class="repair-muted">Drafts: ${escapeHtml(error.message || 'failed')}</div>`;
      if (threadEl) threadEl.innerHTML = `<div class="repair-muted">Thread: ${escapeHtml(error.message || 'failed')}</div>`;
    }
  }

  function draftEditorValues(id) {
    const subject = (document.querySelector(`[data-draft-subject="${id}"]`)?.value || '').trim();
    const body = (document.querySelector(`[data-draft-body="${id}"]`)?.value || '').trim();
    return { subject, body };
  }

  function bindDraftActions(ticket) {
    function beginAction(btn, label) {
      if (busy) {
        message('Still working on the previous action — wait a moment…', 'error');
        return false;
      }
      busy = true;
      if (btn) {
        btn.disabled = true;
        if (label) {
          btn.dataset.prevLabel = btn.textContent || '';
          btn.textContent = label;
        }
      }
      return true;
    }
    function endAction(btn) {
      busy = false;
      if (btn) {
        btn.disabled = false;
        if (btn.dataset.prevLabel) {
          btn.textContent = btn.dataset.prevLabel;
          delete btn.dataset.prevLabel;
        }
      }
    }

    document.querySelectorAll('[data-draft-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-draft-save');
        if (!id || !beginAction(btn, 'Saving…')) return;
        try {
          const { subject, body } = draftEditorValues(id);
          const response = await fetch(`/api/ms-email/drafts/${encodeURIComponent(id)}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ subject, body })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) throw new Error(data.error || 'Save failed');
          message('Draft edits saved.');
        } catch (error) {
          message(error.message || 'Save failed', 'error');
        } finally {
          endAction(btn);
        }
      });
    });

    document.querySelectorAll('[data-draft-improve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-draft-improve');
        let instruction = (document.querySelector(`[data-draft-ai-msg="${id}"]`)?.value || '').trim();
        if (!id) return;
        if (instruction.length < 2) {
          instruction = 'Improve this reply for clarity and professionalism using full case context.';
        }
        if (!beginAction(btn, 'Improving…')) return;
        try {
          const { subject, body } = draftEditorValues(id);
          const response = await fetch(`/api/ms-email/drafts/${encodeURIComponent(id)}/improve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ message: instruction, subject, body })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) throw new Error(data.error || 'AI improve failed');
          const d = data.draft || {};
          const subjEl = document.querySelector(`[data-draft-subject="${id}"]`);
          const bodyEl = document.querySelector(`[data-draft-body="${id}"]`);
          if (subjEl && d.subject != null) subjEl.value = d.subject;
          if (bodyEl && d.body != null) bodyEl.value = d.body;
          const aiBox = document.querySelector(`[data-draft-ai-msg="${id}"]`);
          if (aiBox) aiBox.value = '';
          const note = data.note ? ` — ${data.note}` : '';
          const src = data.source === 'cursor' || data.source === 'openai' ? 'AI' : 'local helper';
          message(`Draft updated by ${src}.${note}`);
          await loadMsThreadAndDrafts(ticket);
        } catch (error) {
          message(error.message || 'AI improve failed', 'error');
        } finally {
          endAction(btn);
        }
      });
    });

    document.querySelectorAll('[data-draft-brief]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-draft-brief');
        if (!id || !beginAction(btn, 'Preparing…')) return;
        try {
          const { subject, body } = draftEditorValues(id);
          const response = await fetch(`/api/ms-email/drafts/${encodeURIComponent(id)}/brief`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ subject, body })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) throw new Error(data.error || 'AI prepare failed');
          message(data.needsHuman
            ? `AI prepared draft — human review flagged${data.needsHumanReason ? `: ${data.needsHumanReason}` : ''}`
            : 'AI prepared draft from full case context.');
          await loadMsThreadAndDrafts(ticket);
        } catch (error) {
          message(error.message || 'AI prepare failed', 'error');
        } finally {
          endAction(btn);
        }
      });
    });

    document.querySelectorAll('[data-draft-answer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-draft-answer');
        const answers = (document.querySelector(`[data-draft-answers="${id}"]`)?.value || '').trim();
        if (!id) return;
        if (answers.length < 2) {
          message('Answer the AI questions first.', 'error');
          return;
        }
        if (!beginAction(btn, 'Sending…')) return;
        try {
          const { subject, body } = draftEditorValues(id);
          const response = await fetch(`/api/ms-email/drafts/${encodeURIComponent(id)}/answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ answers, subject, body })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) throw new Error(data.error || 'Answer failed');
          message('Answers applied — draft updated.');
          await loadMsThreadAndDrafts(ticket);
        } catch (error) {
          message(error.message || 'Answer failed', 'error');
        } finally {
          endAction(btn);
        }
      });
    });

    document.querySelectorAll('[data-draft-upload]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-draft-upload');
        const input = document.querySelector(`[data-draft-file-input="${id}"]`);
        if (input) input.click();
      });
    });

    document.querySelectorAll('[data-draft-file-input]').forEach((input) => {
      input.addEventListener('change', async () => {
        const id = input.getAttribute('data-draft-file-input');
        if (!id || !input.files || !input.files.length) return;
        if (!beginAction(null, null)) return;
        try {
          const fd = new FormData();
          for (const file of input.files) fd.append('files', file);
          const response = await fetch(`/api/ms-email/drafts/${encodeURIComponent(id)}/files`, {
            method: 'POST',
            credentials: 'same-origin',
            body: fd
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) throw new Error(data.error || 'Upload failed');
          message(`Uploaded ${data.saved || 0} file(s) — they will attach on Send Email.`);
          await loadMsThreadAndDrafts(ticket);
        } catch (error) {
          message(error.message || 'Upload failed', 'error');
        } finally {
          endAction(null);
          input.value = '';
        }
      });
    });

    document.querySelectorAll('[data-draft-approve]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-draft-approve');
        if (!id) return;
        if (!window.confirm(
          'Send this email to Microsoft now?\n\n'
          + 'If you already sent a reply for this case / inbound email, cancel — duplicates are blocked after the first successful send.'
        )) return;
        if (!beginAction(btn, 'Sending…')) return;
        try {
          const { subject, body } = draftEditorValues(id);
          const response = await fetch(`/api/ms-email/drafts/${encodeURIComponent(id)}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ subject, body })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) throw new Error(data.error || 'Send failed');
          const sendNote = data.send && data.send.note ? ` — ${data.send.note}` : '';
          message(data.send && data.send.sent
            ? `Email sent to MS.${sendNote}${data.send.sentFolder ? ` Saved to ${data.send.sentFolder}.` : (data.send.sentAppendError ? ` Warning: not copied to Sent (${data.send.sentAppendError}).` : '')} This case now shows SENT — do not send again for the same inbound email.`
            : `Email approved but not sent yet.${sendNote || ' SMTP outgoing is disabled — queued until enabled.'}`);
          await loadMsThreadAndDrafts(ticket);
        } catch (error) {
          message(error.message || 'Send failed', 'error');
        } finally {
          endAction(btn);
        }
      });
    });

    document.querySelectorAll('[data-draft-reject]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-draft-reject');
        const reason = (document.querySelector(`[data-draft-reason="${id}"]`)?.value || '').trim();
        if (!id) return;
        if (reason.length < 3) {
          message('Add a training reason before rejecting (what should change).', 'error');
          return;
        }
        if (!beginAction(btn, 'Rejecting…')) return;
        try {
          const response = await fetch(`/api/ms-email/drafts/${encodeURIComponent(id)}/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ reason })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || !data.ok) throw new Error(data.error || 'Reject failed');
          message('Draft rejected — reason saved for training.');
          await loadMsThreadAndDrafts(ticket);
        } catch (error) {
          message(error.message || 'Reject failed', 'error');
        } finally {
          endAction(btn);
        }
      });
    });
  }

  function labelBlockHtml(ticket) {
    const labels = labelsForTicket(ticket);
    if (!labels.length) {
      if ((ticket.pipeline || '') === 'ship') {
        return `<div class="repair-label-box repair-muted">No shipping label PDF on this ticket yet. Forward the MS “return your device” email (with the PDF attached) to ms-returns@ — it will show up here.</div>`;
      }
      return '';
    }
    return `<div class="repair-optgroup-label">MS shipping label (from email)</div>
      <div class="repair-label-box">${labels.map((lab) => {
        const href = lab.downloadPath || `/api/ms-email/labels/${encodeURIComponent(lab.id)}`;
        const metaBits = [
          lab.size ? `${Math.round(lab.size / 1024)} KB` : null,
          lab.at ? formatWhen(lab.at) : null,
          lab.serialNumber ? `SN ${lab.serialNumber}` : null,
          lab.orderNumber ? `Order ${lab.orderNumber}` : null
        ].filter(Boolean).join(' · ');
        return `<div class="repair-label-row">
          <div>
            <strong>${escapeHtml(lab.filename || 'ShippingLabel.pdf')}</strong>
            <div class="repair-muted">${escapeHtml(metaBits)}</div>
          </div>
          <div class="repair-actions">
            <a class="btn btn-secondary" href="${escapeHtml(href)}" target="_blank" rel="noopener">View PDF</a>
            <a class="btn btn-secondary" href="${escapeHtml(href)}" download="${escapeHtml(lab.filename || 'ShippingLabel.pdf')}">Download</a>
            <button type="button" class="btn btn-secondary" data-view-specs="${escapeHtml(lab.id)}" data-print-serial="${escapeHtml(ticket.serialNumber || '')}" data-print-ticket="${escapeHtml(ticket.id || '')}">View specs</button>
            <button type="button" class="btn" data-print-mode="label" data-print-both="${escapeHtml(lab.id)}" data-print-serial="${escapeHtml(ticket.serialNumber || '')}" data-print-ticket="${escapeHtml(ticket.id || '')}">Print label</button>
            <button type="button" class="btn btn-secondary" data-print-mode="sheet" data-print-both="${escapeHtml(lab.id)}" data-print-serial="${escapeHtml(ticket.serialNumber || '')}" data-print-ticket="${escapeHtml(ticket.id || '')}">Print specs</button>
            <button type="button" class="btn btn-secondary" data-label-gallery="${escapeHtml(ticket.id)}">All labels</button>
          </div>
        </div>`;
      }).join('')}</div>`;
  }

  function stageActionButtons(ticket) {
    const pipe = ticket.pipeline || mainTab || 'needs';
    const stage = STAGE_SHEET[pipe] || STAGE_SHEET.needs;
    if (!stage.actions.length) return '';
    return `<div class="repair-optgroup-label">This stage</div>
      <div class="repair-stage-actions">${stage.actions.map((action) => {
        const cls = action.primary ? 'btn' : 'btn btn-secondary';
        if (action.resolve) {
          return `<button type="button" class="${cls}" data-stage-resolve="${escapeHtml(action.resolve)}">${escapeHtml(action.label)}</button>`;
        }
        return `<button type="button" class="${cls}" data-stage-status="${escapeHtml(action.status)}" data-require="${escapeHtml(action.require || '')}">${escapeHtml(action.label)}</button>`;
      }).join('')}</div>`;
  }

  function stageFieldsHtml(ticket) {
    const pipe = ticket.pipeline || mainTab || 'needs';
    const fields = (STAGE_SHEET[pipe] || STAGE_SHEET.needs).fields || [];
    const show = (name) => fields.includes(name);
    const parts = [];
    if (show('msProgram')) {
      parts.push(`<label class="repair-field">
        <span>Microsoft program</span>
        <select id="repairSheetMsProgram">${msProgramOptions(ticket.msProgram || '')}</select>
      </label>`);
    } else {
      parts.push(`<input type="hidden" id="repairSheetMsProgram" value="${escapeHtml(ticket.msProgram || '')}">`);
    }
    if (show('msCaseId')) {
      parts.push(`<label class="repair-field">
        <span>MS case / service ID</span>
        <input id="repairSheetMsCase" value="${escapeHtml(ticket.msCaseId || '')}" placeholder="e.g. 2501080040014227" autocomplete="off">
      </label>`);
    } else {
      parts.push(`<input type="hidden" id="repairSheetMsCase" value="${escapeHtml(ticket.msCaseId || '')}">`);
    }
    if (show('msOrderNumber')) {
      parts.push(`<label class="repair-field">
        <span>MS order number</span>
        <input id="repairSheetMsOrder" value="${escapeHtml(ticket.msOrderNumber || '')}" placeholder="e.g. 2038068035" autocomplete="off">
      </label>`);
    } else {
      parts.push(`<input type="hidden" id="repairSheetMsOrder" value="${escapeHtml(ticket.msOrderNumber || '')}">`);
    }
    if (show('msRejectReason') || ticket.status === 'ms_rejected') {
      parts.push(`<label class="repair-field" id="repairSheetRejectWrap">
        <span>MS reject reason</span>
        <select id="repairSheetRejectReason">${rejectReasonOptions(ticket.msRejectReason || '')}</select>
      </label>`);
    } else {
      parts.push(`<input type="hidden" id="repairSheetRejectReason" value="${escapeHtml(ticket.msRejectReason || '')}">`);
    }
    if (show('outboundTracking')) {
      parts.push(`<label class="repair-field">
        <span>Outbound tracking (you → MS)</span>
        <input id="repairSheetOutTn" value="${escapeHtml(ticket.outboundTracking || '')}" placeholder="When you ship to MS" autocomplete="off">
      </label>`);
    } else {
      parts.push(`<input type="hidden" id="repairSheetOutTn" value="${escapeHtml(ticket.outboundTracking || '')}">`);
    }
    if (show('inboundTracking')) {
      parts.push(`<label class="repair-field">
        <span>Inbound tracking (MS → you)</span>
        <input id="repairSheetInTn" value="${escapeHtml(ticket.inboundTracking || '')}" placeholder="From MS shipment email" autocomplete="off">
      </label>`);
    } else {
      parts.push(`<input type="hidden" id="repairSheetInTn" value="${escapeHtml(ticket.inboundTracking || '')}">`);
    }
    if (show('msDefectiveSerial') || ticket.msDefectiveSerial || ticket.msReplacementSerial) {
      parts.push(`<label class="repair-field">
        <span>Defective SN (sent to MS)</span>
        <input id="repairSheetDefectiveSn" value="${escapeHtml(ticket.msDefectiveSerial || '')}" placeholder="Original unit SN" autocomplete="off" autocapitalize="characters">
      </label>`);
      parts.push(`<label class="repair-field">
        <span>Replacement SN (from MS)</span>
        <input id="repairSheetReplacementSn" value="${escapeHtml(ticket.msReplacementSerial || '')}" placeholder="Confirm SN on returned unit" autocomplete="off" autocapitalize="characters">
      </label>`);
    } else {
      parts.push(`<input type="hidden" id="repairSheetDefectiveSn" value="${escapeHtml(ticket.msDefectiveSerial || '')}">`);
      parts.push(`<input type="hidden" id="repairSheetReplacementSn" value="${escapeHtml(ticket.msReplacementSerial || '')}">`);
    }
    if (show('promoteReplacement')) {
      parts.push(`<label class="repair-field" style="flex-direction:row;align-items:center;gap:0.5rem;">
        <input type="checkbox" id="repairSheetPromoteReplacement" ${ticket.msReplacementSerial ? 'checked' : ''}>
        <span>Promote replacement SN to inventory identity</span>
      </label>`);
    } else {
      parts.push(`<input type="hidden" id="repairSheetPromoteReplacement" value="">`);
    }
    if (show('expectedBackAt')) {
      parts.push(`<label class="repair-field">
        <span>Expected back date</span>
        <input id="repairSheetExpected" type="date" value="${escapeHtml((ticket.expectedBackAt || '').slice(0, 10))}">
      </label>`);
    } else {
      parts.push(`<input type="hidden" id="repairSheetExpected" value="${escapeHtml((ticket.expectedBackAt || '').slice(0, 10))}">`);
    }
    // vendor always kept but rarely edited — hidden with default Microsoft
    parts.push(`<input type="hidden" id="repairSheetVendor" value="${escapeHtml(ticket.vendorName || 'Microsoft')}">`);

    const noteField = show('note')
      ? `<label class="repair-field">
          <span>Note</span>
          <textarea id="repairSheetNote" placeholder="What’s wrong / what MS said / label printed…"></textarea>
        </label>`
      : `<textarea id="repairSheetNote" hidden></textarea>`;

    return `<div class="repair-grid-2">${parts.join('')}</div>${noteField}`;
  }

  function openManageSheet(ticket) {
    activeTicket = ticket;
    const backdrop = document.getElementById('repairSheetBackdrop');
    const title = document.getElementById('repairSheetTitle');
    const pipe = ticket.pipeline || 'needs';
    const stage = STAGE_SHEET[pipe] || STAGE_SHEET.needs;
    if (title) title.textContent = `${stage.heading} · ${ticket.serialNumber}`;
    const statusLabelFor = (key) =>
      (((meta.statuses || []).find((s) => s.key === key) || {}).label) || key;
    const history = (ticket.statusHistory || []).slice().reverse().slice(0, 12).map((row) => (
      `<div class="repair-history-item"><strong>${escapeHtml(statusLabelFor(row.status))}</strong> · ${escapeHtml(formatWhen(row.at))}`
      + (row.by ? ` · ${escapeHtml(row.by)}` : '')
      + (row.note ? `<div class="repair-muted">${escapeHtml(row.note)}</div>` : '')
      + '</div>'
    )).join('') || '<div class="repair-muted">No status history yet.</div>';

    const notes = (ticket.notes || []).slice().reverse().slice(0, 12).map((row) => (
      `<div class="repair-history-item"><strong>${escapeHtml(formatWhen(row.at))}</strong>`
      + (row.by ? ` · ${escapeHtml(row.by)}` : '')
      + `<div>${escapeHtml(row.text || '')}</div></div>`
    )).join('') || '<div class="repair-muted">No operator notes yet.</div>';

    const nextBlock = ticket.nextActionTitle
      ? `<p class="repair-hint"><strong>Next:</strong> ${escapeHtml(ticket.nextActionTitle)}`
        + (ticket.nextActionDetail ? `<br>${escapeHtml(ticket.nextActionDetail)}` : '')
        + '</p>'
      : '';

    const warrantyInfo = (window.OAWarranty && window.OAWarranty.warrantyCountdown)
      ? window.OAWarranty.warrantyCountdown({
        status: ticket.warrantyStatus,
        expiresOn: ticket.warrantyExpires
      })
      : null;
    const warrantyLine = [
      warrantyInfo && warrantyInfo.lineLabel
        ? warrantyInfo.lineLabel
        : [
          ticket.warrantyStatus,
          ticket.warrantyExpires && /^\d{4}-\d{2}-\d{2}/.test(String(ticket.warrantyExpires))
            ? `expires ${String(ticket.warrantyExpires).slice(0, 10)}`
            : null
        ].filter(Boolean).join(' · '),
      ticket.warrantyDeviceName
    ].filter(Boolean).join(' · ');

    const emailNote = lastEmailNote(ticket);
    const emailBanner = emailNote
      ? `<div class="repair-email-banner"><strong>From MS email</strong> · ${escapeHtml(formatWhen(emailNote.at))}<div class="repair-muted">${escapeHtml(emailNote.text || '')}</div></div>`
      : '';

    const summaryBits = [
      ticket.msCaseId ? `Case ${ticket.msCaseId}` : null,
      ticket.msOrderNumber ? `Order ${ticket.msOrderNumber}` : null,
      ticket.msDeviceModel || null,
      ticket.outboundTracking ? `Out ${ticket.outboundTracking}` : null,
      ticket.inboundTracking ? `In ${ticket.inboundTracking}` : null,
      ticket.msProgramLabel || null
    ].filter(Boolean).join(' · ');

    const relatedBits = [];
    if (Array.isArray(ticket.msRelatedCases) && ticket.msRelatedCases.length) {
      relatedBits.push(`Related cases: ${ticket.msRelatedCases.join(', ')}`);
    }
    if (Array.isArray(ticket.msSiblingSerials) && ticket.msSiblingSerials.length) {
      relatedBits.push(`Other devices on case: ${ticket.msSiblingSerials.join(', ')}`);
    }
    const relatedHtml = relatedBits.length
      ? `<p class="repair-hint">${relatedBits.map((b) => escapeHtml(b)).join('<br>')}</p>`
      : '';

    setHtml('repairSheetBody', `
      <p class="repair-hint">${escapeHtml(ticket.issue || 'No issue text')} ${ticket.quickTag ? `· ${escapeHtml(ticket.quickTag)}` : ''}</p>
      <div style="margin:0 0 0.75rem;display:flex;flex-wrap:wrap;gap:0.4rem;align-items:center;">
        ${warrantyDaysBadge(ticket)}
        ${statusBadge(ticket)}
        ${warrantyLine ? `<span class="repair-muted">${escapeHtml(warrantyLine)}</span>` : ''}
      </div>
      ${summaryBits ? `<p class="repair-hint">${escapeHtml(summaryBits)}</p>` : ''}
      ${relatedHtml}
      ${emailBanner}
      ${nextBlock}
      <div class="repair-briefing-box">
        <div class="repair-optgroup-label" style="margin-top:0;">Case briefing for AI</div>
        <p class="repair-muted" style="margin:0 0 0.55rem;">
          Your first email to MS is usually not in this thread. Record the issue + SN plan + what you already tested so AI can reply correctly at every stage.
        </p>
        <label class="repair-field">
          <span>What we told MS / first contact</span>
          <textarea id="repairSheetBriefing" rows="3" placeholder="e.g. First email: described black-screen / no power. Second email: sent SN 0F…. Asked for advanced exchange.">${escapeHtml(ticket.msCaseBriefing || '')}</textarea>
        </label>
        <label class="repair-field">
          <span>Troubleshooting already done</span>
          <textarea id="repairSheetTroubleshoot" rows="2" placeholder="e.g. Surface diagnostic, battery disconnect, different charger, OS recovery — all failed. Do not ask MS for basic steps.">${escapeHtml(ticket.msTroubleshootingNote || '')}</textarea>
        </label>
        <div class="repair-actions">
          <button type="button" class="btn btn-secondary" id="repairSheetSaveBriefing">Save briefing</button>
        </div>
      </div>
      <div id="repairMsDrafts" class="repair-ms-drafts"><div class="repair-muted">Loading reply drafts…</div></div>
      <div id="repairMsThread" class="repair-ms-thread"><div class="repair-muted">Loading email thread…</div></div>
      ${labelBlockHtml(ticket)}
      ${stageActionButtons(ticket)}
      ${stageFieldsHtml(ticket)}
      <details class="repair-advanced">
        <summary>Advanced — all statuses / fields</summary>
        <label class="repair-field">
          <span>Status</span>
          <select id="repairSheetStatus">${statusOptions(ticket.status)}</select>
        </label>
        <p class="repair-hint" id="repairSheetMsHint">${ticket.msProgramHint ? escapeHtml(ticket.msProgramHint) : ''}</p>
        <div class="repair-actions" style="margin-top:0.5rem;">
          <button type="button" class="btn btn-secondary" id="repairSheetSave">Save fields only</button>
          ${pipe !== 'checkin' && !ticket.closed ? '<button type="button" class="btn btn-secondary" id="repairSheetResolve">Mark completed</button>' : ''}
          ${pipe !== 'checkin' && !ticket.closed ? '<button type="button" class="btn btn-secondary" id="repairSheetCannot">Cannot resolve</button>' : ''}
        </div>
      </details>
      <p class="repair-hint" id="repairSheetStatusMsg"></p>
      ${emailEventsHtml(ticket)}
      <div>
        <div class="repair-optgroup-label">Status history</div>
        <div class="repair-history">${history}</div>
      </div>
      <div>
        <div class="repair-optgroup-label">Notes</div>
        <div class="repair-history">${notes}</div>
      </div>
    `);
    if (backdrop) backdrop.hidden = false;

    loadMsThreadAndDrafts(ticket);

    const STATUS_PROGRAMS = {
      ms_advanced_exchange: 'advanced_exchange',
      ms_approved_ship_ae: 'advanced_exchange',
      ms_same_unit: 'same_unit_repair',
      ms_approved_ship_same: 'same_unit_repair'
    };
    const syncHint = () => {
      const status = document.getElementById('repairSheetStatus')?.value;
      const hintEl = document.getElementById('repairSheetMsHint');
      const programEl = document.getElementById('repairSheetMsProgram');
      if (programEl && programEl.tagName === 'SELECT' && STATUS_PROGRAMS[status]) {
        programEl.value = STATUS_PROGRAMS[status];
      }
      if (!hintEl) return;
      const found = (meta.msPrograms || []).find((row) => row.key === (programEl?.value || ''));
      hintEl.textContent = found ? found.hint : '';
    };
    document.getElementById('repairSheetStatus')?.addEventListener('change', syncHint);
    document.getElementById('repairSheetMsProgram')?.addEventListener('change', syncHint);
    syncHint();

    document.getElementById('repairSheetBody')?.querySelectorAll('[data-stage-status]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const require = btn.dataset.require;
        if (require === 'msCaseId') {
          const caseVal = (document.getElementById('repairSheetMsCase')?.value || '').trim();
          if (!caseVal) {
            const statusMsg = document.getElementById('repairSheetStatusMsg');
            if (statusMsg) statusMsg.textContent = 'Paste the MS case ID first.';
            document.getElementById('repairSheetMsCase')?.focus();
            return;
          }
        }
        const sel = document.getElementById('repairSheetStatus');
        if (sel) {
          sel.value = btn.dataset.stageStatus;
          sel.dispatchEvent(new Event('change'));
        }
        saveTicketUpdate();
      });
    });
    document.getElementById('repairSheetBody')?.querySelectorAll('[data-stage-resolve]').forEach((btn) => {
      btn.addEventListener('click', () => resolveTicket(ticket, btn.dataset.stageResolve));
    });
    document.getElementById('repairSheetBody')?.querySelectorAll('[data-print-both]').forEach((btn) => {
      btn.addEventListener('click', () => printMsLabelBoth(
        btn.dataset.printBoth,
        btn.dataset.printSerial,
        btn.dataset.printTicket,
        btn.dataset.printMode || 'queue',
        btn
      ));
    });
    document.getElementById('repairSheetBody')?.querySelectorAll('[data-view-specs]').forEach((btn) => {
      btn.addEventListener('click', () => viewMsSpecsSheet(
        btn.dataset.viewSpecs,
        btn.dataset.printSerial,
        btn.dataset.printTicket,
        btn
      ));
    });
    document.getElementById('repairSheetBody')?.querySelectorAll('[data-label-gallery]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const t = items.find((row) => row.id === btn.dataset.labelGallery) || ticket;
        if (t) openLabelGalleryOverlay(t);
      });
    });

    document.getElementById('repairSheetSave')?.addEventListener('click', () => saveTicketUpdate());
    document.getElementById('repairSheetSaveBriefing')?.addEventListener('click', () => saveTicketUpdate({ briefingOnly: true }));
    document.getElementById('repairSheetResolve')?.addEventListener('click', () => resolveTicket(ticket, 'resolved'));
    document.getElementById('repairSheetCannot')?.addEventListener('click', () => resolveTicket(ticket, 'cannot_resolve'));
  }

  async function viewMsSpecsSheet(labelId, serial, ticketId, sourceBtn) {
    const statusMsg = document.getElementById('repairSheetStatusMsg');
    const cardStatus = labelId
      ? document.querySelector(`[data-print-status="${labelId}"]`)
      : null;
    const setStatus = (text, isWarn) => {
      if (statusMsg) statusMsg.textContent = text;
      if (cardStatus) {
        cardStatus.hidden = !text;
        cardStatus.textContent = text || '';
        cardStatus.style.background = isWarn ? '#fff7ed' : '#ecfdf5';
        cardStatus.style.borderColor = isWarn ? '#fed7aa' : '#a7f3d0';
        cardStatus.style.color = isWarn ? '#9a3412' : '#065f46';
      }
    };
    if (!labelId) {
      setStatus('Missing label id for specs sheet', true);
      return;
    }
    setStatus('Preparing specs sheet…');
    if (sourceBtn) sourceBtn.disabled = true;
    try {
      const response = await fetch('/api/repair-needed/print-ms-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          labelId,
          serialNumber: serial || undefined,
          ticketId: ticketId || undefined,
          mode: 'view-sheet'
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `Could not build specs (${response.status})`);
      }
      const sheetUrl = data.sheetPdf;
      if (!sheetUrl) throw new Error('Specs PDF was not returned');
      setStatus('Specs sheet ready.');
      message('Specs sheet opened.');
      const opened = window.open(sheetUrl, '_blank', 'noopener');
      if (!opened) {
        setStatus('Popup blocked — allow popups, or use the specs link in a new tab.', true);
        message('Popup blocked — allow popups to view specs.', 'error');
      }
      // Prefer showing specs in the card iframe when present
      const card = document.querySelector(`[data-label-card="${labelId}"]`);
      const frame = card && card.querySelector('iframe.repair-pdf-frame');
      if (frame) frame.src = sheetUrl;
    } catch (error) {
      setStatus(error.message || 'Could not open specs', true);
      message(error.message || 'Could not open specs sheet.', 'error');
    } finally {
      if (sourceBtn) sourceBtn.disabled = false;
    }
  }

  async function printMsLabelBoth(labelId, serial, ticketId, mode, sourceBtn) {
    const statusMsg = document.getElementById('repairSheetStatusMsg');
    const cardStatus = labelId
      ? document.querySelector(`[data-print-status="${labelId}"]`)
      : null;
    const setStatus = (text, isWarn) => {
      if (statusMsg) statusMsg.textContent = text;
      if (cardStatus) {
        cardStatus.hidden = !text;
        cardStatus.textContent = text || '';
        cardStatus.style.background = isWarn ? '#fff7ed' : '#ecfdf5';
        cardStatus.style.borderColor = isWarn ? '#fed7aa' : '#a7f3d0';
        cardStatus.style.color = isWarn ? '#9a3412' : '#065f46';
      }
    };
    const printMode = mode || 'queue';
    const coolKey = printCooldownKey(labelId, printMode);
    const left = printCooldownLeftSec(coolKey);
    if (left > 0) {
      const msg = `Print already sent — wait ${left}s before printing again.`;
      setStatus(msg, true);
      message(msg, 'error');
      syncPrintCooldownButtons(labelId);
      return;
    }
    if (printBusyKeys[coolKey]) {
      setStatus('Print already in progress…', true);
      return;
    }

    setStatus(printMode === 'sheet'
      ? 'Preparing specs sheet…'
      : printMode === 'label'
        ? 'Preparing shipping label…'
        : 'Preparing label + sheet…');
    printBusyKeys[coolKey] = true;
    if (sourceBtn && !sourceBtn.getAttribute('data-print-label')) {
      sourceBtn.setAttribute('data-print-label', sourceBtn.textContent.trim());
    }
    syncPrintCooldownButtons(labelId);
    try {
      const response = await fetch('/api/repair-needed/print-ms-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          labelId,
          serialNumber: serial || undefined,
          ticketId: ticketId || undefined,
          mode: printMode
        })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 429 || data.cooldown) {
        const retry = Number(data.retryAfterSec) || PRINT_COOLDOWN_SEC;
        printCooldownUntil[coolKey] = Date.now() + (retry * 1000);
        startPrintCooldown(labelId, printMode, sourceBtn);
        throw new Error(data.error || `Print cooldown — wait ${retry}s`);
      }
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `Print failed (${response.status})`);
      }
      const warnParts = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
      const soft = !data.queued;
      const successNote = soft
        ? 'Printer not set up on this PC yet — opened PDF for manual print / download.'
        : `Print queued successfully${data.message ? `: ${data.message}` : ''}.`;
      const warn = warnParts.length ? ` (${warnParts.join('; ')})` : '';
      const finalMsg = `${successNote}${warn}`;
      setStatus(finalMsg, soft);
      message(soft ? finalMsg : `Success — ${finalMsg}`);

      // Lock Print for a cooldown so rapid clicks cannot spam the queue.
      startPrintCooldown(labelId, printMode, sourceBtn);

      const pdfUrl = printMode === 'sheet'
        ? (data.sheetPdf || data.labelPdf)
        : (data.labelPdf || data.sheetPdf);
      if (soft && pdfUrl) {
        window.open(pdfUrl, '_blank', 'noopener');
      }
    } catch (error) {
      setStatus(error.message || 'Print failed', true);
      message(error.message || 'Print failed — use View PDF / Download for now.', 'error');
      syncPrintCooldownButtons(labelId);
    } finally {
      delete printBusyKeys[coolKey];
      syncPrintCooldownButtons(labelId);
    }
  }

  async function saveTicketUpdate(opts) {
    if (!activeTicket || busy) return;
    busy = true;
    const statusMsg = document.getElementById('repairSheetStatusMsg');
    if (statusMsg) statusMsg.textContent = 'Saving…';
    try {
      const payload = {
        id: activeTicket.id,
        serialNumber: activeTicket.serialNumber,
        at: activeTicket.at,
        msCaseBriefing: document.getElementById('repairSheetBriefing')?.value || null,
        msTroubleshootingNote: document.getElementById('repairSheetTroubleshoot')?.value || null,
        note: document.getElementById('repairSheetNote')?.value || null
      };
      if (!(opts && opts.briefingOnly)) {
        Object.assign(payload, {
          status: document.getElementById('repairSheetStatus')?.value,
          msProgram: document.getElementById('repairSheetMsProgram')?.value || null,
          msCaseId: document.getElementById('repairSheetMsCase')?.value || null,
          msOrderNumber: document.getElementById('repairSheetMsOrder')?.value || null,
          msRejectReason: document.getElementById('repairSheetRejectReason')?.value || null,
          outboundTracking: document.getElementById('repairSheetOutTn')?.value || null,
          inboundTracking: document.getElementById('repairSheetInTn')?.value || null,
          msDefectiveSerial: document.getElementById('repairSheetDefectiveSn')?.value || null,
          msReplacementSerial: document.getElementById('repairSheetReplacementSn')?.value || null,
          promoteReplacement: !!(document.getElementById('repairSheetPromoteReplacement')?.checked),
          vendorName: document.getElementById('repairSheetVendor')?.value || 'Microsoft',
          expectedBackAt: document.getElementById('repairSheetExpected')?.value || null
        });
      } else {
        // Keep current status when saving briefing only
        payload.status = activeTicket.status;
      }
      const response = await fetch('/api/repair-needed/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Update failed (${response.status})`);
      }
      if (opts && opts.briefingOnly) {
        activeTicket.msCaseBriefing = payload.msCaseBriefing;
        activeTicket.msTroubleshootingNote = payload.msTroubleshootingNote;
        message('Case briefing saved — AI will use this on Prepare / Improve.');
        if (statusMsg) statusMsg.textContent = 'Briefing saved.';
        busy = false;
        return;
      }
      message(`Updated ${activeTicket.serialNumber}.`);
      closeSheet();
      await loadRepairs({ quiet: true });
    } catch (error) {
      if (statusMsg) statusMsg.textContent = error.message || 'Update failed';
      message(error.message || 'Update failed', 'error');
    } finally {
      busy = false;
    }
  }

  async function resolveTicket(ticketOrSerial, outcome, at) {
    if (busy) return;
    const ticket = typeof ticketOrSerial === 'object'
      ? ticketOrSerial
      : { serialNumber: ticketOrSerial, at: at || '', id: null };
    const label = outcome === 'cannot_resolve' ? 'cannot be resolved' : 'completed';
    if (!window.confirm(`Mark repair ${label} for ${ticket.serialNumber}?`)) return;
    busy = true;
    message(`Marking ${label}…`);
    try {
      const response = await fetch('/api/repair-needed/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          id: ticket.id || null,
          serialNumber: ticket.serialNumber,
          at: ticket.at || '',
          outcome: outcome || 'resolved',
          note: document.getElementById('repairSheetNote')?.value || null
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Resolve failed (${response.status})`);
      }
      message(`${ticket.serialNumber} marked ${label}.`);
      closeSheet();
      await loadRepairs({ quiet: true });
    } catch (error) {
      message(error.message || 'Resolve failed', 'error');
    } finally {
      busy = false;
    }
  }

  async function loadMeta() {
    try {
      const response = await fetch('/api/repair-needed/meta', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.ok) {
        meta = {
          statuses: data.statuses || [],
          msPrograms: data.msPrograms || [],
          quickTags: data.quickTags || [],
          pipelines: data.pipelines || [],
          msRejectReasons: data.msRejectReasons || []
        };
      }
    } catch (e) {
      // Page still works with labels from each ticket.
    }
  }

  async function loadRepairs(options = {}) {
    const loading = document.getElementById('repairLoading');
    const root = document.getElementById('repairRoot');
    if (!options.quiet) {
      if (loading) loading.style.display = 'block';
      if (root) root.style.display = 'none';
      message('');
    }
    try {
      const response = await fetch('/api/repair-needed?include=all', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || `Could not load repairs (${response.status})`);
      }
      items = Array.isArray(data.items) ? data.items : [];
      // Default tab: first non-empty MS stage (Needs → …), then To do / Done
      if (!options.quiet) {
        const order = ['needs', 'talking', 'ship', 'transit', 'checkin', 'todo', 'done'];
        const first = order.find((p) => items.some((r) => pipelineOf(r) === p));
        if (first) mainTab = first;
      }
      syncTabUi();
      renderKpis(items);
      renderList();
      await loadUnmatchedMail();
      const updated = document.getElementById('repairUpdated');
      if (updated) updated.textContent = `Updated ${new Date().toLocaleString()}`;
      if (loading) loading.style.display = 'none';
      if (root) root.style.display = 'block';
      applyRepairFocusFromNav();
    } catch (error) {
      if (loading) loading.style.display = 'none';
      message(error.message || 'Could not load repair queue', 'error');
    }
  }

  function applyRepairFocusFromNav() {
    let focus = null;
    try {
      const raw = sessionStorage.getItem('oa_repair_focus');
      if (raw) focus = JSON.parse(raw);
      sessionStorage.removeItem('oa_repair_focus');
    } catch (_) {
      try { sessionStorage.removeItem('oa_repair_focus'); } catch (__) { /* ignore */ }
    }
    if (!focus) return;
    const openMode = String(focus.open || '').toLowerCase();

    if (openMode === 'unmatched' || (focus.uid && !(focus.ticketId || focus.serialNumber))) {
      const box = document.getElementById('repairUnmatched');
      if (box) {
        box.hidden = false;
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        box.classList.add('is-notif-focus');
        setTimeout(() => box.classList.remove('is-notif-focus'), 8000);
        if (focus.uid) {
          const row = box.querySelector(`[data-uids*="${String(focus.uid).replace(/"/g, '')}"]`)
            || [...box.querySelectorAll('.repair-unmatched-row')].find((el) => {
              try {
                const uids = JSON.parse(el.getAttribute('data-uids') || '[]');
                return uids.map(String).includes(String(focus.uid));
              } catch (_) { return false; }
            });
          if (row) {
            row.classList.add('is-notif-focus');
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }
      message(focus.uid
        ? `Opened from notification · unmatched email uid ${focus.uid}`
        : 'Opened from notification · unmatched MS emails', 'ok');
      return;
    }

    if (openMode === 'list' || (!(focus.ticketId || focus.serialNumber) && !focus.draftId)) {
      message('Opened from notification · Repair Needed', 'ok');
      return;
    }

    const ticket = items.find((t) => (
      (focus.ticketId && String(t.id) === String(focus.ticketId))
      || (focus.serialNumber && String(t.serialNumber || '').toUpperCase() === String(focus.serialNumber).toUpperCase())
    ));
    if (!ticket) {
      if (focus.serialNumber || focus.ticketId) {
        filterText = String(focus.serialNumber || focus.ticketId);
        const input = document.getElementById('repairFilter');
        if (input) input.value = filterText;
        renderList();
        message(`Opened from notification · could not find ticket for ${filterText}`, 'error');
      }
      return;
    }
    mainTab = ticket.pipeline || pipelineOf(ticket) || mainTab;
    syncTabUi();
    filterText = String(ticket.serialNumber || '');
    const input = document.getElementById('repairFilter');
    if (input) input.value = filterText;
    renderList();

    // Highlight list row if present
    document.querySelectorAll('[data-open]').forEach((el) => {
      if (String(el.getAttribute('data-open') || '').toUpperCase() === String(ticket.serialNumber || '').toUpperCase()) {
        const row = el.closest('.repair-card, .repair-row, article, li, div');
        if (row) {
          row.classList.add('is-notif-focus');
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });

    if (openMode === 'email') {
      openEmailHistoryOverlay(ticket);
      message(`Opened email history · ${ticket.serialNumber}`, 'ok');
      return;
    }
    if (openMode === 'labels') {
      openLabelGalleryOverlay(ticket);
      message(`Opened labels · ${ticket.serialNumber}`, 'ok');
      return;
    }

    window.__oaRepairDraftFocus = focus.draftId || null;
    openManageSheet(ticket);
    message(`Opened ticket · ${ticket.serialNumber}${focus.draftId ? ' (draft focus)' : ''}`, 'ok');
  }

  async function loadUnmatchedMail() {
    const box = document.getElementById('repairUnmatched');
    if (!box) return;
    try {
      const response = await fetch('/api/ms-email/unmatched', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        box.hidden = true;
        return;
      }
      const groups = Array.isArray(data.groups) && data.groups.length
        ? data.groups
        : (Array.isArray(data.items) ? data.items.map((row) => ({
          key: `uid:${row.uid}`,
          kind: 'email',
          label: String(row.uid),
          cases: row.cases || [],
          orders: row.orders || [],
          serials: row.serials || [],
          uids: [row.uid],
          emails: [{ uid: row.uid, subject: row.subject, date: row.date }],
          subject: row.subject,
          date: row.date,
          suggestions: row.suggestions || []
        })) : []);
      if (!groups.length) {
        box.hidden = true;
        box.innerHTML = '';
        return;
      }
      const emailCount = Number(data.count) || groups.reduce((n, g) => n + (g.uids || []).length, 0);
      box.hidden = false;
      box.innerHTML = `
        <div class="repair-unmatched-head">
          <strong>${groups.length} unmatched ${groups.length === 1 ? 'thread' : 'threads'}</strong>
          <span class="repair-muted">${emailCount} email${emailCount === 1 ? '' : 's'} · grouped by case / order — attach once to link all.</span>
        </div>
        <div class="repair-unmatched-list">${groups.slice(0, 20).map((g) => {
          const kindLabel = g.kind === 'case' ? 'Case' : (g.kind === 'order' ? 'Order' : 'Email');
          const title = g.kind === 'email'
            ? (g.subject || '').slice(0, 100)
            : `${kindLabel} ${g.label}`;
          const bits = [
            g.uids && g.uids.length > 1 ? `${g.uids.length} emails` : '1 email',
            (g.cases || []).length && g.kind !== 'case' ? `Case ${(g.cases || []).join(', ')}` : null,
            (g.orders || []).length && g.kind !== 'order' ? `Order ${(g.orders || []).join(', ')}` : null,
            (g.serials || []).length ? `SN ${(g.serials || []).join(', ')}` : null
          ].filter(Boolean).join(' · ');
          const sub = g.kind !== 'email' && g.subject
            ? `<div class="meta">${escapeHtml((g.subject || '').slice(0, 90))}</div>`
            : '';
          const suggestions = Array.isArray(g.suggestions) ? g.suggestions.slice(0, 3) : [];
          const primaryUid = (g.uids && g.uids[0]) || '';
          const uidsAttr = escapeHtml(JSON.stringify(g.uids || []));
          const suggestHtml = suggestions.length
            ? `<div class="meta">Suggest: ${suggestions.map((s) =>
              `<button type="button" class="btn" data-attach-case-ticket="${escapeHtml(s.id)}" data-attach-case-uid="${escapeHtml(primaryUid)}" data-attach-uids='${uidsAttr}' title="${escapeHtml(s.reason || '')}">${escapeHtml(s.serialNumber || s.id)}</button>`
            ).join(' ')}</div>`
            : '';
          return `<div class="repair-unmatched-row" data-uids='${uidsAttr}'>
            <div>
              <div><strong>${escapeHtml(title)}</strong></div>
              ${sub}
              <div class="meta">${escapeHtml(bits)} ${g.date ? `· ${escapeHtml(formatWhen(g.date))}` : ''}</div>
              ${suggestHtml}
            </div>
            <div class="repair-unmatched-actions">
              <input type="text" data-attach-sn placeholder="Serial" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${escapeHtml((g.serials && g.serials[0]) || '')}">
              <button type="button" class="btn" data-attach-group="1">Attach SN</button>
            </div>
          </div>`;
        }).join('')}</div>`;
      box.querySelectorAll('[data-attach-group]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const row = btn.closest('.repair-unmatched-row');
          const input = row && row.querySelector('[data-attach-sn]');
          const serial = String((input && input.value) || '').trim().toUpperCase();
          let uids = [];
          try { uids = JSON.parse(row?.dataset?.uids || '[]'); } catch (_) { uids = []; }
          if (!serial) {
            message('Enter a serial to attach.', 'error');
            input?.focus();
            return;
          }
          if (!uids.length) {
            message('No emails in this group.', 'error');
            return;
          }
          btn.disabled = true;
          try {
            const response = await fetch('/api/ms-email/attach-serial', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ uids, serialNumber: serial })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok) throw new Error(data.error || 'Attach failed');
            message(`Attached ${serial} to ${uids.length} email${uids.length === 1 ? '' : 's'} (${data.matched || 0} matched).`);
            await loadRepairs({ quiet: true });
          } catch (error) {
            message(error.message || 'Attach failed', 'error');
            btn.disabled = false;
          }
        });
      });
      box.querySelectorAll('[data-attach-case-ticket]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const uid = btn.dataset.attachCaseUid;
          const ticketId = btn.dataset.attachCaseTicket;
          btn.disabled = true;
          try {
            const response = await fetch('/api/ms-email/attach-case', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ uid: Number(uid), ticketId })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok) throw new Error(data.error || 'Attach case failed');
            message(`Linked thread to ticket (${data.backfilled || 0} related emails backfilled).`);
            await loadRepairs({ quiet: true });
          } catch (error) {
            message(error.message || 'Attach case failed', 'error');
            btn.disabled = false;
          }
        });
      });
    } catch (e) {
      box.hidden = true;
    }
  }

  function setMainTab(tab) {
    mainTab = tab || 'needs';
    syncTabUi();
    renderKpis(items);
    renderList();
  }

  async function importEmlFiles(fileList) {
    const status = document.getElementById('repairEmlStatus');
    const files = [...(fileList || [])].filter((f) => /\.eml$/i.test(f.name) || f.type === 'message/rfc822');
    if (!files.length) {
      message('Choose one or more .eml files.', 'error');
      return;
    }
    if (status) status.textContent = `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`;
    const body = new FormData();
    for (const f of files) body.append('files', f, f.name);
    try {
      const response = await fetch('/api/ms-email/import-eml', {
        method: 'POST',
        credentials: 'same-origin',
        body
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'Import failed');
      const okN = data.imported || 0;
      const failN = data.failed || 0;
      if (status) {
        status.textContent = `Imported ${okN}${failN ? `, ${failN} failed` : ''} · matched ${data.matched || 0}`;
      }
      message(`Imported ${okN} .eml file${okN === 1 ? '' : 's'}${failN ? ` (${failN} failed)` : ''}.`);
      await loadRepairs({ quiet: true });
    } catch (error) {
      if (status) status.textContent = '';
      message(error.message || 'Import failed', 'error');
    }
  }

  function bindOnce() {
    const page = document.querySelector('.repair-page');
    if (!page || page.dataset.bound === '1') return;
    page.dataset.bound = '1';

    document.getElementById('repairRefresh')?.addEventListener('click', () => loadRepairs());
    document.getElementById('repairEmlPick')?.addEventListener('click', () => {
      document.getElementById('repairEmlInput')?.click();
    });
    document.getElementById('repairEmlInput')?.addEventListener('change', (event) => {
      const input = event.target;
      importEmlFiles(input.files);
      input.value = '';
    });
    const drop = document.getElementById('repairImportEml');
    if (drop) {
      drop.addEventListener('dragover', (event) => {
        event.preventDefault();
        drop.classList.add('is-drag');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('is-drag'));
      drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('is-drag');
        importEmlFiles(event.dataTransfer && event.dataTransfer.files);
      });
    }
    document.getElementById('repairFilter')?.addEventListener('input', (event) => {
      filterText = event.target.value || '';
      renderList();
    });
    document.getElementById('repairAddNeedsMs')?.addEventListener('click', () => openAddSheet());
    document.getElementById('repairAddClose')?.addEventListener('click', closeAddSheet);
    document.getElementById('repairAddBackdrop')?.addEventListener('click', (event) => {
      if (event.target.id === 'repairAddBackdrop') closeAddSheet();
    });
    document.getElementById('repairAddLookup')?.addEventListener('click', () => lookupAddSerial({ live: true }));
    document.getElementById('repairAddSubmit')?.addEventListener('click', () => submitAddNeedsMs());
    document.getElementById('repairAddSerial')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        // Scanners usually send Enter after the SN
        submitAddNeedsMs();
      }
    });
    page.querySelectorAll('[data-repair-tab]').forEach((btn) => {
      btn.addEventListener('click', () => setMainTab(btn.dataset.repairTab));
    });
    document.getElementById('repairSheetClose')?.addEventListener('click', closeSheet);
    document.getElementById('repairSheetBackdrop')?.addEventListener('click', (event) => {
      if (event.target.id === 'repairSheetBackdrop') closeSheet();
    });
    document.getElementById('repairOverlayClose')?.addEventListener('click', closeOverlay);
    document.getElementById('repairOverlayBackdrop')?.addEventListener('click', (event) => {
      if (event.target.id === 'repairOverlayBackdrop') closeOverlay();
    });

    page.addEventListener('click', (event) => {
      const emailBtn = event.target.closest('[data-email-history]');
      if (emailBtn) {
        event.preventDefault();
        event.stopPropagation();
        const ticket = items.find((row) => row.id === emailBtn.dataset.emailHistory);
        if (ticket) openEmailHistoryOverlay(ticket);
        return;
      }
      const labelBtn = event.target.closest('[data-label-gallery]');
      if (labelBtn && !labelBtn.closest('#repairSheetBody')) {
        event.preventDefault();
        event.stopPropagation();
        const ticket = items.find((row) => row.id === labelBtn.dataset.labelGallery);
        if (ticket) openLabelGalleryOverlay(ticket);
        return;
      }
      const openBtn = event.target.closest('[data-open], .repair-serial');
      if (openBtn) {
        const serial = openBtn.dataset.open || openBtn.dataset.serial;
        if (serial) openDevice(serial);
        return;
      }
      const manageBtn = event.target.closest('[data-manage-id]');
      if (manageBtn) {
        const ticket = items.find((row) => row.id === manageBtn.dataset.manageId)
          || items.find((row) => row.serialNumber === manageBtn.dataset.manageSerial
            && (!manageBtn.dataset.manageAt || row.at === manageBtn.dataset.manageAt));
        if (ticket) openManageSheet(ticket);
        return;
      }
      const resolveBtn = event.target.closest('[data-resolve-serial]');
      if (resolveBtn) {
        resolveTicket({
          id: resolveBtn.dataset.resolveId || null,
          serialNumber: resolveBtn.dataset.resolveSerial,
          at: resolveBtn.dataset.resolveAt || ''
        }, 'resolved');
      }
    });
  }

  window.renderRepairNeededPage = async function renderRepairNeededPage() {
    bindOnce();
    await loadMeta();
    await loadRepairs();
  };
})();
