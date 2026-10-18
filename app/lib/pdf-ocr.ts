// Read the words off pages that have none in their text layer. zipForm and
// Lone Wolf export TXR and TREC forms with every printed word drawn as an
// outline, so "Initialed by: Seller" and "Signature of Seller" are pictures to
// pdf.js; only what someone typed into the form is text. lib/pdf-shapes finds
// those pages and lib/pdf-autodetect labels their blanks with these words.
//
// Tesseract runs in workers served from our own origin (the CSP's worker-src
// 'self'), its WebAssembly needs script-src 'wasm-unsafe-eval', and the
// English model is fetched once from jsDelivr and kept in IndexedDB.
// Everything here but mergeOcr and wordsOf runs only in the browser.

import type { TextItem } from './pdf-autodetect';
import type { PdfDoc } from './pdfjs';

/** Pixels per point the page is drawn at: about 108 dpi, enough for an 8pt footer. */
const SCALE = 1.5;

type Box = { x0: number; y0: number; x1: number; y1: number };
/** The parts of a Tesseract line this reads. */
export type OcrLine = { baseline?: Box & { has_baseline?: boolean }; words: { text: string; bbox: Box }[] };

/** A line's words as text runs in points, each on the line's own baseline so a row stays one row. */
export function wordsOf(page: number, lines: OcrLine[], scale = SCALE): TextItem[] {
  const out: TextItem[] = [];
  for (const ln of lines) {
    const b = ln.baseline && ln.baseline.has_baseline !== false && ln.baseline.x1 > ln.baseline.x0 ? ln.baseline : null;
    for (const w of ln.words) {
      const str = w.text.trim();
      // A lone letter is most often punctuation misread (a comma as "i"); "X", "I" and "a" stay.
      if (!/[a-z0-9]/i.test(str) || (str.length === 1 && !/[0-9XIa]/.test(str))) continue;
      const cx = (w.bbox.x0 + w.bbox.x1) / 2;
      const base = b ? b.y0 + ((b.y1 - b.y0) * (cx - b.x0)) / (b.x1 - b.x0) : w.bbox.y1;
      out.push({ page, str, x: w.bbox.x0 / scale, y: base / scale, w: (w.bbox.x1 - w.bbox.x0) / scale, h: Math.max(6, (base - w.bbox.y0) / scale / 0.75), ocr: true });
    }
  }
  return out;
}

/** The text layer plus the words OCR found, less those it read off text already there (a typed-in "Unknown"). */
export function mergeOcr(items: TextItem[], words: TextItem[]): TextItem[] {
  const area = (t: TextItem) => Math.max(1, t.w * t.h);
  const over = (a: TextItem, b: TextItem) => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y, b.y) - Math.max(a.y - a.h, b.y - b.h));
    return (ix * iy) / Math.min(area(a), area(b));
  };
  const kept = words.filter((w) => !items.some((it) => it.page === w.page && over(it, w) > 0.3));
  return [...items, ...kept.map((w) => ({ ...w, ocr: true }))];
}

// The SIMD build is about twice as fast; browsers without SIMD get the plain one.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`${what} took too long`)), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
};

/** OCR the given pages (1-based) of an open PDF, a few at a time. */
export async function ocrPages(doc: PdfDoc, pageNos: number[], onReading?: (page: number, of: number) => void): Promise<TextItem[]> {
  if (!pageNos.length) return [];
  const simd = WebAssembly.validate(SIMD_PROBE);
  const [{ default: { createWorker, createScheduler } }, worker, core] = await Promise.all([
    import('tesseract.js/dist/tesseract.esm.min.js'),
    import('tesseract.js/dist/worker.min.js?url'),
    simd ? import('tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url') : import('tesseract.js-core/tesseract-core-lstm.wasm.js?url'),
  ]);
  const n = Math.max(1, Math.min(3, pageNos.length, (navigator.hardwareConcurrency || 2) - 1));
  const scheduler = createScheduler();
  // Every worker that starts is stopped when this returns, even one that finishes starting after a timeout gave up on it.
  type W = Awaited<ReturnType<typeof createWorker>>;
  const started: W[] = [];
  let closed = false;
  const stop = (w: W) => { void w.terminate().catch(() => {}); };
  try {
    // The first start downloads the English model (about 10 MB), so it gets a minute.
    const workers = await withTimeout(Promise.all(Array.from({ length: n }, () =>
      createWorker('eng', 1, { workerPath: worker.default, corePath: core.default, workerBlobURL: false })
        .then((w) => { if (closed) stop(w); else started.push(w); return w; }))), 60_000, 'Starting OCR');
    for (const w of workers) scheduler.addWorker(w);
    // One page per worker at a time, so a long form never holds every page's image at once.
    const out: TextItem[] = [];
    let next = 0, done = 0;
    onReading?.(0, pageNos.length);
    await Promise.all(workers.map(async () => {
      while (next < pageNos.length) {
        const p = pageNos[next++];
        const canvas = await drawPage(doc, p);
        try {
          const { data } = await withTimeout(scheduler.addJob('recognize', canvas), 60_000, `Reading page ${p}`);
          out.push(...wordsOf(p, (data as unknown as { lines: OcrLine[] }).lines ?? []));
        } finally { canvas.width = canvas.height = 0; }
        onReading?.(++done, pageNos.length);
      }
    }));
    return out;
  } finally {
    closed = true;
    // Not scheduler.terminate(): it only knows the workers that were added, and a start that timed out added none.
    for (const w of started) stop(w);
  }
}

async function drawPage(doc: PdfDoc, pageNo: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas to read the page on');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}
