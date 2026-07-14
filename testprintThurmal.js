const PDFDocument = require('pdfkit');
const fs = require('fs');
const bwipjs = require('bwip-js');

function createLabelPreview() {
  const doc = new PDFDocument({ size: [288, 96] }); // Size in points (1 inch = 72 points)

  doc.pipe(fs.createWriteStream('label-preview.pdf'));

  // Add text to the document
  doc.fontSize(10).text('Surface Pro 4', 10, 3);
  doc.text('Windows 10 Pro | 512GB | 8GB | i7', 10, 10);
  doc.text('12/6/2023', 230, 10);
  doc.text('1234', 220, 15);

  // Generate and insert barcode
  bwipjs.toBuffer({
      bcid: 'code128',       
      text: '0F00RUN213801J',          
      scale: 1,              
      height: 3,            
      includetext: true,     
      textxalign: 'center',  
  }, function (err, png) {
      if (err) {
          console.error(err);
      } else {
          doc.image(png, 30, 50); // Adjust position and size as needed
          doc.end();
      }
  });
}

createLabelPreview();

const { ThermalPrinter, PrinterTypes, CharacterSet, BreakLine } = require('node-thermal-printer');

async function printLabel() {
  let printer = new ThermalPrinter({
    type: PrinterTypes.Brother,
    interface: 'tcp://192.168.1.156',
    characterSet: CharacterSet.PC852_LATIN2,
    removeSpecialCharacters: false,
    lineCharacter: "=",
    breakLine: BreakLine.WORD,
    options: {
      timeout: 5000
    }
  });

  let isConnected = await printer.isPrinterConnected();
  console.log('Printer connected:', isConnected);
  if (!isConnected) return;

  printer.println("Surface Pro 4");
  printer.println("Windows 10 Pro | 512GB | 8GB | i7");
  printer.println("12/6/2023");
  printer.println("Serial Number: 1234");
  printer.printBarcode("1234", 73); // Code 128

  try {
    let execute = await printer.execute();
    console.log('Printing completed');
  } catch (error) {
    console.error('Error:', error);
  }

  printer.clear();
}

printLabel().catch(console.error);
