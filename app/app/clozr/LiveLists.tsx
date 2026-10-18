// The raw Buyers and Vendors tables, restyled to sit inside the CLOZR shell
// (⌘K "go live database"). Sellers are not here: People and the seller record
// cover them, with real stages, paging and archive instead of a delete.
'use client';

import type { Session } from '@supabase/supabase-js';
import React, { useCallback, useEffect, useState } from 'react';
import type { Buyer, Vendor } from '@/lib/database.types';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { normalizeMarkets, splitMarketCell } from '@/lib/place-names';
import { Mark } from '@/components/ds/mark';
import { useConfirm } from '@/components/ds/Confirm';
import { useDebouncedText } from '@/components/ds/useDebouncedText';
import { archiveBuyers, archiveVendors, createBuyer, quickBuyerProfile, updateBuyer } from '@/lib/crm-write';
import { normalizeBuyBox } from '@/lib/buyer-profile';
import { BULK_BUYER_SOURCE } from '@/lib/prospect-lists';
import { formatDollars, parseDollars } from '@/lib/money';

/** Rows a page. 142,878 buyer rows used to come back as the first 1,000. */
const PAGE = 100;

const LIST_SECTIONS = ['Buyers', 'Vendors'] as const;
type ListSection = (typeof LIST_SECTIONS)[number];
type ListRecord = Buyer | Vendor;

type FormField = {
  key: string;
  label: string;
  placeholder: string;
  type?: string;
  options?: { value: string; label: string }[];
  wide?: boolean;
};

const fieldConfig: Record<ListSection, FormField[]> = {
  Buyers: [
    { key: 'name', label: 'Buyer name', placeholder: 'Jordan Lee' },
    { key: 'company', label: 'Company', placeholder: 'Northstar Homes' },
    { key: 'email', label: 'Email', placeholder: 'jordan@company.com', type: 'email' },
    { key: 'phone', label: 'Phone', placeholder: '(555) 000-0000', type: 'tel' },
    { key: 'markets', label: 'Markets', placeholder: 'Dallas, Fort Worth' },
    { key: 'max_purchase_price', label: 'Maximum purchase price', placeholder: '350k' },
    { key: 'status', label: 'Status', placeholder: '', options: [{ value: 'active', label: 'Active' }, { value: 'vip', label: 'VIP' }, { value: 'inactive', label: 'Inactive' }] },
    { key: 'notes', label: 'Notes', placeholder: 'Preferences, timing, and context', wide: true },
  ],
  Vendors: [
    { key: 'business_name', label: 'Business name', placeholder: 'Clearview Title' },
    { key: 'contact_name', label: 'Contact name', placeholder: 'Morgan Ellis' },
    { key: 'email', label: 'Email', placeholder: 'morgan@company.com', type: 'email' },
    { key: 'phone', label: 'Phone', placeholder: '(555) 000-0000', type: 'tel' },
    { key: 'service_type', label: 'Service type', placeholder: 'Title, inspection, contractor' },
    { key: 'markets', label: 'Markets', placeholder: 'Dallas, Fort Worth' },
    { key: 'status', label: 'Status', placeholder: '', options: [{ value: 'active', label: 'Active' }, { value: 'preferred', label: 'Preferred' }, { value: 'inactive', label: 'Inactive' }] },
    { key: 'notes', label: 'Notes', placeholder: 'Rates, availability, and context', wide: true },
  ],
};

const EMPTY: Record<ListSection, Record<string, string>> = {
  Buyers: { name: '', company: '', email: '', phone: '', markets: '', max_purchase_price: '', status: 'active', notes: '' },
  Vendors: { business_name: '', contact_name: '', email: '', phone: '', service_type: '', markets: '', status: 'active', notes: '' },
};

const STAGE_COLORS: Record<string, string> = {
  active: '#16a34a', vip: '#ff7a45', preferred: '#0A8560', inactive: 'var(--meta, #71717a)',
};

function isListSection(value: string): value is ListSection {
  return (LIST_SECTIONS as readonly string[]).includes(value);
}

function money(value: number | null) {
  return value === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function titleCase(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const headings: Record<ListSection, string[]> = {
  Buyers: ['Buyer', 'Contact', 'Markets', 'Buy box', 'Max price', 'Status'],
  Vendors: ['Business', 'Contact', 'Service', 'Markets', 'Status'],
};

// ---- shared inline styles, matching the CLOZR People screen -----------------

const th: React.CSSProperties = {
  position: 'sticky', top: 0, background: 'var(--canvas, #fafafa)', borderBottom: '1px solid var(--divider, #e4e4e7)',
  padding: '0 12px', height: 36, textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--meta, #71717a)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '0 12px', height: 44, borderBottom: '1px solid var(--divider-2, #f0f0f1)', whiteSpace: 'nowrap' };
const btn: React.CSSProperties = {
  height: 30, padding: '0 11px', borderRadius: 8, border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)',
  fontSize: 12.5, fontWeight: 500, cursor: 'pointer', color: 'var(--ink, #18181b)',
};
const btnDark: React.CSSProperties = {
  height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid var(--ink, #18181b)', background: 'var(--ink, #18181b)',
  color: 'var(--surface, #fff)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
};
const field: React.CSSProperties = {
  width: '100%', height: 34, padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: 8,
  fontSize: 13, outline: 0, background: 'var(--canvas, #fafafa)', color: 'var(--ink, #18181b)', fontFamily: 'inherit',
};

function StatusMarker({ value }: { value: string }) {
  const color = STAGE_COLORS[value] || 'var(--meta, #71717a)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11.5, fontWeight: 600, color }}>
      <Mark label={titleCase(value)} />
      {titleCase(value)}
    </span>
  );
}

export function LiveLists({
  section,
  onSection,
  onToast,
  onChanged,
  canSeeBuyers: allowBuyers = true,
}: {
  section: string;
  onSection: (section: string) => void;
  onToast: (msg: string) => void;
  /** The CRM re-reads after a save, so every screen (and the text composer) has the new values. */
  onChanged?: () => void;
  /** Acquisitions must not open the Buyers tab (RLS already empties the table). */
  canSeeBuyers?: boolean;
}) {
  const sections: readonly ListSection[] = allowBuyers ? LIST_SECTIONS : (['Vendors'] as const);
  // An old link to the Sellers tab lands on the first tab this role has.
  const current: ListSection = (sections as readonly string[]).includes(section) && isListSection(section)
    ? section
    : sections[0];
  const { confirm } = useConfirm();

  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  // The signed-in app session already chose the workspace. A second
  // membership query here used to take whichever row came back first.
  const workspaceId = useSession().workspace?.id ?? null;
  const [records, setRecords] = useState<ListRecord[]>([]);
  const [recordsFor, setRecordsFor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchText, onSearchText] = useDebouncedText(search, setSearch, 300);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<Record<string, string>>(EMPTY.Vendors);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setAuthReady(true);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // Drop the previous workspace's rows before the next fetch paints them.
  if (recordsFor !== workspaceId) {
    setRecordsFor(workspaceId);
    setRecords([]);
    setError('');
    setLoading(!!session && workspaceId != null);
  }

  const loadRecords = useCallback(async (which: ListSection, isStale: () => boolean = () => false) => {
    if (!supabase || !workspaceId) return;
    setLoading(true);
    setError('');
    // One page, searched in the database: the workspace's own buyers (not the
    // free-agent corpus, not archived), or its live vendors.
    const needle = search.trim().replace(/[%_\\,()]/g, ' ').trim();
    const like = (cols: string[]) => cols.map((c) => `${c}.ilike.%${needle}%`).join(',');
    let q = which === 'Buyers'
      ? supabase.from('buyers').select('*', { count: 'exact' }).eq('workspace_id', workspaceId).is('archived_at' as never, null)
        .or(`source.is.null,source.neq.${BULK_BUYER_SOURCE}`)
      : supabase.from('vendors').select('*', { count: 'exact' }).eq('workspace_id', workspaceId).neq('status', 'archived');
    if (needle) q = q.or(like(which === 'Buyers' ? ['name', 'company', 'email', 'phone'] : ['business_name', 'contact_name', 'email', 'phone', 'service_type']));
    const { data, error: err, count } = await q.order('updated_at', { ascending: false }).order('id', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    // A newer request (or an unmount) supersedes this one — drop the response.
    if (isStale()) return;
    if (err) setError(err.message);
    setRecords((data ?? []) as ListRecord[]);
    setTotal(count ?? null);
    setLoading(false);
  }, [workspaceId, search, page]);

  useEffect(() => {
    if (!session || !workspaceId) return;
    let cancelled = false;
    // Kicked off off the render pass so the first setState isn't synchronous.
    const timer = window.setTimeout(() => void loadRecords(current, () => cancelled), 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [current, loadRecords, session, workspaceId]);

  const visible = records;
  const pages = total == null ? 1 : Math.max(1, Math.ceil(total / PAGE));

  function openNew() {
    if (!session) { setAuthMode('signin'); setAuthOpen(true); return; }
    setEditingId(null);
    setForm(EMPTY[current]);
    setModalOpen(true);
  }

  function openEdit(record: ListRecord) {
    const next = { ...EMPTY[current] };
    Object.keys(next).forEach((key) => {
      const value = record[key as keyof ListRecord];
      next[key] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    });
    if (current === 'Buyers') {
      const b = record as Buyer;
      next.status = b.vip ? 'vip' : /inactive/i.test(b.status) ? 'inactive' : 'active';
      next.max_purchase_price = b.max_purchase_price == null ? '' : formatDollars(Number(b.max_purchase_price));
    }
    setEditingId(record.id);
    setForm(next);
    setModalOpen(true);
  }

  async function saveRecord(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !workspaceId) return;
    setSaving(true);
    setError('');

    const blankToNull = (v: string) => v.trim() || null;
    // "DFW, Houston" is two markets, "San Antonio, TX" one; each is stored in its one spelling (lib/place-names).
    const splitMarkets = (v: string) => normalizeMarkets(splitMarketCell(v));
    let err: { message: string } | null = null;

    if (current === 'Buyers') {
      // The same writers as the Buyers screen: the price reads through
      // lib/money, markets and the price land in the buy box (criteria) the
      // matcher reads, and the stage moves only when Active was switched.
      const price = parseDollars(form.max_purchase_price);
      if (price.error) { setSaving(false); setError('Maximum purchase price: ' + price.error); return; }
      const was = editingId ? (records.find((r) => r.id === editingId) as Buyer | undefined) : undefined;
      const box = normalizeBuyBox(was?.criteria ?? {});
      const prefs = (quickBuyerProfile({ name: '', markets: form.markets }).criteria as { location_prefs: unknown[] }).location_prefs;
      const criteria = { ...box, location_prefs: prefs, price: { ...box.price, max: price.value } };
      const profile = {
        name: form.name, company: blankToNull(form.company), email: blankToNull(form.email), phone: blankToNull(form.phone),
        notes: blankToNull(form.notes), criteria, vip: form.status === 'vip', active: form.status !== 'inactive',
      };
      const r = editingId ? await updateBuyer(workspaceId, editingId, profile) : await createBuyer(workspaceId, { ...profile, source: 'Manual' }, null);
      if (!r.ok) err = { message: r.message || 'That buyer did not save.' };
    } else {
      const payload = {
        business_name: form.business_name.trim(), contact_name: blankToNull(form.contact_name),
        email: blankToNull(form.email), phone: blankToNull(form.phone), service_type: blankToNull(form.service_type),
        markets: splitMarkets(form.markets), status: form.status, notes: blankToNull(form.notes),
      };
      ({ error: err } = editingId
        ? await supabase.from('vendors').update(payload).eq('id', editingId)
        : await supabase.from('vendors').insert({ ...payload, workspace_id: workspaceId }));
    }

    setSaving(false);
    if (err) { setError(err.message); return; }
    setModalOpen(false);
    onToast(`${current.slice(0, -1)} saved`);
    onChanged?.();
    await loadRecords(current);
  }

  async function deleteRecord(id: number) {
    if (!supabase) return;
    const kind = current === 'Buyers' ? 'buyer' : 'vendor';
    const ok = await confirm({ title: `Archive this ${kind}?`, body: `It leaves every list. Nothing is deleted; Account restores an archived ${kind}.`, confirmLabel: `Archive ${kind}`, tone: 'danger' });
    if (!ok) return;
    const r = current === 'Buyers' ? await archiveBuyers([String(id)]) : await archiveVendors([String(id)]);
    if (!r.ok) setError(r.message || 'That did not archive.');
    else { onToast(`${kind === 'buyer' ? 'Buyer' : 'Vendor'} archived`); onChanged?.(); await loadRecords(current); }
  }

  async function handleAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setAuthBusy(true);
    setAuthMessage('');

    if (authMode === 'signin') {
      const { error: err } = await supabase.auth.signInWithPassword({ email: authEmail, password: authPassword });
      setAuthBusy(false);
      if (err) setAuthMessage(err.message);
      else setAuthOpen(false);
      return;
    }
    const { data, error: err } = await supabase.auth.signUp({
      email: authEmail, password: authPassword,
      options: { data: { display_name: authEmail.split('@')[0] } },
    });
    setAuthBusy(false);
    if (err) setAuthMessage(err.message);
    else if (!data.session) setAuthMessage('Check your email to confirm your account, then sign in.');
    else setAuthOpen(false);
  }

  return (
    <section
      data-screen-label="Live database"
      style={{ flex: 1, minWidth: 0, display: 'flex', background: 'var(--canvas, #fafafa)' }}
    >
      <aside style={{ width: 228, flex: 'none', borderRight: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', overflow: 'auto', padding: '14px 10px' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--meta, #71717a)', padding: '0 8px 8px' }}>
          Live database
        </div>
        {sections.map((item) => (
          <button
            key={item}
            onClick={() => { onSection(item); setSearch(''); setPage(0); }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: 30,
              padding: '0 8px', border: 0, borderRadius: 7, cursor: 'pointer', fontSize: 13, textAlign: 'left',
              background: current === item ? 'var(--mint-dim, #e7f8f1)' : 'transparent',
              color: current === item ? '#0A8560' : 'var(--ink-2, #27272a)',
              fontWeight: current === item ? 600 : 500,
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <span style={{ color: 'var(--tx-mint, #0a8560)', display: 'inline-flex' }}><Mark label={item} size={12} /></span>
              {item}
            </span>
            {current === item && total != null && <span style={{ fontSize: 11.5, color: 'var(--meta, #71717a)', fontVariantNumeric: 'tabular-nums' }}>{total.toLocaleString('en-US')}</span>}
          </button>
        ))}
        <div style={{ margin: '16px 8px 0', paddingTop: 12, borderTop: '1px solid var(--divider-2, #f0f0f1)', fontSize: 11.5, color: 'var(--subtle, #a1a1aa)', lineHeight: 1.5 }}>
          {supabase ? 'Secured by Supabase · scoped to your workspace' : 'Supabase is not configured — set NEXT_PUBLIC_SUPABASE_URL to enable.'}
        </div>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <div data-head style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)' }}>
          <h1 style={{ margin: '0 8px 0 0', fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em' }}>{current}</h1>
          <span role="status" style={{ fontSize: 12, color: 'var(--meta, #71717a)', fontVariantNumeric: 'tabular-nums' }}>{(total ?? visible.length).toLocaleString('en-US')} records</span>
          {session && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 700, color: '#16a34a' }}>
              <Mark label="Live" />
              Live
            </span>
          )}
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: 8, background: 'var(--canvas, #fafafa)', width: 220 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--meta, #71717a)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={searchText}
              aria-label={`Search ${current.toLowerCase()}`}
              onChange={(e) => { setPage(0); onSearchText(e.target.value); }}
              placeholder={`Search ${current.toLowerCase()}`}
              style={{ border: 0, background: 'none', outline: 0, fontSize: 13, width: '100%', minWidth: 0, color: 'var(--ink, #18181b)' }}
            />
          </div>
          <button onClick={openNew} style={btnDark}>+ Add {current.slice(0, -1).toLowerCase()}</button>
        </div>

        {error && (
          <div style={{ padding: '8px 16px', background: 'var(--negative-soft, #fee2e2)', color: 'var(--tx-red-deep, #991b1b)', fontSize: 12.5, borderBottom: '1px solid var(--tint-red-2, #fecaca)' }}>{error}</div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: 'var(--surface, #fff)' }}>
          {!authReady ? (
            <Empty title="Connecting securely…" body="Checking your Supabase session." />
          ) : !session ? (
            <Empty
              title={`Sign in to open your ${current.toLowerCase()} list`}
              body="CLOZR keeps every live record inside your secured workspace. Every other screen runs on sample data."
              action={<button onClick={() => { setAuthMode('signin'); setAuthOpen(true); }} style={btnDark}>Sign in to continue</button>}
            />
          ) : loading ? (
            <Empty title={`Loading ${current.toLowerCase()}…`} body="Fetching from Supabase." />
          ) : visible.length === 0 ? (
            <Empty
              title={`No ${current.toLowerCase()} found`}
              body="Add one now, or clear your search to see everything."
              action={<button onClick={openNew} style={btnDark}>Add {current.slice(0, -1).toLowerCase()}</button>}
            />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12.5 }}>
              <thead>
                <tr>
                  {headings[current].map((h) => <th key={h} style={th}>{h}</th>)}
                  <th style={{ ...th, textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {visible.map((record) => (
                  <Row key={record.id} section={current} record={record} onEdit={() => openEdit(record)} onDelete={() => void deleteRecord(record.id)} />
                ))}
              </tbody>
            </table>
          )}
          {session && pages > 1 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', fontSize: 12.5, color: 'var(--meta, #71717a)' }}>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>Page {page + 1} of {pages.toLocaleString('en-US')}</span>
              <button type="button" style={btn} disabled={page === 0 || loading} onClick={() => setPage((n) => Math.max(0, n - 1))}>Previous</button>
              <button type="button" style={btn} disabled={page + 1 >= pages || loading} onClick={() => setPage((n) => n + 1)}>Next</button>
            </div>
          ) : null}
        </div>
      </div>

      {authOpen && (
        <Modal onClose={() => setAuthOpen(false)} label="CLOZR account">
          <div style={{ fontSize: 11.5, color: 'var(--meta, #71717a)', fontWeight: 600 }}>Secure workspace</div>
          <h2 style={{ margin: '6px 0 4px', fontSize: 20, fontWeight: 700, letterSpacing: '-0.03em' }}>
            {authMode === 'signin' ? 'Sign in to CLOZR' : 'Create your CLOZR account'}
          </h2>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--meta, #71717a)' }}>Your buyers and vendors stay private to your workspace.</p>
          <form onSubmit={(e) => void handleAuth(e)} style={{ marginTop: 16, display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={{ fontSize: 11.5, color: 'var(--meta, #71717a)', fontWeight: 500 }}>Email</span>
              <input type="email" required value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} placeholder="you@company.com" style={field} />
            </label>
            <label style={{ display: 'grid', gap: 5 }}>
              <span style={{ fontSize: 11.5, color: 'var(--meta, #71717a)', fontWeight: 500 }}>Password</span>
              <input type="password" required minLength={6} value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} placeholder="At least 6 characters" style={field} />
            </label>
            {authMessage && <p style={{ margin: 0, fontSize: 12.5, color: 'var(--tx-hot, #dc2626)' }}>{authMessage}</p>}
            <button style={{ ...btnDark, height: 36 }} disabled={authBusy}>{authBusy ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}</button>
          </form>
          <button
            onClick={() => { setAuthMode((m) => (m === 'signin' ? 'signup' : 'signin')); setAuthMessage(''); }}
            style={{ marginTop: 12, background: 'none', border: 0, color: 'var(--tx-mint, #0a8560)', fontSize: 12.5, cursor: 'pointer', padding: 0, fontWeight: 500 }}
          >
            {authMode === 'signin' ? 'New to CLOZR? Create an account' : 'Already have an account? Sign in'}
          </button>
        </Modal>
      )}

      {modalOpen && (
        <Modal onClose={() => setModalOpen(false)} label={`${editingId ? 'Edit' : 'Add'} ${current.slice(0, -1)}`} wide>
          <div style={{ fontSize: 11.5, color: 'var(--meta, #71717a)', fontWeight: 600 }}>{current} database</div>
          <h2 style={{ margin: '6px 0 16px', fontSize: 20, fontWeight: 700, letterSpacing: '-0.03em' }}>
            {editingId ? 'Edit record' : `Add ${current.slice(0, -1).toLowerCase()}`}
          </h2>
          <form onSubmit={(e) => void saveRecord(e)}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {fieldConfig[current].map((f) => (
                <label key={f.key} style={{ display: 'grid', gap: 5, gridColumn: f.wide ? '1 / -1' : undefined }}>
                  <span style={{ fontSize: 11.5, color: 'var(--meta, #71717a)', fontWeight: 500 }}>{f.label}</span>
                  {f.options ? (
                    <select value={form[f.key]} onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))} style={field}>
                      {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : f.key === 'notes' || f.key === 'motivation' || f.key === 'buy_box' ? (
                    <textarea
                      value={form[f.key]}
                      onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      rows={3}
                      style={{ ...field, height: 'auto', padding: '8px 10px', resize: 'vertical', lineHeight: 1.5 }}
                    />
                  ) : (
                    <input
                      type={f.type ?? 'text'}
                      required={f.key === 'name' || f.key === 'business_name'}
                      min="0"
                      value={form[f.key]}
                      onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      style={field}
                    />
                  )}
                </label>
              ))}
            </div>
            {error && <p style={{ margin: '10px 0 0', fontSize: 12.5, color: 'var(--tx-hot, #dc2626)' }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button type="button" onClick={() => setModalOpen(false)} style={{ ...btn, height: 32 }}>Cancel</button>
              <button style={btnDark} disabled={saving}>{saving ? 'Saving…' : 'Save record'}</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: '80px 20px', textAlign: 'center' }}>
      <div style={{ maxWidth: 420 }}>
        <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-0.02em' }}>{title}</div>
        <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--meta, #71717a)', lineHeight: 1.5 }}>{body}</p>
        {action && <div style={{ marginTop: 14 }}>{action}</div>}
      </div>
    </div>
  );
}

function Modal({ children, onClose, label, wide }: { children: React.ReactNode; onClose: () => void; label: string; wide?: boolean }) {
  return (
    <div
      role="presentation"
      onMouseDown={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,20,25,.4)', display: 'grid', placeItems: 'center', zIndex: 70 }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: wide ? 640 : 400, maxWidth: 'calc(100vw - 40px)', maxHeight: 'calc(100vh - 80px)', overflow: 'auto',
          background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: 14, padding: 22,
          boxShadow: '0 2px 6px rgba(18,20,28,0.06), 0 28px 60px -24px rgba(18,22,45,0.26)',
        }}
      >
        {children}
      </section>
    </div>
  );
}

function Row({ section, record, onEdit, onDelete }: { section: ListSection; record: ListRecord; onEdit: () => void; onDelete: () => void }) {
  const actions = (
    <td style={{ ...td, textAlign: 'right' }}>
      <button onClick={onEdit} style={{ ...btn, height: 26, padding: '0 9px', fontSize: 12 }}>Edit</button>
      <button onClick={onDelete} style={{ ...btn, height: 26, padding: '0 9px', marginLeft: 4, fontSize: 12, color: 'var(--tx-red, #b91c1c)' }}>Archive</button>
    </td>
  );

  if (section === 'Buyers') {
    const b = record as Buyer;
    return (
      <tr>
        <td style={td}><strong style={{ fontWeight: 600 }}>{b.name}</strong><div style={{ fontSize: 11, color: 'var(--subtle, #a1a1aa)' }}>{b.company || 'Independent buyer'}</div></td>
        <td style={td}><div>{b.email || 'No email'}</div><div style={{ fontSize: 11, color: 'var(--subtle, #a1a1aa)' }}>{b.phone || 'No phone'}</div></td>
        <td style={td}>{b.markets.join(', ') || '—'}</td>
        <td style={{ ...td, whiteSpace: 'normal', maxWidth: 240 }}>{b.buy_box || '—'}</td>
        <td style={td}>{money(b.max_purchase_price)}</td>
        <td style={td}><StatusMarker value={b.status} /></td>
        {actions}
      </tr>
    );
  }
  const v = record as Vendor;
  return (
    <tr>
      <td style={td}><strong style={{ fontWeight: 600 }}>{v.business_name}</strong><div style={{ fontSize: 11, color: 'var(--subtle, #a1a1aa)' }}>{v.contact_name || 'No contact named'}</div></td>
      <td style={td}><div>{v.email || 'No email'}</div><div style={{ fontSize: 11, color: 'var(--subtle, #a1a1aa)' }}>{v.phone || 'No phone'}</div></td>
      <td style={td}>{v.service_type || '—'}</td>
      <td style={td}>{v.markets.join(', ') || '—'}</td>
      <td style={td}><StatusMarker value={v.status} /></td>
      {actions}
    </tr>
  );
}
