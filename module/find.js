module.exports = function(app) {
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
app.get('/get-archived-device-details/:trackingNumber', (req, res) => {
    const trackingNumber = req.params.trackingNumber;
    const item = archivedTrackingData.find(td => td.trackingNumber === trackingNumber);

    if (item) {
        res.json(item.devices);
    } else {
        res.status(404).send('Tracking number not found in archived data');
    }
});




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
app.get('/get-device-details/:trackingNumber', (req, res) => {
    const trackingNumber = req.params.trackingNumber;
    const item = trackingData.find(td => td.trackingNumber === trackingNumber);

    if (item) {
        res.json(item.devices);
    } else {
        res.status(404).send('Tracking number not found');
    }
});


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

// This is used for powershell, on the Device itself. 
app.get('/verify-tracking/:lastFourDigits', (req, res) => {
    // Retrieves the last four digits of a tracking number from the request URL.
    const lastFourDigits = req.params.lastFourDigits;

    // Gets the current week, presumably as a specific format or value.
    const currentWeek = getCurrentWeek();
    
    // Filters the 'trackingData' to find entries that match three conditions:
    // 1. The tracking number ends with the specified last four digits.
    // 2. The date of the tracking data falls within the current week.
    // 3. There are remaining items (i.e., 'remaining' is greater than 0).
    const matchedTrackings = trackingData.filter(td =>  
        td.trackingNumber.endsWith(lastFourDigits) &&
        isCurrentWeek(td.date, currentWeek) &&
        td.remaining > 0
    );

    // If there are matched tracking entries, it returns them as a JSON response.
    // Otherwise, it sends a 404 status with a message indicating no match found.
    if (matchedTrackings.length > 0) {
        res.json(matchedTrackings);
    } else {
        res.status(404).send('No matching tracking data found');
    }
});

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
app.get('/get-details-by-serial/:serialNumber', (req, res) => {
    const serialNumber = req.params.serialNumber.toLowerCase();

    // Search in active tracking data
    let device = trackingData.flatMap(td => td.devices)
                      .find(d => d.serialNumber.toLowerCase() === serialNumber);

    // If not found in active data, search in archived data
    if (!device) {
        device = archivedTrackingData.flatMap(td => td.devices)
                         .find(d => d.serialNumber.toLowerCase() === serialNumber);
    }

    if (device) {
        res.json(device);
    } else {
        res.status(404).send('Device not found');
    }
});

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
};