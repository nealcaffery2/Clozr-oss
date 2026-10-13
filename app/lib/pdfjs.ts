// pdf.js, loaded only when a PDF is actually on screen (the field editor, or
// a signer opening an uploaded form) so it never weighs on the main bundle.
//
// The legacy build carries the polyfills older phone browsers need; signers
// open these links on whatever they have. The worker is a separate file Vite
// emits and serves from our own origin, which the CSP's worker-src 'self'
// allows. eval stays off: script-src has no 'unsafe-eval'.

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type PdfDoc = import('pdfjs-dist').PDFDocumentProxy;
export type PdfPage = import('pdfjs-dist').PDFPageProxy;

let loading: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  if (!loading) {
    loading = (async () => {
      const [lib, worker] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
      ]);
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/**
 * Open a PDF from a (signed) URL, or from its bytes. A file picked or dropped
 * in the browser goes in as bytes: pdf.js would fetch a blob: URL with XHR,
 * which the CSP's connect-src does not allow, and the read fails with
 * "Unexpected server response (0)". pdf.js takes the buffer over, so pass a copy
 * if it is needed again.
 */
export async function openPdf(src: string | Uint8Array): Promise<PdfDoc> {
  const lib = await loadPdfJs();
  return lib.getDocument({ ...(typeof src === 'string' ? { url: src } : { data: src }), isEvalSupported: false, disableAutoFetch: false }).promise;
}
