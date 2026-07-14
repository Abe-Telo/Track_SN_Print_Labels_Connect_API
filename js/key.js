document.addEventListener('DOMContentLoaded', function () {
    const keysTable = document.getElementById('keys-table-body');
    const addKeyForm = document.getElementById('add-key-form-element');

    // Fetch all product keys and display them
    function fetchKeys() {
        fetch('/get-product-keys')
            .then(response => response.json())
            .then(data => {
                const tbody = document.getElementById('keys-table-body');
                tbody.innerHTML = ''; // Clear existing rows

                data.forEach((key) => {
                    const availableLicenses = key.licenseCount - key.usedLicenses || 0;
                    const licenseText = `${availableLicenses} out of ${key.licenseCount} available`;

                    const row = `
                    <tr>
                        <td style="width: 30px;><input type="checkbox" class="bulk-checkbox" data-productkey="${key.productKey}"  ></td>
                        <td>${key.version}</td>
                        <td><input type="text" name="productKey" value="${key.productKey}" readonly required></td>
                        <td>
                            <input type="number" name="usedLicenses" value="${key.usedLicenses}" style="width: 50px;"> out of ${key.licenseCount} 
                        </td>
                        <td>${new Date(key.dateAdded).toLocaleString('en-US', { timeZone: 'America/New_York' })}</td>
                        <td>
                            <form id="form-${key.productKey}">
                                <select name="used" required style="width: 100px;> // removes the no option for odd reason when adding style
                                    <option value="No" ${key.used === 'No' ? 'selected' : ''}>No</option>
                                    <option value="Yes" ${key.used === 'Yes' ? 'selected' : ''}>Yes</option>
                                </select>
                                <input type="hidden" name="productKey" value="${key.productKey}">
                            </form>
                        </td>
                        <td>${key.sn || ''}</td>
                        <td>
                            <button type="button" class="confirm-btn" onclick="updateKey('${key.productKey}', 'form-${key.productKey}')">Confirm Changes</button>
                        </td>
                    </tr>`;
                    tbody.innerHTML += row;
                });
            })
            .catch(error => console.error('Error loading product keys:', error));
    }

    // Handle license update and automatically set "used" to "Yes" when licenses are 0
    window.handleLicenseUpdate = function (productKey, input) {
        const newAvailableLicenses = parseInt(input.value);
        const form = document.getElementById(`form-${productKey}`);
        const selectUsed = form.querySelector('select[name="used"]');

        if (newAvailableLicenses === 0) {
            selectUsed.value = 'Yes';
        } else {
            selectUsed.value = 'No';
        }
    };

    // Function to update a key
    window.updateKey = function (productKey, formId) {
        console.log(`Attempting to update key with productKey: ${productKey}`);

        const form = document.getElementById(formId);
        if (!form) {
            console.error(`Form not found for productKey: ${productKey}`);
            return;
        }

        const selectUsed = form.querySelector('select[name="used"]');
        const usedLicensesInput = form.closest('tr').querySelector('input[name="usedLicenses"]');
        const usedLicenses = parseInt(usedLicensesInput.value);

        if (!selectUsed) {
            console.error(`Select element for 'used' not found in form ${formId}`);
            return;
        }

        const used = selectUsed.value;

        console.log(`Updating productKey: ${productKey}, used: ${used}, usedLicenses: ${usedLicenses}`);

        fetch('/update-product-key', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                productKey: productKey,
                used: used,
                usedLicenses: usedLicenses
            })
        })
            .then(response => response.json())
            .then(result => {
                console.log(`Update response: ${JSON.stringify(result)}`);

                if (result.success) {
                    alert('Product key updated successfully!');
                    fetchKeys(); // Refresh the keys
                } else {
                    alert('Failed to update the product key.');
                }
            })
            .catch(error => {
                console.error('Error updating product key:', error);
            });
    };

    // Apply bulk action
    window.applyBulkAction = function () {
        const action = document.getElementById('bulk-action').value;
        const selectedRows = Array.from(document.querySelectorAll('.row-checkbox:checked'))
            .map(checkbox => checkbox.dataset.productkey);

        if (action === 'delete') {
            bulkDelete(selectedRows);
        } else if (action === 'update') {
            selectedRows.forEach(productKey => {
                const form = document.getElementById(`form-${productKey}`);
                updateKey(productKey, form);
            });
        }
    };

    // Bulk delete
    function bulkDelete(selectedRows) {
        selectedRows.forEach(productKey => {
            fetch(`/delete-product-key/${productKey}`, { method: 'DELETE' })
                .then(response => response.json())
                .then(result => {
                    if (result.success) {
                        alert(`Product key ${productKey} deleted successfully!`);
                        fetchKeys();
                    }
                })
                .catch(error => {
                    console.error(`Error deleting product key ${productKey}:`, error);
                });
        });
    }

    // Format date to NY time
    function formatNYDate(dateString) {
        const date = new Date(dateString);
        const options = { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: 'numeric' };
        return date.toLocaleDateString('en-US', options);
    }

    // Event listener for adding a new product key
    addKeyForm.addEventListener('submit', function (event) {
        event.preventDefault();
        const version = document.getElementById('version').value;
        const productKey = document.getElementById('productKey').value;
        const licenseCount = document.getElementById('licenseCount').value;

        fetch('/add-product-key', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                version: version,
                productKey: productKey,
                licenseCount: parseInt(licenseCount, 10)
            })
        })
            .then(response => {
                if (response.ok) {
                    alert('New product key added successfully!');
                    addKeyForm.reset(); // Reset the form fields
                    fetchKeys(); // Refresh the list
                } else {
                    alert('Failed to add new product key.');
                }
            });
    });

    // Initially fetch keys
    fetchKeys();
});
