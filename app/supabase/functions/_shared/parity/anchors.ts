// Text-anchor placement (PandaDoc / DocuSign style "place the signature box
// right after 'Seller Signature:'"). doc_template_fields.anchor_text existed
// but nothing read it. Several Acme Homes PDFs still carry DocuSign anchor
// tags (\Z22hBzr\ etc.), which this also finds.
//
// Returns boxes as fractions of the displayed page, top-left origin, the
// same coordinate system pdf-fields.ts uses.

// deno-lint-ignore-file no-explicit-any
import * as pdfjs from 'npm:pdfjs-dist@4.0.379/legacy/build/pdf.mjs';

export type AnchorHit = { page: number; x: number; y: number; w: number; h: number; text: string };

export async function findAnchors(bytes: Uint8Array, anchors: string[]): Promise<Map<string, AnchorHit[]>> {
  const out = new Map<string, AnchorHit[]>(anchors.map((a) => [a, []]));
  if (!anchors.length) return out;
  const doc = await (pdfjs as any).getDocument({ data: bytes, disableWorker: true, isEvalSupported: false, useSystemFonts: false }).promise;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    // Join items line by line so an anchor split across items still matches.
    type Item = { str: string; x: number; y: number; w: number; h: number };
    const items: Item[] = [];
    for (const it of content.items as any[]) {
      if (!it.str) continue;
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const h = Math.abs(it.transform[3]) || it.height || 10;
      items.push({ str: it.str, x, y: y - h, w: it.width, h });
    }
    items.sort((a, b) => Math.round(a.y) - Math.round(b.y) || a.x - b.x);
    const lines: Item[][] = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last[0].y - it.y) < 3) last.push(it); else lines.push([it]);
    }
    for (const line of lines) {
      const text = line.map((i) => i.str).join('');
      for (const a of anchors) {
        let from = 0;
        while (true) {
          const at = text.indexOf(a, from);
          if (at < 0) break;
          // Map the char range back to item geometry (proportional within an item).
          let pos = 0, x0 = 0, x1 = 0;
          for (const it of line) {
            const s = pos, e = pos + it.str.length;
            const cw = it.w / Math.max(1, it.str.length);
            if (at >= s && at < e) x0 = it.x + (at - s) * cw;
            if (at + a.length > s && at + a.length <= e) x1 = it.x + (at + a.length - s) * cw;
            pos = e;
          }
          const h = Math.max(...line.map((i) => i.h));
          out.get(a)!.push({ page: p, x: x0 / vp.width, y: line[0].y / vp.height, w: Math.max(1, x1 - x0) / vp.width, h: h / vp.height, text: a });
          from = at + a.length;
        }
      }
    }
  }
  return out;
}
