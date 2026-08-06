/* model_ShowAPILocalDetails.js */
document.addEventListener("DOMContentLoaded", function() {
    console.log("addEventListener loded");
    modal_API_Local = document.getElementById("infoModal_API_Local");

    var span = document.getElementsByClassName("close_API_Local")[0];
    span.onclick = function() {
        modal_API_Local.style.display = "none";
    }
    span.onclick = closeModal_API_Local;

    // Ensure buttons exist in the DOM
    var editButton = document.getElementById('editButton');
    var saveButtonShowAPILocalDetails = document.getElementById('saveButtonShowAPILocalDetails');
	if (saveButtonShowAPILocalDetails) {
        // Attach the click event listener to the save button
        saveButtonShowAPILocalDetails.addEventListener('click', saveLocalData);
    }
    if (editButton && saveButtonShowAPILocalDetails) {
        editButton.addEventListener('click', () => toggleEditMode_API_Local(true));
        saveButtonShowAPILocalDetails.addEventListener('click', () => toggleEditMode_API_Local(false));
    }

    var editApiButton = document.getElementById('editApiButton');
    var saveApiButton = document.getElementById('saveApiButton');
    if (editApiButton && saveApiButton) {
        editApiButton.addEventListener('click', () => toggleApiEditMode_API_Local(true));
        saveApiButton.addEventListener('click', () => toggleApiEditMode_API_Local(false));
    }

});

// ------------------------------------------------------ single-device refresh

function modalActionStatus_API_Local(text, isError) {
    const el = document.getElementById('modalActionStatus');
    if (!el) return;
    el.textContent = text || '';
    if (!text) {
        el.style.color = '';
        el.style.fontWeight = '';
        return;
    }
    el.style.fontWeight = '600';
    el.style.color = isError ? '#b42318' : '#166534';
}

async function runModalAction_API_Local(button, endpoint, payload, pendingText, describe) {
    if (!currentDeviceData || !currentDeviceData.serialNumber) {
        modalActionStatus_API_Local('No device loaded.', true);
        return;
    }
    const buttons = [
        'refreshWarrantyButton', 'refreshFromOrderButton',
        'refreshWarrantyButtonOv', 'refreshFromOrderButtonOv',
        'shipStationOrderLookupButton'
    ]
        .map((id) => document.getElementById(id))
        .filter(Boolean);
    buttons.forEach((b) => { b.disabled = true; });
    modalActionStatus_API_Local(pendingText);

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.error) {
            throw new Error(data.error || `Request failed (${response.status})`);
        }
        if (endpoint.includes('refresh-from-order')) {
            shipStationDataCache_API_Local = null;
            shippingLabelCache_API_Local = null;
        }
        modalActionStatus_API_Local(describe(data));
        refreshModalData(currentDeviceData.serialNumber);
        if (typeof refreshDeviceListCallback === 'function') refreshDeviceListCallback();
    } catch (error) {
        modalActionStatus_API_Local(error.message, true);
    } finally {
        buttons.forEach((b) => { b.disabled = false; });
    }
}

function refreshFromWarranty_API_Local() {
    runModalAction_API_Local(
        this,
        '/api/device/refresh-warranty',
        { serialNumber: currentDeviceData && currentDeviceData.serialNumber },
        'Checking Microsoft warranty… (this can take up to a minute)',
        (data) => {
            const w = data.warranty || {};
            const parts = [w.status || 'checked'];
            if (w.expiresOn) parts.push(`expires ${w.expiresOn}`);
            if (w.deviceName) parts.push(w.deviceName);
            return `Warranty updated: ${parts.join(' · ')}`;
        }
    );
}

function refreshFromOrder_API_Local(orderNumberOverride) {
    const fromInput = document.getElementById('shipStationOrderInput');
    const orderNumber = String(
        orderNumberOverride
        || (fromInput && fromInput.value)
        || (currentDeviceData && currentDeviceData.OrderNumber)
        || ''
    ).trim();
    const payload = { serialNumber: currentDeviceData && currentDeviceData.serialNumber };
    if (orderNumber) payload.orderNumber = orderNumber;

    runModalAction_API_Local(
        this,
        '/api/device/refresh-from-order',
        payload,
        'Fetching order from ShipStation…',
        (data) => {
            if (data.orderNumber && currentDeviceData) {
                currentDeviceData.OrderNumber = data.orderNumber;
            }
            shipStationDataCache_API_Local = null;
            shippingLabelCache_API_Local = null;
            apiSourceCatalog_API_Local = null;
            apiSourceCache_API_Local = {};
            const fields = data.updatedFields || [];
            const snPush = data.shipStationSerial || {};
            let snMsg = '';
            if (snPush.uploaded) snMsg = ` SN uploaded to Custom field 3.`;
            else if (snPush.unchanged) snMsg = ` SN already in Custom field 3.`;
            else if (snPush.skipped) snMsg = ` SN not uploaded (${snPush.reason || 'order locked'}).`;
            else if (snPush.error) snMsg = ` SN upload failed: ${snPush.error}.`;
            const fromTracking = data.convertedFromTracking
                ? ` (from tracking ${data.convertedFromTracking})`
                : '';
            if (!fields.length) return `Order ${data.orderNumber}${fromTracking}: already up to date.${snMsg}`;
            return `Order ${data.orderNumber}${fromTracking} (${data.apiVersion}): updated ${fields.join(', ')}.${snMsg}`;
        }
    );
}

// Placeholder for getLocalDataForSerialNumber_API_Local function
function getLocalDataForSerialNumber_API_Local(serialNumber) {
    console.log("getLocalDataForSerialNumber_API_Local Function loded");
    // Placeholder implementation
    return null; // Replace with actual data retrieval logic
}

// Global modal variable
var modal_API_Local;
let currentDeviceData = null; // Global variable to store device data
let shipStationDataCache_API_Local = null;
let activeModalTab_API_Local = 'Overview_API_Local';
let apiSourceCatalog_API_Local = null;
let apiSourceCache_API_Local = {};
let activeApiSource_API_Local = null;

// Open the specific tab
function openTab(evt, tabName_API_Local) {
    var i, tabcontent, tablinks;
    tabcontent = document.getElementsByClassName("tabcontent_API_Local");
    for (i = 0; i < tabcontent.length; i++) {
        tabcontent[i].style.display = "none";
    }
    tablinks = document.getElementsByClassName("tablinks_API_Local");
    for (i = 0; i < tablinks.length; i++) {
        tablinks[i].className = tablinks[i].className.replace(" active", "");
    }
    const panel = document.getElementById(tabName_API_Local);
    if (!panel) {
        console.warn('openTab: missing panel', tabName_API_Local);
        return;
    }
    panel.style.display = "block";
    if (evt && evt.currentTarget) {
        evt.currentTarget.className += " active";
    } else {
        // Programmatic switch: highlight the button that opens this tab.
        for (i = 0; i < tablinks.length; i++) {
            const handler = tablinks[i].getAttribute('onclick') || '';
            if (handler.indexOf(`'${tabName_API_Local}'`) !== -1) {
                tablinks[i].className += " active";
            }
        }
    }
    
    activeModalTab_API_Local = tabName_API_Local;

    renderActiveModalTab_API_Local();
	
    const isLocalTab = tabName_API_Local === 'LocalData_API_Local';
    const editButton = document.getElementById('editButton');
    const saveButton = document.getElementById('saveButtonShowAPILocalDetails');
    if (editButton) editButton.style.display = isLocalTab ? 'block' : 'none';
    if (saveButton) saveButton.style.display = 'none';
}



function clearTabContents_API_Local() {
    [
        "Overview_API_Local",
        "History_API_Local",
        "LocalData_API_Local",
        "WarrantyData_API_Local",
        "ShipStationData_API_Local",
        "PrintData_API_Local",
        "apiSubTabs",
        "apiSubTabBody"
    ].forEach((id) => {
        const element = document.getElementById(id);
        if (element) element.innerHTML = '';
    });
}

/** Collect the note history from the device and every tracking cycle, oldest first. */
function collectNoteHistory_API_Local(localData) {
    const entries = [];
    const push = (list) => {
        (Array.isArray(list) ? list : []).forEach((entry) => {
            if (!entry) return;
            const text = String(entry.text ?? entry.note ?? '').trim();
            if (!text) return;
            entries.push({ at: entry.at || null, text, trackingNumber: entry.trackingNumber || null });
        });
    };

    push(localData.noteLog);
    (localData.trackingHistory || []).forEach((cycle) => push(cycle && cycle.noteLog));

    const seen = new Set();
    return entries
        .filter((entry) => {
            const key = `${entry.at || ''}|${entry.text}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => {
            const ta = a.at ? Date.parse(a.at) : 0;
            const tb = b.at ? Date.parse(b.at) : 0;
            return ta - tb;
        });
}

function formatNoteDate_API_Local(at) {
    if (!at) return null;
    const time = Date.parse(at);
    if (Number.isNaN(time)) return null;
    const d = new Date(time);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function notesHistoryHtml_API_Local(localData, escapeHtml) {
    const history = collectNoteHistory_API_Local(localData);
    if (!history.length) {
        const current = String(localData.notes || '').trim();
        if (!current) return '<p class="dv-muted" style="margin:0;">No notes yet.</p>';
        // Legacy record: a note exists but was saved before note logging began.
        return `<ul class="dv-note-log"><li><span class="dv-note-date">Undated</span> ${escapeHtml(current)}</li></ul>`;
    }
    const rows = history.map((entry) => {
        const date = formatNoteDate_API_Local(entry.at);
        const label = date ? `${date}:` : 'Undated:';
        const where = entry.trackingNumber ? ` <span class="dv-muted">(${escapeHtml(entry.trackingNumber)})</span>` : '';
        return `<li><span class="dv-note-date">${escapeHtml(label)}</span> ${escapeHtml(entry.text)}${where}</li>`;
    }).join('');
    return `<ul class="dv-note-log">${rows}</ul>`;
}

function escapeHtml_API_Local(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
}

function displayValue_API_Local(value) {
    return value == null || String(value).trim() === '' ? '—' : String(value);
}

function readOnlyField_API_Local(label, value, tag) {
    const escapeHtml = escapeHtml_API_Local;
    return `<div class="dv-modal-field">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(displayValue_API_Local(value))}${tag ? ` <em class="dv-fallback-tag">${escapeHtml(tag)}</em>` : ''}</span>
    </div>`;
}

// ------------------------------------------------------------------ overview

function ramLabel_API_Local(value) {
    if (value == null || String(value).trim() === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? `${num} GB` : String(value);
}

function hdLabel_API_Local(value) {
    if (value == null || String(value).trim() === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    return num >= 1000 ? `${Math.round(num / 1024 * 10) / 10 || num / 1000} TB`.replace('.0 TB', ' TB') : `${num} GB`;
}

/** Microsoft CDN links rot; swap a dead image for the placeholder box. */
function msImageFailed_API_Local(img) {
    const placeholder = document.createElement('div');
    placeholder.className = `${img.className} dv-ov-image-empty`;
    placeholder.textContent = 'No image';
    img.replaceWith(placeholder);
}

function chip_API_Local(text, tone) {
    if (!text) return '';
    return `<span class="dv-chip ${tone || 'muted'}">${escapeHtml_API_Local(text)}</span>`;
}

function warrantyChip_API_Local(status, expiresOn) {
    if (window.OAWarranty && window.OAWarranty.warrantyCountdown) {
      const info = window.OAWarranty.warrantyCountdown({ status, expiresOn });
      return chip_API_Local(info.chipLabel, info.chipTone);
    }
    if (/IN_WARRANTY/i.test(status || '')) return chip_API_Local('In warranty', 'ok');
    if (/EXPIRED/i.test(status || '')) return chip_API_Local('Expired', 'danger');
    return chip_API_Local(status || 'Warranty not checked', 'muted');
}

/** Compact card: label/value rows, blanks rendered as em dashes. */
function overviewCard_API_Local(title, rows, footer) {
    const body = rows
        .filter((row) => row)
        .map(([label, value, tag]) => `<div class="dv-ov-row">
            <span class="dv-ov-label">${escapeHtml_API_Local(label)}</span>
            <span class="dv-ov-value">${escapeHtml_API_Local(displayValue_API_Local(value))}${tag ? ` <em class="dv-fallback-tag">${escapeHtml_API_Local(tag)}</em>` : ''}</span>
        </div>`).join('');
    return `<section class="dv-ov-card">
        <h4>${escapeHtml_API_Local(title)}</h4>
        ${body}
        ${footer || ''}
    </section>`;
}

const NO_TRACKING_SOURCE_LABELS_API_Local = {
    warranty_only: 'a Microsoft warranty lookup',
    repair_needed: 'the repair queue',
    repair_status: 'repair status update',
    repair_resolved: 'repair resolved',
    return_action: 'a return action'
};

/** Explain rows that exist in a supporting DB but were never added to a tracking batch. */
function noTrackingNotice_API_Local(localData) {
    if (!localData || localData.hasTrackingHistory !== false) return '';
    const origin = NO_TRACKING_SOURCE_LABELS_API_Local[localData.dataSource] || 'a supporting device record';
    return `<div class="dv-tab-note">
        <strong>Not linked to a tracking batch</strong>
        <p>This serial is only known from ${escapeHtml_API_Local(origin)}, so order, shipping, and tracking history are empty until it is added under a tracking number.</p>
    </div>`;
}

function populateOverview_API_Local(localData) {
    const target = document.getElementById('Overview_API_Local');
    if (!target || !localData) return;
    const escapeHtml = escapeHtml_API_Local;
    const warranty = localData._warrantyMerged || localData.msWarranty || {};
    const status = localData.warrantyStatus || warranty.status || '';
    const msModel = localData.warrantyDeviceName || warranty.deviceName || '';
    const model = msModel || localData.model || '';
    const expires = localData.warrantyExpiresOn || warranty.expiresOn || '';
    const warrantyInfo = (window.OAWarranty && window.OAWarranty.warrantyCountdown)
      ? window.OAWarranty.warrantyCountdown({ status, expiresOn: expires })
      : null;
    const expiresLabel = (warrantyInfo && warrantyInfo.lineLabel) || expires || '';
    const orderStatus = localData.orderStatus || localData.orderstatus || '';
    const destination = [localData.city, localData.state].filter(Boolean).join(', ');
    const notes = collectNoteHistory_API_Local(localData);
    const latestNote = notes.length ? notes[notes.length - 1] : null;
    const currentNote = String(localData.notes || '').trim();

    target.innerHTML = `
      ${noTrackingNotice_API_Local(localData)}
      <div class="dv-ov-hero">
        ${warranty.imageUrl
            ? `<img class="dv-ov-image" src="${escapeHtml(warranty.imageUrl)}" alt="${escapeHtml(model || 'Device')}"
                    loading="lazy" onerror="msImageFailed_API_Local(this)">`
            : '<div class="dv-ov-image dv-ov-image-empty">No image</div>'}
        <div class="dv-ov-identity">
          <div class="dv-ov-serial">${escapeHtml(localData.serialNumber || '—')}</div>
          <div class="dv-ov-model">
            ${escapeHtml(model || 'Unknown model')}
            ${msModel ? '' : '<em class="dv-fallback-tag">local model</em>'}
          </div>
          <div class="dv-ov-chips">
            ${warrantyChip_API_Local(status, expires)}
            ${chip_API_Local(localData.activationStatus, /not/i.test(localData.activationStatus || '') ? 'danger' : 'ok')}
            ${chip_API_Local(orderStatus)}
            ${chip_API_Local(localData.TrackingStage)}
            ${Number(localData.returnVisitCount) > 0 ? chip_API_Local(`Returned ${localData.returnVisitCount}x`, 'danger') : ''}
          </div>
        </div>
        <div class="dv-ov-actions">
          <button type="button" class="dv-icon-btn" id="refreshWarrantyButtonOv">&#8635; Microsoft warranty</button>
          <button type="button" class="dv-icon-btn" id="refreshFromOrderButtonOv">&#8635; Order data</button>
          <button type="button" class="dv-icon-btn" id="overviewPrintButton">&#128438; Print</button>
        </div>
      </div>
      <div class="dv-ov-cards">
        ${(() => {
            const specs = (window.OAWarranty && window.OAWarranty.resolveDisplaySpecs)
              ? window.OAWarranty.resolveDisplaySpecs(localData, warranty)
              : { cpu: localData.cpu, ram: localData.ram, hd: localData.hd };
            return overviewCard_API_Local('Specs', [
            ['CPU', specs.cpu],
            ['RAM', ramLabel_API_Local(specs.ram)],
            ['Storage', hdLabel_API_Local(specs.hd)],
            ['Windows', localData.windowsVersion],
            ['SKU', localData.sku]
        ]);
        })()}
        ${overviewCard_API_Local('Warranty', [
            ['Status', status],
            ['Expires', expiresLabel || expires],
            ['Standard', warranty.standardWarrantyText || localData.warrantyText],
            ['Checked', formatNoteDate_API_Local(warranty.checkedAt) || warranty.checkedAt],
            ['Microsoft model', msModel]
        ])}
        ${overviewCard_API_Local('Order', [
            ['Order number', localData.OrderNumber],
            ['Order status', orderStatus],
            ['Ship date', localData.shipDate],
            ['Customer', localData.name || localData.company],
            ['Destination', destination],
            ['Order total', localData.orderTotal]
        ])}
        ${overviewCard_API_Local('Tracking', [
            ['Tracking number', localData.InternalTrackingNumber],
            ['Tracking date', localData.InternalTrackingDate],
            ['Stage', localData.TrackingStage],
            ['Cycles', localData.trackingHistoryCount],
            ['Times returned', localData.returnVisitCount],
            ['Device date', localData.deviceDate]
        ])}
        ${overviewCard_API_Local('Notes', [
            ['Entries', notes.length || (currentNote ? 1 : 0)],
            ['Latest', latestNote
                ? (formatNoteDate_API_Local(latestNote.at) || 'Undated')
                : (currentNote ? 'Undated' : null)]
        ], `<p class="dv-ov-note">${escapeHtml(latestNote ? latestNote.text : (currentNote || 'No notes yet.'))}</p>`)}
        ${(() => {
            const events = Array.isArray(localData.lifecycleEvents) ? localData.lifecycleEvents : [];
            const first = events.length ? events[0] : null;
            const last = events.length ? events[events.length - 1] : null;
            const metaFor = (ev) => (ev && (HISTORY_EVENT_META_API_Local[ev.type] || { label: ev.type })) || null;
            return overviewCard_API_Local('Journey', [
                ['Events', events.length],
                ['First', first ? `${historyWhen_API_Local(first.at)} — ${metaFor(first).label}` : null],
                ['Latest', last ? `${historyWhen_API_Local(last.at)} — ${metaFor(last).label}` : null]
            ], '<p class="dv-ov-note"><a href="#" id="overviewOpenHistory">Open full history timeline &rarr;</a></p>');
        })()}
      </div>
    `;

    const warrantyButton = document.getElementById('refreshWarrantyButtonOv');
    if (warrantyButton) warrantyButton.addEventListener('click', refreshFromWarranty_API_Local);
    const orderButton = document.getElementById('refreshFromOrderButtonOv');
    if (orderButton) orderButton.addEventListener('click', refreshFromOrder_API_Local);
    const printButton = document.getElementById('overviewPrintButton');
    if (printButton) printButton.addEventListener('click', () => openTab(null, 'PrintData_API_Local'));
    const historyLink = document.getElementById('overviewOpenHistory');
    if (historyLink) {
        historyLink.addEventListener('click', (ev) => {
            ev.preventDefault();
            openTab(null, 'History_API_Local');
        });
    }
}

// ------------------------------------------------------------------ history

const HISTORY_EVENT_META_API_Local = {
    inbound_received: { label: 'Package received (inbound)', tone: 'info' },
    return_received: { label: 'Return package received', tone: 'warn' },
    device_scanned: { label: 'Scanned into system', tone: 'ok' },
    warehouse_processed: { label: 'Processed in warehouse', tone: 'info' },
    shipped: { label: 'Shipped to customer', tone: 'ok' },
    return_visit: { label: 'Came back from customer', tone: 'warn' },
    return_reason: { label: 'Return Note', tone: 'warn' },
    return_action: { label: 'Return processed (disposition)', tone: 'warn' },
    note_logged: { label: 'Note added', tone: 'muted' },
    ss_note_from_buyer: { label: 'Note From Buyer', tone: 'warn' },
    ss_note_to_buyer: { label: 'Note To Buyer', tone: 'info' },
    ss_gift_note: { label: 'Gift Note', tone: 'info' },
    ss_internal_note: { label: 'Internal Note', tone: 'muted' },
    ss_custom_field_1: { label: 'Custom Field 1', tone: 'muted' },
    ss_custom_field_2: { label: 'Custom Field 2', tone: 'muted' },
    ss_custom_field_3: { label: 'Custom Field 3', tone: 'muted' },
    ss_return_note: { label: 'Return Note', tone: 'warn' },
    // Legacy aliases
    ss_customer_note: { label: 'Note From Buyer', tone: 'warn' },
    repair_needed: { label: 'Marked repair needed', tone: 'danger' },
    repair_status: { label: 'Repair status updated', tone: 'info' },
    repair_resolved: { label: 'Repair resolved', tone: 'ok' },
    warranty_backfill: { label: 'Specs filled from Microsoft warranty', tone: 'info' },
    order_refresh: { label: 'Order data refreshed from ShipStation', tone: 'info' }
};

function historyWhen_API_Local(at) {
    if (!at) return 'Undated';
    const raw = String(at);
    // Synthetic date-only events are stored as midnight UTC. Formatting those
    // in local time shifts them to the previous evening, so read the calendar
    // date straight from the string instead.
    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})T00:00:00(\.000)?Z$/);
    if (dateOnly) {
        return `${Number(dateOnly[2])}/${Number(dateOnly[3])}/${dateOnly[1]}`;
    }
    const time = Date.parse(raw);
    if (Number.isNaN(time)) return 'Undated';
    const d = new Date(time);
    const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${date} ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

function populateHistory_API_Local(localData) {
    const target = document.getElementById('History_API_Local');
    if (!target || !localData) return;
    const escapeHtml = escapeHtml_API_Local;

    const cycles = Array.isArray(localData.trackingHistory) ? localData.trackingHistory : [];
    const events = Array.isArray(localData.lifecycleEvents) ? localData.lifecycleEvents : [];

    const styles = `<style>
      .dv-hist-cycles{display:flex;flex-wrap:wrap;gap:0.6rem;margin-bottom:1rem;}
      .dv-hist-cycle{flex:1 1 260px;border:1px solid #e2e8f0;border-radius:10px;padding:0.7rem 0.9rem;background:#f8fafc;}
      .dv-hist-cycle h5{margin:0 0 0.4rem;font-size:0.85rem;color:#334155;}
      .dv-hist-cycle .dv-hist-line{font-size:0.8rem;color:#475569;margin:0.15rem 0;}
      .dv-hist-tl{list-style:none;margin:0;padding:0;position:relative;}
      .dv-hist-tl::before{content:'';position:absolute;left:9px;top:6px;bottom:6px;width:2px;background:#e2e8f0;}
      .dv-hist-item{position:relative;padding:0 0 1rem 2rem;}
      .dv-hist-dot{position:absolute;left:2px;top:0.2rem;width:16px;height:16px;border-radius:50%;border:3px solid #94a3b8;background:#fff;}
      .dv-hist-item.ok .dv-hist-dot{border-color:#16a34a;}
      .dv-hist-item.warn .dv-hist-dot{border-color:#d97706;}
      .dv-hist-item.danger .dv-hist-dot{border-color:#dc2626;}
      .dv-hist-item.info .dv-hist-dot{border-color:#2563eb;}
      .dv-hist-title{font-weight:600;color:#0f172a;font-size:0.9rem;}
      .dv-hist-when{color:#64748b;font-size:0.78rem;margin-left:0.4rem;}
      .dv-hist-meta{color:#475569;font-size:0.8rem;margin-top:0.15rem;}
      .dv-hist-note{color:#334155;font-size:0.82rem;margin-top:0.2rem;background:#f1f5f9;border-radius:6px;padding:0.3rem 0.5rem;display:inline-block;}
      .dv-hist-cyclechip{display:inline-block;font-size:0.7rem;color:#64748b;border:1px solid #cbd5e1;border-radius:999px;padding:0 0.4rem;margin-left:0.4rem;vertical-align:middle;}
    </style>`;

    const cycleCards = cycles.map((cycle) => {
        const who = [cycle.shipToName || cycle.shipToCompany, [cycle.shipToCity, cycle.shipToState].filter(Boolean).join(', ')]
            .filter(Boolean).join(' — ');
        return `<div class="dv-hist-cycle">
          <h5>Cycle ${cycle.cycle} · ${escapeHtml(cycle.stage || '—')} ${cycle.source === 'archived' ? '· archived' : ''}</h5>
          <div class="dv-hist-line">TN ${escapeHtml(cycle.trackingNumber || '—')}${cycle.trackingDate ? ` · ${escapeHtml(cycle.trackingDate)}` : ''}</div>
          ${cycle.inboundSource || cycle.vendor ? `<div class="dv-hist-line">From ${escapeHtml([cycle.inboundSource, cycle.vendor].filter(Boolean).join(' / '))}</div>` : ''}
          ${cycle.orderNumber ? `<div class="dv-hist-line">Order ${escapeHtml(cycle.orderNumber)}${cycle.orderStatus ? ` (${escapeHtml(cycle.orderStatus)})` : ''}</div>` : ''}
          ${cycle.shipDate ? `<div class="dv-hist-line">Shipped ${escapeHtml(cycle.shipDate)}${who ? ` to ${escapeHtml(who)}` : ''}</div>` : ''}
          ${cycle.returnReason ? `<div class="dv-hist-line">Return reason: ${escapeHtml(cycle.returnReason)}</div>` : ''}
        </div>`;
    }).join('');

    const items = events.slice().reverse().map((event) => {
        const meta = HISTORY_EVENT_META_API_Local[event.type] || { label: event.type, tone: 'muted' };
        const bits = [
            event.trackingNumber ? `TN ${event.trackingNumber}` : null,
            event.orderNumber ? `Order ${event.orderNumber}` : null,
            event.source || event.inboundSource ? `From ${event.source || event.inboundSource}` : null,
            event.vendor ? event.vendor : null,
            event.reason ? `Reason: ${event.reason}` : null,
            event.stage ? `Stage: ${event.stage}` : null
        ].filter(Boolean).join(' · ');
        return `<li class="dv-hist-item ${meta.tone}">
          <span class="dv-hist-dot"></span>
          <span class="dv-hist-title">${escapeHtml(meta.label)}</span>
          <span class="dv-hist-when">${escapeHtml(historyWhen_API_Local(event.at))}</span>
          ${Number(event.cycle) > 0 && cycles.length > 1 ? `<span class="dv-hist-cyclechip">cycle ${event.cycle}</span>` : ''}
          ${bits ? `<div class="dv-hist-meta">${escapeHtml(bits)}</div>` : ''}
          ${event.note ? `<div class="dv-hist-note">${escapeHtml(event.note)}</div>` : ''}
        </li>`;
    }).join('');

    target.innerHTML = `
      ${styles}
      ${noTrackingNotice_API_Local(localData)}
      <p class="dv-muted" style="margin:0 0 0.8rem;">
        Full chain of events for ${escapeHtml(localData.serialNumber || 'this device')} —
        ${events.length} event${events.length === 1 ? '' : 's'} across ${cycles.length || 1} tracking cycle${cycles.length === 1 ? '' : 's'}, newest first.
        Notes stay unchanged in their own card; this is the read-only journey view.
      </p>
      ${cycleCards ? `<div class="dv-hist-cycles">${cycleCards}</div>` : ''}
      ${items
        ? `<ul class="dv-hist-tl">${items}</ul>`
        : '<p class="dv-muted">No recorded events yet. History builds up as the device is scanned, shipped, returned, and repaired.</p>'}
    `;
}

// Local tab intentionally contains only what is stored in OrderAssist.
function populateLocalData_API_Local(localData, isEditMode = false) {
    const target = document.getElementById("LocalData_API_Local");
    if (!target || !localData) return;
    const escapeHtml = escapeHtml_API_Local;
    const field = (key, label) => {
        const value = localData[key] ?? '';
        const control = isEditMode
            ? `<input type="text" id="${key}InputField" value="${escapeHtml(value)}">`
            : `<span class="editable">${escapeHtml(displayValue_API_Local(value))}</span>`;
        return `<div class="dv-modal-field"><strong>${escapeHtml(label || key)}</strong>${control}</div>`;
    };
    const read = readOnlyField_API_Local;
    const address = [
        localData.street1, localData.street2, localData.city,
        localData.state, localData.postalCode
    ].filter(Boolean).join(', ');

    target.innerHTML = `
      <div class="dv-modal-section">
        <h3>Device information</h3>
        <div class="dv-modal-grid">
          ${field('serialNumber', 'Serial Number')}
          ${field('model', 'Local model')}
          ${field('sku', 'SKU')}
          ${field('activationStatus', 'Activation')}
          ${field('deviceDate', 'Device date')}
        </div>
      </div>
      <div class="dv-modal-section">
        <h3>Local specs</h3>
        <div class="dv-modal-grid dv-specs-grid">
          ${field('cpu', 'CPU')}
          ${field('ram', 'RAM')}
          ${field('hd', 'HD')}
          ${field('windowsVersion', 'Windows')}
        </div>
      </div>
      <div class="dv-modal-section">
        <h3>Tracking history</h3>
        <div class="dv-modal-grid">
          ${read('Tracking number', localData.InternalTrackingNumber)}
          ${read('Tracking date', localData.InternalTrackingDate)}
          ${read('Tracking status', localData.InternalTrackingStatus)}
          ${read('Stage', localData.TrackingStage)}
          ${read('Inbound source', localData.InboundSource)}
          ${read('Vendor', localData.Vendor)}
          ${read('Times returned', localData.returnVisitCount)}
          ${read('Tracking cycles', localData.trackingHistoryCount)}
        </div>
      </div>
      <div class="dv-modal-section">
        <h3>Local shipping snapshot</h3>
        <div class="dv-modal-grid">
          ${field('OrderNumber', 'Order number')}
          ${read('Order status', localData.orderStatus || localData.orderstatus)}
          ${read('Ship date', localData.shipDate)}
          ${read('Customer', localData.name)}
          ${read('Company', localData.company)}
          ${read('Address', address)}
          ${read('Phone', localData.phone)}
          ${read('Order total', localData.orderTotal)}
          ${read('Quantity', localData.orderQuantity)}
          ${read('Unit price', localData.unitPrice)}
          ${read('Note From Buyer', localData.customerNotes)}
          ${read('Note To Buyer', localData.notesToBuyer)}
          ${read('Gift Note', localData.giftMessage)}
          ${read('Internal Note', localData.internalNotes)}
          ${read('Return Note', localData.returnNote || localData.Return_Reason)}
          ${read('Custom Field 1', localData.customField1)}
          ${read('Custom Field 2', localData.customField2)}
          ${read('Custom Field 3', localData.customField3)}
        </div>
      </div>
      <div class="dv-modal-section">
        <h3>OrderAssist notes</h3>
        <div class="dv-modal-grid">${field('notes', 'Current note')}</div>
        <h4 class="dv-note-log-title">History</h4>
        ${notesHistoryHtml_API_Local(localData, escapeHtml)}
      </div>
    `;
}

function populateWarrantyData_API_Local(localData) {
    const target = document.getElementById("WarrantyData_API_Local");
    if (!target || !localData) return;
    const escapeHtml = escapeHtml_API_Local;
    const warranty = localData._warrantyMerged || localData.msWarranty || {};
    const status = localData.warrantyStatus || warranty.status || '';
    const microsoftModel = localData.warrantyDeviceName || warranty.deviceName || '';
    const expires = localData.warrantyExpiresOn || warranty.expiresOn || '';
    const summary = warranty.summary || localData.warrantyText || warranty.standardWarrantyText || '';
    const standardText = warranty.standardWarrantyText || localData.warrantyText || '';
    const checkedAt = warranty.checkedAt || '';
    const imageUrl = warranty.imageUrl || '';
    const statusChip = /IN_WARRANTY/i.test(status)
        ? '<span class="dv-chip ok">In warranty</span>'
        : (/EXPIRED/i.test(status)
            ? '<span class="dv-chip danger">Expired</span>'
            : `<span class="dv-chip muted">${escapeHtml(status || 'Not checked')}</span>`);
    const fallbackTag = (value) => value ? null : 'local fallback';

    target.innerHTML = `
      <div class="dv-modal-section">
        <div class="dv-section-head">
          <h3>Microsoft warranty</h3>
          <button type="button" class="dv-icon-btn" id="refreshWarrantyButton"
                  title="Refresh directly from Microsoft">&#8635; Refresh Microsoft</button>
        </div>
        <div class="dv-ms-status">
          ${statusChip}
          ${expires ? `<span class="dv-muted">Expires ${escapeHtml(expires)}</span>` : ''}
          ${!status ? '<span class="dv-muted">No Microsoft result saved yet. Local values are shown as fallbacks.</span>' : ''}
        </div>
        <div class="dv-ms-body">
          ${imageUrl ? `<img class="dv-ms-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(microsoftModel || localData.model || 'Device')}" loading="lazy" onerror="msImageFailed_API_Local(this)">` : ''}
          <div class="dv-ms-details">
            <div class="dv-modal-grid">
              ${readOnlyField_API_Local('Microsoft model', microsoftModel || localData.model, fallbackTag(microsoftModel))}
              ${readOnlyField_API_Local('Serial number', warranty.serialNumber || localData.serialNumber, warranty.serialNumber ? null : 'local fallback')}
              ${readOnlyField_API_Local('SKU', localData.sku, 'local')}
              ${readOnlyField_API_Local('Status', status)}
              ${readOnlyField_API_Local('Expires', expires)}
              ${readOnlyField_API_Local('Checked', formatNoteDate_API_Local(checkedAt) || checkedAt)}
            </div>
            <h4 class="dv-note-log-title">Specs</h4>
            <div class="dv-modal-grid dv-specs-grid">
              ${(() => {
                const specs = (window.OAWarranty && window.OAWarranty.resolveDisplaySpecs)
                  ? window.OAWarranty.resolveDisplaySpecs(localData, warranty)
                  : { cpu: localData.cpu, ram: localData.ram, hd: localData.hd, fromMicrosoft: {} };
                const msTag = (used) => (used ? 'from MS model' : 'local');
                return `
              ${readOnlyField_API_Local('CPU', specs.cpu, msTag(specs.fromMicrosoft && specs.fromMicrosoft.cpu))}
              ${readOnlyField_API_Local('RAM', specs.ram, specs.fromMicrosoft && specs.fromMicrosoft.ram ? 'from MS model' : null)}
              ${readOnlyField_API_Local('HD', specs.hd, specs.fromMicrosoft && specs.fromMicrosoft.hd ? 'from MS model' : null)}
              ${readOnlyField_API_Local('Windows', localData.windowsVersion, 'local only')}`;
              })()}
            </div>
          </div>
        </div>
      </div>
      <div class="dv-modal-section">
        <h3>Warranty information</h3>
        <div class="dv-modal-grid">
          ${readOnlyField_API_Local('Standard warranty', standardText)}
          ${readOnlyField_API_Local('Message', warranty.message)}
        </div>
        ${summary ? `<p class="dv-ms-summary">${escapeHtml(summary)}</p>` : '<p class="dv-muted">No warranty summary saved.</p>'}
      </div>
    `;
    const button = document.getElementById('refreshWarrantyButton');
    if (button) button.addEventListener('click', refreshFromWarranty_API_Local);
}

async function fetchShipStationData_API_Local(force = false) {
    if (!currentDeviceData || !currentDeviceData.serialNumber) {
        throw new Error('No device loaded.');
    }
    if (!force && shipStationDataCache_API_Local) return shipStationDataCache_API_Local;
    const response = await fetch(
        `/api/device/order-data/${encodeURIComponent(currentDeviceData.serialNumber)}`,
        { cache: 'no-store' }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || `Order lookup failed (${response.status})`);
    shipStationDataCache_API_Local = data;
    return data;
}

function shipStationItemsHtml_API_Local(items) {
    const escapeHtml = escapeHtml_API_Local;
    if (!Array.isArray(items) || !items.length) return '<p class="dv-muted">No line items returned.</p>';
    const rows = items.map((item) => `<tr>
      <td>${escapeHtml(displayValue_API_Local(item.sku))}</td>
      <td>${escapeHtml(displayValue_API_Local(item.name))}</td>
      <td>${escapeHtml(displayValue_API_Local(item.quantity))}</td>
      <td>${escapeHtml(displayValue_API_Local(item.unitPrice))}</td>
    </tr>`).join('');
    return `<div class="dv-order-items-wrap"><table class="dv-order-items">
      <thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Price</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function trackingUrl_API_Local(trackingNumber, carrierCode) {
    const number = encodeURIComponent(String(trackingNumber || '').trim());
    const carrier = String(carrierCode || '').toLowerCase();
    if (!number) return null;
    if (carrier.includes('ups')) return `https://www.ups.com/track?tracknum=${number}`;
    if (carrier.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${number}`;
    if (carrier.includes('usps') || carrier.includes('stamps')) {
        return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`;
    }
    if (carrier.includes('dhl')) return `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${number}`;
    return null;
}

function shipStationTrackingHtml_API_Local(details) {
    const rows = Array.isArray(details) ? details.filter((row) => row && row.trackingNumber) : [];
    if (!rows.length) {
        return '<p class="dv-muted">No tracking number has been created for this order.</p>';
    }
    return rows.map((row, index) => {
        const url = trackingUrl_API_Local(row.trackingNumber, row.carrierCode);
        const tracking = url
            ? `<a href="${escapeHtml_API_Local(url)}" target="_blank" rel="noopener">${escapeHtml_API_Local(row.trackingNumber)}</a>`
            : escapeHtml_API_Local(row.trackingNumber);
        const flags = [
            row.voided ? 'Voided label' : null,
            row.isReturn ? 'Return label' : null
        ].filter(Boolean).join(' · ');
        return `
          ${rows.length > 1 ? `<h4>Shipment ${index + 1}</h4>` : ''}
          <div class="dv-modal-grid">
            <div class="dv-modal-field"><strong>Tracking number</strong><span>${tracking}</span></div>
            ${readOnlyField_API_Local('Carrier', row.carrierCode)}
            ${readOnlyField_API_Local('Service', row.serviceCode)}
            ${readOnlyField_API_Local('Delivery status', row.trackingStatus)}
            ${readOnlyField_API_Local('Label status', row.status)}
            ${readOnlyField_API_Local('Ship date', row.shipDate)}
            ${readOnlyField_API_Local('Shipment ID', row.shipmentId)}
            ${readOnlyField_API_Local('Label ID', row.labelId)}
            ${readOnlyField_API_Local('ShipStation account', row.apiEmail)}
            ${readOnlyField_API_Local('Tracking API', row.apiVersion)}
            ${flags ? readOnlyField_API_Local('Label type', flags) : ''}
          </div>
        `;
    }).join('');
}

function bindShipStationOrderPrompt_API_Local() {
    const input = document.getElementById('shipStationOrderInput');
    const button = document.getElementById('shipStationOrderLookupButton');
    if (!input || !button) return;

    const submit = () => {
        const orderNumber = String(input.value || '').trim();
        if (!orderNumber) {
            modalActionStatus_API_Local('Enter an order number first.', true);
            input.focus();
            return;
        }
        refreshFromOrder_API_Local(orderNumber);
    };

    button.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submit();
        }
    });
    setTimeout(() => input.focus(), 30);
}

/** Shown when the device has no OrderNumber (or lookup says so). */
function renderShipStationOrderPrompt_API_Local(target, message) {
    const hint = message || 'This device has no order number yet.';
    target.innerHTML = `
      <div class="dv-modal-section">
        <h3>ShipStation order</h3>
        <div class="dv-tab-error">
          <strong>No order number on this device</strong>
          <p>${escapeHtml_API_Local(hint)}</p>
        </div>
        <label class="dv-order-prompt" for="shipStationOrderInput">
          <span>Order number</span>
          <div class="dv-order-prompt-row">
            <input type="text" id="shipStationOrderInput" placeholder="e.g. 111-3285811-3603440 or 1Z… tracking"
                   autocomplete="off" spellcheck="false">
            <button type="button" class="dv-icon-btn" id="shipStationOrderLookupButton">
              Look up &amp; save
            </button>
          </div>
        </label>
        <p class="dv-muted">Saves the order number on this device, then pulls customer, shipping, notes, and line items from ShipStation. A UPS 1Z… tracking is resolved to the order automatically if needed.</p>
      </div>
    `;
    bindShipStationOrderPrompt_API_Local();
}

async function populateShipStationData_API_Local(force = false) {
    const target = document.getElementById("ShipStationData_API_Local");
    if (!target) return;

    const existingOrder = String((currentDeviceData && currentDeviceData.OrderNumber) || '').trim();
    if (!existingOrder) {
        renderShipStationOrderPrompt_API_Local(target);
        return;
    }

    target.innerHTML = '<p class="dv-muted">Loading live ShipStation order…</p>';
    try {
        const payload = await fetchShipStationData_API_Local(force);
        const order = payload.orderData || {};
        const shipTo = order.shipTo || {};
        const advanced = order.advancedOptions || {};
        const trackingDetails = payload.trackingDetails || [];
        const primaryTracking = trackingDetails.find((row) => row && !row.voided && !row.isReturn)
            || trackingDetails[0]
            || {};
        const address = [shipTo.street1, shipTo.street2, shipTo.city, shipTo.state, shipTo.postalCode]
            .filter(Boolean).join(', ');
        target.innerHTML = `
          <div class="dv-modal-section">
            <div class="dv-section-head">
              <h3>ShipStation order ${escapeHtml_API_Local(payload.orderNumber)}</h3>
              <button type="button" class="dv-icon-btn" id="refreshFromOrderButton">&#8635; Update local data</button>
            </div>
            <div class="dv-ms-status">
              <span class="dv-chip ok">${escapeHtml_API_Local(order.orderStatus || 'Found')}</span>
              <span class="dv-muted">${escapeHtml_API_Local(payload.account || '')}</span>
              <span class="dv-muted">API ${escapeHtml_API_Local(payload.apiVersion || '')}</span>
            </div>
            <div class="dv-modal-grid">
              ${readOnlyField_API_Local('Order number', order.orderNumber || payload.orderNumber)}
              ${readOnlyField_API_Local('Order status', order.orderStatus)}
              ${readOnlyField_API_Local('Order date', order.orderDate)}
              ${readOnlyField_API_Local('Ship date', order.shipDate || primaryTracking.shipDate)}
              ${readOnlyField_API_Local('Order total', order.orderTotal)}
              ${readOnlyField_API_Local('Amount paid', order.amountPaid)}
            </div>
          </div>
          <div class="dv-modal-section">
            <h3>Shipment / tracking</h3>
            ${shipStationTrackingHtml_API_Local(trackingDetails)}
          </div>
          <div class="dv-modal-section">
            <h3>Customer / shipping</h3>
            <div class="dv-modal-grid">
              ${readOnlyField_API_Local('Name', shipTo.name)}
              ${readOnlyField_API_Local('Company', shipTo.company)}
              ${readOnlyField_API_Local('Address', address)}
              ${readOnlyField_API_Local('Country', shipTo.country)}
              ${readOnlyField_API_Local('Phone', shipTo.phone)}
              ${readOnlyField_API_Local('Residential', shipTo.residential)}
            </div>
          </div>
          <div class="dv-modal-section">
            <h3>Notes / custom fields</h3>
            <div class="dv-modal-grid">
              ${readOnlyField_API_Local('Customer notes', order.customerNotes)}
              ${readOnlyField_API_Local('Internal notes', order.internalNotes)}
              ${readOnlyField_API_Local('Custom field 1', advanced.customField1)}
              ${readOnlyField_API_Local('Custom field 2', advanced.customField2)}
              ${readOnlyField_API_Local('Custom field 3', advanced.customField3)}
            </div>
          </div>
          <div class="dv-modal-section">
            <h3>Line items</h3>
            ${shipStationItemsHtml_API_Local(order.items)}
          </div>
        `;
        const button = document.getElementById('refreshFromOrderButton');
        if (button) button.addEventListener('click', () => refreshFromOrder_API_Local());
    } catch (error) {
        if (/no order number/i.test(error.message || '')) {
            renderShipStationOrderPrompt_API_Local(target, error.message);
            return;
        }
        target.innerHTML = `
          <div class="dv-tab-error"><strong>ShipStation order unavailable</strong><p>${escapeHtml_API_Local(error.message)}</p></div>
          <div class="dv-modal-section">
            <h3>Try a different order number</h3>
            <label class="dv-order-prompt" for="shipStationOrderInput">
              <span>Order number</span>
              <div class="dv-order-prompt-row">
                <input type="text" id="shipStationOrderInput"
                       value="${escapeHtml_API_Local(existingOrder)}"
                       autocomplete="off" spellcheck="false">
                <button type="button" class="dv-icon-btn" id="shipStationOrderLookupButton">
                  Look up &amp; save
                </button>
              </div>
            </label>
            <p class="dv-muted">If this is a UPS 1Z… tracking, Look up &amp; save will resolve it to the ShipStation order automatically.</p>
          </div>
        `;
        bindShipStationOrderPrompt_API_Local();
    }
}

// --------------------------------------------------------------------- print

let activePrintSubTab_API_Local = 'specs';
let shippingLabelCache_API_Local = null;

function printSheetHtml_API_Local(localData) {
    const escapeHtml = escapeHtml_API_Local;
    const warranty = localData._warrantyMerged || localData.msWarranty || {};
    const model = localData.warrantyDeviceName || warranty.deviceName || localData.model || '';
    const rows = [
        ['Serial number', localData.serialNumber],
        ['Model', model],
        ['SKU', localData.sku],
        ['CPU', localData.cpu],
        ['RAM', ramLabel_API_Local(localData.ram)],
        ['Storage', hdLabel_API_Local(localData.hd)],
        ['Windows', localData.windowsVersion],
        ['Activation', localData.activationStatus],
        ['Warranty', localData.warrantyStatus || warranty.status],
        ['Warranty expires', localData.warrantyExpiresOn || warranty.expiresOn],
        ['Order number', localData.OrderNumber],
        ['Order status', localData.orderStatus || localData.orderstatus],
        ['Ship date', localData.shipDate],
        ['Customer', localData.name || localData.company],
        ['Tracking number', localData.InternalTrackingNumber],
        ['Stage', localData.TrackingStage],
        ['Times returned', localData.returnVisitCount]
    ];
    const body = rows.map(([label, value]) => `<tr>
        <th>${escapeHtml(label)}</th><td>${escapeHtml(displayValue_API_Local(value))}</td>
      </tr>`).join('');
    const notes = collectNoteHistory_API_Local(localData);
    const noteRows = notes.length
        ? notes.map((entry) => `<li><strong>${escapeHtml(formatNoteDate_API_Local(entry.at) || 'Undated')}:</strong> ${escapeHtml(entry.text)}</li>`).join('')
        : `<li>${escapeHtml(String(localData.notes || '').trim() || 'No notes.')}</li>`;
    return `<h1>${escapeHtml(localData.serialNumber || 'Device')}</h1>
      <h2>${escapeHtml(model || 'Unknown model')}</h2>
      <table class="dv-print-table"><tbody>${body}</tbody></table>
      <h3>Notes</h3>
      <ul class="dv-print-notes">${noteRows}</ul>
      <p class="dv-print-stamp">Printed ${escapeHtml(new Date().toLocaleString())}</p>`;
}

function printDeviceSheet_API_Local() {
    if (!currentDeviceData) return;
    const win = window.open('', '_blank', 'width=800,height=1000');
    if (!win) {
        modalActionStatus_API_Local('Popup blocked — allow popups to print the device sheet.', true);
        return;
    }
    win.document.write(`<!DOCTYPE html><html><head><title>${escapeHtml_API_Local(currentDeviceData.serialNumber || 'Device')}</title>
      <style>
        body { font-family: Segoe UI, Arial, sans-serif; margin: 28px; color: #111827; }
        h1 { margin: 0; font-size: 22px; letter-spacing: 0.5px; }
        h2 { margin: 2px 0 16px; font-size: 15px; font-weight: 500; color: #374151; }
        h3 { margin: 18px 0 6px; font-size: 13px; text-transform: uppercase; color: #6b7280; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border-bottom: 1px solid #e5e7eb; padding: 5px 8px; text-align: left; font-size: 12px; }
        th { width: 34%; color: #6b7280; font-weight: 600; }
        ul { margin: 0; padding-left: 18px; font-size: 12px; }
        li { margin-bottom: 4px; }
        .dv-print-stamp { margin-top: 20px; font-size: 10px; color: #9ca3af; }
        .dv-print-barcodes { margin-top: 18px; }
        .dv-print-barcodes figure { margin: 0 0 14px; }
        .dv-print-barcodes figcaption { font-size: 11px; color: #6b7280; margin-bottom: 4px; }
        .dv-print-barcodes img { display: block; width: 100%; height: 72px; }
      </style></head><body>${printSheetHtml_API_Local(currentDeviceData)}${printBarcodesBlockHtml_API_Local(currentDeviceData, true)}</body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 450);
}

let printPrintersCache_API_Local = null;
let printCountdownTimer_API_Local = null;
let printCooldownTimer_API_Local = null;
let printCooldownUntil_API_Local = 0;
let printJobInFlight_API_Local = false;
const PRINT_COOLDOWN_SEC_API_Local = 15;

function printCooldownLeft_API_Local() {
    return Math.max(0, Math.ceil((printCooldownUntil_API_Local - Date.now()) / 1000));
}

function clearPrintCooldown_API_Local() {
    if (printCooldownTimer_API_Local) {
        clearInterval(printCooldownTimer_API_Local);
        printCooldownTimer_API_Local = null;
    }
}

function applyPrintCooldownUi_API_Local(btn) {
    if (!btn) return;
    const base = btn.getAttribute('data-print-base') || btn.textContent.replace(/\s*\(\d+s\)\s*$/, '').trim();
    if (!btn.getAttribute('data-print-base')) btn.setAttribute('data-print-base', base);
    const left = printCooldownLeft_API_Local();
    if (left > 0 || printJobInFlight_API_Local) {
        btn.disabled = true;
        btn.textContent = left > 0 ? `${base} (${left}s)` : base;
    } else {
        btn.disabled = false;
        btn.textContent = base;
    }
}

function startPrintSuccessCooldown_API_Local(btn) {
    printCooldownUntil_API_Local = Date.now() + (PRINT_COOLDOWN_SEC_API_Local * 1000);
    clearPrintCooldown_API_Local();
    const tick = () => {
        applyPrintCooldownUi_API_Local(btn);
        if (printCooldownLeft_API_Local() <= 0) {
            clearPrintCooldown_API_Local();
            applyPrintCooldownUi_API_Local(btn);
        }
    };
    tick();
    printCooldownTimer_API_Local = setInterval(tick, 250);
}

function printUseForSubTab_API_Local(tab) {
    return ({ specs: 'specs', shipping: 'shipping', packing: 'packing', template: 'template', pc: 'pc' })[tab] || 'specs';
}

async function loadPrintPrinters_API_Local(force) {
    if (!force && printPrintersCache_API_Local) return printPrintersCache_API_Local;
    const response = await fetch('/api/printers', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
        throw new Error(payload.error || `Printers lookup failed (${response.status})`);
    }
    printPrintersCache_API_Local = (payload.printers || []).filter((p) => p && p.enabled !== false);
    return printPrintersCache_API_Local;
}

function printerMatchesUse_API_Local(printer, useKey) {
    const uses = Array.isArray(printer.uses) && printer.uses.length
        ? printer.uses.map((u) => String(u || '').toLowerCase())
        : [String(printer.role || '').toLowerCase()].filter(Boolean);
    return uses.includes(String(useKey || '').toLowerCase());
}

function printDirectControlsHtml_API_Local(printBtnId, label) {
    return `
      <div class="dv-print-direct">
        <label class="dv-print-field">Printer
          <select id="printPrinterSelect" class="dv-print-select">
            <option value="regular">Regular printing</option>
          </select>
        </label>
        <label class="dv-print-field">Copies
          <input type="number" id="printCopiesInput" class="dv-print-copies" min="1" max="20" value="1" title="Number of copies">
        </label>
        <button type="button" class="dv-icon-btn" id="${escapeHtml_API_Local(printBtnId)}">&#128438; ${escapeHtml_API_Local(label || 'Print')}</button>
        <div id="printCountdownBanner" class="dv-print-countdown" hidden></div>
      </div>`;
}

async function fillPrintPrinterSelect_API_Local(useKey) {
    const select = document.getElementById('printPrinterSelect');
    if (!select) return;
    while (select.options.length > 1) select.remove(1);
    try {
        const printers = await loadPrintPrinters_API_Local(true);
        printers.filter((p) => printerMatchesUse_API_Local(p, useKey)).forEach((p) => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name || p.windowsPrinterName || p.id;
            select.appendChild(opt);
        });
        if (select.options.length > 1) select.selectedIndex = 1;
    } catch (error) {
        console.warn('Could not load printers for print tab', error);
    }
}

function cancelPrintCountdown_API_Local() {
    if (printCountdownTimer_API_Local) {
        clearInterval(printCountdownTimer_API_Local);
        printCountdownTimer_API_Local = null;
    }
    const banner = document.getElementById('printCountdownBanner');
    if (banner) {
        banner.hidden = true;
        banner.innerHTML = '';
    }
}

function startPrintCountdown_API_Local(onFire) {
    cancelPrintCountdown_API_Local();
    const banner = document.getElementById('printCountdownBanner');
    if (!banner) {
        onFire();
        return;
    }
    let left = 4;
    banner.hidden = false;
    const render = () => {
        banner.innerHTML = `You're about to print in <strong>${left}</strong> second${left === 1 ? '' : 's'}. `
            + `<button type="button" class="dv-icon-btn" id="printCountdownCancel">Cancel</button>`;
        const cancel = document.getElementById('printCountdownCancel');
        if (cancel) {
            cancel.addEventListener('click', () => {
                cancelPrintCountdown_API_Local();
                modalActionStatus_API_Local('Print cancelled.');
            });
        }
    };
    render();
    printCountdownTimer_API_Local = setInterval(() => {
        left -= 1;
        if (left <= 0) {
            cancelPrintCountdown_API_Local();
            onFire();
            return;
        }
        render();
    }, 1000);
}

function bindDirectPrintControls_API_Local(opts) {
    const useKey = opts.useKey;
    const printBtnId = opts.printBtnId;
    const regularPrint = opts.regularPrint;
    const pdfUrl = opts.pdfUrl;
    const serial = opts.serial || (currentDeviceData && currentDeviceData.serialNumber) || '';

    fillPrintPrinterSelect_API_Local(useKey);
    const btn = document.getElementById(printBtnId);
    if (!btn) return;
    if (!btn.getAttribute('data-print-base')) {
        btn.setAttribute('data-print-base', btn.textContent.trim());
    }
    btn.addEventListener('click', () => {
        const left = printCooldownLeft_API_Local();
        if (left > 0) {
            modalActionStatus_API_Local(`Print already sent — wait ${left}s before printing again.`, true);
            applyPrintCooldownUi_API_Local(btn);
            return;
        }
        if (printJobInFlight_API_Local || printCountdownTimer_API_Local) {
            modalActionStatus_API_Local('Print already in progress…', true);
            return;
        }

        const select = document.getElementById('printPrinterSelect');
        const copiesEl = document.getElementById('printCopiesInput');
        const printerId = select ? select.value : 'regular';
        const copies = Math.min(20, Math.max(1, parseInt(copiesEl && copiesEl.value, 10) || 1));
        const printerLabel = select && select.selectedOptions[0]
            ? select.selectedOptions[0].textContent
            : 'printer';

        startPrintCountdown_API_Local(async () => {
            if (printerId === 'regular') {
                regularPrint();
                startPrintSuccessCooldown_API_Local(btn);
                modalActionStatus_API_Local('Print dialog opened. Wait before printing again.');
                return;
            }
            printJobInFlight_API_Local = true;
            applyPrintCooldownUi_API_Local(btn);
            try {
                const response = await fetch('/api/print/jobs', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        printerId,
                        use: useKey,
                        pdfUrl,
                        serial,
                        copies
                    })
                });
                const payload = await response.json().catch(() => ({}));
                if (response.status === 429 || payload.cooldown) {
                    const retry = Number(payload.retryAfterSec) || PRINT_COOLDOWN_SEC_API_Local;
                    printCooldownUntil_API_Local = Date.now() + (retry * 1000);
                    startPrintSuccessCooldown_API_Local(btn);
                    throw new Error(payload.error || `Print cooldown — wait ${retry}s`);
                }
                if (!response.ok || payload.error) {
                    throw new Error(payload.error || `Print failed (${response.status})`);
                }
                const name = (payload.job && (payload.job.printerName || payload.job.windowsPrinterName)) || printerLabel;
                modalActionStatus_API_Local(`Success — queued ${copies}× to ${name}. The office agent will print shortly.`);
                startPrintSuccessCooldown_API_Local(btn);
            } catch (error) {
                modalActionStatus_API_Local(error.message || 'Print failed', true);
                applyPrintCooldownUi_API_Local(btn);
            } finally {
                printJobInFlight_API_Local = false;
                applyPrintCooldownUi_API_Local(btn);
            }
        });
    });
}

function barcodeUrl_API_Local(text, bcid) {
    if (!text) return null;
    const params = new URLSearchParams({
        text: String(text),
        bcid: bcid || 'code128',
        scale: '2',
        height: '10'
    });
    return `/api/device/barcode.png?${params.toString()}`;
}

function printBarcodesBlockHtml_API_Local(localData, forPrintWindow) {
    const escapeHtml = escapeHtml_API_Local;
    const items = [
        ['Serial number', localData.serialNumber, 'code39'],
        ['Order number', localData.OrderNumber, 'code128'],
        ['Tracking number', localData.InternalTrackingNumber, 'code128']
    ].filter((row) => row[1] && String(row[1]).trim());

    if (!items.length) {
        return forPrintWindow ? '' : '<p class="dv-muted">No barcode values available.</p>';
    }

    const figures = items.map(([label, value, bcid]) => {
        const url = barcodeUrl_API_Local(value, bcid);
        return `<figure class="dv-barcode-card">
          <figcaption>${escapeHtml(label)} · <code>${escapeHtml(value)}</code></figcaption>
          <img src="${escapeHtml(url)}" alt="${escapeHtml(label)} barcode" loading="lazy">
        </figure>`;
    }).join('');

    return `<div class="dv-print-barcodes${forPrintWindow ? '' : ''}">${figures}</div>`;
}

function bindPrintFrameButtons_API_Local(printBtnId, openBtnId, frameId, url) {
    const printBtn = document.getElementById(printBtnId);
    if (printBtn) printBtn.addEventListener('click', () => {
        const frame = document.getElementById(frameId);
        try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
        } catch (e) {
            window.open(url, '_blank');
        }
    });
    const openBtn = document.getElementById(openBtnId);
    if (openBtn) openBtn.addEventListener('click', () => window.open(url, '_blank'));
}

function renderPrintSpecsSubTab_API_Local(localData) {
    const body = document.getElementById('printSubTabBody');
    if (!body) return;
    const serial = encodeURIComponent(localData.serialNumber || '');
    const pdfUrl = `/api/device/specs-sheet/${serial}/pdf`;
    body.innerHTML = `
      <div class="dv-modal-section">
        <div class="dv-section-head">
          <h3>Specs sheet</h3>
        </div>
        ${printDirectControlsHtml_API_Local('printSheetButton', 'Print sheet')}
        <div class="dv-print-sheet">${printSheetHtml_API_Local(localData)}</div>
      </div>
      <div class="dv-modal-section">
        <h3>Barcodes</h3>
        ${printBarcodesBlockHtml_API_Local(localData, false)}
        <p class="dv-muted">Serial uses Code 39; order / tracking use Code 128.</p>
      </div>
    `;
    bindDirectPrintControls_API_Local({
        useKey: 'specs',
        printBtnId: 'printSheetButton',
        pdfUrl,
        serial: localData.serialNumber,
        regularPrint: printDeviceSheet_API_Local
    });
}

function renderPrintPcLabelSubTab_API_Local(localData) {
    const body = document.getElementById('printSubTabBody');
    if (!body) return;
    const serial = encodeURIComponent(localData.serialNumber || '');
    const labelUrl = `/preview-label/${serial}`;
    body.innerHTML = `
      <div class="dv-modal-section">
        <div class="dv-section-head">
          <h3>Back-of-PC label (1.5" × 0.75")</h3>
          <div class="dv-print-buttons">
            <button type="button" class="dv-icon-btn" id="openLabelButton">Open PDF</button>
          </div>
        </div>
        ${printDirectControlsHtml_API_Local('printLabelButton', 'Print label')}
        <iframe class="dv-print-frame" id="labelPreviewFrame" title="PC label preview" src="${labelUrl}"></iframe>
        <p class="dv-muted">Small sticker for the back of the PC. Barcode encodes the serial number.</p>
      </div>
    `;
    const openBtn = document.getElementById('openLabelButton');
    if (openBtn) openBtn.addEventListener('click', () => window.open(labelUrl, '_blank'));
    bindDirectPrintControls_API_Local({
        useKey: 'pc',
        printBtnId: 'printLabelButton',
        pdfUrl: labelUrl,
        serial: localData.serialNumber,
        regularPrint: () => {
            const frame = document.getElementById('labelPreviewFrame');
            try {
                frame.contentWindow.focus();
                frame.contentWindow.print();
            } catch (e) {
                window.open(labelUrl, '_blank');
            }
        }
    });
}

function shippingLabelMetaHtml_API_Local(label) {
    if (!label) return '';
    const escapeHtml = escapeHtml_API_Local;
    return `<div class="dv-modal-grid">
      ${readOnlyField_API_Local('Tracking', label.trackingNumber)}
      ${readOnlyField_API_Local('Carrier', label.carrierCode)}
      ${readOnlyField_API_Local('Service', label.serviceCode)}
      ${readOnlyField_API_Local('Ship date', label.shipDate)}
      ${readOnlyField_API_Local('Status', label.status)}
      ${readOnlyField_API_Local('Account', label.account)}
      ${readOnlyField_API_Local('Label id', label.labelId || label.shipmentId)}
    </div>`;
}

async function renderPrintShippingSubTab_API_Local(localData, force) {
    const body = document.getElementById('printSubTabBody');
    if (!body || !localData) return;

    const orderNumber = String(localData.OrderNumber || '').trim();
    if (!orderNumber && !String(localData.InternalTrackingNumber || '').trim()) {
        body.innerHTML = `
          <div class="dv-tab-error">
            <strong>No order or tracking number</strong>
            <p>Add an order number on the ShipStation tab first, then come back for the shipping label.</p>
          </div>
          <button type="button" class="dv-icon-btn" id="printGoShipStation">Open ShipStation tab</button>
        `;
        const go = document.getElementById('printGoShipStation');
        if (go) go.addEventListener('click', () => openTab(null, 'ShipStationData_API_Local'));
        return;
    }

    body.innerHTML = '<p class="dv-muted">Looking up shipping label in ShipStation…</p>';
    try {
        if (force) shippingLabelCache_API_Local = null;
        if (!shippingLabelCache_API_Local) {
            const response = await fetch(
                `/api/device/shipping-label/${encodeURIComponent(localData.serialNumber)}`,
                { cache: 'no-store' }
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) {
                throw new Error(payload.error || `Lookup failed (${response.status})`);
            }
            shippingLabelCache_API_Local = payload;
        }

        const payload = shippingLabelCache_API_Local;
        const labels = payload.labels || [];
        const best = labels.find((row) => row.hasPdf) || labels[0] || null;
        const serial = encodeURIComponent(localData.serialNumber);
        const pdfUrl = `/api/device/shipping-label/${serial}/pdf`;
        const tracking = (best && best.trackingNumber) || payload.trackingNumber || '';

        if (best && best.hasPdf) {
            body.innerHTML = `
              <div class="dv-modal-section">
                <div class="dv-section-head">
                  <h3>ShipStation shipping label</h3>
                  <div class="dv-print-buttons">
                    <button type="button" class="dv-icon-btn" id="openShipLabelButton">Open PDF</button>
                    <button type="button" class="dv-icon-btn" id="reloadShipLabelButton">&#8635; Reload</button>
                  </div>
                </div>
                ${printDirectControlsHtml_API_Local('printShipLabelButton', 'Print label')}
                <div class="dv-ms-status">
                  <span class="dv-chip ok">PDF available</span>
                  <span class="dv-muted">${escapeHtml_API_Local(best.account || '')}</span>
                  <span class="dv-muted">${escapeHtml_API_Local(best.source || '')}</span>
                </div>
                ${shippingLabelMetaHtml_API_Local(best)}
                <iframe class="dv-print-frame dv-print-frame-tall" id="shipLabelFrame"
                        title="Shipping label" src="${pdfUrl}"></iframe>
              </div>
            `;
            const openShip = document.getElementById('openShipLabelButton');
            if (openShip) openShip.addEventListener('click', () => window.open(pdfUrl, '_blank'));
            bindDirectPrintControls_API_Local({
                useKey: 'shipping',
                printBtnId: 'printShipLabelButton',
                pdfUrl,
                serial: localData.serialNumber,
                regularPrint: () => {
                    const frame = document.getElementById('shipLabelFrame');
                    try {
                        frame.contentWindow.focus();
                        frame.contentWindow.print();
                    } catch (e) {
                        window.open(pdfUrl, '_blank');
                    }
                }
            });
        } else {
            const reason = payload.missingReason || {
                title: labels.length ? 'Carrier label PDF expired' : 'No shipping label found',
                message: labels.length
                    ? 'ShipStation only keeps label PDF downloads for a limited time. Shipment details below are still available — use the Packing slip tab to print.'
                    : 'No label was found for this order/tracking across ShipStation accounts. You can still print from the Packing slip tab.'
            };
            const statusChip = payload.orderStatus
                ? `<span class="dv-chip warn">${escapeHtml_API_Local(payload.orderStatus)}</span>`
                : '';
            body.innerHTML = `
              <div class="dv-modal-section">
                <div class="dv-section-head">
                  <h3>ShipStation shipping label</h3>
                  <div class="dv-print-buttons">
                    <button type="button" class="dv-icon-btn" id="goPackingSlipTabButton">Open Packing slip tab</button>
                    <button type="button" class="dv-icon-btn" id="reloadShipLabelButton">&#8635; Reload</button>
                  </div>
                </div>
                <div class="dv-ms-status">
                  ${statusChip}
                  ${payload.orderNumber ? `<span class="dv-muted">Order ${escapeHtml_API_Local(payload.orderNumber)}</span>` : ''}
                </div>
                <div class="dv-tab-error">
                  <strong>${escapeHtml_API_Local(reason.title)}</strong>
                  <p>${escapeHtml_API_Local(reason.message)}</p>
                </div>
                ${best ? shippingLabelMetaHtml_API_Local(best) : ''}
              </div>
            `;
            const goPack = document.getElementById('goPackingSlipTabButton');
            if (goPack) {
                goPack.addEventListener('click', () => {
                    activePrintSubTab_API_Local = 'packing';
                    populatePrintData_API_Local(localData);
                });
            }
        }

        if (labels.length > 1) {
            const list = labels.map((row, index) => `<li>
              ${index + 1}. ${escapeHtml_API_Local(row.trackingNumber || row.labelId || row.shipmentId || 'label')}
              · ${escapeHtml_API_Local(row.carrierCode || '—')}
              · ${row.hasPdf ? 'PDF' : (row.expired ? 'expired' : 'no PDF')}
              · ${escapeHtml_API_Local(row.account || '')}
            </li>`).join('');
            body.insertAdjacentHTML('beforeend', `
              <div class="dv-modal-section">
                <h3>All labels found (${labels.length})</h3>
                <ul class="dv-print-notes">${list}</ul>
              </div>
            `);
        }

        const reload = document.getElementById('reloadShipLabelButton');
        if (reload) reload.addEventListener('click', () => renderPrintShippingSubTab_API_Local(localData, true));
    } catch (error) {
        body.innerHTML = `<div class="dv-tab-error"><strong>Shipping label lookup failed</strong><p>${escapeHtml_API_Local(error.message)}</p></div>
          <button type="button" class="dv-icon-btn" id="reloadShipLabelButton">&#8635; Retry</button>`;
        const reload = document.getElementById('reloadShipLabelButton');
        if (reload) reload.addEventListener('click', () => renderPrintShippingSubTab_API_Local(localData, true));
    }
}

async function renderPrintPackingSubTab_API_Local(localData, force) {
    const body = document.getElementById('printSubTabBody');
    if (!body || !localData) return;

    const orderNumber = String(localData.OrderNumber || '').trim();
    const trackingNumber = String(localData.InternalTrackingNumber || '').trim();
    if (!orderNumber && !trackingNumber) {
        body.innerHTML = `
          <div class="dv-tab-error">
            <strong>No order or tracking number</strong>
            <p>Add an order number on the ShipStation tab first, then come back for the packing slip.</p>
          </div>
          <button type="button" class="dv-icon-btn" id="printGoShipStationPack">Open ShipStation tab</button>
        `;
        const go = document.getElementById('printGoShipStationPack');
        if (go) go.addEventListener('click', () => openTab(null, 'ShipStationData_API_Local'));
        return;
    }

    body.innerHTML = '<p class="dv-muted">Loading packing slip…</p>';
    try {
        if (force) shippingLabelCache_API_Local = null;
        if (!shippingLabelCache_API_Local) {
            const response = await fetch(
                `/api/device/shipping-label/${encodeURIComponent(localData.serialNumber)}`,
                { cache: 'no-store' }
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) {
                throw new Error(payload.error || `Lookup failed (${response.status})`);
            }
            shippingLabelCache_API_Local = payload;
        }

        const payload = shippingLabelCache_API_Local;
        const labels = payload.labels || [];
        const best = labels.find((row) => row.hasPdf) || labels[0] || null;
        const serial = encodeURIComponent(localData.serialNumber);
        const packUrl = `/api/device/shipping-label/${serial}/pack?t=${Date.now()}`;
        const tracking = (best && best.trackingNumber) || payload.trackingNumber || trackingNumber || '';

        body.innerHTML = `
          <div class="dv-modal-section">
            <div class="dv-section-head">
              <h3>Packing slip</h3>
              <div class="dv-print-buttons">
                <button type="button" class="dv-icon-btn" id="openPackSlipTabButton">Open PDF</button>
                <button type="button" class="dv-icon-btn" id="reloadPackSlipButton">&#8635; Reload</button>
              </div>
            </div>
            ${printDirectControlsHtml_API_Local('printPackSlipTabButton', 'Print packing slip')}
            <div class="dv-ms-status">
              <span class="dv-chip ok">Packing slip</span>
              ${payload.orderNumber ? `<span class="dv-muted">Order ${escapeHtml_API_Local(payload.orderNumber)}</span>` : ''}
              ${payload.orderStatus ? `<span class="dv-chip warn">${escapeHtml_API_Local(payload.orderStatus)}</span>` : ''}
              <span class="dv-muted">${escapeHtml_API_Local((best && best.account) || '')}</span>
            </div>
            ${best ? shippingLabelMetaHtml_API_Local(best) : `
              <div class="dv-modal-grid">
                ${readOnlyField_API_Local('Order', payload.orderNumber || orderNumber)}
                ${readOnlyField_API_Local('Tracking', tracking)}
              </div>
            `}
            <iframe class="dv-print-frame dv-print-frame-tall" id="packSlipTabFrame"
                    title="Packing slip" src="${packUrl}"></iframe>
            <p class="dv-muted">Packing slip PDF from ShipStation (includes order details and tracking barcode when available).</p>
          </div>
        `;
        const openPack = document.getElementById('openPackSlipTabButton');
        if (openPack) openPack.addEventListener('click', () => window.open(packUrl, '_blank'));
        bindDirectPrintControls_API_Local({
            useKey: 'packing',
            printBtnId: 'printPackSlipTabButton',
            pdfUrl: packUrl.split('?')[0],
            serial: localData.serialNumber,
            regularPrint: () => {
                const frame = document.getElementById('packSlipTabFrame');
                try {
                    frame.contentWindow.focus();
                    frame.contentWindow.print();
                } catch (e) {
                    window.open(packUrl, '_blank');
                }
            }
        });
        const reload = document.getElementById('reloadPackSlipButton');
        if (reload) reload.addEventListener('click', () => renderPrintPackingSubTab_API_Local(localData, true));
    } catch (error) {
        body.innerHTML = `<div class="dv-tab-error"><strong>Packing slip lookup failed</strong><p>${escapeHtml_API_Local(error.message)}</p></div>
          <button type="button" class="dv-icon-btn" id="reloadPackSlipButton">&#8635; Retry</button>`;
        const reload = document.getElementById('reloadPackSlipButton');
        if (reload) reload.addEventListener('click', () => renderPrintPackingSubTab_API_Local(localData, true));
    }
}

async function renderPrintTemplateSubTab_API_Local(localData, force) {
    const body = document.getElementById('printSubTabBody');
    if (!body || !localData) return;

    const orderNumber = String(localData.OrderNumber || '').trim();
    if (!orderNumber) {
        body.innerHTML = `
          <div class="dv-tab-error">
            <strong>No order number</strong>
            <p>Add an order number on the ShipStation tab first. The store template is chosen from that order&apos;s selling channel.</p>
          </div>
          <button type="button" class="dv-icon-btn" id="printGoShipStationTemplate">Open ShipStation tab</button>
        `;
        const go = document.getElementById('printGoShipStationTemplate');
        if (go) go.addEventListener('click', () => openTab(null, 'ShipStationData_API_Local'));
        return;
    }

    body.innerHTML = '<p class="dv-muted">Loading store packing-slip template…</p>';
    try {
        const response = await fetch(
            `/api/device/packing-template/${encodeURIComponent(localData.serialNumber)}${force ? `?t=${Date.now()}` : ''}`,
            { cache: 'no-store' }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.error) {
            throw new Error(payload.error || `Lookup failed (${response.status})`);
        }

        const serial = encodeURIComponent(localData.serialNumber);
        const pdfUrl = `/api/device/packing-template/${serial}/pdf?t=${Date.now()}`;
        const market = payload.store && payload.store.marketplaceName
            ? payload.store.marketplaceName
            : payload.templateKey;
        const storeName = payload.store && payload.store.storeName ? payload.store.storeName : '';

        body.innerHTML = `
          <div class="dv-modal-section">
            <div class="dv-section-head">
              <h3>From template</h3>
              <div class="dv-print-buttons">
                <button type="button" class="dv-icon-btn" id="openTemplateSlipButton">Open PDF</button>
                <button type="button" class="dv-icon-btn" id="reloadTemplateSlipButton">&#8635; Reload</button>
              </div>
            </div>
            ${printDirectControlsHtml_API_Local('printTemplateSlipButton', 'Print template')}
            <div class="dv-ms-status">
              <span class="dv-chip ok">${escapeHtml_API_Local(market || 'Template')}</span>
              ${storeName ? `<span class="dv-muted">${escapeHtml_API_Local(storeName)}</span>` : ''}
              ${payload.orderNumber ? `<span class="dv-muted">Order ${escapeHtml_API_Local(payload.orderNumber)}</span>` : ''}
              ${payload.orderStatus ? `<span class="dv-chip warn">${escapeHtml_API_Local(payload.orderStatus)}</span>` : ''}
            </div>
            <div class="dv-modal-grid">
              ${readOnlyField_API_Local('Template', payload.templateLabel || payload.templateKey)}
              ${readOnlyField_API_Local('Order number', payload.orderNumber)}
              ${readOnlyField_API_Local('Serial numbers', (payload.serialNumbers && payload.serialNumbers.length)
                ? payload.serialNumbers.join(', ')
                : (payload.serialNumber || localData.serialNumber))}
              ${readOnlyField_API_Local('Tracking', payload.trackingNumber)}
              ${readOnlyField_API_Local('Resolved via', payload.resolvedFrom === 'tracking'
                ? `Tracking → order (${payload.lookupInput || ''})`
                : 'Order number')}
              ${readOnlyField_API_Local('Items', payload.itemCount)}
              ${readOnlyField_API_Local('Account', payload.account)}
            </div>
            <p class="dv-muted">Serials print under each line item when SKU/model matches. Tracking values like 1Z… are converted to the ShipStation order when possible.</p>
            <iframe class="dv-print-frame dv-print-frame-tall" id="templateSlipFrame"
                    title="Store packing slip template" src="${pdfUrl}"></iframe>
            <p class="dv-muted">Uses the packing-slip layout for this order&apos;s store channel (Newegg, Amazon, Walmart, etc.).</p>
          </div>
        `;
        const openBtn = document.getElementById('openTemplateSlipButton');
        if (openBtn) openBtn.addEventListener('click', () => window.open(pdfUrl, '_blank'));
        bindDirectPrintControls_API_Local({
            useKey: 'template',
            printBtnId: 'printTemplateSlipButton',
            pdfUrl: pdfUrl.split('?')[0],
            serial: localData.serialNumber,
            regularPrint: () => {
                const frame = document.getElementById('templateSlipFrame');
                try {
                    frame.contentWindow.focus();
                    frame.contentWindow.print();
                } catch (e) {
                    window.open(pdfUrl, '_blank');
                }
            }
        });
        const reload = document.getElementById('reloadTemplateSlipButton');
        if (reload) reload.addEventListener('click', () => renderPrintTemplateSubTab_API_Local(localData, true));
    } catch (error) {
        body.innerHTML = `<div class="dv-tab-error"><strong>Template packing slip failed</strong><p>${escapeHtml_API_Local(error.message)}</p></div>
          <button type="button" class="dv-icon-btn" id="reloadTemplateSlipButton">&#8635; Retry</button>`;
        const reload = document.getElementById('reloadTemplateSlipButton');
        if (reload) reload.addEventListener('click', () => renderPrintTemplateSubTab_API_Local(localData, true));
    }
}

function populatePrintData_API_Local(localData) {
    const target = document.getElementById('PrintData_API_Local');
    if (!target || !localData) return;

    cancelPrintCountdown_API_Local();

    if (!['specs', 'shipping', 'packing', 'template', 'pc'].includes(activePrintSubTab_API_Local)) {
        activePrintSubTab_API_Local = 'specs';
    }

    target.innerHTML = `
      <div class="dv-subtabs" id="printSubTabs">
        <button type="button" class="dv-subtab${activePrintSubTab_API_Local === 'specs' ? ' active' : ''}" data-print-tab="specs">Specs &amp; barcodes</button>
        <button type="button" class="dv-subtab${activePrintSubTab_API_Local === 'shipping' ? ' active' : ''}" data-print-tab="shipping">Shipping label</button>
        <button type="button" class="dv-subtab${activePrintSubTab_API_Local === 'packing' ? ' active' : ''}" data-print-tab="packing">Packing slip</button>
        <button type="button" class="dv-subtab${activePrintSubTab_API_Local === 'template' ? ' active' : ''}" data-print-tab="template">From template</button>
        <button type="button" class="dv-subtab${activePrintSubTab_API_Local === 'pc' ? ' active' : ''}" data-print-tab="pc">PC label</button>
      </div>
      <div class="dv-subtab-body" id="printSubTabBody"></div>
    `;

    target.querySelectorAll('[data-print-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            activePrintSubTab_API_Local = button.getAttribute('data-print-tab');
            populatePrintData_API_Local(localData);
        });
    });

    if (activePrintSubTab_API_Local === 'shipping') {
        renderPrintShippingSubTab_API_Local(localData, false);
    } else if (activePrintSubTab_API_Local === 'packing') {
        renderPrintPackingSubTab_API_Local(localData, false);
    } else if (activePrintSubTab_API_Local === 'template') {
        renderPrintTemplateSubTab_API_Local(localData, false);
    } else if (activePrintSubTab_API_Local === 'pc') {
        renderPrintPcLabelSubTab_API_Local(localData);
    } else {
        renderPrintSpecsSubTab_API_Local(localData);
    }
}

// ------------------------------------------------------------------ API data

async function populateAPIData_API_Local() {
    const tabs = document.getElementById('apiSubTabs');
    const body = document.getElementById('apiSubTabBody');
    if (!tabs || !body || !currentDeviceData) return;

    if (!apiSourceCatalog_API_Local) {
        tabs.innerHTML = '<span class="dv-muted">Loading source list…</span>';
        try {
            const response = await fetch(
                `/api/device/api-sources/${encodeURIComponent(currentDeviceData.serialNumber)}`,
                { cache: 'no-store' }
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) throw new Error(payload.error || `Failed (${response.status})`);
            apiSourceCatalog_API_Local = payload;
        } catch (error) {
            tabs.innerHTML = '';
            body.innerHTML = `<div class="dv-tab-error"><strong>Source list unavailable</strong><p>${escapeHtml_API_Local(error.message)}</p></div>`;
            return;
        }
    }

    const sources = apiSourceCatalog_API_Local.sources || [];
    if (!activeApiSource_API_Local || !sources.some((s) => s.id === activeApiSource_API_Local && s.available)) {
        const first = sources.find((s) => s.available);
        activeApiSource_API_Local = first ? first.id : null;
    }

    tabs.innerHTML = sources.map((source) => {
        const active = source.id === activeApiSource_API_Local ? ' active' : '';
        const disabled = source.available ? '' : ' disabled';
        const title = source.available ? source.description : source.unavailableReason;
        return `<button type="button" class="dv-subtab${active}"${disabled}
                  data-source="${escapeHtml_API_Local(source.id)}"
                  title="${escapeHtml_API_Local(title || '')}">${escapeHtml_API_Local(source.label)}</button>`;
    }).join('');
    tabs.querySelectorAll('.dv-subtab').forEach((button) => {
        button.addEventListener('click', () => {
            activeApiSource_API_Local = button.getAttribute('data-source');
            populateAPIData_API_Local();
        });
    });

    if (!activeApiSource_API_Local) {
        body.innerHTML = '<p class="dv-muted">No API sources available for this device.</p>';
        return;
    }
    renderApiSource_API_Local(activeApiSource_API_Local, false);
}

async function renderApiSource_API_Local(sourceId, force) {
    const body = document.getElementById('apiSubTabBody');
    if (!body || !currentDeviceData) return;
    const meta = (apiSourceCatalog_API_Local.sources || []).find((s) => s.id === sourceId) || {};

    const cached = apiSourceCache_API_Local[sourceId];
    if (!cached || force) {
        body.innerHTML = `<p class="dv-muted">Pulling <strong>${escapeHtml_API_Local(meta.label || sourceId)}</strong>…</p>`;
        try {
            const response = await fetch(
                `/api/device/api-source/${encodeURIComponent(sourceId)}/${encodeURIComponent(currentDeviceData.serialNumber)}`,
                { cache: 'no-store' }
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.error) throw new Error(payload.error || `Failed (${response.status})`);
            apiSourceCache_API_Local[sourceId] = payload;
        } catch (error) {
            body.innerHTML = `<div class="dv-tab-error"><strong>${escapeHtml_API_Local(meta.label || sourceId)} failed</strong>
              <p>${escapeHtml_API_Local(error.message)}</p></div>
              <button type="button" class="dv-icon-btn" id="apiSourceRetry">Retry</button>`;
            const retry = document.getElementById('apiSourceRetry');
            if (retry) retry.addEventListener('click', () => renderApiSource_API_Local(sourceId, true));
            return;
        }
    }

    const payload = apiSourceCache_API_Local[sourceId];
    const json = JSON.stringify(payload.data, null, 2);
    const empty = payload.data == null
        || (Array.isArray(payload.data) && !payload.data.length)
        || json === '{}';
    body.innerHTML = `
      <div class="dv-subtab-head">
        <div>
          <strong>${escapeHtml_API_Local(meta.label || sourceId)}</strong>
          <p class="dv-muted">${escapeHtml_API_Local(meta.description || '')}</p>
        </div>
        <div class="dv-print-buttons">
          <span class="dv-muted">${payload.elapsedMs != null ? `${payload.elapsedMs} ms` : ''}</span>
          <button type="button" class="dv-icon-btn" id="apiSourceCopy">Copy JSON</button>
          <button type="button" class="dv-icon-btn" id="apiSourceReload">&#8635; Reload</button>
        </div>
      </div>
      ${empty ? '<p class="dv-muted">This source returned no data for this device.</p>' : ''}
      <pre class="dv-api-debug">${escapeHtml_API_Local(json)}</pre>`;

    const reload = document.getElementById('apiSourceReload');
    if (reload) reload.addEventListener('click', () => renderApiSource_API_Local(sourceId, true));
    const copy = document.getElementById('apiSourceCopy');
    if (copy) copy.addEventListener('click', () => {
        navigator.clipboard.writeText(json).then(
            () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy JSON'; }, 1500); },
            () => { copy.textContent = 'Copy failed'; }
        );
    });
}
function saveLocalData() {
    console.log("Save Local Data function triggered");

    if (!currentDeviceData || !currentDeviceData.serialNumber) {
        console.error("No device data available to save.");
        return;
    }

    const serialNumber = currentDeviceData.serialNumber;
    const updatedData = {};
    const fields = ['model', 'cpu', 'ram', 'hd', 'windowsVersion', 'sku', 'notes', 'activationStatus', 'OrderNumber', 'serialNumber'];

    fields.forEach(field => {
        const inputField = document.getElementById(`${field}InputField`);
        if (inputField) {
            updatedData[field] = inputField.value;
        } else {
            console.log(`Field not found: ${field}InputField`);
        }
    });

    fetch(`/update-device/${encodeURIComponent(serialNumber)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatedData),
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Failed to update device');
        }
        return response.text();
    })
    .then(result => {
        console.log(result);
        // Refresh the modal data
        refreshModalData(serialNumber);
		
        // Call the callback function to refresh the device list in all_devices.js
        if (refreshDeviceListCallback) {
            refreshDeviceListCallback();
        }
		
    })
    .catch(error => {
        console.error('Error:', error);
    });
}

/**
 * Warranty can be cached without being stamped onto the device record, so pull
 * it separately and let the modal render one merged Microsoft view.
 */
function attachWarranty_API_Local(deviceData) {
    const serial = deviceData && deviceData.serialNumber;
    if (!serial) return Promise.resolve(deviceData);
    return fetch(`/warranty/${encodeURIComponent(serial)}`)
        .then(response => (response.ok ? response.json() : null))
        .then(payload => {
            if (payload && payload.warranty) deviceData._warrantyMerged = payload.warranty;
            return deviceData;
        })
        .catch(() => deviceData);
}

function renderActiveModalTab_API_Local() {
    if (!currentDeviceData) return;
    switch (activeModalTab_API_Local) {
        case 'History_API_Local':
            populateHistory_API_Local(currentDeviceData);
            break;
        case 'LocalData_API_Local':
            populateLocalData_API_Local(currentDeviceData, false);
            break;
        case 'WarrantyData_API_Local':
            populateWarrantyData_API_Local(currentDeviceData);
            break;
        case 'ShipStationData_API_Local':
            populateShipStationData_API_Local(false);
            break;
        case 'PrintData_API_Local':
            populatePrintData_API_Local(currentDeviceData);
            break;
        case 'APIData_API_Local':
            populateAPIData_API_Local();
            break;
        default:
            populateOverview_API_Local(currentDeviceData);
    }
}

// Function to refresh modal data
function refreshModalData(serialNumber) {
    fetch(`/get-details-by-serial/${encodeURIComponent(serialNumber)}`)
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to fetch updated device data');
            }
            return response.json();
        })
        .then(attachWarranty_API_Local)
        .then(updatedDeviceData => {
            currentDeviceData = updatedDeviceData; // Update the global current device data
            apiSourceCache_API_Local = {}; // stale after a refresh writes new local values
            renderActiveModalTab_API_Local();
        })
        .catch(error => {
            console.error('Error:', error);
        });
}





function ensureModalApiLocalOnBody() {
    if (!modal_API_Local) {
        modal_API_Local = document.getElementById("infoModal_API_Local");
    }
    if (modal_API_Local && modal_API_Local.parentElement !== document.body) {
        document.body.appendChild(modal_API_Local);
    }
}

function openModalApiLocal() {
    ensureModalApiLocalOnBody();
    if (modal_API_Local) {
        modal_API_Local.style.display = "block";
    }
}

function loadModalData_API_Local(serialNumber) {
    const serial = String(serialNumber == null ? '' : serialNumber).trim();
    if (!serial) {
        const overview = document.getElementById('Overview_API_Local');
        if (overview) overview.innerHTML = '<div class="dv-tab-error"><strong>Device unavailable</strong><p>No serial number was provided for this row.</p></div>';
        openModalApiLocal();
        openTab(null, 'Overview_API_Local');
        return;
    }
    fetch(`/get-details-by-serial/${encodeURIComponent(serial.toLowerCase())}`)
        .then(response => {
            if (response.status === 404) {
                throw new Error(`No record found for serial ${serial}. It may have been deleted — refresh the list to reload it.`);
            }
            if (!response.ok) {
                throw new Error(`Lookup failed for serial ${serial} (HTTP ${response.status}).`);
            }
            return response.json();
        })
        .then(attachWarranty_API_Local)
        .then(deviceData => {
            currentDeviceData = deviceData; // Store the fetched data
            shipStationDataCache_API_Local = null;
            shippingLabelCache_API_Local = null;
            apiSourceCatalog_API_Local = null;
            apiSourceCache_API_Local = {};
            activeApiSource_API_Local = null;
            activePrintSubTab_API_Local = 'specs';
            activeModalTab_API_Local = 'Overview_API_Local';
            modalActionStatus_API_Local('');
            clearTabContents_API_Local();
            openModalApiLocal();
            openTab(null, 'Overview_API_Local');
        })
        .catch(error => {
            console.error(error);
            const overview = document.getElementById("Overview_API_Local");
            if (overview) overview.innerHTML = `<div class="dv-tab-error"><strong>Device unavailable</strong><p>${escapeHtml_API_Local(error.message)}</p></div>`;
            openModalApiLocal();
            openTab(null, 'Overview_API_Local');
        });
}


document.addEventListener("DOMContentLoaded", function() {
    console.log("addEventListener loded");
    modal_API_Local = document.getElementById("infoModal_API_Local");

    var span = document.getElementsByClassName("close_API_Local")[0];
    span.onclick = function() {
        modal_API_Local.style.display = "none";
    }
});

window.onclick = function(event) {
    if (event.target == modal_API_Local) {
        modal_API_Local.style.display = "none";
    }
};


// Toggle between Edit and Save mode
function toggleEditMode_API_Local(isEditMode) {
    const editButton = document.getElementById('editButton');
    const saveButtonShowAPILocalDetails = document.getElementById('saveButtonShowAPILocalDetails');
    const fields = document.querySelectorAll('.editable');

    editButton.style.display = isEditMode ? 'none' : 'block';
    saveButtonShowAPILocalDetails.style.display = isEditMode ? 'block' : 'none';

    fields.forEach(field => {
        if (isEditMode) {
            const value = field.textContent;
            field.innerHTML = `<input type="text" value="${value}">`;
        } else {
            const input = field.querySelector('input');
            field.textContent = input ? input.value : field.textContent;
        }
    });
	    // Repopulate data with appropriate mode
    populateLocalData_API_Local(currentDeviceData, isEditMode);
}


// Toggle between Edit and Save mode for API data
function toggleApiEditMode_API_Local(isEditMode) {
    const editButton = document.getElementById('editApiButton');
    const saveButtonShowAPILocalDetails = document.getElementById('saveApiButton');
    const fields = document.querySelectorAll('#APIData_API_Local .editable');

    editButton.style.display = isEditMode ? 'none' : 'block';
    saveButtonShowAPILocalDetails.style.display = isEditMode ? 'block' : 'none';

    fields.forEach(field => {
        if (isEditMode) {
            const value = field.textContent;
            field.innerHTML = `<input type="text" value="${value}">`;
        } else {
            const input = field.querySelector('input');
            field.textContent = input ? input.value : field.textContent;
        }
    });
}
//document.getElementById('editButton').addEventListener('click', () => toggleEditMode_API_Local(true));
//document.getElementById('saveButtonShowAPILocalDetails').addEventListener('click', () => toggleEditMode_API_Local(false));


//document.getElementById('editApiButton').addEventListener('click', () => toggleApiEditMode_API_Local(true));
//document.getElementById('saveApiButton').addEventListener('click', () => toggleApiEditMode_API_Local(false));

    // Show/hide edit and save buttons based on the selected tab
/*    const isLocalTab = tabName_API_Local === 'LocalData_API_Local';
    document.getElementById('editButton').style.display = isLocalTab ? 'block' : 'none';
    document.getElementById('saveButtonShowAPILocalDetails').style.display = 'none'; // Always hide save button initially

    const isApiTab = tabName_API_Local === 'APIData_API_Local';
    document.getElementById('editApiButton').style.display = isApiTab ? 'block' : 'none';
    document.getElementById('saveApiButton').style.display = 'none'; // Always hide save button initially
*/	
	


function closeModal_API_Local() {
    modal_API_Local.style.display = "none";
}

