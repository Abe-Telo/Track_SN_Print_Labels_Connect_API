# PowerShell Script to Interact with Express Server

# Function to send POST request to your server
function Send-DeviceDetails($serialNumber, $orderNumber) {
    # Using regular expression to extract the tracking number
    # Adjust the regular expression as per your requirement
    $orderNumber = if ($orderNumber -match "[0-9]{22}") { $matches[0] } else { $orderNumber }

 
     
    $url = 'http://localhost:3000/add-or-update-device' # Replace with your actual server URL
    $body = @{
        serialNumber = $serialNumber
        orderNumber = $orderNumber
        #model = "NEW (Never Tested)"
        model = ""
        cpu = ""
        ram = ""
        hd = ""
        windowsVersion = ""
        sku = ""
        notes = ""
    } | ConvertTo-Json

    try {
        $response = Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType "application/json"
        Write-Output "Response from server: "
        Write-Output $response.message

        # Display information about order existence
        if ($response.orderFound) {
            #Write-Host "Order found in the system." -ForegroundColor Green
			#Write-Host "Order found in the system. Order Status: $($response.orderstatus)" -ForegroundColor Green
			Write-Host "Order found in the system. Order Status: " -NoNewline -ForegroundColor Green
			Write-Host $($response.orderstatus) -ForegroundColor Yellow
			#Write-Host $($response.operationLogs) -ForegroundColor Yellow
			#[System.Media.SystemSounds]::Asterisk.Play() # Success Sound
			#[System.Media.SystemSounds]::Exclamation.Play()
			
			# Display operation logs
            if ($response.operationLogs -and $response.operationLogs.Count -gt 0) {
                #Write-Host "Operation Logs:" -ForegroundColor Cyan
                foreach ($log in $response.operationLogs) {
                    Write-Host $log -ForegroundColor Yellow
                }
            }
        } else {
            #Write-Host "Order Number not found in the Venders system." -ForegroundColor Red
			#Write-Host "Order Number not found in $($response.org) ShipStation, Walmart, Newegg." -ForegroundColor Red
			Write-Host "Order Number not found in (ShipStation, Walmart, Newegg)" -ForegroundColor Red
			Write-Host "Currently we support only one ShipStation account" -ForegroundColor Red
            #Write-Host "This error is external and the Serial Number has still bean connected on the local server." -ForegroundColor Red
            Write-Host "If you are sure this is a correct order, then talk to Abe to fix this issue." -ForegroundColor Red
            Write-Host "Its still a good practice to scan all Barcodes, Even if you have an error." -ForegroundColor Blue
            Write-Host "Since we can still trace them" -ForegroundColor Blue
            Write-Host "If you wish to try again, Rescan the bar codes." -ForegroundColor Yellow
            [System.Media.SystemSounds]::Hand.Play() # Partial Success Sound
        }

    } catch {
        Write-Error "Error: $_"
        [System.Media.SystemSounds]::Beep.Play() # Error Sound
    }
}

# Loop to keep asking for Serial Number and Order Number
while ($true) {
    $serialNumber = Read-Host "Enter Serial Number (or 'exit' to quit)"
    if ($serialNumber -eq 'exit') { break }

    $orderNumber = Read-Host "Enter Order Number"

    if (-not $serialNumber -or -not $orderNumber) {
        Write-Host "Serial Number and Order Number cannot be empty!" -ForegroundColor Red
        continue
    }

    Send-DeviceDetails -serialNumber $serialNumber -orderNumber $orderNumber
    Write-Host "`n"
}
