function MarkTrackingDone(app) {
    app.post('/mark-tracking-done', (req, res) => {
        const { trackingNumber } = req.body;

        // Find the tracking index
        const index = trackingData.findIndex(td => td.trackingNumber === trackingNumber);
        if (index !== -1) {
            // Move item to archive
            const item = trackingData.splice(index, 1)[0];
            archivedTrackingData.push(item);

            // Save updated data
            saveTrackingData();
            saveArchivedTrackingData();

            res.send('Tracking number marked as done and archived.');
        } else {
            res.status(404).send('Tracking number not found.');
        }
    });
}

module.exports = {
    MarkTrackingDone
};
  