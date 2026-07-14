
function delete_tracking(app) {
app.post('/delete-tracking', (req, res) => {
    const { trackingNumbersToDelete } = req.body;

    trackingData = trackingData.filter(item => !trackingNumbersToDelete.includes(item.trackingNumber));
    saveTrackingData();
    
    res.send('Tracking data deleted successfully');
});
}

function delete_archived_tracking(app) {
app.post('/delete-archived-tracking', (req, res) => {
    const { trackingNumbersToDelete } = req.body;

    // Filter out the entries to be deleted from the archivedTrackingData
    archivedTrackingData = archivedTrackingData.filter(item => !trackingNumbersToDelete.includes(item.trackingNumber));
    saveArchivedTrackingData();
    
    res.send('Archived tracking data deleted successfully');
});
}

function delete_single_device(app) {
app.delete('/delete_single_device/:serialNumber', (req, res) => {
    const serialNumber = req.params.serialNumber.toLowerCase();
    let deviceFound = false;

    // Remove the device from trackingData or archivedTrackingData
    [global.trackingData, global.archivedTrackingData].forEach(dataArray => {
        dataArray.forEach(trackingItem => {
            const deviceIndex = trackingItem.devices.findIndex(d => 
                d.serialNumber.toLowerCase() === serialNumber);
            if (deviceIndex !== -1) {
                trackingItem.devices.splice(deviceIndex, 1); // Remove the device
                deviceFound = true;
                // Depending on where it was found, save the corresponding data
                if (dataArray === global.trackingData) {
                    global.saveTrackingData();
                } else {
                    global.saveArchivedTrackingData();
                }
            }
        });
    });

    if (deviceFound) {
        res.send('Device deleted successfully');
    } else {
        res.status(404).send('Device not found');
    }
});
}


module.exports = {
    delete_tracking,
    delete_archived_tracking,
    delete_single_device
};