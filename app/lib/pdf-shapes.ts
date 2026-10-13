// What a PDF draws, as opposed to what it says: the empty boxes and the rules
// a form uses for its blanks. Many contracts (PandaDoc and DocuSign exports,
// TREC forms) draw a box or a line where a value goes instead of typing
// underscores, so the text layer alone misses them.
//
// Walks pdf.js's operator list, keeping the transform stack, and returns
// rectangles and horizontal segments in the page's displayed coordinates
// (points, top-left origin) — the same space lib/pdf-autodetect reads text in.

import type { PdfDoc, PdfPage } from './pdfjs';
import { loadPdfJs } from './pdfjs';
import type { PageDim, TextItem } from './pdf-autodetect';

export type Shape = { page: number; kind: 'box' | 'rule'; x: number; y: number; w: number; h: number };

type Ops = Record<string, number>;
type M = [number, number, number, number, number, number];

const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * Boxes and rules on one page. `page` is 1-based, as the field tables keep it.
 * A thin filled rectangle is how most generators draw a line, so anything
 * under 2.5pt tall counts as a rule.
 */
export async function pageShapes(page: PdfPage, OPS: Ops, pageNo: number): Promise<Shape[]> {
  const vp = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  // Paint colours, so a white rectangle (a page background, a knock-out) is not read as a box.
  let fill = 0, stroke = 0;
  const colorStack: [number, number][] = [];
  const level = (a: unknown) => {
    if (typeof a === 'string') { const h = a.replace('#', ''); return Math.min(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)); }
    if (!a || typeof a !== 'object') return 0;
    const c = a as Record<number, unknown>;
    return Math.min(Number(c[0] ?? 0), Number(c[1] ?? 0), Number(c[2] ?? 0));
  };
  const out: Shape[] = [];
  // Vertical segments, only to recognise a box drawn as four separate lines.
  const sides: { x: number; y0: number; y1: number }[] = [];
  const toView = (x: number, y: number) => {
    const [ux, uy] = apply(ctm, x, y);
    return vp.convertToViewportPoint(ux, uy) as [number, number];
  };
  const pushRect = (x0: number, y0: number, x1: number, y1: number) => {
    const [ax, ay] = toView(x0, y0), [bx, by] = toView(x1, y1);
    const x = Math.min(ax, bx), y = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
    if (w < 1 && h < 1) return;
    if (h <= 2.5 && w >= 30) out.push({ page: pageNo, kind: 'rule', x, y, w, h });
    else if (w >= 24 && h >= 8 && h <= 140 && w < vp.width * 0.98) out.push({ page: pageNo, kind: 'box', x, y, w, h });
  };

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i] as unknown[];
    if (fn === OPS.save) { stack.push(ctm); colorStack.push([fill, stroke]); }
    else if (fn === OPS.restore) { ctm = stack.pop() ?? ctm; [fill, stroke] = colorStack.pop() ?? [fill, stroke]; }
    else if (fn === OPS.setFillRGBColor) fill = level(args);
    else if (fn === OPS.setStrokeRGBColor) stroke = level(args);
    else if (fn === OPS.setFillGray) fill = Number(args[0] ?? 0) * 255;
    else if (fn === OPS.setStrokeGray) stroke = Number(args[0] ?? 0) * 255;
    else if (fn === OPS.transform) ctm = mul(ctm, args as unknown as M);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args[0] as M | null;
      if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.constructPath) {
      // Only a path that is painted is on the page; one followed by a clip just masks what comes next (a watermark's frame, a logo).
      const next = ol.fnArray[i + 1];
      if (next === OPS.clip || next === OPS.eoClip || next === OPS.endPath) continue;
      // Near-white ink is invisible on the page.
      const strokes = next === OPS.stroke || next === OPS.closeStroke;
      if ((strokes ? stroke : fill) > 235) continue;
      const ops = args[0] as number[];
      const c = args[1] as number[];
      let k = 0;
      let cur: [number, number] | null = null;
      for (const op of ops) {
        if (op === OPS.rectangle) {
          const [x, y, w, h] = c.slice(k, k + 4); k += 4;
          pushRect(x, y, x + w, y + h);
        } else if (op === OPS.moveTo) {
          cur = [c[k], c[k + 1]]; k += 2;
        } else if (op === OPS.lineTo) {
          const nx = c[k], ny = c[k + 1]; k += 2;
          if (cur) {
            const [ax, ay] = toView(cur[0], cur[1]), [bx, by] = toView(nx, ny);
            // Horizontal segments only: those are the blanks.
            if (Math.abs(by - ay) <= 1.5 && Math.abs(bx - ax) >= 30) out.push({ page: pageNo, kind: 'rule', x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: 0.5 });
            else if (Math.abs(bx - ax) <= 1.5 && Math.abs(by - ay) >= 6) sides.push({ x: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) });
          }
          cur = [nx, ny];
        } else if (op === OPS.curveTo) k += 6;
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4;
      }
    }
  }
  return dedupe(joinBoxes(dedupe(out), sides, pageNo));
}

/**
 * A box drawn as four lines: two rules of the same span, one above the other,
 * with a side at each end. Both sides are required, so two signature lines
 * stacked one under the other stay two lines.
 */
function joinBoxes(shapes: Shape[], sides: { x: number; y0: number; y1: number }[], pageNo: number): Shape[] {
  const rules = shapes.filter((s) => s.kind === 'rule').sort((a, b) => a.y - b.y);
  const used = new Set<Shape>();
  const boxes: Shape[] = [];
  const side = (x: number, y0: number, y1: number) => sides.some((v) => Math.abs(v.x - x) < 3 && v.y0 <= y0 + 3 && v.y1 >= y1 - 3);
  for (const top of rules) {
    if (used.has(top)) continue;
    const bottom = rules.find((b) => b !== top && !used.has(b) && b.y - top.y >= 8 && b.y - top.y <= 140 && Math.abs(b.x - top.x) < 3 && Math.abs(b.w - top.w) < 4);
    if (!bottom || !side(top.x, top.y, bottom.y) || !side(top.x + top.w, top.y, bottom.y)) continue;
    used.add(top); used.add(bottom);
    boxes.push({ page: pageNo, kind: 'box', x: top.x, y: top.y, w: top.w, h: bottom.y - top.y });
  }
  return [...shapes.filter((s) => !used.has(s)), ...boxes];
}

/** Generators often draw the same rule twice (fill + stroke, or four sides of a box as rules). */
function dedupe(shapes: Shape[]): Shape[] {
  const out: Shape[] = [];
  for (const s of shapes) {
    if (out.some((o) => o.kind === s.kind && Math.abs(o.x - s.x) < 2 && Math.abs(o.y - s.y) < 2 && Math.abs(o.w - s.w) < 3 && Math.abs(o.h - s.h) < 3)) continue;
    out.push(s);
  }
  // A rule that is just the edge of a box is not a blank of its own.
  return out.filter((s) => s.kind === 'box' || !out.some((b) => b.kind === 'box' && s.x >= b.x - 2 && s.x + s.w <= b.x + b.w + 2 && (Math.abs(s.y - b.y) < 3 || Math.abs(s.y - (b.y + b.h)) < 3)));
}

// --------------------------------------------------------------- browser

/** Everything lib/pdf-autodetect reads from an open PDF: positioned text, page sizes and drawn shapes. */
export async function readLayout(doc: PdfDoc): Promise<{ items: TextItem[]; pages: PageDim[]; shapes: Shape[] }> {
  const lib = await loadPdfJs();
  const items: TextItem[] = [];
  const pages: PageDim[] = [];
  const shapes: Shape[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    pages.push({ width: vp.width, height: vp.height });
    for (const raw of (await page.getTextContent()).items) {
      if (!('str' in raw) || !raw.str) continue;
      const [, , c, d, e, f] = raw.transform as number[];
      const [x, y] = vp.convertToViewportPoint(e, f);
      items.push({ page: n, str: raw.str, x, y, w: raw.width, h: Math.abs(raw.height || Math.hypot(c, d)) || 10 });
    }
    try { shapes.push(...await pageShapes(page, lib.OPS as unknown as Record<string, number>, n)); } catch { /* text cues still work */ }
  }
  return { items, pages, shapes };
}
