module.exports = function(app) {


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
app.post('/update-remainingWEB', (req, res) => {
    // Extracts the tracking number and new quantity from the request body.
    const { trackingNumber, newQuantity } = req.body;

    // Finds the index of the tracking item in the 'trackingData' array that matches the given tracking number.
    const index = trackingData.findIndex(item => item.trackingNumber === trackingNumber);

    // Checks if the tracking item was found (i.e., index is not -1).
    if (index !== -1) {
        // Updates the 'remaining' field of the found tracking item to the new quantity.
        trackingData[index].remaining = Number(newQuantity);

        // Checks if the remaining quantity is 0.
        if (trackingData[index].remaining === 0) {
            // If remaining is 0, moves the item to the archived data.
            archivedTrackingData.push(trackingData[index]);
            saveArchivedTrackingData(); // Saves the updated archived tracking data.

            // Removes the item from active tracking data.
            trackingData.splice(index, 1);
        }

        // Saves the updated active tracking data.
        saveTrackingData();

        // Responds with a success message.
        res.send('remaining updated successfully');
    } else {
        // If the tracking number is not found in 'trackingData', responds with a 404 status and an error message.
        res.status(404).send('Tracking number not found');
    }
});

/*
    Endpoint: /update-remaining
    Method: POST
    Purpose: To update the remaining quantity of an item tracked under a specific tracking number.
    Functionality:
        Receives a tracking number and a new remaining quantity via the request body.
        Searches for the tracking item with the given tracking number.
        If found, updates its remaining quantity to the new value and saves the updated tracking data.
        Returns a success message if the update is successful.
        If the tracking number is not found, returns a 404 error with an appropriate message.
*/
app.post('/update-remaining', (req, res) => {
    // Extracts the tracking number and new quantity from the request body.
    const { trackingNumber, newQuantity } = req.body;

    // Finds the index of the tracking item in the 'trackingData' array that matches the given tracking number.
    const index = trackingData.findIndex(item => item.trackingNumber === trackingNumber);

    // Checks if the tracking item was found (i.e., index is not -1).
    if (index !== -1) {
        // Updates the 'remaining' field of the found tracking item to the new quantity.
        // The new quantity is converted to a number to ensure the correct data type.
        trackingData[index].remaining = Number(newQuantity);

        // Saves the updated tracking data.
        saveTrackingData();

        // Sends a success message to the client.
        res.send('Quantity updated successfully');
    } else {
        // If the tracking number is not found in 'trackingData', responds with a 404 status and an error message.
        res.status(404).send('Tracking number not found');
    }
});


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
};