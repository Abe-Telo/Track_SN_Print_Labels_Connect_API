
function performSearch() {
    const input = document.getElementById('searchInput');
    const statusEl = document.getElementById('searchStatus');
    const table = document.getElementById('resultsTable');
    if (!input || !table) return;

    const searchTerm = (input.value || '').trim().toLowerCase();
    if (!searchTerm) {
        if (statusEl) statusEl.textContent = 'Enter a search term first.';
        table.innerHTML = '';
        return;
    }

    if (statusEl) statusEl.textContent = 'Searching...';

    fetch(`/search?term=${encodeURIComponent(searchTerm)}`)
        .then(response => {
            if (!response.ok) throw new Error('Search request failed (' + response.status + ')');
            return response.json();
        })
        .then(data => {
            displaySearchResults(Array.isArray(data) ? data : [], searchTerm);
            if (statusEl) {
                statusEl.textContent = data.length
                    ? `Found ${data.length} tracking record(s).`
                    : 'No matches. Try tracking #, serial #, model, order #, or notes.';
            }
        })
        .catch(error => {
            console.error('Error:', error);
            if (statusEl) statusEl.textContent = 'Search error: ' + error.message;
            table.innerHTML = '';
        });
}

function displaySearchResults(results, searchTerm) {
    const table = document.getElementById('resultsTable');
    table.innerHTML = '';

    const headerRow = table.insertRow();
    headerRow.innerHTML = '<th>Date</th><th>Tracking Number</th><th>Qty</th><th>Remaining</th><th>Source</th><th>Devices</th>';

    results.forEach(item => {
        const row = table.insertRow();
        row.insertCell().innerText = item.date || '';

        const trackingNumberCell = row.insertCell();
        const trackingNumberLink = document.createElement('a');
        trackingNumberLink.href = '#';
        trackingNumberLink.textContent = item.trackingNumber || '';
        trackingNumberLink.onclick = function (e) {
            e.preventDefault();
            showDeviceDetails(item.trackingNumber, !!item.isArchived);
        };
        trackingNumberCell.appendChild(trackingNumberLink);

        row.insertCell().innerText = item.quantity ?? '';
        row.insertCell().innerText = item.remaining ?? '';
        row.insertCell().innerText = item.isArchived ? 'Archived' : 'Active';

        const deviceInfoCell = row.insertCell();
        (item.devices || []).forEach(device => {
            const sn = device.serialNumber || '';
            const model = device.model || '';
            const order = device.OrderNumber || device.orderNumber || '';
            const deviceText = order
                ? `${sn} - ${model} (Order: ${order})`
                : `${sn} - ${model}`;

            const hay = (sn + ' ' + model + ' ' + order + ' ' + (device.notes || '') + ' ' + (device.sku || '')).toLowerCase();
            if (searchTerm && hay.includes(searchTerm)) {
                const highlighted = document.createElement('span');
                highlighted.style.backgroundColor = 'yellow';
                highlighted.textContent = deviceText;
                deviceInfoCell.appendChild(highlighted);
            } else {
                deviceInfoCell.appendChild(document.createTextNode(deviceText));
            }
            deviceInfoCell.appendChild(document.createElement('br'));
        });
    });
}

document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('searchButton');
    const input = document.getElementById('searchInput');
    if (btn) {
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            performSearch();
        });
    }
    if (input) {
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                performSearch();
            }
        });
    }
});
