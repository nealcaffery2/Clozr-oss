// Contracts on a record. Two engines behind one card:
//   CLOZR (default) — the Acme Homes templates, filled from the record, signed
//            on /sign. Each signer gets their own link to text or email, and
//            the signed PDF and its certificate land back on the record.
//   PandaDoc — opt-in. With an API key it drives PandaDoc directly; without
//            one it can only write a packet of fields to paste by hand, which
//            is why it is no longer what the card opens on.
'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import {
  type ContractKind, type ContractRow, type DocTemplate, type Recipient, type RenderResult, type SignerInput, type SignerLink,
  KIND_LABELS, TOKEN_HELP, clozrPdfUrl, contractFields, createClozr, listContracts, listDocTemplates, listSigners,
  remindClozr, renderClozr, savePandaPacket, sendClozr, setContractNotary, signerLinks, splitName, statusLabel, docsPlus,
  type DocFolder, type LibraryTemplate, guessKind, templateFolders,
} from '@/lib/contracts';
import { folderTree } from '@/supabase/functions/_shared/doc-library';
import { formatPacket, sharedLinks } from '@/lib/pandadoc-match';
import { createPdfClozr, isPdfContract, isPdfTemplate, uploadDocSource } from '@/lib/pdf-docs';
import { reachClick } from '@/app/components/record/reach';
import { buyerContactProblem } from '@/lib/buyer-contact';
import { FileDrop } from '@/components/FileDrop';
import { ContractTermsPanel } from '@/components/ContractTerms';
import { RecipientPicker } from '@/components/RecipientPicker';
import { RecipientsPanel } from '@/components/RecipientsPanel';
import { type CrmChoice, type Unsaved, SaveToCrmDialog } from '@/components/SaveToCrmDialog';
import { type Contact, type ContactLink, isLinked, linkOf } from '@/lib/contact-search';
import { linkLabel, saveRecipientToCrm, tieContractToCrm } from '@/lib/contract-recipients';
import { VAR_HELP } from '@/supabase/functions/_shared/doc-vars';

type Party = { name?: string | null; email?: string | null; phone?: string | null } | null | undefined;
type Props = {
  workspaceId: number | null; sellerId?: number | null; dealId?: number | null; buyerId?: number | null;
  seller?: Party; buyer?: Party; canWrite: boolean; compact?: boolean;
  onToast: (msg: string) => void; onChanged?: () => void;
  /** "New contract" asks for a template elsewhere (the record's template picker) instead of opening the form here. */
  onNewContract?: () => void;
  /** Open the new-contract form on this template (a doc_templates id), filled from the record; -1 opens it on Upload a PDF. */
  startTemplateId?: number | null;
};
type SignerLite = { contract_id: number; role: string; label: string | null; name: string | null; email: string | null; status: string; signed_at: string | null; viewed_at?: string | null; view_seconds?: number | null; last_delivery_status?: string | null };

const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const h2: React.CSSProperties = { margin: 0, fontSize: '14px', fontWeight: 700, letterSpacing: '-0.01em' };
const sub: React.CSSProperties = { margin: '2px 0 0', fontSize: '12px', color: 'var(--meta, #71717a)' };
const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 600, marginBottom: '5px' };
const field: React.CSSProperties = { width: '100%', height: '34px', padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', fontSize: '13px', outline: 0, background: 'var(--canvas, #fafafa)', color: 'var(--ink, #18181b)' };
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  height: '30px', padding: '0 11px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
  border: `1px solid ${primary ? '#0A8560' : 'var(--divider, #e4e4e7)'}`, background: primary ? (disabled ? '#7fcbb2' : '#0A8560') : '#fff', color: primary ? '#fff' : '#18181b', opacity: !primary && disabled ? 0.6 : 1,
});
const SIGN_SUBJECT = 'Please review and sign';
const link: React.CSSProperties = { fontSize: '12px', color: 'var(--tx-mint, #0a8560)', background: 'none', border: 0, cursor: 'pointer', padding: 0, fontWeight: 500 };
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null);
// [Fill.ForwardingAddress] from an imported Word template reads as "Forwarding address".
const tokenLabel = (name: string) => TOKEN_HELP.find(([n]) => n === name)?.[1] ?? VAR_HELP.find(([n]) => n === name)?.[1]
  ?? (name.startsWith('Fill.') ? (name.slice(5).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (c) => c.toUpperCase())) : name.replace('.', ' · '));

// The field editor and pdf.js load only when someone opens a PDF's fields.
const ContractFieldsDialog = React.lazy(() => import('@/components/PdfFieldDialogs').then((m) => ({ default: m.ContractFieldsDialog })));

const DOC_CSS = `
.cz-doc { font: 13px/1.55 Georgia, 'Times New Roman', serif; color: var(--ink, #18181b); background: var(--surface, #fff); padding: 28px 32px; }
.cz-doc h1 { font: 700 17px/1.25 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; text-transform: uppercase; text-align: center; margin: 18px 0 12px; }
.cz-doc h2 { font: 700 14px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 16px 0 6px; }
.cz-doc h3 { font: 700 11px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-3, #3f3f46); margin: 14px 0 5px; }
.cz-doc .small { font: 11px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--meta, #71717a); }
.cz-doc p { margin: 0 0 8px; } .cz-doc ul { margin: 0 0 8px 20px; padding: 0; }
.cz-doc hr.page { border: 0; border-top: 1px dashed var(--line, #d4d4d8); margin: 22px 0; }
.cz-doc .sig { border: 1px solid var(--divider, #e4e4e7); border-radius: 8px; padding: 10px 12px; margin: 12px 0; background: var(--canvas, #fafafa); }
.cz-doc .sig-label { font: 700 10px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; letter-spacing: .1em; text-transform: uppercase; color: var(--meta, #71717a); }
.cz-doc .sig-line { height: 40px; display: flex; align-items: flex-end; border-bottom: 1px solid var(--ink, #18181b); margin: 4px 0; }
.cz-doc .sig-line .blank { color: var(--subtle, #a1a1aa); font: 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding-bottom: 3px; }
.cz-doc .sig-meta { font: 11px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--muted, #52525b); }
`;

export function ContractsCard({ workspaceId, sellerId, dealId, buyerId, seller, buyer, canWrite, compact, onToast, onChanged, onNewContract, startTemplateId }: Props) {
  const key = `${workspaceId}:${sellerId ?? ''}:${dealId ?? ''}:${buyerId ?? ''}`;
  const [loaded, setLoaded] = useState<{ key: string; rows: ContractRow[]; signers: SignerLite[] } | null>(null);
  const rows: ContractRow[] | null = loaded && loaded.key === key ? loaded.rows : null;
  const signers: SignerLite[] = loaded && loaded.key === key ? loaded.signers : [];
  const [open, setOpen] = useState(startTemplateId != null);
  const [busy, setBusy] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<number, SignerLink[]>>({});
  const [tick, setTick] = useState(0);
  // Contracts whose AI-read terms (and Review changes) are showing.
  const [terms, setTerms] = useState<Record<number, boolean>>({});
  // Recipients panel per contract (migration 114); open by default while an approval is pending or was rejected.
  const [people, setPeople] = useState<Record<number, boolean>>({});
  const [fieldsFor, setFieldsFor] = useState<ContractRow | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!workspaceId || (!sellerId && !dealId && !buyerId)) { if (live) setLoaded({ key, rows: [], signers: [] }); return; }
      const r = await listContracts(workspaceId, { sellerId, dealId, buyerId });
      const s = await listSigners(workspaceId, r.filter((c) => c.provider === 'clozr').map((c) => c.id));
      if (live) setLoaded({ key, rows: r, signers: s });
    })();
    return () => { live = false; };
  }, [workspaceId, sellerId, dealId, buyerId, key, tick]);

  const refresh = () => { setTick((t) => t + 1); onChanged?.(); };
  const upd = (c: ContractRow) => setLoaded((l) => (l && l.key === key ? { ...l, rows: l.rows.map((x) => (x.id === c.id ? { ...x, ...c } : x)) } : l));

  async function act(kind: string, c: ContractRow) {
    if (!workspaceId) return;
    setBusy(`${kind}:${c.id}`);
    try {
      if (c.provider === 'clozr') {
        if (kind === 'links') {
          if (links[c.id]) { setLinks((l) => { const n = { ...l }; delete n[c.id]; return n; }); return; }
          const r = await signerLinks(workspaceId, c.id); if (!r.ok) return onToast(r.message);
          setLinks((l) => ({ ...l, [c.id]: r.data.signers }));
        } else if (kind === 'send') {
          const r = await sendClozr(workspaceId, c.id); if (!r.ok) return onToast(r.message);
          upd(r.data.contract); setLinks((l) => ({ ...l, [c.id]: r.data.signers }));
          onToast(r.data.awaiting_approval ? 'Sent to the approver first · it goes out for signature when approved'
            : r.data.emailed || r.data.texted ? `Sent · ${[r.data.emailed ? `${r.data.emailed} email${r.data.emailed === 1 ? '' : 's'}` : null, r.data.texted ? `${r.data.texted} text${r.data.texted === 1 ? '' : 's'}` : null].filter(Boolean).join(', ')} out` : 'Sent · copy the signing links below and text or email them'); refresh();
        } else if (kind === 'remind') {
          const r = await remindClozr(workspaceId, c.id); if (!r.ok) return onToast(r.message);
          onToast(r.data.texted ? `Reminder sent · ${r.data.emailed ? `${r.data.emailed} emailed, ` : ''}${r.data.texted} texted` : r.data.emailed ? `Reminder emailed to ${r.data.emailed}` : 'No email provider set — copy the link and text it instead');
        } else if (kind === 'pdf') {
          const r = await clozrPdfUrl(workspaceId, c.id); if (!r.ok) return onToast(r.message);
          window.open(r.data.url, '_blank', 'noopener');
        } else if (kind === 'void') {
          // Void with notice (docs-plus): every recipient is emailed that it was voided, and why.
          const reason = window.prompt(`Void "${c.name}"? The signing links stop working and everyone on it is emailed.\n\nReason (optional):`, '');
          if (reason === null) return;
          const r = await docsPlus<{ emailed: number }>(workspaceId, 'void', { contract_id: c.id, reason: reason.trim() || null }); if (!r.ok) return onToast(r.message);
          onToast(r.data.emailed ? `Voided · ${r.data.emailed} recipient${r.data.emailed === 1 ? '' : 's'} told` : 'Voided');
          refresh();
        } else if (kind === 'extend') {
          const days = window.prompt(c.status === 'expired' ? 'Revive it for how many more days?' : 'Extend the deadline by how many days?', '14');
          if (!days) return;
          const r = await docsPlus<{ expires_at: string }>(workspaceId, 'extend_expiry', { contract_id: c.id, days: Number(days) }); if (!r.ok) return onToast(r.message);
          onToast(`Signable until ${fmtDate(r.data.expires_at)}`); refresh();
        } else if (kind === 'correct') {
          if (!window.confirm(`Edit and resend "${c.name}"? Signatures already given are cleared, the old links stop working, and it goes back to a draft so you can fix it and send it again.`)) return;
          const r = await docsPlus<{ revision: number }>(workspaceId, 'correct', { contract_id: c.id }); if (!r.ok) return onToast(r.message);
          onToast(`Back to a draft (revision ${r.data.revision}). Fix it, then press Send.`);
          if (isPdfContract(c)) setFieldsFor({ ...c, status: 'draft' });
          refresh();
        } else if (kind === 'duplicate') {
          const r = await docsPlus<{ contract: ContractRow }>(workspaceId, 'duplicate', { contract_id: c.id }); if (!r.ok) return onToast(r.message);
          onToast(`Copied as a draft: ${r.data.contract.name}`); refresh();
        } else if (kind === 'delete') {
          if (!window.confirm(`Delete "${c.name}"? It leaves every list; its audit trail is kept.`)) return;
          const r = await docsPlus(workspaceId, 'delete', { contract_id: c.id }); if (!r.ok) return onToast(r.message);
          refresh();
        } else if (kind === 'notary-digital' || kind === 'notary-wet' || kind === 'notary-vendor') {
          const mode = kind === 'notary-wet' ? 'wet' : kind === 'notary-vendor' ? 'vendor' : 'digital';
          const vendor = mode === 'vendor' ? window.prompt('Vendor name', c.notary_vendor ?? '') : null;
          if (mode === 'vendor' && !vendor) return;
          const r = await setContractNotary(workspaceId, c.id, mode, vendor);
          if (!r.ok) return onToast(r.message);
          upd(r.data.contract);
          onToast(mode === 'digital' ? (r.data.emailed ? `Notary emailed (${r.data.emailed})` : (r.data.note ?? 'Notary marked')) : mode === 'wet' ? 'Marked for print and wet stamp' : `Vendor notary: ${vendor}`);
          refresh();
        }
        return;
      }
      if (kind === 'copy') {
        const toks = (Array.isArray(c.tokens) ? c.tokens : []) as { name: string; value: string }[];
        const text = formatPacket(toks);
        if (!text) return onToast('No fields on this packet yet.');
        await navigator.clipboard?.writeText(text);
        onToast('Fields copied — paste them into the Acme Homes PandaDoc template');
      }
    } finally { setBusy(null); }
  }

  return (
    <div style={{ ...card, ...(compact ? { padding: '14px 16px' } : {}) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={h2}>Contracts</h2>
          <p style={sub}>Acme Homes templates fill from this record. Preview the document, then send each signer their own link. Signed documents move the stage.</p>
        </div>
        {canWrite && workspaceId ? (
          <button type="button" onClick={() => (onNewContract && !open ? onNewContract() : setOpen((o) => !o))} style={btn(!open)}>{open ? 'Cancel' : 'New contract'}</button>
        ) : null}
      </div>

      {open && workspaceId ? (
        <NewContract
          workspaceId={workspaceId} sellerId={sellerId ?? null} dealId={dealId ?? null} buyerId={buyerId ?? null} seller={seller} buyer={buyer} onToast={onToast}
          startTemplateId={startTemplateId ?? null}
          onDone={(c, ls, placeFields) => { setOpen(false); if (ls) setLinks((l) => ({ ...l, [c.id]: ls })); setLoaded((l) => (l && l.key === key ? { ...l, rows: [c, ...l.rows.filter((x) => x.id !== c.id)] } : l)); if (placeFields) setFieldsFor(c); refresh(); }}
        />
      ) : null}

      <div style={{ marginTop: '12px' }}>
        {rows === null ? <div style={{ fontSize: '12.5px', color: 'var(--subtle, #a1a1aa)' }}>Loading…</div>
          : rows.length === 0 ? <div style={{ fontSize: '12.5px', color: 'var(--subtle, #a1a1aa)' }}>No contracts yet.</div>
          : rows.map((c) => {
            const partly = ['sent', 'viewed'].includes(c.status) && signers.some((s) => s.contract_id === c.id && (s.status === 'signed' || s.status === 'filled'));
            const st = partly ? { ...statusLabel(c.status), text: 'Partially signed' } : statusLabel(c.status);
            const draft = ['draft', 'uploaded', 'error'].includes(c.status);
            const done = ['completed', 'voided', 'declined', 'rejected'].includes(c.status);
            const mine = signers.filter((s) => s.contract_id === c.id && s.status !== 'delegated');
            const recips = (Array.isArray(c.recipients) ? c.recipients : []) as Recipient[];
            const when = c.completed_at ? `Signed ${fmtDate(c.completed_at)}` : c.viewed_at ? `Viewed ${fmtDate(c.viewed_at)}` : c.sent_at ? `Sent ${fmtDate(c.sent_at)}` : `Created ${fmtDate(c.created_at)}`;
            const err = c.status === 'error' ? (c.last_event as { error?: string } | null)?.error : null;
            const who = c.provider === 'clozr'
              ? mine.map((s) => `${s.name || s.email || s.label || s.role}${s.status === 'signed' ? ' ✓' : ''}`).join(', ')
              : recips.map((r) => r.email).join(', ');
            const ls = links[c.id];
            const showPeople = c.provider === 'clozr' && (people[c.id] ?? (c.status === 'awaiting_approval' || (c.status === 'draft' && !!(c as ContractRow & { approval_rejected_reason?: string | null }).approval_rejected_reason)));
            return (
              <div key={c.id} style={{ borderTop: '1px solid var(--divider-2, #f0f0f1)', padding: '10px 0' }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: '180px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '13px', fontWeight: 600 }}>{c.name}</span>
                      <span style={{ fontSize: '11px', fontWeight: 700, color: st.color, background: st.bg, padding: '2px 7px', borderRadius: '6px' }}>{st.text}</span>
                      {c.provider === 'pandadoc' ? <span style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)' }}>PandaDoc</span> : null}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)', marginTop: '2px' }}>{KIND_LABELS[(c.kind as ContractKind)] ?? c.kind} · {when}{who ? ` · ${who}` : ''}</div>
                    {c.provider === 'clozr' ? <div style={{ fontSize: '11.5px', color: 'var(--muted, #52525b)', marginTop: '2px' }}>Only the email on each signer can open the link.{c.needs_notary ? ` · Notary: ${c.notary_status || c.notary_mode}` : ''}</div> : null}
                    {mine.some((s) => s.viewed_at || s.signed_at) ? (
                      <div style={{ fontSize: '11.5px', color: 'var(--ink-3, #3f3f46)', marginTop: '3px' }}>
                        {mine.map((s) => {
                          const mins = s.view_seconds ? `${Math.max(1, Math.round(s.view_seconds / 60))} min open` : null;
                          const bits = [s.label || s.role, s.status === 'signed' ? `signed ${fmtDate(s.signed_at)}` : s.viewed_at ? `viewed ${fmtDate(s.viewed_at)}` : null, mins].filter(Boolean);
                          return bits.join(' · ');
                        }).join('  ·  ')}
                      </div>
                    ) : null}
                    {mine.some((s) => ['bounced', 'failed', 'complained'].includes(String(s.last_delivery_status))) ? (
                      <div style={{ fontSize: '11.5px', color: 'var(--tx-red, #b91c1c)', marginTop: '3px' }}>
                        Email did not arrive: {mine.filter((s) => ['bounced', 'failed', 'complained'].includes(String(s.last_delivery_status))).map((s) => `${s.name || s.label || s.role} (${s.email})`).join(', ')}. Fix the address under Recipients and resend.
                      </div>
                    ) : null}
                    {err ? <div style={{ fontSize: '11.5px', color: 'var(--tx-red, #b91c1c)', marginTop: '2px' }}>{err}</div> : null}
                  </div>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                    {c.pdf_path || c.status === 'completed' ? <button type="button" style={link} onClick={() => setTerms((t) => ({ ...t, [c.id]: !t[c.id] }))}>{terms[c.id] ? 'Hide terms' : c.extract_status === 'running' ? 'Reading terms…' : 'Terms'}</button> : null}
                    {c.provider === 'clozr' ? (
                      <>
                        <button type="button" style={link} disabled={!!busy} onClick={() => act('links', c)}>{ls ? 'Hide links' : 'Signing links'}</button>
                        <button type="button" style={link} onClick={() => setPeople((p) => ({ ...p, [c.id]: !showPeople }))}>{showPeople ? 'Hide recipients' : c.status === 'awaiting_approval' ? 'Approval' : 'Recipients'}</button>
                        {canWrite && draft && isPdfContract(c) ? <button type="button" style={link} disabled={!!busy} onClick={() => setFieldsFor(c)} title="The filled-in contract: change anything on the page, then send">Review &amp; send</button> : null}
                        {canWrite && draft ? <button type="button" style={link} disabled={!!busy} onClick={() => act('send', c)}>{busy === `send:${c.id}` ? 'Sending…' : 'Send'}</button> : null}
                        {canWrite && !draft && !done ? <button type="button" style={{ ...link, color: 'var(--muted, #52525b)' }} disabled={!!busy} onClick={() => act('remind', c)}>Remind</button> : null}
                        <button type="button" style={{ ...link, color: 'var(--muted, #52525b)' }} disabled={!!busy} onClick={() => act('pdf', c)}>{busy === `pdf:${c.id}` ? 'Fetching…' : 'PDF'}</button>
                        {canWrite && ['sent', 'viewed', 'expired'].includes(c.status) ? <button type="button" style={{ ...link, color: 'var(--muted, #52525b)' }} disabled={!!busy} onClick={() => act('extend', c)}>{c.status === 'expired' ? 'Revive' : 'Extend'}</button> : null}
                        {canWrite && ['sent', 'viewed', 'declined', 'expired', 'awaiting_approval'].includes(c.status) ? <button type="button" style={{ ...link, color: 'var(--muted, #52525b)' }} disabled={!!busy} onClick={() => act('correct', c)} title="Back to a draft: fix it and send it again">Edit &amp; resend</button> : null}
                        {canWrite ? <button type="button" style={{ ...link, color: 'var(--muted, #52525b)' }} disabled={!!busy} onClick={() => act('duplicate', c)}>Duplicate</button> : null}
                        {canWrite && !done ? <button type="button" style={{ ...link, color: 'var(--tx-red, #b91c1c)' }} disabled={!!busy} onClick={() => act('void', c)}>Void</button> : null}
                        {canWrite && ['draft', 'voided', 'declined', 'expired'].includes(c.status) ? <button type="button" style={{ ...link, color: 'var(--tx-red, #b91c1c)' }} disabled={!!busy} onClick={() => act('delete', c)}>Delete</button> : null}
                        {canWrite ? (
                          <>
                            <button type="button" style={link} disabled={!!busy} onClick={() => act('notary-digital', c)}>Email notary</button>
                            <button type="button" style={{ ...link, color: 'var(--muted, #52525b)' }} disabled={!!busy} onClick={() => act('notary-wet', c)}>Print & stamp</button>
                            <button type="button" style={{ ...link, color: 'var(--muted, #52525b)' }} disabled={!!busy} onClick={() => act('notary-vendor', c)}>Vendor</button>
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>
                        {canWrite && (Array.isArray(c.tokens) ? c.tokens : []).length ? <button type="button" style={link} disabled={!!busy} onClick={() => act('copy', c)}>Copy fields</button> : null}
                        <a href="https://app.pandadoc.com" target="_blank" rel="noreferrer" style={{ ...link, textDecoration: 'none' }}>{c.pandadoc_id ? 'Open in PandaDoc' : 'Open PandaDoc'}</a>
                      </>
                    )}
                  </div>
                </div>
                {c.provider === 'pandadoc' ? <PandaLinks recipients={recips} onToast={onToast} waiting={!c.pandadoc_id} /> : null}
                {ls ? <SignerLinks signers={ls} onToast={onToast} /> : null}
                {terms[c.id] ? <ContractTermsPanel contract={c} canWrite={canWrite} onToast={onToast} onChanged={onChanged} /> : null}
                {showPeople && workspaceId ? <RecipientsPanel workspaceId={workspaceId} contract={c} canWrite={canWrite} onToast={onToast} onChanged={refresh} /> : null}
              </div>
            );
          })}
      </div>
      {fieldsFor && workspaceId ? (
        <React.Suspense fallback={null}>
          <ContractFieldsDialog workspaceId={workspaceId} contract={fieldsFor} onToast={onToast} onClose={() => { setFieldsFor(null); refresh(); }} />
        </React.Suspense>
      ) : null}
    </div>
  );
}

function PandaLinks({ recipients, onToast, waiting }: { recipients: Recipient[]; onToast: (m: string) => void; waiting: boolean }) {
  const links = sharedLinks(recipients);
  if (!links.length) {
    return waiting ? <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--meta, #71717a)' }}>Waiting on PandaDoc. After Casey sends, each signer’s link lands here.</div> : null;
  }
  const copy = (url: string, who: string) => { void navigator.clipboard?.writeText(url).then(() => onToast(`Link for ${who} copied`)); };
  return (
    <div style={{ marginTop: '8px', padding: '10px 12px', background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px' }}>
      {links.map((s, i) => {
        const who = s.name || s.email || s.role || 'Signer';
        const mail = s.email ? `mailto:${s.email}?subject=${encodeURIComponent('Please review and sign')}&body=${encodeURIComponent(`Here is the document to review and sign:\n${s.url}`)}` : null;
        return (
          <div key={`${s.url}-${i}`} style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '5px 0', fontSize: '12.5px' }}>
            <span style={{ fontWeight: 600, minWidth: '90px' }}>{s.role || 'Signer'}</span>
            <span style={{ color: 'var(--muted, #52525b)', flex: 1, minWidth: '120px' }}>{who}{s.email && s.name ? ` · ${s.email}` : ''}</span>
            <span style={{ fontSize: '11px', fontWeight: 700, color: s.done ? 'var(--tx-mint, #0a8560)' : 'var(--meta, #71717a)' }}>{s.done ? 'Signed' : 'Waiting'}</span>
            {!s.done ? (
              <span style={{ display: 'flex', gap: '8px' }}>
                <button type="button" style={link} onClick={() => copy(s.url, who)}>Copy link</button>
                {mail ? <a href={mail} onClick={(e) => reachClick(e, 'email', { name: s.name || '', email: s.email, subject: SIGN_SUBJECT, body: `Here is the document to review and sign:\n${s.url}` })} style={{ ...link, textDecoration: 'none' }}>Email</a> : null}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SignerLinks({ signers, onToast }: { signers: SignerLink[]; onToast: (m: string) => void }) {
  const copy = (s: SignerLink) => { void navigator.clipboard?.writeText(s.url).then(() => onToast(`Link for ${s.name || s.label || s.role} copied`)); };
  return (
    <div style={{ marginTop: '8px', padding: '10px 12px', background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px' }}>
      {signers.map((s) => {
        // A CC or viewer is copied: they get the signed copy, never a "review and sign" link.
        if (s.recipient_type === 'cc' || s.recipient_type === 'viewer') {
          return (
            <div key={s.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '5px 0', fontSize: '12.5px' }}>
              <span style={{ fontWeight: 600, minWidth: '90px' }}>{s.label || (s.recipient_type === 'cc' ? 'CC' : 'Viewer')}</span>
              <span style={{ color: 'var(--muted, #52525b)', flex: 1, minWidth: '120px' }}>{s.name || '—'}{s.email ? ` · ${s.email}` : ''}</span>
              <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--meta, #71717a)' }}>{s.recipient_type === 'cc' ? 'Gets the signed copy' : 'Can view'}</span>
            </div>
          );
        }
        const st = s.status === 'signed' ? { text: 'Signed', color: 'var(--tx-green, #15803d)' } : s.status === 'viewed' ? { text: 'Viewed', color: 'var(--tx-amber, #b45309)' } : s.status === 'declined' ? { text: 'Declined', color: 'var(--tx-red, #b91c1c)' } : { text: 'Waiting', color: 'var(--meta, #71717a)' };
        const sms = s.phone ? `sms:${s.phone.replace(/[^\d+]/g, '')}?&body=${encodeURIComponent(`Here is the document to review and sign: ${s.url}`)}` : null;
        const mail = s.email ? `mailto:${s.email}?subject=${encodeURIComponent('Please review and sign')}&body=${encodeURIComponent(`Here is the document to review and sign:\n${s.url}`)}` : null;
        return (
          <div key={s.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', padding: '5px 0', fontSize: '12.5px' }}>
            <span style={{ fontWeight: 600, minWidth: '90px' }}>{s.label || s.role}</span>
            <span style={{ color: 'var(--muted, #52525b)', flex: 1, minWidth: '120px' }}>{s.name || '—'}{s.email ? ` · ${s.email}` : ''}{s.phone ? ` · ${s.phone}` : ''}</span>
            <span style={{ fontSize: '11px', fontWeight: 700, color: st.color }}>{st.text}</span>
            {s.status !== 'signed' ? (
              <span style={{ display: 'flex', gap: '8px' }}>
                <button type="button" style={link} onClick={() => copy(s)}>Copy link</button>
                {sms ? <a href={sms} onClick={(e) => reachClick(e, 'text', { name: s.name || '', phone: s.phone, email: s.email, body: `Here is the document to review and sign: ${s.url}` })} style={{ ...link, textDecoration: 'none' }}>Text</a> : null}
                {mail ? <a href={mail} onClick={(e) => reachClick(e, 'email', { name: s.name || '', phone: s.phone, email: s.email, subject: SIGN_SUBJECT, body: `Here is the document to review and sign:\n${s.url}` })} style={{ ...link, textDecoration: 'none' }}>Email</a> : null}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ new contract
type Choice = { id: string; label: string; engine: 'clozr' | 'pandadoc' | 'upload'; clozr?: DocTemplate };
type Remind = 'default' | 'daily' | 'off' | 'template';
const SIGN_BY = [3, 7, 14, 30];
/** A template's own sign-by days, order and reminders (migration 115), as the form's starting values. */
function templateDefaults(t: DocTemplate | undefined): { expires: number; orderMode: 'parallel' | 'sequential'; remind: Remind } {
  const x = t as LibraryTemplate | undefined;
  const p = x?.reminder_policy;
  const remind: Remind = !p ? 'default'
    : !p.first_after_days && !p.repeat_every_days ? 'off'
    : p.first_after_days === 1 && p.repeat_every_days === 1 ? 'daily'
    : p.first_after_days === 1 && p.repeat_every_days === 2 ? 'default' : 'template';
  return { expires: x?.default_expiry_days || 14, orderMode: x?.default_signing_order === 'sequential' ? 'sequential' : 'parallel', remind };
}
/** An edit to a template recipient; `unlinked` means the sender cleared the CRM link. */
type SignerEdit = Partial<SignerInput> & { unlinked?: boolean };
type Extra = { name: string; email: string; phone: string; type: 'cc' | 'viewer' | 'approver'; delivery: 'email' | 'sms' | 'both'; link: ContactLink | null };
const NO_LINK: ContactLink = { seller_id: null, buyer_id: null, vendor_id: null, user_id: null };
const linkFields = (l: ContactLink | null | undefined): ContactLink => ({ ...NO_LINK, ...(l ?? {}) });
/** A recipient on a one-off uploaded PDF: signs, or only fills in fields. */
type UploadRecip = { role: string; label: string; name: string; email: string; phone: string; type: 'signer' | 'filler' };
/** What a template role does on this contract: signs, fills in only (PDF), or gets a copy (CC). */
type RoleType = 'signer' | 'filler' | 'cc';
/** The numbered step headings, PandaDoc's order: recipients, details, send. */
function StepHead({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', margin: '14px 0 6px' }}>
      <span style={{ width: '18px', height: '18px', borderRadius: '50%', background: 'var(--ink, #18181b)', color: 'var(--surface, #fff)', fontSize: '11px', fontWeight: 700, display: 'inline-grid', placeItems: 'center', flex: 'none' }}>{n}</span>
      <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--ink, #18181b)' }}>{title}</span>
      {hint ? <span style={{ fontSize: '12px', color: 'var(--meta, #71717a)' }}>{hint}</span> : null}
    </div>
  );
}

function NewContract({ workspaceId, sellerId, dealId, buyerId, seller, buyer, onToast, onDone, startTemplateId = null }: {
  workspaceId: number; sellerId: number | null; dealId: number | null; buyerId: number | null; seller: Party; buyer: Party; startTemplateId?: number | null;
  onToast: (m: string) => void; onDone: (c: ContractRow, links?: SignerLink[], placeFields?: boolean) => void;
}) {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [choiceId, setChoiceId] = useState('');
  const [kind, setKind] = useState<ContractKind>('offer');
  const [render, setRender] = useState<{ id: string; r: RenderResult } | null>(null);
  const [signerEdits, setSignerEdits] = useState<Record<string, SignerEdit>>({});
  const [fills, setFills] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [needsNotary, setNeedsNotary] = useState(false);
  const [notaryMode, setNotaryMode] = useState<'digital' | 'wet' | 'vendor'>('digital');
  const [notaryVendor, setNotaryVendor] = useState('');
  const [expires, setExpires] = useState(14);
  const [orderMode, setOrderMode] = useState<'parallel' | 'sequential'>('parallel');
  const [remind, setRemind] = useState<Remind>('default');
  const [folders, setFolders] = useState<DocFolder[]>([]);
  const [tplQuery, setTplQuery] = useState('');
  const [extras, setExtras] = useState<Extra[]>([]);
  // "Save as a new Person or Buyer?" before sending, for recipients typed in by hand.
  const [askCrm, setAskCrm] = useState<Unsaved[] | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [, setPreviewToSend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ contract: ContractRow; signers: SignerLink[]; emailed: number; texted?: number; awaiting_approval?: boolean } | null>(null);
  const [packetDone, setPacketDone] = useState<{ contract: ContractRow; packet: string } | null>(null);
  const [recips, setRecips] = useState<Recipient[] | null>(null);
  const [packetPreview, setPacketPreview] = useState<string>('');
  // PDF overlay: a one-off upload, and who signs or fills in on PDF templates.
  const [upFile, setUpFile] = useState<File | null>(null);
  const [upName, setUpName] = useState('');
  const [upRecips, setUpRecips] = useState<UploadRecip[] | null>(null);
  const [rtypes, setRtypes] = useState<Record<string, RoleType>>({});
  // Opened on a template picked a step earlier: show its name, not a second template menu.
  const [changingTpl, setChangingTpl] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const [cz, fs] = await Promise.all([listDocTemplates(workspaceId), templateFolders(workspaceId)]);
      if (!live) return;
      if (fs.ok) setFolders(fs.data.folders);
      const clozr = (Array.isArray(cz) ? cz : []).map((t) => ({ id: `c${t.id}`, label: t.name, engine: 'clozr' as const, clozr: t }));
      const panda: Choice[] = [{ id: 'p-packet', label: 'Fields to paste into PandaDoc', engine: 'pandadoc' }];
      const upload: Choice[] = [{ id: 'upload', label: 'Upload a PDF (TREC form, county form…)', engine: 'upload' }];
      // The paste-into-PandaDoc packet is gone from new contracts: CLOZR sends its own.
      void panda;
      const list: Choice[] = [...clozr, ...upload];
      setChoices(list);
      // Picked on the record's template list: start on that one.
      const first = clozr.find((c) => c.clozr.id === startTemplateId) ?? clozr[0];
      // -1: "Upload a PDF or use PandaDoc instead" on the template list.
      setChoiceId(startTemplateId === -1 ? 'upload' : first?.id ?? list[0].id);
      setKind((first?.clozr.kind as ContractKind) ?? 'offer');
      const d = templateDefaults(first?.clozr);
      setExpires(d.expires); setOrderMode(d.orderMode); setRemind(d.remind);
    })();
    return () => { live = false; };
  }, [workspaceId, startTemplateId]);

  const choice = choices?.find((c) => c.id === choiceId) ?? null;
  // A seller or buyer picked in the recipients fills the details from their own record and deal.
  const partyOfRole = (role: string) => ((choice?.clozr?.signers ?? []) as { role: string; party?: string }[]).find((r) => r.role === role)?.party;
  const pickedId = (party: 'seller' | 'buyer') => {
    const e = Object.entries(signerEdits).find(([role, x]) => partyOfRole(role) === party && (party === 'seller' ? x.seller_id : x.buyer_id));
    return e ? Number(party === 'seller' ? e[1].seller_id : e[1].buyer_id) : null;
  };
  const rSeller = sellerId ?? pickedId('seller');
  const rBuyer = buyerId ?? pickedId('buyer');

  // A CLOZR template renders on selection so the signer list and fill-ins appear.
  useEffect(() => {
    if (!choice?.clozr) return;
    let live = true;
    const id = choice.id;
    void renderClozr(workspaceId, { templateId: choice.clozr.id, sellerId: rSeller, dealId, buyerId: rBuyer }).then((r) => {
      if (!live) return;
      if (!r.ok) { onToast(r.message); return; }
      setRender({ id, r: r.data });
    });
    return () => { live = false; };
  }, [choice, workspaceId, rSeller, dealId, rBuyer, onToast]);

  useEffect(() => {
    if (choice?.engine !== 'pandadoc') return;
    let live = true;
    void contractFields(workspaceId, { sellerId, dealId, buyerId }).then((r) => {
      if (live && r.ok) setPacketPreview(r.data.packet);
    });
    return () => { live = false; };
  }, [choice, workspaceId, sellerId, dealId, buyerId]);

  const rendered = render && render.id === choiceId ? render.r : null;
  const mapped = (rendered?.used ?? []).flatMap((name) => {
    const value = rendered?.tokens.find((t) => t.name === name)?.value;
    return value ? [{ name, value }] : [];
  });
  // A role filled from this record is linked to it until the sender picks or types someone else.
  const autoLink = (s: SignerInput): ContactLink | null => {
    const e = signerEdits[s.role];
    if (e?.unlinked) return null;
    if (e && ((e.name !== undefined && e.name !== s.name) || (e.email !== undefined && e.email !== s.email))) return null;
    if (s.party === 'seller' && sellerId) return { seller_id: sellerId };
    if (s.party === 'buyer' && buyerId) return { buyer_id: buyerId };
    return null;
  };
  const signerRows: SignerInput[] = (rendered?.signers ?? []).map((s) => {
    const { unlinked: _unlinked, ...e } = signerEdits[s.role] ?? {};
    void _unlinked;
    const picked = isLinked(e as ContactLink) ? null : autoLink(s);
    return { ...s, ...e, ...(picked ?? {}) };
  });
  const pickSigner = (role: string, c: Contact) => setSignerEdits((x) => ({ ...x, [role]: { ...x[role], name: c.name, email: c.email ?? '', phone: c.phone ?? '', ...linkFields(linkOf(c)), unlinked: false } }));
  const typeSigner = (role: string, name: string) => setSignerEdits((x) => {
    const cur = x[role] ?? {};
    // Typing over a picked person makes it someone new: drop the link.
    return { ...x, [role]: isLinked(cur as ContactLink) ? { ...cur, name, ...NO_LINK, unlinked: true } : { ...cur, name } };
  });
  const fillNames = (rendered?.missing ?? []).filter((n) => !n.startsWith('Company.'));
  const companyMissing = (rendered?.missing ?? []).filter((n) => n.startsWith('Company.'));
  const tokens = Object.entries(fills).filter(([, v]) => v.trim()).map(([name, value]) => ({ name, value: value.trim() }));
  // A buyer signing needs a phone and an email on the row, same as adding a buyer.
  // The end buyer, from the template's own map: on a purchase agreement the "Buyer" is our company, and that signer is not asked for a buyer's phone.
  const buyerParty = new Set(((choice?.clozr?.signers ?? []) as unknown as { role?: string; party?: string }[]).filter((r) => r.party === 'buyer').map((r) => String(r.role)));
  const buyerRole = (role: string) => buyerParty.has(role);
  const isBuyerRow = (s: SignerInput) => buyerRole(s.role) && (!s.optional || !!(s.name || s.email || s.phone || '').trim());
  const buyerGap = signerRows.map((s) => (isBuyerRow(s) ? buyerContactProblem(s) : null)).find(Boolean) ?? null;
  const pdfTpl = isPdfTemplate(choice?.clozr) ? choice?.clozr ?? null : null;
  const tplRoles = (choice?.clozr?.signers ?? []) as { role: string; recipient_type?: string | null }[];
  const rtypeOf = (role: string): RoleType => {
    if (rtypes[role]) return rtypes[role];
    const t = tplRoles.find((r) => r.role === role)?.recipient_type;
    return t === 'filler' ? 'filler' : t === 'cc' ? 'cc' : 'signer';
  };
  // What goes to the server: a template role marked CC is copied, never asked to sign.
  const signersOut = (): SignerInput[] => signerRows.map((s) => {
    const t = rtypeOf(s.role);
    return t === 'cc' ? { ...s, recipient_type: 'cc' } : pdfTpl ? { ...s, recipient_type: t as SignerInput['recipient_type'] } : s;
  });
  const defaultUpRecips = (): UploadRecip[] => {
    const out: UploadRecip[] = [];
    if (seller?.name || seller?.email) out.push({ role: 'seller', label: 'Seller', name: seller?.name ?? '', email: seller?.email ?? '', phone: seller?.phone ?? '', type: 'signer' });
    if (buyer?.name || buyer?.email) out.push({ role: 'buyer', label: 'Buyer', name: buyer?.name ?? '', email: buyer?.email ?? '', phone: buyer?.phone ?? '', type: 'signer' });
    return out.length ? out : [{ role: 'signer1', label: 'Signer', name: '', email: '', phone: '', type: 'signer' }];
  };
  const upList = upRecips ?? defaultUpRecips();
  const valid = choice?.engine === 'clozr'
    ? signerRows.some((s) => !s.optional && rtypeOf(s.role) !== 'cc' && (s.email || s.name)) && !buyerGap
    : choice?.engine === 'upload'
      ? !!upFile && upList.some((r) => r.name.trim() || r.email.trim())
      : !!(sellerId || dealId || buyerId);

  function defaultRecips(): Recipient[] {
    const party = kind === 'assignment' ? buyer : seller;
    return party?.email ? [{ email: party.email, ...splitName(party.name) }] : [{ email: '' }];
  }
  const pdRecips = recips ?? defaultRecips();

  async function doPreview(thenSend: boolean) {
    if (!choice?.clozr) return;
    setBusy('preview');
    const r = await renderClozr(workspaceId, { templateId: choice.clozr.id, sellerId, dealId, buyerId, tokens });
    setBusy(null);
    if (!r.ok) return onToast(r.message);
    setRender({ id: choice.id, r: r.data });
    setPreviewToSend(thenSend);
    setPreview(r.data.html);
  }
  /**
   * Everyone on it in the CRM and on the deal before it is created: a seller
   * or buyer typed in is saved (or matched), the deal is found or opened, and
   * the contract is filed on the seller, the buyer and the deal.
   */
  async function tie() {
    const { data: auth } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
    const t = await tieContractToCrm(workspaceId, signersOut(), { sellerId, dealId, buyerId }, auth.user?.id ?? null);
    if (!t.ok) { onToast(t.message); return null; }
    if (t.saved.length) onToast(`Added to the CRM and the deal: ${t.saved.join(', ')}`);
    return t;
  }

  async function go(send: boolean, crm?: Record<string, CrmChoice>, review = false) {
    if (!choice) return;
    // Uploaded PDFs and PDF templates: fields placed on the pages (migration 113).
    if (choice.engine === 'upload' || pdfTpl) {
      setBusy(send ? 'send' : 'draft');
      try {
        const extraRows: SignerInput[] = extras.filter((e) => e.email.trim() || e.name.trim()).map((e, i) => ({
          role: `extra${i + 1}`, extra: true, recipient_type: e.type, name: e.name.trim() || null, email: e.email.trim() || null, phone: e.phone.trim() || null,
          delivery: e.delivery, label: e.type === 'cc' ? 'CC' : e.type === 'approver' ? 'Approver' : 'Viewer', ...(e.link ?? {}),
        }));
        const tplPolicy = (choice.clozr as LibraryTemplate | undefined)?.reminder_policy ?? null;
        const reminders = remind === 'off' ? { first_after_days: 0, repeat_every_days: 0 } : remind === 'daily' ? { first_after_days: 1, repeat_every_days: 1 } : remind === 'template' ? tplPolicy : tplPolicy ? { first_after_days: 1, repeat_every_days: 2 } : null;
        const notary = needsNotary ? { needs: true, mode: notaryMode, vendor: notaryVendor || null } : null;
        if (choice.engine === 'upload') {
          // Upload the file, save a draft, then open the field editor on it: fields are placed before it goes out.
          if (!upFile) return onToast('Choose a PDF first.');
          const up = await uploadDocSource(workspaceId, upFile, 'uploads');
          if (!up.ok) return onToast(up.message);
          const used = new Set<string>();
          const people = upList.filter((r) => r.name.trim() || r.email.trim()).map((r, i) => {
            let role = (r.label || r.role).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `signer${i + 1}`;
            while (used.has(role)) role = `${role}_${i + 1}`;
            used.add(role);
            return { role, label: r.label.trim() || 'Signer', name: r.name.trim() || null, email: r.email.trim() || null, phone: r.phone.trim() || null, recipient_type: r.type };
          });
          const r = await createPdfClozr(workspaceId, { sourcePath: up.data, kind, name: upName.trim() || upFile.name.replace(/\.pdf$/i, ''), sellerId, dealId, buyerId, signers: [...people, ...extraRows], message: message || null, expiresDays: expires, send: false, orderMode, reminders, notary });
          if (!r.ok) return onToast(r.message);
          onToast('Draft saved · place the fields, then send it from the list');
          onDone(r.data.contract, r.data.signers, true);
          return;
        }
        if (pdfTpl) {
          const t = await tie();
          if (!t) return;
          const r = await createPdfClozr(workspaceId, { templateId: pdfTpl.id, sellerId: t.ids.sellerId, dealId: t.ids.dealId, buyerId: t.ids.buyerId, signers: [...t.rows, ...extraRows], tokens, message: message || null, expiresDays: expires, send: send && !review, orderMode, reminders, notary });
          if (!r.ok) return onToast(r.message);
          // Review on the document: the draft opens on its pages, filled in, to change anything and send from there.
          if (review) { onDone(r.data.contract, r.data.signers, true); return; }
          setResult(r.data);
          const skipped = r.data.skipped.length ? ` · ${r.data.skipped.length} field${r.data.skipped.length === 1 ? '' : 's'} had nobody to fill them` : '';
          onToast((!send ? 'Draft saved' : r.data.awaiting_approval ? 'Sent to the approver first · it goes out for signature when approved' : r.data.emailed || r.data.texted ? `Sent · ${[r.data.emailed ? `${r.data.emailed} email${r.data.emailed === 1 ? '' : 's'}` : null, r.data.texted ? `${r.data.texted} text${r.data.texted === 1 ? '' : 's'}` : null].filter(Boolean).join(', ')} out` : 'Ready · copy each signing link and text or email it') + skipped);
          return;
        }
      } finally { setBusy(null); }
      return;
    }
    if (choice.clozr) {
      const extraRows: SignerInput[] = extras.filter((e) => e.email.trim() || e.name.trim()).map((e, i) => ({
        role: `extra${i + 1}`, extra: true, recipient_type: e.type, name: e.name.trim() || null, email: e.email.trim() || null, phone: e.phone.trim() || null,
        delivery: e.delivery, label: e.type === 'cc' ? 'CC' : e.type === 'approver' ? 'Approver' : 'Viewer', ...(e.link ?? {}),
      }));
      // Send goes straight out; new people are saved to the CRM and the deal on the way (tie).
      setBusy(send ? 'send' : 'draft');
      try {
        const t = await tie();
        if (!t) return;
        const everyone = [...t.rows, ...extraRows];
        const saved = new Map<string, ContactLink>();
        for (const [key, kind] of Object.entries(crm ?? {})) {
          if (kind === 'skip') continue;
          const s = everyone.find((x) => x.role === key);
          if (!s?.name) continue;
          const { data: auth } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
          const r = await saveRecipientToCrm(workspaceId, { name: s.name, email: s.email, phone: s.phone }, kind, auth.user?.id ?? null);
          if (!r.ok) { onToast(`${s.name}: ${r.message}`); continue; }
          saved.set(key, r.link);
        }
        setAskCrm(null);
        const withLinks = (rows: SignerInput[]) => rows.map((s) => (saved.has(s.role) ? { ...s, ...saved.get(s.role) } : s));
        const reminders = remind === 'off' ? { first_after_days: 0, repeat_every_days: 0 } : remind === 'daily' ? { first_after_days: 1, repeat_every_days: 1 } : remind === 'template' ? (choice.clozr as LibraryTemplate).reminder_policy ?? null
          // Said out loud when the template has its own policy, so the function does not apply that instead.
          : (choice.clozr as LibraryTemplate).reminder_policy ? { first_after_days: 1, repeat_every_days: 2 } : null;
        const r = await createClozr(workspaceId, { templateId: choice.clozr.id, sellerId: t.ids.sellerId, dealId: t.ids.dealId, buyerId: t.ids.buyerId, signers: withLinks(everyone), tokens, message: message || null, expiresDays: expires, send, orderMode, reminders, notary: needsNotary ? { needs: true, mode: notaryMode, vendor: notaryVendor || null } : null });
        if (!r.ok) return onToast(r.message);
        setResult(r.data);
        onToast(!send ? 'Draft saved' : r.data.awaiting_approval ? 'Sent to the approver first · it goes out for signature when approved'
          : r.data.emailed || r.data.texted ? `Sent · ${[r.data.emailed ? `${r.data.emailed} email${r.data.emailed === 1 ? '' : 's'}` : null, r.data.texted ? `${r.data.texted} text${r.data.texted === 1 ? '' : 's'}` : null].filter(Boolean).join(', ')} out` : 'Ready · copy each signing link and text or email it');
        if (r.data.failed?.length) onToast(`Some texts did not go: ${r.data.failed.map((f) => f.reason).join('; ')}`);
      } finally { setBusy(null); }
      return;
    }
    setBusy(send ? 'send' : 'draft');
    try {
      const r = await savePandaPacket(workspaceId, { kind, sellerId, dealId, buyerId, recipients: pdRecips.filter((x) => x.email.includes('@')), message: message || null });
      if (!r.ok) return onToast(r.message);
      setPacketDone({ contract: r.data.contract, packet: r.data.packet });
      onToast('Packet saved. Copy the fields into PandaDoc and send — the webhook will attach it.');
    } finally { setBusy(null); }
  }

  if (packetDone) {
    return (
      <div style={{ marginTop: '12px', padding: '12px', border: '1px solid #A8ECD2', borderRadius: '10px', background: '#F0FBF6' }}>
        <div style={{ fontSize: '13px', fontWeight: 700 }}>{packetDone.contract.name}</div>
        <div style={{ fontSize: '12px', color: 'var(--muted, #52525b)', marginTop: '2px' }}>Copy these fields into the Acme Homes PandaDoc template, proof it, and send. Status and signing links come back here.</div>
        <pre style={{ margin: '10px 0 0', padding: '10px 12px', background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '12px', whiteSpace: 'pre-wrap', maxHeight: '220px', overflow: 'auto' }}>{packetDone.packet || 'No fields yet — fill the record first.'}</pre>
        <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(packetDone.packet).then(() => onToast('Fields copied')); }} style={btn(true)}>Copy fields</button>
          <a href="https://app.pandadoc.com" target="_blank" rel="noreferrer" style={{ ...btn(), display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>Open PandaDoc</a>
          <button type="button" onClick={() => onDone(packetDone.contract)} style={btn()}>Done</button>
        </div>
      </div>
    );
  }

  if (result) {
    return (
      <div style={{ marginTop: '12px', padding: '12px', border: '1px solid #A8ECD2', borderRadius: '10px', background: '#F0FBF6' }}>
        <div style={{ fontSize: '13px', fontWeight: 700 }}>{result.contract.name}</div>
            <div style={{ fontSize: '12px', color: 'var(--muted, #52525b)', marginTop: '2px' }}>
          {result.awaiting_approval ? 'Waiting on the approver. It goes out to the signers as soon as they approve; you will get a notification.' : result.contract.status === 'draft' ? 'Saved as a draft. Send it from the list below when ready.' : result.texted ? `Sent: ${result.emailed} emailed, ${result.texted} texted. Opening a link is tracked on the deal.` : result.emailed ? `Emailed to ${result.emailed} signer${result.emailed === 1 ? '' : 's'}. Opening the link is tracked on the deal — no code.` : 'Each signer has their own link. Opening it is tracked on the deal. Copy it and text or email it — or set an email provider in Settings to send automatically.'}
        </div>
        <SignerLinks signers={result.signers} onToast={onToast} />
        <button type="button" onClick={() => onDone(result.contract, result.signers)} style={{ ...btn(true), marginTop: '10px' }}>Done</button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: '12px', padding: '12px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', background: 'var(--canvas, #fafafa)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: '10px 12px' }}>
        <div>
          <label style={label}>Template</label>
          {startTemplateId != null && startTemplateId !== -1 && !changingTpl && choice ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: '34px' }}>
              <span style={{ fontSize: '13.5px', fontWeight: 700, color: 'var(--ink, #18181b)' }}>{choice.label}{isPdfTemplate(choice.clozr) ? ' (PDF)' : ''}</span>
              <button type="button" onClick={() => setChangingTpl(true)} style={link}>Change</button>
            </div>
          ) : <>
          {(choices?.filter((c) => c.engine === 'clozr').length ?? 0) > 8 ? (
            <input type="search" value={tplQuery} onChange={(e) => setTplQuery(e.target.value)} placeholder="Search templates…" aria-label="Search templates" style={{ ...field, height: '30px', marginBottom: '6px' }} />
          ) : null}
          <select value={choiceId} onChange={(e) => {
            setChoiceId(e.target.value); const c = choices?.find((x) => x.id === e.target.value); if (c) setKind((c.clozr?.kind as ContractKind) ?? 'offer'); setSignerEdits({}); setFills({}); setRtypes({});
            if (c?.clozr) { const d = templateDefaults(c.clozr); setExpires(d.expires); setOrderMode(d.orderMode); setRemind(d.remind); }
          }} style={field} disabled={!choices?.length}>
            {choices === null ? <option value="">Loading templates…</option> : choices.length === 0 ? <option value="">No templates</option> : null}
            {(() => {
              // Grouped by folder (in tree order), unfiled first; the search narrows by name but keeps the chosen one.
              const terms = tplQuery.toLowerCase().split(/\s+/).filter(Boolean);
              const cz = (choices ?? []).filter((c) => c.engine === 'clozr' && (c.id === choiceId || terms.every((t) => c.label.toLowerCase().includes(t))));
              const folderOf = (c: Choice) => (c.clozr as LibraryTemplate | undefined)?.folder_id ?? null;
              const tree = folderTree(folders);
              const groups: Array<{ key: string; label: string; items: Choice[] }> = [
                { key: 'none', label: tree.length ? 'Templates' : 'Acme Homes templates', items: cz.filter((c) => folderOf(c) == null || !tree.some((f) => f.id === folderOf(c))) },
                ...tree.map((f) => ({ key: String(f.id), label: f.path, items: cz.filter((c) => folderOf(c) === f.id) })),
              ];
              return groups.filter((g) => g.items.length).map((g) => <optgroup key={g.key} label={g.label}>{g.items.map((c) => <option key={c.id} value={c.id}>{c.label}{isPdfTemplate(c.clozr) ? ' (PDF)' : ''}</option>)}</optgroup>);
            })()}
            {choices?.some((c) => c.engine === 'upload') ? <optgroup label="Your own PDF">{choices.filter((c) => c.engine === 'upload').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup> : null}
            {choices?.some((c) => c.engine === 'pandadoc') ? <optgroup label="PandaDoc (paste by hand)">{choices.filter((c) => c.engine === 'pandadoc').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup> : null}
          </select>
          </>}
        </div>
        <div>
          <label style={label}>{choice?.engine !== 'pandadoc' ? 'Sign by' : 'Type'}</label>
          {choice?.engine !== 'pandadoc' ? (
            <select value={expires} onChange={(e) => setExpires(Number(e.target.value))} style={field}>
              {(SIGN_BY.includes(expires) ? SIGN_BY : [...SIGN_BY, expires].sort((a, b) => a - b)).map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          ) : (
            <select value={kind} onChange={(e) => setKind(e.target.value as ContractKind)} style={field}>
              {(Object.keys(KIND_LABELS) as ContractKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </select>
          )}
        </div>
      </div>

      {choice?.engine === 'clozr' ? (
        <>
          <div>
            <StepHead n={1} title="Recipients" hint="Who signs, and who gets a copy" />
            {!rendered ? <div style={{ fontSize: '12px', color: 'var(--subtle, #a1a1aa)' }}>Filling the template from the record…</div> : signerRows.map((s) => (
              <div key={s.role} style={{ display: 'grid', gridTemplateColumns: '90px minmax(0, 1.3fr) minmax(0, 1.4fr) minmax(0, 1fr) 104px', gap: '8px', marginBottom: '6px', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: s.optional ? 'var(--subtle, #a1a1aa)' : 'var(--ink, #18181b)' }}>{s.label}{s.optional ? ' (opt.)' : ''}</span>
                <RecipientPicker workspaceId={workspaceId} value={s.name ?? ''} onChange={(v) => typeSigner(s.role, v)} onPick={(c) => pickSigner(s.role, c)} linked={linkLabel(s)} onUnlink={() => setSignerEdits((x) => ({ ...x, [s.role]: { ...x[s.role], ...NO_LINK, unlinked: true } }))} placeholder="Full name — or search" />
                <input value={s.email ?? ''} onChange={(e) => setSignerEdits((x) => ({ ...x, [s.role]: { ...x[s.role], email: e.target.value } }))} placeholder={buyerRole(s.role) ? 'Email *' : 'email@example.com'} type="email" style={field} />
                <input value={s.phone ?? ''} onChange={(e) => setSignerEdits((x) => ({ ...x, [s.role]: { ...x[s.role], phone: e.target.value } }))} placeholder={buyerRole(s.role) ? 'Phone *' : 'Phone (for texting)'} style={field} />
                <select value={s.delivery ?? 'email'} onChange={(e) => setSignerEdits((x) => ({ ...x, [s.role]: { ...x[s.role], delivery: e.target.value as 'email' | 'sms' | 'both' } }))} style={{ ...field, padding: '0 6px' }} title="How the signing link goes out">
                  <option value="email">Email</option><option value="sms">Text</option><option value="both">Both</option>
                </select>
                <select value={rtypeOf(s.role)} onChange={(e) => setRtypes((x) => ({ ...x, [s.role]: e.target.value as RoleType }))} style={{ ...field, gridColumn: '2 / span 1', height: '30px' }} title="A CC gets the signed copy and is never asked to sign">
                  <option value="signer">Signs</option>
                  {pdfTpl ? <option value="filler">Fills in fields only</option> : null}
                  <option value="cc">Gets a copy (CC)</option>
                </select>
              </div>
            ))}
            {rendered && buyerGap ? <div style={{ fontSize: '12px', color: 'var(--tx-red, #b91c1c)', marginBottom: '6px' }}>{buyerGap}</div> : null}
            {rendered && signerRows.some((s) => ['seller', 'seller2', 'buyer'].includes(String(s.party)) && (s.name ?? '').trim() && !isLinked(s as ContactLink)) ? (
              <div style={{ fontSize: '12px', color: 'var(--muted, #52525b)', marginBottom: '6px' }}>
                Not in the CRM yet: {signerRows.filter((s) => ['seller', 'seller2', 'buyer'].includes(String(s.party)) && (s.name ?? '').trim() && !isLinked(s as ContactLink)).map((s) => s.name).join(', ')}. They are added (or matched by email and phone) and put on the deal when you send.
              </div>
            ) : null}
            {rendered ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginTop: '8px' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--muted, #52525b)' }}>
                  Order
                  <select value={orderMode} onChange={(e) => setOrderMode(e.target.value as 'parallel' | 'sequential')} style={{ ...field, width: 'auto', height: '30px' }} title="Sequential sends each signer their link only after the one above them has signed">
                    <option value="parallel">Everyone at once</option>
                    <option value="sequential">In order, top to bottom</option>
                  </select>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--muted, #52525b)' }}>
                  Reminders
                  <select value={remind} onChange={(e) => setRemind(e.target.value as Remind)} style={{ ...field, width: 'auto', height: '30px' }} title="Automatic nudges to whoever has not signed, 8am to 8pm Central">
                    <option value="default">After 1 day, then every 2</option>
                    <option value="daily">Every day</option>
                    <option value="off">Off</option>
                    {(choice?.clozr as LibraryTemplate | undefined)?.reminder_policy ? (() => {
                      const p = (choice!.clozr as LibraryTemplate).reminder_policy!;
                      return <option value="template">Template: after {p.first_after_days} day{p.first_after_days === 1 ? '' : 's'}, then every {p.repeat_every_days}</option>;
                    })() : null}
                  </select>
                </label>
                <button type="button" onClick={() => setExtras((x) => [...x, { name: '', email: '', phone: '', type: 'cc', delivery: 'email', link: null }])} style={link}>+ Add CC recipient</button>
              </div>
            ) : null}
            {extras.map((e, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px minmax(0, 1.3fr) minmax(0, 1.4fr) minmax(0, 1fr) 104px auto', gap: '8px', marginTop: '6px', alignItems: 'center' }}>
                <select value={e.type} onChange={(ev) => setExtras((x) => x.map((y, j) => (j === i ? { ...y, type: ev.target.value as Extra['type'] } : y)))} style={{ ...field, height: '34px' }} title="CC gets the signed copy; a viewer can read it while it is out; an approver signs off before anyone else gets it">
                  <option value="cc">CC (gets a copy)</option>
                  <option value="viewer">Viewer</option>
                  <option value="approver">Approver</option>
                </select>
                <RecipientPicker
                  workspaceId={workspaceId} value={e.name} kinds={e.type === 'approver' ? ['team'] : undefined}
                  placeholder={e.type === 'approver' ? 'Search your team' : 'Full name — or search'}
                  onChange={(v) => setExtras((x) => x.map((y, j) => (j === i ? { ...y, name: v, link: null } : y)))}
                  onPick={(c) => setExtras((x) => x.map((y, j) => (j === i ? { ...y, name: c.name, email: c.email ?? '', phone: c.phone ?? '', link: linkOf(c) } : y)))}
                  linked={linkLabel(e.link)} onUnlink={() => setExtras((x) => x.map((y, j) => (j === i ? { ...y, link: null } : y)))}
                />
                <input value={e.email} onChange={(ev) => setExtras((x) => x.map((y, j) => (j === i ? { ...y, email: ev.target.value } : y)))} placeholder="email@example.com" type="email" style={field} />
                <input value={e.phone} onChange={(ev) => setExtras((x) => x.map((y, j) => (j === i ? { ...y, phone: ev.target.value } : y)))} placeholder="Phone (for texting)" style={field} />
                <select value={e.delivery} onChange={(ev) => setExtras((x) => x.map((y, j) => (j === i ? { ...y, delivery: ev.target.value as Extra['delivery'] } : y)))} style={{ ...field, padding: '0 6px' }} title="How the link goes out">
                  <option value="email">Email</option><option value="sms">Text</option><option value="both">Both</option>
                </select>
                <button type="button" onClick={() => setExtras((x) => x.filter((_, j) => j !== i))} style={{ ...link, color: 'var(--tx-red, #b91c1c)', justifySelf: 'start' }}>Remove</button>
              </div>
            ))}
            {extras.some((e) => e.type === 'approver') ? <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--tx-mint, #0a8560)' }}>Goes to the approver first. The signers get it only after every approver approves; a rejection brings it back here as a draft.</div> : null}
          </div>
          {rendered?.missing_sections?.length ? (
            <div role="alert" style={{ marginTop: '10px', padding: '8px 10px', borderRadius: '8px', background: 'var(--negative-soft, #fee2e2)', border: '1px solid var(--tint-red-2, #fecaca)', color: 'var(--tx-red, #b91c1c)', fontSize: '12px' }}>
              This template places a section that was deleted (#{rendered.missing_sections.join(', #')}). Fix the template under Contracts → Templates before sending.
            </div>
          ) : null}
          {mapped.length || fillNames.length ? <StepHead n={2} title="Details" hint="Filled from this record. Change anything, or fill in what's blank." /> : null}
          {fillNames.length ? (
            <div style={{ marginTop: '4px' }}>
              <label style={{ ...label, color: 'var(--tx-amber, #b45309)' }}>Blank · fill in</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' }}>
                {fillNames.map((n) => (
                  <div key={n}>
                    <div style={{ fontSize: '11.5px', color: 'var(--muted, #52525b)', marginBottom: '3px' }}>{tokenLabel(n)}</div>
                    <input value={fills[n] ?? ''} onChange={(e) => setFills((f) => ({ ...f, [n]: e.target.value }))} placeholder={n.includes('Date') || n.includes('Deadline') ? 'September 20, 2026' : n.includes('EMD') || n.includes('Fee') || n.includes('Price') ? '$500' : ''} style={field} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {mapped.length ? (
            <div style={{ marginTop: '10px' }}>
              <label style={label}>From this record · edit any of them</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' }}>
                {mapped.map((m) => (
                  <div key={m.name}>
                    <div style={{ fontSize: '11.5px', color: 'var(--muted, #52525b)', marginBottom: '3px' }} title={m.name}>{tokenLabel(m.name)}</div>
                    {/* Typed values ride along as tokens, which win over the record's value. */}
                    <input value={fills[m.name] ?? m.value} onChange={(e) => setFills((f) => ({ ...f, [m.name]: e.target.value }))} style={field} />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {companyMissing.length ? <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--tx-amber, #b45309)' }}>Company details are blank on this template ({companyMissing.map(tokenLabel).join(', ')}). Fill them in Settings → Contracts and offers.</div> : null}
        </>
      ) : choice?.engine === 'upload' ? (
        <div style={{ marginTop: '10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: '10px 12px' }}>
            <div>
              <label style={label}>PDF</label>
              <FileDrop file={upFile} accept="application/pdf,.pdf" hint="PDF; fields are mapped for you next" onFile={(f) => { if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return onToast('Drop a PDF here.'); setUpFile(f); if (!upName) setUpName(f.name.replace(/\.pdf$/i, '')); setKind(guessKind(f.name)); }} />
            </div>
            <div>
              <label style={label}>Type</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as ContractKind)} style={field}>
                {(Object.keys(KIND_LABELS) as ContractKind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={label}>Name</label>
              <input value={upName} onChange={(e) => setUpName(e.target.value)} placeholder="TREC 1-4 · 912 Cordial Rd" style={field} />
            </div>
          </div>
          <label style={{ ...label, marginTop: '10px' }}>Recipients</label>
          {upList.map((r, i) => {
            const set = (patch: Partial<UploadRecip>) => setUpRecips(upList.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '110px minmax(0, 1.2fr) minmax(0, 1.4fr) minmax(0, 1fr) 130px auto', gap: '6px', marginBottom: '6px', alignItems: 'center' }}>
                <input value={r.label} onChange={(e) => set({ label: e.target.value })} placeholder="Role (Seller)" style={field} />
                <input value={r.name} onChange={(e) => set({ name: e.target.value })} placeholder="Full name" style={field} />
                <input value={r.email} onChange={(e) => set({ email: e.target.value })} placeholder="email@example.com" type="email" style={field} />
                <input value={r.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="Phone" style={field} />
                <select value={r.type} onChange={(e) => set({ type: e.target.value as 'signer' | 'filler' })} style={field} title="A form filler types in their fields and presses Done; they never sign">
                  <option value="signer">Signs</option>
                  <option value="filler">Fills in only</option>
                </select>
                <button type="button" onClick={() => setUpRecips(upList.length > 1 ? upList.filter((_, j) => j !== i) : upList)} style={{ ...btn(), padding: '0 9px', height: '34px' }} aria-label="Remove">×</button>
              </div>
            );
          })}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
            <button type="button" onClick={() => setUpRecips([...upList, { role: `signer${upList.length + 1}`, label: '', name: '', email: '', phone: '', type: 'signer' }])} style={link}>+ Add recipient</button>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--muted, #52525b)' }}>
              Order
              <select value={orderMode} onChange={(e) => setOrderMode(e.target.value as 'parallel' | 'sequential')} style={{ ...field, width: 'auto', height: '30px' }}>
                <option value="parallel">Everyone at once</option>
                <option value="sequential">In order, top to bottom</option>
              </select>
            </label>
          </div>
          <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--meta, #71717a)' }}>Next you place the fields on the pages — signature, initials, dates, text, checkboxes — and give each one to a recipient. It stays a draft until you send it.</div>
        </div>
      ) : (
        <div style={{ marginTop: '10px' }}>
          <label style={label}>Signer{pdRecips.length > 1 ? 's' : ''}</label>
          {pdRecips.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto', gap: '8px', marginBottom: '6px' }}>
              <input value={r.email} onChange={(e) => setRecips(pdRecips.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} placeholder="email@example.com" style={field} type="email" />
              <input value={r.first_name ?? ''} onChange={(e) => setRecips(pdRecips.map((x, j) => (j === i ? { ...x, first_name: e.target.value } : x)))} placeholder="First" style={field} />
              <input value={r.last_name ?? ''} onChange={(e) => setRecips(pdRecips.map((x, j) => (j === i ? { ...x, last_name: e.target.value } : x)))} placeholder="Last" style={field} />
              <button type="button" onClick={() => setRecips(pdRecips.length > 1 ? pdRecips.filter((_, j) => j !== i) : pdRecips)} style={{ ...btn(), padding: '0 9px', height: '34px' }}>×</button>
            </div>
          ))}
          <button type="button" onClick={() => setRecips([...pdRecips, { email: '' }])} style={link}>+ Add signer</button>
          {packetPreview ? (
            <div style={{ marginTop: '10px' }}>
              <label style={label}>Fields to paste into PandaDoc</label>
              <pre style={{ margin: 0, padding: '10px 12px', background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '12px', whiteSpace: 'pre-wrap', maxHeight: '180px', overflow: 'auto' }}>{packetPreview}</pre>
              <button type="button" onClick={() => { void navigator.clipboard?.writeText(packetPreview).then(() => onToast('Fields copied')); }} style={{ ...link, marginTop: '6px' }}>Copy fields</button>
            </div>
          ) : null}
        </div>
      )}

      <div style={{ marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ ...label, margin: 0, display: 'inline-flex', alignItems: 'center', gap: '6px', textTransform: 'none', letterSpacing: 0, fontSize: '12.5px', color: 'var(--ink, #18181b)' }}>
          <input type="checkbox" checked={needsNotary} onChange={(e) => setNeedsNotary(e.target.checked)} /> Needs notarization
        </label>
        {needsNotary ? (
          <>
            <select value={notaryMode} onChange={(e) => setNotaryMode(e.target.value as 'digital' | 'wet' | 'vendor')} style={{ ...field, width: 'auto' }}>
              <option value="digital">In-house digital seal</option>
              <option value="wet">Print and wet-stamp</option>
              <option value="vendor">Third-party vendor</option>
            </select>
            {notaryMode === 'vendor' ? <input value={notaryVendor} onChange={(e) => setNotaryVendor(e.target.value)} placeholder="Vendor name" style={{ ...field, width: '180px' }} /> : null}
          </>
        ) : null}
      </div>
      {choice?.engine !== 'upload' ? <StepHead n={3} title="Review and send" /> : null}
      <div style={{ marginTop: '6px' }}>
        <label style={label}>Message to signers (optional)</label>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="Attached is the agreement we discussed. Reach out with any questions." style={{ ...field, height: 'auto', padding: '8px 10px', resize: 'vertical' }} />
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
        {choice?.engine === 'upload' ? (
          <button type="button" disabled={!valid || !!busy} onClick={() => go(false)} style={btn(true, !valid || !!busy)}>{busy === 'draft' ? 'Uploading…' : 'Upload and place fields'}</button>
        ) : choice?.engine === 'clozr' ? (
          <>
            {/* One click sends: it saves as part of the send. Preview is there to look, not a step. */}
            <button type="button" disabled={!valid || !rendered || !!busy} onClick={() => void go(true)} style={btn(true, !valid || !rendered || !!busy)}>{busy === 'send' ? 'Sending…' : 'Send for signatures'}</button>
            {pdfTpl ? <button type="button" disabled={!valid || !rendered || !!busy} onClick={() => void go(false, undefined, true)} style={btn(false, !valid || !rendered || !!busy)} title="Open the filled-in contract to change anything on the page before it goes out">{busy === 'draft' ? 'Opening…' : 'Review on the document'}</button>
              : <button type="button" disabled={!rendered || !!busy} onClick={() => void doPreview(false)} style={btn(false, !rendered || !!busy)}>{busy === 'preview' ? 'Rendering…' : 'Preview'}</button>}
            <button type="button" disabled={!valid || !!busy} onClick={() => go(false)} style={{ ...link, alignSelf: 'center', marginLeft: '4px' }}>{busy === 'draft' ? 'Saving…' : 'Save as draft'}</button>
          </>
        ) : (
          <button type="button" disabled={!valid || !!busy} onClick={() => go(false)} style={btn(true, !valid || !!busy)}>{busy === 'draft' ? 'Saving…' : 'Save packet for PandaDoc'}</button>
        )}
      </div>

      {askCrm ? <SaveToCrmDialog rows={askCrm} busy={busy === 'send'} confirmLabel="Save and send" onCancel={() => setAskCrm(null)} onDone={(c) => void go(true, c)} /> : null}
      {preview ? (
        <div role="dialog" aria-modal="true" aria-label="Contract preview" data-testid="contract-preview" onClick={() => { setPreview(null); setPreviewToSend(false); }} style={{ position: 'fixed', inset: 0, background: 'rgba(24,24,27,.55)', zIndex: 200, display: 'grid', placeItems: 'center', padding: '20px' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(860px, 100%)', maxHeight: '90vh', overflow: 'auto', background: 'var(--surface, #fff)', borderRadius: '12px', boxShadow: '0 20px 60px rgba(0,0,0,.3)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderBottom: '1px solid var(--divider, #e4e4e7)', position: 'sticky', top: 0, background: 'var(--surface, #fff)', zIndex: 1 }}>
              <span style={{ fontSize: '13px', fontWeight: 700, flex: 1, minWidth: 0 }}>Preview · {choice?.label}</span>
              <button type="button" onClick={() => { setPreview(null); setPreviewToSend(false); }} style={btn()}>Close</button>
              <button type="button" disabled={!valid || !!busy} onClick={() => { setPreview(null); setPreviewToSend(false); void go(true); }} style={btn(true, !valid || !!busy)}>{busy === 'send' ? 'Sending…' : 'Send for signatures'}</button>
            </div>
            <div style={{ padding: '8px 14px', fontSize: '12px', color: 'var(--muted, #52525b)', background: 'var(--canvas, #fafafa)', borderBottom: '1px solid var(--divider-2, #f0f0f1)' }}>
              {mapped.length} field{mapped.length === 1 ? '' : 's'} filled from this record{fillNames.length ? ` · ${fillNames.length} still blank` : ''}
            </div>
            <style>{DOC_CSS}</style>
            <div className="cz-doc" dangerouslySetInnerHTML={{ __html: preview }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

// The Supabase client is referenced so the card can be tree-shaken correctly in the demo build.
void supabase;
