# Define test data
$trackingNumber = "TEST123B"
$serialNumber = "TEST12300012"
$model = "TestModel"
$cpu = "i5-8250U"
$ram = "8GB"
$hd = "256GB SSD"
$windowsVersion = "Windows 10 Pro"
$sku = "SKU123"
$notes = "Test notes"
$activationStatus = "Active"

# Construct the body
$body = @{
    trackingNumber = $trackingNumber
    serialNumber = $serialNumber
    model = $model
    cpu = $cpu
    ram = $ram
    hd = $hd
    windowsVersion = $windowsVersion
    sku = $sku
    notes = $notes
    activationStatus = $activationStatus
} | ConvertTo-Json

# Send request to the Node.js server
try {
    Write-Host "Submitting Data to Server..."
    $response = Invoke-RestMethod -Uri "http://orderassistnow.com:3000/add-or-update-device" -Method Post -Body $body -ContentType "application/json"
    Write-Host "Response from server: $($response | ConvertTo-Json -Depth 5)"
} catch {
    Write-Host "Error submitting data to server: $($_.Exception.Message)"
}

pause
