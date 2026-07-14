/* All Tracking (archive) — list, search, filter, sort, pagination */
(function () {
  let archiveData = [];
  let filteredRows = [];
  let currentPage = 1;

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function getPageSize() {
    const val = document.getElementById('archivePageSize')?.value || '500';
    if (val === 'all') return Infinity;
    return parseInt(val, 10) || 500;
  }

  function deviceHaystack(item) {
    const parts = [item.trackingNumber || '', item.date || ''];
    (item.devices || []).forEach((d) => {
      parts.push(
        d.serialNumber || '',
        d.model || '',
        d.notes || '',
        d.sku || '',
        d.OrderNumber || d.orderNumber || ''
      );
    });
    return parts.join(' ').toLowerCase();
  }

  function applyArchiveFilters(resetPage = true) {
    const table = document.getElementById('archiveTable');
    if (!table) return;

    if (resetPage) currentPage = 1;

    const term = (document.getElementById('archiveSearch')?.value || '').trim().toLowerCase();
    const fromVal = document.getElementById('archiveDateFrom')?.value || '';
    const toVal = document.getElementById('archiveDateTo')?.value || '';
    const sortVal = document.getElementById('archiveSort')?.value || 'date_desc';

    filteredRows = archiveData.filter((item) => {
      if (term && !deviceHaystack(item).includes(term)) return false;
      if (fromVal && (item.date || '') < fromVal) return false;
      if (toVal && (item.date || '') > toVal) return false;
      return true;
    });

    const byDate = (a, b) => new Date(a.date || 0) - new Date(b.date || 0);
    if (sortVal === 'date_desc') filteredRows.sort((a, b) => byDate(b, a));
    else if (sortVal === 'date_asc') filteredRows.sort(byDate);
    else if (sortVal === 'qty_desc') filteredRows.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    else if (sortVal === 'qty_asc') filteredRows.sort((a, b) => (a.quantity || 0) - (b.quantity || 0));
    else if (sortVal === 'tn_asc') filteredRows.sort((a, b) => String(a.trackingNumber || '').localeCompare(String(b.trackingNumber || '')));

    renderCurrentPage(term);
  }

  function renderCurrentPage(term) {
    const statusEl = document.getElementById('archiveStatus');
    const pageSize = getPageSize();
    const total = filteredRows.length;
    const totalPages = pageSize === Infinity ? 1 : Math.max(1, Math.ceil(total / pageSize));

    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const start = pageSize === Infinity ? 0 : (currentPage - 1) * pageSize;
    const end = pageSize === Infinity ? total : Math.min(start + pageSize, total);
    const pageRows = filteredRows.slice(start, end);

    renderArchiveRows(pageRows, term || (document.getElementById('archiveSearch')?.value || '').trim().toLowerCase());

    if (statusEl) {
      if (total === 0) {
        statusEl.textContent = 'No matching records. Try clearing filters.';
      } else if (pageSize === Infinity) {
        statusEl.textContent = `Showing all ${total} matching record(s) — ${archiveData.length} total.`;
      } else {
        statusEl.textContent = `Showing ${start + 1}–${end} of ${total} matching record(s) — ${archiveData.length} total.`;
      }
    }

    const pager = document.getElementById('archivePager');
    const info = document.getElementById('archivePageInfo');
    const prev = document.getElementById('archivePrevPage');
    const next = document.getElementById('archiveNextPage');
    if (pager) {
      if (pageSize === Infinity || totalPages <= 1) {
        pager.style.display = 'none';
      } else {
        pager.style.display = 'flex';
        if (info) info.textContent = `Page ${currentPage} of ${totalPages}`;
        if (prev) prev.disabled = currentPage <= 1;
        if (next) next.disabled = currentPage >= totalPages;
      }
    }
  }

  function renderArchiveRows(rows, term) {
    const table = document.getElementById('archiveTable');
    table.innerHTML = '<tr><th>Date</th><th>Tracking Number</th><th>Quantity</th><th>Remaining</th><th>Devices</th></tr>';

    rows.forEach((item) => {
      const row = table.insertRow();
      row.insertCell().innerText = item.date || '';

      const trackingNumberCell = row.insertCell();
      const trackingNumberLink = document.createElement('a');
      trackingNumberLink.href = '#';
      trackingNumberLink.textContent = item.trackingNumber || '';
      trackingNumberLink.onclick = function (e) {
        e.preventDefault();
        showDeviceDetails(item.trackingNumber, true);
      };
      trackingNumberCell.appendChild(trackingNumberLink);

      row.insertCell().innerText = item.quantity ?? '';
      row.insertCell().innerText = item.remaining ?? '';

      const devCell = row.insertCell();
      const devices = item.devices || [];
      const preview = devices.slice(0, 3);
      preview.forEach((d) => {
        const text = `${d.serialNumber || ''} — ${d.model || ''}`;
        const hay = (String(d.serialNumber || '') + ' ' + String(d.model || '') + ' ' + String(d.notes || '') + ' ' + String(d.OrderNumber || d.orderNumber || '')).toLowerCase();
        if (term && hay.includes(term)) {
          const mark = document.createElement('span');
          mark.style.backgroundColor = 'yellow';
          mark.textContent = text;
          devCell.appendChild(mark);
        } else {
          devCell.appendChild(document.createTextNode(text));
        }
        devCell.appendChild(document.createElement('br'));
      });
      if (devices.length > 3) {
        const more = document.createElement('span');
        more.style.color = '#64748b';
        more.textContent = `+${devices.length - 3} more device(s)`;
        devCell.appendChild(more);
      }
    });
  }

  function wireArchiveFilters() {
    const search = document.getElementById('archiveSearch');
    const from = document.getElementById('archiveDateFrom');
    const to = document.getElementById('archiveDateTo');
    const sort = document.getElementById('archiveSort');
    const pageSize = document.getElementById('archivePageSize');
    const clear = document.getElementById('archiveClearFilters');
    const prev = document.getElementById('archivePrevPage');
    const next = document.getElementById('archiveNextPage');

    if (search) search.addEventListener('input', debounce(() => applyArchiveFilters(true), 200));
    if (from) from.addEventListener('change', () => applyArchiveFilters(true));
    if (to) to.addEventListener('change', () => applyArchiveFilters(true));
    if (sort) sort.addEventListener('change', () => applyArchiveFilters(true));
    if (pageSize) pageSize.addEventListener('change', () => { currentPage = 1; renderCurrentPage(); });
    if (clear) {
      clear.addEventListener('click', function () {
        if (search) search.value = '';
        if (from) from.value = '';
        if (to) to.value = '';
        if (sort) sort.value = 'date_desc';
        if (pageSize) pageSize.value = '500';
        applyArchiveFilters(true);
      });
    }
    if (prev) prev.addEventListener('click', function () { currentPage -= 1; renderCurrentPage(); });
    if (next) next.addEventListener('click', function () { currentPage += 1; renderCurrentPage(); });
  }

  function fetchArchiveTrackingData() {
    const table = document.getElementById('archiveTable');
    const statusEl = document.getElementById('archiveStatus');
    if (!table) {
      console.warn('archiveTable not found yet');
      return;
    }

    if (statusEl) statusEl.textContent = 'Loading archived tracking…';

    fetch('/archived-tracking-data')
      .then((response) => {
        if (!response.ok) throw new Error('Failed to load archived data (' + response.status + ')');
        return response.json();
      })
      .then((data) => {
        archiveData = Array.isArray(data) ? data : [];
        wireArchiveFilters();
        applyArchiveFilters(true);
      })
      .catch((error) => {
        console.error('Failed to fetch archived tracking data:', error);
        if (statusEl) statusEl.textContent = 'Error: ' + error.message;
      });
  }

  // Expose for shell.js to call after HTML is injected
  window.fetchArchiveTrackingData = fetchArchiveTrackingData;
})();
