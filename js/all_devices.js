// All Devices — redesigned table with warranty-aware device info.
let refreshDeviceListCallback = null;

document.addEventListener('DOMContentLoaded', function () {
  let devices = [];
  let dataTracking = {};

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function showMessage(text, type = 'ok') {
    const el = $('devicesMessage');
    if (!el) return;
    el.textContent = text;
    el.style.display = 'block';
    el.classList.toggle('error', type === 'error');
  }

  function shortWindows(version) {
    const text = String(version || '');
    if (/Windows\s*11\s*Pro/i.test(text)) return '11 Pro';
    if (/Windows\s*11\s*Home/i.test(text)) return '11 Home';
    if (/Windows\s*10\s*Pro/i.test(text)) return '10 Pro';
    if (/Windows\s*10\s*Home/i.test(text)) return '10 Home';
    if (/Windows\s*11/i.test(text)) return '11';
    if (/Windows\s*10/i.test(text)) return '10';
    return text || '—';
  }

  function shortCpu(cpu) {
    let text = String(cpu || '');
    if (text.includes('CPU')) text = text.split('CPU')[0];
    if (text.includes('Microsoft')) text = text.split('Microsoft')[0];
    return text.trim() || '—';
  }

  function formatRam(ram) {
    if (ram == null || ram === '') return '—';
    const text = String(ram).trim();
    if (/gb/i.test(text)) return text;
    return `${text}GB`;
  }

  function formatHd(hd) {
    if (hd == null || hd === '') return '—';
    const text = String(hd).trim();
    if (/gb|tb/i.test(text)) return text;
    const n = Number(text);
    if (Number.isFinite(n) && n >= 1024 && n % 1024 === 0) return `${n / 1024}TB`;
    return `${text}GB`;
  }

  function warrantyMeta(device) {
    const status = device.warrantyStatus
      || (device.msWarranty && device.msWarranty.status)
      || null;
    const deviceName = device.warrantyDeviceName
      || (device.msWarranty && device.msWarranty.deviceName)
      || '';
    const expires = device.warrantyExpiresOn
      || (device.msWarranty && device.msWarranty.expiresOn)
      || '';
    const countdown = (window.OAWarranty && window.OAWarranty.warrantyCountdown)
      ? window.OAWarranty.warrantyCountdown({ status, expiresOn: expires })
      : null;
    return { status, deviceName, expires, countdown };
  }

  /** MS warranty name with cpu/ram/hd/windows stripped, e.g. keep "Surface Laptop 7 - Copilot+ PC - 13 in." */
  function cleanWarrantyName(deviceName) {
    let text = String(deviceName || '').trim();
    if (!text) return '';
    text = text.replace(/\b(?:i\d+|R\d+|SQ\d+|Plus|Core|Ultra\s*\d*)\s*\/\s*\d+\s*\/\s*\d+\s*(?:GB|TB)?/gi, '');
    text = text.replace(/\b\d+\s*\/\s*\d+\s*(?:GB|TB)?\b/gi, '');
    text = text.replace(/\b\d+\s*(?:GB|TB)\b/gi, '');
    text = text.replace(/\b(?:Win(?:dows)?)\s*(?:10|11)?\s*(?:Home|Pro)?\b/gi, '');
    text = text.replace(/\b(?:i[3579]|R[3579]|SQ\d+)\b(?!\s*(?:in|inch))/gi, '');
    text = text.replace(/\s*[-–—|/,]+\s*$/g, '');
    text = text.replace(/^\s*[-–—|/,]+\s*/g, '');
    text = text.replace(/\s*[-–—]\s*[-–—]+/g, ' - ');
    text = text.replace(/\s{2,}/g, ' ').trim();
    return text;
  }

  function chip(label, tone) {
    return `<span class="dv-chip ${tone || ''}">${escapeHtml(label)}</span>`;
  }

  function activationChip(status) {
    const value = String(status || '').trim();
    if (!value) return chip('Activation ?', 'muted');
    if (/^active$/i.test(value)) return chip('Windows Active', 'ok');
    if (/not\s*active/i.test(value)) return chip('Not Active', 'warn');
    return chip(value, 'muted');
  }

  function warrantyChip(warranty) {
    if (warranty && warranty.countdown) {
      return chip(warranty.countdown.chipLabel, warranty.countdown.chipTone);
    }
    const status = warranty && warranty.status;
    if (!status) return chip('Not checked', 'muted');
    if (/IN_WARRANTY/i.test(status)) return chip('In warranty', 'ok');
    if (/EXPIRED/i.test(status)) return chip('Expired', 'danger');
    return chip(status, 'muted');
  }

  function specLine(label, value) {
    return `<div class="dv-spec"><span class="dv-spec-label">${escapeHtml(label)}</span> ${escapeHtml(value)}</div>`;
  }

  function openSerialDetails(serialNumber) {
    if (!serialNumber || typeof window.loadModalData_API_Local !== 'function') return;
    refreshDeviceListCallback = () => {
      fetch('/list-all-devices')
        .then((response) => response.json())
        .then((data) => {
          devices = data;
          filterDevices();
        })
        .catch((error) => console.error('Error:', error));
    };
    window.loadModalData_API_Local(serialNumber);
  }

  function openTrackingDetails(trackingNumber, archived) {
    if (!trackingNumber || typeof window.showDeviceDetails !== 'function') return;
    window.showDeviceDetails(trackingNumber, !!archived);
  }

  // ---------------------------------------------------------------- columns

  const LAYOUT_KEY = 'orderassist.devices.layout.v1';
  const MIN_COL_WIDTH = 90;

  const COLUMN_DEFS = [
    { id: 'device', label: 'Device', width: 280 },
    { id: 'specs', label: 'Specs', width: 200 },
    { id: 'tracking', label: 'Tracking', width: 210 },
    { id: 'shipping', label: 'Shipping', width: 160 },
    { id: 'customer', label: 'Customer', width: 220 },
    { id: 'notes', label: 'Notes', width: 190 },
    { id: 'actions', label: 'Order / Actions', width: 150 }
  ];

  const COLUMN_BY_ID = COLUMN_DEFS.reduce((acc, col) => {
    acc[col.id] = col;
    return acc;
  }, {});

  function defaultLayout() {
    return {
      order: COLUMN_DEFS.map((c) => c.id),
      hidden: [],
      widths: COLUMN_DEFS.reduce((acc, c) => {
        acc[c.id] = c.width;
        return acc;
      }, {}),
      pageSize: 100
    };
  }

  let layout = defaultLayout();

  function loadLayout() {
    layout = defaultLayout();
    let saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || 'null');
    } catch (error) {
      saved = null;
    }
    if (!saved || typeof saved !== 'object') return;

    if (Array.isArray(saved.order)) {
      const known = saved.order.filter((id) => COLUMN_BY_ID[id]);
      const missing = COLUMN_DEFS.map((c) => c.id).filter((id) => !known.includes(id));
      layout.order = known.concat(missing);
    }
    if (Array.isArray(saved.hidden)) {
      layout.hidden = saved.hidden.filter((id) => COLUMN_BY_ID[id]);
    }
    if (saved.widths && typeof saved.widths === 'object') {
      Object.keys(layout.widths).forEach((id) => {
        const value = Number(saved.widths[id]);
        if (Number.isFinite(value) && value >= MIN_COL_WIDTH) layout.widths[id] = Math.round(value);
      });
    }
    if (saved.pageSize === 'all' || Number.isFinite(Number(saved.pageSize))) {
      layout.pageSize = saved.pageSize === 'all' ? 'all' : Number(saved.pageSize);
    }
  }

  function saveLayout() {
    try {
      window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch (error) {
      /* storage unavailable — layout stays session-only */
    }
  }

  function visibleColumns() {
    const cols = layout.order
      .filter((id) => !layout.hidden.includes(id))
      .map((id) => COLUMN_BY_ID[id]);
    return cols.length ? cols : [COLUMN_BY_ID.device];
  }

  // ---------------------------------------------------------------- cells

  function deviceContext(device) {
    const trackingInfo = dataTracking[device.serialNumber] || {};
    const w = warrantyMeta(device);
    const winLabel = shortWindows(device.windowsVersion);
    return {
      device,
      trackingInfo,
      warranty: w,
      warrantyLabel: cleanWarrantyName(w.deviceName),
      winLabel,
      trackingText: device.TrackingNumber || device.InternalTrackingNumber || trackingInfo.trackingNumber || '—',
      trackingArchived: device.TrackingArchived != null
        ? !!device.TrackingArchived
        : !!trackingInfo.archived,
      originalTrackingText: device.OriginalTrackingNumber
        || device.originalTrackingNumber
        || device.TrackingNumber
        || device.InternalTrackingNumber
        || trackingInfo.trackingNumber
        || '',
      originalTrackingArchived: device.OriginalTrackingArchived != null
        ? !!device.OriginalTrackingArchived
        : !!trackingInfo.archived,
      dateText: trackingInfo.date || device.trackingDate || '—',
      quantityText: trackingInfo.quantity != null ? trackingInfo.quantity : '—',
      stageText: device.TrackingStage || trackingInfo.stage || '',
      warehouseInfo: [device.warehouseCompany, device.warehouseName].filter(Boolean).join(' — ') || '—',
      orderStatusText: device.orderstatus || device.orderStatus || '—',
      shipDateText: device.shipDate || '',
      combinedAddress: [
        device.street1, device.street2, device.city, device.state, device.postalCode,
        device.residential === true ? 'Residential' : (device.residential === false ? 'Business' : '')
      ].filter(Boolean).join(', ')
    };
  }

  const CELL_RENDERERS = {
    device(cell, ctx) {
      const { device, warranty, warrantyLabel } = ctx;
      cell.innerHTML = `
        <button type="button" class="dv-sn dv-table-link">${escapeHtml(device.serialNumber || '')}</button>
        <div class="dv-line">${escapeHtml(device.model || 'No model')}</div>
        ${warrantyLabel ? `<div class="dv-warranty-name" title="${escapeHtml(warranty.deviceName)}">${escapeHtml(warrantyLabel)}</div>` : ''}
        <div class="dv-sku">${escapeHtml(device.sku || 'No SKU')}</div>
        <div class="dv-bubbles">
          ${warrantyChip(warranty)}
          ${activationChip(device.activationStatus)}
        </div>
      `;
      cell.querySelector('.dv-sn')?.addEventListener('click', () => {
        openSerialDetails(device.serialNumber);
      });
    },

    specs(cell, ctx) {
      const { device, warranty, winLabel } = ctx;
      const expLine = (warranty.countdown && warranty.countdown.lineLabel)
        || warranty.expires
        || '—';
      cell.innerHTML = `
        ${specLine('CPU', shortCpu(device.cpu))}
        ${specLine('RAM', formatRam(device.ram))}
        ${specLine('HD', formatHd(device.hd))}
        ${specLine('Win', winLabel)}
        ${specLine('Expires', expLine)}
      `;
    },

    tracking(cell, ctx) {
      const {
        device, trackingText, trackingArchived, originalTrackingText,
        originalTrackingArchived, dateText, quantityText, stageText
      } = ctx;
      cell.innerHTML = '';

      const currentLine = document.createElement('div');
      currentLine.className = 'dv-tracking-line';
      const currentLabel = document.createElement('span');
      currentLabel.className = 'dv-spec-label';
      currentLabel.textContent = 'Tracking';
      currentLine.appendChild(currentLabel);
      if (trackingText && trackingText !== '—') {
        const currentButton = document.createElement('button');
        currentButton.type = 'button';
        currentButton.className = 'dv-table-link dv-tracking-link';
        currentButton.textContent = trackingText;
        currentButton.title = `Show all devices in tracking ${trackingText}`;
        currentButton.addEventListener('click', () => openTrackingDetails(trackingText, trackingArchived));
        currentLine.appendChild(currentButton);
      } else {
        currentLine.appendChild(document.createTextNode(' —'));
      }
      cell.appendChild(currentLine);

      const originalLine = document.createElement('div');
      originalLine.className = 'dv-tracking-line dv-muted';
      const originalLabel = document.createElement('span');
      originalLabel.className = 'dv-spec-label';
      originalLabel.textContent = 'Original';
      originalLine.appendChild(originalLabel);
      if (originalTrackingText) {
        const originalButton = document.createElement('button');
        originalButton.type = 'button';
        originalButton.className = 'dv-table-link dv-tracking-link';
        originalButton.textContent = originalTrackingText;
        originalButton.title = `Show all devices in original tracking ${originalTrackingText}`;
        originalButton.addEventListener('click', () => {
          openTrackingDetails(originalTrackingText, originalTrackingArchived);
        });
        originalLine.appendChild(originalButton);
      } else {
        originalLine.appendChild(document.createTextNode(' —'));
      }
      cell.appendChild(originalLine);

      const scanLine = document.createElement('div');
      scanLine.className = 'dv-muted';
      scanLine.textContent = `Scan ${dateText}`;
      cell.appendChild(scanLine);

      const addedLine = document.createElement('div');
      addedLine.className = 'dv-muted';
      addedLine.textContent = `Added ${device.deviceDate || '—'} · Qty ${quantityText}${stageText ? ` · ${stageText}` : ''}`;
      cell.appendChild(addedLine);
    },

    shipping(cell, ctx) {
      cell.innerHTML = `
        <div class="dv-line">${escapeHtml(ctx.warehouseInfo)}</div>
        <div class="dv-muted">${escapeHtml(ctx.orderStatusText)}${ctx.shipDateText ? ` · ${escapeHtml(ctx.shipDateText)}` : ''}</div>
      `;
    },

    customer(cell, ctx) {
      const { device, combinedAddress } = ctx;
      const nameCompany = [
        device.name ? `N: ${device.name}` : '',
        device.company ? `C: ${device.company}` : ''
      ].filter(Boolean).join(' ') || '—';
      cell.innerHTML = `
        <div class="dv-line">${escapeHtml(nameCompany)}</div>
        <div class="dv-muted dv-clamp" title="${escapeHtml(combinedAddress || '')}">${escapeHtml(combinedAddress || '—')}</div>
        <div class="dv-muted">${device.phone ? `Phone ${escapeHtml(device.phone)}` : ''}${device.orderTotal != null ? ` · Paid $${escapeHtml(device.orderTotal)}` : ''}</div>
      `;
    },

    notes(cell, ctx) {
      cell.appendChild(ctx.notesInput);
    },

    actions(cell, ctx) {
      cell.appendChild(ctx.orderNumberInput);
      cell.appendChild(ctx.actions);
    }
  };

  function fetchAndProcessArchiveData() {
    Promise.all([
      fetch('/archived-tracking-data').then((r) => r.json()),
      fetch('/get-tracking-data').then((r) => r.json())
    ])
      .then(([archivedData, trackingData]) => {
        dataTracking = {};
        const ingest = (list, archived) => {
          (list || []).forEach((item) => {
            (item.devices || []).forEach((device) => {
              if (!device || !device.serialNumber) return;
              dataTracking[device.serialNumber] = {
                date: item.date,
                trackingNumber: item.trackingNumber,
                quantity: item.quantity,
                remaining: item.remaining,
                status: item.status,
                stage: item.stage || null,
                archived: !!archived
              };
            });
          });
        };
        ingest(archivedData, true);
        ingest(trackingData, false);
        fetchAndDisplayDevices();
      })
      .catch((error) => console.error('Failed to fetch tracking data:', error));
  }

  function fetchAndDisplayDevices() {
    fetch('/list-all-devices')
      .then((response) => response.json())
      .then((data) => {
        devices = data;
        // Render through the filters: browsers restore filter values on reload,
        // so rendering the raw list here would disagree with the visible inputs.
        filterDevices();
      })
      .catch((error) => console.error('Error fetching devices:', error));
  }

  // Every filter, so the UI can report which ones are hiding rows. Browsers
  // restore form state on reload, so a forgotten filter is easy to miss.
  const FILTER_FIELDS = [
    ['filterSerialNumber', 'Serial'],
    ['filterModel', 'Model'],
    ['filterSku', 'SKU'],
    ['filterWindowsVersion', 'Windows'],
    ['filterCpu', 'CPU'],
    ['filterRam', 'RAM'],
    ['filterHd', 'HD'],
    ['filterTracking', 'Tracking #'],
    ['filterOrderstatus', 'Shipping status'],
    ['filterActivationStatus', 'Activation'],
    ['filterWarranty', 'Warranty'],
    ['filterWarrantyDays', 'Warranty days'],
    ['filterNameCompany', 'Name | Company'],
    ['filterPhone', 'Phone'],
    ['filterAddress', 'Address'],
    ['filterNotes', 'Notes'],
    ['filterOrderNumber', 'Order #']
  ];

  function activeFilters() {
    return FILTER_FIELDS
      .map(([id, label]) => ({ id, label, value: (($(id) && $(id).value) || '').trim() }))
      .filter((f) => f.value !== '');
  }

  function activeFilterSummary() {
    return activeFilters().map((f) => `${f.label} = "${f.value}"`).join(', ');
  }

  function syncClearFiltersButton() {
    const button = $('clearFiltersButton');
    if (!button) return;
    const count = activeFilters().length;
    button.disabled = count === 0;
    button.textContent = count ? `Clear filters (${count})` : 'Clear filters';
  }

  function clearFilters() {
    FILTER_FIELDS.forEach(([id]) => {
      const el = $(id);
      if (el) el.value = '';
    });
    document.querySelectorAll('#shipStatusChips .ship-chip').forEach((chip) => {
      chip.classList.toggle('is-active', (chip.getAttribute('data-ship') || '') === '');
    });
    filterDevices();
  }

  function filterDevices() {
    const val = (id) => (($(id) && $(id).value) || '').toLowerCase();

    const filterSerialNumber = val('filterSerialNumber');
    const filterModel = val('filterModel');
    const filterSku = val('filterSku');
    const filterWindowsVersion = val('filterWindowsVersion');
    const filterCpu = val('filterCpu');
    const filterRam = val('filterRam');
    const filterHd = val('filterHd');
    const filterTracking = val('filterTracking');
    const filterNameCompany = val('filterNameCompany');
    const filterAddress = val('filterAddress');
    const filterPhone = val('filterPhone');
    const filterNotes = val('filterNotes');
    const filterActivationStatus = val('filterActivationStatus');
    const filterOrderstatus = val('filterOrderstatus');
    const filterOrderNumber = val('filterOrderNumber');
    const filterWarranty = val('filterWarranty');
    const filterWarrantyDays = val('filterWarrantyDays');

    const filteredDevices = devices.filter((device) => {
      const trackingInfo = dataTracking[device.serialNumber] || {};
      const trackingText = [
        device.TrackingNumber,
        device.InternalTrackingNumber,
        device.OriginalTrackingNumber,
        device.originalTrackingNumber,
        trackingInfo.trackingNumber,
        trackingInfo.date,
        device.TrackingStage,
        trackingInfo.stage
      ].filter(Boolean).join(' ').toLowerCase();

      const combinedNameCompany = [device.name, device.company].filter(Boolean).join(' ').toLowerCase();
      const combinedAddress = [
        device.street1, device.street2, device.city, device.state, device.postalCode
      ].filter(Boolean).join(', ').toLowerCase();

      const orderStatus = (device.orderstatus || device.orderStatus || '').toLowerCase();
      const w = warrantyMeta(device);
      const warrantyKey = (w.status || 'not_checked').toLowerCase();

      const warrantyOk = !filterWarranty
        || (filterWarranty === 'not_checked' && !w.status)
        || (filterWarranty === 'expired' && ((w.countdown && w.countdown.expired) || warrantyKey.includes('expired')))
        || (filterWarranty === 'in_warranty' && !(w.countdown && w.countdown.expired) && warrantyKey.includes('in_warranty'))
        || (!['not_checked', 'expired', 'in_warranty'].includes(filterWarranty) && warrantyKey.includes(filterWarranty));

      const daysOk = !filterWarrantyDays
        || !(window.OAWarranty && window.OAWarranty.matchesDaysFilter)
        || window.OAWarranty.matchesDaysFilter(w.expires, w.status, filterWarrantyDays);

      return String(device.serialNumber || '').toLowerCase().includes(filterSerialNumber)
        && String(device.model || '').toLowerCase().includes(filterModel)
        && String(device.sku || '').toLowerCase().includes(filterSku)
        && String(device.windowsVersion || '').toLowerCase().includes(filterWindowsVersion)
        && String(device.cpu || '').toLowerCase().includes(filterCpu)
        && String(device.ram ?? '').toLowerCase().includes(filterRam)
        && String(device.hd ?? '').toLowerCase().includes(filterHd)
        && trackingText.includes(filterTracking)
        && combinedNameCompany.includes(filterNameCompany)
        && combinedAddress.includes(filterAddress)
        && (String(device.phone || '').toLowerCase().includes(filterPhone) || filterPhone === '')
        && String(device.notes || '').toLowerCase().includes(filterNotes)
        && String(device.activationStatus || '').toLowerCase().includes(filterActivationStatus)
        && (orderStatus.includes(filterOrderstatus) || filterOrderstatus === '')
        && (String(device.OrderNumber || '').toLowerCase().includes(filterOrderNumber) || filterOrderNumber === '')
        && warrantyOk
        && daysOk;
    });

    syncClearFiltersButton();
    populateTable(filteredDevices);
  }

  // ---------------------------------------------------------------- header

  function renderHeader() {
    const table = $('DevicesTable');
    if (!table) return;
    const colgroup = table.querySelector('colgroup');
    const headRow = table.tHead && table.tHead.rows[0];
    if (!colgroup || !headRow) return;

    const cols = visibleColumns();
    const total = cols.reduce((sum, col) => sum + (layout.widths[col.id] || col.width), 0);
    table.style.width = `${total}px`;

    colgroup.innerHTML = '';
    headRow.innerHTML = '';

    cols.forEach((col) => {
      const width = layout.widths[col.id] || col.width;

      const colEl = document.createElement('col');
      colEl.style.width = `${width}px`;
      colgroup.appendChild(colEl);

      const th = document.createElement('th');
      th.dataset.columnId = col.id;
      th.draggable = true;

      const label = document.createElement('span');
      label.className = 'dv-th-label';
      label.textContent = col.label;
      th.appendChild(label);

      const resizer = document.createElement('span');
      resizer.className = 'dv-resizer';
      resizer.title = 'Drag to resize';
      resizer.addEventListener('mousedown', (event) => startResize(event, col.id));
      resizer.addEventListener('dblclick', () => {
        layout.widths[col.id] = COLUMN_BY_ID[col.id].width;
        saveLayout();
        renderHeader();
      });
      th.appendChild(resizer);

      th.addEventListener('dragstart', (event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', col.id);
        th.classList.add('dv-dragging');
      });
      th.addEventListener('dragend', () => th.classList.remove('dv-dragging'));
      th.addEventListener('dragover', (event) => {
        event.preventDefault();
        th.classList.add('dv-drop-target');
      });
      th.addEventListener('dragleave', () => th.classList.remove('dv-drop-target'));
      th.addEventListener('drop', (event) => {
        event.preventDefault();
        th.classList.remove('dv-drop-target');
        const dragged = event.dataTransfer.getData('text/plain');
        moveColumn(dragged, col.id);
      });

      headRow.appendChild(th);
    });
  }

  function moveColumn(draggedId, targetId) {
    if (!draggedId || !targetId || draggedId === targetId) return;
    if (!COLUMN_BY_ID[draggedId] || !COLUMN_BY_ID[targetId]) return;
    const order = layout.order.filter((id) => id !== draggedId);
    const at = order.indexOf(targetId);
    order.splice(at < 0 ? order.length : at, 0, draggedId);
    layout.order = order;
    saveLayout();
    renderHeader();
    renderPage();
    renderColumnsPanel();
  }

  let resizeState = null;

  function startResize(event, columnId) {
    event.preventDefault();
    event.stopPropagation();
    const startWidth = layout.widths[columnId] || COLUMN_BY_ID[columnId].width;
    resizeState = { columnId, startX: event.clientX, startWidth };
    document.body.classList.add('dv-resizing');
    window.addEventListener('mousemove', onResizeMove);
    window.addEventListener('mouseup', endResize);
  }

  function onResizeMove(event) {
    if (!resizeState) return;
    const delta = event.clientX - resizeState.startX;
    const width = Math.max(MIN_COL_WIDTH, Math.round(resizeState.startWidth + delta));
    layout.widths[resizeState.columnId] = width;
    renderHeader();
  }

  function endResize() {
    if (resizeState) saveLayout();
    resizeState = null;
    document.body.classList.remove('dv-resizing');
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup', endResize);
  }

  // ------------------------------------------------------- columns settings

  function renderColumnsPanel() {
    const list = $('columnsSettingsList');
    if (!list) return;
    list.innerHTML = '';

    layout.order.forEach((id, index) => {
      const col = COLUMN_BY_ID[id];
      if (!col) return;
      const row = document.createElement('div');
      row.className = 'devices-columns-row';

      const label = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !layout.hidden.includes(id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) layout.hidden = layout.hidden.filter((h) => h !== id);
        else if (visibleColumns().length > 1) layout.hidden = layout.hidden.concat(id);
        else checkbox.checked = true;
        saveLayout();
        renderHeader();
        renderPage();
      });
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(` ${col.label}`));
      row.appendChild(label);

      const controls = document.createElement('div');
      controls.className = 'devices-columns-controls';

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'dv-icon-btn';
      up.textContent = '↑';
      up.title = 'Move left';
      up.disabled = index === 0;
      up.addEventListener('click', () => moveColumn(id, layout.order[index - 1]));
      controls.appendChild(up);

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'dv-icon-btn';
      down.textContent = '↓';
      down.title = 'Move right';
      down.disabled = index === layout.order.length - 1;
      down.addEventListener('click', () => {
        const target = layout.order[index + 1];
        const order = layout.order.filter((x) => x !== id);
        order.splice(order.indexOf(target) + 1, 0, id);
        layout.order = order;
        saveLayout();
        renderHeader();
        renderPage();
        renderColumnsPanel();
      });
      controls.appendChild(down);

      row.appendChild(controls);
      list.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- paging

  let currentList = [];
  let currentPage = 1;

  function pageSizeValue() {
    return layout.pageSize === 'all' ? currentList.length || 1 : Number(layout.pageSize) || 100;
  }

  function totalPages() {
    if (layout.pageSize === 'all') return 1;
    return Math.max(1, Math.ceil(currentList.length / pageSizeValue()));
  }

  function populateTable(deviceList) {
    currentList = Array.isArray(deviceList) ? deviceList.slice() : [];
    currentPage = 1;
    const heading = $('allDevicesHeading');
    if (heading) {
      const total = devices.length;
      heading.textContent = currentList.length === total
        ? `All Devices (${total})`
        : `All Devices (${currentList.length} of ${total} — filtered)`;
    }
    renderHeader();
    renderPage();
  }

  function renderPage() {
    const table = $('DevicesTable');
    const tableBody = table && table.tBodies[0];
    if (!tableBody) return;

    const pages = totalPages();
    if (currentPage > pages) currentPage = pages;
    const size = pageSizeValue();
    const start = layout.pageSize === 'all' ? 0 : (currentPage - 1) * size;
    const end = layout.pageSize === 'all' ? currentList.length : Math.min(currentList.length, start + size);
    const slice = currentList.slice(start, end);
    const cols = visibleColumns();

    tableBody.innerHTML = '';

    if (!slice.length) {
      const row = tableBody.insertRow();
      const cell = row.insertCell();
      cell.colSpan = cols.length;
      cell.className = 'dv-empty';
      const summary = activeFilterSummary();
      if (summary) {
        cell.textContent = `No devices match: ${summary}. `;
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'btn btn-secondary';
        reset.textContent = 'Clear filters';
        reset.addEventListener('click', clearFilters);
        cell.appendChild(reset);
      } else {
        cell.textContent = 'No devices to show.';
      }
    }

    slice.forEach((device) => {
      const row = tableBody.insertRow();
      const ctx = deviceContext(device);
      buildRowControls(ctx, row);
      cols.forEach((col) => {
        const cell = row.insertCell();
        const render = CELL_RENDERERS[col.id];
        if (render) render(cell, ctx);
      });
    });

    renderPager(start, end);
    const wrap = document.querySelector('.devices-table-wrap');
    if (wrap) wrap.scrollTop = 0;
    fitShellHeight();
  }

  /** Size the table area to the viewport so the pager sits flush at the bottom. */
  function fitShellHeight() {
    const shell = document.querySelector('.devices-shell');
    if (!shell || !shell.offsetParent) return;
    const top = shell.getBoundingClientRect().top;
    let height = Math.max(420, Math.round(window.innerHeight - top - 12));
    shell.style.height = `${height}px`;

    // Absorb padding of the surrounding card/main so the page itself never scrolls.
    const overflow = document.documentElement.scrollHeight - window.innerHeight;
    if (overflow > 0 && overflow < 200) {
      height = Math.max(420, height - overflow);
      shell.style.height = `${height}px`;
    }
  }

  function renderPager(start, end) {
    const info = $('devicesPagerInfo');
    const pagesEl = $('devicesPagerPages');
    const sizeEl = $('devicesPageSize');
    if (sizeEl) sizeEl.value = String(layout.pageSize);
    if (info) {
      info.textContent = currentList.length
        ? `Showing ${start + 1}–${end} of ${currentList.length}`
        : 'No devices';
    }
    if (!pagesEl) return;
    pagesEl.innerHTML = '';

    const pages = totalPages();
    if (pages <= 1) return;

    const addButton = (label, page, opts = {}) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dv-page-btn';
      button.textContent = label;
      if (opts.active) button.classList.add('active');
      if (opts.disabled) button.disabled = true;
      button.addEventListener('click', () => {
        currentPage = page;
        renderPage();
      });
      pagesEl.appendChild(button);
    };

    addButton('‹', Math.max(1, currentPage - 1), { disabled: currentPage === 1 });

    const window_ = 2;
    const shown = new Set([1, pages]);
    for (let p = currentPage - window_; p <= currentPage + window_; p += 1) {
      if (p >= 1 && p <= pages) shown.add(p);
    }
    const sorted = Array.from(shown).sort((a, b) => a - b);
    let previous = 0;
    sorted.forEach((p) => {
      if (previous && p - previous > 1) {
        const gap = document.createElement('span');
        gap.className = 'dv-page-gap';
        gap.textContent = '…';
        pagesEl.appendChild(gap);
      }
      addButton(String(p), p, { active: p === currentPage });
      previous = p;
    });

    addButton('›', Math.min(pages, currentPage + 1), { disabled: currentPage === pages });
  }

  function buildRowControls(ctx, row) {
    const device = ctx.device;

    const notesInput = document.createElement('textarea');
    notesInput.className = 'dv-notes';
    notesInput.value = device.notes || '';
    notesInput.disabled = true;
    ctx.notesInput = notesInput;

    const orderNumberInput = document.createElement('input');
    orderNumberInput.type = 'text';
    orderNumberInput.className = 'dv-order';
    orderNumberInput.value = device.OrderNumber || '';
    orderNumberInput.disabled = true;
    ctx.orderNumberInput = orderNumberInput;

    const actions = document.createElement('div');
    actions.className = 'dv-actions';
    ctx.actions = actions;

    const makeIconButton = (src, title, onClick) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dv-icon-btn';
      button.title = title;
      const icon = document.createElement('img');
      icon.src = src;
      icon.alt = title;
      button.appendChild(icon);
      button.onclick = onClick;
      return button;
    };

    const actionButton = makeIconButton(
      device.OrderNumber ? 'media/edit.png' : 'media/save.png',
      'Edit / save',
      function () {
        if (orderNumberInput.disabled) {
          orderNumberInput.disabled = false;
          notesInput.disabled = false;
          actionButton.querySelector('img').src = 'media/save.png';
        } else {
          updateDeviceDetails(device.serialNumber, orderNumberInput.value, notesInput.value);
          orderNumberInput.disabled = true;
          notesInput.disabled = true;
          actionButton.querySelector('img').src = 'media/edit.png';
        }
      }
    );

    const trashButton = makeIconButton('media/trash.png', 'Delete', function () {
      if (!window.confirm(`Delete device ${device.serialNumber}?`)) return;
      fetch(`/delete_single_device/${encodeURIComponent(device.serialNumber)}`, { method: 'DELETE' })
        .then((response) => {
          if (response.ok) row.remove();
          else console.error('Failed to delete the device');
        })
        .catch((error) => console.error('Error:', error));
    });

    const detailButton = makeIconButton('media/details_icon.png', 'Device details', function () {
      openSerialDetails(device.serialNumber);
    });

    const printButton = makeIconButton('media/print_icon.png', 'Print / save', function () {
      if (!orderNumberInput.disabled) {
        updateDeviceDetails(device.serialNumber, orderNumberInput.value, notesInput.value);
      }
      if (device.serialNumber) {
        window.open(`/print-label/${encodeURIComponent(device.serialNumber)}`, '_blank');
      }
    });

    actions.appendChild(actionButton);
    actions.appendChild(trashButton);
    actions.appendChild(detailButton);
    actions.appendChild(printButton);
  }

  function updateDeviceDetails(serialNumber, orderNumber, notes) {
    fetch(`/update-device-details/${encodeURIComponent(serialNumber)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ OrderNumber: orderNumber, notes })
    })
      .then((response) => {
        if (!response.ok) throw new Error('Network response was not ok');
        return response.json();
      })
      .then(() => filterDevices())
      .catch((error) => console.error('Error updating device:', error));
  }

  // Both bulk jobs read ShipStation V1, capped at 40 requests/minute per API
  // key. We pace at 36/minute so the server-side limiter never has to queue,
  // which would otherwise stall requests behind the proxy timeout.
  const BULK_REQUESTS_PER_MIN = 36;
  const BULK_MIN_GAP_MS = Math.ceil(60000 / BULK_REQUESTS_PER_MIN);
  const BULK_RETRY_STATUSES = [429, 502, 503, 504];

  function etaText(remaining, avgMs) {
    const seconds = Math.ceil((remaining * Math.max(avgMs || 0, BULK_MIN_GAP_MS)) / 1000);
    if (seconds <= 60) return `~${seconds}s left`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `~${minutes}m left`;
    const hours = Math.floor(minutes / 60);
    return `~${hours}h ${minutes % 60}m left`;
  }

  function bulkEtaElement(loadingProgress) {
    if (!loadingProgress) return null;
    let el = $('bulkEta');
    if (!el) {
      el = document.createElement('span');
      el.id = 'bulkEta';
      el.className = 'dv-muted';
      loadingProgress.appendChild(el);
    }
    return el;
  }

  async function runBulkByOrder(endpoint, button) {
    const loadingProgress = $('loadingProgress');
    const currentProgress = $('currentProgress');
    const totalDevicesEl = $('totalDevices');
    const etaEl = bulkEtaElement(loadingProgress);
    button.classList.add('loadingButton');
    button.disabled = true;
    if (loadingProgress) loadingProgress.style.display = 'flex';

    // One request per order covers every device sharing that order number.
    const orderNumbers = Array.from(
      new Set(devices.map((d) => String(d.OrderNumber || '').trim()).filter(Boolean))
    );
    if (totalDevicesEl) totalDevicesEl.textContent = String(orderNumbers.length);
    if (currentProgress) currentProgress.textContent = '0';

    let failed = 0;
    let avgMs = 0;
    for (let i = 0; i < orderNumbers.length; i += 1) {
      if (etaEl) etaEl.textContent = etaText(orderNumbers.length - i, avgMs);
      const startedAt = Date.now();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderNumbers: [orderNumbers[i]] })
          });
          if (response.ok) break;
          if (!BULK_RETRY_STATUSES.includes(response.status) || attempt === 2) {
            failed += 1;
            console.error(`Failed for order ${orderNumbers[i]} (HTTP ${response.status})`);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
        } catch (error) {
          if (attempt === 2) {
            failed += 1;
            console.error(`Failed for order ${orderNumbers[i]}`, error);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
        }
      }

      if (currentProgress) currentProgress.textContent = String(i + 1);
      const elapsed = Date.now() - startedAt;
      avgMs = avgMs ? avgMs * 0.7 + elapsed * 0.3 : elapsed;
      const gap = BULK_MIN_GAP_MS - elapsed;
      if (gap > 0 && i < orderNumbers.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, gap));
      }
    }

    if (failed) console.warn(`Bulk job finished with ${failed} failed order(s).`);
    button.classList.remove('loadingButton');
    button.disabled = false;
    if (etaEl) etaEl.textContent = '';
    if (loadingProgress) loadingProgress.style.display = 'none';
    fetchAndDisplayDevices();
  }

  refreshDeviceListCallback = function () {
    fetch('/list-all-devices')
      .then((response) => response.json())
      .then((data) => {
        devices = data;
        filterDevices();
      })
      .catch((error) => console.error('Error fetching updated devices:', error));
  };

  loadLayout();
  renderHeader();
  renderColumnsPanel();
  syncClearFiltersButton();
  fetchAndProcessArchiveData();

  window.addEventListener('resize', fitShellHeight);
  const devicesSection = $('devicesTable');
  if (devicesSection) {
    new MutationObserver(() => fitShellHeight())
      .observe(devicesSection, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  $('devicesPageSize')?.addEventListener('change', function () {
    layout.pageSize = this.value === 'all' ? 'all' : Number(this.value);
    currentPage = 1;
    saveLayout();
    renderPage();
  });

  const columnsButton = $('columnsSettingsButton');
  const columnsPanel = $('columnsSettingsPanel');

  function closeColumnsPanel() {
    if (!columnsPanel) return;
    columnsPanel.hidden = true;
    columnsButton?.setAttribute('aria-expanded', 'false');
  }

  columnsButton?.addEventListener('click', function (event) {
    event.stopPropagation();
    if (!columnsPanel) return;
    const open = columnsPanel.hidden;
    columnsPanel.hidden = !open;
    columnsButton.setAttribute('aria-expanded', String(open));
    if (open) renderColumnsPanel();
  });

  columnsPanel?.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', closeColumnsPanel);
  $('columnsCloseButton')?.addEventListener('click', closeColumnsPanel);

  $('columnsResetButton')?.addEventListener('click', function () {
    const pageSize = layout.pageSize;
    layout = defaultLayout();
    layout.pageSize = pageSize;
    saveLayout();
    renderHeader();
    renderColumnsPanel();
    renderPage();
  });

  [
    'filterSerialNumber', 'filterSku', 'filterModel', 'filterWindowsVersion',
    'filterCpu', 'filterRam', 'filterHd', 'filterTracking',
    'filterNameCompany', 'filterAddress', 'filterPhone', 'filterNotes',
    'filterActivationStatus', 'filterOrderstatus', 'filterOrderNumber', 'filterWarranty', 'filterWarrantyDays'
  ].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', filterDevices);
    el.addEventListener('change', filterDevices);
  });

  $('clearFiltersButton')?.addEventListener('click', clearFilters);

  document.querySelectorAll('#shipStatusChips .ship-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const status = btn.getAttribute('data-ship') || '';
      const select = $('filterOrderstatus');
      if (select) select.value = status;
      document.querySelectorAll('#shipStatusChips .ship-chip').forEach((chip) => {
        chip.classList.toggle('is-active', chip === btn);
      });
      filterDevices();
    });
  });

  $('filterOrderstatus')?.addEventListener('change', () => {
    const select = $('filterOrderstatus');
    const value = select ? select.value : '';
    document.querySelectorAll('#shipStatusChips .ship-chip').forEach((chip) => {
      chip.classList.toggle('is-active', (chip.getAttribute('data-ship') || '') === value);
    });
  });

  $('updateShippingStatusButton')?.addEventListener('click', function () {
    runBulkByOrder('/bulk-update-local-shipping-status', this);
  });

  $('updateDeviceInfoButton')?.addEventListener('click', function () {
    runBulkByOrder('/bulk-update-device-info', this);
  });

  $('fillWarrantyGapsButton')?.addEventListener('click', async function () {
    const button = this;
    button.classList.add('loadingButton');
    button.disabled = true;
    try {
      const response = await fetch('/api/warranty/fill-gaps', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'OrderAssistWarranty'
        },
        body: '{}'
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      showMessage(
        `Warranty fill: ${body.updatedDevices || 0} devices updated`
        + (body.fieldCounts ? ` (${Object.entries(body.fieldCounts).map(([k, v]) => `${k}:${v}`).join(', ')})` : '')
        + `. Still missing model: ${body.stillBlankModel ?? '—'}.`,
        'ok'
      );
      fetchAndDisplayDevices();
    } catch (error) {
      showMessage(`Warranty fill failed: ${error.message}`, 'error');
    } finally {
      button.classList.remove('loadingButton');
      button.disabled = false;
    }
  });
});
