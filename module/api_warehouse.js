 //NEEDES TO BE ADDED TO ADD.JS
 
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