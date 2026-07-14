

/*
app.get('/search', (req, res) => {
    const searchTerm = req.query.term.toLowerCase();

const filteredTrackingData = trackingData.filter(item => 
    item.trackingNumber.includes(searchTerm) ||
    (Array.isArray(item.devices) && item.devices.some(device => 
        device.serialNumber.toLowerCase().includes(searchTerm) ||
        device.model.toLowerCase().includes(searchTerm)
    ))
);


const filteredArchivedData = archivedTrackingData.filter(item => 
    item.trackingNumber.includes(searchTerm) ||
    (Array.isArray(item.devices) && item.devices.some(device => 
        device.serialNumber.toLowerCase().includes(searchTerm) ||
        device.model.toLowerCase().includes(searchTerm)
    ))
);


    const combinedResults = [...filteredTrackingData, ...filteredArchivedData];
    res.json(combinedResults);
});
*/


/*  Endpoint: /search
    Method: GET
    Purpose: To search through both active and archived tracking data for items that match a given search term.
    Functionality:
      Accepts a search term via query parameters.
      Searches through both trackingData and archivedTrackingData.
      Looks for matches in tracking numbers, and within device arrays, checks device serial numbers and models.
      Adds a flag (isArchived) to distinguish between active and archived data in the results.
      Returns a combined list of matching items from both data sets.		*/

function searchTrackingModel(app) {

app.get('/search', (req, res) => {
    // Extracts and converts the search term to lowercase for case-insensitive searching.
    const searchTerm = req.query.term.toLowerCase();

    // Filters the active tracking data (trackingData) for items that match the search term.
    // The search covers tracking numbers and, within each item's devices array, device serial numbers and models.
    const filteredTrackingData = trackingData.filter(item =>
        item.trackingNumber.includes(searchTerm) ||
        (Array.isArray(item.devices) && item.devices.some(device =>
            device.serialNumber.toLowerCase().includes(searchTerm) ||
            device.model.toLowerCase().includes(searchTerm)
        ))
    ).map(item => ({ ...item, isArchived: false })); // Marks these items as not archived.

    // Performs a similar filter on the archived tracking data (archivedTrackingData).
    const filteredArchivedData = archivedTrackingData.filter(item =>
        item.trackingNumber.includes(searchTerm) ||
        (Array.isArray(item.devices) && item.devices.some(device =>
            device.serialNumber.toLowerCase().includes(searchTerm) ||
            device.model.toLowerCase().includes(searchTerm)
        ))
    ).map(item => ({ ...item, isArchived: true })); // Marks these items as archived.

    // Combines the filtered results from both active and archived data.
    const combinedResults = [...filteredTrackingData, ...filteredArchivedData];

    // Sends the combined results back to the client in JSON format.
    res.json(combinedResults);
});
}

module.exports = {
    searchTrackingModel
};