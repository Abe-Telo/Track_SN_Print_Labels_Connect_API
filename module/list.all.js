
function gettrackingdata(app) {
app.get('/get-tracking-data', (req, res) => {
    res.json(trackingData);
});
}


function getarchivedtrackingdata(app) {
// WEB Data is returned in XML unless you call it in html, Most likley can also be used to get in Powershell as XML
app.get('/archived-tracking-data', (req, res) => {
    res.json(archivedTrackingData);
});
}



function XMLlistalldevices(app) {
    // Define the route
    app.get('/list-all-devices', (req, res) => {
        try {
            const devices = listAllDevices(global.archivedTrackingData, global.trackingData);
            res.json(devices);
        } catch (error) {
            console.error(error);
            res.status(500).send('Error retrieving device data');
        }
    });

    app.get('/all-devices', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'all_devices.html'));
    });
}

function listAllDevices(archivedTrackingData, trackingData) {
    let allDevices = [];
    archivedTrackingData.concat(trackingData).forEach(entry => {
        if (entry.devices && entry.devices.length > 0) {
            allDevices = allDevices.concat(entry.devices);
        }
    });
    return allDevices;
}
 

module.exports = {
    gettrackingdata,
    getarchivedtrackingdata,
    listAllDevices,
    XMLlistalldevices
};