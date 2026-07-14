// all_devices.js 
document.addEventListener("DOMContentLoaded", function() {
    let devices = [];

    function filterDevices() {
        const filterSerialNumber = document.getElementById('filterSerialNumber').value.toLowerCase();
        const filterModel = document.getElementById('filterModel').value.toLowerCase();
        const filterCpu = document.getElementById('filterCpu').value.toLowerCase();
        const filterRam = document.getElementById('filterRam').value.toLowerCase();
        const filterHd = document.getElementById('filterHd').value.toLowerCase();
        const filterWindowsVersion = document.getElementById('filterWindowsVersion').value.toLowerCase();
        const filterSku = document.getElementById('filterSku').value.toLowerCase();
        const filterNotes = document.getElementById('filterNotes').value.toLowerCase();
        const filterActivationStatus = document.getElementById('filterActivationStatus').value.toLowerCase();
		
		

        const filteredDevices = devices.filter(device => {
            return device.serialNumber.toLowerCase().includes(filterSerialNumber) &&
                   device.model.toLowerCase().includes(filterModel) &&
                   device.cpu.toLowerCase().includes(filterCpu) &&
                   device.ram.toString().toLowerCase().includes(filterRam) &&
                   device.hd.toString().toLowerCase().includes(filterHd) &&
                   device.windowsVersion.toLowerCase().includes(filterWindowsVersion) &&
                   device.sku.toLowerCase().includes(filterSku) &&
                   device.notes.toLowerCase().includes(filterNotes) &&
                   device.activationStatus.toLowerCase().includes(filterActivationStatus);
        });

        populateTable(filteredDevices);
    }

function populateTable(deviceList) {
	
		    console.log('Populating table with device data');
    const tableBody = document.getElementById('devicesTable').getElementsByTagName('tbody')[0];
    tableBody.innerHTML = '';
    deviceList.forEach(device => {
        let row = tableBody.insertRow();
        row.insertCell().textContent = device.serialNumber;
        row.insertCell().textContent = device.model;
        row.insertCell().textContent = device.cpu;
        row.insertCell().textContent = device.ram;
        row.insertCell().textContent = device.hd;
        row.insertCell().textContent = device.windowsVersion;
        //row.insertCell().textContent = device.sku;
        row.insertCell().textContent = device.notes;
        //row.insertCell().textContent = device.activationStatus;

        // OrderNumber cell 
        const orderNumberCell = row.insertCell();
        const inputBox = document.createElement('input');
        inputBox.type = 'text';
        inputBox.value = device.OrderNumber ? device.OrderNumber : '';
        inputBox.disabled = !!device.OrderNumber;

        //const actionButton = document.createElement('button');
        //const actionIcon = document.createElement('img'); // Create an img element
        //actionIcon.src = device.OrderNumber ? 'edit.png' : 'save.png'; // Set the source of the image
		
		
        const actionButton = document.createElement('button');
        actionButton.style.border = 'none';
        actionButton.style.padding = '0';
        actionButton.style.background = 'none';

        const actionIcon = document.createElement('img');
        actionIcon.src = device.OrderNumber ? 'edit.png' : 'save.png';
        actionIcon.style.display = 'block';
        actionIcon.style.width = '16px';
        actionIcon.style.height = '16px';

        actionButton.appendChild(actionIcon);
        actionButton.appendChild(actionIcon); // Append the img element to the button

        actionButton.onclick = function() {
            if (inputBox.disabled) {
                inputBox.disabled = false;
                actionIcon.src = 'save.png'; // Change icon to save
            } else {
                updateDeviceDetails(device.serialNumber, inputBox.value);
                inputBox.disabled = true;
                actionIcon.src = 'edit.png'; // Change icon to edit
            }
        };
		
// Trash Button
const trashButton = document.createElement('button');
trashButton.style.border = 'none';
trashButton.style.padding = '0';
trashButton.style.background = 'none';
trashButton.style.marginLeft = '5px'; // Add some space between buttons

const trashIcon = document.createElement('img');
trashIcon.src = 'trash.png';
trashIcon.style.display = 'block';
trashIcon.style.width = '16px';
trashIcon.style.height = '16px';

trashButton.appendChild(trashIcon);

trashButton.onclick = function() {
    if (confirm(`Are you sure you want to delete the device with serial number ${device.serialNumber}?`)) {
        fetch(`/delete_single_device/${encodeURIComponent(device.serialNumber)}`, {
            method: 'DELETE'
        })
        .then(response => {
            if (response.ok) {
                console.log('Device deleted successfully');
                // Optionally, refresh the device list or remove the row from the table
            } else {
                console.error('Failed to delete the device');
            }
        })
        .catch(error => console.error('Error:', error));
    }
};

orderNumberCell.appendChild(inputBox);
orderNumberCell.appendChild(actionButton);
orderNumberCell.appendChild(trashButton); // Append the trash button next to the action button

    });
}
/*            // OrderNumber cell
            const orderNumberCell = row.insertCell();
            const inputBox = document.createElement('input');
            inputBox.type = 'text';
            inputBox.value = device.OrderNumber ? device.OrderNumber : '';
            inputBox.disabled = !!device.OrderNumber;

            const actionButton = document.createElement('button');
            actionButton.innerText = device.OrderNumber ? 'Edit' : 'Save';

            actionButton.onclick = function() {
                if (actionButton.innerText === 'Edit') {
                    inputBox.disabled = false;
                    actionButton.innerText = 'Save';
                } else {
                    updateDeviceDetails(device.serialNumber, inputBox.value);
                    inputBox.disabled = true;
                    actionButton.innerText = 'Edit';
                }
            };

            orderNumberCell.appendChild(inputBox);
            orderNumberCell.appendChild(actionButton);
        });
    }
*/
    // Fetch devices and populate table
    fetch('/list-all-devices')
        .then(response => response.json())
        .then(data => {
            devices = data;
            populateTable(devices);
        })
        .catch(error => console.error('Error:', error));
 
    // Event listeners for each filter
    document.getElementById('filterSerialNumber').addEventListener('input', filterDevices);
    document.getElementById('filterModel').addEventListener('input', filterDevices);
    document.getElementById('filterCpu').addEventListener('input', filterDevices);
    document.getElementById('filterRam').addEventListener('input', filterDevices);
    document.getElementById('filterHd').addEventListener('input', filterDevices);
    document.getElementById('filterWindowsVersion').addEventListener('input', filterDevices);
    document.getElementById('filterSku').addEventListener('input', filterDevices);
    document.getElementById('filterNotes').addEventListener('input', filterDevices);
    document.getElementById('filterActivationStatus').addEventListener('input', filterDevices);
});

 

    function updateDeviceDetails(serialNumber, orderNumber) {
        console.log(`Attempting to update device ${serialNumber} with order number ${orderNumber}`);
        fetch(`/update-device-details/${encodeURIComponent(serialNumber)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ OrderNumber: orderNumber })
        })
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.json(); // Assuming the server sends back JSON
        })
        .then(data => {
            console.log('Device updated successfully:', data);
            // Refresh the table to reflect the updated data
            filterDevices(); // Call filterDevices to refresh the table
        })
        .catch(error => {
            console.error('Error updating device:', error);
        });
    }







	
/*

    // Fetch the device data and populate the table
    fetch('/list-all-devices')
        .then(response => response.json())
        .then(data => {
            devices = data; // Store the original data
            populateTable(devices); // Populate table with original data
        })
        .catch(error => console.error('Error:', error));

    // Add event listeners for filter inputs
    document.getElementById('filterSerialNumber').addEventListener('input', filterDevices);
    // Add more event listeners for additional filters
});


    // Fetch the device data and populate the table
    fetch('/list-all-devices')
        .then(response => response.json())
        .then(devices => {
            const tableBody = document.getElementById('devicesTable').getElementsByTagName('tbody')[0];
            devices.forEach(device => {
                let row = tableBody.insertRow();
                row.insertCell().textContent = device.serialNumber;
                row.insertCell().textContent = device.model;
                row.insertCell().textContent = device.cpu;
                row.insertCell().textContent = device.ram;
                row.insertCell().textContent = device.hd;
                row.insertCell().textContent = device.windowsVersion;
                row.insertCell().textContent = device.sku;
                row.insertCell().textContent = device.notes;
                row.insertCell().textContent = device.activationStatus;
            });
        })
        .catch(error => console.error('Error:', error));
});
*/  