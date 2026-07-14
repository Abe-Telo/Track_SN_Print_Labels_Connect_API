/**
 * This function updates the details of a device associated with a given order number in the local database.
 * 
 * The function checks the active and archived tracking data to find a device with a matching order number.
 * When a matching device is found, only fields that are empty (null, undefined, or empty string) in the local database are updated 
 * with the values provided in the `deviceDetails` object. If a field already contains data, it remains unchanged.
 * 
 * The function works in the following steps:
 * 1. It iterates through the `trackingData` (active data) to find the matching device.
 * 2. If no device is found in the active data, it searches in the `archivedTrackingData`.
 * 3. Once the device is found, it updates only the empty fields.
 * 4. After updating the fields, it saves the changes to both active and archived tracking data by calling the global `saveTrackingData` 
 *    and `saveArchivedTrackingData` functions.
 * 
 * This process ensures that existing data is preserved, and only missing information is filled in from the `deviceDetails` object.
 * 
 * @param {string} orderNumber - The order number associated with the device.
 * @param {Object} deviceDetails - An object containing the details of the device to update (model, CPU, RAM, etc.).
 */
function updateDeviceInfoInDatabase(orderNumber, deviceDetails) {
    let deviceFound = false;

    const updateDeviceDetails = (trackingData) => {
        trackingData.forEach(trackingItem => {
            trackingItem.devices.forEach(device => {
                if (device.OrderNumber === orderNumber) {
                    // Only update fields that are empty in the local DB
                    device.model = device.model || deviceDetails.model;
                    device.cpu = device.cpu || deviceDetails.cpu;
                    device.ram = device.ram || deviceDetails.ram;
                    device.hd = device.hd || deviceDetails.hd;
                    device.windowsVersion = device.windowsVersion || deviceDetails.windowsVersion;
                    
                    // Update or create new fields
                    device.orderStatus = deviceDetails.orderStatus || device.orderStatus;
                    device.shipDate = deviceDetails.shipDate || device.shipDate;
                    device.customerNotes = deviceDetails.customerNotes || device.customerNotes;
                    device.internalNotes = deviceDetails.internalNotes || device.internalNotes;
                    
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
                    
                    deviceFound = true;
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

// Export the function
module.exports = {
    updateDeviceInfoInDatabase
};
