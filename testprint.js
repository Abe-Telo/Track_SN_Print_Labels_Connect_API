const pdfPrinter = require('pdf-to-printer');

const filePath = "C:\\Users\\Windows Deployment\\Downloads\\ShippingLabel-COWJZB7YGB9X.pdf";  // Corrected file path

pdfPrinter.print(filePath, { printer: "HP4B5CF1 (HP ENVY 5660 series)" }).then(() => {
  console.log("Print job sent successfully");
}).catch(err => {
  console.error("Error occurred:", err);
});

