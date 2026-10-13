// Drop any document and get a template out of it — the PandaDoc way in.
//
//   PDF    read in the browser (pdf.js): who is on it and what it is, from
//          its own words; a short sheet confirms the name and the people;
//          then it is stored as a PDF template (lib/pdf-docs) and the field
//          editor opens with every field already mapped (lib/pdf-autodetect).
//   Word   (.docx, or .txt/.md) becomes a text template in the Template
//          Library: signature blocks, {{variables}} the record fills and
//          [Fill.*] blanks asked for when sending (lib/doc-text-import).
'use client';

import React, { useRef, useState } from 'react';
import { CenteredDialog } from '@/components/ContractsHub';
import { TemplateFieldsDialog } from '@/components/PdfFieldDialogs';
import { KIND_LABELS, type ContractKind, guessKind, loadLibrary, saveLibraryTemplate, type DocTemplate } from '@/lib/contracts';
import { type PdfRole, type PdfTemplate, createPdfTemplate, uploadDocSource } from '@/lib/pdf-docs';
import { type Imported, folderMaker, importPdf } from '@/lib/template-import';
import { detectFields, partyOf, sideOf, type Who } from '@/lib/pdf-autodetect';
import { autoMapText, type TextTemplate } from '@/lib/doc-text-import';
import { VAR_HELP } from '@/supabase/functions/_shared/doc-vars';
import { RecipientPicker } from '@/components/RecipientPicker';

const INK = '#18181b';
const MUTED = '#71717a';
const LINE = '#e4e4e7';
const GREEN = '#0A8560';
const field: React.CSSProperties = { width: '100%', height: '34px', padding: '0 10px', border: `1px solid ${LINE}`, borderRadius: '9px', fontSize: '13px', background: '#fff', color: INK, boxSizing: 'border-box', fontFamily: 'inherit' };
const cap: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: MUTED, fontWeight: 600, marginBottom: '5px' };
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  height: '34px', padding: '0 14px', borderRadius: '9px', fontSize: '12.5px', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit',
  border: `1px solid ${primary ? GREEN : LINE}`, background: primary ? GREEN : '#fff', color: primary ? '#fff' : INK, opacity: disabled ? 0.55 : 1,
});

const PARTIES: [string, string][] = [['seller', 'Seller on the record'], ['seller2', 'Second seller'], ['buyer', 'Buyer on the record'], ['company', 'Your company signer'], ['other', 'Someone else (typed in)']];
const WHO_LABEL: Record<Who, string> = { seller: 'Seller', seller2: 'Seller 2', buyer: 'Buyer', assignor: 'Assignor', assignee: 'Assignee', company: 'Company' };
const ORDER: Who[] = ['seller', 'seller2', 'buyer', 'assignor', 'assignee', 'company'];
type Role = { role: string; label: string; party: string; filler: boolean };

type Stage =
  | { t: 'idle' }
  | { t: 'reading'; name: string }
  | { t: 'pdf'; file: File; name: string; kind: ContractKind; roles: Role[]; blanks: number }
  | { t: 'word'; tpl: TextTemplate; name: string; kind: ContractKind };

const baseName = (f: string) => f.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+\d{1,2}$/, '').replace(/\s+/g, ' ').trim();

export function DocImport({ workspaceId, onToast, onSaved, compact }: {
  workspaceId: number;
  onToast: (m: string) => void;
  /** After a template is saved (a PDF one once its fields are saved too). */
  onSaved?: (t: DocTemplate) => void;
  /** A one-line button instead of the full drop zone. */
  compact?: boolean;
}) {
  const [stage, setStage] = useState<Stage>({ t: 'idle' });
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [placing, setPlacing] = useState<PdfTemplate | null>(null);
  const [batch, setBatch] = useState<{ rows: Imported[]; done: boolean; skipped: number } | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  async function take(file: File) {
    setErr(null);
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const name = baseName(file.name);
    const kind = guessKind(name);
    if (file.size > 25 * 1024 * 1024) return onToast('That file is over 25 MB.');
    setStage({ t: 'reading', name });
    try {
      if (ext === 'pdf' || file.type === 'application/pdf') {
        // Read it here first: who is on it decides the recipients the sheet suggests.
        // From its bytes, not a blob: URL, which the CSP does not let pdf.js fetch (lib/pdfjs).
        const [{ openPdf }, { readLayout }] = await Promise.all([import('@/lib/pdfjs'), import('@/lib/pdf-shapes')]);
        const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
        const layout = await readLayout(doc);
        void doc.destroy();
        const { found, side } = detectFields(layout.items, layout.pages, layout.shapes, { name, kind });
        const blanks = found.length;
        const who = [...new Set(found.filter((f) => f.type === 'signature' || f.type === 'initials' || f.type === 'date_signed').map((f) => f.who).filter((w): w is Who => !!w))];
        who.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
        let roles: Role[] = who.map((w) => ({ role: w, label: WHO_LABEL[w], party: partyOf(w, side), filler: false }));
        if (!roles.length) {
          const side = sideOf(name, kind);
          roles = (['seller', 'buyer'] as Who[]).map((w) => ({ role: w, label: WHO_LABEL[w], party: partyOf(w, side), filler: false }));
        }
        setStage({ t: 'pdf', file, name, kind, roles, blanks });
        return;
      }
      if (ext === 'docx' || ext === 'txt' || ext === 'md') {
        let text: string;
        if (ext === 'docx') {
          const mammoth = (await import('mammoth')).default;
          text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
        } else text = await file.text();
        if (!text.trim()) throw new Error('There is no text in that file.');
        setStage({ t: 'word', tpl: autoMapText(text, { name, kind }), name, kind });
        return;
      }
      if (['doc', 'pages', 'rtf', 'odt'].includes(ext)) throw new Error(`Save it as a PDF or .docx first; a .${ext} file cannot be read in the browser.`);
      throw new Error('Drop a PDF or a Word (.docx) file.');
    } catch (e) {
      setStage({ t: 'idle' });
      const m = (e as Error).message || '';
      onToast(/password/i.test(m) ? 'That PDF is password-protected. Save an unlocked copy and drop that.' : /invalid pdf|unexpected/i.test(m) ? 'That file could not be read as a PDF.' : m || 'Could not read that file.');
    }
  }

  /** Several files at once: each PDF becomes a template with its fields saved, no screen per file (lib/template-import). */
  async function takeMany(files: File[]) {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    const skipped = files.length - pdfs.length;
    if (!pdfs.length) return onToast('Drop PDFs to import several at once; a Word file goes in on its own.');
    const rows: Imported[] = pdfs.map((f) => ({ file: f.name, ok: false, message: 'Waiting…' }));
    setBatch({ rows: [...rows], done: false, skipped });
    const lib = await loadLibrary(workspaceId);
    const builtIns = lib.ok ? lib.data.templates.filter((t) => t.built_in && !t.archived_at) : [];
    const folderFor = folderMaker(workspaceId, lib.ok ? lib.data.folders : []);
    // One at a time: pdf.js and the uploads would only fight over the connection.
    for (const [i, f] of pdfs.entries()) {
      rows[i] = { ...rows[i], message: 'Reading and mapping…' };
      setBatch({ rows: [...rows], done: false, skipped });
      rows[i] = await importPdf(workspaceId, f, { folderFor, builtIns });
      setBatch({ rows: [...rows], done: false, skipped });
    }
    setBatch({ rows: [...rows], done: true, skipped });
    const ok = rows.filter((r) => r.ok).length;
    if (ok) onSaved?.(rows.find((r) => r.ok)!.template!);
  }
  const pick = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length > 1) void takeMany(files);
    else if (files[0]) void take(files[0]);
  };

  async function createPdf(s: Extract<Stage, { t: 'pdf' }>) {
    const clean = s.roles.filter((r) => r.label.trim());
    if (!clean.length) return setErr('Add at least one recipient.');
    if (!clean.some((r) => !r.filler)) return setErr('Someone has to sign it.');
    setBusy(true); setErr(null);
    const up = await uploadDocSource(workspaceId, s.file, 'templates');
    if (!up.ok) { setBusy(false); return setErr(up.message); }
    const used = new Set<string>();
    const roles: PdfRole[] = clean.map((r, i) => {
      let role = r.role || r.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `role${i + 1}`;
      while (used.has(role)) role = `${role}_${i + 1}`;
      used.add(role);
      return { role, label: r.label.trim(), party: r.party, optional: r.party === 'seller2' || r.party === 'other', recipient_type: r.filler ? 'filler' : 'signer' };
    });
    const lib = await loadLibrary(workspaceId);
    const folderId = await folderMaker(workspaceId, lib.ok ? lib.data.folders : [])(s.kind);
    const t = await createPdfTemplate(workspaceId, { name: s.name.trim() || baseName(s.file.name), kind: s.kind, pdfPath: up.data, roles, folderId }, null);
    setBusy(false);
    if (!t.ok) return setErr(t.message);
    setStage({ t: 'idle' });
    setPlacing(t.data);
  }

  async function createWord(s: Extract<Stage, { t: 'word' }>, body: string, signers: TextTemplate['signers']) {
    setBusy(true); setErr(null);
    const r = await saveLibraryTemplate(workspaceId, { template_id: null, name: s.name.trim() || 'Imported template', kind: s.kind, body_md: body, signers: signers as unknown as DocTemplate['signers'] });
    setBusy(false);
    if (!r.ok) return setErr(/row-level|not allowed|role/i.test(r.message) ? 'Only an owner or admin can add templates.' : r.message);
    onToast(`${r.data.template.name} is in your templates`);
    setStage({ t: 'idle' });
    onSaved?.(r.data.template);
  }

  const dropProps = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); },
  };
  const reading = stage.t === 'reading' || (!!batch && !batch.done);

  return (
    <>
      <input ref={input} type="file" hidden multiple accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={(e) => { const files = e.target.files ? Array.from(e.target.files) : []; e.target.value = ''; if (files.length > 1) void takeMany(files); else if (files[0]) void take(files[0]); }} />
      {compact ? (
        <button type="button" {...dropProps} onClick={() => input.current?.click()} disabled={reading}
          style={{ ...btn(), height: '32px', border: `1px ${over ? 'solid' : 'dashed'} ${over ? GREEN : '#c4c4c8'}`, background: over ? '#ecfdf5' : '#fff' }}>
          {reading ? 'Reading…' : '⇪ Upload documents'}
        </button>
      ) : (
        <div {...dropProps} role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
          style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '16px', borderRadius: '12px', cursor: 'pointer', marginBottom: '14px',
            border: `1.5px dashed ${over ? GREEN : '#c4c4c8'}`, background: over ? '#ecfdf5' : '#fff', transition: 'background .15s, border-color .15s' }}>
          <span aria-hidden style={{ width: '42px', height: '42px', borderRadius: '10px', background: '#f4f4f5', display: 'grid', placeItems: 'center', fontSize: '18px', flex: 'none' }}>⇪</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: '13.5px', fontWeight: 650, color: INK }}>{batch && !batch.done ? `Importing ${batch.rows.filter((r) => r.message !== 'Waiting…').length} of ${batch.rows.length}…` : stage.t === 'reading' ? `Reading ${stage.name}…` : 'Drop your documents to make them templates'}</span>
            <span style={{ display: 'block', fontSize: '12px', color: MUTED, marginTop: '2px', lineHeight: 1.45 }}>PDF or Word, one or a whole stack. Your own pages, logo and design stay exactly as they are; signatures, initials and dates are placed for each signer and addresses, prices and dates fill from the record.</span>
          </span>
          <span style={{ ...btn(true), display: 'inline-flex', alignItems: 'center', flex: 'none' }}>Choose files</span>
        </div>
      )}

      {stage.t === 'pdf' ? (
        <CenteredDialog title="New template from a PDF" onClose={() => { setStage({ t: 'idle' }); setErr(null); }} width={680} z={140}>
          <PdfSheet s={stage} workspaceId={workspaceId} busy={busy} err={err} onChange={setStage} onCreate={() => void createPdf(stage)} onCancel={() => { setStage({ t: 'idle' }); setErr(null); }} />
        </CenteredDialog>
      ) : null}
      {stage.t === 'word' ? (
        <CenteredDialog title="New template from a Word document" onClose={() => { setStage({ t: 'idle' }); setErr(null); }} width={920} z={140}>
          <WordSheet s={stage} busy={busy} err={err} onChange={setStage} onSave={(b, sg) => void createWord(stage, b, sg)} onCancel={() => { setStage({ t: 'idle' }); setErr(null); }} />
        </CenteredDialog>
      ) : null}
      {batch ? (
        <CenteredDialog title={!batch.done ? 'Importing your documents…' : batch.rows.some((r) => r.ok) ? 'Templates imported' : 'Nothing was imported'} onClose={() => { if (batch.done) setBatch(null); }} width={640} z={140}>
          <BatchView batch={batch} onClose={() => setBatch(null)} />
        </CenteredDialog>
      ) : null}
      {placing ? (
        <TemplateFieldsDialog workspaceId={workspaceId} template={placing} onClose={() => setPlacing(null)}
          onSaved={(n) => { onToast(`${placing.name} is ready to send · ${n} field${n === 1 ? '' : 's'}`); onSaved?.(placing); }} />
      ) : null}
    </>
  );
}

function BatchView({ batch, onClose }: { batch: { rows: Imported[]; done: boolean; skipped: number }; onClose: () => void }) {
  const ok = batch.rows.filter((r) => r.ok);
  const replaced = ok.map((r) => r.replaced).filter((x): x is string => !!x);
  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', background: '#fff', overflow: 'hidden' }}>
        {batch.rows.map((r, i) => {
          const waiting = !r.ok && (r.message === 'Waiting…' || r.message === 'Reading and mapping…');
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', borderTop: i ? '1px solid #f0f0f1' : 0, fontSize: '13px' }}>
              <span aria-hidden style={{ width: '20px', height: '20px', borderRadius: '999px', display: 'grid', placeItems: 'center', fontSize: '11px', fontWeight: 700, flex: 'none',
                background: r.ok ? '#dcfce7' : waiting ? '#f4f4f5' : '#fee2e2', color: r.ok ? '#15803d' : waiting ? MUTED : '#b91c1c' }}>{r.ok ? '✓' : waiting ? '…' : '!'}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.template?.name ?? r.file}</span>
                <span style={{ display: 'block', fontSize: '12px', color: r.ok || waiting ? MUTED : '#b91c1c' }}>{r.message}{r.replaced ? ` · replaces the built-in ${r.replaced}` : ''}</span>
              </span>
            </div>
          );
        })}
      </div>
      {batch.skipped ? <div style={{ fontSize: '12px', color: '#b45309' }}>{batch.skipped} file{batch.skipped === 1 ? ' was' : 's were'} not a PDF and {batch.skipped === 1 ? 'was' : 'were'} skipped; drop a Word file on its own.</div> : null}
      {batch.done ? (
        <>
          <div style={{ fontSize: '12.5px', color: '#52525b', lineHeight: 1.5 }}>
            {ok.length} template{ok.length === 1 ? '' : 's'} added and filed by type. Open one in Templates to preview it or adjust a field.
            {replaced.length ? ` The built-in text version${replaced.length === 1 ? ' is' : 's are'} archived so New contract uses your documents.` : ''}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button type="button" onClick={onClose} style={btn(true)}>Done</button></div>
        </>
      ) : null}
    </div>
  );
}

function PdfSheet({ s, workspaceId, busy, err, onChange, onCreate, onCancel }: {
  s: Extract<Stage, { t: 'pdf' }>; workspaceId: number; busy: boolean; err: string | null;
  onChange: (s: Stage) => void; onCreate: () => void; onCancel: () => void;
}) {
  const setRole = (i: number, patch: Partial<Role>) => onChange({ ...s, roles: s.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ fontSize: '12.5px', color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '9px', padding: '9px 11px' }}>
        {s.blanks ? <><b>{s.blanks} blank{s.blanks === 1 ? '' : 's'} found</b> in {s.file.name}. Confirm who is on it; the next screen shows every field on the pages, already mapped.</>
          : <>No text blanks found in {s.file.name} (it may be a scan). You can still place fields by hand on the next screen.</>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
        <label><span style={cap}>Name</span><input value={s.name} onChange={(e) => onChange({ ...s, name: e.target.value })} style={field} /></label>
        <label><span style={cap}>Type</span>
          <select value={s.kind} onChange={(e) => onChange({ ...s, kind: e.target.value as ContractKind })} style={field}>
            {(Object.keys(KIND_LABELS) as ContractKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
        </label>
      </div>
      <div>
        <span style={cap}>Who is on it</span>
        {s.roles.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.3fr) auto auto', gap: '8px', marginBottom: '6px', alignItems: 'center' }}>
            {/* A role (Seller, Buyer) or a fixed person: typing searches People, Buyers, Vendors and the team. */}
            <RecipientPicker workspaceId={workspaceId} value={r.label} onChange={(v) => setRole(i, { label: v })} placeholder="Seller, Title company… or search"
              onPick={(c) => setRole(i, { label: c.name, party: c.kind === 'seller' ? 'seller' : c.kind === 'buyer' ? 'buyer' : c.kind === 'team' ? 'company' : 'other' })} />
            <select value={r.party} onChange={(e) => setRole(i, { party: e.target.value })} aria-label="Who this is" style={field}>
              {PARTIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', whiteSpace: 'nowrap' }} title="Types values in and presses Done; never signs">
              <input type="checkbox" checked={r.filler} onChange={(e) => setRole(i, { filler: e.target.checked })} /> Fills in only
            </label>
            <button type="button" onClick={() => onChange({ ...s, roles: s.roles.filter((_, j) => j !== i) })} style={{ ...btn(), padding: '0 10px' }} aria-label={`Remove ${r.label}`}>×</button>
          </div>
        ))}
        <button type="button" onClick={() => onChange({ ...s, roles: [...s.roles, { role: '', label: '', party: 'other', filler: false }] })} style={{ border: 0, background: 'none', color: GREEN, fontWeight: 600, fontSize: '12.5px', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>+ Add recipient</button>
      </div>
      {err ? <div role="alert" style={{ fontSize: '12.5px', color: '#b91c1c', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: '9px', padding: '8px 10px' }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={btn()}>Cancel</button>
        <button type="button" disabled={busy} onClick={onCreate} style={btn(true, busy)}>{busy ? 'Uploading…' : 'Create and map fields'}</button>
      </div>
    </div>
  );
}

const varLabel = (k: string) => VAR_HELP.find(([v]) => v === k)?.[1] ?? k;

function WordSheet({ s, busy, err, onChange, onSave, onCancel }: {
  s: Extract<Stage, { t: 'word' }>; busy: boolean; err: string | null;
  onChange: (s: Stage) => void; onSave: (body: string, signers: TextTemplate['signers']) => void; onCancel: () => void;
}) {
  const [body, setBody] = useState(s.tpl.body_md);
  const [signers, setSigners] = useState(s.tpl.signers);
  const roles = [...new Set(Array.from(body.matchAll(/\{\{\s*sign:([a-z0-9_]+)\s*\}\}/gi), (m) => m[1].toLowerCase()))];
  const missing = signers.filter((x) => !x.optional && !roles.includes(x.role));
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px' }}>
        <label><span style={cap}>Name</span><input value={s.name} onChange={(e) => onChange({ ...s, name: e.target.value })} style={field} /></label>
        <label><span style={cap}>Type</span>
          <select value={s.kind} onChange={(e) => onChange({ ...s, kind: e.target.value as ContractKind })} style={field}>
            {(Object.keys(KIND_LABELS) as ContractKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
        </label>
      </div>
      <div>
        <span style={cap}>Signers</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {signers.map((x, i) => (
            <span key={x.role} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px', border: `1px solid ${LINE}`, borderRadius: '8px', fontSize: '12.5px' }}>
              <input value={x.label} onChange={(e) => setSigners(signers.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} aria-label="Signer" style={{ border: 0, outline: 0, width: '80px', fontWeight: 600, fontFamily: 'inherit' }} />
              <select value={x.party} onChange={(e) => setSigners(signers.map((y, j) => (j === i ? { ...y, party: e.target.value } : y)))} aria-label="Who this is" style={{ border: 0, fontSize: '12px', color: MUTED, background: 'transparent' }}>
                {PARTIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </span>
          ))}
        </div>
      </div>
      {s.tpl.mapped.length ? (
        <div>
          <span style={cap}>Mapped · {s.tpl.mapped.length}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {s.tpl.mapped.map((m, i) => {
              const fill = m.to.startsWith('Fill.');
              return <span key={i} style={{ fontSize: '12px', padding: '3px 8px', borderRadius: '999px', background: fill ? '#f4f4f5' : '#ecfdf5', color: fill ? '#52525b' : '#065f46' }}>{m.label} → {fill ? 'typed when sending' : varLabel(m.to)}</span>;
            })}
          </div>
        </div>
      ) : null}
      <label>
        <span style={cap}>Template text · {'{{variables}}'} fill from the record, [Fill.*] are asked for when sending, {'{{sign:role}}'} places a signature block</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} style={{ ...field, height: '300px', padding: '10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', lineHeight: 1.5, resize: 'vertical' }} />
      </label>
      {missing.length ? <div style={{ fontSize: '12px', color: '#b45309' }}>{missing.map((x) => x.label).join(', ')} {missing.length === 1 ? 'has' : 'have'} no {'{{sign:…}}'} block in the text.</div> : null}
      {err ? <div role="alert" style={{ fontSize: '12.5px', color: '#b91c1c', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: '9px', padding: '8px 10px' }}>{err}</div> : null}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{ flex: 1, fontSize: '12px', color: MUTED }}>When the layout matters, upload the PDF instead: it keeps every page exactly as it is.</span>
        <button type="button" onClick={onCancel} style={btn()}>Cancel</button>
        <button type="button" disabled={busy || !!missing.length || !s.name.trim()} onClick={() => onSave(body, signers)} style={btn(true, busy || !!missing.length || !s.name.trim())}>{busy ? 'Saving…' : 'Save template'}</button>
      </div>
    </div>
  );
}
