// Signing an uploaded PDF (a TREC form, a county form): the real pages, with
// this recipient's fields laid over them where the sender placed them.
//
// "Next field" walks the signer through what is left, required first. Text
// and numbers save when the signer leaves the box (one batch, one audit event,
// not one per keystroke); checkboxes, dropdowns and signatures save as they
// are set. Signature and initials boxes use the signature adopted once in the
// adopt sheet. Finish only goes through when every required field is filled.
//
// A form filler gets the same page with no signature boxes and finishes with
// Done instead of signing.
//
// Field logic (radio groups, conditional show/require, formulas, email/phone,
// collect file, stamp) runs through _shared/parity/field-logic.ts, the same
// rules esign enforces on save and finish.
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { PdfPageCanvas, usePdf, useWidth } from '@/components/PdfPages';
import { FIELD_META, type FieldType, displayValue, recipientColor } from '@/supabase/functions/_shared/pdf-fields';
import { type Conditions, type LogicField, blockers, computeFormulas, isVisible, valueMap } from '@/supabase/functions/_shared/parity/field-logic';
import { AdoptSignature, handToPng } from './AdoptSignature';

type Res<T> = { ok: true; data: T } | { ok: false; message: string };
type Api = <T>(body: Record<string, unknown>) => Promise<Res<T>>;
type Field = {
  id: number; type: FieldType; page: number; x: number; y: number; w: number; h: number;
  required: boolean; read_only: boolean; label: string | null; options: string[] | null;
  value: string | null; filled_at: string | null; mine: boolean; color: number; who: string | null;
  field_key?: string | null; group_key?: string | null; conditions?: Conditions; formula?: string | null; placeholder?: string | null;
};
/** docs-public (collect file): same credential as esign, the signing token and gate. */
type Upload = (body: Record<string, unknown>) => Promise<Res<{ attachment: { id: number; label: string } }>>;
type Me = { id: number; role: string; label: string | null; name: string | null; recipient_type?: string };
export type Finished = { completed: boolean; pdf_url: string | null; waiting?: number; redirect_url?: string | null };
type Signed = { completed: boolean; pdf_url?: string | null; waiting_on?: number; redirect_url?: string | null };

const initialsOf = (name: string) => name.trim().split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 3).toUpperCase();
const byPosition = (a: Field, b: Field) => a.page - b.page || a.y - b.y || a.x - b.x;

export function PdfSigning({ token, gate, api, upload, me, canAct, onDone, onDecline }: {
  token: string; gate: string | null; api: Api; upload: Upload; me: Me;
  /** It is this recipient's turn and they have not finished. */
  canAct: boolean;
  onDone: (d: Finished) => void; onDecline: () => void;
}) {
  const [data, setData] = useState<{ fields: Field[]; source_url: string | null } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<number, string | null>>({});
  const [unsaved, setUnsaved] = useState<Record<number, true>>({});
  const [adopted, setAdopted] = useState<{ name: string; png: string | null; initials: string | null } | null>(null);
  const [adoptFor, setAdoptFor] = useState<number | 'finish' | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ text: string; field?: number | null } | null>(null);
  const [hereRef, width] = useWidth<HTMLDivElement>();
  const saving = useRef<Promise<boolean> | null>(null);
  const filler = me.recipient_type === 'filler';

  useEffect(() => {
    let live = true;
    void api<{ fields: Field[]; source_url: string | null }>({ action: 'fields', token, gate }).then((r) => {
      if (!live) return;
      if (!r.ok) { setLoadErr(r.message); return; }
      setData(r.data);
    });
    return () => { live = false; };
  }, [api, token, gate]);

  const { doc, sizes, error: pdfErr } = usePdf(data?.source_url ?? null);
  // Current values (typed but unsaved included), formulas recomputed, hidden conditionals dropped.
  const live = useMemo(() => {
    const cur = (data?.fields ?? []).map((f) => (f.id in edits ? { ...f, value: edits[f.id] } : f));
    const sums = computeFormulas(cur as LogicField[]);
    return cur.map((f) => (f.type === 'formula' && sums.has(f.id) ? { ...f, value: sums.get(f.id) ?? null } : f));
  }, [data, edits]);
  const vals = useMemo(() => valueMap(live as LogicField[]), [live]);
  const fields = useMemo(() => live.filter((f) => isVisible(f as LogicField, vals)), [live, vals]);
  const valueOf = useCallback((f: Field) => live.find((x) => x.id === f.id)?.value ?? '', [live]);
  const mine = useMemo(() => fields.filter((f) => f.mine && !f.read_only && f.type !== 'date_signed' && f.type !== 'formula').sort(byPosition), [fields]);
  const open = useMemo(() => new Set(blockers(live.map((f) => ({ ...f, signer_id: f.mine ? me.id : -1 })) as LogicField[], me.id).map((b) => b.id)), [live, me.id]);
  const leftRequired = mine.filter((f) => open.has(f.id));

  /** Save everything typed since the last save, as one batch. */
  const flush = useCallback(async (extra?: Record<number, string | null>): Promise<boolean> => {
    if (saving.current) await saving.current;
    const ids = Object.keys({ ...unsaved, ...(extra ?? {}) }).map(Number);
    if (!ids.length || !canAct) return true;
    const all = { ...edits, ...(extra ?? {}) };
    const values = ids.map((id) => ({ id, value: all[id] ?? null }));
    const run = (async () => {
      const r = await api<{ ok: boolean; saved: { id: number; value: string | null }[] }>({ action: 'fields_save', token, gate, values });
      if (!r.ok) { setErr({ text: r.message }); return false; }
      // The server may change more than was sent (radio siblings cleared, formulas recomputed).
      const saved = new Map(r.data.saved.map((s) => [s.id, s.value]));
      setData((d) => (d ? { ...d, fields: d.fields.map((f) => (saved.has(f.id) ? { ...f, value: saved.get(f.id) ?? null } : ids.includes(f.id) ? { ...f, value: all[f.id] ?? null } : f)) } : d));
      setEdits((e) => { const n = { ...e }; for (const id of saved.keys()) if (!ids.includes(id)) delete n[id]; return n; });
      setUnsaved((u) => { const n = { ...u }; for (const id of ids) delete n[id]; return n; });
      setErr(null);
      return true;
    })();
    saving.current = run;
    try { return await run; } finally { saving.current = null; }
  }, [api, token, gate, edits, unsaved, canAct]);

  const edit = (f: Field, v: string | null) => { setEdits((e) => ({ ...e, [f.id]: v })); setUnsaved((u) => ({ ...u, [f.id]: true })); };
  const setNow = (f: Field, v: string | null) => {
    // One answer per radio group: the others clear here and on the server.
    if (f.type === 'radio' && v === 'true' && f.group_key) {
      const sibs = live.filter((x) => x.mine && x.type === 'radio' && x.group_key === f.group_key && x.id !== f.id && x.value);
      setEdits((e) => ({ ...e, ...Object.fromEntries(sibs.map((x) => [x.id, null])) }));
    }
    edit(f, v);
    void flush({ [f.id]: v });
  };

  async function attach(f: Field, file: File) {
    if (file.size > 25 * 1024 * 1024) { setErr({ text: 'Files up to 25 MB.', field: f.id }); return; }
    setBusy(true);
    const data_base64 = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => bad(r.error); r.readAsDataURL(file); });
    const r = await upload({ action: 'attachment_upload', token, gate, field_id: f.id, label: f.label || file.name, filename: file.name, content_type: file.type, data_base64 });
    setBusy(false);
    if (!r.ok) { setErr({ text: r.message, field: f.id }); return; }
    const { id, label } = r.data.attachment;
    setData((d) => (d ? { ...d, fields: d.fields.map((x) => (x.id === f.id ? { ...x, value: String(id), placeholder: label } : x)) } : d));
    setErr(null);
  }

  /** A stamp or seal: any image, saved as a PNG no wider than 600px. */
  async function stamp(f: Field, file: File) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('not an image')); i.src = url; });
      const k = Math.min(1, 600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
      setNow(f, c.toDataURL('image/png'));
    } catch {
      setErr({ text: 'That file is not an image.', field: f.id });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const goTo = (f: Field | undefined) => {
    if (!f) return;
    const el = document.getElementById(`cz-f-${f.id}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const box = el?.querySelector<HTMLElement>('input, select, button');
    window.setTimeout(() => box?.focus({ preventScroll: true }), 350);
  };
  const next = async () => {
    await flush();
    const empty = mine.filter((f) => !valueOf(f).trim());
    goTo(leftRequired[0] ?? empty[0] ?? mine[0]);
  };

  async function signBox(f: Field) {
    if (valueOf(f)) { setNow(f, null); return; }
    if (!adopted?.png) { setAdoptFor(f.id); return; }
    setNow(f, f.type === 'initials' ? adopted.initials : adopted.png);
  }

  async function adopt(v: { name: string; png: string | null }) {
    const initials = await handToPng(initialsOf(v.name), 'dancing');
    const a = { name: v.name, png: v.png, initials };
    setAdopted(a);
    setConsent(true);
    const target = adoptFor;
    setAdoptFor(null);
    if (target === 'finish') { await finish(a); return; }
    const f = fields.find((x) => x.id === target);
    if (f) setNow(f, f.type === 'initials' ? initials : v.png);
  }

  async function finish(a = adopted) {
    setErr(null);
    if (!(await flush())) return;
    if (leftRequired.length) {
      setErr({ text: `${leftRequired.length} required field${leftRequired.length === 1 ? ' is' : 's are'} still empty.`, field: leftRequired[0].id });
      goTo(leftRequired[0]);
      return;
    }
    if (filler) {
      if (!consent) { setErr({ text: 'Tick the box to agree to fill this in electronically.' }); return; }
      setBusy(true);
      const r = await api<Signed>({ action: 'fill_done', token, gate, consent: true, origin: window.location.origin });
      setBusy(false);
      if (!r.ok) { setErr({ text: r.message }); return; }
      onDone({ completed: r.data.completed, pdf_url: r.data.pdf_url ?? null, waiting: r.data.waiting_on, redirect_url: r.data.redirect_url ?? null });
      return;
    }
    // Signers adopt a signature before anything is committed, even on a form with no signature box.
    if (!a) { setAdoptFor('finish'); return; }
    setBusy(true);
    const r = await api<Signed>({ action: 'sign', token, gate, name: a.name, signature_png: a.png, consent: true, origin: window.location.origin });
    setBusy(false);
    if (!r.ok) { setErr({ text: r.message }); return; }
    onDone({ completed: r.data.completed, pdf_url: r.data.pdf_url ?? null, waiting: r.data.waiting_on, redirect_url: r.data.redirect_url ?? null });
  }

  if (loadErr) return <div className="cz-card"><p className="cz-lede" style={{ margin: 0 }}>{loadErr}</p></div>;
  const w = Math.max(280, width);

  return (
    <>
      <div className="cz-paper" style={{ padding: 0 }}>
        <div className="cz-paper-top" style={{ padding: '10px 14px' }}>
          <span style={{ flex: 1 }}>
            {!data ? 'Opening the form…' : mine.length ? `${mine.length - mine.filter((f) => !valueOf(f).trim()).length} of ${mine.length} of your fields filled` : 'Nothing for you to fill on this form.'}
          </span>
        </div>
        <div ref={hereRef} style={{ background: '#e4e4e7', padding: '10px 0', display: 'grid', gap: '10px', justifyItems: 'center' }}>
          {pdfErr ? <p className="cz-lede" style={{ padding: 20 }}>We could not open the form: {pdfErr}</p> : null}
          {doc && width > 0 ? sizes.map((s, i) => {
            const pw = w - 20;
            const ph = Math.round(pw * s.height / s.width);
            return (
              <div key={i} style={{ position: 'relative', width: `${pw}px`, height: `${ph}px`, boxShadow: '0 1px 6px rgba(0,0,0,.15)' }}>
                <PdfPageCanvas doc={doc} page={i + 1} width={pw} height={ph} />
                {fields.filter((f) => f.page === i + 1).map((f) => (
                  <FieldBox key={f.id} f={f} pw={pw} ph={ph} value={valueOf(f)} canAct={canAct} bad={err?.field === f.id}
                    required={open.has(f.id)}
                    onEdit={(v) => edit(f, v)} onSet={(v) => setNow(f, v)} onBlur={() => void flush()} onSign={() => void signBox(f)}
                    onFile={(file) => void (f.type === 'stamp' ? stamp(f, file) : attach(f, file))} />
                ))}
              </div>
            );
          }) : !pdfErr ? <p className="cz-lede" style={{ padding: 20 }}>Opening the form…</p> : null}
        </div>
      </div>

      {canAct ? (
        <div className="cz-dock">
          <div className="cz-dock-in" style={{ flexWrap: 'wrap' }}>
            <span className="cz-dock-stat">
              {err ? <span style={{ color: 'var(--cz-bad)' }}>{err.text}</span>
                : leftRequired.length ? <><b>{leftRequired.length} required field{leftRequired.length === 1 ? '' : 's'}</b> left{filler ? '' : ', then sign'}.</>
                : filler ? <>All set. Press <b>Done</b> to hand it on.</> : <>All fields filled. <b>Finish</b> to sign.</>}
              {filler ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 12 }}>
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> I agree to fill this in electronically.
                </label>
              ) : null}
            </span>
            <button type="button" onClick={onDecline} className="cz-linkbtn">Decline</button>
            {mine.length ? <button type="button" onClick={() => void next()} className="cz-btn cz-btn-ghost cz-btn-sm">Next field</button> : null}
            <button type="button" disabled={busy} onClick={() => void finish()} className="cz-btn cz-btn-primary">{busy ? (filler ? 'Sending…' : 'Signing…') : filler ? 'Done' : 'Finish'}</button>
          </div>
        </div>
      ) : null}

      {adoptFor != null ? (
        <AdoptSignature
          initialName={adopted?.name ?? me.name ?? ''}
          role={me.label || me.role}
          busy={busy}
          error={null}
          onClose={() => setAdoptFor(null)}
          onAdopt={(v) => void adopt(v)}
        />
      ) : null}
    </>
  );
}

/** One field over the page: an input when it is mine to fill, the value otherwise. */
function FieldBox({ f, pw, ph, value, canAct, bad, required, onEdit, onSet, onBlur, onSign, onFile }: {
  f: Field; pw: number; ph: number; value: string; canAct: boolean; bad: boolean;
  /** Still blocks finishing (required now, conditions and groups applied). */
  required: boolean;
  onEdit: (v: string | null) => void; onSet: (v: string | null) => void; onBlur: () => void; onSign: () => void; onFile: (file: File) => void;
}) {
  const color = recipientColor(f.color);
  const editable = f.mine && canAct && !f.read_only && f.type !== 'date_signed' && f.type !== 'formula';
  const h = f.h * ph;
  const font = Math.max(9, Math.min(16, h * 0.62));
  const empty = !value.trim();
  const box: React.CSSProperties = {
    position: 'absolute', left: `${f.x * pw}px`, top: `${f.y * ph}px`, width: `${f.w * pw}px`, height: `${h}px`, boxSizing: 'border-box',
    border: editable ? `1.5px solid ${bad ? '#b91c1c' : color}` : f.mine ? `1px dashed ${color}` : '0', borderRadius: 3,
    background: editable ? (required ? 'rgba(255,216,77,.35)' : `${color}14`) : 'transparent',
    display: 'flex', alignItems: 'center', overflow: 'hidden', fontSize: `${font}px`, color: '#0f1730',
  };
  const inputStyle: React.CSSProperties = { width: '100%', height: '100%', border: 0, background: 'transparent', font: 'inherit', color: 'inherit', padding: '0 3px', outline: 'none' };
  const title = `${f.label || FIELD_META[f.type].label}${f.required ? ' (required)' : ''}${f.mine ? '' : f.who ? ` · ${f.who}` : ''}`;

  if (f.type === 'signature' || f.type === 'initials') {
    return (
      <div id={`cz-f-${f.id}`} style={box} title={title}>
        {editable ? (
          <button type="button" onClick={onSign} aria-label={empty ? `${FIELD_META[f.type].label} here` : 'Clear'}
            style={{ ...inputStyle, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: `${Math.min(13, font)}px`, fontWeight: 650, color }}>
            {empty ? (f.type === 'initials' ? 'Initial' : 'Sign here') : <Ink src={value} alt="" />}
          </button>
        ) : value ? <Ink src={value} alt={FIELD_META[f.type].label} /> : null}
      </div>
    );
  }
  const pick = (accept: string, label: React.ReactNode, style?: React.CSSProperties) => (
    <label style={{ ...inputStyle, cursor: 'pointer', display: 'flex', alignItems: 'center', fontSize: `${Math.min(12, font)}px`, fontWeight: 650, color, whiteSpace: 'nowrap', ...style }}>
      {label}
      <input type="file" accept={accept} hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onFile(file); }} />
    </label>
  );
  if (f.type === 'stamp') {
    return (
      <div id={`cz-f-${f.id}`} style={{ ...box, justifyContent: 'center' }} title={title}>
        {editable && empty ? pick('image/*', 'Add stamp', { justifyContent: 'center' })
          : editable ? <button type="button" onClick={() => onSet(null)} aria-label="Clear stamp" style={{ ...inputStyle, cursor: 'pointer' }}><Ink src={value} alt="" /></button>
          : value ? <Ink src={value} alt="Stamp" /> : null}
      </div>
    );
  }
  if (f.type === 'attachment') {
    return (
      <div id={`cz-f-${f.id}`} style={box} title={title}>
        {editable ? pick('application/pdf,image/*,.doc,.docx', empty ? `Upload ${f.label || 'file'}` : `Attached: ${f.placeholder || 'file'} (replace)`)
          : <span style={{ padding: '0 3px', whiteSpace: 'nowrap' }}>{empty ? '' : 'File attached'}</span>}
      </div>
    );
  }
  if (f.type === 'radio') {
    return (
      <div id={`cz-f-${f.id}`} style={{ ...box, justifyContent: 'center', borderRadius: '50%' }} title={title}>
        {editable ? (
          <button type="button" role="radio" aria-checked={value === 'true'} aria-label={f.label || 'Choice'} onClick={() => onSet(value === 'true' ? null : 'true')}
            style={{ ...inputStyle, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>{value === 'true' ? <Dot size={h * 0.55} /> : null}</button>
        ) : value === 'true' ? <Dot size={h * 0.55} /> : null}
      </div>
    );
  }
  if (f.type === 'checkbox') {
    return (
      <div id={`cz-f-${f.id}`} style={{ ...box, justifyContent: 'center' }} title={title}>
        {editable ? (
          <button type="button" role="checkbox" aria-checked={value === 'true'} aria-label={f.label || 'Checkbox'} onClick={() => onSet(value === 'true' ? null : 'true')}
            style={{ ...inputStyle, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>{value === 'true' ? <Check size={Math.max(9, h * 0.85)} strokeWidth={3} aria-hidden /> : null}</button>
        ) : value === 'true' ? <Check size={Math.max(9, h * 0.85)} strokeWidth={3} aria-hidden /> : null}
      </div>
    );
  }
  if (!editable) {
    const shown = f.type === 'date_signed' && empty && f.mine ? 'Date signed' : displayValue(f, value);
    return <div id={`cz-f-${f.id}`} style={box} title={title}><span style={{ padding: '0 3px', whiteSpace: 'nowrap', color: f.type === 'date_signed' && empty ? '#9ca3af' : undefined }}>{shown}</span></div>;
  }
  if (f.type === 'dropdown') {
    return (
      <div id={`cz-f-${f.id}`} style={box} title={title}>
        <select value={value} onChange={(e) => onSet(e.target.value || null)} aria-label={f.label || 'Choose'} style={{ ...inputStyle, padding: 0 }}>
          <option value="">{f.label || 'Choose…'}</option>
          {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  return (
    <div id={`cz-f-${f.id}`} style={box} title={title}>
      <input
        value={value} onChange={(e) => onEdit(e.target.value)} onBlur={onBlur} aria-label={f.label || FIELD_META[f.type].label}
        type={f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text'}
        inputMode={f.type === 'number' || f.type === 'currency' ? 'decimal' : undefined}
        placeholder={f.placeholder || f.label || (f.type === 'currency' ? '$' : '')} style={inputStyle}
      />
    </div>
  );
}

/** The chosen radio: a filled dot, drawn rather than typed so it sits centred at any size. */
function Dot({ size }: { size: number }) {
  return <span aria-hidden style={{ width: `${size}px`, height: `${size}px`, borderRadius: '50%', background: 'currentColor', display: 'block' }} />;
}

/** A signature or initials image: a data URL, so there is nothing for an image loader to optimize. */
function Ink({ src, alt }: { src: string; alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt={alt} src={src} style={{ maxWidth: '100%', maxHeight: '100%', margin: '0 auto', display: 'block' }} />;
}
