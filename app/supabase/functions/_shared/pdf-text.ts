// A PDF's text layer, page by page, for Lane resources (lane-resources).
// Same pdf.js build as parity/anchors.ts; imported lazily by the caller so a
// pdf.js problem only breaks PDF uploads.

// deno-lint-ignore-file no-explicit-any
import * as pdfjs from 'npm:pdfjs-dist@4.0.379/legacy/build/pdf.mjs';

/** Every page's text, pages separated by a blank line. Empty for a scan. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await (pdfjs as any).getDocument({ data: bytes, disableWorker: true, isEvalSupported: false, useSystemFonts: false }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    let s = '';
    for (const it of content.items as any[]) {
      if (typeof it.str !== 'string') continue;
      s += it.str + (it.hasEOL ? '\n' : it.str && !it.str.endsWith(' ') ? ' ' : '');
    }
    pages.push(s.replace(/[ \t]+/g, ' ').replace(/ \n/g, '\n').trim());
  }
  return pages.join('\n\n');
}
