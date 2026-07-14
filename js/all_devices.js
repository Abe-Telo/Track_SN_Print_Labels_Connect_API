// all_devices.js 
let refreshDeviceListCallback = null; // Add this at the top of the file

document.addEventListener("DOMContentLoaded", function() {
	
 
	
    let devices = [];
let dataTracking = {};

function fetchAndProcessArchiveData() {
    Promise.all([
        fetch('/archived-tracking-data').then(response => response.json()),
        fetch('/get-tracking-data').then(response => response.json())
    ])
    .then(([archivedData, trackingData]) => {
        // Process archived data
        archivedData.forEach(item => {
            item.devices.forEach(device => {
                //dataTracking[device.serialNumber] = item.date;

                    dataTracking[device.serialNumber] = {
                        date: item.date,
                        trackingNumber: item.trackingNumber,
                        quantity: item.quantity,
                        remaining: item.remaining,
                        status: item.status				
				 }; 
            });
        });

        // Process tracking data
        // Assuming trackingData has a similar structure to archivedData
        trackingData.forEach(item => {
            item.devices.forEach(device => {
                // This will overwrite the date if the device is in both archived and tracking data
                //dataTracking[device.serialNumber] = item.date;
				
				      dataTracking[device.serialNumber] = {
                        date: item.date,
                        trackingNumber: item.trackingNumber,
                        quantity: item.quantity,
                        remaining: item.remaining,
                        status: item.status				
				 };
				
            });
        });

        // Once the dataTracking is ready, fetch and display the devices
        fetchAndDisplayDevices();
    })
    .catch(error => console.error('Failed to fetch tracking and archived tracking data:', error));
}

function fetchAndDisplayDevices() {
    fetch('/list-all-devices')
    .then(response => response.json())
    .then(devices => {
        populateTable(devices);
    })
    .catch(error => console.error('Error fetching devices:', error));
}

// Call this function when the page loads
fetchAndProcessArchiveData();


function filterDevices() {
    const filterSerialNumber = document.getElementById('filterSerialNumber').value.toLowerCase();
    const filterModel = document.getElementById('filterModel').value.toLowerCase();
    const filterSku = document.getElementById('filterSku').value.toLowerCase();
    const filterWindowsVersion = document.getElementById('filterWindowsVersion').value.toLowerCase();
	
    const filterCpu = document.getElementById('filterCpu').value.toLowerCase();
    const filterRam = document.getElementById('filterRam').value.toLowerCase();
    const filterHd = document.getElementById('filterHd').value.toLowerCase();
	
    const filterTracking = document.getElementById('filterTracking').value.toLowerCase();
    //const filterTrackingDate = document.getElementById('filterTrackingDate').value.toLowerCase();
    //const filterQuantity = document.getElementById('filterQuantity').value.toLowerCase();
	
    //const filterWarehouseInfo = document.getElementById('filterWarehouseInfo').value.toLowerCase();
    //const filterorderStatus = document.getElementById('filterorderStatus').value.toLowerCase();
    //const filterShipstaionNotes = document.getElementById('filterShipstaionNotes').value.toLowerCase();
	
    const filterNameCompany = document.getElementById('filterNameCompany').value.toLowerCase();
    const filterAddress = document.getElementById('filterAddress').value.toLowerCase();
    const filterPhone = document.getElementById('filterPhone').value.toLowerCase();
	
    //const filterSku = document.getElementById('filterSku').value.toLowerCase();
    const filterNotes = document.getElementById('filterNotes').value.toLowerCase();
    const filterActivationStatus = document.getElementById('filterActivationStatus').value.toLowerCase();
    const filterOrderstatus = document.getElementById('filterOrderstatus').value.toLowerCase();
    const filterOrderNumber = document.getElementById('filterOrderNumber').value.toLowerCase();

    const filteredDevices = devices.filter(device => {
		       // let phoneStr = device.phone ? device.phone.toString().toLowerCase() : '';


		// Handle undefined or missing fields with || '' fallback
		let combinedNameCompany = [
            device.name ? `N: ${device.name}` : '', 
            device.company ? `C: ${device.company}` : ''
		].filter(Boolean).join(', ').toLowerCase(); // Join with a comma and space, then convert to lowercase

		let combinedAddress = [ 
            device.street1,
            device.street2,
            device.city,
            device.state,
            device.postalCode,
            (device.residential === true) ? "Residential" : (device.residential === false) ? "Business" : ""
        ].filter(Boolean).join(', ').toLowerCase();

		const trackingInfo = dataTracking[device.serialNumber];
        let trackingText = trackingInfo ? trackingInfo.trackingNumber.toLowerCase() : '';



        return device.serialNumber?.toLowerCase().includes(filterSerialNumber) &&
               device.model?.toLowerCase().includes(filterModel) &&
               device.sku?.toLowerCase().includes(filterSku) &&
               device.windowsVersion?.toLowerCase().includes(filterWindowsVersion) &&
			   
               device.cpu?.toLowerCase().includes(filterCpu) &&
               device.ram?.toString().toLowerCase().includes(filterRam) &&
               device.hd?.toString().toLowerCase().includes(filterHd) &&
			   
               
			   trackingText.includes(filterTracking) &&
			   //device.trackingInfo.toString().toLowerCase().includes(filterTracking) &&
			   //(device.trackingInfo ? device.trackingInfo.toLowerCase().includes(filterTracking) : filterTracking === '') &&
               //device.trackingDate.toString().toLowerCase().includes(filterTrackingDate) &&
               //device.quantity.toString().toLowerCase().includes(filterQuantity) &&
			   
               //device.warehouseInfo.toString().toLowerCase().includes(filterWarehouseInfo) &&
               //device.hd.toString().toLowerCase().includes(filterorderStatus) &&
               //device.shipstaionNotes.toString().toLowerCase().includes(filterShipstaionNotes) &&
			   
               combinedNameCompany.toString().toLowerCase().includes(filterNameCompany) &&
               //device.address.toString().toLowerCase().includes(filterAddress) &&
			   combinedAddress.includes(filterAddress) &&
               //(device.combinedAddress?.toLowerCase().includes(filterAddress) || filterAddress === '') &&
               (device.phone?.toLowerCase().includes(filterPhone) || filterPhone === '') &&
			   
               //device.sku?.toLowerCase().includes(filterSku) &&
               device.notes?.toLowerCase().includes(filterNotes) &&
               device.activationStatus?.toLowerCase().includes(filterActivationStatus) &&
               (device.orderstatus ? device.orderstatus.toLowerCase().includes(filterOrderstatus) : filterOrderstatus === '') &&
               (device.OrderNumber ? device.OrderNumber.toLowerCase().includes(filterOrderNumber) : filterOrderNumber === '');
    });
        populateTable(filteredDevices);
}


// Add this function to collect order numbers and send the update request
function BulkUpdateDeviceShippingStatusToLocalDB() {
    const orderNumbers = devices
        .filter(device => device.OrderNumber && device.OrderNumber.trim() !== '') // Filter out devices without a valid order number
        .map(device => device.OrderNumber); // Extract the order numbers

    if (orderNumbers.length === 0) {
        console.log("No order numbers to update.");
        return;
    }


    fetch('/bulk-update-local-shipping-status', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ orderNumbers })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error('Failed to update local shipping status');
        }
        return response.json();
    })
    .then(data => {
        console.log("Local shipping status updated:", data);
        if (refreshDeviceListCallback) {
            refreshDeviceListCallback(); // Refresh the device list
        }
    })
    .catch(error => {
        console.error("Error in bulk updating shipping status:", error);
    });
}

// Add a callback function to refresh the device list
refreshDeviceListCallback = function() {
    // Fetch updated device list
    fetch('/list-all-devices')
    .then(response => response.json())
    .then(data => {
		console.log(data); // Log the data to inspect its structure
        devices = data; // Update local device list
        populateTable(devices); // Re-populate the table with updated data
    })
    .catch(error => console.error('Error fetching updated devices:', error));
};

function populateTable(deviceList) {

deviceList.reverse();

    // Heading
    const totalDevices = deviceList.length;// Calculate the total number of devices
    const heading = document.getElementById('allDevicesHeading');// Update the heading with the total number of devices
    heading.textContent = `All Devices (${totalDevices})`;// Update the heading with the total number of devices
	
    const tableBody = document.getElementById('devicesTable').getElementsByTagName('tbody')[0];
    tableBody.innerHTML = '';
	
	//const table = document.getElementById('devicesTable');
    //tableBody.style.backgroundColor = 'white';
	
    //deviceList.forEach(device => {
	deviceList.forEach((device, index) => { 	
        let row = tableBody.insertRow(); 

       // Alternate row colors
        //row.style.backgroundColor = index % 2 === 0 ? '#f2f2f2' : '#ffffff';

        // Set background color based on the row index
        //row.style.backgroundColor = index % 2 === 0 ? 'blue' : 'red'; // Light gray for even, white for odd
        //  row.style.backgroundColor = index % 2 === 0 ? '#f2f2f2' : '#ffffff'; // Blue for even, red for odd
		

		
         // Check if the device's serial number is in the dataTracking
        const trackingInfo = dataTracking[device.serialNumber]; // Root Array
        // Row for Serial Number 
		
		// Assuming device data includes tracking number and date
        //let trackingCell = row.insertCell();
        //trackingCell.textContent = device.trackingNumber || 'Not Available';

        // Add a cell for the date using the dataTracking
        //let dateCell = row.insertCell();
        //dateCell.textContent = dataTracking[device.serialNumber] || 'Date Not Available';
		//dateCell.textContent = dataTracking.date || 'Date Not Available';

        // Add a new cell for tracking number
		//let trackingCell = row.insertCell();
        //trackingCell.textContent = device.trackingNumber || 'Not Available'; 
		//const trackingNumberInput = document.getElementById("trackingNumber");
        //const trackingNumber = trackingNumberInput.value.trim();
        //let trackingCell = row.insertCell();
        //trackingCell.textContent = device.trackingNumber; // Assuming each device has a `trackingNumber` property

		//let dateCell = row.insertCell(); // Working on this. Not yet working
        //dateCell.textContent = device.date; // Display the date
		
        // Serial Number Cell
        //let serialCell = row.insertCell();
        //serialCell.textContent = device.serialNumber || '';
		
        // Cell for Serial Number, Order Status, and Date
        //let serialOrderCell = row.insertCell();

		
		
		
		
        let serialText = device.serialNumber ? `${device.serialNumber}` : "";
        let orderStatusText = device.orderstatus ? `${device.orderstatus}` : "";
        let trackingText = trackingInfo ? trackingInfo.trackingNumber : 'NO Tracking';


/*
//serialOrderCell.innerHTML = `<span style="display: block; background-color: #f0f0f0;">${serialText} - ${dateText}</span>
//                             <span style="display: block; background-color: #d3d3d3;">${orderStatusText}</span>`;


   // if (serialOrderCell = serialOrderCell) {
    //    serialOrderCell.style.backgroundColor = '#ff0000'; // Red background
        //someCell.style.color = '#ffffff'; // White text
   // }


        // Add a cell for the date
        //let dateCell = row.insertCell();
        //dateCell.textContent = trackingInfo ? trackingInfo.date : 'Date Not Available';

        // Add a cell for the tracking number (if needed)
        //let trackingNumberCell = row.insertCell();
        //trackingNumberCell.textContent = trackingInfo ? trackingInfo.trackingNumber : 'Tracking Number Not Available';






        //let serialOrderCell = row.insertCell();
        //serialOrderCell.innerHTML = `${device.serialNumber}<br>${device.orderstatus}`;
        //serialOrderCell.innerHTML = `${device.serialNumber} <br> Order Status: ${device.orderstatus}`;
		//row.insertCell().textContent = device.serialNumber;
	    //row.insertCell().textContent = device.orderstatus; 
		*/
/*
	createMiniTable(
        row,
        device.model ? device.model : '',
        device.warehouseName ? device.warehouseName : '',
        device.warehouseCompany ? device.warehouseCompany : '',
        '#f0f0f0',
        '#d3d3d3',
        '#e6e6e6'
    );
*/		
        // Cell for Model, Warehouse Name, and Warehouse Company
        //let modelWarehouseCell = row.insertCell();
        let skuText = device.sku ? `${device.sku}` : "";
        let modelText = device.model ? `${device.model}` : "";
        let warehouseNameText = device.warehouseName ? `${device.warehouseName}` : "";
        let warehouseCompanyText = device.warehouseCompany ? `${device.warehouseCompany}` : "";
        // Combine model, warehouse name, and warehouse company in one cell
        // Check if both warehouseName and warehouseCompany are available to format accordingly

        let warehouseInfo = (warehouseNameText && warehouseCompanyText) ? `${warehouseCompanyText} - ${warehouseNameText}` : "";
        //modelWarehouseCell.innerHTML = `${modelText} <br> ${warehouseInfo}`;

        //modelWarehouseCell.innerHTML = `<span style="display: block; background-color: #f0f0f0;">${modelText}</span>
         //                               <span style="display: block; background-color: #d3d3d3;">${warehouseInfo}</span>`;

		  //row.insertCell().textContent = device.warehouseName;
          //row.insertCell().textContent = device.warehouseCompany;		


		
		// TRIM CPU DETIALS
        let cpuText = device.cpu;
        if (cpuText.includes('CPU')) { cpuText = cpuText.split('CPU')[0]; }// Remove text after 'CPU'
        if (cpuText.includes('Microsoft')) {cpuText = cpuText.split('Microsoft')[0]; }// Remove the word 'Microsoft' and anything following it
        //row.insertCell().textContent = cpuText.trim(); // .trim() to remove any leading/trailing whitespace
        cpuText = cpuText.trim();

        // Insert CPU text in the first line of a mini table
 


        //row.insertCell().textContent = device.ram;
        //row.insertCell().textContent = device.hd;



	

	
        //row.insertCell().textContent = device.warehouseDetails.warehouseName;
        //row.insertCell().textContent = device.warehouseDetails.originAddressName;
        //row.insertCell().textContent = device.warehouseDetails.originAddressCompany;
 		//row.insertCell().textContent = device.advancedOptions.warehouseId;

		
		
		
		        // Shorten Windows Version directly in the function
        let windowsVersion = device.windowsVersion;
        if (windowsVersion.includes('Windows 10 Pro')) { windowsVersion = '10 Pro'; } 
		else if (windowsVersion.includes('Windows 10 Home')) { windowsVersion = '10 Home'; } 
		else if (windowsVersion.includes('Windows 11 Pro')) {  windowsVersion = '11 Pro'; } 
		else if (windowsVersion.includes('Windows 11 Home')) { windowsVersion = '11 Home'; } 
        
        let deviceDate = device.deviceDate ? `${device.deviceDate}` : "";
		
		let dateText = trackingInfo ? trackingInfo.date : 'NO Date';
		let quantityText = trackingInfo ? trackingInfo.quantity : 'NO quantity';
        //row.insertCell().textContent = windowsVersion;
		 
        let shipDateText = device.shipDate ? `${device.shipDate}` : "";        
        let customerNotesText = device.customerNotes ? `${device.customerNotes}` : "";
        let internalNotesText = device.internalNotes ? `${device.internalNotes}` : "";
        let customField1Text1 = device.customField1 ? `${device.customField1}` : "";
        let customField1Text2 = device.customField2 ? `${device.customField2}` : "";
        let customField1Text3 = device.customField3 ? `${device.customField3}` : "";
		
		
        let name = device.name ? `${device.name}` : "";
        let company = device.company ? `${device.company}` : "";
        let street1 = device.street1 ? `${device.street1}` : "";
        let street2 = device.street2 ? `${device.street2}` : "";
        let city = device.city ? `${device.city}` : "";
        let state = device.state ? `${device.state}` : "";
        let postalCode = device.postalCode ? `${device.postalCode}` : "";
        let phone = device.phone ? `${device.phone}` : "";
        let residential = device.residential ? `${device.residential}` : "";

				
		 
createMiniTable(row,
		device.serialNumber || serialText, 
		//modelText,
		//skuText,
		skuText || modelText, // Use skuText, fallback to modelText if skuText is empty
		windowsVersion +
		(typeof device.unitPrice !== 'undefined' ? ' - Price: $' + device.unitPrice : '') +
		(typeof device.orderQuantity !== 'undefined' ? ' - Quantity:' + device.orderQuantity : ''), 
		//windowsVersion +    typeof device.orderTotal !== 'undefined' ? 'Total: $' + device.orderTotal : '',
		'#f0f0f0', '#d3d3d3', '#e6e6e6');
 
		    createMiniTable(
        row, 
        'CPU: ' + cpuText,  // CPU details on the first line
        'RAM: ' + (device.ram || ''),  // RAM on the second line
        'HD: ' + (device.hd || ''),  // HD on the third line
        '#f0f0f0', '#d3d3d3', '#e6e6e6'
    );
	
    // Create a mini table for Windows Version and Date in the same cell
    createMiniTable(
        row,
        trackingText, // Windows version on the first line
        'Scan: ' + dateText + // Date on the second line
        ' Device Added: ' + deviceDate,
        'Tracking Quantity: ' + quantityText,// Empty third line
        '#f0f0f0', '#d3d3d3', '#e6e6e6'
    );
	
createMiniTable(row, 
		warehouseInfo,  
		orderStatusText + ' - ' + shipDateText,  
		customerNotesText + internalNotesText + customField1Text1 + customField1Text2 + customField1Text3, '#f0f0f0', '#d3d3d3', '#e6e6e6');	
//createMiniTable(row, warehouseInfo, warehouseCompanyText, orderStatusText, '#f0f0f0', '#d3d3d3', '#e6e6e6');	
        //row.insertCell().textContent = device.windowsVersion;
		

let combinedAddress = [ device.street1, device.street2, device.city, device.state, device.postalCode,
    //device.residential ? "Residential" : "Business"
    (device.residential === true) ? "Residential" : (device.residential === false) ? "Business" : ""
].filter(Boolean).join(', '); // Combines and filters out empty fields

createMiniTable(row, //device.name + " " + device.company, //street1 + street2 + city + state + postalCode + residential,  
				(device.name ? 'N: ' + device.name : '') + 
				(device.name && device.company ? ' ' : '') + // Adds a space if both name and company are present
				(device.company ? 'C: ' + device.company : ''), 
				combinedAddress, 
				//device.phone + 
				(typeof device.phone !== 'undefined' ? 'Phone: ' + device.phone : '') +
				(typeof device.orderTotal !== 'undefined' ? ' - Total Paid: $' + device.orderTotal : ''),
				//phone, 
				'#f0f0f0', '#d3d3d3', '#e6e6e6');


        // Editable notes cell
        const notesCell = row.insertCell();
        const notesInput = document.createElement('textarea');
        notesInput.type = 'textarea';
        notesInput.value = device.notes;
        notesInput.disabled = true; // Initially disabled
		// Optional: Set the size of the textarea
		notesInput.rows = 4; // Number of rows
		notesInput.cols = 30; // Number of columns
        notesCell.appendChild(notesInput);
 
 

	
	
        // Editable OrderNumber cell
        const orderNumberCell = row.insertCell();
        const orderNumberInput = document.createElement('input');
        orderNumberInput.type = 'text';
        orderNumberInput.value = device.OrderNumber ? device.OrderNumber : '';
        orderNumberInput.disabled = true; // Initially disabled
        orderNumberCell.appendChild(orderNumberInput);

        // Edit/Save button
        const actionButton = document.createElement('button');
        actionButton.style.border = 'none';
        actionButton.style.padding = '0';
        actionButton.style.background = 'none';

        const actionIcon = document.createElement('img');
        actionIcon.src = device.OrderNumber ? 'media/edit.png' : 'media/save.png';
        actionIcon.style.display = 'block';
        actionIcon.style.width = '16px';
        actionIcon.style.height = '16px';
        actionButton.appendChild(actionIcon);

        actionButton.onclick = function() {
            if (orderNumberInput.disabled) {
                orderNumberInput.disabled = false;
                notesInput.disabled = false;
                actionIcon.src = 'media/save.png'; // Change icon to save
            } else {
                updateDeviceDetails(device.serialNumber, orderNumberInput.value, notesInput.value);
                orderNumberInput.disabled = true;
                notesInput.disabled = true;
                actionIcon.src = 'media/edit.png'; // Change icon to edit
            }
        };

        // Trash button
        const trashButton = document.createElement('button');
        trashButton.style.border = 'none';
        trashButton.style.padding = '0';
        trashButton.style.background = 'none';
        trashButton.style.marginLeft = '5px'; // Add some space between buttons

        const trashIcon = document.createElement('img');
        trashIcon.src = 'media/trash.png';
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
                        // Refresh the device list or remove the row from the table
                        row.remove();
                    } else {
                        console.error('Failed to delete the device');
                    }
                })
                .catch(error => console.error('Error:', error));
            }
        };

        // Detail button
        const detailButton = document.createElement('button');
        detailButton.style.border = 'none';
        detailButton.style.padding = '0';
        detailButton.style.background = 'none';
        detailButton.style.marginLeft = '5px'; // Add some space between buttons

        const detailIcon = document.createElement('img');
        detailIcon.src = 'media/details_icon.png';
        detailIcon.style.display = 'block';
        detailIcon.style.width = '16px';
        detailIcon.style.height = '16px';
        detailButton.appendChild(detailIcon);

        // Load the file model_ShowAPILocalDetails.js and when submitting a call back is placed with the updates (without refreshing)
        detailButton.onclick = function() {
            // Set the callback function
            refreshDeviceListCallback = () => {
                // Fetch the updated device list
                fetch('/list-all-devices')
                    .then(response => response.json())
                    .then(data => {
						console.log(data);
                        devices = data;
                        filterDevices(); // Refresh the device list table
                    })
                    .catch(error => console.error('Error:', error));
            };
        
            // Open the modal
            loadModalData_API_Local(device.serialNumber);
        };
		
        // Print button
        const printButton = document.createElement('button');
        printButton.style.border = 'none';
        printButton.style.padding = '0';
        printButton.style.background = 'none';
        printButton.style.marginLeft = '5px'; // Add some space between buttons

        const printIcon = document.createElement('img');
        printIcon.src = 'media/print_icon.png';
        printIcon.style.display = 'block';
        printIcon.style.width = '16px';
        printIcon.style.height = '16px';
        printButton.appendChild(printIcon);
		
		 
        printButton.onclick = function() {
            if (orderNumberInput.disabled) { 
            } else {
                updateDeviceDetails(device.serialNumber, orderNumberInput.value, notesInput.value); 
            }
        };	
		
        orderNumberCell.appendChild(document.createElement('br'));
        orderNumberCell.appendChild(actionButton);
        orderNumberCell.appendChild(trashButton); // Append the trash button next to the action button 
        orderNumberCell.appendChild(detailButton); 
        orderNumberCell.appendChild(printButton); 
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
		    console.log(data); // Log the data In the browser 
            devices = data;
            populateTable(devices);
        })
        .catch(error => console.error('Error:', error));
 
    // Event listeners for each filter
    document.getElementById('filterSerialNumber').addEventListener('input', filterDevices);
    document.getElementById('filterSku').addEventListener('input', filterDevices);
    document.getElementById('filterModel').addEventListener('input', filterDevices);
    document.getElementById('filterWindowsVersion').addEventListener('input', filterDevices);
	
    document.getElementById('filterCpu').addEventListener('input', filterDevices);
    document.getElementById('filterRam').addEventListener('input', filterDevices);
    document.getElementById('filterHd').addEventListener('input', filterDevices);
	
    document.getElementById('filterTracking').addEventListener('input', filterDevices);
    //document.getElementById('filterTrackingDate').addEventListener('input', filterDevices);
    //document.getElementById('filterQuantity').addEventListener('input', filterDevices);
	
    //document.getElementById('filterWarehouseInfo').addEventListener('input', filterDevices);
    //document.getElementById('filterorderStatus').addEventListener('input', filterDevices);
    //document.getElementById('filterShipstaionNotes').addEventListener('input', filterDevices);
	
    document.getElementById('filterNameCompany').addEventListener('input', filterDevices);
    document.getElementById('filterAddress').addEventListener('input', filterDevices);
    document.getElementById('filterPhone').addEventListener('input', filterDevices);

    //document.getElementById('filterSku').addEventListener('input', filterDevices);
    document.getElementById('filterNotes').addEventListener('input', filterDevices);
    document.getElementById('filterActivationStatus').addEventListener('input', filterDevices);
    document.getElementById('filterOrderstatus').addEventListener('input', filterDevices); 
    document.getElementById('filterOrderNumber').addEventListener('input', filterDevices);

document.getElementById('updateShippingStatusButton').addEventListener('click', async function() {
    const updateButton = this;
    const loadingProgress = document.getElementById('loadingProgress');
    const currentProgress = document.getElementById('currentProgress');
    const totalDevices = document.getElementById('totalDevices');

    updateButton.classList.add('loadingButton');
    updateButton.disabled = true;
    loadingProgress.style.display = 'block';

    const orderNumbers = devices.map(device => device.OrderNumber).filter(orderNumber => orderNumber);
    totalDevices.textContent = orderNumbers.length;
    currentProgress.textContent = '0';

    for (let i = 0; i < orderNumbers.length; i++) {
        try {
            // Sending request to your server endpoint
            const response = await fetch('/bulk-update-local-shipping-status', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ orderNumbers: [orderNumbers[i]] })
            });

            if (!response.ok) {
                throw new Error('Failed to update order');
            }

            // Update progress after each successful request
            currentProgress.textContent = (i + 1).toString();
			console.log('Local shipping status updated and saved.');
        } catch (error) {
            console.error(`Failed to update order ${orderNumbers[i]}`, error);
        }
    }

    // After completion
    updateButton.classList.remove('loadingButton');
    updateButton.disabled = false;
    loadingProgress.style.display = 'none';
    filterDevices(); // Refresh the devices table
});




document.getElementById('updateDeviceInfoButton').addEventListener('click', async function() {
    const updateButton = this; // Reference to the button clicked
    const loadingProgress = document.getElementById('loadingProgress'); // Loading progress bar element
    const currentProgress = document.getElementById('currentProgress'); // Current progress text element
    const totalDevices = document.getElementById('totalDevices'); // Total devices text element

    updateButton.classList.add('loadingButton'); // Add loading class for visual feedback
    updateButton.disabled = true; // Disable button to prevent multiple clicks
    loadingProgress.style.display = 'block'; // Show loading progress bar

    const orderNumbers = devices.map(device => device.OrderNumber).filter(orderNumber => orderNumber);
    totalDevices.textContent = orderNumbers.length; // Set total number of devices to be processed
    currentProgress.textContent = '0'; // Initialize current progress to 0

    for (let i = 0; i < orderNumbers.length; i++) {
        try {
            // Sending request to the server endpoint
            const response = await fetch('/bulk-update-device-info', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ orderNumbers: [orderNumbers[i]] }) // Send one order number at a time
//TODO add shipDate, shipDate, customerNotes: null,  internalNotes: null 
/*name: Mark DeGroff 
residential: null
addressVerified: null
shipTo:
name: Mark DeGroff
company:
street1: Room 503 Culkin Hall SUNYCO
street2: Auxiliary Services SUNY Oswego 
city: Oswego
state: NY
postalCode: 13126
country: US
phone: 315-312-2106
*/
				
            });

            if (!response.ok) {
                throw new Error('Failed to update device info');
            }

            // Update progress after each successful request
            currentProgress.textContent = (i + 1).toString();
            console.log(`Device info updated for order number ${orderNumbers[i]}`);
        } catch (error) {
            console.error(`Failed to update device info for order number ${orderNumbers[i]}`, error);
        }
    }

    // After completion
    updateButton.classList.remove('loadingButton'); // Remove loading class
    updateButton.disabled = false; // Re-enable button
    loadingProgress.style.display = 'none'; // Hide loading progress bar
    filterDevices(); // Refresh the devices table
});


 


});

 

// Function to update device details
function updateDeviceDetails(serialNumber, orderNumber, notes) {
    console.log(`Attempting to update device ${serialNumber} with order number ${orderNumber} and notes ${notes}`);
    fetch(`/update-device-details/${encodeURIComponent(serialNumber)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ OrderNumber: orderNumber, notes: notes })
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




//---------------------------------------------







 


// Helper function to create a mini table
function createMiniTable(row, line1, line2, line3, color1, color2, color3) {
    let cell = row.insertCell();
    let miniTable = document.createElement('table');
    miniTable.style.width = '100%';
    miniTable.style.borderCollapse = 'collapse';
    miniTable.style.border = '0'; // Remove border to avoid unnecessary lines
    miniTable.style.tableLayout = 'fixed'; // Fixed table layout
    miniTable.style.margin = '0'; // Override the global margin setting

    // Create rows for each line of data
    let row1 = miniTable.insertRow();
    let row2 = miniTable.insertRow();
    let row3 = miniTable.insertRow();

    // Set background colors and text styles
    styleMiniTableRow(row1, line1, color1);
    styleMiniTableRow(row2, line2, color2);
    styleMiniTableRow(row3, line3, color3);

    // Append mini table to the main table cell
    cell.appendChild(miniTable);
}

// Helper function to style each row of the mini table
function styleMiniTableRow(row, text, bgColor) {
    row.style.backgroundColor = bgColor;
    let cell = row.insertCell();
    cell.textContent = text || ''; // If text is empty, it will set the content to an empty string
    cell.style.padding = '5px';  // Add some padding for better readability
    cell.style.border = '0';     // Remove cell border
    cell.style.fontSize = '14px'; // Set font size
    cell.style.height = '20px';  // Set a fixed height for rows
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