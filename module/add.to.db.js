const multer = require('multer');
const upload = multer(); // Basic setup, customize as needed
const util = require('util'); //  makes array a one liner. 
const play = require('play-sound')();
//const play = require('play-sound')({ player: "'./beep.mp3" }); // Replace with the actual path to mpg123
const { exec } = require('child_process');
// ... your existing code ...
 
const fs = require('fs');

	// The following is to be implemented and added. 
	//sold: Number(quantity),
	//ordernumber: Number(quantity),
	//Account, Wallmart API
	//Account API from shipping 
	// Idea is to add tracking number from one of those when selling.
	// Cerdenchals diffrent files. 
	
//function playErrorSound() {
//    var audio = new Audio('./beep.mp3'); // Path to your error sound file
//    audio.play();
//}

function playErrorSound() {
exec('mpg123 ./beep.mp3', (err, stdout, stderr) => {
    if (err) {
        // handle error
        console.log(`Error playing sound: ${err}`);
        return;
    }
    // Sound played successfully
});
}
	
function addTracking(app) {
// Test if saves in DB, or if saves in memory, (Very Importnad) - At least find out exsaclty what this does. and where we use it. 
app.post('/add-tracking', upload.none(), (req, res) => {
    //console.log("New tracking Number addded:", req.body); 
        // Construct a log string with colored formatting for each value in one liner Instead of a full array. 
        const logString = Object.entries(req.body)
                                .map(([key, value]) => `${key}: ${util.inspect(value, { colors: true, depth: null })}`)
                                .join(', ');
        console.log(`New tracking Number added: { ${logString} }`); 

    const { date, trackingNumber, quantity } = req.body
	
	
	        // Check if tracking number already exists
        const trackingExists = trackingData.some(entry => entry.trackingNumber === trackingNumber);
        if (trackingExists) {
            console.warn(`Warning: Tracking number ${trackingNumber} already exists.`);
            
            // Play an error sound on the server
            
        //playErrorSound();
			//play.play('beep.mp3', function(err){
            ///    if (err) console.log(`Could not play sound: ${err}`);
            //});

            return res.status(400).send(`Tracking number ${trackingNumber} already exists.`);
        }
	
    if (!date || !trackingNumber || !quantity) {
        console.error("Missing required fields");
        return res.status(400).send('Missing required fields');
    }
	
const newData = {
    date,
    trackingNumber,
    quantity: Number(quantity),
    remaining: 0, // starts at 0; PS/CMD +1 per scanned device until remaining === quantity
    status: 'Active',
    devices: [] // New field to store device details
};

    trackingData.push(newData);
    //console.log("New tracking data added:", newData);
    //console.log("New tracking data added:", newData);

    saveTrackingData();
    res.send('Tracking data added successfully');
});
}
//Number(quantity)

function addDevice(app) {
    app.post('/add-device', upload.none(), (req, res) => {
        const { trackingNumber, serialNumber, model, cpu, ram, hd, windowsVersion, sku, notes, activationStatus, status, OrderNumber, API, Account, InAccount, Return_Reason, notApprovedReason, deviceDate } = req.body;

        // Add today's date as default if deviceDate is not provided
        const currentDate = new Date().toISOString().slice(0, 10);
        const deviceDateFinal = deviceDate || currentDate;

        const index = trackingData.findIndex(item => item.trackingNumber === trackingNumber);

        if (index !== -1) {
            // Check if 'devices' array exists, if not initialize it
            if (!trackingData[index].devices) {
                trackingData[index].devices = [];
            }

            // Check if the device with the same serial number already exists
            const deviceIndex = trackingData[index].devices.findIndex(device => device.serialNumber === serialNumber);

            if (deviceIndex !== -1) {
                // Update existing device information; keep the original scan date if one exists
                const existingDate = trackingData[index].devices[deviceIndex].deviceDate;
                trackingData[index].devices[deviceIndex] = { serialNumber, model, cpu, ram, hd, windowsVersion, sku, notes, activationStatus, status, OrderNumber, API, Account, InAccount, Return_Reason, notApprovedReason, deviceDate: deviceDate || existingDate || deviceDateFinal };
                res.send('Device information updated successfully');
            } else {
                // Add new device, including the date
                const newDevice = { serialNumber, model, cpu, ram, hd, windowsVersion, sku, notes, activationStatus, status, OrderNumber, API, Account, InAccount, Return_Reason, notApprovedReason, deviceDate: deviceDateFinal };
                trackingData[index].devices.push(newDevice);
                res.send('New device added successfully');
            }

            saveTrackingData();
        } else {
            res.status(404).send('Tracking number not found');
        }
    });
}


module.exports = {
    addTracking,
	addDevice
};