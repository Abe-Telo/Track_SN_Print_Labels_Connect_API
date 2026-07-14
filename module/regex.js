
// Function to parse device details from the item name
function parseDeviceDetailsFromName(itemName) {
    let model = '';
    let cpu = '';
    let ram = '';
    let hd = '';
    let windowsVersion = '';
    let orderstatus = '';

    // Enhanced model extraction with inch details
    const modelRegex = /Surface (Book \d+ \d+"|Laptop \d+|Pro \d+(?: - \d+\")?|Laptop Go, \d+\.\d+"|Go \d+|Studio \d+)/;
    const modelMatch = itemName.match(modelRegex);
    if (modelMatch && modelMatch[0]) {
        model = modelMatch[0].replace(/\" Touchscreen|\" PixelSense Display|,|\s-\s.*$/g, '').trim();
    } else {
        // Fallback for models not matching the specific pattern
        const fallbackModelRegex = /Surface [^\,]+/;
        const fallbackModelMatch = itemName.match(fallbackModelRegex);
        if (fallbackModelMatch && fallbackModelMatch[0]) {
            model = fallbackModelMatch[0];
        }
    }

    // CPU extraction - further refined
    const cpuRegex = /Intel Core i[357]-?\d+|AMD Ryzen \d+ \d+U?|Microsoft SQ \d+ Processor|Intel ATOM X[\d]+-Z[\d]+U?|Intel Core i\d+-\d+G\d+|Intel Core i\d+ Processor|Intel Core i\d+ \d+\.\d+GHz|Intel Core i\d+|Intel Atom \d+\.\d+Ghz/;
    const cpuMatch = itemName.match(cpuRegex);
    if (cpuMatch && cpuMatch[0]) {
        cpu = cpuMatch[0].split(',')[0].trim();
    }





/* THIS ALSO WORKS 
    // RAM extraction
    // Capturing only the first occurrence of GB
    const ramRegex = /(\d+\s*GB)/i;
    const ramMatch = itemName.match(ramRegex);
    if (ramMatch && ramMatch[1]) {
        ram = ramMatch[1].replace(/\s+/g, ''); // Remove any spaces within the match
    }
	
    // HD extraction
    // Ignoring the first GB/TB (usually RAM) and capturing the second occurrence
    const hdRegex = /(?:\d+\s*?(GB|TB).*?)(\d+\s*?(GB|TB))/i;
    const hdMatch = itemName.match(hdRegex);
    if (hdMatch && hdMatch[2]) {
        hd = hdMatch[2].replace(/\s+/g, ''); // Remove any spaces within the match
    }
*/	

/*
   // RAM extraction - capturing only the first occurrence of GB
    const ramRegex = /(\d+)\s*GB/i;
    const ramMatch = itemName.match(ramRegex);

    // HD extraction - capturing the second occurrence of a numeric value with GB or TB
    const hdRegex = /(\d+)\s*(GB|TB)/ig;
    let hdMatch;
    let match;
    while ((match = hdRegex.exec(itemName)) !== null) {
        if (!ramMatch || match[1] !== ramMatch[1]) {
            hdMatch = match;
        }
    }
    // Assign values to RAM and HD
    if (ramMatch && ramMatch[1]) {
        ram = ramMatch[1] + 'GB';
    }
    if (hdMatch && hdMatch[1]) {
        hd = hdMatch[1] + hdMatch[2];
    }
*/
 // Original extraction logic for model, cpu, and windowsVersion remains unchanged

// Original working code
const ramRegex = /(\d+)\s*GB/i;
const ramMatch = itemName.match(ramRegex);

// Additional logic for RAM verification
if (ramMatch) {
    const ramValue = parseInt(ramMatch[1], 10);
    // Only assign RAM if it's realistically a RAM value, 64GB or less in this case
    if (ramValue <= 64) {
        ram = ramMatch[0];
    }
}

const hdRegex = /(\d+)\s*(GB|TB)/ig;
let hdMatch;
let match;
let foundRamValue = ramMatch ? parseInt(ramMatch[1], 10) : undefined;

while ((match = hdRegex.exec(itemName)) !== null) {
    const value = parseInt(match[1], 10);
    const isRamValue = value === foundRamValue;
    const isValidHD = match[2] === 'TB' || (match[2] === 'GB' && value > 32 && !isRamValue);

    // To avoid picking the same value as RAM or unrealistic HD values
    if (!isRamValue && isValidHD) {
        hdMatch = match;
        break; // Assuming the first valid HD found is what you're interested in
    }
}

// Assigning values to RAM and HD with additional checks
if (!ram && ramMatch) {
    ram = ramMatch[1] + 'GB'; // Fallback to original RAM assignment if not done above
}
if (hdMatch) {
    hd = hdMatch[1] + hdMatch[2];
}


// Your logic to assign and use model, cpu, ram, hd, and windowsVersion continues from here...




























/*
    // RAM extraction
    const ramRegex = /[\d]+GB/;
    const ramMatch = itemName.match(ramRegex);
    if (ramMatch && ramMatch[0]) {
        ram = ramMatch[0];
    }

	

/*	
    // HD extraction - targeting the second occurrence of GB or TB
    const hdRegex = /(?:\d+GB|\d+TB).*?(\d+GB|\d+TB)/;
    const hdMatch = itemName.match(hdRegex);
    if (hdMatch && hdMatch[1]) {
        hd = hdMatch[1];
    }
/*
    // HD extraction - targeting the last GB or TB occurrence
    const hdRegex = /(\d+GB|\d+TB)(?!.*\d+GB|\d+TB)/;
    const hdMatch = itemName.match(hdRegex);
    if (hdMatch && hdMatch[0]) {
        hd = hdMatch[0];
    }

/*
    // HD extraction - targeting the second GB or TB occurrence
    const hdRegex = /(\d+GB|\d+TB).*?(\d+GB|\d+TB)/;
    const hdMatch = itemName.match(hdRegex);
    if (hdMatch && hdMatch[2]) {
        hd = hdMatch[2];
    }
/*	
    // HD extraction - further refined to accurately capture HD details
    const hdRegex = /(\d+)(GB|TB) (SSD|Hard Drive)/;
    const hdMatch = itemName.match(hdRegex);
    if (hdMatch && hdMatch[0]) {
        hd = hdMatch[1] + hdMatch[2];  // Concatenating the size and unit (GB or TB)
    } else {
        // Fallback HD extraction if SSD or Hard Drive not mentioned
        const fallbackHdRegex = /(\d+)(GB|TB)(?! RAM| Memory)/;
        const fallbackHdMatch = itemName.match(fallbackHdRegex);
        if (fallbackHdMatch && fallbackHdMatch[0]) {
            hd = fallbackHdMatch[1] + fallbackHdMatch[2];
        }
    }
*/
    // Windows Version extraction
    const windowsVersionRegex = /Windows [^\,]+/;
    const windowsVersionMatch = itemName.match(windowsVersionRegex);
    if (windowsVersionMatch && windowsVersionMatch[0]) {
        windowsVersion = windowsVersionMatch[0].split(' -')[0].trim();
    }

    return { model, cpu, ram, hd, windowsVersion };
}


module.exports = {
    parseDeviceDetailsFromName
};


/*
    // Extracting the model
    const modelRegex = /Surface [^\,]+/;
    const modelMatch = itemName.match(modelRegex);
    if (modelMatch && modelMatch[0]) {
        model = modelMatch[0];
    }
*/

//Microsoft Surface Book 3 15 i7-1065G7 16 256 SSD GTX 1660TI SMG-00001
//    name: 'Microsoft - Surface Laptop 4 13.5&reg; Touch-Screen &reg; AMD Ryzen 5 Surface Edition - 8GB Memory - 256GB Solid State Drive (Latest Model) - Platinum',