'use client';

// One vendor (a lender, title company, attorney, photographer…), opened like a
// seller: every field edits in place, Call / Text / Email go through the
// softphone and the docked composer, and the activity is the same stream the
// seller and buyer records draw: messages to and from the vendor's phone and
// email, and the deals they sit on.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ScreenFrame, ScreenHeader } from '@/components/ds/Screen';
import { EmptyState } from '@/components/ds/Empty';
import { TypeChip } from '@/components/TypeChip';
import { openReach } from '@/app/components/record/reach';
import { ActivityChips } from '@/app/components/record/ActivityChips';
import { ActivityStream, feedToStream, readOrder, saveOrder, type StreamOrder } from '@/app/components/record/ActivityStream';
import { dbId, loadVendorTimeline } from '@/lib/crm';
import { setVendorField, setVendorLocation, setVendorMainPoc, type VendorField } from '@/lib/crm-write';
import type { TimelineEntry } from '@/lib/clozr-types';
import { supabase } from '@/lib/supabase';
import { useConfirm } from '@/components/ds/Confirm';
import '@/app/components/record/record.css';

type VendorRow = {
  id: number; business_name: string; contact_name: string | null; title: string | null; phone: string | null; email: string | null;
  service_type: string | null; city: string | null; state: string | null; markets: string[] | null; notes: string | null;
  tags: string[] | null; status: string | null; is_main_poc: boolean | null;
};
const COLS = 'id,business_name,contact_name,title,phone,email,service_type,city,state,markets,notes,tags,status,is_main_poc';
const TYPES = ['Lender', 'Hard Money Lender', 'Title Company', 'Attorney', 'Photographer/Notary', 'Contractor', 'Insurance', 'Survey', 'Realtor', 'Novation Realtor', 'Flat Fee Realtor/Service', 'Wholesaler', 'Institutional seller', 'Other'];
const STATUSES = ['active', 'inactive', 'archived'];

const FEED_CHIPS = [['All', 'All'], ['Calls', 'call'], ['Texts', 'sms'], ['Email', 'mail'], ['Deals', 'deal']] as const;
const chanIs = (chan: string, key: string) => key === 'All' || chan.toLowerCase().includes(key) || (key === 'sms' && chan.toLowerCase().includes('text'));
const CHAN: Record<string, [string, string]> = {
  call: ['#e6142e', 'Call'], voicemail: ['#e6142e', 'Voicemail'], sms_in: ['#e6142e', 'SMS in'], sms_out: ['#e6142e', 'SMS out'],
  email: ['var(--muted, #52525b)', 'Email'], note: ['var(--meta, #71717a)', 'Note'], deal: ['#0A8560', 'Deal'],
};
const pretty = (p: string | null) => {
  const d = (p ?? '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p ?? '';
};

/** A label over an input that saves on blur or Enter when it changed. */
function Field({ label, value, onSave, multiline, placeholder, disabled }: {
  label: string; value: string; onSave: (v: string) => Promise<boolean>; multiline?: boolean; placeholder?: string; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  // A saved (or reloaded) value replaces the draft.
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setDraft(value); }
  const commit = async () => { if (draft.trim() !== value.trim() && !(await onSave(draft))) setDraft(value); };
  const common = {
    value: draft, disabled, placeholder: placeholder ?? '—', 'aria-label': label,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => void commit(),
    style: { width: '100%', minWidth: 0, padding: '6px 8px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', background: 'var(--surface, #fff)', font: '13px/1.4 var(--font-sans)', color: 'var(--ink, #18181b)', resize: 'vertical' as const },
  };
  return (
    <label style={{ display: 'grid', gap: '4px', fontSize: '11px', fontWeight: 600, color: 'var(--meta, #71717a)' }}>
      {label}
      {multiline
        ? <textarea rows={4} {...common} />
        : <input {...common} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(value); (e.target as HTMLInputElement).blur(); } }} />}
    </label>
  );
}

function Pick({ label, value, options, onSave, disabled }: { label: string; value: string; options: string[]; onSave: (v: string) => void; disabled?: boolean }) {
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <label style={{ display: 'grid', gap: '4px', fontSize: '11px', fontWeight: 600, color: 'var(--meta, #71717a)' }}>
      {label}
      <select value={value} disabled={disabled} onChange={(e) => onSave(e.target.value)} aria-label={label}
        style={{ height: '32px', padding: '0 6px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', background: 'var(--surface, #fff)', font: '13px var(--font-sans)', color: 'var(--ink, #18181b)', textTransform: label === 'Status' ? 'capitalize' : undefined }}>
        {value ? null : <option value="">—</option>}
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

export function VendorRecord({ V }: { V: ClozrView }) {
  const ids = V.liveIds;
  const vid = /^v\d+$/.test(V.vendorId) ? dbId(V.vendorId) : null;
  const canWrite = !!ids?.canWrite;
  const [v, setV] = useState<VendorRow | null | undefined>(undefined);
  const [feed, setFeed] = useState<TimelineEntry[] | null>(null);
  const [nonce, setNonce] = useState(0);
  const [chip, setChip] = useState<string>('All');
  const [order, setOrderState] = useState<StreamOrder>('asc');
  useEffect(() => { const t = setTimeout(() => setOrderState(readOrder()), 0); return () => clearTimeout(t); }, []);
  const setOrder = (o: StreamOrder) => { setOrderState(o); saveOrder(o); };

  // The row itself, read as the signed-in user (RLS), archived or not.
  useEffect(() => {
    if (!supabase || !ids || vid == null) return;
    let alive = true;
    void supabase.from('vendors').select(COLS).eq('workspace_id', ids.workspaceId).eq('id', vid).maybeSingle()
      .then(({ data }) => { if (alive) setV((data as unknown as VendorRow | null) ?? null); });
    return () => { alive = false; };
  }, [ids?.workspaceId, vid]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = v ? v.contact_name || v.business_name : '';
  useEffect(() => {
    if (!ids || !v) return;
    let alive = true;
    void loadVendorTimeline(ids.workspaceId, { id: v.id, name, phone: v.phone, email: v.email }, V.teammateName)
      .then((rows) => { if (alive) setFeed(rows ?? []); });
    return () => { alive = false; };
  }, [ids?.workspaceId, v?.id, v?.phone, v?.email, name, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const { confirm } = useConfirm();
  const save = useCallback(async (field: VendorField, raw: string): Promise<boolean> => {
    if (!v) return false;
    if (field === 'status' && raw === 'archived' && v.status !== 'archived') {
      const ok = await confirm({ title: `Archive ${v.business_name || v.contact_name || 'this vendor'}?`, body: 'They leave every list. Nothing is deleted; Settings, Archive puts them back.', confirmLabel: 'Archive vendor', tone: 'danger' });
      if (!ok) return false;
    }
    if (!canWrite) { V.showToast('You can’t edit vendors in this workspace.', 'error'); return false; }
    const r = await setVendorField(v.id, field, raw);
    if (!r.ok) { V.showToast(r.message || 'That did not save.', 'error'); return false; }
    const { data } = await supabase!.from('vendors').select(COLS).eq('id', v.id).maybeSingle();
    if (data) setV(data as unknown as VendorRow);
    V.reloadCrm();
    return true;
  }, [v, canWrite, V, confirm]);

  const events = useMemo(() => (feed ?? []).map((t): ClozrView['buyerTimeline'][number] => {
    const [color, chan] = CHAN[t.type] ?? ['var(--meta, #71717a)', t.type ? t.type[0].toUpperCase() + t.type.slice(1) : 'Note'];
    return {
      id: t.id, chan, color, title: t.title, body: t.body || '', time: t.time, who: t.who, actor: t.who,
      isCall: t.type === 'call', isSms: /sms/.test(t.type), toRep: t.toRep ?? null, line: t.line ?? null,
      commId: /^ct\d+$/.test(t.id) ? Number(t.id.slice(2)) : null, email: t.email ?? null, ai: t.ai ?? null,
      agentTag: !!t.agent, rep: t.agent ? { name: t.agent.name, avatar: t.agent.avatar || '' } : null, earlier: [],
    };
  }), [feed]);
  const chips = FEED_CHIPS.map(([label, key]) => ({ label, pressed: chip === label, count: key === 'All' ? null : events.filter((t) => chanIs(t.chan, key)).length, go: () => setChip(label) }));
  const items = useMemo(() => events.filter((t) => chanIs(t.chan, FEED_CHIPS.find(([l]) => l === chip)?.[1] ?? 'All')).map((t) => feedToStream(t)), [events, chip]);
  const deals = (feed ?? []).filter((t) => t.type === 'deal' && t.dealId);

  const back = { label: 'Vendors', go: V.backToVendors };
  if (!ids || vid == null || v === null) {
    return (
      <ScreenFrame data-screen-label="Vendor record" header={<ScreenHeader back={back} title="Vendor" />}>
        <EmptyState
          title={!ids ? 'Vendor records open in a signed-in workspace' : 'That vendor isn’t in this workspace'}
          hint={!ids ? 'Sign in to see the vendor’s details and everything said with them.' : 'It may have been archived or opened from another workspace.'}
          action={{ label: 'Back to vendors', onClick: V.backToVendors }}
        />
      </ScreenFrame>
    );
  }
  if (!v) {
    return (
      <ScreenFrame data-screen-label="Vendor record" header={<ScreenHeader back={back} title="Vendor" />}>
        <p role="status" style={{ margin: 0, fontSize: '13px', color: 'var(--muted, #52525b)' }}>Loading the vendor…</p>
      </ScreenFrame>
    );
  }

  const reach = (ch: 'text' | 'email') => openReach(ch, {
    name, phone: v.phone, email: v.email, vendorId: v.id, audience: 'any', onSent: () => setNonce((n) => n + 1),
  });
  return (
    <section data-screen-label="Vendor record" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <ScreenHeader back={back} title={name || v.business_name} meta={name && v.business_name && name !== v.business_name ? v.business_name : undefined} actions={<>
        <button type="button" className="ds-btn ds-btn--ghost" disabled={!v.phone} onClick={() => V.callParty(name, v.phone!)}>Call</button>
        <button type="button" className="ds-btn ds-btn--ghost" disabled={!v.phone} onClick={() => reach('text')}>Text</button>
        <button type="button" className="ds-btn ds-btn--ghost" disabled={!v.email} onClick={() => reach('email')}>Email</button>
      </>} />
      <div style={{ flex: 1, minHeight: 0, display: V.isMobile ? 'block' : 'grid', overflow: V.isMobile ? 'auto' : 'visible', gridTemplateColumns: V.isMobile ? '1fr' : 'var(--rec-side, 320px) minmax(0,1fr)', background: 'var(--page)' }}>
        <aside style={{ borderRight: V.isMobile ? 0 : '1px solid var(--divider, #e4e4e7)', overflow: 'auto', padding: '12px', display: 'grid', gap: '10px', alignContent: 'start' }}>
          <div className="rec-card" style={{ display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '16px', fontWeight: 700, color: 'var(--ink, #18181b)' }}>{name}</span>
              {v.service_type ? <TypeChip kind={v.service_type} /> : null}
              {v.status && v.status !== 'active' ? <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--meta, #71717a)', textTransform: 'capitalize' }}>{v.status}</span> : null}
            </div>
            <Field label="Company" value={v.business_name} onSave={(x) => save('business_name', x)} disabled={!canWrite} />
            <Field label="Contact name" value={v.contact_name ?? ''} onSave={(x) => save('contact_name', x)} disabled={!canWrite} />
            <Field label="Title" value={v.title ?? ''} onSave={(x) => save('title', x)} disabled={!canWrite} placeholder="Escrow officer, loan officer…" />
            <Field label="Phone" value={pretty(v.phone)} onSave={(x) => save('phone', x)} disabled={!canWrite} />
            <Field label="Email" value={v.email ?? ''} onSave={(x) => save('email', x)} disabled={!canWrite} />
            <Pick label="Service type" value={v.service_type ?? ''} options={TYPES} onSave={(x) => void save('service_type', x)} disabled={!canWrite} />
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 72px', gap: '8px' }}>
              <Field label="City" value={v.city ?? ''} disabled={!canWrite} onSave={async (x) => {
                const r = await setVendorLocation(v.id, x, v.state);
                if (!r.ok) { V.showToast(r.message || 'That did not save.', 'error'); return false; }
                setV({ ...v, city: x.trim() || null }); V.reloadCrm(); return true;
              }} />
              <Field label="State" value={v.state ?? ''} disabled={!canWrite} onSave={async (x) => {
                const r = await setVendorLocation(v.id, v.city, x);
                if (!r.ok) { V.showToast(r.message || 'That did not save.', 'error'); return false; }
                const { data } = await supabase!.from('vendors').select(COLS).eq('id', v.id).maybeSingle();
                if (data) setV(data as unknown as VendorRow);
                V.reloadCrm(); return true;
              }} />
            </div>
            <Field label="Markets" value={(v.markets ?? []).join(', ')} onSave={(x) => save('markets', x)} disabled={!canWrite} placeholder="San Antonio, TX, Austin, TX" />
            <Field label="Tags" value={(v.tags ?? []).join(', ')} onSave={(x) => save('tags', x)} disabled={!canWrite} placeholder="Comma separated" />
            <Pick label="Status" value={v.status ?? 'active'} options={STATUSES} onSave={(x) => void save('status', x)} disabled={!canWrite} />
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: 'var(--ink-2, #27272a)' }}>
              <input type="checkbox" checked={!!v.is_main_poc} disabled={!canWrite} onChange={async (e) => {
                const on = e.target.checked;
                const r = await setVendorMainPoc(v.id, on);
                if (!r.ok) return V.showToast(r.message || 'That did not save.', 'error');
                setV({ ...v, is_main_poc: on }); V.reloadCrm();
              }} style={{ width: '14px', height: '14px', accentColor: 'var(--tx-mint, #0a8560)' }} />
              Main point of contact at {v.business_name}
            </label>
            <Field label="Notes" value={v.notes ?? ''} onSave={(x) => save('notes', x)} disabled={!canWrite} multiline />
          </div>
          {deals.length ? (
            <div className="rec-card" style={{ display: 'grid', gap: '6px' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--meta, #71717a)' }}>Deals · {deals.length}</div>
              {deals.map((d) => (
                <button key={d.id} type="button" className="dc2" onClick={() => V.openLandedDeal(dbId(d.dealId!), null)}
                  style={{ textAlign: 'left', border: 0, background: 'none', padding: '4px 0', cursor: 'pointer', fontSize: '12.5px', color: 'var(--ink-2, #27272a)' }}>
                  <span style={{ display: 'block', fontWeight: 600 }}>{d.title.replace(/^On deal · /, '')}</span>
                  <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)' }}>{d.body}</span>
                </button>
              ))}
            </div>
          ) : null}
        </aside>
        <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ActivityChips V={V} chips={chips} userMenu={null} order={order} onOrder={setOrder} />
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px' }}>
            {feed == null ? <p style={{ fontSize: '13px', color: 'var(--meta, #71717a)' }}>Loading activity…</p>
              : items.length ? <ActivityStream V={V} me={ids.userId} items={items} kind="vendor" vendor={{ id: v.id, name }} order={order} />
                : <p style={{ fontSize: '13px', color: 'var(--meta, #71717a)' }}>No calls, texts, emails or deals with {name} yet.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
