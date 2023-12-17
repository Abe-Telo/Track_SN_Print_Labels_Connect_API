const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');
//const printer = require('printer');
const { ThermalPrinter, PrinterTypes, CharacterSet, BreakLine } = require('node-thermal-printer')
const fs = require('fs');
 
//For printing and PDF Viewer 
const PDFDocument = require('pdfkit');
//const bwipjs = requirtrackingDatae('bwip-js');
const bwipjs = require('bwip-js');

const multer = require('multer');   
const upload = multer();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const dataFilePath = 'db/trackingData.json';
const archivedDataFilePath = 'db/archivedTrackingData.json';
const commentsFilePath = 'db/comments.json';
const updatesFilePath = 'db/updates.json';

const config = JSON.parse(fs.readFileSync('account/ShipStation.json', 'utf8'));
// Example: Selecting ShipStation credentials
const selectedBrand = 'ShipStation';  // This can be dynamically selected in the future
const selectedAccountIndex = 0;   // Index to select which account of the brand ETC 0,1,2,3,4
const credentials = config[selectedBrand][selectedAccountIndex];
const encodedCredentials = Buffer.from(`${credentials.api_key}:${credentials.api_secret}`).toString('base64'); // Encode API Key and Secret for Basic Auth

let trackingData = [];
let archivedTrackingData = [];
let commentsData = [];
let updatesData = [];

// Assigning data to global variables
global.trackingData = trackingData;
global.archivedTrackingData = archivedTrackingData;

// Load data from files...
global.trackingData = fs.existsSync(dataFilePath) ? JSON.parse(fs.readFileSync(dataFilePath, 'utf8')) : [];
global.archivedTrackingData = fs.existsSync(archivedDataFilePath) ? JSON.parse(fs.readFileSync(archivedDataFilePath, 'utf8')) : [];
// ... similarly for commentsData and updatesData ...

// Utility functions
global.saveTrackingData = function() {
    fs.writeFileSync(dataFilePath, JSON.stringify(global.trackingData, null, 2));
    console.log('Tracking data saved in trackingData.json');
};
global.saveArchivedTrackingData = function() {
    fs.writeFileSync(archivedDataFilePath, JSON.stringify(global.archivedTrackingData, null, 2));
    console.log('Saved in Archive DB');
};
// ... 


// Read tracking data
if (fs.existsSync(dataFilePath)) {
    const fileContent = fs.readFileSync(dataFilePath, 'utf8');
    trackingData = JSON.parse(fileContent);
}

// Read archived tracking data
if (fs.existsSync(archivedDataFilePath)) {
    const archivedFileContent = fs.readFileSync(archivedDataFilePath, 'utf8');
    archivedTrackingData = JSON.parse(archivedFileContent);
}

// Read comments
if (fs.existsSync(commentsFilePath)) {
    const commentsFileContent = fs.readFileSync(commentsFilePath, 'utf8');
    commentsData = JSON.parse(commentsFileContent);
}

// Read updates
if (fs.existsSync(updatesFilePath)) {
    const updatesFileContent = fs.readFileSync(updatesFilePath, 'utf8');
    updatesData = JSON.parse(updatesFileContent);
}

//---------------------------------------------------------------------
// List of blocked directories
const blockedDirectories = ['/account', '/db'];

app.use((req, res, next) => {
    const requestPath = req.path;
    // Check if the request is for a blocked directory
    if (blockedDirectories.some(dir => requestPath.startsWith(dir))) {
        return res.status(403).send('Access Denied');
    }
    next();
});
// This allows all files to be seen (Be careful) 
app.use(express.static(path.join(__dirname))); //
// --------------------------------------------------------------------------


function saveTrackingData() {    fs.writeFileSync(dataFilePath, JSON.stringify(trackingData, null, 2));    console.log('Tracking data saved in trackingData.json ');   }// Save tracking data to file
function saveArchivedTrackingData() {    fs.writeFileSync(archivedDataFilePath, JSON.stringify(archivedTrackingData, null, 2));       console.log('Saved in Archive DB'); }// Save tracking data to file    }// Save archived tracking data to file
function saveCommentsData() {    fs.writeFileSync(commentsFilePath, JSON.stringify(commentsData, null, 2));          }// Save comments to file
function saveUpdatesData() {    fs.writeFileSync(updatesFilePath, JSON.stringify(updatesData, null, 2));          }// Save updates to file


// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve the archive page
app.get('/archive', (req, res) => {
    res.sendFile(path.join(__dirname, 'archive.html'));
});

// Test if saves in DB, or if saves in memory, (Very Importnad) - At least find out exsaclty what this does. and where we use it. 
app.post('/add-tracking', upload.none(), (req, res) => {
    console.log("Received add-tracking request with data:", req.body);

    const { date, trackingNumber, quantity } = req.body;
    if (!date || !trackingNumber || !quantity) {
        console.error("Missing required fields");
        return res.status(400).send('Missing required fields');
    }
/*
    const newData = {
        date,
        trackingNumber,
        quantity: Number(quantity),
        remaining: Number(quantity),
        status: 'Active'
    };
*/
	
const newData = {
    date,
    trackingNumber,
    quantity: Number(quantity),
    remaining: Number(quantity),
    status: 'Active',
    devices: [] // New field to store device details
};

    trackingData.push(newData);
    console.log("New tracking data added:", newData);

    saveTrackingData();
    res.send('Tracking data added successfully');
});

	// The following is to be implemented and added. 
	//sold: Number(quantity),
	//ordernumber: Number(quantity),
	//Account, Wallmart API
	//Account API from shipping 
	// Idea is to add tracking number from one of those when selling.
	// Cerdenchals diffrent files. 
	



	
app.post('/add-device', upload.none(), (req, res) => {
    //const { trackingNumber, serialNumber, model, cpu, ram, hd, windowsVersion, sku, notes, activationStatus } = req.body; 
    const { trackingNumber, serialNumber, model, cpu, ram, hd, windowsVersion, sku, notes, activationStatus, status, OrderNumber, API, Account, InAccount, Return_Reason, notApprovedReason } = req.body;

    const index = trackingData.findIndex(item => item.trackingNumber === trackingNumber);

    if (index !== -1) {
        // Check if 'devices' array exists, if not initialize it
        if (!trackingData[index].devices) {
            trackingData[index].devices = [];
        }

        // Check if the device with the same serial number already exists
        const deviceIndex = trackingData[index].devices.findIndex(device => device.serialNumber === serialNumber);

        if (deviceIndex !== -1) {
            // Update existing device information
            trackingData[index].devices[deviceIndex] = { erialNumber, model, cpu, ram, hd, windowsVersion, sku, notes, activationStatus, status, OrderNumber, API, Account, InAccount, Return_Reason, notApprovedReason };
            res.send('Device information updated successfully');
        } else {
            // Add new device
            const newDevice = { serialNumber, model, cpu, ram, hd, windowsVersion, sku, notes, activationStatus };
            trackingData[index].devices.push(newDevice);
            res.send('New device added successfully');
        }

        saveTrackingData();
    } else {
        res.status(404).send('Tracking number not found');
    }
});










app.get('/get-tracking-data', (req, res) => {
    res.json(trackingData);
});

// WEB Data is returned in XML unless you call it in html, Most likley can also be used to get in Powershell as XML
app.get('/archived-tracking-data', (req, res) => {
    res.json(archivedTrackingData);
});



//const testRoutes = require('./module/test.js');
//testRoutes(app);



// WEB Data is returned in XML unless you call it in html, Most likley can also be used to get in Powershell as XML
app.get('/past-week-tracking-data', (req, res) => {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const pastWeekData = archivedTrackingData.filter(item => {
        const itemDate = new Date(item.date);
        return itemDate >= oneWeekAgo;
    });

    res.json(pastWeekData);
});








app.post('/delete-tracking', (req, res) => {
    const { trackingNumbersToDelete } = req.body;

    trackingData = trackingData.filter(item => !trackingNumbersToDelete.includes(item.trackingNumber));
    saveTrackingData();
    
    res.send('Tracking data deleted successfully');
});














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




//const add_to_DB = require('./module/add.to.db.js');
const find_DB = require('./module/find.js');
const update_DB = require('./module/update.db.js');

 
// Initialize your modules with the app instance
//add_to_DB(app);
find_DB(app);
update_DB(app);


const createPdf = require('./module/print.template.js');

function findDeviceBySerialNumber(serialNumber) {
    // Search in active tracking data (trackingData).
    let device = trackingData.flatMap(td => td.devices).find(d => d.serialNumber === serialNumber);

    // If a device is found in active tracking data, return it.
    if (device) return device;

    // If not found in active data, search in archived tracking data (archivedTrackingData).
    // Returns the found device, or undefined if not found.
    return archivedTrackingData.flatMap(td => td.devices).find(d => d.serialNumber === serialNumber);
}


// Endpoint to print label (PDF preview)
app.get('/print-label/:serialNumber', (req, res) => {
    // Extracts the serial number from the URL parameter.
    const serialNumber = req.params.serialNumber;

    // Finds the device associated with the provided serial number using the findDeviceBySerialNumber function.
    let device = findDeviceBySerialNumber(serialNumber);

    // Checks if the device was found.
    if (device) {
        // Sets HTTP response headers to indicate that the content type is PDF and 
        // the disposition is inline (displayed within the browser), with a suggested filename.
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="' + serialNumber + '.pdf"');

        // Calls a function createPdf, passing the device object and the response stream.
        // This function is responsible for generating the PDF and writing it to the response.
        createPdf(device, res);
    } else {
        // If the device is not found, sends a 404 error with an appropriate message.
        res.status(404).send('Device not found');
    }
});

 
 
 
app.get('/preview-label/:serialNumber', (req, res) => {
    const serialNumber = req.params.serialNumber;
    let device = findDeviceBySerialNumber(serialNumber);

    if (device) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="' + device.serialNumber + '.pdf"');
        createPdf(device, res);
    } else {
        res.status(404).send('Device not found');
    }
});

//PDF.js
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));


function printPdf(filePath) {
    try {
        const data = fs.readFileSync(filePath);
        printer.printDirect({
            data: data,
            printer: 'name_of_your_printer', // Use printer name or leave it undefined to use the default printer
            type: 'PDF',
            success: function (jobID) {
                console.log("Print job submitted, ID:", jobID);
            },
            error: function (err) {
                console.error('Print error:', err);
            }
        });
    } catch (err) {
        console.error('Error reading file for printing:', err);
    }
}
 
// In your Express route definitions

app.get('/print-document/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'path-to-pdf-files', filename);

    try {
        printPdf(filePath);
        res.send('Print job submitted');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error submitting print job');
    }
});
 
 
 

function getCurrentWeek() {
    // Implement logic to get the current week number
    return new Date().getWeek();
}

function isCurrentWeek(dateString, currentWeek) {
    const date = new Date(dateString);
    return date.getWeek() === currentWeek;
}

Date.prototype.getWeek = function() {
    const firstDayOfYear = new Date(this.getFullYear(), 0, 1);
    const pastDaysOfYear = (this - firstDayOfYear) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
};

 

// Function to read or initialize data
function initializeData(filePath, defaultValue = []) {
    if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(fileContent);
    } else {
        fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
        return defaultValue;
    }
}

trackingData = initializeData(dataFilePath);
archivedTrackingData = initializeData(archivedDataFilePath);
commentsData = initializeData(commentsFilePath);
updatesData = initializeData(updatesFilePath);


  


 
 



// Endpoint to submit comments
app.post('/submit_comment', (req, res) => {
    const comment = req.body.comment;
    const filePath = 'comments.json';

    updateFile(filePath, comment, res);
});


app.post('/add_update', (req, res) => {
    const update = req.body.update;
    updatesData.push(update); // Add the new update to the updates array
    // Asynchronously save updates to the updates.json file
    fs.writeFile(updatesFilePath, JSON.stringify(updatesData, null, 2), (writeErr) => {
        if (writeErr) {
            res.status(500).send({ message: 'Error saving update' });
        } else {
            res.send({ message: 'Update added successfully' });
        }
    });
});

// Endpoint to get comments
app.get('/get_comments', (req, res) => {
    const filePath = 'db/comments.json';
    readFile(filePath, res);
});

 
 

function updateFile(filePath, content, res) {
    fs.readFile(`db/${filePath}`, (err, data) => {
        if (err) {
            res.status(500).send({ message: 'Error reading file' });
        } else {
            let json = JSON.parse(data);
            json.push(content);
            fs.writeFile(`db/${filePath}`, JSON.stringify(json, null, 2), (writeErr) => {
                if (writeErr) {
                    res.status(500).send({ message: 'Error writing to file' });
                } else {
                    res.send({ message: 'Successfully updated' });
                }
            });
        }
    });
}

function readFile(filePath, res) {
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.status(500).send({ message: 'Error reading file' });
        } else {
            res.send(JSON.parse(data));
        }
    });
}


// Endpoint to get updates
app.get('/get_updates', (req, res) => {
    const filePath = 'db/updates.json';
    readFile(filePath, res);
});






// ShipStation API Start 
const createOrUpdateOrder = async (orderData) => {
    try {
        const response = await axios.post('https://ssapi.shipstation.com/orders/createorder', orderData, {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error creating/updating order:', error.response ? error.response.data : error.message);
    }
};
 
// Function to make GET request to ShipStation
const getShipStationData = async (endpoint) => {
    try {
        const response = await axios.get(`https://ssapi.shipstation.com/${endpoint}`, {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`
            }
        });
        return response.data;
    } catch (error) {
        return error.response.data;
    }
};

// Function to get order by orderNumber
const getOrder = async (orderNumber) => {
    try {
        const response = await axios.get(`https://ssapi.shipstation.com/orders?orderNumber=${orderNumber}`, {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`,
                'Content-Type': 'application/json'
            }
        });
        if (response.data && response.data.orders && response.data.orders.length > 0) {
            console.log("Fetched Order:", response.data.orders[0]);  // Log the fetched order
            return response.data.orders[0];
        } else {
            console.log("No order found with number:", orderNumber);  // Log if no order is found
            return null;
        }
    } catch (error) {
        console.error("Error fetching order:", error.response ? error.response.data : error.message);
        return null;
    }
};


// Function to update an order's internal notes and custom fields in ShipStation
const updateOrderFields = async (orderNumber, internalNotes, customField1, customField2, customField3) => {
    try {
        // Retrieve the existing order
        const existingOrder = await getOrder(orderNumber);
        if (!existingOrder || ['shipped', 'cancelled'].includes(existingOrder.orderStatus)) {
            throw new Error('Order not found or cannot be updated');
        }

        // Update the internalNotes and custom fields within advancedOptions of the existing order
        const updatedOrder = { 
            ...existingOrder, 
            internalNotes: internalNotes,
            advancedOptions: {
                ...existingOrder.advancedOptions,
                customField1: customField1,
                customField2: customField2, // Reserved For Ezra
                customField3: customField3
            }
        };

        // Send the update request
        const response = await axios.post('https://ssapi.shipstation.com/orders/createorder', updatedOrder, {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error updating order:', error.response ? error.response.data : error.message);
        throw error; // Rethrow the error for further handling
    }
};


app.post('/update-order-fields', async (req, res) => {
    const { orderNumber, internalNotes, customField1, customField2, customField3 } = req.body;

    if (!orderNumber) {
        return res.status(400).send({ message: 'Order number is required.' });
    }

    try {
        const response = await updateOrderFields(orderNumber, internalNotes, customField1, customField2, customField3);
        res.send(response);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.get('/get-order-full/:orderNumber', async (req, res) => { // Full No restriction
    try {
        const orderNumber = req.params.orderNumber;
        const orderData = await getOrder(orderNumber);

        if (!orderData) {
            return res.status(404).send({ message: 'Order not found' });
        }

        res.json(orderData);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

app.get('/get-order/:orderNumber', async (req, res) => {
    try {
        const orderNumber = req.params.orderNumber;
        const orderData = await getOrder(orderNumber);

        if (!orderData) {
            return res.status(404).send({ message: 'Order not found' });
        }

        // Extracting specific fields from the order
        const extractedData = {
            orderStatus: orderData.orderStatus,
            shipTo: orderData.shipTo,
            items: orderData.items, // Assuming you want all items details
            customerNotes: orderData.customerNotes,
            internalNotes: orderData.internalNotes,
            gift: orderData.gift,
            giftMessage: orderData.giftMessage,
            requestedShippingService: orderData.requestedShippingService,
            carrierCode: orderData.carrierCode,
            serviceCode: orderData.serviceCode,
            packageCode: orderData.packageCode,
            confirmation: orderData.confirmation,
            shipDate: orderData.shipDate,
            holdUntilDate: orderData.holdUntilDate,
            storeId: orderData.storeId,
            source: orderData.source,
            userId: orderData.userId,
            externallyFulfilled: orderData.externallyFulfilled,
            externallyFulfilledBy: orderData.externallyFulfilledBy,
            externallyFulfilledById: orderData.externallyFulfilledById,
            externallyFulfilledByName: orderData.externallyFulfilledByName,
            labelMessages: orderData.labelMessages
        };

        res.json(extractedData);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});


app.post('/update-device-details/:serialNumber', (req, res) => {
    const serialNumber = req.params.serialNumber;
    const updatedData = req.body;

    let deviceFound = false;
    trackingData.forEach(trackingItem => {
        const deviceIndex = trackingItem.devices.findIndex(d => d.serialNumber === serialNumber);
        if (deviceIndex !== -1) {
            trackingItem.devices[deviceIndex] = { ...trackingItem.devices[deviceIndex], ...updatedData };
            deviceFound = true;
        }
    });

    if (deviceFound) {
        saveTrackingData();
        res.send('Device details updated successfully');
    } else {
        res.status(404).send('Device not found');
    }
});


 
 
// ShipStation API END


const PORT = 3000;
//app.listen(PORT, () => {
//    console.log(`Server is running on port ${PORT}`);
//});


app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
