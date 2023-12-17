document.addEventListener("DOMContentLoaded", function() {
    if (document.getElementById('searchButton') && document.getElementById('searchInput')) {
        document.getElementById('searchButton').addEventListener('click', function() { 
            const searchTerm = document.getElementById('searchInput').value.toLowerCase(); 

            fetch(`/search?term=${encodeURIComponent(searchTerm)}`)
                .then(response => response.json())
                .then(data => {
                    displaySearchResults(data, searchTerm);
                })
                .catch(error => {
                    console.error('Error:', error);
                });
        });
    }
});

function displaySearchResults(results, searchTerm) {
    const table = document.getElementById('resultsTable');
    table.innerHTML = '';

    // Create table headers
    const headerRow = table.insertRow();
    headerRow.innerHTML = `<th>Date</th><th>Tracking Number</th><th>Quantity</th><th>Remaining</th><th>Devices</th>`;

    // Populate table rows with search results
    results.forEach(item => {
        const row = table.insertRow();
        const trackingNumberCell = document.createElement('td');
        const trackingNumberLink = document.createElement('a');
        trackingNumberLink.href = '#';
        trackingNumberLink.textContent = item.trackingNumber;
        trackingNumberLink.onclick = function() { showDeviceDetails(item.trackingNumber, item.isArchived); };
        trackingNumberCell.appendChild(trackingNumberLink);
        row.appendChild(trackingNumberCell);

        row.insertCell().innerText = item.date;
        row.insertCell().innerText = item.quantity;
        row.insertCell().innerText = item.remaining;

        const deviceInfoCell = document.createElement('td');
        item.devices.forEach(device => {
            const deviceText = `${device.serialNumber} - ${device.model}`;
            if (device.serialNumber.toLowerCase().includes(searchTerm) || device.model.toLowerCase().includes(searchTerm)) {
                const highlighted = document.createElement('span');
                highlighted.style.backgroundColor = 'yellow';
                highlighted.textContent = deviceText;
                deviceInfoCell.appendChild(highlighted);
            } else {
                deviceInfoCell.appendChild(document.createTextNode(deviceText));
            }
            deviceInfoCell.appendChild(document.createElement('br'));
        });

        row.appendChild(deviceInfoCell);
    });
}




/*
function displaySearchResults(results, searchTerm) {
    const table = document.getElementById('resultsTable');
    table.innerHTML = '';

    // Create table headers
    const headerRow = table.insertRow();
    headerRow.innerHTML = `<th>Date</th><th>Tracking Number</th><th>Quantity</th><th>Remaining</th><th>Devices</th>`;

    // Define a function to populate table rows
    function populateRows(items, isArchived) {
        items.forEach(item => {
            const row = table.insertRow();
            const trackingNumberCell = document.createElement('td');
            const trackingNumberLink = document.createElement('a');
            trackingNumberLink.href = '#';
            trackingNumberLink.textContent = item.trackingNumber;
            trackingNumberLink.onclick = function() { showDeviceDetails(item.trackingNumber, isArchived); };
            trackingNumberCell.appendChild(trackingNumberLink);
            row.appendChild(trackingNumberCell);

            row.insertCell().innerText = item.date;
            row.insertCell().innerText = item.quantity;
            row.insertCell().innerText = item.remaining;

            const deviceInfoCell = document.createElement('td');
            item.devices.forEach(device => {
                const deviceText = `${device.serialNumber} - ${device.model}`;
                if (device.serialNumber.toLowerCase().includes(searchTerm) || device.model.toLowerCase().includes(searchTerm)) {
                    const highlighted = document.createElement('span');
                    highlighted.style.backgroundColor = 'yellow';
                    highlighted.textContent = deviceText;
                    deviceInfoCell.appendChild(highlighted);
                } else {
                    deviceInfoCell.appendChild(document.createTextNode(deviceText));
                }
                deviceInfoCell.appendChild(document.createElement('br'));
            });

            row.appendChild(deviceInfoCell);
        });
    }

    // Separate the results into archived and non-archived
    const nonArchivedItems = results.filter(item => !item.isArchived);
    const archivedItems = results.filter(item => item.isArchived);

    // Populate rows for non-archived items
    populateRows(nonArchivedItems, false);
    //populateRows(nonArchivedItems, true);

    // Populate rows for archived items
    populateRows(archivedItems, true);
}

*/