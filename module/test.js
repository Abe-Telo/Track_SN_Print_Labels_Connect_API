// test.js
module.exports = function(app) {
app.get('/archived-tracking-data', (req, res) => {
    try {
        res.json(archivedTrackingData);
    } catch (error) {
        console.error(error);
        res.status(500).send('Internal Server Error');
    }
});

};


