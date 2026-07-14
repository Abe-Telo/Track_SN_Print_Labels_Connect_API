const { applySafeArchiveState } = require('./safe_archive.js');
//module.exports = function(app) {



//updates all things in local DateBase.
// This is used in model_ShowAPILocalDetails.js
function updatedevice_SerialNumber_NoLimit(app) {
app.post('/update-device/:serialNumber', (req, res) => {
    const serialNumber = req.params.serialNumber;
    const updates = req.body; // This now contains all the updated fields

    // Call a function to update the device with these fields
    if (updateDevice(serialNumber, updates)) {
        saveTrackingData();
        saveArchivedTrackingData();
        res.send('Device updated successfully');
    } else {
        console.log('Device not found');
        res.status(404).send('Device not found');
    }
});
}
function updateDevice(serialNumber, updates) {
    let found = false;

    // Update in trackingData
    trackingData.forEach(trackingItem => {
        const device = trackingItem.devices.find(d => d.serialNumber === serialNumber);
        if (device) {
            Object.assign(device, updates); // Update the device data
            found = true;
        }
    });

    // If not found in trackingData, update in archivedTrackingData
    if (!found) {
        archivedTrackingData.forEach(trackingItem => {
            const device = trackingItem.devices.find(d => d.serialNumber === serialNumber);
            if (device) {
                Object.assign(device, updates); // Update the device data
                found = true;
            }
        });
    }

    return found;
}


/* Endpoint: /update-order-number/:serialNumber
   Method: POST
   urpose: To update the order number associated with a device identified by its serial number.
   Functionality:
     Retrieves the serial number and order number from the request.
     Logs the operation of updating the order number.
     Calls updateDeviceOrderNumber to perform the update. This function's implementation is not shown but is assumed to update the device's order number in some data store.
     If the update is successful, it saves the changes to tracking data and responds to the client with a success message.
     If the device with the given serial number is not found, it logs an error and sends a 404 response.
*/
// To Update OrderNumber into Internel DB
function updateOrderNumber_serialNumber(app) {
app.post('/update-order-number/:serialNumber', (req, res) => {
    // Retrieves the serial number from the URL parameter.
    const serialNumber = req.params.serialNumber;

    // Extracts the order number from the request body.
    const { orderNumber } = req.body;

    // Logs the operation to the console.
    console.log(`Updating order number for serial: ${serialNumber} with new order number: ${orderNumber}`);

    // Calls a function to update the order number for the given serial number.
    // This function is expected to return true if the update is successful, false otherwise.
    if (updateDeviceOrderNumber(serialNumber, orderNumber)) {
        // If the update is successful, saves the changes to tracking data and archived tracking data.
        saveTrackingData();
        saveArchivedTrackingData();

        // Sends a success message back to the client.
        res.send('Order number updated successfully');
    } else {
        // If the device is not found, logs the error and sends a 404 status with a 'Device not found' message.
        console.log('Device not found');
        res.status(404).send('Device not found');
    }
});
}

/*  Purpose: To update the order number of a device identified by its serial number.
    Process:
        The function first searches through the active tracking data (trackingData).
        If the device is found, its OrderNumber is updated to newOrderNumber, and the function returns true.
        If the device is not found in the active data, the function then searches through the archived tracking data (archivedTrackingData).
        If the device is found in the archived data, its OrderNumber is updated similarly, and the function returns true.
        If the device is not found in either set of data, the function returns false, indicating that the update was not successful.
*/
// Function to update order number for a device by its serial number
function updateDeviceOrderNumber(serialNumber, newOrderNumber) {
    // Iterates through each item in the active tracking data.
    for (const trackingItem of trackingData) {
        // Searches for a device with the matching serial number within the current tracking item.
        const device = trackingItem.devices.find(d => d.serialNumber === serialNumber);

        // If the device is found, updates its OrderNumber and returns true.
        if (device) {
            device.OrderNumber = newOrderNumber;
            return true; // Update successful
        }
    }

    // If the device wasn't found in active data, repeats the search in archived tracking data.
    for (const trackingItem of archivedTrackingData) {
        // Searches for a device with the matching serial number within the current archived tracking item.
        const device = trackingItem.devices.find(d => d.serialNumber === serialNumber);

        // If the device is found in archived data, updates its OrderNumber and returns true.
        if (device) {
            device.OrderNumber = newOrderNumber;
            return true; // Update successful
        }
    }

    // If the device isn't found in either active or archived data, returns false.
    return false; // Device not found
}


/*
    Endpoint: /update-quantityWEB
    Method: POST
    Purpose: To update the quantity of a tracking item in the tracking data.
    Functionality:
        Receives a tracking number and a new quantity value via the request body.
        Searches for the tracking item with the given tracking number.
        If found, updates its quantity to the new value.
        Saves the updated tracking data.
        Returns a success message if the update is successful.
        If the tracking number is not found, returns a 404 error with an appropriate message.
*/
// it should remove -1 in quantity if i am not mistaken
function updateQuantityWEBMin1(app) {
app.post('/update-quantityWEB', (req, res) => {
    // Extracts the tracking number and new quantity from the request body.
    const { trackingNumber, newQuantity } = req.body;

    // Finds the index of the tracking item in the 'trackingData' array that matches the given tracking number.
    const index = trackingData.findIndex(item => item.trackingNumber === trackingNumber);

    // Checks if the tracking item was found (i.e., index is not -1).
    if (index !== -1) {
        // Updates the 'quantity' field of the found tracking item to the new quantity.
        // The new quantity is converted to a number to ensure correct data type.
        trackingData[index].quantity = Number(newQuantity);

        // Saves the updated tracking data (the implementation of saveTrackingData is not shown).
        saveTrackingData();

        // Responds with a success message.
        res.send('Quantity updated successfully');
    } else {
        // If the tracking number is not found in 'trackingData', responds with a 404 status and an error message.
        res.status(404).send('Tracking number not found');
    }
});
}

/*
app.post('/update-remainingWEB', (req, res) => {
    const { trackingNumber, newQuantity } = req.body;

    const index = trackingData.findIndex(item => item.trackingNumber === trackingNumber);
    if (index !== -1) {
        // Convert newQuantity to a number
        trackingData[index].remaining = Number(newQuantity);
        //trackingData[index].remaining = newQuantity;
        saveTrackingData();
        res.send('remaining updated successfully');
    } else {
        res.status(404).send('Tracking number not found');
    }
});
*/



/*
    Endpoint: /update-remainingWEB
    Method: POST
    Purpose: To update the remaining quantity of a tracked item and move it to archived data if the quantity reaches zero.
    Functionality:
        Receives a tracking number and a new remaining quantity via the request body.
        Searches for the tracking item with the given tracking number.
        If found, updates its remaining quantity to the new value.
        If the remaining quantity reaches zero, moves the item to archived tracking data.
        Saves the updates to both active and archived tracking data.
        Returns a success message if the update is successful.
        If the tracking number is not found, returns a 404 error with an appropriate message.
*/
function updateRemainingWEB0ToArchive(app) {
    app.post('/update-remainingWEB', (req, res) => {
        const { trackingNumber, newQuantity } = req.body;
        const index = global.trackingData.findIndex(item => item.trackingNumber === trackingNumber);

        if (index !== -1) {
            const item = global.trackingData[index];
            item.remaining = Number(newQuantity);

            // Correct workflow:
            // remaining starts at 0 and climbs as devices are scanned.
            // When remaining === quantity (e.g. 3=3), enter 3-month SAFE archive.
            // Clicking Done still archives immediately.
            // Return buckets (qty >= 9000) are excluded.
            const changed = applySafeArchiveState(item);
            global.saveTrackingData();

            if (item.autoArchivePending) {
                return res.send(`Solved (${item.remaining}/${item.quantity}). Safe archive until ${item.archiveEligibleAt}.`);
            }
            if (changed) {
                return res.send('Remaining updated. Safe archive cancelled (not complete).');
            }
            return res.send('Remaining quantity updated successfully.');
        } else {
            console.error(`Tracking number ${trackingNumber} not found.`);
            res.status(404).send('Tracking number not found');
        }
    });
}


function updateRemainingMin1(app) {
    app.post('/update-remaining', (req, res) => {
        console.log('--- Raw Request Debugging ---');
        console.log('Raw Request Body:', req.body);

        // Extract parameters from the request
        let { trackingNumber, serialNumber, newQuantity } = req.body;

        // Sanitize inputs
        trackingNumber = trackingNumber ? String(trackingNumber).trim() : null;
        serialNumber = serialNumber ? String(serialNumber).trim() : null;
        newQuantity = newQuantity !== undefined ? Number(newQuantity) : null;

        console.log('Received Parameters:');
        console.log('Tracking Number:', trackingNumber);
        console.log('Serial Number:', serialNumber);
        console.log('newQuantity:', newQuantity);

        // Validate parameters
        if (!trackingNumber || !serialNumber || newQuantity === null || newQuantity < 0) {
            console.log(`Missing or invalid parameters: trackingNumber = ${trackingNumber}, serialNumber = ${serialNumber}, newQuantity = ${newQuantity}`);
            console.log('Raw Request Body for Debugging:', JSON.stringify(req.body, null, 2));
            return res.status(400).send('Invalid or missing parameters');
        }

        console.log(`/update-remaining \n Request to update quantity and remaining for tracking number: ${trackingNumber}, serial number: ${serialNumber}`);

        // Fetch the tracking item
        const trackingItem = global.trackingData.find(item => item.trackingNumber === trackingNumber);

        if (trackingItem) {
            // Ensure devices array exists
            if (!Array.isArray(trackingItem.devices)) {
                trackingItem.devices = [];
            }

            // Check if serial number exists in devices
            const existingDevice = trackingItem.devices.find(device => device.serialNumber === serialNumber);

            if (existingDevice) {
                console.log(`/update-remaining \n Serial number ${serialNumber} already exists for tracking number ${trackingNumber}.`);
                return res.send(`Device with serial number ${serialNumber} is already in the system. Quantity and remaining were not updated.`);
            } else {
                // Add the serial number to the devices array (stamp the scan date)
                trackingItem.devices.push({ serialNumber, deviceDate: new Date().toISOString().slice(0, 10) });

                // Expected quantity comes from scanner script; remaining = scanned count (+1)
                trackingItem.quantity = newQuantity;
                trackingItem.remaining = Number(trackingItem.remaining || 0) + 1;

                // When remaining hits quantity (3=3), enter 3-month safe archive
                applySafeArchiveState(trackingItem);

                global.saveTrackingData();
                if (trackingItem.autoArchivePending) {
                    global.saveArchivedTrackingData(); // no-op for active, but keeps pattern consistent if later hooks save
                }

                console.log(`/update-remaining \n Added serial number ${serialNumber}, quantity=${trackingItem.quantity}, remaining=${trackingItem.remaining}, safePending=${!!trackingItem.autoArchivePending}`);
                if (trackingItem.autoArchivePending) {
                    return res.send(`Device added. Solved (${trackingItem.remaining}/${trackingItem.quantity}). Safe archive until ${trackingItem.archiveEligibleAt}.`);
                }
                return res.send(`Device with serial number ${serialNumber} added successfully. Quantity and remaining updated.`);
            }
        } else {
            console.log(`/update-remaining \n Tracking number ${trackingNumber} not found.`);
            return res.status(404).send('Tracking number not found');
        }
    });
}






















// COUNT DOWN FOR POWERSHELL
//function updateRemainingMin1(app) 
/*function updateRemainingMin1COUNTDOWN(app) {
app.post('/update-remaining', (req, res) => {
    // Extracts the tracking number and new quantity from the request body.
    const { trackingNumber, newQuantity } = req.body;

    console.log(`/update-remaining \n Request to update quantity for tracking number: ${trackingNumber} with new quantity: ${newQuantity}`);

    // Finds the index of the tracking item in the 'trackingData' array that matches the given tracking number.
    const index = trackingData.findIndex(item => item.trackingNumber === trackingNumber);

    // Checks if the tracking item was found (i.e., index is not -1).
    if (index !== -1) {
        // Logs the old quantity before updating
        console.log(`/update-remaining \n Old quantity for tracking number ${trackingNumber}: ${trackingData[index].remaining}`);

        // Updates the 'remaining' field of the found tracking item to the new quantity.
        // The new quantity is converted to a number to ensure the correct data type.
        trackingData[index].remaining = Number(newQuantity);

        // Saves the updated tracking data.
        saveTrackingData();

        // Sends a success message to the client.
        res.send('Quantity updated successfully');
    } else {
        // If the tracking number is not found in 'trackingData', logs the error and responds with a 404 status and an error message.
        console.log(`/update-remaining \n Tracking number ${trackingNumber} not found for quantity update.`);
        res.status(404).send('Tracking number not found');
        res.status(404).send('Tracking number not found');
    }
});
}
*/

//module.exports = { updateOrderNumber_serialNumber, updateDeviceOrderNumber, updateQuantityWEBMin1, updateRemainingWEB0ToArchive, updateRemainingMin1  };

module.exports = {
    updatedevice_SerialNumber_NoLimit,
    updateDevice,
	
    updateOrderNumber_serialNumber,
    updateDeviceOrderNumber,
    updateQuantityWEBMin1,
    updateRemainingWEB0ToArchive,
    updateRemainingMin1
};


/*
    Endpoint: /update-device
    Method: POST
    Purpose: To update details of an existing device or add a new device to the tracking system based on tracking and serial numbers.
    Functionality:
        Receives comprehensive device information via the request body.
        Searches for the tracking item with the given tracking number.
        If found, it either updates an existing device's details or adds a new device to the tracking item's devices array, depending on whether the device with the given serial number already exists.
        Saves the updated tracking data.
        Returns a success message for either updating or adding the device.
        If the tracking number is not found, it returns a 404 error with an appropriate message.
*/
/*
app.post('/update-device', upload.none(), (req, res) => {
    // Extracts device-related data from the request body.
    const { trackingNumber, serialNumber, model, cpu, ram, hd, windowsVersion, sku, notes, activationStatus, status, OrderNumber, API, Account, InAccount, Return_Reason, notApprovedReason } = req.body;

    // Finds the index of the tracking item in the 'trackingData' array that matches the given tracking number.
    const index = trackingData.findIndex(item => item.trackingNumber === trackingNumber);

    // Checks if the tracking item was found (i.e., index is not -1).
    if (index !== -1) {
        // Ensures the 'devices' array exists within the found tracking item.
        if (!trackingData[index].devices) {
            trackingData[index].devices = [];
        }

        // Finds the index of the device with the given serial number within the 'devices' array.
        const deviceIndex = trackingData[index].devices.findIndex(device => device.serialNumber === serialNumber);

        // Checks if the device already exists in the tracking data.
        if (deviceIndex !== -1) {
            // Updates the existing device's details.
            trackingData[index].devices[deviceIndex] = { serialNumber, model, cpu, ram, hd, windowsVersion, sku, notes, activationStatus, status, OrderNumber, API, Account, InAccount, Return_Reason, notApprovedReason };
            res.send('Device information updated successfully');
        } else {
            // Adds a new device to the 'devices' array if not found.
            const newDevice = { serialNumber, model, cpu, ram, hd, windowsVersion, sku, notes, activationStatus, status, OrderNumber, API, Account, InAccount, Return_Reason, notApprovedReason };
            trackingData[index].devices.push(newDevice);
            res.send('New device added successfully');
        }

        // Saves the updated tracking data.
        saveTrackingData();
    } else {
        // Responds with a 404 status and error message if the tracking number is not found.
        res.status(404).send('Tracking number not found');
    }
});

*/
//};