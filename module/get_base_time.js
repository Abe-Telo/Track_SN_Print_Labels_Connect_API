/*
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
*/

/*
const currentWeek = getCurrentWeek();
const currentMonth = getCurrentMonth();
const currentYear = getCurrentYear();

const someDateString = "2023-03-15";  // Example date

const inCurrentWeek = isCurrentWeek(someDateString, currentWeek);
const inCurrentMonth = isCurrentMonth(someDateString, currentMonth);
const inCurrentYear = isCurrentYear(someDateString, currentYear);
*/

Date.prototype.getWeek = function() {
    const firstDayOfYear = new Date(this.getFullYear(), 0, 1);
    const pastDaysOfYear = (this - firstDayOfYear) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
};

function getCurrentWeek() {
    return new Date().getWeek();
}

function isCurrentWeek(dateString, currentWeek) {
    const date = new Date(dateString);
    return date.getWeek() === currentWeek;
}

function getCurrentMonth() {
    return new Date().getMonth();  // Returns 0-11 (January is 0)
}

function isCurrentMonth(dateString, currentMonth) {
    const date = new Date(dateString);
    return date.getMonth() === currentMonth;
}

function getCurrentYear() {
    return new Date().getFullYear();
}

function isCurrentYear(dateString, currentYear) {
    const date = new Date(dateString);
    return date.getFullYear() === currentYear;
}



function pastweektrackingdata(app) {

app.get('/past-week-tracking-data', (req, res) => {
    try {
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

        const pastWeekData = archivedTrackingData.filter(item => {
            const itemDate = new Date(item.date);
            return itemDate >= oneWeekAgo;
        });

        res.json(pastWeekData);
    } catch (error) {
        console.error("Error processing past-week-tracking-data:", error);
        res.status(500).send("An error occurred while processing your request.");
    }
});
}

function pastMonthTrackingData(app) {
    app.get('/past-month-tracking-data', (req, res) => {
        try {
            const oneMonthAgo = new Date();
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

            const pastMonthData = archivedTrackingData.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= oneMonthAgo;
            });

            res.json(pastMonthData);
        } catch (error) {
            console.error("Error processing past-month-tracking-data:", error);
            res.status(500).send("An error occurred while processing your request.");
        }
    });
}

function pastThreeMonthsTrackingData(app) {
    app.get('/past-three-months-tracking-data', (req, res) => {
        try {
            const threeMonthsAgo = new Date();
            threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

            const pastThreeMonthsData = archivedTrackingData.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= threeMonthsAgo;
            });

            res.json(pastThreeMonthsData);
        } catch (error) {
            console.error("Error processing past-three-months-tracking-data:", error);
            res.status(500).send("An error occurred while processing your request.");
        }
    });
}

function pastSixMonthsTrackingData(app) {
    app.get('/past-six-months-tracking-data', (req, res) => {
        try {
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

            const pastSixMonthsData = archivedTrackingData.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= sixMonthsAgo;
            });

            res.json(pastSixMonthsData);
        } catch (error) {
            console.error("Error processing past-six-months-tracking-data:", error);
            res.status(500).send("An error occurred while processing your request.");
        }
    });
}

function pastYearTrackingData(app) {
    app.get('/past-year-tracking-data', (req, res) => {
        try {
            const oneYearAgo = new Date();
            oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

            const pastYearData = archivedTrackingData.filter(item => {
                const itemDate = new Date(item.date);
                return itemDate >= oneYearAgo;
            });

            res.json(pastYearData);
        } catch (error) {
            console.error("Error processing past-year-tracking-data:", error);
            res.status(500).send("An error occurred while processing your request.");
        }
    });
}

module.exports = {
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
};


 