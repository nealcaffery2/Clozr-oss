// Templates as you would see them in PandaDoc: a card per document with its
// first page as the picture, and a preview that shows every page as it will
// be sent. A PDF template shows the actual file (its own logo, letterhead
// and design) with the fields placed on it; a plain-text template shows the
// page CLOZR renders from it, under the company letterhead from Settings.
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ListedTemplate } from '@/lib/contracts';
import { KIND_LABELS } from '@/lib/contracts';
import { type PdfTemplate, docSourceUrl, templateFields } from '@/lib/pdf-docs';
import type { FieldDef } from '@/supabase/functions/_shared/pdf-fields';
import { FIELD_META, recipientColor } from '@/supabase/functions/_shared/pdf-fields';
import { VAR_HELP } from '@/supabase/functions/_shared/doc-vars';
import { PdfPageCanvas, usePdf, useWidth } from '@/components/PdfPages';
import { CenteredDialog } from '@/components/ContractsHub';

const INK = 'var(--ink, #18181b)';
const MUTED = 'var(--meta, #71717a)';
const LINE = 'var(--divider, #e4e4e7)';
const GREEN = '#0A8560';

/** What the letterhead prints (workspace settings → company). */
export type Letterhead = { name?: string; legal?: string; address?: string; phone?: string; email?: string; logo?: string };

const roleList = (t: ListedTemplate) => (Array.isArray(t.signers) ? (t.signers as { role: string; label?: string; recipient_type?: string | null }[]) : []);

// ------------------------------------------------------------------ thumbnails

type Thumb = { src: string; pages: number };
const thumbs = new Map<string, Promise<Thumb>>();
let running = 0;
const queue: (() => void)[] = [];
/** At most two PDFs open at a time while a gallery fills. */
const slot = () => new Promise<() => void>((res) => {
  const go = () => { running++; res(() => { running--; queue.shift()?.(); }); };
  if (running < 2) go(); else queue.push(go);
});

/** Page 1 of a stored PDF as an image, rendered once per session. */
function pdfThumb(path: string): Promise<Thumb> {
  let p = thumbs.get(path);
  if (!p) {
    p = (async () => {
      const done = await slot();
      try {
        const url = await docSourceUrl(path);
        if (!url.ok) throw new Error(url.message);
        const { openPdf } = await import('@/lib/pdfjs');
        const doc = await openPdf(url.data);
        try {
          const page = await doc.getPage(1);
          const base = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: 480 / base.width });
          const c = document.createElement('canvas');
          c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
          const ctx = c.getContext('2d');
          if (!ctx) throw new Error('no canvas');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          return { src: c.toDataURL('image/jpeg', 0.82), pages: doc.numPages };
        } finally { void doc.destroy(); }
      } finally { done(); }
    })();
    p.catch(() => thumbs.delete(path));
    thumbs.set(path, p);
  }
  return p;
}

/** Only start work once the card scrolls into view. */
function useSeen<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  // No IntersectionObserver (old browsers): load straight away.
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

function PdfThumb({ path, onPages }: { path: string; onPages?: (n: number) => void }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [st, setSt] = useState<{ path: string; thumb: Thumb | null; err: boolean } | null>(null);
  useEffect(() => {
    if (!seen) return;
    let live = true;
    pdfThumb(path).then((t) => { if (live) { setSt({ path, thumb: t, err: false }); onPages?.(t.pages); } }, () => { if (live) setSt({ path, thumb: null, err: true }); });
    return () => { live = false; };
    // onPages is a report-back, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, seen]);
  const cur = st && st.path === path ? st : null;
  return (
    <div ref={ref} style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
      {/* A data: URL rendered here; nothing for next/image to optimise. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {cur?.thumb ? <img src={cur.thumb.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }} />
        : <span style={{ fontSize: '11px', color: 'var(--subtle, #a1a1aa)' }}>{cur?.err ? 'No preview' : 'Loading…'}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ text paper

type Piece = { t: 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'small'; text: string } | { t: 'sign'; role: string } | { t: 'page' };

/** The same shapes the contracts engine renders (_shared/docs.ts parse), enough to preview. */
function parseBody(body: string): Piece[] {
  const out: Piece[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ t: 'p', text: para.join(' ') }); para = []; } };
  for (const raw of body.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const m = line.match(/^\{\{\s*sign:([a-z0-9_]+)\s*\}\}$/i);
    if (m) { flush(); out.push({ t: 'sign', role: m[1].toLowerCase() }); continue; }
    if (/^---+$/.test(line.trim())) { flush(); out.push({ t: 'page' }); continue; }
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith('###### ')) { flush(); out.push({ t: 'small', text: line.slice(7) }); continue; }
    if (/^#{3,5} /.test(line)) { flush(); out.push({ t: 'h3', text: line.replace(/^#+\s*/, '') }); continue; }
    if (line.startsWith('## ')) { flush(); out.push({ t: 'h2', text: line.slice(3) }); continue; }
    if (line.startsWith('# ')) { flush(); out.push({ t: 'h1', text: line.slice(2) }); continue; }
    if (/^[-*•]\s+/.test(line.trim())) { flush(); out.push({ t: 'li', text: line.trim().replace(/^[-*•]\s+/, '') }); continue; }
    para.push(line.trim());
  }
  flush();
  return out;
}

const varName = new Map(VAR_HELP.map(([k, v]) => [k, v]));
/** Text with its {{variables}} and [Tokens] shown as the chips a signer never sees. */
function Inline({ text }: { text: string }) {
  const parts = text.replace(/\*\*(.+?)\*\*/g, '$1').split(/(\{\{[^}]+\}\}|\[[A-Z][A-Za-z]*\.[A-Za-z0-9]+\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const v = p.match(/^\{\{\s*([a-z0-9_.]+)(\|[^}]*)?\s*\}\}$/i);
        const tk = p.match(/^\[([A-Z][A-Za-z]*)\.([A-Za-z0-9]+)\]$/);
        if (v || tk) {
          const label = v ? varName.get(v[1]) ?? v[1] : tk![1] === 'Fill' ? tk![2].replace(/([a-z])([A-Z])/g, '$1 $2') : `${tk![1]} ${tk![2]}`;
          return <span key={i} style={{ background: 'var(--mint-dim, #e7f8f1)', color: '#065f46', borderRadius: '3px', padding: '0 3px', fontWeight: 600, whiteSpace: 'nowrap' }}>{label}</span>;
        }
        return <React.Fragment key={i}>{p}</React.Fragment>;
      })}
    </>
  );
}

/** One plain-text template as letter-size pages, under the letterhead. 612px wide, like the PDF. */
export function TextPaper({ body, title, head, signers, pageLimit }: { body: string; title: string; head: Letterhead; signers: { role: string; label?: string }[]; pageLimit?: number }) {
  const pages = useMemo(() => {
    const out: Piece[][] = [[]];
    for (const b of parseBody(body)) { if (b.t === 'page') out.push([]); else out[out.length - 1].push(b); }
    return out.filter((p, i) => p.length || i === 0);
  }, [body]);
  const shown = pageLimit ? pages.slice(0, pageLimit) : pages;
  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      {shown.map((blocks, n) => (
        <div key={n} style={{ width: '612px', minHeight: '792px', background: 'var(--surface, #fff)', boxShadow: '0 1px 3px rgba(0,0,0,.12)', padding: '30px 54px 48px', boxSizing: 'border-box', fontFamily: 'Helvetica, Arial, sans-serif', color: INK, position: 'relative' }}>
          <Letterhead head={head} title={title} />
          {blocks.map((b, i) => {
            switch (b.t) {
              case 'h1': return <div key={i} style={{ textAlign: 'center', fontWeight: 700, fontSize: '15px', margin: '10px 0 10px' }}><Inline text={b.text} /></div>;
              case 'h2': return <div key={i} style={{ fontWeight: 700, fontSize: '12.5px', margin: '10px 0 5px' }}><Inline text={b.text} /></div>;
              case 'h3': return <div key={i} style={{ fontWeight: 700, fontSize: '11.5px', color: '#333', margin: '10px 0 4px' }}><Inline text={b.text} /></div>;
              case 'small': return <div key={i} style={{ fontSize: '8.5px', color: MUTED, margin: '0 0 3px' }}><Inline text={b.text} /></div>;
              case 'li': return <div key={i} style={{ fontSize: '10px', lineHeight: 1.38, paddingLeft: '20px', position: 'relative', margin: '0 0 2px' }}><span style={{ position: 'absolute', left: '8px' }}>•</span><Inline text={b.text} /></div>;
              case 'p': return <p key={i} style={{ fontSize: '10px', lineHeight: 1.38, margin: '0 0 6px' }}><Inline text={b.text} /></p>;
              case 'sign': {
                const s = signers.find((x) => x.role === b.role);
                return (
                  <div key={i} style={{ margin: '14px 0 10px' }}>
                    <div style={{ fontSize: '8.5px', fontWeight: 700, color: MUTED }}>{s?.label ?? b.role}</div>
                    <div style={{ display: 'flex', gap: '30px', marginTop: '40px' }}>
                      <div style={{ flex: '0 0 260px', borderTop: `0.7px solid ${INK}`, fontSize: '7.5px', color: MUTED, paddingTop: '3px' }}>Signature</div>
                      <div style={{ flex: 1, borderTop: `0.7px solid ${INK}`, fontSize: '7.5px', color: MUTED, paddingTop: '3px' }}>Date</div>
                    </div>
                  </div>
                );
              }
              default: return null;
            }
          })}
          <div style={{ position: 'absolute', bottom: '22px', left: 0, right: 0, textAlign: 'center', fontSize: '8px', color: MUTED }}>Page {n + 1} of {pages.length}</div>
        </div>
      ))}
    </div>
  );
}

/** The top of every page CLOZR renders: logo (or name) on the left, contact details on the right, a green rule under. */
function Letterhead({ head, title }: { head: Letterhead; title: string }) {
  const contact = [head.address, [head.phone, head.email].filter(Boolean).join(' · ')].filter(Boolean);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', paddingBottom: '8px', borderBottom: `1.5px solid ${GREEN}`, marginBottom: '18px', minHeight: '34px' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {head.logo ? <img src={head.logo} alt="" style={{ maxHeight: '34px', maxWidth: '150px', objectFit: 'contain' }} />
        : <span style={{ fontWeight: 700, fontSize: '12px' }}>{head.name || 'Your company'}</span>}
      <span style={{ flex: 1 }} />
      <span style={{ textAlign: 'right', fontSize: '7.5px', lineHeight: 1.35, color: MUTED }}>
        {contact.length ? contact.map((c, i) => <span key={i} style={{ display: 'block' }}>{c}</span>) : <span>{title}</span>}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ card

export function TemplateCard({ t, head, folder, selected, draggable, onOpen, onDragStart, onDragEnd }: {
  t: ListedTemplate; head: Letterhead; folder?: string | null; selected?: boolean; draggable?: boolean;
  onOpen: () => void; onDragStart?: (e: React.DragEvent) => void; onDragEnd?: () => void;
}) {
  const pdf = (t as PdfTemplate).mode === 'pdf';
  const path = (t as PdfTemplate).pdf_path ?? null;
  const [pages, setPages] = useState<number | null>(null);
  const roles = roleList(t);
  const W = 196;
  return (
    <button type="button" onClick={onOpen} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd} className="tg-card"
      style={{ display: 'flex', flexDirection: 'column', textAlign: 'left', padding: 0, border: `1px solid ${selected ? GREEN : LINE}`, borderRadius: '12px', background: 'var(--surface, #fff)', cursor: 'pointer', overflow: 'hidden', fontFamily: 'inherit', minWidth: 0 }}>
      <div style={{ position: 'relative', height: '220px', background: 'var(--surface-2, #f4f4f5)', overflow: 'hidden', borderBottom: `1px solid ${LINE}` }}>
        <div style={{ position: 'absolute', left: '50%', top: '14px', width: `${W}px`, height: '240px', marginLeft: `-${W / 2}px`, background: 'var(--surface, #fff)', boxShadow: '0 1px 4px rgba(0,0,0,.14)', overflow: 'hidden' }}>
          {pdf && path ? <PdfThumb path={path} onPages={setPages} /> : (
            <div style={{ transform: `scale(${W / 612})`, transformOrigin: 'top left', width: '612px', pointerEvents: 'none' }}>
              <TextPaper body={t.body_md} title={t.name} head={head} signers={roles} pageLimit={1} />
            </div>
          )}
        </div>
        <span style={{ position: 'absolute', top: '8px', left: '8px', fontSize: '11px', fontWeight: 800, borderRadius: '5px', padding: '2px 6px',
          background: pdf ? '#0A8560' : '#fff', color: pdf ? '#fff' : MUTED, border: pdf ? 0 : `1px solid ${LINE}` }}>{pdf ? 'Your document' : t.built_in ? 'Built-in text' : 'Text'}</span>
        {t.archived_at ? <span style={{ position: 'absolute', top: '8px', right: '8px', fontSize: '11px', fontWeight: 800, borderRadius: '5px', padding: '2px 6px', background: 'var(--tint-orange-2, #ffedd5)', color: 'var(--tx-orange-deep, #9a3412)' }}>Archived</span> : null}
      </div>
      <div style={{ padding: '10px 12px 12px', minWidth: 0 }}>
        <div style={{ fontSize: '13px', fontWeight: 650, color: t.archived_at ? 'var(--subtle, #a1a1aa)' : INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.name}>{t.name}</div>
        <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {KIND_LABELS[t.kind as keyof typeof KIND_LABELS] ?? t.kind}
          {pages ? ` · ${pages} page${pages === 1 ? '' : 's'}` : ''}
          {roles.length ? ` · ${roles.map((r) => r.label || r.role).join(', ')}` : ''}
        </div>
        {folder || t.used ? (
          <div style={{ fontSize: '11px', color: 'var(--subtle, #a1a1aa)', marginTop: '3px' }}>{[folder, t.used ? `used ${t.used}×` : null].filter(Boolean).join(' · ')}</div>
        ) : null}
      </div>
    </button>
  );
}

// ------------------------------------------------------------------ preview

/** Every page as it will be sent, with the template's details and actions beside it. */
export function TemplatePreview({ t, head, folder, onClose, children }: {
  t: ListedTemplate; head: Letterhead; folder?: string | null; onClose: () => void; children?: React.ReactNode;
}) {
  const pdf = (t as PdfTemplate).mode === 'pdf';
  const roles = roleList(t);
  const [url, setUrl] = useState<{ path: string; url: string | null; err: string | null } | null>(null);
  const [fields, setFields] = useState<{ id: number; rows: FieldDef[] } | null>(null);
  const [showFields, setShowFields] = useState(true);
  const path = (t as PdfTemplate).pdf_path ?? null;
  useEffect(() => {
    if (!pdf || !path) return;
    let live = true;
    void docSourceUrl(path).then((r) => { if (live) setUrl({ path, url: r.ok ? r.data : null, err: r.ok ? null : r.message }); });
    void templateFields(t.id).then((rows) => { if (live) setFields({ id: t.id, rows }); });
    return () => { live = false; };
  }, [pdf, path, t.id]);
  const cur = url && url.path === path ? url : null;
  const { doc, sizes, error, loading } = usePdf(cur?.url ?? null);
  const [paneRef, paneW] = useWidth<HTMLDivElement>();
  const pw = Math.max(240, Math.min(paneW - 40, 820));
  const fs = fields && fields.id === t.id ? fields.rows : [];
  const colorOf = (role: string) => recipientColor(Math.max(0, roles.findIndex((r) => r.role === role)));
  const textScale = Math.min(1, pw / 612);

  return (
    <CenteredDialog title={t.name} onClose={onClose} width={1240} z={120}>
      <style>{TP_CSS}</style>
      <div className="tp-wrap">
        <div ref={paneRef} className="tp-pages">
          {pdf ? (
            cur?.err || error ? <div style={{ padding: '40px', textAlign: 'center', color: 'var(--tx-red, #b91c1c)', fontSize: '13px' }}>{cur?.err ?? error}</div>
            : loading || !doc ? <div style={{ padding: '40px', textAlign: 'center', color: MUTED, fontSize: '13px' }}>Loading the document…</div>
            : sizes.map((sz, i) => {
              const h = Math.round(pw * sz.height / sz.width);
              return (
                <div key={i} style={{ position: 'relative', width: `${pw}px`, height: `${h}px`, margin: '0 auto', boxShadow: '0 1px 4px rgba(0,0,0,.16)' }}>
                  <PdfPageCanvas doc={doc} page={i + 1} width={pw} height={h} />
                  {showFields ? fs.filter((f) => f.page === i + 1).map((f, j) => (
                    <div key={j} title={`${f.label || FIELD_META[f.type].label} · ${roles.find((r) => r.role === f.role)?.label ?? f.role}`}
                      style={{ position: 'absolute', left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, border: `1.5px solid ${colorOf(f.role)}`, background: `${colorOf(f.role)}22`, borderRadius: '3px', boxSizing: 'border-box', overflow: 'hidden', fontSize: '9px', lineHeight: 1.1, color: colorOf(f.role), fontWeight: 700, padding: '1px 3px', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                      {f.label || FIELD_META[f.type].label}
                    </div>
                  )) : null}
                  <div style={{ position: 'absolute', bottom: '-18px', right: 0, fontSize: '10.5px', color: MUTED }}>Page {i + 1} of {sizes.length}</div>
                </div>
              );
            })
          ) : (
            <div style={{ width: `${612 * textScale}px`, margin: '0 auto' }}>
              <div style={{ transform: `scale(${textScale})`, transformOrigin: 'top left', width: '612px' }}>
                <TextPaper body={t.body_md} title={t.name} head={head} signers={roles} />
              </div>
            </div>
          )}
        </div>
        <aside className="tp-side">
          <div style={{ fontSize: '11px', fontWeight: 800, color: pdf ? GREEN : MUTED }}>{pdf ? 'Your document' : t.built_in ? 'Built-in text template' : 'Text template'}</div>
          <div style={{ fontSize: '12.5px', color: 'var(--muted, #52525b)', lineHeight: 1.5 }}>
            {KIND_LABELS[t.kind as keyof typeof KIND_LABELS] ?? t.kind}{folder ? ` · ${folder}` : ''}
            {sizes.length ? ` · ${sizes.length} page${sizes.length === 1 ? '' : 's'}` : ''}
            {t.used ? ` · used ${t.used}×` : ''}
          </div>
          {!pdf ? (
            <div style={{ fontSize: '12px', color: MUTED, lineHeight: 1.5, background: 'var(--canvas, #fafafa)', border: `1px solid ${LINE}`, borderRadius: '8px', padding: '8px 10px' }}>
              CLOZR lays this one out itself, under your letterhead (logo and details from Settings → Contracts). To send your own design instead, upload the PDF and it replaces this.
            </div>
          ) : null}
          <div>
            <div style={{ fontSize: '11.5px', color: MUTED, fontWeight: 600, marginBottom: '6px' }}>Recipients</div>
            {roles.map((r) => {
              const n = fs.filter((f) => f.role === r.role).length;
              return (
                <div key={r.role} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', padding: '4px 0' }}>
                  <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: colorOf(r.role), flex: 'none' }} />
                  <span style={{ flex: 1, fontWeight: 600 }}>{r.label || r.role}{r.recipient_type === 'filler' ? <span style={{ color: MUTED, fontWeight: 400 }}> · fills in</span> : null}</span>
                  {pdf ? <span style={{ color: MUTED, fontSize: '11.5px' }}>{n} field{n === 1 ? '' : 's'}</span> : null}
                </div>
              );
            })}
          </div>
          {pdf ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12.5px' }}>
              <input type="checkbox" checked={showFields} onChange={(e) => setShowFields(e.target.checked)} /> Show fields ({fs.length})
            </label>
          ) : null}
          <div style={{ display: 'grid', gap: '6px', marginTop: '4px' }}>{children}</div>
        </aside>
      </div>
    </CenteredDialog>
  );
}

const TP_CSS = `
.tp-wrap { display: flex; gap: 16px; align-items: flex-start; margin: -18px; min-height: 70vh; }
.tp-pages { flex: 1; min-width: 0; display: grid; gap: 30px; padding: 24px 20px 40px; background: #e9e9ec; max-height: 80vh; overflow: auto; }
.tp-side { flex: 0 0 270px; display: grid; gap: 12px; padding: 18px 18px 18px 0; align-content: start; }
@media (max-width: 860px) {
  .tp-wrap { flex-direction: column; }
  .tp-side { flex: none; width: 100%; padding: 0 18px 18px; box-sizing: border-box; }
  .tp-pages { max-height: none; width: 100%; box-sizing: border-box; }
}
.tg-card { transition: box-shadow .15s, transform .15s, border-color .15s; }
.tg-card:hover { box-shadow: 0 6px 20px rgba(0,0,0,.08); transform: translateY(-1px); }
`;
export const GALLERY_CSS = TP_CSS;
