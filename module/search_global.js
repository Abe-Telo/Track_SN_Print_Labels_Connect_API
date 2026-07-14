
/*  Endpoint: /search
    Method: GET
    Purpose: Search active + archived tracking by tracking #, serial, model, order #, notes.
*/

function safeLower(value) {
    if (value === null || value === undefined) return '';
    return String(value).toLowerCase();
}

function itemMatches(item, searchTerm) {
    if (safeLower(item.trackingNumber).includes(searchTerm)) return true;
    if (!Array.isArray(item.devices)) return false;
    return item.devices.some(device =>
        safeLower(device.serialNumber).includes(searchTerm) ||
        safeLower(device.model).includes(searchTerm) ||
        safeLower(device.OrderNumber || device.orderNumber).includes(searchTerm) ||
        safeLower(device.notes).includes(searchTerm) ||
        safeLower(device.sku).includes(searchTerm)
    );
}

function searchTrackingModel(app) {
    app.get('/search', (req, res) => {
        try {
            const raw = (req.query.term || '').trim();
            if (!raw) {
                return res.json([]);
            }
            const searchTerm = raw.toLowerCase();
            const active = Array.isArray(global.trackingData) ? global.trackingData : [];
            const archived = Array.isArray(global.archivedTrackingData) ? global.archivedTrackingData : [];

            const filteredTrackingData = active
                .filter(item => itemMatches(item, searchTerm))
                .map(item => ({ ...item, isArchived: false }));

            const filteredArchivedData = archived
                .filter(item => itemMatches(item, searchTerm))
                .map(item => ({ ...item, isArchived: true }));

            res.json([...filteredTrackingData, ...filteredArchivedData]);
        } catch (error) {
            console.error('Error in /search:', error);
            res.status(500).json({ error: 'Search failed', message: error.message });
        }
    });
}

module.exports = {
    searchTrackingModel
};
