// Place fields on an uploaded PDF: drag a field type from the palette onto
// the page, drag it to move, pull the corner to resize. Every field belongs to
// one recipient and is drawn in that recipient's color, so it is obvious at a
// glance who fills what. A field can be bound to a Clozr Docs variable
// (deal.purchase_price …), which fills it from the record and locks it.
//
// Opens full-screen, every page in one scroll with the recipients, the field
// palette and the selected field on the right, the way PandaDoc lays it out.
// Positions are kept as fractions of the page
// (supabase/functions/_shared/pdf-fields.ts), so zoom never changes them.
//
// Prepare mode (a draft contract about to go out, PandaDoc's "prepare
// document" step): every box shows what it holds, filled from the record,
// and the sender types straight onto the page to change it. Signature,
// initials and date-signed boxes show who signs there. Send saves and sends.
//
// A document with no fields yet is auto-mapped on open (lib/pdf-autodetect):
// signatures, initials and dates go to the right recipient and values the
// record holds are bound to it, so the person checks and saves rather than
// placing every box by hand.
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PdfPageCanvas, usePdf, useWidth } from '@/components/PdfPages';
import { VAR_HELP } from '@/supabase/functions/_shared/doc-vars';
import { assignRoles, detectFields } from '@/lib/pdf-autodetect';
import { readLayout } from '@/lib/pdf-shapes';
import {
  FIELD_META, FIELD_TYPES, type FieldDef, type FieldType, clampRect, fieldAllowedFor, newField, normalizeField, recipientColor,
} from '@/supabase/functions/_shared/pdf-fields';
import { type ConditionOp, type LogicField, computeFormulas } from '@/supabase/functions/_shared/parity/field-logic';
import {
  AtSign, Calendar, CalendarCheck, CaseUpper, ChevronDown, CircleDot, DollarSign, Hash, type LucideIcon, Paperclip, PenLine, Phone, Sigma, SquareCheck, Stamp, Type,
} from 'lucide-react';

/** `party` (seller, seller2, buyer, company, other) is who the role is, for auto-mapping. */
export type EditorRole = { role: string; label: string; recipient_type?: string | null; party?: string | null };
type Props = {
  title: string;
  sourceUrl: string | null;
  roles: EditorRole[];
  initial: FieldDef[];
  onSave: (fields: FieldDef[]) => Promise<{ ok: true } | { ok: false; message: string }>;
  onClose: () => void;
  /** A sent contract: look, but do not move anything. */
  readOnly?: boolean;
  note?: string | null;
  /** The document's name and contract kind: they say which side of the deal it is, and so who "Buyer" is. Null turns auto-mapping off. */
  autoMap?: { name: string; kind: string } | null;
  /** Prepare mode: values editable on the page, and a Send button that saves then sends. */
  prepare?: { onSend: (fields: FieldDef[]) => Promise<{ ok: true } | { ok: false; message: string }> } | null;
};
type Item = FieldDef & { key: string };
type Drag = { key: string; mode: 'move' | 'resize'; px: number; py: number; start: { x: number; y: number; w: number; h: number }; pw: number; ph: number };

const INK = '#18181b';
const MUTED = '#71717a';
const LINE = '#e4e4e7';
const GREEN = '#0A8560';
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  height: '30px', padding: '0 11px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${primary ? GREEN : LINE}`, background: primary ? (disabled ? '#7fcbb2' : GREEN) : '#fff', color: primary ? '#fff' : INK, opacity: !primary && disabled ? 0.55 : 1, fontFamily: 'inherit',
});
const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: MUTED, fontWeight: 500, margin: '16px 0 6px' };
const input: React.CSSProperties = { width: '100%', height: '30px', padding: '0 8px', border: `1px solid ${LINE}`, borderRadius: '7px', fontSize: '12.5px', background: '#fff', color: INK, boxSizing: 'border-box' };
const ICON_OF: Record<FieldType, LucideIcon> = {
  signature: PenLine, initials: CaseUpper, date_signed: CalendarCheck, text: Type, number: Hash, currency: DollarSign, date: Calendar, checkbox: SquareCheck, dropdown: ChevronDown,
  radio: CircleDot, attachment: Paperclip, stamp: Stamp, formula: Sigma, email: AtSign, phone: Phone,
};
/** The field type's icon, sized to the text beside it. */
function FieldIcon({ type, size = 12 }: { type: FieldType; size?: number }) {
  const I = ICON_OF[type];
  return <I size={size} strokeWidth={2} aria-hidden style={{ flex: 'none' }} />;
}
/** Operators a "show / require when" condition offers (parity/field-logic.ts). */
const OPS: Array<[ConditionOp, string]> = [['checked', 'is ticked'], ['unchecked', 'is not ticked'], ['filled', 'is filled'], ['empty', 'is empty'], ['eq', 'equals'], ['neq', 'does not equal'], ['gt', 'is more than'], ['lt', 'is less than']];
const needsValue = (op: ConditionOp) => ['eq', 'neq', 'gt', 'lt'].includes(op);
/** In prepare mode the sender types into these on the page; the rest are for the signer. */
const fillable = (t: FieldType) => !FIELD_META[t].signs;
const signsLabel = (who: string, t: FieldType) => `${who} ${t === 'date_signed' ? 'dates' : t === 'initials' ? 'initials' : t === 'stamp' ? 'stamps' : 'signs'}`;

/**
 * A field's value on the page, editable in place: an input sized to the box,
 * a tick for checkboxes and radios, a menu for dropdowns, and a formula's
 * result shown read-only. Pointer-down stays here so typing never drags.
 */
function FillBox({ f, ph, color, value, hint, onFocus, onChange }: {
  f: FieldDef; ph: number; color: string; value: string; hint: string; onFocus: () => void; onChange: (v: string | null) => void;
}) {
  const h = f.h * ph;
  const font = Math.max(9, Math.min(15, h * 0.62));
  const stop = (e: { stopPropagation: () => void }) => { e.stopPropagation(); onFocus(); };
  const base: React.CSSProperties = { width: '100%', height: '100%', border: 0, background: 'transparent', font: 'inherit', fontSize: `${font}px`, fontWeight: 500, color: INK, padding: '0 2px', outline: 'none', minWidth: 0 };
  if (f.type === 'checkbox' || f.type === 'radio') {
    const on = value === 'true';
    const dot = h * 0.5;
    return (
      <button type="button" role={f.type} aria-checked={on} aria-label={f.label || hint} onPointerDown={stop} onClick={() => onChange(on ? null : 'true')}
        style={{ ...base, padding: 0, display: 'grid', placeItems: 'center', cursor: 'pointer', color }}>
        {on && f.type === 'radio' ? <span aria-hidden style={{ width: `${dot}px`, height: `${dot}px`, borderRadius: '50%', background: 'currentColor' }} /> : null}
        {on && f.type === 'checkbox' ? <SquareCheck size={Math.max(9, h * 0.9)} strokeWidth={2.5} aria-hidden /> : null}
      </button>
    );
  }
  if (f.type === 'formula') return <span title={`${hint}: ${f.formula ?? ''}`} style={{ ...base, display: 'flex', alignItems: 'center', fontVariantNumeric: 'tabular-nums' }}>{value}</span>;
  if (f.type === 'dropdown') {
    return (
      <select value={value} onPointerDown={stop} onFocus={onFocus} onChange={(e) => onChange(e.target.value || null)} aria-label={f.label || hint} style={{ ...base, padding: 0 }}>
        <option value="">{f.label || 'Choose'}</option>
        {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (f.type === 'attachment') return <span style={{ ...base, display: 'flex', alignItems: 'center', color, fontWeight: 650, fontSize: `${Math.min(12, font)}px` }}>{hint}: the signer uploads it</span>;
  return (
    <input value={value} onPointerDown={stop} onFocus={onFocus} onChange={(e) => onChange(e.target.value)} aria-label={f.label || hint} placeholder={hint}
      type={f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text'}
      inputMode={f.type === 'number' || f.type === 'currency' ? 'decimal' : undefined} style={base} />
  );
}

export default function PdfFieldEditor({ title, sourceUrl, roles, initial, onSave, onClose, readOnly, note, autoMap, prepare }: Props) {
  const { doc, sizes, error: pdfError, loading } = usePdf(sourceUrl);
  const [items, setItems] = useState<Item[]>(() => initial.map((f, i) => ({ ...f, key: f.id != null ? `f${f.id}` : `i${i}` })));
  const [selected, setSelected] = useState<string | null>(null);
  const [activeRole, setActiveRole] = useState<string>(roles[0]?.role ?? '');
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [paneRef, paneWidth] = useWidth<HTMLDivElement>();
  const drag = useRef<Drag | null>(null);
  const seq = useRef(0);
  const [mapping, setMapping] = useState(false);
  const [mapped, setMapped] = useState<{ n: number; bound: number; signers: number } | null>(null);
  const autoRan = useRef(false);

  /** Read the PDF's text and drawings and place every field it can find. */
  async function runAutoMap(replace: boolean) {
    if (!doc || !autoMap || readOnly || !roles.length) return;
    if (!replace && items.length) return;
    setMapping(true); setErr(null);
    try {
      const layout = await readLayout(doc);
      const { found, side } = detectFields(layout.items, layout.pages, layout.shapes, autoMap);
      const fields = assignRoles(found, roles, side);
      setItems(fields.map((f, i) => ({ ...f, key: `a${i}-${seq.current++}` })));
      setSelected(null); setDirty(true); setPage(1);
      setMapped({ n: fields.length, bound: fields.filter((f) => f.variable_key).length, signers: fields.filter((f) => FIELD_META[f.type].signs).length });
      if (!fields.length) setErr(layout.items.length < 5 ? 'This looks like a scan, so there is no text to read fields from. Drag them on from the left.' : 'No blanks found to map. Drag fields on from the left.');
    } catch (e) {
      setErr(`Could not read the document to map it: ${(e as Error).message}`);
    } finally { setMapping(false); }
  }
  // A document with no fields yet is mapped as soon as it opens.
  useEffect(() => {
    if (!doc || autoRan.current || initial.length || readOnly || !autoMap) return;
    autoRan.current = true;
    void runAutoMap(false);
    // runAutoMap reads current state; this runs once, when the PDF is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const colorOf = useMemo(() => {
    const m = new Map(roles.map((r, i) => [r.role, recipientColor(i)]));
    return (role: string) => m.get(role) ?? '#a1a1aa';
  }, [roles]);
  const roleOf = (role: string) => roles.find((r) => r.role === role);
  const pages = sizes.length;
  // Every page at the same width, one under another (PandaDoc and DocuSign do it this way): fields are dragged on the page they sit on.
  const pw = Math.max(200, Math.round(Math.min(paneWidth - 48, 980) * zoom));
  const phOf = (n: number) => { const sz = sizes[n - 1] ?? { width: 612, height: 792 }; return Math.round(pw * sz.height / sz.width); };
  const cur = items.find((f) => f.key === selected) ?? null;
  const active = roleOf(activeRole);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const scroller = useRef<HTMLDivElement | null>(null);

  const change = (key: string, patch: Partial<FieldDef>) => { setItems((xs) => xs.map((f) => (f.key === key ? { ...f, ...patch } : f))); setDirty(true); };
  const remove = (key: string) => { setItems((xs) => xs.filter((f) => f.key !== key)); setSelected(null); setDirty(true); };
  const add = (type: FieldType, at: { x: number; y: number }, onPageNo: number = page) => {
    if (readOnly || !activeRole) return;
    if (!fieldAllowedFor(type, active?.recipient_type)) { setErr(`${active?.label ?? 'This recipient'} only fills in fields; give signature boxes to a signer.`); return; }
    seq.current += 1;
    const key = `n${seq.current}`;
    // A radio joins the selected radio's question, so placing Yes / No / Unknown in a row is three clicks.
    const extra: Partial<FieldDef> = type === 'radio' ? { group_key: cur?.type === 'radio' && cur.group_key ? cur.group_key : `question_${seq.current}` } : {};
    setItems((xs) => [...xs, { ...newField(type, activeRole, onPageNo, at, sizes[onPageNo - 1] ?? { width: 612, height: 792 }), ...extra, key }]);
    setSelected(key); setDirty(true); setErr(null);
  };
  const goToPage = (n: number) => {
    setPage(n);
    pageEls.current.get(n)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // The page in view is the one a clicked palette field drops onto.
  const onScroll = () => {
    const sc = scroller.current;
    if (!sc) return;
    const mid = sc.getBoundingClientRect().top + sc.clientHeight / 3;
    for (const [n, el] of pageEls.current) {
      const r = el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) { if (n !== page) setPage(n); break; }
    }
  };

  // --- dragging fields around the page (pointer events, so it works on touch too)
  const startDrag = (e: React.PointerEvent, f: Item, mode: Drag['mode']) => {
    e.stopPropagation();
    setSelected(f.key);
    if (readOnly) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { key: f.key, mode, px: e.clientX, py: e.clientY, start: { x: f.x, y: f.y, w: f.w, h: f.h }, pw, ph: phOf(f.page) };
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.px) / d.pw, dy = (e.clientY - d.py) / d.ph;
    const r = d.mode === 'move' ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy } : { ...d.start, w: d.start.w + dx, h: d.start.h + dy };
    change(d.key, clampRect(r));
  };
  const endDrag = () => { drag.current = null; };

  const onDrop = (n: number) => (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/x-clozr-field') as FieldType;
    if (!FIELD_TYPES.includes(type)) return;
    const r = e.currentTarget.getBoundingClientRect();
    add(type, { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }, n);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { if (cur) setSelected(null); else close(); return; }
    if (!cur || readOnly) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(cur.key); return; }
    const sz = sizes[cur.page - 1] ?? { width: 612, height: 792 };
    const step = e.shiftKey ? 10 : 1;
    const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const n = nudge[e.key];
    if (n) { e.preventDefault(); change(cur.key, clampRect({ ...cur, x: cur.x + n[0] / sz.width, y: cur.y + n[1] / sz.height })); }
  };

  /** Every field, checked; in prepare mode with what it holds, so typed values save. */
  function collect(): FieldDef[] | null {
    setErr(null);
    const out: FieldDef[] = [];
    for (const f of items) {
      const n = normalizeField(f, pages || null);
      if (!n.ok) { setErr(`Page ${f.page}: ${n.error}`); setSelected(f.key); goToPage(f.page); return null; }
      out.push(prepare ? { ...n.field, value: f.value ?? null } : n.field);
    }
    return out;
  }
  async function save() {
    const out = collect();
    if (!out) return;
    setBusy(true);
    const r = await onSave(out);
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setDirty(false);
  }
  async function send() {
    const out = collect();
    if (!out || !prepare) return;
    setBusy(true);
    const r = await prepare.onSend(out);
    setBusy(false);
    if (!r.ok) { setErr(r.message); return; }
    setDirty(false);
  }
  /** A value typed or ticked on the page; a radio clears the rest of its question. */
  const setValue = (f: Item, v: string | null) => {
    setItems((xs) => xs.map((x) => {
      if (x.key === f.key) return { ...x, value: v };
      if (f.type === 'radio' && v === 'true' && x.type === 'radio' && x.group_key && x.group_key === f.group_key && x.role === f.role) return { ...x, value: null };
      return x;
    }));
    setDirty(true);
  };
  const sums = useMemo(() => computeFormulas(items.map((f) => ({ ...f, id: f.key })) as LogicField[]), [items]);
  function close() { if (dirty && !readOnly && !window.confirm('Close without saving the fields you moved?')) return; onClose(); }

  const counts = new Map<string, number>();
  for (const f of items) counts.set(f.role, (counts.get(f.role) ?? 0) + 1);
  const bound = cur?.variable_key ? VAR_HELP.find(([k]) => k === cur.variable_key)?.[1] ?? cur.variable_key : null;
  // What a condition or formula can point at: named fields, and radio groups (their answer is the chosen radio's label).
  const refs = Array.from(new Set(items.flatMap((f) => (f.key === cur?.key ? [] : [f.field_key, f.type === 'radio' ? f.group_key : null]).filter((k): k is string => !!k))));
  const cond = cur?.conditions?.all?.[0] ?? null;
  const setCond = (patch: Partial<{ field: string; op: ConditionOp; value: string }> | null, action = cur?.conditions?.action ?? 'show') => {
    if (!cur) return;
    if (!patch) { change(cur.key, { conditions: null }); return; }
    const next = { field: cond?.field ?? refs[0] ?? '', op: cond?.op ?? 'checked', value: cond?.value ?? '', ...patch };
    change(cur.key, { conditions: { action, all: [{ field: next.field, op: next.op, ...(needsValue(next.op) ? { value: next.value } : {}) }] } });
  };
  const unsigned = roles.filter((r) => r.recipient_type !== 'filler' && !items.some((f) => f.role === r.role && f.type === 'signature'));

  return (
    <div role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKey} tabIndex={-1} className="cz-fe" style={{ position: 'fixed', inset: 0, zIndex: 150, display: 'flex', flexDirection: 'column', background: '#eef0f3', color: INK, outline: 0, fontFamily: 'inherit' }}>
      <style>{FE_CSS}</style>
      {/* top bar */}
      <div className="cz-fe-top">
        <button type="button" onClick={close} className="cz-fe-icon" aria-label="Close">←</button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '14.5px', fontWeight: 650, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title.replace(/^Fields · /, '')}</div>
          <div style={{ fontSize: '11.5px', color: MUTED }}>{pages ? `${pages} page${pages === 1 ? '' : 's'} · ` : ''}{items.length} field{items.length === 1 ? '' : 's'}{prepare ? ' · click any box on the page to change what it says' : dirty ? ' · unsaved changes' : readOnly ? ' · read only' : ' · saved'}</div>
        </div>
        <div className="cz-fe-hide-sm" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <button type="button" style={btn()} onClick={() => setZoom((z) => Math.max(0.5, z / 1.2))} aria-label="Zoom out">−</button>
          <button type="button" style={{ ...btn(), minWidth: '54px' }} onClick={() => setZoom(1)} title="Fit to width">{Math.round(zoom * 100)}%</button>
          <button type="button" style={btn()} onClick={() => setZoom((z) => Math.min(2.5, z * 1.2))} aria-label="Zoom in">+</button>
        </div>
        {!readOnly && autoMap ? (
          <button type="button" style={btn(false, mapping || !doc)} disabled={mapping || !doc} title="Read the document and place its signature, date and data fields"
            onClick={() => { if (!items.length || window.confirm(`Replace the ${items.length} field${items.length === 1 ? '' : 's'} here with auto-mapped ones?`)) void runAutoMap(true); }}>
            {mapping ? 'Mapping…' : 'Auto-map'}
          </button>
        ) : null}
        {prepare && !readOnly ? (
          <>
            <button type="button" style={btn(false, busy || !dirty)} disabled={busy || !dirty} onClick={() => void save()}>Save draft</button>
            <button type="button" style={{ ...btn(true, busy), height: '34px', padding: '0 18px' }} disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send'}</button>
          </>
        ) : !readOnly ? <button type="button" style={{ ...btn(true, busy || !dirty), height: '34px', padding: '0 16px' }} disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save fields'}</button>
          : <button type="button" style={btn()} onClick={close}>Done</button>}
      </div>
      {note || err || (mapped && mapped.n) ? (
        <div style={{ padding: '8px 16px 0', display: 'grid', gap: '6px' }}>
          {note ? <div className="cz-fe-note cz-fe-warn">{note}</div> : null}
          {err ? <div role="alert" className="cz-fe-note cz-fe-bad">{err}</div> : null}
          {mapped && mapped.n ? (
            <div role="status" className="cz-fe-note cz-fe-good">
              <span style={{ flex: 1 }}><b>{mapped.n} field{mapped.n === 1 ? '' : 's'} mapped automatically</b>: {mapped.signers} to sign or date, {mapped.bound} filled from the record. Check each page, adjust anything that is off, then save.</span>
              <button type="button" onClick={() => setMapped(null)} style={{ border: 0, background: 'none', color: 'inherit', cursor: 'pointer', fontSize: '15px' }} aria-label="Dismiss">×</button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="cz-fe-body">
        {/* page rail */}
        <nav className="cz-fe-rail" aria-label="Pages">
          {sizes.map((_, i) => {
            const n = i + 1;
            const k = items.filter((f) => f.page === n);
            return (
              <button key={n} type="button" onClick={() => goToPage(n)} className={`cz-fe-thumb${page === n ? ' is-on' : ''}`} aria-label={`Page ${n}`}>
                <span className="cz-fe-thumb-n">{n}</span>
                <span style={{ display: 'flex', gap: '2px', flexWrap: 'wrap', justifyContent: 'center' }}>
                  {roles.map((r) => { const c = k.filter((f) => f.role === r.role).length; return c ? <span key={r.role} title={`${r.label}: ${c}`} style={{ minWidth: '14px', height: '14px', borderRadius: '7px', padding: '0 3px', background: colorOf(r.role), color: '#fff', fontSize: '9.5px', lineHeight: '14px', fontWeight: 700 }}>{c}</span> : null; })}
                </span>
              </button>
            );
          })}
        </nav>

        {/* the pages */}
        <div ref={(el) => { scroller.current = el; paneRef(el); }} onScroll={onScroll} onPointerDown={() => setSelected(null)} className="cz-fe-canvas">
          {pdfError ? <div className="cz-fe-empty" style={{ color: '#b91c1c' }}>Could not open the PDF: {pdfError}</div>
            : !sourceUrl ? <div className="cz-fe-empty">No PDF on this document yet.</div>
            : !doc || paneWidth <= 0 ? <div className="cz-fe-empty">{loading ? 'Opening the PDF…' : 'Opening…'}</div>
            : sizes.map((_, i) => {
              const n = i + 1;
              const ph = phOf(n);
              return (
                <div key={n} ref={(el) => { if (el) pageEls.current.set(n, el); else pageEls.current.delete(n); }} style={{ position: 'relative', width: `${pw}px`, height: `${ph}px`, margin: '0 auto 22px', background: '#fff', boxShadow: '0 1px 3px rgba(15,23,42,.08), 0 10px 30px -12px rgba(15,23,42,.25)', borderRadius: '2px' }}>
                  <PdfPageCanvas doc={doc} page={n} width={pw} height={ph} />
                  <div onDragOver={(e) => { if (!readOnly) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={onDrop(n)} style={{ position: 'absolute', inset: 0 }}>
                    {items.filter((f) => f.page === n).map((f) => {
                      const c = colorOf(f.role);
                      const on = f.key === selected;
                      const text = f.label || (f.variable_key ? VAR_HELP.find(([k]) => k === f.variable_key)?.[1] ?? f.variable_key : FIELD_META[f.type].label);
                      return (
                        <div key={f.key} onPointerDown={(e) => startDrag(e, f, 'move')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
                          title={`${roleOf(f.role)?.label ?? f.role} · ${FIELD_META[f.type].label}${f.variable_key ? ' · from the record' : ''}${f.required ? ' · required' : ''}`}
                          style={{ position: 'absolute', left: `${f.x * pw}px`, top: `${f.y * ph}px`, width: `${f.w * pw}px`, height: `${f.h * ph}px`, boxSizing: 'border-box',
                            border: `${on ? 2 : 1.5}px ${f.variable_key ? 'dashed' : 'solid'} ${c}`, background: `${c}${on ? '30' : '1a'}`, borderRadius: '4px', cursor: readOnly ? 'default' : 'move', touchAction: 'none',
                            display: 'flex', alignItems: 'center', gap: '3px', overflow: 'visible', fontSize: `${Math.max(8, Math.min(12, f.h * ph * 0.55))}px`, color: c, fontWeight: 650, padding: '0 4px', whiteSpace: 'nowrap', userSelect: 'none',
                            boxShadow: on ? `0 0 0 3px ${c}33` : 'none', zIndex: on ? 3 : 2 }}>
                          {prepare && !readOnly && fillable(f.type)
                            ? <FillBox f={f} ph={ph} color={c} value={f.type === 'formula' ? sums.get(f.key) ?? f.value ?? '' : f.value ?? ''} hint={text}
                                onFocus={() => setSelected(f.key)} onChange={(v) => setValue(f, v)} />
                            : f.type === 'checkbox' || f.type === 'radio' ? null
                            : <><FieldIcon type={f.type} size={Math.max(9, Math.min(12, f.h * ph * 0.55))} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{prepare && FIELD_META[f.type].signs ? signsLabel(roleOf(f.role)?.label ?? f.role, f.type) : text}{f.required && !f.variable_key ? ' *' : ''}</span></>}
                          {on && prepare && !readOnly && fillable(f.type) ? (
                            <span onPointerDown={(e) => startDrag(e, f, 'move')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} aria-label="Move" title="Drag to move"
                              style={{ position: 'absolute', left: '-6px', top: '-6px', width: '11px', height: '11px', background: c, border: '2px solid #fff', borderRadius: '3px', cursor: 'move', touchAction: 'none' }} />
                          ) : null}
                          {on && !readOnly ? (
                            <span onPointerDown={(e) => startDrag(e, f, 'resize')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} aria-label="Resize"
                              style={{ position: 'absolute', right: '-6px', bottom: '-6px', width: '11px', height: '11px', background: '#fff', border: `2px solid ${c}`, borderRadius: '3px', cursor: 'nwse-resize', touchAction: 'none' }} />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  <span style={{ position: 'absolute', right: 0, bottom: '-18px', fontSize: '11px', color: '#a1a1aa' }}>{n} / {pages}</span>
                </div>
              );
            })}
        </div>

        {/* right panel: recipients, fields, the selected field */}
        <aside className="cz-fe-side" data-open={cur ? '1' : '0'}>
          <span style={{ ...label, marginTop: 0 }}>Recipients</span>
          <div style={{ display: 'grid', gap: '6px' }}>
            {roles.map((r) => {
              const c = colorOf(r.role);
              const on = activeRole === r.role;
              return (
                <button key={r.role} type="button" onClick={() => setActiveRole(r.role)} disabled={readOnly}
                  style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '8px 10px', borderRadius: '10px', cursor: readOnly ? 'default' : 'pointer', textAlign: 'left', fontSize: '12.5px', fontFamily: 'inherit', color: INK,
                    border: `1.5px solid ${on ? c : LINE}`, background: on ? `${c}12` : '#fff', boxShadow: on ? `0 0 0 3px ${c}1f` : 'none' }}>
                  <span style={{ width: '24px', height: '24px', borderRadius: '50%', background: c, color: '#fff', display: 'grid', placeItems: 'center', fontSize: '11px', fontWeight: 700, flexShrink: 0 }}>{(r.label || r.role).trim().charAt(0).toUpperCase()}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
                    <span style={{ display: 'block', fontSize: '11px', color: MUTED }}>{r.recipient_type === 'filler' ? 'Fills in fields' : 'Signs'} · {counts.get(r.role) ?? 0} field{(counts.get(r.role) ?? 0) === 1 ? '' : 's'}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {unsigned.length && !readOnly ? <div className="cz-fe-note cz-fe-warn" style={{ marginTop: '8px' }}>{unsigned.map((r) => r.label).join(', ')} {unsigned.length === 1 ? 'has' : 'have'} no signature field yet.</div> : null}

          {!readOnly ? (
            <>
              <span style={label}>Fields for <span style={{ color: colorOf(activeRole) }}>{active?.label ?? 'nobody yet'}</span></span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                {FIELD_TYPES.map((t) => {
                  const allowed = fieldAllowedFor(t, active?.recipient_type);
                  return (
                    <div key={t} role="button" tabIndex={0} draggable={allowed}
                      onDragStart={(e) => { e.dataTransfer.setData('application/x-clozr-field', t); e.dataTransfer.effectAllowed = 'copy'; }}
                      onClick={() => add(t, { x: 0.5, y: 0.35 })}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(t, { x: 0.5, y: 0.35 }); } }}
                      title={allowed ? 'Drag onto the page, or click to drop it on the page in view' : 'A form filler does not sign'}
                      className="cz-fe-tile" style={{ cursor: allowed ? 'grab' : 'not-allowed', opacity: allowed ? 1 : 0.4 }}>
                      <span style={{ color: colorOf(activeRole), display: 'inline-flex' }}><FieldIcon type={t} size={14} /></span>{FIELD_META[t].label}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

            {cur ? (
              <>
                <span style={label}>Selected · {FIELD_META[cur.type].label}</span>
                <div style={{ display: 'grid', gap: '8px', fontSize: '12.5px' }}>
                  <label>Recipient
                    <select value={cur.role} disabled={readOnly} onChange={(e) => {
                      const r = roleOf(e.target.value);
                      if (!fieldAllowedFor(cur.type, r?.recipient_type)) { setErr(`${r?.label ?? 'That recipient'} only fills in fields.`); return; }
                      change(cur.key, { role: e.target.value });
                    }} style={input}>
                      {roles.map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                      {!roleOf(cur.role) ? <option value={cur.role}>{cur.role} (not on this document)</option> : null}
                    </select>
                  </label>
                  <label>Label (what the signer sees)
                    <input value={cur.label ?? ''} disabled={readOnly} onChange={(e) => change(cur.key, { label: e.target.value })} placeholder={FIELD_META[cur.type].label} style={input} />
                  </label>
                  {!FIELD_META[cur.type].signs && !['radio', 'attachment', 'formula'].includes(cur.type) ? (
                    <label>Fill from the record
                      <select value={cur.variable_key ?? ''} disabled={readOnly} onChange={(e) => change(cur.key, { variable_key: e.target.value || null, read_only: !!e.target.value })} style={input}>
                        <option value="">Nothing. The recipient types it</option>
                        {VAR_HELP.map(([k, d]) => <option key={k} value={k}>{d} ({k})</option>)}
                      </select>
                    </label>
                  ) : null}
                  {bound ? <div style={{ fontSize: '11.5px', color: MUTED }}>Filled from {bound} when the contract is created, and locked. If the record has no value, the recipient types it.</div> : null}
                  {cur.type !== 'date_signed' && cur.type !== 'formula' ? (
                    <label style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                      <input type="checkbox" checked={!!cur.required} disabled={readOnly || !!cur.variable_key} onChange={(e) => change(cur.key, { required: e.target.checked })} /> Required
                    </label>
                  ) : <div style={{ fontSize: '11.5px', color: MUTED }}>Stamped with the date they sign.</div>}
                  {cur.type === 'dropdown' ? (
                    <label>Options, one per line
                      <textarea value={(cur.options ?? []).join('\n')} disabled={readOnly} rows={4} onChange={(e) => change(cur.key, { options: e.target.value.split('\n') })} style={{ ...input, height: 'auto', padding: '6px 8px', resize: 'vertical' }} />
                    </label>
                  ) : null}
                  {cur.type === 'number' || cur.type === 'currency' ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                      <label>Min<input value={cur.validation?.min ?? ''} disabled={readOnly} inputMode="decimal" onChange={(e) => change(cur.key, { validation: { ...cur.validation, min: e.target.value === '' ? null : Number(e.target.value) } })} style={input} /></label>
                      <label>Max<input value={cur.validation?.max ?? ''} disabled={readOnly} inputMode="decimal" onChange={(e) => change(cur.key, { validation: { ...cur.validation, max: e.target.value === '' ? null : Number(e.target.value) } })} style={input} /></label>
                    </div>
                  ) : null}
                  {cur.type === 'text' ? (
                    <label>Max length<input value={cur.validation?.maxLength ?? ''} disabled={readOnly} inputMode="numeric" onChange={(e) => change(cur.key, { validation: { ...cur.validation, maxLength: e.target.value === '' ? null : Number(e.target.value) } })} style={input} /></label>
                  ) : null}
                  {cur.type === 'radio' || cur.type === 'checkbox' ? (
                    <label>{cur.type === 'radio' ? 'Question (radios with the same one: pick one)' : 'Group (optional, for "tick at least / at most")'}
                      <input value={cur.group_key ?? ''} disabled={readOnly} list="cz-fe-groups" onChange={(e) => change(cur.key, { group_key: e.target.value || null })} placeholder="payment_method" style={input} />
                      <datalist id="cz-fe-groups">{Array.from(new Set(items.filter((f) => f.type === cur.type && f.group_key).map((f) => f.group_key as string))).map((g) => <option key={g} value={g} />)}</datalist>
                    </label>
                  ) : null}
                  {cur.type === 'radio' ? <div style={{ fontSize: '11.5px', color: MUTED }}>The label is the answer this radio gives (Wise, PayPal…); conditions and formulas read it under the question name.</div> : null}
                  {cur.type === 'checkbox' && cur.group_key ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                      <label>Tick at least<input value={cur.validation?.minChecked ?? ''} disabled={readOnly} inputMode="numeric" onChange={(e) => change(cur.key, { validation: { ...cur.validation, minChecked: e.target.value === '' ? null : Number(e.target.value) } })} style={input} /></label>
                      <label>At most<input value={cur.validation?.maxChecked ?? ''} disabled={readOnly} inputMode="numeric" onChange={(e) => change(cur.key, { validation: { ...cur.validation, maxChecked: e.target.value === '' ? null : Number(e.target.value) } })} style={input} /></label>
                    </div>
                  ) : null}
                  {!FIELD_META[cur.type].signs && cur.type !== 'radio' ? (
                    <label>Field name (for conditions and formulas)
                      <input value={cur.field_key ?? ''} disabled={readOnly} onChange={(e) => change(cur.key, { field_key: e.target.value.replace(/[^a-z0-9_.]/gi, '_') || null })} placeholder="gross_fee" style={input} />
                    </label>
                  ) : null}
                  {cur.type === 'formula' ? (
                    <label>Formula
                      <input value={cur.formula ?? ''} disabled={readOnly} onChange={(e) => change(cur.key, { formula: e.target.value || null })} placeholder="round({gross} * {pct} / 100, 2)" style={input} />
                      <span style={{ display: 'block', fontSize: '11px', color: MUTED, marginTop: '4px' }}>
                        + − × ÷ ( ), round(x, n), min, max, over {refs.length ? refs.map((r) => `{${r}}`).join(' ') : 'other fields once they have a name'}.
                      </span>
                    </label>
                  ) : null}
                  {cur.type === 'text' ? (
                    <label>Must match (regex, optional)
                      <input value={cur.validation?.pattern ?? ''} disabled={readOnly} onChange={(e) => change(cur.key, { validation: { ...cur.validation, pattern: e.target.value || null } })} placeholder="\d{5}" style={input} />
                    </label>
                  ) : null}
                  {cur.type !== 'date_signed' && refs.length ? (
                    <div style={{ display: 'grid', gap: '6px', paddingTop: '4px', borderTop: `1px solid ${LINE}` }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                        <input type="checkbox" checked={!!cond} disabled={readOnly} onChange={(e) => setCond(e.target.checked ? {} : null)} />
                        Only {cur.conditions?.action === 'require' ? 'require' : 'show'} it when…
                      </label>
                      {cond ? (
                        <>
                          <select value={cur.conditions?.action ?? 'show'} disabled={readOnly} onChange={(e) => setCond({}, e.target.value as 'show' | 'require')} style={input}>
                            <option value="show">Show it (hidden and blank otherwise)</option>
                            <option value="require">Require it (optional otherwise)</option>
                          </select>
                          <select value={cond.field} disabled={readOnly} onChange={(e) => setCond({ field: e.target.value })} style={input}>
                            {refs.map((r) => <option key={r} value={r}>{r}</option>)}
                            {!refs.includes(cond.field) ? <option value={cond.field}>{cond.field || 'pick a field'}</option> : null}
                          </select>
                          <select value={cond.op} disabled={readOnly} onChange={(e) => setCond({ op: e.target.value as ConditionOp })} style={input}>
                            {OPS.map(([op, t]) => <option key={op} value={op}>{t}</option>)}
                          </select>
                          {needsValue(cond.op) ? <input value={String(cond.value ?? '')} disabled={readOnly} onChange={(e) => setCond({ value: e.target.value })} placeholder="value" style={input} /> : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {!FIELD_META[cur.type].signs && !cur.variable_key && !['checkbox', 'radio', 'attachment', 'formula'].includes(cur.type) ? (
                    <label>Default value<input value={cur.default_value ?? ''} disabled={readOnly} onChange={(e) => change(cur.key, { default_value: e.target.value || null })} style={input} /></label>
                  ) : null}
                  {!readOnly ? <button type="button" onClick={() => remove(cur.key)} style={{ ...btn(), color: '#b91c1c', borderColor: '#fecaca', justifySelf: 'start' }}>Delete field</button> : null}
                </div>
              </>
            ) : (
              <p style={{ fontSize: '12px', color: MUTED, lineHeight: 1.5, marginTop: '14px' }}>
                {readOnly ? 'Fields can only be moved while the contract is a draft.' : 'Pick who a field is for, then drag it onto the page. Click a field to change it; arrow keys nudge it, Delete removes it.'}
              </p>
            )}
        </aside>
      </div>
    </div>
  );
}

const FE_CSS = `
.cz-fe-top{height:58px;flex:none;display:flex;align-items:center;gap:10px;padding:0 16px;background:#fff;border-bottom:1px solid ${LINE}}
.cz-fe-icon{width:34px;height:34px;border-radius:9px;border:1px solid ${LINE};background:#fff;cursor:pointer;font-size:16px;color:${INK};flex:none}
.cz-fe-note{display:flex;align-items:center;gap:10px;font-size:12.5px;border-radius:9px;padding:8px 11px;line-height:1.45}
.cz-fe-good{color:#065f46;background:#ecfdf5;border:1px solid #a7f3d0}
.cz-fe-warn{color:#92400e;background:#fffbeb;border:1px solid #fde68a}
.cz-fe-bad{color:#b91c1c;background:#fee2e2;border:1px solid #fecaca}
.cz-fe-body{flex:1;min-height:0;display:grid;grid-template-columns:88px minmax(0,1fr) 300px}
.cz-fe-rail{overflow:auto;padding:12px 10px;background:#fff;border-right:1px solid ${LINE};display:grid;align-content:start;gap:8px}
.cz-fe-thumb{display:grid;gap:5px;justify-items:center;padding:10px 4px 8px;border:1px solid ${LINE};border-radius:8px;background:#fafafa;cursor:pointer;font-family:inherit}
.cz-fe-thumb.is-on{border-color:${INK};background:#fff;box-shadow:0 0 0 2px ${INK}14}
.cz-fe-thumb-n{width:34px;height:44px;border-radius:3px;background:#fff;border:1px solid ${LINE};display:grid;place-items:center;font-size:12px;font-weight:650;color:${MUTED}}
.cz-fe-canvas{overflow:auto;padding:24px 24px 40px;min-width:0}
.cz-fe-empty{padding:40px;text-align:center;font-size:13px;color:${MUTED}}
.cz-fe-side{overflow:auto;padding:16px 14px;background:#fff;border-left:1px solid ${LINE}}
.cz-fe-tile{display:flex;align-items:center;gap:8px;height:38px;padding:0 8px;border:1px solid ${LINE};border-radius:8px;background:#fff;font-size:12.5px;font-weight:550;color:${INK};user-select:none}
.cz-fe-tile:hover{background:#fafafa}
@media (max-width: 1000px){.cz-fe-body{grid-template-columns:minmax(0,1fr) 280px}.cz-fe-rail{display:none}}
@media (max-width: 760px){
  .cz-fe-body{display:flex;flex-direction:column}
  .cz-fe-side{order:-1;max-height:34vh;border-left:0;border-bottom:1px solid ${LINE}}
  .cz-fe-canvas{padding:14px 10px 30px}
  .cz-fe-hide-sm{display:none !important}
  .cz-fe-top{padding:0 10px;gap:8px}
}
`;
