'use client';

// What we know: how to reach them and what they told us, each value edited
// where it sits. The edit box is the value itself (same padding, a tint on
// focus), so opening an edit never moves the lines around it.

import React, { useCallback, useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ContactField } from '@/components/ContactField';
import { eyebrow } from './ui';
import { LeadMemoryCard } from './LeadMemoryCard';
import { ImportInfoRows } from './ImportInfo';
import { demoLeadMemory } from '@/lib/lead-memory-client';
import type { SellerPhoneRow } from '@/lib/database.types';
import { addSellerPhones, loadSellerPhones, otherNumbers, primaryFlag, removeSellerPhone } from '@/lib/seller-phones';
import { formatPhone, toE164 } from '@/lib/talkr';
import { InlineField } from '@/components/ds/InlineField';
import { dueDiligence, type KnowField, type KnowSection } from '@/lib/what-we-know';

const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: '132px minmax(0,1fr)', gap: '10px', padding: '7px 0', borderBottom: '1px solid #f0f0f1', fontSize: '12.5px', alignItems: 'baseline', margin: 0 };
const badge = (color: string, bg: string): React.CSSProperties => ({ fontSize: '10px', fontWeight: 700, color, background: bg, borderRadius: '5px', padding: '1px 5px', letterSpacing: '0.02em' });
const quiet: React.CSSProperties = { border: 0, background: 'none', color: '#a1a1aa', cursor: 'pointer', fontSize: '12px', padding: 0 };

/**
 * The seller's other numbers (seller_phones, migration 129), under the
 * primary: each one calls like the primary does, a badge says when one is
 * marked do not call or wrong, and anyone who can edit adds one or takes one
 * off. Read for the open seller only, never with the workspace.
 */
function OtherPhones({ workspaceId, sellerId, primary, canWrite, onCall, onToast }: {
  workspaceId: number; sellerId: number; primary: string; canWrite: boolean;
  onCall: (phone: string, id: number) => void; onToast?: (m: string) => void;
}) {
  const [rows, setRows] = useState<SellerPhoneRow[]>([]);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const m = await loadSellerPhones(workspaceId, [sellerId]);
    setRows(m.get(sellerId) ?? []);
  }, [workspaceId, sellerId]);
  useEffect(() => {
    let alive = true;
    void loadSellerPhones(workspaceId, [sellerId]).then((m) => { if (alive) setRows(m.get(sellerId) ?? []); });
    return () => { alive = false; };
  }, [workspaceId, sellerId]);

  const add = async () => {
    if (draft === null) return;
    const e164 = toE164(draft.trim());
    if (!e164) return setErr('Enter a full phone number, area code first');
    setBusy(true);
    const r = await addSellerPhones(workspaceId, sellerId, primary, [{ phone: e164 }], 'manual');
    setBusy(false);
    if (!r.ok) return setErr(r.message || 'That number was not saved.');
    setErr(null);
    setDraft(null);
    onToast?.(r.added ? 'Number added' : 'That number is already on file');
    void reload();
  };
  const remove = async (id: number) => {
    const r = await removeSellerPhone(workspaceId, id);
    if (!r.ok) return onToast?.(r.message || 'That number was not removed.');
    setRows((xs) => xs.filter((x) => x.id !== id));
  };

  // The main number logged wrong (or registry DNC) while they had others: the dialer skips it.
  const own = toE164(primary);
  const ownFlag = primaryFlag(primary, rows);
  const ownRow = ownFlag ? rows.find((r) => toE164(r.phone) === own && (r.is_wrong || r.is_dnc)) : undefined;
  return (
    <>
      {ownFlag ? (
        <div style={{ marginTop: '3px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', color: '#71717a' }}>
          <span style={badge(ownFlag === 'dnc' ? '#b91c1c' : '#b45309', ownFlag === 'dnc' ? '#fef2f2' : '#fffbeb')}>{ownFlag === 'dnc' ? 'DNC' : 'Wrong'}</span>
          Main number: the dialer skips it
          {canWrite && ownRow && ownFlag === 'wrong' ? (
            <button type="button" onClick={() => void remove(ownRow.id)} title="It is their number after all" style={{ ...quiet, color: '#0A8560', fontSize: '11.5px' }}>Undo</button>
          ) : null}
        </div>
      ) : null}
      {otherNumbers(primary, rows).map((r) => {
        const label = formatPhone(r.phone);
        return (
          <div key={r.id} style={{ marginTop: '3px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            {r.is_dnc ? (
              <span className="clozr-contact" title="Marked do not call" style={{ fontWeight: 500, color: '#71717a' }}>{label}</span>
            ) : (
              <a href="#" className="clozr-contact" onClick={(e) => { e.preventDefault(); onCall(r.phone, r.id); }} style={{ fontWeight: 500 }}>{label}</a>
            )}
            {r.is_dnc ? <span style={badge('#b91c1c', '#fef2f2')}>DNC</span> : null}
            {r.is_wrong ? <span style={badge('#b45309', '#fffbeb')} title="Logged as a wrong number">Wrong</span> : null}
            {canWrite ? (
              <button type="button" title={`Remove ${label}`} aria-label={`Remove ${label}`} onClick={() => void remove(r.id)} style={{ ...quiet, fontSize: '11.5px', minHeight: '24px' }}>Remove</button>
            ) : null}
          </div>
        );
      })}
      {canWrite && draft !== null ? (
        <span style={{ marginTop: '4px', display: 'flex', gap: '4px', alignItems: 'center', minWidth: 0 }}>
          <input autoFocus value={draft} disabled={busy} type="tel" aria-label="Another number" placeholder="(210) 555-0100"
            aria-invalid={err ? true : undefined}
            onChange={(e) => { setDraft(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); if (e.key === 'Escape') { setDraft(null); setErr(null); } }}
            style={{ height: '26px', minWidth: 0, width: '100%', padding: '0 7px', border: '1px solid #0A8560', borderRadius: '7px', fontSize: '12.5px', outline: 0 }} />
          <button type="button" onClick={() => void add()} disabled={busy} style={{ height: '26px', padding: '0 8px', border: 0, borderRadius: '7px', background: '#0A8560', color: '#fff', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>Add</button>
        </span>
      ) : null}
      {err ? <span role="alert" className="ds-inline-error" style={{ display: 'block', marginTop: '2px' }}>{err}</span> : null}
      {canWrite && draft === null ? (
        <button type="button" onClick={() => setDraft('')} style={{ ...quiet, display: 'block', marginTop: '3px', minHeight: '24px', color: '#0A8560', fontWeight: 600 }}>Add number</button>
      ) : null}
    </>
  );
}

const SECTION_LABEL: Record<KnowSection, string> = {
  dd: 'Due diligence', property: 'Property', deal: 'Numbers', seller: 'What they told us', form: 'Form answers',
};
const sectionHead: React.CSSProperties = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', margin: '14px 0 2px', fontSize: '11px', fontWeight: 600, color: '#52525b' };

function DoneMark({ done }: { done: boolean }) {
  return done ? (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#0A8560" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Answered" role="img" style={{ flex: 'none', marginTop: '2px' }}>
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  ) : (
    <span role="img" aria-label="Not asked yet" style={{ width: '10px', height: '10px', borderRadius: '999px', boxShadow: 'inset 0 0 0 1.5px #d4d4d8', flex: 'none', margin: '3px 2px 0' }} />
  );
}

/** One row: the label, the value edited in place, and what goes beside it. */
function KnowRow({ V, f, readOnly }: { V: ClozrView; f: KnowField; readOnly: string | false }) {
  const link = typeof f.value === 'string' && /^https?:\/\//i.test(f.value) ? f.value : null;
  return (
    <div style={row} data-field={f.field}>
      <dt style={{ color: '#71717a', lineHeight: 1.35, display: 'flex', gap: '6px', alignItems: 'flex-start' }}>
        {f.dd ? <DoneMark done={f.dd.done} /> : null}
        <span>{f.k}</span>
      </dt>
      <dd style={{ margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 }}>
          <InlineField recordId={V.P.id} field={f.field} label={f.k} type={f.type} value={f.value}
            readOnly={f.readOnly || readOnly} placeholder={f.dd ? 'Ask' : 'Add'}
            format={f.type === 'number' ? () => f.v : undefined}
            onSave={(v) => V.saveSellerField(f.field, v)} />
          {link ? <a href={link} target="_blank" rel="noreferrer" style={{ fontSize: '11.5px', color: '#0A8560', fontWeight: 600 }}>Open</a> : null}
          {f.section === 'deal' ? (
            <button type="button" className="rec-press" onClick={V.comprLinked ? V.openCompr : V.runCompr} disabled={!V.comprLinked && V.comprRunning}
              style={{ border: 0, background: 'none', padding: '2px 0', font: 'inherit', fontSize: '11.5px', fontWeight: 600, color: '#0A8560', cursor: 'pointer' }}>
              {V.comprLinked ? 'Open in COMPR' : V.comprRunning ? 'Running COMPR…' : 'Run COMPR'}
            </button>
          ) : null}
        </span>
        {f.note ? <span style={{ fontSize: '11.5px', color: '#71717a', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{f.note}</span> : null}
      </dd>
    </div>
  );
}

const SECTIONS: KnowSection[] = ['dd', 'property', 'deal', 'seller', 'form'];

/**
 * The editable rows of What we know, section by section. The Submission tab
 * draws the form's answers with this; What we know draws the rest.
 */
export function KnowRows({ V, sections = SECTIONS, heads = true }: { V: ClozrView; sections?: readonly KnowSection[]; heads?: boolean }) {
  const fields: KnowField[] = V.personFields || [];
  const dd = dueDiligence(fields);
  const readOnly = V.liveIds && !V.liveIds.canWrite ? 'Read-only: you can’t edit this record' : false;
  return (
    <>
      {sections.map((sec) => {
        const rows = fields.filter((f) => f.section === sec);
        // A lead that never came through the disposition form has no form answers to show.
        if (!rows.length || (sec === 'form' && rows.every((f) => f.v === '—'))) return null;
        return (
          <React.Fragment key={sec}>
            {heads ? (
              <div role="heading" aria-level={3} style={sectionHead}>
                <span>{SECTION_LABEL[sec]}</span>
                {sec === 'dd' ? (
                  <span data-testid="dd-progress" style={{ fontWeight: 600, color: dd.done === dd.of ? '#0A8560' : '#b45309' }}>
                    {dd.done === dd.of ? 'All four in' : `${dd.done} of ${dd.of} in`}
                  </span>
                ) : null}
              </div>
            ) : null}
            {rows.map((f) => <KnowRow key={f.field} V={V} f={f} readOnly={readOnly} />)}
          </React.Fragment>
        );
      })}
    </>
  );
}

/** `omit`: sections another tab already draws (the form's answers, on a record with a Submission tab). */
export function WhatWeKnow({ V, bare, omit }: { V: ClozrView; bare?: boolean; omit?: readonly KnowSection[] }) {
  const others = (V.sellersOnProperty || []).filter((p) => !p.isCurrent);
  // A live record this user can't edit reads as text, with the reason as the tooltip.
  const readOnly = V.liveIds && !V.liveIds.canWrite ? 'Read-only: you can’t edit this record' : false;
  const ws = V.liveIds?.workspaceId ?? null;
  return (
    <section aria-label="What we know" data-testid="record-know">
      {bare ? null : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ ...eyebrow, margin: 0 }}>What we know</h2>
          <span style={{ fontSize: '11px', color: '#71717a' }}>{readOnly ? 'Read-only' : 'Click a value to edit'}</span>
        </div>
      )}
      <div style={{ margin: bare ? '0 0 8px' : '6px 0 8px' }}>
        <LeadMemoryCard
          key={V.P.id}
          kind="seller"
          workspaceId={V.liveIds?.workspaceId ?? null}
          recordId={V.liveIds?.sellerId ?? null}
          demo={V.isLiveData ? null : demoLeadMemory('seller', { id: V.P.id, name: V.P.name, address: V.P.addr, fields: (V.personFields || []).map((f) => ({ k: f.k, v: f.v })) })}
        />
      </div>
      <dl style={{ margin: 0 }}>
        <div style={row}>
          <dt style={{ color: '#71717a' }}>Phones</dt>
          <dd style={{ margin: 0, minWidth: 0 }}>
            <ContactField field="phone" sellerId={V.liveIds?.sellerId ?? null} workspaceId={ws} value={V.P.phone} canWrite={!!V.liveIds?.canWrite} onSaved={() => V.sellerSaved()} onToast={V.showToast}>
              {V.P.phone && V.P.phone !== '—'
                ? <a href="#" className="clozr-contact" onClick={(e) => { e.preventDefault(); V.callPerson(); }} style={{ fontWeight: 500 }}>{formatPhone(V.P.phone)}</a>
                : <span style={{ color: '#a1a1aa' }}>No phone yet</span>}
            </ContactField>
            {V.liveIds?.sellerId ? (
              <OtherPhones key={V.liveIds.sellerId} workspaceId={V.liveIds.workspaceId} sellerId={V.liveIds.sellerId} primary={V.P.phone}
                canWrite={!!V.liveIds.canWrite} onCall={(phone, id) => { V.callPersonAt(phone, id); }} onToast={V.showToast} />
            ) : null}
            {others.map((p) => (
              <div key={p.name + p.phone} style={{ marginTop: '3px', fontSize: '12px' }}>
                <span className="clozr-contact" style={{ fontWeight: 500 }}>{p.phone}</span>
                <button type="button" className="dc12" onClick={p.go} style={{ marginLeft: '6px', border: 0, background: 'none', padding: 0, cursor: 'pointer', color: '#71717a', fontSize: '12px' }}>
                  {p.name} · {String(p.role).toLowerCase()}
                </button>
              </div>
            ))}
          </dd>
        </div>
        <div style={row}>
          <dt style={{ color: '#71717a' }}>Email</dt>
          <dd style={{ margin: 0, minWidth: 0, fontWeight: 500 }}>
            <ContactField field="email" sellerId={V.liveIds?.sellerId ?? null} workspaceId={ws} value={V.P.email} canWrite={!!V.liveIds?.canWrite} onSaved={() => V.sellerSaved()} onToast={V.showToast} />
          </dd>
        </div>
        {V.liveIds?.sellerId ? <ImportInfoRows key={V.liveIds.sellerId} workspaceId={V.liveIds.workspaceId} sellerId={V.liveIds.sellerId} /> : null}
        <KnowRows V={V} sections={omit?.length ? SECTIONS.filter((x) => !omit.includes(x)) : SECTIONS} />
      </dl>
    </section>
  );
}
