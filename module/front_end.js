const { runDueAutoArchive, clearSafeArchivePending } = require('./safe_archive.js');

function MarkTrackingDone(app) {
    // Check on startup, then hourly.
    runDueAutoArchive();
    setInterval(runDueAutoArchive, 60 * 60 * 1000);

    app.post('/mark-tracking-done', (req, res) => {
        try {
            const trackingNumber = (req.body && req.body.trackingNumber) ? String(req.body.trackingNumber).trim() : '';
            if (!trackingNumber) {
                return res.status(400).send('Tracking number is required.');
            }

            const active = Array.isArray(global.trackingData) ? global.trackingData : [];
            const index = active.findIndex(td => String(td.trackingNumber) === trackingNumber);
            if (index === -1) {
                return res.status(404).send('Tracking number not found.');
            }

            const [item] = active.splice(index, 1);
            clearSafeArchivePending(item);
            item.manuallyArchivedAt = new Date().toISOString();
            item.archiveReason = 'manual_done';

            if (!Array.isArray(global.archivedTrackingData)) {
                global.archivedTrackingData = [];
            }
            global.archivedTrackingData.push(item);

            global.saveTrackingData();
            global.saveArchivedTrackingData();

            console.log(`Marked done (exact TN): ${trackingNumber}`);
            return res.send('Tracking number marked as done and archived.');
        } catch (error) {
            console.error('mark-tracking-done error:', error);
            return res.status(500).send('Failed to mark tracking as done.');
        }
    });
}

module.exports = {
    MarkTrackingDone,
    runDueAutoArchive
};
