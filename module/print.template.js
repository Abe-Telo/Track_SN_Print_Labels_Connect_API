const PDFDocument = require('pdfkit');
const bwipjs = require('bwip-js');
//const printer = require('printer');

// Function to create a PDF label for a device
//module.exports = function createPdfLabel(serialNumber, res) {
module.exports = function createPdf(device, res) {
    // Create a new PDF document
    const doc = new PDFDocument({
        size: [216, 108], // 1.5in x 0.75in in points
        margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });

    // Pipe the PDF directly to the response
    doc.pipe(res);

    // Define your data here (this needs to be dynamic based on your application logic)
    let model = 'Test Model Label Surface Pro 4'; // Example data
    let date = '12/6/2023';
    let trackingNumber = '1234';
    let os = 'Windows 10 Pro';
    let storage = '512GB';
    let ram = '8GB';
    let cpu = 'i7';
    let serialNumber = 'TEST12300012';

    // Set font sizes and barcode dimensions
    const mainFontSize = 8;
    const smallFontSize = 4;
    const leftMargin = 10;
    const barcodeWidth = 196;
    const barcodeHeight = 35;
    const line1Y = 10;
    const line2Y = 25;
    const barcodeY = 40;

    // Add model name, date, and tracking number
    doc.font('Helvetica-Bold').fontSize(mainFontSize).text(model, leftMargin, line1Y, { width: 100, align: 'left' });
    doc.font('Helvetica').fontSize(smallFontSize).text(`${date}`, 108, line1Y, { width: 98, align: 'right' });
    doc.text(`${trackingNumber}`, 108, line1Y + 6, { width: 98, align: 'right' });

    // Add specs on the second line
    doc.font('Helvetica').fontSize(mainFontSize).text(`${os} | ${storage} | ${ram} | ${cpu}`, leftMargin, line2Y, { align: 'left', width: 196 - leftMargin });

    // Generate Barcode
    bwipjs.toBuffer({
        bcid: 'code39',
        text: serialNumber,
        scale: 1,
        height: 10,
        includetext: false,
        textxalign: 'center',
    }, function (err, buffer) {
        if (err) {
            console.error("Error generating barcode:", err);
            return;
        }

        // Insert the barcode
        doc.image(buffer, leftMargin, barcodeY, { width: barcodeWidth, height: barcodeHeight });

        // Add serial number text below barcode
        doc.font('Helvetica').fontSize(mainFontSize).text(serialNumber, leftMargin, barcodeY + barcodeHeight + 5, { align: 'center', width: barcodeWidth });

        // Finalize the PDF
        doc.end();
    });
};
