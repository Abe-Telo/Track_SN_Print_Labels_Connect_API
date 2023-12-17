# Define the log file path
$logFilePath = "$PSScriptRoot\GSFormLog.txt"
$GSForm = "https://docs.google.com/forms/u/0/d/e/1FAIpQLSebFSdVbYc4nGDuDxRdcwbzXMd7tS1LUghUmnZ8_D93MLjF6Q/formResponse"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# Function Definitions
function Write-Log {
    param([string]$message, [ConsoleColor]$color = 'White')
    Write-Host $message -ForegroundColor $color
    $message | Out-File -FilePath $logFilePath -Append
}

# Fetch system information and log
Write-Log "Fetching system information..." -color 'Yellow'
$serialNumber = (Get-WmiObject -Class Win32_BIOS).SerialNumber
$sku = (Get-ComputerInfo).CsSystemSkuNumber
$model = (Get-WmiObject -Class Win32_ComputerSystem).Model
$windowsVersionFull = (Get-ComputerInfo).OsName + " " + (Get-ComputerInfo).OsVersion
$cpu = (Get-WmiObject -Class Win32_Processor).Name
$ram = [Math]::Round((Get-ComputerInfo).CsTotalPhysicalMemory / 1GB)
$hd = [Math]::Round((Get-WmiObject -Class Win32_DiskDrive | Select-Object -First 1).Size / 1e9)
$softwareLicensingService = Get-CimInstance SoftwareLicensingProduct -Filter "partialproductkey is not null" | ? name -like windows*
$licenseStatus = $softwareLicensingService.LicenseStatus
$activationStatus = if ($licenseStatus -eq 1) { "Active" } else { "Not Active" }
$productKey = $softwareLicensingService.OA3xOriginalProductKey
$windowsVersion = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").ProductName + " " + (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion").ReleaseId

# Logging system information
$logMessages = @{
    "Serial Number" = $serialNumber
    "SKU" = $sku
    "Model" = $model
    "Windows Version" = $windowsVersionFull -replace 'Microsoft Windows', 'Windows' -replace '\s10\.0\.\d+', '' -replace '\s\d+\.\d+\.\d+', ''
    "CPU" = $cpu
    "RAM" = "${ram}GB"
    "HD" = "${hd}GB"
    "Activation Status" = $activationStatus
    "Product Key" = $productKey
    "You can install" = $windowsVersion
}

# Logging system information
foreach ($key in $logMessages.Keys) {
    Write-Log "${key}: $($logMessages[$key])" -color 'Green'
}


# Form data submission
$formData = @{
    "entry.366548140" = $serialNumber
    "entry.446059738" = $model
    "entry.155658717" = $sku
    "entry.730980097" = $logMessages["Windows Version"]
    "entry.732944140" = $cpu
    "entry.362455697" = $ram
    "entry.1305266274" = $hd
    "entry.781520028" = $activationStatus  #activated
    "entry.656484314" = $windowsVersion #can install
}

try {
    Write-Log "Submitting the form data..." -color 'Green'
    $response = Invoke-WebRequest -Uri $GSForm -Method Post -Body $formData -WebSession $session -UseBasicParsing
    Write-Log "Form submission response status: $($response.StatusCode)" -color 'Green'
} catch {
    Write-Log "Error submitting form data: $_" -color 'Red'
}

# Additional information
$trackingNumber = Read-Host "What's the tracking number?"
$numberOfPieces = Read-Host "How many pieces came in the box?"
$notes = Read-Host "Do you want to add some notes?"

$formDataUpdate = @{
    "entry.1583355117" = "$trackingNumber.$numberOfPieces"
    "entry.36246794" = $notes
    "entry.366548140" = $serialNumber
    "entry.446059738" = $model
    "entry.155658717" = $sku
    "entry.730980097" = $logMessages["Windows Version"]
    "entry.732944140" = $cpu
    "entry.362455697" = $ram
    "entry.1305266274" = $hd
    "entry.781520028" = $activationStatus  #activated
    "entry.656484314" = $windowsVersion #can install
}


try {
    Write-Log "Submitting the updated form data..." -color 'Green'
    $response = Invoke-WebRequest -Uri $GSForm -Method Post -Body $formDataUpdate -WebSession $session -UseBasicParsing
    Write-Log "Updated form submission response status: $($response.StatusCode)" -color 'Green'
} catch {
    Write-Log "Error submitting updated form data: $_" -color 'Red'
}

# Construct the body
$body = @{
    trackingNumber = $trackingNumber
    serialNumber = $serialNumber
    model = $model
    cpu = $cpu
    ram = $ram
    hd = $hd
    windowsVersion = $windowsVersion #can install
    sku = $sku
    notes = $notes
    activationStatus = $activationStatus 
} | ConvertTo-Json

# Verify Tracking Number and Update Remaining Quantity
function Verify-And-Update-Tracking {
    param([string]$lastFourDigits)
    try {
        $url = "http://localhost:3000/verify-tracking/$lastFourDigits"
        $response = Invoke-RestMethod -Uri $url -Method Get

        if ($response.Length -eq 0) {
            Write-Log "No matching tracking data found for last four digits: $lastFourDigits" -color 'Red'
            return $false
        }
		 
        # Assuming response is an array of objects and using the first one
        $matchedTracking = $response[0]
        $fullTrackingNumber = $matchedTracking.trackingNumber
        $newRemaining = $matchedTracking.remaining - 1

        # Check if no more items left before sending data to the server
        if ($newRemaining -lt 0) {
            Write-Log "No more items left for this tracking number: $fullTrackingNumber" -color 'Red'
            return $false
        }

        # Update the remaining quantity
        $updateRemainingUri = "http://localhost:3000/update-remaining"
        $updateRemainingBody = @{
            "trackingNumber" = $fullTrackingNumber
            "newQuantity" = $newRemaining
        } | ConvertTo-Json
        Invoke-RestMethod -Uri $updateRemainingUri -Method Post -Body $updateRemainingBody -ContentType "application/json"
        Write-Log "Updated remaining quantity for tracking number $fullTrackingNumber to $newRemaining" -color 'Green'

        # Construct the body for add-device
        $bodyForDevice = @{
            trackingNumber = $fullTrackingNumber
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

        # Add device details
        try {
            Write-Log "Submitting Data to Server for tracking number $fullTrackingNumber..." -color 'Green'
            $serverResponse = Invoke-RestMethod -Uri "http://localhost:3000/add-device" -Method Post -Body $bodyForDevice -ContentType "application/json"
            Write-Log "Data submission to server successful for tracking number $fullTrackingNumber" -color 'Green'
        } catch {
            Write-Log "Error submitting data to server: $($_.Exception.Message)" -color 'Red'
        }

        return $true
    } catch {
        Write-Log "Error while verifying tracking number: $_" -color 'Red'
        return $false
    }
}

 



#$trackingNumber = Read-Host "What's the tracking number?"

#$lastFourDigits = Read-Host "What's the last four digits of the tracking number?"
if (Verify-And-Update-Tracking -lastFourDigits $trackingNumber) {
    Write-Log "Verification and update successful." -color 'Green'
} else {
    Write-Log "Verification failed or no more items left." -color 'Red'
}

pause


# ... [rest of your script]

# Ask to print



$printChoice = Read-Host "Do you want to print? (yes/no)"
$lastFourDigits = "1234" # Example last four digits
$matchedTracking = @{quantity = 5} # Example matched tracking data
$serialNumber = "SN12345" # Example serial number

if ($printChoice -eq "y") {
    # Example print content (simple text)
    $printContent = @"
Surface Pro 4                                  $(Get-Date -Format "MM/dd/yyyy")
Windows 10 Pro 2009 | Ram 8 | HD 238
Intel(R) Core(TM) i7-6650U CPU @ 2.20GHz
97-7321.1                                      Last 4 of tracking: $lastFourDigits | Quantity: $($matchedTracking.quantity)
SN: $serialNumber [Barcode 39 representation needed]
"@

    # Print the content to the default printer
    #$printContent | Out-Printer

    # Open image file
    $imageFilePath = "C:\path\to\barcode_image.jpg" # Path to barcode image generated by an external tool
    Start-Process -FilePath $imageFilePath

    Write-Host "Sent to printer and image opened."
} else {
    Write-Host "Print skipped."
}

# Open the PDF file
#Start-Process -FilePath $pdfFilePath

# Open the image file
#Start-Process -FilePath $imageFilePath




pause