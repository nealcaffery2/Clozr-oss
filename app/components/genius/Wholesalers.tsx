// The wholesaler database: every LLC on an assignment in the Dispositions
// Drive, grouped into families (New Western and its shells), who each one
// sells to, and the end buyers we have signed with, each with the person,
// email and phone off the contract. The harvester that reads the Drive runs
// from here; Genius's "Wholesaler buyers" method reads this table.
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  type Entity, type EntityKind, type Family, type HarvestStatus, type WholesalerBook, addEntity, contractBuyers, entityToBuyer, families, harvestRun, harvestSave, harvestStatus, loadWholesalers, setKind, setParent,
} from '@/lib/wholesalers';
import { Badge, FAINT, GREEN, HAIR, ICON, INK, Icon, LINE, MUTED, PURPLE, PURPLE_TINT, Pill, RED, ago, btn, input, money, sectionLabel } from './parts';

type Props = { workspaceId: number; userId: string | null; canWrite: boolean; isMobile: boolean; onToast: (m: string) => void; onOpenBuyer?: (id: number) => void; onAdded?: () => void };

const KIND_LABEL: Record<EntityKind, string> = { wholesaler: 'Wholesaler', buyer: 'Buyer', both: 'Wholesaler & buyer', title: 'Title', unknown: 'Unknown' };
const KIND_TINT: Record<EntityKind, [string, string]> = { wholesaler: ['#9a3412', 'var(--tint-orange-2, #ffedd5)'], buyer: ['#15803d', 'var(--positive-soft, #dcfce7)'], both: ['#6d28d9', 'var(--tint-violet, #ede9fe)'], title: ['var(--ink-3, #3f3f46)', 'var(--surface-2, #f4f4f5)'], unknown: ['var(--muted, #52525b)', 'var(--surface-2, #f4f4f5)'] };
const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: `1px solid ${LINE}`, borderRadius: '14px', overflow: 'hidden' };

export function Wholesalers({ workspaceId, userId, canWrite, isMobile, onToast, onOpenBuyer, onAdded }: Props) {
  const [book, setBook] = useState<WholesalerBook | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<HarvestStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'wholesalers' | 'buyers' | 'deals'>('wholesalers');
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState<Record<number, boolean>>({});
  const [draft, setDraft] = useState<{ name: string; kind: EntityKind; state: string; contact: string; email: string; phone: string } | null>(null);
  const [folder, setFolder] = useState('');

  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);
  useEffect(() => {
    let live = true;
    void loadWholesalers(workspaceId).then((r) => { if (!live) return; if (r.ok) { setBook(r.data); setErr(null); } else setErr(r.message); });
    void harvestStatus(workspaceId).then((r) => { if (live && r.ok) setStatus(r.data); });
    return () => { live = false; };
  }, [workspaceId, tick]);

  const fams = useMemo(() => (book ? families(book) : []), [book]);
  const buyers = useMemo(() => (book ? contractBuyers(book) : []), [book]);
  const byId = useMemo(() => new Map((book?.entities ?? []).map((e) => [e.id, e])), [book]);
  const needle = q.trim().toLowerCase();
  const hit = (s: (string | null | undefined)[]) => !needle || s.some((x) => (x ?? '').toLowerCase().includes(needle));

  const run = async () => {
    setRunning(true);
    const r = await harvestRun(workspaceId);
    setRunning(false);
    if (!r.ok) return onToast(r.message);
    const d = r.data;
    onToast(d.error ? `Harvest stopped: ${d.error}` : `Read ${d.read} contract${d.read === 1 ? '' : 's'}, filed ${d.filed}${d.queued ? ` · ${d.queued} folders still queued, run again` : ' · the whole folder is read'}`);
    void reload();
    void harvestStatus(workspaceId).then((x) => { if (x.ok) setStatus(x.data); });
  };
  const saveFolder = async () => {
    const r = await harvestSave(workspaceId, folder.trim() || status?.default_folder || '');
    if (!r.ok) return onToast(r.message);
    onToast(`Reading ${r.data.root_name ?? 'that folder'} from now on`);
    void harvestStatus(workspaceId).then((x) => { if (x.ok) setStatus(x.data); });
  };
  const toBuyer = async (e: Entity) => {
    if (!book) return;
    setAdding((a) => ({ ...a, [e.id]: true }));
    const r = await entityToBuyer(workspaceId, e, book.deals, userId);
    setAdding((a) => ({ ...a, [e.id]: false }));
    if (!r.ok) return onToast(r.message);
    onToast(`${e.name} is in Buyer Prospects, labelled Contract`);
    onAdded?.();
    void reload();
  };
  const addOne = async () => {
    if (!draft) return;
    const r = await addEntity(workspaceId, { name: draft.name, kind: draft.kind, state: draft.state, contact_name: draft.contact, email: draft.email, phone: draft.phone });
    if (!r.ok) return onToast(r.message);
    setDraft(null); onToast('Added'); void reload();
  };

  const contact = (e: Entity) => [e.contact_name, e.email, e.phone].filter(Boolean).join(' · ');

  const harvestCard = (
    <div style={{ ...card, padding: '14px 16px', display: 'grid', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '13.5px', fontWeight: 700, color: INK }}>Contracts in the Dispositions Drive</span>
        {status ? <Badge color={status.drive_connected ? GREEN : RED} tint={status.drive_connected ? 'var(--mint-dim, #e7f8f1)' : 'var(--tint-red, #fef2f2)'}>{status.drive_connected ? `Drive connected · ${status.email}` : 'Drive not connected'}</Badge> : null}
        <span style={{ flex: 1 }} />
        {canWrite ? <button type="button" onClick={() => void run()} disabled={running || !status?.drive_connected} style={{ ...btn('purple', true), opacity: running || !status?.drive_connected ? 0.6 : 1 }}>{running ? 'Reading the Drive…' : status?.config?.last_run_at ? 'Read new contracts now' : 'Read the Drive now'}</button> : null}
      </div>
      <div style={{ fontSize: '12.5px', color: MUTED, lineHeight: 1.5 }}>
        Every assignment PDF under the folder is read once: the wholesaler on one side, the buyer on the other, the person who signed with their email and phone, the price, the fee and the closer. It runs four times a day on its own; this button runs a pass now.
        {status?.config ? <> Last run {status.config.last_run_at ? ago(status.config.last_run_at) : 'never'} · {status.config.contracts_read} contracts read · {status.config.files_seen.toLocaleString('en-US')} files seen{status.config.queued ? ` · ${status.config.queued} folders still to walk` : status.config.done_at ? ' · the whole folder is read' : ''}.</> : null}
        {status?.config?.last_error ? <span style={{ color: RED }}> {status.config.last_error}</span> : null}
        {!status?.drive_connected ? <span style={{ color: RED }}> Connect Drive first: Settings → Google → Connect Drive (read-only).</span> : null}
      </div>
      {canWrite && status?.drive_connected ? (
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={status.config?.root_name ? `Reading "${status.config.root_name}" · paste another folder link to change` : 'Paste the Drive folder link (the Dispositions folder is the default)'} style={{ ...input, height: '30px', flex: 1, minWidth: '240px', fontSize: '12px' }} />
          <button type="button" onClick={() => void saveFolder()} style={btn('ghost', true)}>Use this folder</button>
        </div>
      ) : null}
    </div>
  );

  const familyRow = (f: Family) => {
    const isOpen = open === f.root.id;
    const [c, tint] = KIND_TINT[f.root.kind];
    return (
      <div key={f.root.id} style={{ borderTop: `1px solid ${HAIR}` }}>
        <div role="button" tabIndex={0} onClick={() => setOpen(isOpen ? null : f.root.id)} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(isOpen ? null : f.root.id); }}
          style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', cursor: 'pointer', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '13px', fontWeight: 650, color: INK }}>{f.root.name}</span>
          <Badge color={c} tint={tint}>{KIND_LABEL[f.root.kind]}</Badge>
          {f.aliases.length ? <Badge title={f.aliases.map((a) => a.name).join(', ')}>{f.aliases.length} LLC{f.aliases.length === 1 ? '' : 's'}</Badge> : null}
          {f.states.length ? <span style={{ fontSize: '11.5px', color: MUTED }}>{f.states.join(' · ')}</span> : null}
          <span style={{ marginLeft: 'auto', fontSize: '12px', color: MUTED, whiteSpace: 'nowrap' }}>{f.deals} deal{f.deals === 1 ? '' : 's'} · {f.buyers.length} buyer{f.buyers.length === 1 ? '' : 's'}</span>
          <Icon d={isOpen ? ICON.chevronUp : ICON.chevronDown} size={13} />
        </div>
        {isOpen ? (
          <div style={{ padding: '0 14px 14px', display: 'grid', gap: '12px', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
            <div>
              <div style={sectionLabel}>The entities</div>
              {[f.root, ...f.aliases].map((e) => (
                <div key={e.id} style={{ fontSize: '12px', padding: '4px 0', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: INK, fontWeight: e.id === f.root.id ? 650 : 500 }}>{e.name}</span>
                  {contact(e) ? <span style={{ color: MUTED }}>{contact(e)}</span> : null}
                  {canWrite && e.id !== f.root.id ? <button type="button" onClick={() => void setParent(e.id, null).then(reload)} style={{ ...btn('ghost', true), marginLeft: 'auto' }}>Not an alias</button> : null}
                </div>
              ))}
              {canWrite ? (
                <select onChange={(e) => { const id = Number(e.target.value); if (id) void setParent(id, f.root.id).then(reload); e.target.value = ''; }} defaultValue="" aria-label={`Add an alias of ${f.root.name}`} style={{ ...input, height: '28px', fontSize: '11.5px', marginTop: '6px', maxWidth: '100%' }}>
                  <option value="">Add an LLC as an alias…</option>
                  {(book?.entities ?? []).filter((e) => e.id !== f.root.id && !e.parent_id && !f.aliases.some((a) => a.id === e.id)).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              ) : null}
              {canWrite ? (
                <div style={{ marginTop: '6px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {(['wholesaler', 'buyer', 'both'] as EntityKind[]).map((k) => <Pill key={k} on={f.root.kind === k} onClick={() => void setKind(f.root.id, k).then(reload)}>{KIND_LABEL[k]}</Pill>)}
                </div>
              ) : null}
            </div>
            <div>
              <div style={sectionLabel}>Who they sell to</div>
              {f.buyers.length === 0 ? <div style={{ fontSize: '12px', color: FAINT }}>No buyer on a contract or deed yet. Run Genius with the Wholesaler buyers method near one of their houses to read the deed index.</div> : f.buyers.slice(0, 15).map((b) => (
                <div key={b.entity.id} style={{ fontSize: '12px', padding: '4px 0', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: INK, fontWeight: 600 }}>{b.entity.name}</span>
                  <span style={{ color: MUTED }}>{b.deals} deal{b.deals === 1 ? '' : 's'}{b.last_deal ? ` · last ${b.last_deal.slice(0, 7)}` : ''}{b.volume ? ` · ${money(b.volume)}` : ''}</span>
                  {contact(b.entity) ? <span style={{ color: FAINT }}>{contact(b.entity)}</span> : null}
                  {b.entity.buyer_id ? <button type="button" onClick={() => onOpenBuyer?.(b.entity.buyer_id!)} style={{ ...btn('ghost', true), color: GREEN, marginLeft: 'auto' }}>In buyers</button>
                    : canWrite ? <button type="button" disabled={!!adding[b.entity.id]} onClick={() => void toBuyer(b.entity)} style={{ ...btn('solid', true), marginLeft: 'auto' }}>Add to buyers</button> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const buyersTab = (
    <div>
      {buyers.length === 0 ? <div style={{ padding: '18px 14px', fontSize: '12.5px', color: FAINT }}>No end buyers on file yet. Read the Drive, or run Genius with the Wholesaler buyers method.</div> : buyers.filter((b) => hit([b.entity.name, b.entity.contact_name, b.entity.email, ...b.wholesalers])).map((b) => (
        <div key={b.entity.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderTop: `1px solid ${HAIR}`, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '13px', fontWeight: 650, color: INK }}>{b.entity.name}</span>
              <Badge color="var(--tx-mint-deep, #08694c)" tint={PURPLE_TINT}>Contract</Badge>
              <span style={{ fontSize: '12px', color: MUTED }}>{b.deals.length} deal{b.deals.length === 1 ? '' : 's'} from {b.wholesalers.join(', ') || 'us'}</span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--ink-3, #3f3f46)', marginTop: '2px' }}>{contact(b.entity) || [b.deals[0]?.assignee_person, b.deals[0]?.assignee_email, b.deals[0]?.assignee_phone].filter(Boolean).join(' · ') || 'No contact on the contract'}</div>
            <div style={{ fontSize: '11.5px', color: FAINT, marginTop: '2px' }}>{b.deals.slice(0, 3).map((d) => `${d.property_address ?? '?'}${d.city ? `, ${d.city}` : ''}${d.state ? ` ${d.state}` : ''}${d.total_price ? ` · ${money(d.total_price)}` : ''}${d.closing_date ? ` · ${d.closing_date.slice(0, 7)}` : ''}`).join(' | ')}</div>
          </div>
          {b.entity.buyer_id ? <button type="button" onClick={() => onOpenBuyer?.(b.entity.buyer_id!)} style={{ ...btn('ghost', true), color: GREEN }}>In buyers</button>
            : canWrite ? <button type="button" disabled={!!adding[b.entity.id]} onClick={() => void toBuyer(b.entity)} style={btn('solid', true)}>{adding[b.entity.id] ? 'Adding…' : 'Add to buyers'}</button> : null}
        </div>
      ))}
    </div>
  );

  const dealsTab = (
    <div>
      {(book?.deals ?? []).filter((d) => hit([d.assignor_name, d.assignee_name, d.property_address, d.city, d.state, d.title_company])).slice(0, 300).map((d) => (
        <div key={d.id} style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) 150px', gap: '6px 12px', padding: '9px 14px', borderTop: `1px solid ${HAIR}`, fontSize: '12px', alignItems: 'center' }}>
          <div><span style={{ color: INK, fontWeight: 600 }}>{d.property_address ?? '?'}</span><span style={{ color: FAINT }}>{d.city ? `, ${d.city}` : ''}{d.state ? ` ${d.state}` : ''}</span> <Badge>{d.leg === 'deed' ? 'Deed' : d.leg}</Badge></div>
          <div style={{ color: 'var(--ink-3, #3f3f46)' }}><span style={{ color: FAINT }}>From </span>{d.assignor_name ?? '?'}</div>
          <div style={{ color: 'var(--ink-3, #3f3f46)' }}><span style={{ color: FAINT }}>To </span>{d.assignee_name ?? '?'}{d.assignee_person ? <span style={{ color: FAINT }}> · {d.assignee_person}</span> : null}</div>
          <div style={{ color: MUTED, whiteSpace: 'nowrap' }}>{d.total_price ? money(d.total_price) : d.purchase_price ? money(d.purchase_price) : '—'}{d.assignment_fee ? ` (+${money(d.assignment_fee)})` : ''}{d.closing_date ? ` · ${d.closing_date.slice(0, 7)}` : ''}{d.source_url ? <> · <a href={d.source_url} target="_blank" rel="noreferrer" style={{ color: PURPLE }}>file</a></> : null}</div>
        </div>
      ))}
      {book && !book.deals.length ? <div style={{ padding: '18px 14px', fontSize: '12.5px', color: FAINT }}>No contracts read yet.</div> : null}
    </div>
  );

  return (
    <div data-gx style={{ display: 'grid', gap: '14px' }}>
      {harvestCard}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: `1px solid ${HAIR}`, flexWrap: 'wrap', background: 'var(--band)' }}>
          {([['wholesalers', `Wholesalers · ${fams.length}`], ['buyers', `End buyers · ${buyers.length}`], ['deals', `Contracts · ${book?.deals.length ?? 0}`]] as const).map(([k, l]) => <Pill key={k} on={tab === k} onClick={() => setTab(k)}>{l}</Pill>)}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name, a city, a person" aria-label="Search" style={{ ...input, height: '28px', fontSize: '12px', marginLeft: 'auto', width: isMobile ? '100%' : '240px' }} />
          {canWrite ? <button type="button" onClick={() => setDraft(draft ? null : { name: '', kind: 'wholesaler', state: '', contact: '', email: '', phone: '' })} style={btn('ghost', true)}>{draft ? 'Cancel' : 'Add a wholesaler'}</button> : null}
        </div>
        {draft ? (
          <div style={{ display: 'flex', gap: '6px', padding: '10px 14px', flexWrap: 'wrap', borderBottom: `1px solid ${HAIR}`, background: 'var(--c-genius-soft, #f0faf5)' }}>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Company (Goldline Investments LLC)" style={{ ...input, height: '30px', flex: 2, minWidth: '200px' }} />
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as EntityKind })} style={{ ...input, height: '30px' }}>{(['wholesaler', 'buyer', 'both'] as EntityKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
            <input value={draft.state} onChange={(e) => setDraft({ ...draft, state: e.target.value.toUpperCase().slice(0, 2) })} placeholder="TX" style={{ ...input, height: '30px', width: '56px' }} />
            <input value={draft.contact} onChange={(e) => setDraft({ ...draft, contact: e.target.value })} placeholder="Person" style={{ ...input, height: '30px', flex: 1, minWidth: '120px' }} />
            <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="Email" style={{ ...input, height: '30px', flex: 1, minWidth: '140px' }} />
            <input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} placeholder="Phone" style={{ ...input, height: '30px', width: '130px' }} />
            <button type="button" onClick={() => void addOne()} disabled={!draft.name.trim()} style={btn('purple', true)}>Save</button>
          </div>
        ) : null}
        {err ? <div style={{ padding: '14px', fontSize: '12.5px', color: RED }}>{err}</div> : !book ? <div style={{ padding: '14px', fontSize: '12.5px', color: FAINT }}>Loading…</div>
          : tab === 'wholesalers' ? (fams.filter((f) => hit([f.root.name, ...f.aliases.map((a) => a.name), ...f.buyers.map((b) => b.entity.name)])).length === 0
            ? <div style={{ padding: '18px 14px', fontSize: '12.5px', color: FAINT }}>No wholesalers yet. Read the Drive, or add one.</div>
            : fams.filter((f) => hit([f.root.name, ...f.aliases.map((a) => a.name), ...f.buyers.map((b) => b.entity.name)])).map(familyRow))
          : tab === 'buyers' ? buyersTab : dealsTab}
      </div>
      <div style={{ fontSize: '11.5px', color: FAINT, lineHeight: 1.5 }}>
        An alias is an LLC a wholesaler trades through (Goldline Investments LLC and Soup to Nuts LLC are New Western). Genius counts a family&apos;s deals together when it ranks their buyers. {byId.size.toLocaleString('en-US')} entities on file.
      </div>
    </div>
  );
}
