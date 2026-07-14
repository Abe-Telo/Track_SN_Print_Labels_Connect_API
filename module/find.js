 

/*
   '/get-archived-device-details/:trackingNumber' Endpoint Overview:

   - Purpose: Retrieves device details for a given tracking number from archived tracking data.
   - Request Type: GET.
   - Parameter: 'trackingNumber' from URL.
   - Data Source: 'archivedTrackingData', an array-like collection of archived tracking items.
   - Functionality: 
       1. Extracts 'trackingNumber' from the URL.
       2. Searches 'archivedTrackingData' for a matching 'trackingNumber'.
       3. If found, returns the associated device details in JSON format.
       4. If not found, sends a 404 error with 'Tracking number not found in archived data'.
*/
function getArchivedDeviceDetails_trackingNumber(app) {
app.get('/get-archived-device-details/:trackingNumber', (req, res) => {
    const trackingNumber = req.params.trackingNumber;
    const item = archivedTrackingData.find(td => td.trackingNumber === trackingNumber);

    if (item) {
        res.json(item.devices);
    } else {
        res.status(404).send('Tracking number not found in archived data');
    }
});
}


 /*
   '/get-device-details/:trackingNumber' Endpoint Overview:

   - Purpose: Retrieves device details associated with a specific tracking number from active tracking data.
   - Request Type: GET.
   - Parameter: 'trackingNumber' from URL.
   - Data Source: 'trackingData', an array-like collection with tracking information.
   - Functionality: 
       1. Extracts 'trackingNumber' from the URL.
       2. Searches 'trackingData' for an item with a matching 'trackingNumber'.
       3. If found, returns device details in JSON format.
       4. If not found, sends a 404 error with a message 'Tracking number not found'.
*/
function getDeviceDetails_trackingnumber(app) {
app.get('/get-device-details/:trackingNumber', (req, res) => {
    const trackingNumber = req.params.trackingNumber;
    const item = trackingData.find(td => td.trackingNumber === trackingNumber);

    if (item) {
        res.json(item.devices);
    } else {
        res.status(404).send('Tracking number not found');
    }
});
}


/* 
app.get('/get-device-details/:trackingNumber', (req, res) => {
    // Extracts the trackingNumber from the request URL.
    const trackingNumber = req.params.trackingNumber;

    // Calls the function getDeviceDetailsByTrackingNumber with the extracted trackingNumber.
    // This function is expected to return an array of device details for the given tracking number.
    const deviceDetails = getDeviceDetailsByTrackingNumber(trackingNumber);

    // Sends the array of device details as a JSON response to the client.
    res.json(deviceDetails);
});

// Assuming you have a function to get device details by tracking number
function getDeviceDetailsByTrackingNumber(trackingNumber) {
    // Replace this with actual logic to fetch device details from your data store
    return []; // This should return an array of device details
}
*/
function verifytracking_lastFour(app) {
    // This is used for PowerShell, on the Device itself. 
    app.get('/verify-tracking/:lastFourDigits', (req, res) => {
        const lastFourDigits = req.params.lastFourDigits.trim();

        // Validate length
        if (lastFourDigits.length < 4 || lastFourDigits.length > 8) {
            return res.status(400).send('Tracking digits must be between 4 and 8 characters');
        }

        // Add debug logs
        console.log(`Searching for tracking numbers ending with: "${lastFourDigits}"`);

        // Filter for matching tracking numbers
        const matchedTrackings = trackingData.filter(td => {
            const trackingEndsWith = td.trackingNumber.slice(-lastFourDigits.length) === lastFourDigits;

            // Check for remaining > 0 condition (commented out)
            // const hasRemaining = td.remaining > 0;

            console.log(`Checking: ${td.trackingNumber}, Ends With "${lastFourDigits}": ${trackingEndsWith}`);

            // Commented out remaining > 0 to include entries with remaining = 0
            return trackingEndsWith; // && hasRemaining;
        });

        // Return matched trackings or error message
        if (matchedTrackings.length > 0) {
            console.log("Matched Tracking Entries:", matchedTrackings);
            res.json(matchedTrackings);
        } else {
            console.log(`No matching tracking data found for last four digits: "${lastFourDigits}"`);
            res.status(404).send('No matching tracking data found');
        }
    });
}


/*
   '/get-details-by-serial/:serialNumber' Endpoint Overview:

   - Purpose: Retrieves details of a device using its serial number from either active or archived tracking data.
   - Request Type: GET.
   - Parameter: 'serialNumber' from URL, handled case-insensitively.
   - Data Sources: 
       1. 'trackingData' - Active tracking data.
       2. 'archivedTrackingData' - Archived tracking data.
   - Functionality: 
       1. Converts 'serialNumber' to lowercase for case-insensitive search.
       2. First searches in 'trackingData'. If not found, searches in 'archivedTrackingData'.
       3. Returns device details in JSON format if found.
       4. Sends a 404 error with 'Device not found' if no matching device is found in either data source.
*/

// Search device by Serial Number
function getdetailsby_serialnumber(app) {
    app.get('/get-details-by-serial/:serialNumber', (req, res) => {
        const serialNumber = req.params.serialNumber;

        // Validate the input serialNumber
        if (!serialNumber) {
            console.error("Serial number is missing or undefined.");
            return res.status(400).send('Serial number is required');
        }

        const serialNumberLower = serialNumber.toLowerCase(); // Convert to lowercase for case-insensitive comparison
        const combinedTrackingData = [...trackingData, ...archivedTrackingData];

        // Search for devices in both trackingData and archivedTrackingData
        let deviceDetails = combinedTrackingData.flatMap(trackingEntry =>
            (trackingEntry.devices || []).filter(device =>
                device.serialNumber && device.serialNumber.toLowerCase() === serialNumberLower
            ).map(device => ({
                ...device,
                InternalTrackingNumber: trackingEntry.InternalTrackingNumber || trackingEntry.trackingNumber,
                InternalTrackingDate: trackingEntry.date,
                InternalTrackingQuantity: trackingEntry.quantity,
                InternalTrackingRemaining: trackingEntry.remaining
            }))
        );

        if (deviceDetails.length > 0) {
            res.json(deviceDetails[0]); // Assuming only one device per serial number
        } else {
            console.log(`Device not found for serial number: ${serialNumber}`);
            res.status(404).send('Device not found');
        }
    });
}



function getdetailsby_orderNumber(app) {
app.get('/get-details-by-order/:orderNumber', (req, res) => {
    const orderNumber = req.params.orderNumber;
    const combinedTrackingData = [...trackingData, ...archivedTrackingData];

    const devicesMatchingOrderNumber = combinedTrackingData.flatMap(trackingEntry =>
        (trackingEntry.devices || []).map(device => ({
            ...device,
            InternalTrackingNumber: trackingEntry.trackingNumber, // Attach InternalTrackingNumber from the parent tracking entry
            InternalTrackingDate: trackingEntry.date, // Attach InternalTrackingNumber from the parent tracking entry
            InternalTrackingQuantity: trackingEntry.quantity, // Attach InternalTrackingNumber from the parent tracking entry
            InternalTrackingRemaining: trackingEntry.remaining, // Attach InternalTrackingNumber from the parent tracking entry
            // Include any other trackingEntry fields you want to attach to each device
        })).filter(device =>
            device.OrderNumber === orderNumber
        )
    );

    if (devicesMatchingOrderNumber.length > 0) {
        res.json(devicesMatchingOrderNumber);
    } else {
        res.status(404).send('No devices found for the provided order number');
    }
});
}

/* Just added new.
app.get('/find-tracking-by-serial/:serialNumber', (req, res) => {
    // Extracts the serial number from the request URL.
    const serialNumber = req.params.serialNumber;

    // Initializes a variable to hold the tracking number.
    let trackingNumber = null;

    // Iterates through each item in 'trackingData'.
    trackingData.forEach(item => {
        // Looks for a device within the 'devices' array of the current tracking item that matches the serial number.
        const foundDevice = item.devices.find(device => device.serialNumber === serialNumber);

        // If a device is found, assigns its corresponding tracking number to the 'trackingNumber' variable.
        if (foundDevice) {
            trackingNumber = item.trackingNumber;
        }
    });

    // If a matching tracking number is found, returns it in JSON format.
    // If not, sends a 404 status with a message indicating the serial number was not found.
    if (trackingNumber) {
        res.json({ trackingNumber });
    } else {
        res.status(404).send('Serial number not found');
    }
});

*/

/*
app.get('/verify-tracking/:lastFourDigits', (req, res) => {
    const lastFourDigits = req.params.lastFourDigits;
    const currentWeek = getCurrentWeek();
    
    const matchedTrackings = trackingData.filter(td =>  
        td.trackingNumber.endsWith(lastFourDigits) &&
        isCurrentWeek(td.date, currentWeek) &&
        td.remaining > 0
    );

    if (matchedTrackings.length > 0) {
        // Send back the full tracking numbers
        const fullTrackingNumbers = matchedTrackings.map(td => td.trackingNumber);
        res.json(fullTrackingNumbers);
    } else {
        res.status(404).send('No matching tracking data found');
    }
});
*/


module.exports = { 
	//gettrackingdata, 
	//getarchivedtrackingdata, 
	getArchivedDeviceDetails_trackingNumber, 
	getDeviceDetails_trackingnumber, 
	getDeviceDetails_trackingnumber,
	verifytracking_lastFour,
	getdetailsby_serialnumber,
	getdetailsby_orderNumber};
