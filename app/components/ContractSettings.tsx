// Settings for the contract engine: who the buying entity is (what the
// templates print and who signs), how offers are priced, and the templates
// themselves — system ones read-only, a workspace copy editable.
'use client';

import React, { useEffect, useState } from 'react';
import { type DocTemplate, listDocTemplates } from '@/lib/contracts';
import { type WorkspaceSettings, loadSettings, saveSettings } from '@/lib/integrations';
import { isPdfTemplate } from '@/lib/pdf-docs';
import { CenteredDialog } from '@/components/ContractsHub';
import { TemplateLibrary } from '@/components/TemplateLibrary';
import { parseDollars } from '@/lib/money';

const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 500, marginBottom: '5px' };
const fieldBase: React.CSSProperties = { width: '100%', height: '34px', padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', fontSize: '13px', outline: 0, background: 'var(--canvas, #fafafa)', color: 'var(--ink, #18181b)' };
const primary = (disabled: boolean): React.CSSProperties => ({ height: '34px', padding: '0 14px', borderRadius: '9px', border: '1px solid #0A8560', background: disabled ? '#7fcbb2' : '#0A8560', color: '#fff', fontSize: '12.5px', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' });
const ghost: React.CSSProperties = { height: '34px', padding: '0 12px', borderRadius: '9px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12.5px', fontWeight: 600, cursor: 'pointer', color: 'var(--ink, #18181b)' };

type Company = NonNullable<WorkspaceSettings['company']>;
type Offers = NonNullable<WorkspaceSettings['offers']>;

export function ContractSettings({ workspaceId, admin, demo, isMobile }: { workspaceId: number | null; admin: boolean; demo: boolean; isMobile: boolean }) {
  const [loaded, setLoaded] = useState<{ key: number | null; v: WorkspaceSettings } | null>(null);
  const [templates, setTemplates] = useState<DocTemplate[]>([]);
  const [draft, setDraft] = useState<WorkspaceSettings | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void loadSettings(workspaceId).then((v) => { if (live) setLoaded({ key: workspaceId, v }); });
    // Which template Generate offer fills is a choice between the templates
    // this workspace actually has, not a name typed from memory.
    void listDocTemplates(workspaceId).then((rows) => { if (live) setTemplates(rows); });
    return () => { live = false; };
  }, [workspaceId]);
  const base = loaded && loaded.key === workspaceId ? loaded.v : {};
  const v: WorkspaceSettings = draft ?? base;
  const c: Company = v.company ?? {};
  const o: Offers = v.offers ?? {};
  const wantPd = o.engine === 'pandadoc';
  const ro = !admin || demo;
  const field: React.CSSProperties = { ...fieldBase, background: ro ? 'var(--surface-2, #f4f4f5)' : 'var(--canvas, #fafafa)' };
  const setC = (k: keyof Company) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...v, company: { ...c, [k]: e.target.value } });
  const setO = <K extends keyof Offers>(k: K, val: Offers[K]) => setDraft({ ...v, offers: { ...o, [k]: val } });
  const num = (e: React.ChangeEvent<HTMLInputElement>) => { const n = Number(e.target.value.replace(/[^0-9.]/g, '')); return Number.isFinite(n) && e.target.value !== '' ? n : undefined; };
  /** A dollar field: "1.5k" is 1,500, the same reading as every other money input. */
  const dollars = (e: React.ChangeEvent<HTMLInputElement>) => parseDollars(e.target.value).value ?? num(e);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!workspaceId || !draft) return;
    setBusy(true); setNote(null);
    const r = await saveSettings(workspaceId, draft);
    setBusy(false);
    setNote({ ok: r.ok, text: r.ok ? 'Saved. New contracts and offers use these details.' : r.message ?? 'Could not save.' });
    if (r.ok) { setLoaded({ key: workspaceId, v: draft }); setDraft(null); }
  }

  const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px 12px' };
  return (
    <>
      <form onSubmit={save} style={card}>
        <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Contracts and offers</h2>
        <p style={{ margin: '0 0 12px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 }}>
          CLOZR fills the Acme Homes templates from the record, renders the PDF and gives each signer their own link. The details below are what those templates print and who signs for the company.
          {ro ? ' Only an owner or admin can change them.' : ''}
        </p>
        <div style={grid}>
          <div><label style={label}>Trade name</label><input value={c.name ?? ''} onChange={setC('name')} disabled={ro} placeholder="Acme Homes" style={field} /></div>
          <div><label style={label}>Legal entity (the buyer on contracts)</label><input value={c.legal ?? ''} onChange={setC('legal')} disabled={ro} placeholder="Your Company, LLC" style={field} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={label}>Address</label><input value={c.address ?? ''} onChange={setC('address')} disabled={ro} placeholder="Street, Suite, City, ST ZIP" style={field} /></div>
          <div><label style={label}>Who signs for the company</label><input value={c.signer ?? ''} onChange={setC('signer')} disabled={ro} placeholder="Full name" style={field} /></div>
          <div><label style={label}>Their title</label><input value={c.title ?? ''} onChange={setC('title')} disabled={ro} placeholder="COO" style={field} /></div>
          <div><label style={label}>Company email (gets the signing link)</label><input value={c.email ?? ''} onChange={setC('email')} disabled={ro} placeholder="contracts@yourcompany.com" type="email" style={field} /></div>
          <div><label style={label}>Company phone</label><input value={c.phone ?? ''} onChange={setC('phone')} disabled={ro} placeholder="(210) 555-0100" style={field} /></div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={label}>Letterhead logo (top of every document CLOZR lays out)</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ width: '170px', height: '48px', border: '1px dashed var(--line, #d4d4d8)', borderRadius: '9px', display: 'grid', placeItems: 'center', background: 'var(--surface, #fff)', overflow: 'hidden' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {c.logo ? <img src={c.logo} alt="Logo" style={{ maxWidth: '150px', maxHeight: '36px', objectFit: 'contain' }} /> : <span style={{ fontSize: '11.5px', color: 'var(--subtle, #a1a1aa)' }}>No logo</span>}
              </div>
              {!ro ? (
                <label style={{ ...ghost, display: 'inline-flex', alignItems: 'center' }}>
                  {c.logo ? 'Replace' : 'Upload logo'}
                  <input type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => {
                    const f = e.target.files?.[0]; e.target.value = '';
                    if (!f) return;
                    void logoDataUrl(f).then((logo) => setDraft({ ...v, company: { ...c, logo } }), (err: Error) => setNote({ ok: false, text: err.message }));
                  }} />
                </label>
              ) : null}
              {!ro && c.logo ? <button type="button" onClick={() => setDraft({ ...v, company: { ...c, logo: undefined } })} style={ghost}>Remove</button> : null}
              <span style={{ fontSize: '12px', color: 'var(--meta, #71717a)' }}>Your uploaded PDFs keep their own; this is for CLOZR’s built-in letters and offers.</span>
            </div>
          </div>
          <div style={{ gridColumn: '1 / -1' }}><label style={label}>Escrow holder named on the purchase agreement</label><input value={c.escrow ?? ''} onChange={setC('escrow')} disabled={ro} placeholder={c.legal || 'Acme Holdings, LLC'} style={field} /></div>
        </div>

        <h3 style={{ margin: '18px 0 4px', fontSize: '13px', fontWeight: 600 }}>Brokerage on TREC and state forms</h3>
        <p style={{ margin: '0 0 10px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 }}>
          The agent block those forms print. Each rep&apos;s own license number is on their profile; these are the brokerage and supervising broker every form shares.
        </p>
        <div style={grid}>
          <div><label style={label}>Brokerage</label><input value={c.brokerage_name ?? ''} onChange={setC('brokerage_name')} disabled={ro} placeholder="Brokerage name" style={field} /></div>
          <div><label style={label}>Brokerage license</label><input value={c.brokerage_license ?? ''} onChange={setC('brokerage_license')} disabled={ro} placeholder="License number" style={field} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={label}>Brokerage address</label><input value={c.brokerage_address ?? ''} onChange={setC('brokerage_address')} disabled={ro} placeholder="Street, City, ST ZIP" style={field} /></div>
          <div><label style={label}>Supervising broker</label><input value={c.supervisor_name ?? ''} onChange={setC('supervisor_name')} disabled={ro} placeholder="Full name" style={field} /></div>
          <div><label style={label}>Supervisor license</label><input value={c.supervisor_license ?? ''} onChange={setC('supervisor_license')} disabled={ro} placeholder="License number" style={field} /></div>
          <div><label style={label}>Supervisor phone</label><input value={c.supervisor_phone ?? ''} onChange={setC('supervisor_phone')} disabled={ro} placeholder="Phone" type="tel" style={field} /></div>
        </div>

        <h3 style={{ margin: '18px 0 4px', fontSize: '13px', fontWeight: 600 }}>Offers</h3>
        <p style={{ margin: '0 0 10px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 }}>
          Generate offer prices the number from the underwriting, fills the offer letter and mints the seller’s signing link. With auto-offer on, every COMPR run that produces a MAO generates the first offer by itself.
        </p>
        <div style={grid}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', gridColumn: '1 / -1' }}>
            <input type="checkbox" checked={!!o.auto} disabled={ro} onChange={(e) => setO('auto', e.target.checked)} /> Auto-generate an offer after COMPR underwrites a property
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', gridColumn: '1 / -1' }}>
            <input type="checkbox" checked={!!o.send} disabled={ro} onChange={(e) => setO('send', e.target.checked)} /> Send the offer letter to the seller right away (otherwise it waits as a draft with its link ready)
          </label>
          <div>
            <label style={label}>Offer document</label>
            <select value={o.engine ?? 'clozr'} disabled={ro} onChange={(e) => setO('engine', e.target.value as Offers['engine'])} style={field}>
              <option value="clozr">Acme Homes template, signed in CLOZR</option>
              <option value="pandadoc">PandaDoc (needs an API key)</option>
            </select>
          </div>
          {wantPd ? (
            <div>
              <label style={label}>PandaDoc template to fill</label>
              <input
                value={o.pandadoc_template_name ?? ''} disabled={ro}
                onChange={(e) => setO('pandadoc_template_name', e.target.value || undefined)}
                placeholder="Cash Offer Letter"
                style={field}
              />
            </div>
          ) : (
            <div>
              <label style={label}>Template Generate offer fills</label>
              <select value={o.template_key ?? 'offer_letter'} disabled={ro} onChange={(e) => setO('template_key', e.target.value)} style={field}>
                {templates.length ? templates.filter((t) => !isPdfTemplate(t)).map((t) => <option key={t.key} value={t.key}>{t.name}</option>) : <option value="offer_letter">Cash Offer Letter</option>}
              </select>
            </div>
          )}
          <div style={{ gridColumn: '1 / -1', fontSize: '12px', color: 'var(--meta, #71717a)', lineHeight: 1.5 }}>
            {wantPd
              ? 'PandaDoc needs a PANDADOC_API_KEY on the project to fill and send a template. Without one there is nothing to send, so an offer generated here falls back to the CLOZR letter and says so on the record. On the PandaDoc webhook subscription, tick Tokens and Fields so we store what was filled, plus each recipient’s signing link.'
              : 'The template above is filled from the record — seller, property, price, earnest money, close date — and rendered to a PDF. The seller signs on their own link with no account, and the signed PDF and its certificate land back on the record.'}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
            <input type="checkbox" checked={o.email !== false} disabled={ro} onChange={(e) => setO('email', e.target.checked)} /> {wantPd ? 'PandaDoc emails the document (Clozr records it from the webhook)' : 'Email the signing link from CLOZR / Gmail'}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
            <input type="checkbox" checked={!!o.sms} disabled={ro} onChange={(e) => setO('sms', e.target.checked)} /> {wantPd ? 'After send, copy the webhook signing link to text the seller' : 'Text the signing link to the seller'}
          </label>
          <div>
            <label style={label}>Price the offer from</label>
            <select value={o.basis ?? 'mao'} disabled={ro} onChange={(e) => setO('basis', e.target.value as Offers['basis'])} style={field}>
              <option value="mao">COMPR MAO (presented offer)</option>
              <option value="wholesale">COMPR wholesale MAO</option>
              <option value="pct_arv">% of ARV minus rehab</option>
            </select>
          </div>
          <div><label style={label}>% of ARV (when that basis is chosen)</label><input value={o.pct ?? ''} onChange={(e) => setO('pct', num(e))} disabled={ro} placeholder="70" style={field} /></div>
          <div><label style={label}>Round down to</label><input value={o.round_to ?? ''} onChange={(e) => setO('round_to', dollars(e))} disabled={ro} placeholder="500" style={field} /></div>
          <div><label style={label}>Offer good for (days)</label><input value={o.expires_days ?? ''} onChange={(e) => setO('expires_days', num(e))} disabled={ro} placeholder="3" style={field} /></div>
          <div><label style={label}>Earnest money on the letter</label><input value={o.emd ?? ''} onChange={(e) => setO('emd', dollars(e))} disabled={ro} placeholder="500" style={field} /></div>
          <div><label style={label}>Days to close on the letter</label><input value={o.close_days ?? ''} onChange={(e) => setO('close_days', num(e))} disabled={ro} placeholder="21" style={field} /></div>
        </div>
        {note ? <div role="status" style={{ marginTop: '10px', padding: '9px 11px', borderRadius: '9px', fontSize: '12.5px', background: note.ok ? 'var(--positive-soft, #dcfce7)' : 'var(--negative-soft, #fee2e2)', border: `1px solid ${note.ok ? 'var(--tint-green-3, #bbf7d0)' : 'var(--tint-red-2, #fecaca)'}`, color: note.ok ? 'var(--tx-green, #15803d)' : '#b91c1c' }}>{note.text}</div> : null}
        {!ro ? <button type="submit" disabled={busy || !draft} style={{ ...primary(busy || !draft), marginTop: '12px' }}>{busy ? 'Saving…' : 'Save contracts and offers'}</button> : null}
      </form>
      <TemplatesCard workspaceId={workspaceId} />
    </>
  );
}

/** The template library lives in one place (Contracts → Templates); this opens the same screen from Settings. */
function TemplatesCard({ workspaceId }: { workspaceId: number | null }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div style={card}>
      <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Templates</h2>
      <p style={{ margin: '0 0 10px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 }}>
        Your own documents (PDFs from PandaDoc or anywhere) are sent exactly as they look, with their logo and design; drop a whole stack in at once and each gets its fields placed and is filed by type. CLOZR’s built-in text templates stay as fallbacks, laid out under the letterhead above.
      </p>
      <button type="button" disabled={!workspaceId} onClick={() => setOpen(true)} style={primary(!workspaceId)}>Open templates</button>
      {note ? <div role="status" style={{ marginTop: '10px', fontSize: '12.5px', color: 'var(--tx-green, #15803d)' }}>{note}</div> : null}
      {open && workspaceId ? (
        <CenteredDialog title="Templates" onClose={() => setOpen(false)} width={1320} z={80}>
          <TemplateLibrary workspaceId={workspaceId} onToast={setNote} />
        </CenteredDialog>
      ) : null}
    </div>
  );
}

/** A logo file as a small PNG data URL: at most 480×160, so it rides in workspace settings and prints sharp in a 150×30pt slot. */
async function logoDataUrl(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) throw new Error('Use a PNG, JPEG, WebP or SVG image.');
  if (file.size > 5 * 1024 * 1024) throw new Error('That image is over 5 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('Could not read that image.')); img.src = url; });
    const w = img.naturalWidth || 480, h = img.naturalHeight || 160;
    const sc = Math.min(1, 480 / w, 160 / h);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h * sc));
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Could not read that image.');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/png');
    if (out.length > 400_000) throw new Error('That logo is too detailed to store; try a simpler or smaller file.');
    return out;
  } finally { URL.revokeObjectURL(url); }
}
