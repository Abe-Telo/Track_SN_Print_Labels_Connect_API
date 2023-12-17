// add.tracking.info.js  <script src="js/add.tracking.info.js"></script>


// Adding tracking number
document.addEventListener("DOMContentLoaded", function() {
    document.getElementById("trackingForm").addEventListener("submit", function(e) {
        e.preventDefault();
        const formData = new FormData(this);

        fetch('/add-tracking', {
            method: 'POST',
            body: formData
        })
        .then(response => response.text())
        .then(data => {
            document.getElementById('log').textContent = 'Tracking data added successfully';
            fetchAndDisplayTrackingData();
            fetchPastWeekTrackingData();
        })
        .catch(error => {
            console.error('Error:', error);
            document.getElementById('log').textContent = 'Error adding tracking data';
        });
    });

    // Initialize data display on page load
    fetchAndDisplayTrackingData();
    fetchPastWeekTrackingData();
});

// Fetch and display tracking data
        function fetchAndDisplayTrackingData() {
            fetch('/get-tracking-data')
            .then(response => response.json())
            .then(data => {
                const table = document.getElementById('trackingTable');
                table.innerHTML = '<tr><th>Select</th><th>Date</th><th>Tracking Number</th><th>Quantity</th><th>Repairing</th></tr>';
        
                data.forEach(item => {
                    const row = table.insertRow();
                    const checkboxCell = row.insertCell();
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.setAttribute('data-tracking-number', item.trackingNumber);
                    checkboxCell.appendChild(checkbox);

                    row.insertCell().innerText = item.date;
			
                    //row.insertCell().innerText = item.trackingNumber;
                    const trackingNumberCell = row.insertCell();
                    const trackingNumberLink = document.createElement('a');
                    trackingNumberLink.href = '#';
                    trackingNumberLink.textContent = item.trackingNumber;
                    trackingNumberLink.onclick = function() { showDeviceDetails(item.trackingNumber); };
                    trackingNumberCell.appendChild(trackingNumberLink);
			
                    const quantityCell = row.insertCell();
                    const quantityInput = document.createElement('input');
                    quantityInput.type = 'number';
                    quantityInput.value = item.quantity;
                    quantityInput.disabled = false; // Make the quantity input read-only
                    quantityCell.appendChild(quantityInput);
            
                    const remainingCell = row.insertCell();
                    const remainingInput = document.createElement('input');
                    remainingInput.type = 'number';
                    remainingInput.value = item.remaining;
                    remainingInput.disabled = false; // Make the remaining input read-only
                    remainingCell.appendChild(remainingInput);
			 
                });
            })
            .catch(error => console.error('Failed to fetch tracking data:', error));
        }

// Fetch and display past week's tracking data
function fetchPastWeekTrackingData() {
    fetch('/past-week-tracking-data')
    .then(response => response.json())
    .then(data => {
        const table = document.getElementById('pastWeekTable');
        table.innerHTML = '<tr><th>Date</th><th>Tracking Number</th><th>Quantity</th><th>Remaining</th></tr>'; // Table headers

        data.forEach(item => {
            const row = table.insertRow();

            // Date
            row.insertCell().innerText = item.date;
            
            // Tracking Number
            const trackingNumberCell = row.insertCell();
            const trackingNumberLink = document.createElement('a');
            trackingNumberLink.href = '#';
            trackingNumberLink.textContent = item.trackingNumber;
            trackingNumberLink.classList.add('trackingNumber');
            //trackingNumberLink.addEventListener('click', () => showDeviceDetails(item.trackingNumber));
			trackingNumberLink.addEventListener('click', () => showDeviceDetails(item.trackingNumber, true));
            trackingNumberCell.appendChild(trackingNumberLink);
            
            // Quantity
            row.insertCell().innerText = item.quantity;

            // Remaining
            row.insertCell().innerText = item.remaining;
        });
    })
    .catch(error => console.error('Failed to fetch past week tracking data:', error));
}

// Update quantities
function updateQuantities() {
    const allRows = document.querySelectorAll('#trackingTable tr:not(:first-child)');
    allRows.forEach(row => {
        const trackingNumber = row.cells[2].innerText;
        const newQuantity = row.cells[3].querySelector('input').value;
        const newRemaining = row.cells[4].querySelector('input').value;

        fetch('/update-quantityWEB', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ trackingNumber, newQuantity })
        })
        .then(response => response.text())
        .then(data => {
            console.log('Quantity updated:', data);
            return fetch('/update-remainingWEB', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
               // body: JSON.stringify({ trackingNumber, newRemaining })
				body: JSON.stringify({ trackingNumber, newQuantity: newRemaining })
            });
        })
        .then(response => response.text())
        .then(data => {
            console.log('Remaining updated:', data);
            document.getElementById('log').textContent = 'Quantities and remaining updated successfully';
            // Refresh the display
            fetchAndDisplayTrackingData();
            fetchPastWeekTrackingData(); // Refresh the table for past week's entries if necessary
        })
        .catch(error => {
            console.error('Error:', error);
            document.getElementById('log').textContent = 'Error updating quantities and remaining';
        });
    });
}

		

            function deleteSelected() {
                var checkboxes = document.querySelectorAll('input[type="checkbox"]:checked');
                var trackingNumbersToDelete = Array.from(checkboxes).map(cb => cb.getAttribute('data-tracking-number'));

                fetch('/delete-tracking', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ trackingNumbersToDelete })
                })
                .then(response => response.text())
                .then(data => {
                    document.getElementById('log').textContent = 'Selected entries deleted successfully';
                    fetchAndDisplayTrackingData(); // Refresh the table
                    fetchPastWeekTrackingData(); // Refresh the table
                })
                .catch(error => console.error('Error:', error));
            }

// Event listeners for delete and save buttons
document.addEventListener("DOMContentLoaded", function() {
    const deleteButton = document.getElementById("deleteButton");
    if (deleteButton) {
        deleteButton.addEventListener("click", deleteSelected);
    }

    const saveButton = document.getElementById("saveButton");
    if (saveButton) {
        saveButton.addEventListener("click", updateQuantities);
    }
});
