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

// Placeholder for getLocalDataForSerialNumber_API_Local function
function getLocalDataForSerialNumber_API_Local(serialNumber) {
    console.log("getLocalDataForSerialNumber_API_Local Function loded");
    // Placeholder implementation
    return null; // Replace with actual data retrieval logic
}

// Global modal variable
var modal_API_Local;
let currentDeviceData = null; // Global variable to store device data

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
    document.getElementById(tabName_API_Local).style.display = "block";
    if (evt) {
        evt.currentTarget.className += " active";
    } else {
        // Manually set the active class for the default tab
        var defaultTab = document.getElementById("defaultOpen_API_Local");
        if (defaultTab) {
            defaultTab.className += " active";
        }
    }
    
    // Clear existing content when switching tabs
    clearTabContents_API_Local();

    // Load appropriate data based on the selected tab
    if (tabName_API_Local === 'LocalData_API_Local' && currentDeviceData) {
        populateLocalData_API_Local(currentDeviceData);
    } else if (tabName_API_Local === 'APIData_API_Local') {
        populateAPIData_API_Local({ dummyData: "This is dummy API data" }); // Dummy data for testing
    }
	
	    const isLocalTab = tabName_API_Local === 'LocalData_API_Local';
    document.getElementById('editButton').style.display = isLocalTab ? 'block' : 'none';
    document.getElementById('saveButtonShowAPILocalDetails').style.display = 'none'; // Always hide save button initially

    const isApiTab = tabName_API_Local === 'APIData_API_Local';
    document.getElementById('editApiButton').style.display = isApiTab ? 'block' : 'none';
    document.getElementById('saveApiButton').style.display = 'none'; // Always hide save button initially
//	    const isLocalTab = tabName_API_Local === 'LocalData_API_Local';
  //  document.getElementById('editButton').style.display = isLocalTab ? 'block' : 'none';
  //  document.getElementById('saveButtonShowAPILocalDetails').style.display = 'none';

  //  const isApiTab = tabName_API_Local === 'APIData_API_Local';
  //  document.getElementById('editApiButton').style.display = isApiTab ? 'block' : 'none';
  //  document.getElementById('saveApiButton').style.display = 'none';
}



function clearTabContents_API_Local() {
    const localDataDiv = document.getElementById("LocalData_API_Local");
    const apiDataDiv = document.getElementById("APIData_API_Local");
    localDataDiv.innerHTML = '';
    apiDataDiv.innerHTML = '';
}

// Populate data 
function populateLocalData_API_Local(localData, isEditMode = false) {
    const localDataDiv = document.getElementById("LocalData_API_Local");
    localDataDiv.innerHTML = Object.entries(localData).map(([key, value]) => {
        const fieldValue = isEditMode ? `<input type="text" id="${key}InputField" value="${value}">` : value;
        return `<div><strong>${key}:</strong> <span class="editable">${fieldValue}</span></div>`;
		       // return `<div><strong>${key}:</strong> <span class="editable"><input type="text" id="${key}InputField" value="${value}"></span></div>`;

    }).join('');
}



// Populate API data
function populateAPIData_API_Local() {
    const apiDataDiv = document.getElementById("APIData_API_Local");
    apiDataDiv.innerHTML = 'Loading API data...'; // Display a loading message

    if (currentDeviceData && currentDeviceData.OrderNumber) {
        fetch(`/get-order-full/${encodeURIComponent(currentDeviceData.OrderNumber)}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Order not found');
                }
                return response.json();
            })
            .then(orderData => {
                // Format the data for display using formatDataForDisplay_API_Local
                apiDataDiv.innerHTML = formatDataForDisplay_API_Local(orderData);
            })
            .catch(error => {
                console.error(error);
                apiDataDiv.textContent = `Error: ${error.message}`;
            });
    } else {
        apiDataDiv.textContent = 'No order number available for API data.';
    }
}
function formatDataForDisplay_API_Local(data, indent = 0) {
    if (typeof data !== 'object' || data === null) {
        return `<span class="editable">${data}</span>`;
    }

    if (Array.isArray(data)) {
        return data.map(item => `<div style="margin-left: ${indent}em;">${formatDataForDisplay_API_Local(item, indent + 1)}</div>`).join('');
    }

    return Object.entries(data).map(([key, value]) => {
        return `<div style="margin-left: ${indent}em;"><strong>${key}:</strong> ${formatDataForDisplay_API_Local(value, indent + 1)}</div>`;
    }).join('');
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

// Function to refresh modal data
function refreshModalData(serialNumber) {
    fetch(`/get-details-by-serial/${encodeURIComponent(serialNumber)}`)
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to fetch updated device data');
            }
            return response.json();
        })
        .then(updatedDeviceData => {
            currentDeviceData = updatedDeviceData; // Update the global current device data
            populateLocalData_API_Local(updatedDeviceData, false); // Repopulate the modal with updated data
        })
        .catch(error => {
            console.error('Error:', error);
        });
}





function loadModalData_API_Local(serialNumber) {
    fetch(`/get-details-by-serial/${encodeURIComponent(serialNumber.toLowerCase())}`)
        .then(response => {
            if (!response.ok) {
                throw new Error('Device not found');
            }
            return response.json();
        })
        .then(deviceData => {
            currentDeviceData = deviceData; // Store the fetched data
            populateLocalData_API_Local(deviceData); // Populate local data tab
            modal_API_Local.style.display = "block";
            
            // Open the Local Data tab by default
            openTab(null, 'LocalData_API_Local');
        })
        .catch(error => {
            console.error(error);
            const localDataDiv = document.getElementById("LocalData_API_Local");
            localDataDiv.innerHTML = `<p>Error: ${error.message}</p>`;
            modal_API_Local.style.display = "block";
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

