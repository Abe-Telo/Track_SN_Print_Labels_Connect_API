const { ThermalPrinter, PrinterTypes, CharacterSet, BreakLine } = require('node-thermal-printer');

async function printReceipt() {
  let printer = new ThermalPrinter({
    type: PrinterTypes.Brother,                                   
    interface: 'tcp://192.168.1.156',                          // Replace 'xxx.xxx.xxx.xxx' with your printer's IP address
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

  // Example of printing
  printer.println("Hello World");
  printer.drawLine();
  
  // Continue with other printer commands as needed

  try {
    let execute = await printer.execute();
    console.log('Printing completed');
  } catch (error) {
    console.error('Error:', error);
  }

  printer.clear();
}

printReceipt().catch(console.error);


