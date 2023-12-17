// showDeviceDetails.js

// Function to show device details
function showDeviceDetails(trackingNumber, isArchived = false) {
    const endpoint = isArchived ? `/get-archived-device-details/${trackingNumber}` : `/get-device-details/${trackingNumber}`;

    fetch(endpoint)
        .then(response => response.json())
        .then(devices => {
            const modalTable = document.getElementById('modalTable');

            // Define the headers
            let tableContent = `<tr>
                <th>Serial Number</th>
                <th>Model</th>
                <th>CPU</th>
                <th>RAM</th>
                <th>HD</th>
                <th>Windows Version</th>
                <th>Status</th>
                <th>Notes</th>
                <!--<th>Order Number</th>
                <th>API</th>
                <th>Account</th>
                <th>In Account</th>
                <th>Return Reason</th>
                <th>Not Approved Reason</th>-->
                <th>Print Label</th>
            </tr>`;

            // Append each device row to the table content
            tableContent += devices.map(device => `
                <tr>
                    <td>${device.serialNumber}</td>
                    <td>${device.model}</td>
                    <td>${device.cpu}</td>
                    <td>${device.ram}</td>
                    <td>${device.hd}</td>
                    <td>${device.windowsVersion}</td>
                    <td>${device.status}</td>
                    <td>${device.notes}</td>
                    <!--<td>${device.OrderNumber}</td>
                    <td>${device.API}</td>
                    <td>${device.Account}</td>
                    <td>${device.InAccount ? 'Yes' : 'No'}</td>
                    <td>${device['Return_Reason']}</td>
                    <td>${device.notApprovedReason}</td>-->
                    <td>
                        <input type="text" 
                               value="${device.OrderNumber || ''}" 
                               ${device.OrderNumber ? 'disabled' : ''} 
                               onchange="linkOrderNumber(this, '${device.serialNumber}')" />
                    </td>
                    <td><img src="details_icon.png" class="details-icon" onclick="orderDetailsModal('${device.serialNumber}')"></td>
                    <td><img src="print_icon.png" class="print-icon" onclick="printLabel('${device.serialNumber}')"></td>
                </tr>
            `).join('');

            // Set the innerHTML of the table to the compiled content
            modalTable.innerHTML = tableContent;

            showModal();
        })
        .catch(error => console.error('Error:', error));
}

function linkOrderNumber(inputElement, serialNumber) {
    inputElement.addEventListener('blur', () => {
        const orderNumber = inputElement.value;
        fetch(`/update-order-number/${serialNumber}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ orderNumber: orderNumber })
        })
        .then(response => {
            if (response.ok) {
                console.log('Order number updated successfully');
                if (orderNumber) {
                    inputElement.disabled = true; // Disable the field only if it's not empty
                }
            } else {
                console.error('Failed to update order number');
            }
        })
        .catch(error => {
            console.error('Error:', error);
        });
    });
}
//submitEditForm(device.serialNumber, device.trackingNumber);


function orderDetailsModal(serialNumber) {
    // First, fetch details based on serial number from the internal database
    fetch(`/get-details-by-serial/${serialNumber}`)
        .then(response => response.json())
        .then(device => {
            // Check if there is an OrderNumber to fetch additional details
            if (device && device.OrderNumber) {
                return fetch(`/get-order/${device.OrderNumber}`)
                    .then(orderResponse => orderResponse.json())
                    .then(orderData => ({ device, orderData })) // Combine both data
                    .catch(() => ({ device })); // In case of order fetch error, return only device data
            } else {
                return { device }; // Return only device data if no OrderNumber
            }
        })
        .then(combinedData => {
            const { device, orderData } = combinedData;
            const modalContent = document.getElementById('ModalOrderDetails');
            let contentHtml = `<h2>Details for Serial Number: ${serialNumber}</h2>
                               <button onclick="editDeviceDetails('${serialNumber}')">Edit</button>`;

            // Add device details 
            contentHtml += device.status ? `<p>Status: ${device.status}</p>` : '';
            contentHtml += device.notes ? `<p>Notes: ${device.notes}</p>` : '';
            contentHtml += device.OrderNumber ? `<p>Order Number: ${device.OrderNumber}</p>` : '';
            contentHtml += device.API ? `<p>API: ${device.API}</p>` : '';
            contentHtml += device.Account ? `<p>Account: ${device.Account}</p>` : '';
            contentHtml += typeof device.InAccount !== 'undefined' ? `<p>In Account: ${device.InAccount ? 'Yes' : 'No'}</p>` : '';
            contentHtml += device['Return_Reason'] ? `<p>Return Reason: ${device['Return_Reason']}</p>` : '';
            contentHtml += device.notApprovedReason ? `<p>Not Approved Reason: ${device.notApprovedReason}</p>` : '';
            // ... add other device fields

            // Add order details if available
        if (orderData) {
            contentHtml += orderData.orderStatus ? `<p>Order Status: ${orderData.orderStatus}</p>` : '';
            contentHtml += orderData.shipTo ? `<p>Ship To: ${formatShipTo(orderData.shipTo)}</p>` : '';
            contentHtml += orderData.items ? `<p>Items: ${orderData.items.map(item => item.name).join(', ')}</p>` : '';
            contentHtml += orderData.customerNotes ? `<p>Customer Notes: ${orderData.customerNotes}</p>` : '';
            contentHtml += orderData.internalNotes ? `<p>Internal Notes: ${orderData.internalNotes}</p>` : '';
            contentHtml += typeof orderData.gift !== 'undefined' ? `<p>Gift: ${orderData.gift ? 'Yes' : 'No'}</p>` : '';
            contentHtml += orderData.giftMessage ? `<p>Gift Message: ${orderData.giftMessage}</p>` : '';
            contentHtml += orderData.requestedShippingService ? `<p>Requested Shipping Service: ${orderData.requestedShippingService}</p>` : '';
            contentHtml += orderData.carrierCode ? `<p>Carrier Code: ${orderData.carrierCode}</p>` : '';
            contentHtml += orderData.serviceCode ? `<p>Service Code: ${orderData.serviceCode}</p>` : '';
            contentHtml += orderData.packageCode ? `<p>Package Code: ${orderData.packageCode}</p>` : '';
            contentHtml += orderData.confirmation ? `<p>Confirmation: ${orderData.confirmation}</p>` : '';
            contentHtml += orderData.shipDate ? `<p>Ship Date: ${orderData.shipDate}</p>` : '';
            contentHtml += orderData.holdUntilDate ? `<p>Hold Until Date: ${orderData.holdUntilDate}</p>` : '';
            contentHtml += orderData.storeId ? `<p>Store ID: ${orderData.storeId}</p>` : '';
            contentHtml += orderData.source ? `<p>Source: ${orderData.source}</p>` : '';
            contentHtml += orderData.userId ? `<p>User ID: ${orderData.userId}</p>` : '';
            contentHtml += typeof orderData.externallyFulfilled !== 'undefined' ? `<p>Externally Fulfilled: ${orderData.externallyFulfilled ? 'Yes' : 'No'}</p>` : '';
            contentHtml += orderData.externallyFulfilledBy ? `<p>Externally Fulfilled By: ${orderData.externallyFulfilledBy}</p>` : '';
            contentHtml += orderData.externallyFulfilledById ? `<p>Externally Fulfilled By ID: ${orderData.externallyFulfilledById}</p>` : '';
            contentHtml += orderData.externallyFulfilledByName ? `<p>Externally Fulfilled By Name: ${orderData.externallyFulfilledByName}</p>` : '';
            contentHtml += orderData.labelMessages ? `<p>Label Messages: ${orderData.labelMessages}</p>` : '';
        }
			
			

            modalContent.innerHTML = contentHtml;
            showOrderDetailsModal();
        })
        .catch(error => {
            console.error('Error:', error);
            const modalContent = document.getElementById('ModalOrderDetails');
            modalContent.innerHTML = `<p>Error loading details: ${error.message}</p>`;
        });
}

// Helper function to format the ship to address
function formatShipTo(shipToData) {
    if (!shipToData) return 'N/A';
    return `${shipToData.name}, ${shipToData.street1}, ${shipToData.city}, ${shipToData.state}, ${shipToData.postalCode}, ${shipToData.country}`;
} 

function editDeviceDetails(serialNumber) {
    // Fetch current device details
    fetch(`/get-details-by-serial/${serialNumber}`)
        .then(response => response.json())
        .then(device => {
			
            // Populate all fields 
            document.getElementById('editSerialNumber').value = serialNumber;
            document.getElementById('editModel').value = device.model || '';
            document.getElementById('editCPU').value = device.cpu || '';
            document.getElementById('editRAM').value = device.ram || '';
            document.getElementById('editHD').value = device.hd || '';
            document.getElementById('editWindowsVersion').value = device.windowsVersion || '';
            document.getElementById('editStatus').value = device.status || '';
            document.getElementById('editNotes').value = device.notes || '';
            document.getElementById('editOrderNumber').value = device.OrderNumber || '';
            document.getElementById('editAPI').value = device.API || '';
            document.getElementById('editAccount').value = device.Account || '';
            document.getElementById('editInAccount').checked = device.InAccount;
            document.getElementById('editReturnReason').value = device['Return_Reason'] || '';
            document.getElementById('editNotApprovedReason').value = device.notApprovedReason || '';
			
			
						// Create a submit button
            const submitButton = document.createElement('button');
            submitButton.textContent = 'Save Changes';
            submitButton.addEventListener('click', () => submitEditForm(serialNumber, device.trackingNumber));

            const form = document.getElementById('editDeviceForm');
            form.appendChild(submitButton);
			

            // Show the modal
            document.getElementById('editDeviceModal').style.display = 'block';
        })
        .catch(error => console.error('Error fetching device details:', error));
}



function closeEditModal() {
    document.getElementById('editDeviceModal').style.display = 'none';
}


function submitEditForm(serialNumber, trackingNumber) {
	  //  event.preventDefault(); // Prevent form submission
		
		
		
	    //const serialNumber = document.getElementById('editSerialNumber').value;
    const updatedData = {
        trackingNumber: "MS_2016040335",
        serialNumber: serialNumber,
        model: document.getElementById('editModel').value,
        cpu: document.getElementById('editCPU').value,
        ram: document.getElementById('editRAM').value,
        hd: document.getElementById('editHD').value,
        windowsVersion: document.getElementById('editWindowsVersion').value,
      //  sku: document.getElementById('editSKU').value,
        notes: document.getElementById('editNotes').value
        activationStatus: document.getElementById('editActivationStatus').value,
        status: document.getElementById('editStatus').value,
        OrderNumber: document.getElementById('editOrderNumber').value,
        API: document.getElementById('editAPI').value,
        Account: document.getElementById('editAccount').value,
        InAccount: document.getElementById('editInAccount').checked,
        Return_Reason: document.getElementById('editReturnReason').value,
        notApprovedReason: document.getElementById('editNotApprovedReason').value
    };


console.log('Manuel Tracking number test:', trackingNumber); // Log the data being sent
console.log('Updated Data:', updatedData); // Log the data being sent
    //fetch('/add-device', {
    fetch(`/update-device-details/${serialNumber}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatedData),
    })
    .then(response => {
        console.log('Raw Response:', response);
        if (!response.ok) {
            throw new Error('Network response was not OK');
        }
        return response.json();
    })
    .then(data => {
        console.log('Device details updated successfully:', data);
        closeEditModal();
        // Optionally refresh or update the UI
    })
    .catch(error => {
        console.error('Error:', error);
    });
}

/*
function submitEditForm() {
    const serialNumber = document.getElementById('editSerialNumber').value;
    const updatedData = {
        status: document.getElementById('editStatus').value,
        notes: document.getElementById('editNotes').value,
        // Collect other fields...
    };

    fetch(`/update-device-details/${serialNumber}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatedData),
    })
    .then(response => {
        if (response.ok) {
            console.log('Device details updated successfully');
            closeEditModal();
            // Optionally refresh or update the UI
        } else {
            console.error('Failed to update device details');
        }
    })
    .catch(error => console.error('Error:', error));
}
*/









function showOrderDetailsModal() {
    document.getElementById('orderDetailsModal').style.display = 'block';
}

function closeOrderDetailsModal() {
    document.getElementById('orderDetailsModal').style.display = 'none';
}
 


/* This should be used with a submit button, If ever added. 
function linkOrderNumber(inputElement, serialNumber) {
    const orderNumber = inputElement.value;
    fetch(`/update-order-number/${serialNumber}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ orderNumber: orderNumber })
    })
    .then(response => {
        if (response.ok) {
            console.log('Order number updated successfully');
            inputElement.disabled = true; // Optionally disable the field after update
        } else {
            console.error('Failed to update order number');
        }
    })
    .catch(error => console.error('Error:', error));
}
*/

/*
function showMoreDetailsModal(serialNumber) {
    // Fetch additional details based on the serial number
    fetch(`/get-more-details/${serialNumber}`)
        .then(response => response.json())
        .then(details => {
            const moreDetailsContent = document.getElementById('moreDetailsContent');
            
            // Assuming 'details' contains additional info to be displayed
            moreDetailsContent.innerHTML = `
                <p>Serial Number: ${details.serialNumber}</p>
                <p>Additional Info: ${details.additionalInfo}</p>
                <!-- ... more details ... -->
            `;

            // Function to show the more details modal
            showMoreDetails();
        })
        .catch(error => console.error('Error:', error));
}


function showMoreDetails() {
    // Logic to display the 'moreDetailsModal'
    // This depends on how your modals are implemented (e.g., using Bootstrap, custom CSS, etc.)
}
*/
function printLabel(serialNumber) {
    const url = `/preview-label/${serialNumber}`;
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';

    pdfjsLib.getDocument(url).promise.then(function(pdfDoc) {
        console.log('PDF loaded');
        pdfDoc.getPage(1).then(function(page) {
            var canvas = document.getElementById('pdfCanvas'); // Canvas in your modal
            var ctx = canvas.getContext('2d');
            var viewport = page.getViewport({scale: 1});
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            var renderContext = {
                canvasContext: ctx,
                viewport: viewport
            };
            page.render(renderContext).promise.then(function() {
                console.log('Page rendered');
                showLabelPreviewModal(); // Show modal after rendering
            });
        });
    }).catch(function(error) {
        console.error('Error: ', error);
    });
}





/*
function printLabel(serialNumber) {
    const url = `/preview-label/${serialNumber}`;
    document.getElementById('labelPreviewFrame').src = url;
    showLabelPreviewModal();
}
*/
/*
// Updated function to handle label preview
function printLabel(serialNumber) {
    const url = `/preview-label/${serialNumber}`;
    document.getElementById('labelPreviewFrame').src = url;
    showLabelPreviewModal();
}*/ 



function showLabelPreviewModal() {
    document.getElementById('labelPreviewModal').style.display = 'block';
}

function closeLabelPreviewModal() {
    document.getElementById('labelPreviewModal').style.display = 'none';
}

/*
function printLabelFromModal() {
    var canvas = document.getElementById('pdfCanvas');
    if (!canvas) {
        console.error('No canvas found for printing');
        return;
    }

    // Create an image from the canvas content
    var imgData = canvas.toDataURL('image/png');

    // Open a new window for printing
    var printWindow = window.open('', '_blank');
    printWindow.document.open();
    printWindow.document.write('<html><head><title>Print</title></head><body>');
    printWindow.document.write('<img id="printImage" src="' + imgData + '" style="width:100%;"></body></html>');
    printWindow.document.close();

    // Wait for the image to load before printing
    printWindow.onload = function() {
        var printImage = printWindow.document.getElementById('printImage');
        if (printImage) {
            // Adjust the scale of the image for printing
            printImage.style.width = '216mm';  // Adjust width as needed
            printImage.style.height = '108mm'; // Adjust height as needed
            printWindow.focus();
            printWindow.print();
            printWindow.close();
        } else {
            console.error('Image not found for printing');
            printWindow.close();
        }
    };
}
*/

function printPdfDirectly(serialNumber) {
    const url = `/preview-label/${serialNumber}`;
    window.open(url, '_blank');
}


function printLabelFromModal() {
    var canvas = document.getElementById('pdfCanvas');
    if (!canvas) {
        console.error('No canvas found for printing');
        return;
    }

    // Convert canvas content to data URL (image)
    var imgData = canvas.toDataURL('image/png');

    // Open a new print window
    var printWindow = window.open('', '_blank');
    printWindow.document.open();
    printWindow.document.write('<html><head><title>Print</title></head><body>');
    printWindow.document.write('<img src="' + imgData + '" onload="window.print();" style="width:216mm;height:108mm;"></body></html>');
    printWindow.document.close();
}

function printPdfFromCanvas(serialNumber) {
    const url = `/preview-label/${serialNumber}`;

    // Fetch and render the PDF onto a canvas
    // Then open a print dialog for the canvas content
    // This part requires PDF.js to fetch and render the PDF onto a canvas
    // After rendering, you can use a similar method as previously discussed to print the canvas content
}

/*
function printLabelFromModal() {
    var canvas = document.getElementById('pdfCanvas');
    if (!canvas) {
        console.error('No canvas found for printing');
        return;
    }

    // Create a window or an iframe to print
    var printWindow = window.open('', '_blank');
    printWindow.document.open();
    printWindow.document.write('<html><head><title>Print</title></head><body>');
    printWindow.document.write('<img src="' + canvas.toDataURL('image/png') + '" style="width: 100%;">');
    printWindow.document.write('</body></html>');
    printWindow.document.close();

    // Wait for the image to load in the print window
    printWindow.onload = function() {
        printWindow.focus();
        printWindow.print();
        printWindow.close();
    };
}
*/

//Download img
function downloadLabelFromModal() {
    var canvas = document.getElementById('pdfCanvas');
    var link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = 'Label.png';
    link.click();
}
/* Download PDF
function downloadLabelFromModal() {
    const iframe = document.getElementById('labelPreviewFrame');
    const url = iframe.src;
    const link = document.createElement('a');
    link.href = url;
    link.download = 'Label.pdf';
    link.click();
}

*/


// Function to show the modal
function showModal() {
    const modal = document.getElementById('deviceDetailsModal');
    if (modal) {
        modal.style.display = 'block';
    }
}

// Function to close the modal
function closeModal() {
    const modal = document.getElementById('deviceDetailsModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// Event listener for closing the modal
document.addEventListener('DOMContentLoaded', function() {
    const closeModalButton = document.getElementById('closeModal');
    if (closeModalButton) {
        closeModalButton.addEventListener('click', closeModal);
    }
});








/*/preview-label/:serialNumber
function printLabel(serialNumber) {
    fetch(`/preview-label/${serialNumber}`)
        .then(response => response.blob())
        .then(blob => {
            const url = window.URL.createObjectURL(blob);
            window.open(url, '_blank').print();
        })
        .catch(error => console.error('Error printing label:', error));
}
*/
 
 /*
 // Updated function to handle label preview
function printLabel(serialNumber) {
    fetch(`/print-label/${serialNumber}`)
        .then(response => response.blob())
        .then(blob => {
            const url = window.URL.createObjectURL(blob);
            document.getElementById('labelPreviewFrame').src = url;
            showLabelPreviewModal();
        })
        .catch(error => console.error('Error:', error));
}
*/