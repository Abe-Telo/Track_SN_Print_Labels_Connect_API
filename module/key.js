const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const { atomicWriteJsonSync } = require('./atomic_json.js');

// Database path
const dbPath = path.join(__dirname, '../db/windows_keys.json');

// Function to load the database
function loadDatabase() {
    if (fs.existsSync(dbPath)) {
        return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    }
    return [];
}

// Function to save to the database
function saveDatabase(data) {
    atomicWriteJsonSync(dbPath, data);
}

// Function to initialize routes
function AddproductKey(app) {
    // Middleware
    app.use(bodyParser.urlencoded({ extended: true }));
    app.use(bodyParser.json());

    // Route to display the HTML form for adding a new product key
    app.get('/add-product-key', (req, res) => {
        res.sendFile(path.join(__dirname, '../html/add_key.html'));
    });

    // Route to handle adding a new product key
    app.post('/add-product-key', (req, res) => {
        const { version, productKey, licenseCount, sn } = req.body;
        const db = loadDatabase();

        // Check if the product key already exists
        const existingKey = db.find(entry => entry.productKey === productKey);

        if (existingKey) {
            // If the product key exists and SN is provided, append it to the SN array
            if (sn && !existingKey.sn.includes(sn)) {
                existingKey.sn.push(sn);
            }
        } else {
            // Create a new entry if the product key doesn't exist
            const newEntry = {
                version,
                productKey,
                licenseCount: parseInt(licenseCount, 10),
                usedLicenses: 0, // Initialize as 0 used licenses
                dateAdded: new Date().toISOString(),
                used: 'No',
                sn: sn ? [sn] : [] // Store SN as an array
            };
            db.push(newEntry);
        }

        saveDatabase(db);
        res.json({ success: true, message: 'Product key added/updated successfully!' });
    });

    // Route to handle updating a product key
    app.post('/update-product-key', (req, res) => {
        const { productKey, used, usedLicenses } = req.body;

        console.log(`Received update request for productKey: ${productKey}, Used: ${used}, UsedLicenses: ${usedLicenses}`);

        const db = loadDatabase();
        const entry = db.find(e => e.productKey === productKey);

        if (entry) {
            // Update the 'used' status and the number of used licenses
            entry.used = used;
            entry.usedLicenses = usedLicenses;

            // Automatically set 'used' to 'Yes' if all licenses are used
            if (parseInt(usedLicenses, 10) === entry.licenseCount) {
                entry.used = 'Yes';
            }

            saveDatabase(db);
            console.log(`Product key ${productKey} updated successfully.`);
            res.json({ success: true });
        } else {
            console.log(`Product key ${productKey} not found.`);
            res.status(404).json({ success: false, message: 'Product key not found' });
        }
    });

    // Route to handle deleting a product key
    app.delete('/delete-product-key/:productKey', (req, res) => {
        const { productKey } = req.params;
        const db = loadDatabase();
        const updatedDb = db.filter(entry => entry.productKey !== productKey);

        if (db.length === updatedDb.length) {
            console.log(`Product key ${productKey} not found.`);
            return res.status(404).json({ success: false, message: 'Product key not found' });
        }

        saveDatabase(updatedDb);
        console.log(`Product key ${productKey} deleted successfully.`);
        res.json({ success: true });
    });

    // Route to get all product keys
    app.get('/get-product-keys', (req, res) => {
        const db = loadDatabase();
        res.json(db); // Send all product keys as a JSON response
    });
}

module.exports = {
    AddproductKey
};
