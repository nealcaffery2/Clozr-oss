// Vite's `?url` suffix: the import is the URL the bundler emitted the file at
// (lib/pdfjs.ts uses it for the pdf.js worker).
declare module '*?url' {
  const url: string;
  export default url;
}

// tesseract.js's browser ES module (lib/pdf-ocr.ts): its package entry is
// CommonJS for Node, so the app imports the built file and keeps the types.
declare module 'tesseract.js/dist/tesseract.esm.min.js' {
  const Tesseract: typeof import('tesseract.js');
  export default Tesseract;
}
