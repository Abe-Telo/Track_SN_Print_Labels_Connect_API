


 


    //    document.addEventListener("DOMContentLoaded", function() {
     //       fetchArchiveTrackingData();
     //   });

        function fetchArchiveTrackingData() {
            fetch('/archived-tracking-data')
            .then(response => response.json())
            .then(data => {
                const table = document.getElementById('archiveTable');
                table.innerHTML = '<tr><th>Date</th><th>Tracking Number</th><th>Quantity</th><th>Remaining</th></tr>';

                data.forEach(item => {
                    const row = table.insertRow();

                    row.insertCell().innerText = item.date;

                    const trackingNumberCell = row.insertCell();
                    const trackingNumberLink = document.createElement('a');
                    trackingNumberLink.href = '#';
                    trackingNumberLink.textContent = item.trackingNumber;
                    trackingNumberLink.onclick = function() { showDeviceDetails(item.trackingNumber, true); };
                    trackingNumberCell.appendChild(trackingNumberLink);

                    row.insertCell().innerText = item.quantity;
                    row.insertCell().innerText = item.remaining;
                });
            })
            .catch(error => console.error('Failed to fetch archived tracking data:', error));
        }
		fetchArchiveTrackingData();

 
        function closeModal() {
            document.getElementById('deviceDetailsModal').style.display = 'none';
        }

        document.getElementById('closeModal').addEventListener('click', closeModal);
    
	
 

// Expose the initialize function to the global scope
 