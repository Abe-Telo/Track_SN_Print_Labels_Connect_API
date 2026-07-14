const express = require('express');
const session = require('express-session');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');
const setupLogin = require('./module/login');


const { ThermalPrinter, PrinterTypes, CharacterSet, BreakLine } = require('node-thermal-printer')
const fs = require('fs');
 
//For printing and PDF Viewer 
const PDFDocument = require('pdfkit');
//const bwipjs = requirtrackingDatae('bwip-js');
const bwipjs = require('bwip-js');
const chalk = require('chalk'); // Assuming you are using chalk for colored logs

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

const { atomicWriteJsonSync } = require('./module/atomic_json.js');

const config = JSON.parse(fs.readFileSync('account/ShipStation.json', 'utf8'));
// Example: Selecting ShipStation credentials
const selectedBrand = 'ShipStation';  // This can be dynamically selected in the future
const selectedAccountIndex = 0;   // Index to select which account of the brand ETC 0,1,2,3,4
const credentials = config[selectedBrand][selectedAccountIndex];
const encodedCredentials = Buffer.from(`${credentials.api_key}:${credentials.api_secret}`).toString('base64'); // Encode API Key and Secret for Basic Auth



// Setup login routes
setupLogin(app); // /module/login
// LOGIN ROUTE ENDED 

// --------------------------------------------------------------------------
// Single source of truth for tracking data (shared with modules via global.*)
// Do NOT keep a separate local copy — that caused silent desync.
// --------------------------------------------------------------------------
function initializeData(filePath, defaultValue = []) {
    if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(fileContent);
    }
    atomicWriteJsonSync(filePath, defaultValue);
    return defaultValue;
}

global.trackingData = initializeData(dataFilePath);
global.archivedTrackingData = initializeData(archivedDataFilePath);
global.commentsData = initializeData(commentsFilePath);
global.updatesData = initializeData(updatesFilePath);

// NOTE: No local let/var copies. Bare names in this file and in modules
// resolve to global.* so there is only one in-memory array each.

global.saveTrackingData = function() {
    atomicWriteJsonSync(dataFilePath, global.trackingData);
};

global.saveArchivedTrackingData = function() {
    atomicWriteJsonSync(archivedDataFilePath, global.archivedTrackingData);
};

global.saveCommentsData = function() {
    atomicWriteJsonSync(commentsFilePath, global.commentsData);
};

global.saveUpdatesData = function() {
    atomicWriteJsonSync(updatesFilePath, global.updatesData);
};

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

// --------------------------------------------------------------------------
// Static files: allowlist only (do NOT expose whole app tree).
// Keeps Full Connection / remote clients working:
//   UI folders, Downloads (USB updates), ps/ scripts, print previews, beep, labels.
// Server source (add.js, module/, backups, package.json, etc.) is NOT web-served.
// --------------------------------------------------------------------------
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/media', express.static(path.join(__dirname, 'media')));
app.use('/Downloads', express.static(path.join(__dirname, 'Downloads')));
app.use('/ps', express.static(path.join(__dirname, 'ps')));
app.use('/print', express.static(path.join(__dirname, 'print')));
app.use('/html', express.static(path.join(__dirname, 'html')));
app.use('/pdf', express.static(path.join(__dirname, 'pdf')));

// Root-level assets the browser UI still loads by absolute/relative path
['beep.mp3', 'beep-1-sec-6162.mp3', 'Labeltemplate.dymo', 'label.pdf', 'label-preview.pdf'].forEach((fileName) => {
    app.get('/' + fileName, (req, res) => {
        res.sendFile(path.join(__dirname, fileName));
    });
});
// --------------------------------------------------------------------------


// Local wrappers so any call site using bare save* hits the atomic global savers.
function saveTrackingData() { global.saveTrackingData(); }
function saveArchivedTrackingData() { global.saveArchivedTrackingData(); }
function saveCommentsData() { global.saveCommentsData(); }
function saveUpdatesData() { global.saveUpdatesData(); }





// Let all HTML files in the dir html work as root dir.
app.use(express.static(path.join(__dirname, 'html')));

// Default route for the main page (optional)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'html/index.html'));
});

// Serve the archive page
app.get('/archive', (req, res) => {
    res.sendFile(path.join(__dirname, 'html/archive.html'));
});


// Import the key module
const { AddproductKey } = require('./module/key.js');
AddproductKey(app);


const { 
    addTracking,  
    addDevice } = require('./module/add.to.db.js');
	
addTracking(app);
addDevice(app); 

const { 
    //gettrackingdata, 
    //getarchivedtrackingdata, 
    getDeviceDetails_trackingnumber, 
    getArchivedDeviceDetails_trackingNumber, 
    verifytracking_lastFour, 
    getdetailsby_serialnumber,
    getdetailsby_orderNumber} = require('./module/find.js');
getDeviceDetails_trackingnumber(app);
getArchivedDeviceDetails_trackingNumber(app);
verifytracking_lastFour(app);
getdetailsby_serialnumber(app);
getdetailsby_orderNumber(app);

const { 
    updatedevice_SerialNumber_NoLimit, 
    updateDevice, 
    updateOrderNumber_serialNumber, 
    updateDeviceOrderNumber, 
    updateQuantityWEBMin1, 
    updateRemainingWEB0ToArchive, 
    updateRemainingMin1 } = require('./module/update.db.js');
updatedevice_SerialNumber_NoLimit(app);
updateDevice(app);
updateOrderNumber_serialNumber(app);
updateDeviceOrderNumber(app);
updateQuantityWEBMin1(app);
updateRemainingWEB0ToArchive(app);
updateRemainingMin1(app);

//const testRoutes = require('./module/test.js');
//testRoutes(app);


// Time Based Functions. 
const {
    getCurrentWeek,
    isCurrentWeek,
    getCurrentMonth,
    isCurrentMonth,
    getCurrentYear,
    isCurrentYear,
    pastweektrackingdata,
    pastMonthTrackingData,
    pastThreeMonthsTrackingData,
    pastSixMonthsTrackingData,
    pastYearTrackingData
} = require('./module/get_base_time.js');
pastweektrackingdata(app); //pastweektrackingdata(app, archivedTrackingData);
pastMonthTrackingData(app); //pastMonthTrackingData(app, archivedTrackingData);
pastThreeMonthsTrackingData(app); //pastThreeMonthsTrackingData(app, archivedTrackingData);
pastSixMonthsTrackingData(app); //pastSixMonthsTrackingData(app, archivedTrackingData);
pastYearTrackingData(app);  //pastYearTrackingData(app, archivedTrackingData);

// Example usage of the imported functions
const currentWeek = getCurrentWeek();
const currentMonth = getCurrentMonth();
const currentYear = getCurrentYear();
// You can now use these values as needed in your app

 







// List Functions. 
const { 
    XMLlistalldevices,
    gettrackingdata, 
    getarchivedtrackingdata } = require('./module/list.all.js');
XMLlistalldevices(app);
gettrackingdata(app);
getarchivedtrackingdata(app);

// Front END. 
const { MarkTrackingDone } = require('./module/front_end.js');
MarkTrackingDone(app); // Done Button Function to move to archive

MarkTrackingDone

// Deleate Functions. 
const { 
	delete_tracking,
	delete_archived_tracking,
	delete_single_device	} = require('./module/delete.js');
delete_tracking(app);
delete_archived_tracking(app);
delete_single_device(app);
 

const { searchTrackingModel } = require('./module/search_global.js');
searchTrackingModel(app);


 

//const add_to_DB = require('./module/add.to.db.js');
//const find_DB = require('./module/find.js');
//const update_DB = require('./module/update.db.js');

 
// Initialize your modules with the app instance
//add_to_DB(app);
//find_DB(app);
//update_DB(app);



//updateOrderNumber_serialNumber(app);
//updateDeviceOrderNumber(app);






const createPdf = require('./module/print.template.js');
// First it checks trackingData then archivedTrackingData for a matching SN
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
 
 
 
/*
function getCurrentWeek() {
    // Implement logic to get the current week number
    return new Date().getWeek();
}
global.getCurrentWeek = getCurrentWeek;

function isCurrentWeek(dateString, currentWeek) {
    const date = new Date(dateString);
    return date.getWeek() === currentWeek;
}
global.isCurrentWeek = isCurrentWeek;

Date.prototype.getWeek = function() {
    const firstDayOfYear = new Date(this.getFullYear(), 0, 1);
    const pastDaysOfYear = (this - firstDayOfYear) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
};
global.getWeek = Date.prototype.getWeek;
 */
 

// Endpoint to submit comments
app.post('/submit_comment', (req, res) => {
    const comment = req.body.comment;
    const filePath = 'comments.json';

    updateFile(filePath, comment, res);
});


app.post('/add_update', (req, res) => {
    const update = req.body.update;
    global.updatesData.push(update);
    try {
        global.saveUpdatesData();
        res.send({ message: 'Update added successfully' });
    } catch (writeErr) {
        res.status(500).send({ message: 'Error saving update' });
    }
});

// Endpoint to get comments
app.get('/get_comments', (req, res) => {
    const filePath = 'db/comments.json';
    readFile(filePath, res);
});

 
 

function updateFile(filePath, content, res) {
    try {
        const fullPath = path.join('db', filePath);
        let json = [];
        if (fs.existsSync(fullPath)) {
            json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        }
        json.push(content);
        atomicWriteJsonSync(fullPath, json);
        // Keep in-memory comments in sync when writing comments.json
        if (filePath === 'comments.json') {
            global.commentsData = json;
        }
        res.send({ message: 'Successfully updated' });
    } catch (err) {
        res.status(500).send({ message: 'Error writing to file' });
    }
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
// Enhanced updateOrderFields function
async function updateOrderFields(orderNumber, internalNotes, customField1, customField3) {
    try {
        const existingOrder = await getOrder(orderNumber);
        if (!existingOrder) {
            console.error(`Order ${orderNumber} not found in ShipStation.`);
            throw new Error('Order not found');
        }

        if (['shipped', 'cancelled'].includes(existingOrder.orderStatus)) {
            console.error(`Order ${orderNumber} is in status ${existingOrder.orderStatus} and cannot be updated.`);
            throw new Error('Order cannot be updated');
        }

        const updatedOrder = { 
            ...existingOrder, 
            internalNotes,
            advancedOptions: {
                ...existingOrder.advancedOptions,
                customField1,
                customField3
            }
        };

        console.log(`Sending update request to ShipStation for order ${orderNumber}:`, updatedOrder);

        const response = await axios.post('https://ssapi.shipstation.com/orders/createorder', updatedOrder, {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`ShipStation update response for order ${orderNumber}:`, response.data);
        return response.data;
    } catch (error) {
        console.error(`Error updating order ${orderNumber}:`, error.response ? error.response.data : error.message);
        throw error; // Rethrow the error for further handling
    }
}


// Express route
app.post('/update-order-fields', async (req, res) => {
    const { orderNumber, internalNotes, customField1, customField3 } = req.body;
    console.log('Running: app.post(/update-order-fields)');

    if (!orderNumber) {
        return res.status(400).send({ message: 'Order number is required.' });
    }

    try {
        const response = await updateOrderFields(orderNumber, internalNotes, customField1, customField3);
        console.log('ShipStation update response:', response);
        res.send(response);
    } catch (error) {
        console.error('Error in /update-order-fields route:', error.message);
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

/*
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
*/

// Addes the order number internally, And then calls on the /update-order-fields Function to update the SN via the API.
// Please note this only works when order is still proccing and not in shipped status.
 //app.post('/update-device-details/:serialNumber', (req, res) => {
app.post('/update-device-details/:serialNumber', async (req, res) => {
    const serialNumber = req.params.serialNumber.toLowerCase();
    const updatedData = req.body;

    let deviceFound = false;
    let isArchivedData = false;

    // Update in active tracking data
    global.trackingData.forEach(trackingItem => {
        const deviceIndex = trackingItem.devices.findIndex(d => d.serialNumber.toLowerCase() === serialNumber);
        if (deviceIndex !== -1) {
            if (!trackingItem.devices[deviceIndex].hasOwnProperty('OrderNumber')) {
                trackingItem.devices[deviceIndex].OrderNumber = '';
            }
            trackingItem.devices[deviceIndex] = { ...trackingItem.devices[deviceIndex], ...updatedData };
            deviceFound = true;
            console.log(`Updated in active data: Serial Number: ${serialNumber}, Tracking Number: ${trackingItem.trackingNumber}`);
        }
    });

    // If not found in active, search in archived data
    if (!deviceFound) {
        global.archivedTrackingData.forEach(trackingItem => {
            const deviceIndex = trackingItem.devices.findIndex(d => d.serialNumber.toLowerCase() === serialNumber);
            if (deviceIndex !== -1) {
                if (!trackingItem.devices[deviceIndex].hasOwnProperty('OrderNumber')) {
                    trackingItem.devices[deviceIndex].OrderNumber = '';
                }
                trackingItem.devices[deviceIndex] = { ...trackingItem.devices[deviceIndex], ...updatedData };
                deviceFound = true;
                isArchivedData = true;
                console.log(`Updated in archived data: Serial Number: ${serialNumber}, Tracking Number: ${trackingItem.trackingNumber}`);
            }
        });
    }

    if (deviceFound) {
        // Save changes to tracking data
        if (isArchivedData) {
            global.saveArchivedTrackingData();
            console.log('Saved and reloading archived tracking data');
        } else {
            global.saveTrackingData();
            console.log('Saved and reloading active tracking data');
        }
        // Update ShipStation order if OrderNumber exists
        if (updatedData.OrderNumber) {
            try {
                const shipStationFields = {
                    orderNumber: updatedData.OrderNumber,
                    customField3: serialNumber
                };

                // Only add internalNotes if there are notes to update
                if (updatedData.notes) {
                    shipStationFields.internalNotes = updatedData.notes;
                }

                const shipStationResponse = await updateOrderFields(
                    shipStationFields.orderNumber, // OrderNumber
                    shipStationFields.internalNotes, // internalNotes
                    '', // customField1
                    '', // customField2
                    shipStationFields.customField3 // customField3 (Serial Number)
                );
            } catch (error) {
                console.error('Error updating ShipStation order:', error);
                return res.status(500).send({ error: error.message });
            }
        }
		//_______ End of ship station. 
        res.send('Device details updated successfully');
    } else {
        res.status(404).send('Device not found');
    }
});













//Bulk API OPrations. 
// Function to fetch order status from ShipStation
async function fetchOrderStatus(orderNumber) {
    try {
        const response = await axios.get(`https://ssapi.shipstation.com/orders?orderNumber=${orderNumber}`, {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.data && response.data.orders && response.data.orders.length > 0) {
            const order = response.data.orders[0];
            return order.orderStatus;
        }
        return null;
    } catch (error) {
        console.error(`Error fetching order ${orderNumber}:`, error);
        return null;
    }
}

// Looks like this primerly looks in local DB for orderNumbers and updates the shipping status. 
app.post('/bulk-update-local-shipping-status', async (req, res) => {
    const orderNumbers = req.body.orderNumbers;
    const config = JSON.parse(fs.readFileSync('account/ShipStation.json', 'utf8'));

    for (const orderNumber of orderNumbers) {
        const orderResponse = await fetchOrderFromAnyApi(orderNumber, config);
        if (orderResponse && orderResponse.orderData) {
            const orderStatus = orderResponse.orderData.orderStatus;

            // Update both active and archived tracking data
            [global.trackingData, global.archivedTrackingData].forEach(trackingData => {
                trackingData.forEach(trackingItem => {
                    trackingItem.devices.forEach(device => {
                        if (device.OrderNumber === orderNumber) {
                            device.orderstatus = orderStatus;
                        }
                    });
                });
            });

            console.log(`Updated local status for OrderNumber ${orderNumber} to ${orderStatus}`);
        } else {
            console.error(`OrderNumber ${orderNumber} not found or failed to fetch status.`);
        }
    }

    global.saveTrackingData();
    global.saveArchivedTrackingData();
    res.send('Bulk local shipping status updated successfully.');
});



// Helper function to fetch warehouse details
async function fetchWarehouseDetails(warehouseId, config) {
    const encodedCredentials = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');
    try {
        const response = await axios.get(`https://ssapi.shipstation.com/warehouses/${warehouseId}`, {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`
            }
        });
        return response.data;
    } catch (error) {
        console.error(`Failed to fetch warehouse details for warehouse ID ${warehouseId}:`, error);
        return null;
    }
}


// Import the parsing function
//const { parseDeviceDetailsFromName } = require('./path/to/your/parser');

app.post('/bulk-update-device-info', async (req, res) => {
    const orderNumbers = req.body.orderNumbers;
    const config = JSON.parse(fs.readFileSync('account/ShipStation.json', 'utf8'));
    const debugLogFilePath = 'module/Regex-debug-log.txt'; // Update with the actual path

  
    for (const orderNumber of orderNumbers) {
        const orderResponse = await fetchOrderFromAnyApi(orderNumber, config);	
		//if order not found check via tracking number fetchOrderNumberByTrackingFromAnyApi
        if (orderResponse && orderResponse.orderData && orderResponse.orderData.items) {
		    console.log("Advanced Options:", orderResponse.orderData.items); // Debugging log	
				
            orderResponse.orderData.items.forEach(item => {
                const { model, cpu, ram, hd, windowsVersion } = parseDeviceDetailsFromName(item.name);
                const orderStatus = orderResponse.orderData.orderStatus || '';				
                const shipDate = orderResponse.orderData.shipDate; // Extract shipDate
                const customerNotes = orderResponse.orderData.customerNotes || ''; // Extract customer notes or default to 'None'
                const internalNotes = orderResponse.orderData.internalNotes || ''; // Extract internal notes or default to 'None'
                const customField1 = orderResponse.orderData.advancedOptions.customField1 || '';
                const customField2 = orderResponse.orderData.advancedOptions.customField2 || '';
                const customField3 = orderResponse.orderData.advancedOptions.customField3 || '';

                const name = orderResponse.orderData.shipTo.name || '';
                const company = orderResponse.orderData.shipTo.company || '';
                const street1 = orderResponse.orderData.shipTo.street1 || '';
                const street2 = orderResponse.orderData.shipTo.street2 || '';
                const city = orderResponse.orderData.shipTo.city || '';
                const state = orderResponse.orderData.shipTo.state || '';
                const postalCode = orderResponse.orderData.shipTo.postalCode || '';
                const phone = orderResponse.orderData.shipTo.phone || '';
                const residential = orderResponse.orderData.shipTo.residential || '';
				
                const orderTotal = orderResponse.orderData.orderTotal || '';
                const orderQuantity = orderResponse.orderData.items[0].quantity || '';
                const unitPrice = orderResponse.orderData.items[0].unitPrice || '';
				
                // Write parsed details to the debug file
                //const logEntry = `Order Number: ${orderNumber}, Item: ${item.name}, Model: ${model}, CPU: ${cpu}, RAM: ${ram}, HD: ${hd}, Windows Version: ${windowsVersion}\n`;
                const logEntry = `Order Number: ${orderNumber}, Item: ${item.name}, Model: ${model}, CPU: ${cpu}, RAM: ${ram}, HD: ${hd}, Windows Version: ${windowsVersion}, Ship Date: ${shipDate}, Customer Notes: ${customerNotes}, Internal Notes: ${internalNotes}\n`;
                //  ToDO Add Warehouse name and warehouse company from the /get-warehouses Or /get-warehouse/:warehouseId
                fs.appendFileSync(debugLogFilePath, logEntry);
				console.log(chalk.yellow(`Order Number: ${orderNumber}, Item: ${item.name}, Model: ${model}, CPU: ${cpu}, RAM: ${ram}, HD: ${hd}, Windows Version: ${windowsVersion}, Ship Date: ${shipDate}, Customer Notes: ${customerNotes}, Internal Notes: ${internalNotes}, Custom Field 1: ${customField1}, Custom Field 2: ${customField2}, Custom Field 3: ${customField3}`));
				
				console.log(chalk.yellow(`Client info: ${name}, Company: ${company}, Street1: ${street1}, Street2: ${street2}, City: ${city}, State: ${state}, Postal Code: ${postalCode}, Phone: ${phone}, Residential: ${residential}, Model: ${model}, CPU: ${cpu}, RAM: ${ram}, HD: ${hd}, Windows Version: ${windowsVersion}, Ship Date: ${shipDate}, Customer Notes: ${customerNotes}, Internal Notes: ${internalNotes}, Custom Field 1: ${customField1}, Custom Field 2: ${customField2}, Custom Field 3: ${customField3}`));
				//console.log(chalk.yellow(`Clint info: ${name}, Item: ${company}, Model: ${model}, CPU: ${cpu}, RAM: ${ram}, HD: ${hd}, Windows Version: ${windowsVersion}, Ship Date: ${shipDate}, Customer Notes: ${customerNotes}, Internal Notes: ${internalNotes}, Custom Field 1: ${customField1}, Custom Field 2: ${customField2}, Custom Field 3: ${customField3}`));
				

                // Logic to find the device by order number and update its details
                //updateDeviceInfoInDatabase(orderNumber, { model, cpu, ram, hd, windowsVersion });
                updateDeviceInfoInDatabase(orderNumber, { 
				model, cpu, ram, hd, windowsVersion, 
				shipDate, orderStatus,
				customerNotes, 	internalNotes, customField1, customField2, customField3,
				name, company, street1, street2, city, state, postalCode, phone, residential,
				orderTotal, orderQuantity, unitPrice
				
				});  				
            });
        }
    }

    res.send('Bulk device info updated successfully.');
});




// Update Device info button 
const { updateDeviceInfoInDatabase } = require('./module/button_update_api.js');
updateDeviceInfoInDatabase;

// Update Device info button 
/*
function updateDeviceInfoInDatabase(orderNumber, deviceDetails) {
    let deviceFound = false;

    const updateDeviceDetails = (trackingData) => {
        trackingData.forEach(trackingItem => {
            trackingItem.devices.forEach(device => {
                if (device.OrderNumber === orderNumber) {
                    // Update device details
                    //device.model = deviceDetails.model;
                    //device.cpu = deviceDetails.cpu;
                    //device.ram = deviceDetails.ram;
                    //device.hd = deviceDetails.hd;
                    //device.windowsVersion = deviceDetails.windowsVersion;	

                    device.cpu = device.model || deviceDetails.model;                   
                    device.cpu = device.cpu || deviceDetails.cpu;
                    device.ram = device.ram || deviceDetails.ram;
                    device.hd = device.hd || deviceDetails.hd;
                    device.windowsVersion = device.windowsVersion || deviceDetails.windowsVersion;
                    
                    // Update or create new fields
                    device.orderStatus = deviceDetails.orderStatus || device.orderStatus;
                    device.shipDate = deviceDetails.shipDate || device.shipDate;
                    device.customerNotes = deviceDetails.customerNotes || device.customerNotes;
                    device.internalNotes = deviceDetails.internalNotes || device.internalNotes;
					
                    //device.shipDate = deviceDetails.shipDate;
                    //device.customerNotes = deviceDetails.customerNotes;
                    //device.internalNotes = deviceDetails.internalNotes;
					
                    device.customField1 = deviceDetails.customField1 || device.customField1;
                    device.customField2 = deviceDetails.customField2 || device.customField2;
                    device.customField3 = deviceDetails.customField3 || device.customField3;
					
                    device.name = deviceDetails.name || device.name;
                    device.company = deviceDetails.company || device.company;
                    device.street1 = deviceDetails.street1 || device.street1;
                    device.street2 = deviceDetails.street2 || device.street2;
                    device.city = deviceDetails.city || device.city;
                    device.state = deviceDetails.state || device.state;
                    device.postalCode = deviceDetails.postalCode || device.postalCode;
                    device.phone = deviceDetails.phone || device.phone;
                    device.residential = deviceDetails.residential || device.residential; 
					
                    device.orderTotal = deviceDetails.orderTotal || device.orderTotal; 
                    device.orderQuantity = deviceDetails.orderQuantity || device.orderQuantity; 
                    device.unitPrice = deviceDetails.unitPrice || device.unitPrice; 
					
                    //device.customField1 = deviceDetails.customField1;
                    //device.customField2 = deviceDetails.customField2;
                    //device.customField3 = deviceDetails.customField3;
					
                    deviceFound = true;
					
					//console.log(deviceDetails);
                }
            });
        });
    };

    // Update in active tracking data
    updateDeviceDetails(global.trackingData);

    // If not found in active data, update in archived data
    if (!deviceFound) {
        updateDeviceDetails(global.archivedTrackingData);
    }

    // Save changes to tracking data
    if (deviceFound) {
        global.saveTrackingData();
        global.saveArchivedTrackingData();
        console.log(`Device details updated for OrderNumber: ${orderNumber}`);
    }
}

*/

function findApiEmailByOrderNumber(orderNumber) {
    let apiemail = null;

    // First, search in active tracking data
    for (const trackingItem of global.trackingData) {
        const device = trackingItem.devices.find(d => d.OrderNumber === orderNumber);
        if (device) {
            apiemail = device.apiemail;
            break;
        }
    }

    // If not found, search in archived tracking data
    if (!apiemail) {
        for (const trackingItem of global.archivedTrackingData) {
            const device = trackingItem.devices.find(d => d.OrderNumber === orderNumber);
            if (device) {
                apiemail = device.apiemail;
                break;
            }
        }
    }

    return apiemail;
}



 // Function to make a request to the API with rate limiting
async function makeApiRequestWithRateLimiting(endpoint, method = 'GET', data = null) {
    const url = `https://ssapi.shipstation.com/${endpoint}`;
    const headers = {
        'Authorization': `Basic ${encodedCredentials}`,
        'Content-Type': 'application/json'
    };

    let response;
    try {
        if (method === 'GET') {
            response = await axios.get(url, { headers });
        } else if (method === 'POST') {
            response = await axios.post(url, data, { headers });
        }
        // add more methods as needed

        const rateLimit = {
            limit: parseInt(response.headers['x-rate-limit-limit']),
            remaining: parseInt(response.headers['x-rate-limit-remaining']),
            reset: parseInt(response.headers['x-rate-limit-reset'])
        };

        return { success: true, data: response.data, rateLimit };
    } catch (error) {
        // Rate limit handling
        if (error.response && error.response.status === 429) {
            const resetTime = parseInt(error.response.headers['x-rate-limit-reset']) * 1000;
            console.log(`Rate limit exceeded. Waiting for ${resetTime} milliseconds.`);
            await new Promise(resolve => setTimeout(resolve, resetTime));
            return makeApiRequestWithRateLimiting(endpoint, method, data);
        } else {
            // Handle other errors
            console.error(`Error making API request: ${error.message}`);
            return { success: false, error };
        }
    }
}


 
// ShipStation API END










// This function should be adapted to call different APIs based on 'org' and account details
// Function to fetch order from API based on organization and account email 
async function fetchOrderFromSpecificApi(orderNumber, org, apiemail) {
    // Read the configuration file for API accounts
    const config = JSON.parse(fs.readFileSync('account/ShipStation.json', 'utf8'));

    if (org === 'ShipStation') {
        // Find the account details for ShipStation based on apiemail
        const accountDetails = config[org].find(account => account.Email === apiemail);

        if (accountDetails) {
            // Encode the API key and secret for Basic Auth
            const encodedCredentials = Buffer.from(`${accountDetails.api_key}:${accountDetails.api_secret}`).toString('base64');

            try {
                // Make an API call to fetch the order
                const response = await axios.get(`https://ssapi.shipstation.com/orders?orderNumber=${orderNumber}`, {
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (response.data && response.data.orders && response.data.orders.length > 0) {
                    return response.data.orders[0];
                } else {
                    return null;
                }
            } catch (error) {
                console.error(`Error fetching order from ShipStation: ${error.message}`);
                return null;
            }
        } else {
            console.log(`Account details not found for email: ${apiemail} in ${org}`);
            return null;
        }
    }

    // Add logic for other organizations like Walmart, Newegg, etc.
    // ...

    return null; // Return null if the organization is not handled
}

// Function to search and locate Order Number from all API. 
async function fetchOrderFromAnyApi(orderNumber, config) {
    for (const org in config) {
        for (const account of config[org]) {
            // Encode API Key and Secret for Basic Auth
            const encodedCredentials = Buffer.from(`${account.api_key}:${account.api_secret}`).toString('base64');
			//let operationLogs = [];
            try {
                // Adjust the API endpoint based on the organization
                let apiUrl = '';
                switch (org) {
                    case 'ShipStation':
                        apiUrl = `https://ssapi.shipstation.com/orders?orderNumber=${orderNumber}`;
                        break;
                    case 'Walmart':
                        // apiUrl = [Walmart API endpoint]
                        break;
                    case 'Newegg':
                        // apiUrl = [Newegg API endpoint]
                        break;
                    // Add more cases for other organizations
                }

                // Fetch the order using the respective API
                const response = await axios.get(apiUrl, {
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (response.data && response.data.orders && response.data.orders.length > 0) {
                    console.log(chalk.green(`Order number ${orderNumber} found in ${org} under account ${account.Email}.`));
                    //operationLogs.push(`Order number ${orderNumber} found in ${org} under account ${account.Email}.`);
                    return { orderData: response.data.orders[0], org, apiemail: account.Email };
                }
            } catch (error) {
                //operationLogs.push(`Error fetching order from ${org} (${account.Email}): ${error.message}`);
				console.error(chalk.red(`Error fetching order from ${org} (${account.Email}): ${error.message}`));
                // Continue checking the next account
            }
        }
    }

    console.log(chalk.yellow(`Order number ${orderNumber} not found in any configured API.`));
   	return null;
}

/*
async function fetchOrderNumberByTrackingFromAnyApi(trackingNumber, config) {
    for (const org in config) {
        for (const account of config[org]) {
            // Encode API Key and Secret for Basic Auth
            const encodedCredentials = Buffer.from(`${account.api_key}:${account.api_secret}`).toString('base64');

            try {
                let apiUrl = '';
                switch (org) {
                    case 'ShipStation':
                        apiUrl = `https://ssapi.shipstation.com/shipments?trackingNumber=${trackingNumber}`;
                        break;
                    case 'Walmart':
                        // apiUrl for Walmart API to get order by tracking number
                        break;
                    case 'Newegg':
                        // apiUrl for Newegg API to get order by tracking number
                        break;
                    // Add cases for other organizations as needed
                }

                if (!apiUrl) continue; // If apiUrl isn't set for an org, skip to the next one

                const response = await axios.get(apiUrl, {
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (response.data && response.data.shipments && response.data.shipments.length > 0) {
                    const orderNumber = response.data.shipments[0].orderNumber;
                    console.log(chalk.green(`Tracking number ${trackingNumber} found in ${org} under account ${account.Email}. Order number: ${orderNumber}`));
                    return { orderNumber, org, apiemail: account.Email };
                }
            } catch (error) {
                console.error(chalk.red(`Error fetching order number by tracking number from ${org} (${account.Email}): ${error.message}`));
                // Continue checking the next account
            }
        }
    }

    console.log(chalk.yellow(`Tracking number ${trackingNumber} not found in any configured API.`));
    return null;
}
*/
  //Get Order number by scanning the Tracking number
async function fetchOrderNumberByTrackingFromAnyApi(trackingNumber, config) {
    for (const org in config) {
        for (const account of config[org]) {
            const encodedCredentials = Buffer.from(`${account.api_key}:${account.api_secret}`).toString('base64');
            try {
                let apiUrl = '';
                switch (org) {
                    case 'ShipStation':
                        apiUrl = `https://ssapi.shipstation.com/shipments?trackingNumber=${trackingNumber}`;
                        break;
                    // Add cases for other organizations like Walmart, Newegg, etc.
                }

                const response = await axios.get(apiUrl, {
                    headers: {
                        'Authorization': `Basic ${encodedCredentials}`,
                        'Content-Type': 'application/json'
                    }
                });

                if (response.data && response.data.shipments && response.data.shipments.length > 0) {
                    //console.log(chalk.green(`Tracking number ${trackingNumber} found in ${org} under account ${account.Email}. Response data: ${JSON.stringify(response.data)}`));
                    console.log(chalk.green(`Tracking number ${trackingNumber} found in ${org} under account ${account.Email}. `));
//Response data: ${JSON.stringify(response.data)}
                    return { 
                        orderNumber: response.data.shipments[0].orderNumber, 
                        org, 
                        apiemail: account.Email, 
                        fullResponse: response.data // Include the full response for detailed results
                    };
                }
            } catch (error) {
                console.error(chalk.red(`Error fetching order number from tracking number in ${org} (${account.Email}): ${error.message}`));
            }
        }
    }

    console.log(chalk.yellow(`Tracking number ${trackingNumber} not found in any configured API.`));
    return null;
}



 // Powershell
// THis is a test to see if we can check for exsisting tracking number if not create one will be used for powershell
//app.post('/add-or-update-device', (req, res) => {
app.post('/add-or-update-device', async (req, res) => { 
    const { serialNumber } = req.body;
    //TODO! add Todays date in as deviceDate into DB

        // Add today's date as default if deviceDate is not provided
    //let { orderNumber, model, cpu, ram, hd, windowsVersion, sku, notes, org, apiemail, orderstatus } = req.body;
    let { orderNumber, model, cpu, ram, hd, windowsVersion, sku, notes, org, apiemail, orderstatus, deviceDate } = req.body;
    
    console.log(chalk.blue(`Received request From PowerShell to add/update device with Serial Number: ${serialNumber}, Order Number: ${orderNumber}, Device Date: `));

    // If deviceDate is not provided, default to today's date (formatted as YYYY-MM-DD)
    const formattedDeviceDate = deviceDate || new Date().toISOString().slice(0, 10);
    //deviceDate = deviceDate || new Date().toISOString().slice(0, 10); // If deviceDate is not provided, use today's date
    //deviceDate = deviceDate || new Date().toISOString().slice(0, 10); // If deviceDate is not provided, use today's date
    // Log the received data including device date
    console.log(chalk.blue(`Received request From PowerShell to add/update device with Serial Number: ${serialNumber}, Order Number: ${orderNumber}, Device Date: ${formattedDeviceDate}`));


    
    let existingDevice = null;
    let foundInActiveData = false;
    let orderData = null;
    let orderFound = false;
	let operationLogs = []; // Initialize an array to store operation logs
    let warehouseId;  // Declare warehouseid
	let warehouseName = ''; // Initialize with default value or empty string
	let warehouseCompany = ''; // Initialize with default value or empty string

/* To implement possiably to use fetchOrderFromAnyApi and fetchOrderNumberByTrackingFromAnyApi instead of current method
    // First, try to find the order using the order number
    orderData = await fetchOrderFromAnyApi(orderNumber, config);
    orderFound = orderData != null;
	    if (!orderFound) {
        // If order not found by order number, search using tracking number
        const trackingResponse = await fetchOrderNumberByTrackingFromAnyApi(orderNumber, config);
        if (trackingResponse && trackingResponse.orderNumber) {
            console.log(chalk.green(`Found order number ${trackingResponse.orderNumber} using tracking number.`));
            orderNumber = trackingResponse.orderNumber; // Update the orderNumber
            orderData = await fetchOrderFromAnyApi(orderNumber, config); // Refetch the order data using the newly found order number
            orderFound = orderData != null;
        } else {
            console.error(chalk.red(`Could not find order using tracking number ${orderNumber}.`));
        }
    }
*/
    try {  // Search for orderNumber with a tracking number instead. (If not found, Treat the input number as a ordernumber THis allows both to work. 
        console.log(`Attempting to fetch order number using tracking number: ${orderNumber}`);
        const trackingResponse = await axios.get(`http://localhost:3000/get-fullResponse-by-tracking/${orderNumber}`); // Check the response
        if (trackingResponse.data && trackingResponse.data.orderNumber) { // If Comes back with data then. 
            console.log(`Fetched order number from tracking number: ${trackingResponse.data.orderNumber}`);
            orderNumber = trackingResponse.data.orderNumber; // Update the orderNumber directly
        }
			//orderNumber: orderInfo.orderNumber,
			//apiTrackingfullResponse: orderInfo.fullResponse.shipments[0]  // RESPONSE WOULD BE FULL 
		
    } catch (error) {  // Else, if no data came back, Treat it the current value as a ordernumber and not a tracking number. 
        console.error(`Could not find tracking number: Treating ${orderNumber} as a order number.  `, error.message);
    }
	
//-----


    try { // Look at each API and match the order number from API. 
        orderData = await fetchOrderFromAnyApi(orderNumber, config);
        orderFound = orderData != null; 

        // Extracting orderStatus
        const orderStatus = orderData.orderData.orderStatus;
        //const orderStatus = orderData && orderData.orderData ? orderData.orderData.orderStatus : "";
        console.log(chalk.blue(`Order Status: ${orderStatus}`));


        if (orderFound) { // Data From API
            console.log(chalk.green(`Order number ${orderNumber} found. Using order details.`));
            //console.log(chalk.yellow(`Order data: ${JSON.stringify(orderData.orderData, null, 2)}`)); // FULL API DATA IN A ARRAY
			
		// Extract the org and apiemail from the response
        org = orderData.org;
        apiemail = orderData.apiemail;

            // DATA HOLDER IF API IS FOUND> ADDEDS DATA GLOBALLY
            if (orderData.orderData.items && orderData.orderData.items.length > 0) {
								 
                const itemDetails = orderData.orderData.items[0];
                const parsedDetails = parseDeviceDetailsFromName(itemDetails.name);
				const apiData = orderData.orderData; // RETURN API DATA
                model = model || parsedDetails.model;
                cpu = cpu || parsedDetails.cpu;
                ram = ram || parsedDetails.ram;
                hd = hd || parsedDetails.hd;
                windowsVersion = windowsVersion || parsedDetails.windowsVersion;
                //orderstatus = orderstatus || parsedDetails.orderStatus;
				org = org || org;
				apiemail = apiemail || apiemail;
				orderstatus = orderstatus || orderStatus;							
				warehouseId = warehouseId || apiData.advancedOptions.warehouseId;
				// Display Shipment Time in powershell and logs

				const createDateTime = new Date(apiData.createDate).toLocaleString();
				const modifyDateTime = new Date(apiData.modifyDate).toLocaleString();
				const shipByDateTime = new Date(apiData.shipByDate).toLocaleString();
				console.log(chalk.yellow(`Order Created: ${createDateTime}, Updated ${modifyDateTime}, Ship by ${shipByDateTime}`));
				operationLogs.push(`Order Created: ${createDateTime}, Updated ${modifyDateTime}, Ship by ${shipByDateTime}
				`);
			
				// Fetching warehouse details
				warehouseId = apiData.advancedOptions.warehouseId; 
			    console.log(chalk.yellow(`WareHouse ID ${warehouseId}`));	
				if (warehouseId) {
					try {
							const warehouseResponse = await axios.get(`https://ssapi.shipstation.com/warehouses/${warehouseId}`, {
							headers: {
								'Authorization': `Basic ${encodedCredentials}`
							}
						});

						const warehouse = warehouseResponse.data;
						warehouseName = warehouse.originAddress.name;
						warehouseCompany = warehouse.originAddress.company;
						warehouseName = warehouseName || warehouse.originAddress.name;
						warehouseCompany = warehouseCompany || warehouse.originAddress.company;
										
						console.log(chalk.yellow(`Warehouse Name: ${warehouse.originAddress.name}, Company: ${warehouse.originAddress.company}`));
						// You can also store these details in variables or log them as needed
					} catch (error) {
						console.error(chalk.red(`Error fetching warehouse details for ID ${warehouseId}: ${error.message}`));
						// Handle error, possibly continue processing other parts of the order
					}
				} else {
					console.log(chalk.red('Warehouse ID not found in order data.'));
				}
 
				
				
            } else {
                console.log(chalk.red(`Order number ${orderNumber} found, but no item details available.`));
                operationLogs.push(`Order number ${orderNumber} found, but no item details available.
				`);
            }
        } else {
            console.log(chalk.red(`Order number ${orderNumber} not found in any API.`));
            operationLogs.push(`Order number ${orderNumber} not found in any API.
			`);
        }
    } catch (error) {
        console.error(chalk.red(`Error fetching order data for ${orderNumber}: ${error.message}`));
        operationLogs.push(`Error fetching order data for ${orderNumber}: ${error.message}
		`);
    }

	

    // Function to create a new tracking number for today if needed
    const todayTrackingNumber = `New_Never_Opened_${new Date().toISOString().slice(0, 10)}`;
    let todayTrackingEntry = global.trackingData.find(entry => entry.trackingNumber === todayTrackingNumber);

    if (!todayTrackingEntry) {
        todayTrackingEntry = {
            date: new Date().toISOString().slice(0, 10),
            trackingNumber: todayTrackingNumber,
            quantity: 0,
            remaining: 0,
            status: 'Active',
            devices: []
        };
        global.trackingData.push(todayTrackingEntry);
    }


    // Search in active tracking data
    global.trackingData.forEach(trackingEntry => {
        const deviceIndex = trackingEntry.devices.findIndex(d => d.serialNumber === serialNumber);
        if (deviceIndex !== -1) {
            existingDevice = trackingEntry.devices[deviceIndex];
            foundInActiveData = true;
        }
    });

    // Search in archived tracking data if not found in active data
    if (!existingDevice) {
        global.archivedTrackingData.forEach(trackingEntry => {
            const deviceIndex = trackingEntry.devices.findIndex(d => d.serialNumber === serialNumber);
            if (deviceIndex !== -1) {
                existingDevice = trackingEntry.devices[deviceIndex];
            }
        });
    }
// if Serial is not locally, create new tracking with device warehouseId
    if (!existingDevice) {
        const newDevice = {
            serialNumber,
            //model: model || 'NEW (Never Tested)',
            model: model || '',
            cpu: cpu || '',  
            ram: ram || '',
            hd: hd || '',
            windowsVersion: windowsVersion || '',
            sku: sku || '',
            notes: notes || 'New Device',
            activationStatus: 'Active',
            OrderNumber: orderNumber || '',
            org: org, // Set org
            apiemail: apiemail, // Set apiemail
            orderstatus: orderstatus || '',
			//warehouseId: warehouseId || '',
            warehouseName: warehouseName || '',
            deviceDate: formattedDeviceDate || '', // Use today's date or provided deviceDate  
            warehouseCompany: warehouseCompany
   
        };

        todayTrackingEntry.devices.push(newDevice);
        todayTrackingEntry.quantity++;
        todayTrackingEntry.remaining++;
        console.log(`New device added with tracking number: ${todayTrackingNumber}`);
        global.saveTrackingData();

    // Save the info Online, If status is proccing		
    if (org === "ShipStation") { 
        console.log(`Serial Number: ${serialNumber} is not in the database. Updating ShipStation.`);
			// For a new device
			

	let newDeviceLogs = await updateShipStation(serialNumber, orderNumber, notes, false, org, orderstatus);
	       console.log(`Logs Data: ${serialNumber}  ${orderNumber}  ${notes}  ${org}  ${orderstatus} `);
	operationLogs.push(`Get Data: ${serialNumber}  ${orderNumber}  ${notes}  ${org}  ${orderstatus} 

orderNumber ${orderNumber}, ${notes}

Warehouse: ${warehouseName}, Company: ${warehouseCompany},  ${org} Email: ${apiemail}  
`);
	operationLogs = operationLogs.concat(newDeviceLogs);
    } else {
        console.log(`API Method not supported at the time. Current supported APIs: ShipStation`);
		operationLogs.push(`API Method not supported at the time. Current supported APIs: ShipStation
		`);
    }
		
    } else {
        existingDevice.OrderNumber = orderNumber || existingDevice.OrderNumber;
        existingDevice.model = existingDevice.model || model;
        existingDevice.cpu = existingDevice.cpu || cpu;
        existingDevice.ram = existingDevice.ram || ram;
        existingDevice.hd = existingDevice.hd || hd;
        existingDevice.windowsVersion = existingDevice.windowsVersion || windowsVersion;
        existingDevice.sku = existingDevice.sku || sku;
        existingDevice.notes = existingDevice.notes || notes;
        existingDevice.org = existingDevice.org || org; // Update org
        existingDevice.apiemail = existingDevice.apiemail || apiemail; // Update apiemail
        existingDevice.orderstatus = existingDevice.orderstatus || orderstatus;
        //existingDevice.warehouseId = existingDevice.warehouseId || warehouseId;
        existingDevice.warehouseName = existingDevice.warehouseName || warehouseName; 
        existingDevice.warehouseCompany = existingDevice.warehouseCompany || warehouseCompany;
        console.log(`Updated existing device: Serial Number: ${serialNumber}`);

    if (org === "ShipStation") { 
        console.log(`Serial Number: ${serialNumber} is not in the database. Updating ShipStation.`);   
			// For an existing device
			let existingDeviceLogs = await updateShipStation(serialNumber, orderNumber, notes, true, org, orderstatus);
				console.log(`Data: ${serialNumber}  ${orderNumber}  ${notes}  ${org}  ${orderstatus}   ${apiemail} `);
				operationLogs.push(`Serial already in local DB: Updated local DB with new info.
				`);
	                                
				operationLogs = operationLogs.concat(existingDeviceLogs);
    } else {
        console.log(`API Method not supported at the time. Current supported APIs: ShipStation`);
		operationLogs.push(`API Method not supported at the time. Current supported APIs: ShipStation
		`);
    }


        if (foundInActiveData) {
            global.saveTrackingData();
        } else {
            global.saveArchivedTrackingData();
        }
    }

    res.send({ 
        message: 'Device added or updated successfully',
        orderFound: orderFound, 
        orderstatus: orderstatus,
		operationLogs: operationLogs, // Send the accumulated logs
		org: org // Include organization information
    });
});
async function updateShipStation(serialNumber, orderNumber, notes, isExistingDevice, org, orderStatus) {
    let operationLogs = [];

    if (org === "ShipStation") {
        // Check if orderStatus is defined before calling toLowerCase
        if (orderStatus && ["shipped", "cancelled"].includes(orderStatus.toLowerCase())) {
            let message = `Error updating ShipStation order: ${orderNumber} is ${orderStatus} and cannot be updated.
			`;
            console.log(message);
            operationLogs.push(message);
            return operationLogs;
        }

        let internalNotesUpdate = isExistingDevice ? notes : '';
        console.log(`Serial Number: ${serialNumber} ${isExistingDevice ? 'already exists' : 'is not'} in the database. Updating ShipStation.`);
        operationLogs.push(`Serial Number: ${serialNumber} ${isExistingDevice ? 'already exists' : 'is not'} in the database. Updating ShipStation.
		`);
        
        try {
            const updateResponse = await axios.post('http://localhost:3000/update-order-fields', {
                orderNumber: orderNumber, 
                internalNotes: internalNotesUpdate, 
                customField1: '', 
                customField3: serialNumber
            });
            operationLogs.push('ShipStation order updated: ' + JSON.stringify(updateResponse.data));
        } catch (error) {
            operationLogs.push('Error updating ShipStation order: ' + error.message);
        }
    } else {
        operationLogs.push(`API Method not supported at the time. Current supported APIs: ShipStation`);
    }

    return operationLogs;
}

// ALL ShipStaion API (CURRENTLY IT ONLY RETURNS ORDER NUMBER)
app.get('/get-fullResponse-by-tracking/:trackingNumber', async (req, res) => {
    const trackingNumber = req.params.trackingNumber;
    console.log(`Received tracking number: ${trackingNumber}`);

    const config = JSON.parse(fs.readFileSync('account/ShipStation.json', 'utf8'));

    try {
        const orderInfo = await fetchOrderNumberByTrackingFromAnyApi(trackingNumber, config);
        console.log(`Order info received: ${JSON.stringify(orderInfo)}`);

        if (orderInfo && orderInfo.orderNumber) {
            console.log(`Order number found: ${orderInfo.orderNumber.shipments}`);
            res.json({ 
			orderNumber: orderInfo.orderNumber,
			apiTrackingfullResponse: orderInfo.fullResponse.shipments[0]
					   });
			//res.json({ orderNumber: orderInfo.orderNumber });
        } else {
            console.log('No order number found for the provided tracking number');
            res.status(404).send('Order number not found for the provided tracking number');
        }
    } catch (error) {
        console.error('Error fetching order number:', error.message);
        res.status(500).send('Error fetching order number details');
    }
});



  //most likly not needed anymore as we have the /get-fullResponse-by-tracking/
  //however, We need to update all the links and test before making a move like this.
 //Get Order number by scanning the Tracking number
 app.get('/get-order-by-tracking/:trackingNumber', async (req, res) => {
    const trackingNumber = req.params.trackingNumber;
    const shipStationApiUrl = `https://ssapi.shipstation.com/shipments?trackingNumber=${trackingNumber}`;

    try {
        const response = await axios.get(shipStationApiUrl, {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`, // Ensure this uses your encoded API credentials
                'Content-Type': 'application/json'
            }
        });

        // Check if the response contains shipment data
        if (response.data && response.data.shipments && response.data.shipments.length > 0) {
            const orderNumber = response.data.shipments[0].orderNumber;
            res.json({ orderNumber });
        } else {
            res.status(404).send('No shipment found for the provided tracking number');
        }
    } catch (error) {
        console.error('Error fetching shipment:', error.message);
        res.status(500).send('Error fetching shipment details');
    }
});
 
app.get('/get-tracking-by-order/:orderNumber', async (req, res) => {
    const orderNumber = req.params.orderNumber;
    // Load your API configurations
    const config = JSON.parse(fs.readFileSync('account/ShipStation.json', 'utf8'));

    let shipmentFound = false;

    for (const org in config) {
        for (const account of config[org]) {
            const encodedCredentials = Buffer.from(`${account.api_key}:${account.api_secret}`).toString('base64');
            let apiUrl = '';
            switch (org) {
                case 'ShipStation':
                    apiUrl = `https://ssapi.shipstation.com/shipments?orderNumber=${orderNumber}`;
                    break;
                // Add cases for other organizations/APIs here
            }

            if (apiUrl !== '') {
                try {
                    const response = await axios.get(apiUrl, {
                        headers: {
                            'Authorization': `Basic ${encodedCredentials}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    if (response.data && response.data.shipments && response.data.shipments.length > 0) {
                        // Successfully found shipment details
                        const shipmentDetails = response.data.shipments[0]; // Assuming interest in the first shipment
                        console.log(chalk.green(`Order number ${orderNumber} found in ${org} under account ${account.Email}.`));
                        res.json({
                            orderNumber: orderNumber, // Ensure this is correct based on your data structure
                            org,
                            apiEmail: account.Email,
                            shipmentDetails
                        });
                        shipmentFound = true;
                        break; // Exit the loop once shipment details are found
                    }
                } catch (error) {
                    console.error(chalk.red(`Error fetching shipment details from ${org} (${account.Email}): ${error.message}`));
                }
            }
        }
        if (shipmentFound) break; // Break out of the outer loop if shipment details have been found
    }

    if (!shipmentFound) {
        console.log(chalk.yellow(`Order number ${orderNumber} not found in any configured API.`));
        res.status(404).send('No shipment found for the provided order number across all APIs.');
    }
});

app.get('/get-tracking-by-order_TEST2/:orderNumber', async (req, res) => {
    const orderNumber = req.params.orderNumber;
    const shipStationApiUrl = `https://ssapi.shipstation.com/shipments?orderNumber=${orderNumber}`;

    try {
        const response = await axios.get(shipStationApiUrl, {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`, // Use your encoded API credentials
                'Content-Type': 'application/json'
            }
        });

        // Check if the response contains shipment data
        if (response.data && response.data.shipments && response.data.shipments.length > 0) {
            const shipmentDetails = response.data.shipments[0]; // Assuming you're interested in the first shipment
            console.log(`Order number found: ${response.data.shipments[0].orderNumber}`);

            res.json({
                orderNumber: shipmentDetails.orderNumber, // Ensure this is correct based on your data structure
                shipmentDetails
            });
        } else {
            res.status(404).send('No shipment found for the provided order number in: /get-tracking-by-order/:orderNumber 404');
        }
    } catch (error) {
        console.error('Error fetching shipments:', error.message);
        res.status(500).send('Error fetching shipment details in: /get-tracking-by-order/:orderNumber 500');
    }
});




 
 
 // Gets all results of ware
 app.get('/get-warehouses', async (req, res) => {
    try {
        const response = await axios.get('https://ssapi.shipstation.com/warehouses', {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`
            }
        });

        res.json(response.data);
    } catch (error) {
        console.error('Error fetching warehouses:', error.message);
        res.status(500).send('Error fetching warehouses');
    }
});

// Gets all results of Warehouse BY ID. 
app.get('/get-warehouse/:warehouseId', async (req, res) => {
    const warehouseId = req.params.warehouseId;

    try {
        const warehousesResponse = await axios.get('https://ssapi.shipstation.com/warehouses', {
            headers: {
                'Authorization': `Basic ${encodedCredentials}`
            }
        });

        const warehouse = warehousesResponse.data.find(w => w.warehouseId.toString() === warehouseId);

        if (!warehouse) {
            return res.status(404).send('Warehouse not found');
        }
/*
        const result = {
            warehouseName: warehouse.warehouseName,
            originAddress: {
                name: warehouse.originAddress.name,
                company: warehouse.originAddress.company
            }
        };
	   res.json(result);
*/
        res.json(warehouse);
    } catch (error) {
        console.error('Error fetching warehouse:', error.message);
        res.status(500).send('Error fetching warehouse');
    }
});
 
 
 

 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
 
async function updateLocalShippingStatus() {
    const localOrders = getLocalOrders(); // Function to get orders from your local database
    for (const order of localOrders) {
        if (rateLimitReached()) {
            await waitForRateLimitReset(); // Function that waits until rate limit reset
        }
        try {
            const shipStationOrder = await getOrderFromShipStation(order.orderNumber); // Function to get order status from ShipStation
            if (shipStationOrder) {
                updateLocalOrderStatus(order.orderNumber, shipStationOrder.status); // Function to update local database
            }
        } catch (error) {
            console.error(`Error updating order ${order.orderNumber}: ${error}`);
            // Handle error or log it
        }
    }
    console.log('Local shipping status update complete.');
}

// Function to check if rate limit is reached
function rateLimitReached() {
    // Implement logic to check rate limit
}

// Function to wait for rate limit reset
async function waitForRateLimitReset() {
    // Implement waiting logic based on 'X-Rate-Limit-Reset'
}

// Implement other necessary functions like getLocalOrders, getOrderFromShipStation, updateLocalOrderStatus

 
 
 
 
 
 
 
 
 
 


 
 
 
 
 
 
 

 /*
		// Update existing device details
        existingDevice.OrderNumber = orderNumber || existingDevice.OrderNumber;
        existingDevice.model = model || existingDevice.model;
        existingDevice.cpu = cpu || existingDevice.cpu;
        existingDevice.ram = ram || existingDevice.ram;
        existingDevice.hd = hd || existingDevice.hd;
        existingDevice.windowsVersion = windowsVersion || existingDevice.windowsVersion;
        existingDevice.sku = sku || existingDevice.sku;
        existingDevice.notes = notes || existingDevice.notes;
*/





//regex.js
// Function to parse device details from the item nameconst { 
const { parseDeviceDetailsFromName } = require('./module/regex.js');
//parseDeviceDetailsFromName(app);
const ipp = require('ipp');
const Printer = ipp.Printer;
const printerUrl = "ipp://192.168.1.156:631/ipp/print";

const formatPrintData = (data) => {
    let output = '';
    for (const key in data) {
        output += `${key}: ${data[key]}\n`;
    }
    return output;
};

app.post('/print', (req, res) => {
    const printData = req.body;
    console.log('Received print data:', printData);
    const formattedData = formatPrintData(printData);
    const tempFilePath = path.join(__dirname, 'tempPrintFile.txt');
    fs.writeFileSync(tempFilePath, formattedData);

    const printer = new Printer(printerUrl);
    const fileBuffer = fs.readFileSync(tempFilePath);

    const msg = {
        "operation-attributes-tag": {
            "requesting-user-name": "Node User",
            "job-name": "Print Job",
            "document-format": "application/octet-stream" // Change as needed
        },
        data: fileBuffer
    };

    printer.execute("Print-Job", msg, function(err, response) {
        if (err) {
            console.error('Error:', err);
            res.status(500).send(`Print error: ${err.message}`);
        } else {
            console.log('Printed:', response);
            res.send('Print job sent successfully.');
        }
    });
});

app.get('/print-status/:jobId', (req, res) => {
    const jobId = req.params.jobId;
    const printer = new Printer(printerUrl);

    printer.execute("Get-Job-Attributes", {
        "operation-attributes-tag": {
            "job-id": jobId // Just use job-id for querying
        }
    }, function(err, response) {
        if (err) {
            console.error('Error querying job status:', err);
            res.status(500).send(`Error querying job status: ${err.message}`);
        } else {
            console.log('Job status:', response);
            res.send(response);
        }
    });
});










// Path to your label file
//const labelFilePath = 'Labeltemplate.dymo';  
const labelFilePath = 'Labeltemplate.dymo'; // Path to your .dymo file

// Function to read the .dymo file
const readDymoFile = (filePath) => {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(data);
    });
  });
};

// Function to print the label
const printLabel = async (labelXml) => {
  const Print_config = {
    printerName: "DYMO LabelManager 280",
    labelXml: labelXml,
    // Adjust or remove printParamsXml based on requirements or supported features for LabelManager 280
    //printParamsXml: '<LabelWriterPrintParams/>', // Review if specific params are needed for LabelManager
    //labelSetXml: '<LabelSet/>' // Use this if you need to print multiple labels with different text
  };
  // Your printing code here...


  try {
    const response = await axios.post('http://localhost:41951/DYMO/DLS/Printing/PrintLabel', Print_config);
    console.log('Label printed successfully:', response.data);
  } catch (error) {
    console.error('Failed to print label:', error);
  }
};

// Main function to execute the steps
const main = async () => {
  try {
    const labelXml = await readDymoFile(labelFilePath);
    await printLabel(labelXml);
  } catch (error) {
    console.error('Error:', error);
  }
};

main(); // Run the main function









const PORT = 3000;
//app.listen(PORT, () => {
//    console.log(`Server is running on port ${PORT}`);
//});


app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
			// If it exsisit show shipping status, (Reason, if status is already shipped, then we can not update in API side, This is true for ShipStation) but continue only with warnings and status of shipping.
			// Also we will add what account API this item belongs to in the 
			// const { serialNumber, orderNumber, model, cpu, ram, hd, windowsVersion, sku, notes, org, apiemail } = req.body;
			// the org will reprsent, Shipstation, walemart etc, The apiemail will reprsent the email connected to the account,
			// Now when the device sees org, ShipStation, and email name2@ShipStation.com, It will load the data of that API for that account. 
			/*
			{
  "ShipStation": [
    {
    "Name": "My persnal Name",
    "CompanyName": "ShipStation Inc.",
    "Email": "info@shoppowerprice.com",
    "api_key": "MYAPIKEY1",
    "api_secret": "MYSECRETAPI1"
    },
	{
      "Name": "Name 2",
      "CompanyName": "ShipStation Inc.",
      "Email": "name2@ShipStation.com",
      "api_key": "ShipStation_api_key_2",
      "api_secret": "ShipStation_api_secret_2"
    }
  ],
  "Walmart": [
    {
    "Name": "Walmart",
    "CompanyName": "Walmart Inc.",
    "Email": "contact@walmart.com",
    "api_key": "walmart_api_key",
    "api_secret": "walmart_api_secret"
    } 
  ],
  "Newegg": [
    {
    "Name": "Newegg",
    "CompanyName": "Newegg Inc.",
    "Email": "contact@newegg.com",
    "api_key": "newegg_api_key",
    "api_secret": "newegg_api_secret"
    }
  ] 
}
*/


