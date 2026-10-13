// Vite's `?url` suffix: the import is the URL the bundler emitted the file at
// (lib/pdfjs.ts uses it for the pdf.js worker).
declare module '*?url' {
  const url: string;
  export default url;
}
