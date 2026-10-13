'use client';

// Bank (Brex) — the owner/admin half of Profitability.
//
// Balances and transactions come from bank_accounts / bank_transactions, which
// RLS only returns to an owner or admin; the brex-sync edge function fills them
// and holds the token. Tagging a transaction to a deal goes through the
// tag_bank_transaction RPC, so "realized profit" is the money that actually
// moved: inflows tagged to a deal less outflows tagged to it.

import React, { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { BankAccountRow, BankTransactionRow } from '@/lib/database.types';
import type { Range, ReportRaw } from '@/lib/reporting';
import { Table } from './ReportBlocks';

type Status = { connected: boolean; source: 'workspace' | 'secret' | null; last_synced_at: string | null; last_error: string | null };

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e4e4e7', borderRadius: '12px', minWidth: 0 };
const btn: React.CSSProperties = { height: '30px', padding: '0 12px', borderRadius: '7px', border: '1px solid #e4e4e7', background: '#fff', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap' };
const dark: React.CSSProperties = { ...btn, border: '1px solid #18181b', background: '#18181b', color: '#fff', fontWeight: 600 };
const cents = (n: number | null | undefined) => (n == null ? '—' : (n < 0 ? '−$' : '$') + (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

async function call(workspaceId: number, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('brex-sync', { body: { workspace_id: workspaceId, ...body } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    throw new Error(message);
  }
  return data as Record<string, unknown>;
}

type Loaded = { key: string; status: Status | null; accounts: BankAccountRow[]; txns: BankTransactionRow[]; err: string | null };

async function fetchBank(workspaceId: number, since: string | null, key: string): Promise<Loaded> {
  try {
    const status = (await call(workspaceId, { action: 'status' })) as unknown as Status;
    let q = supabase!.from('bank_transactions').select('*').eq('workspace_id', workspaceId).order('posted_at', { ascending: false }).limit(2000);
    if (since) q = q.gte('posted_at', since);
    const [a, t] = await Promise.all([supabase!.from('bank_accounts').select('*').eq('workspace_id', workspaceId).order('is_primary', { ascending: false }), q]);
    return { key, status, accounts: (a.data ?? []) as BankAccountRow[], txns: (t.data ?? []) as BankTransactionRow[], err: a.error?.message ?? t.error?.message ?? null };
  } catch (e) {
    return { key, status: null, accounts: [], txns: [], err: e instanceof Error ? e.message : String(e) };
  }
}

export function BankPanel({ workspaceId, range, raw }: { workspaceId: number | null; range: Range; raw: ReportRaw }) {
  const [nonce, setNonce] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  const since = Number.isFinite(range.start) ? isoDay(range.start) : null;
  const key = `${workspaceId}:${since}:${nonce}`;

  useEffect(() => {
    if (!workspaceId || !supabase) return;
    let live = true;
    void fetchBank(workspaceId, since, key).then((r) => { if (live) setLoaded(r); });
    return () => { live = false; };
  }, [workspaceId, since, key]);
  const reload = () => setNonce((n) => n + 1);

  const status = loaded?.status ?? null;
  const accounts = loaded?.accounts ?? [];
  const txns = loaded?.txns ?? [];
  const err = actionErr ?? loaded?.err ?? null;

  const run = async (body: Record<string, unknown>) => {
    if (!workspaceId) return;
    setBusy(true); setActionErr(null);
    try {
      const r = await call(workspaceId, body);
      if (r.ok === false) setActionErr(String(r.error ?? 'Brex sync failed'));
      setToken('');
      reload();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const tag = async (id: number, dealId: number | null) => {
    if (!supabase) return;
    setLoaded((l) => (l ? { ...l, txns: l.txns.map((x) => (x.id === id ? { ...x, deal_id: dealId } : x)) } : l));
    const { error } = await supabase.rpc('tag_bank_transaction', { p_id: id, p_deal_id: dealId });
    if (error) { setActionErr(error.message); reload(); }
  };

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid #f0f0f1' }}>
      <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: '1 1 220px', minWidth: 0 }}>
        <span style={{ fontWeight: 600, fontSize: '14px' }}>Bank (Brex)</span>
        <span style={{ fontSize: '11.5px', color: '#71717a' }}>
          Owner and admin only.{status?.last_synced_at ? ` Last synced ${new Date(status.last_synced_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : ''}
          {status?.source === 'secret' ? ' Token from the BREX_API_TOKEN secret.' : ''}
        </span>
      </span>
      {status?.connected ? (
        <>
          <button style={dark} disabled={busy} onClick={() => void run({ action: 'sync', since: since ?? isoDay(Date.now() - 730 * 86_400_000) })}>{busy ? 'Syncing…' : 'Sync now'}</button>
          {status.source === 'workspace' ? <button style={btn} disabled={busy} onClick={() => void run({ action: 'disconnect' })}>Disconnect</button> : null}
        </>
      ) : null}
    </div>
  );
  const errLine = err || status?.last_error
    ? <div style={{ padding: '10px 16px', fontSize: '12px', color: '#dc2626', borderBottom: '1px solid #f0f0f1' }}>{err ?? status?.last_error}</div> : null;

  if (!workspaceId) {
    return <div style={card}>{header}<p style={{ margin: 0, padding: '16px', fontSize: '12.5px', color: '#52525b', lineHeight: 1.5 }}>The bank feed runs on a signed-in workspace. In yours, an owner connects Brex here and balances, inflows and outflows land on this tab.</p></div>;
  }

  if (status && !status.connected) {
    return (
      <div style={card}>
        {header}{errLine}
        <div style={{ padding: '16px', display: 'grid', gap: '10px', fontSize: '12.5px', color: '#52525b', lineHeight: 1.5 }}>
          <div style={{ fontWeight: 600, color: '#18181b' }}>Connect Brex</div>
          <div>
            Create a user token in Brex (Developer → Create token) with <code>accounts.cash.readonly</code>, <code>transactions.cash.readonly</code>{' '}
            and, for card spend, <code>accounts.card.readonly</code> and <code>transactions.card.readonly</code>. Paste it below: it is stored server-side
            and never sent back to a browser. Or set it as a function secret instead:
            {' '}<code>supabase secrets set BREX_API_TOKEN=… BREX_WORKSPACE_ID={workspaceId}</code>.
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Brex user token"
              style={{ flex: '1 1 260px', minWidth: 0, height: '30px', padding: '0 10px', borderRadius: '7px', border: '1px solid #e4e4e7', fontSize: '12.5px' }} />
            <button style={dark} disabled={busy || token.trim().length < 20} onClick={() => void run({ action: 'connect', token: token.trim() })}>{busy ? 'Connecting…' : 'Connect'}</button>
          </div>
        </div>
      </div>
    );
  }

  const inflow = txns.filter((t) => t.amount_cents > 0).reduce((a, t) => a + t.amount_cents, 0);
  const outflow = txns.filter((t) => t.amount_cents < 0).reduce((a, t) => a + t.amount_cents, 0);
  const addr = (id: number) => {
    const d = raw.deals.find((x) => x.id === id);
    const s = d?.seller_id != null ? raw.sellers.find((x) => x.id === d.seller_id) : undefined;
    return s?.address || s?.name || 'Deal ' + id;
  };
  const dealOptions = raw.deals.filter((d) => d.stage !== 'Prospect').map((d) => ({ id: d.id, label: `${addr(d.id)} · ${d.stage}` }));
  const byDeal = new Map<number, { in: number; out: number }>();
  for (const t of txns) {
    if (t.deal_id == null) continue;
    const x = byDeal.get(t.deal_id) ?? { in: 0, out: 0 };
    byDeal.set(t.deal_id, t.amount_cents > 0 ? { ...x, in: x.in + t.amount_cents } : { ...x, out: x.out + t.amount_cents });
  }
  const tile = (k: string, v: string, color?: string) => (
    <div key={k} style={{ padding: '12px 16px', borderRight: '1px solid #f0f0f1', borderBottom: '1px solid #f0f0f1', marginBottom: '-1px' }}>
      <div style={{ fontSize: '11.5px', color: '#71717a', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k}</div>
      <div style={{ fontSize: '19px', fontWeight: 700, letterSpacing: '-0.03em', marginTop: '4px', color }}>{v}</div>
    </div>
  );

  return (
    <div style={{ ...card, overflow: 'hidden' }}>
      {header}{errLine}
      {!status ? (err ? null : <div style={{ padding: '16px', fontSize: '12.5px', color: '#71717a' }}>Checking the Brex connection…</div>) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', borderBottom: '1px solid #f0f0f1' }}>
            {accounts.map((a) => tile(`${a.name ?? a.kind}${a.kind === 'card' ? ' balance' : ''}`, cents(a.current_balance_cents)))}
            {tile('Inflows in range', cents(inflow), '#16a34a')}
            {tile('Outflows in range', cents(outflow), '#dc2626')}
            {tile('Net cash flow', cents(inflow + outflow))}
          </div>
          {!accounts.length ? <div style={{ padding: '14px 16px', fontSize: '12.5px', color: '#71717a' }}>Connected, but nothing synced yet. Press Sync now.</div> : null}
          {byDeal.size ? (
            <>
              <div style={{ padding: '12px 16px 4px', fontWeight: 600, fontSize: '13px' }}>Realized profit by deal <span style={{ fontWeight: 400, color: '#71717a', fontSize: '11.5px' }}>· tagged inflows less tagged costs, in range</span></div>
              <Table cols={['Deal', 'Money in', 'Costs out', 'Realized profit']}
                rows={[...byDeal.entries()].map(([id, x]) => [addr(id), cents(x.in), cents(x.out), cents(x.in + x.out)])} />
            </>
          ) : null}
          <div style={{ padding: '12px 16px 4px', fontWeight: 600, fontSize: '13px' }}>Transactions <span style={{ fontWeight: 400, color: '#71717a', fontSize: '11.5px' }}>· tag the assignment wire and a deal&apos;s costs to its deal</span></div>
          {!txns.length ? <div style={{ padding: '10px 16px 16px', fontSize: '12.5px', color: '#71717a' }}>No bank transactions posted in this range.</div> : (
            <Table cols={['Description', 'Posted', 'Type', 'Amount', 'Deal']}
              rows={txns.map((t) => [
                <span key="d" title={t.description ?? ''}>{t.counterparty || t.description || '—'}</span>,
                t.posted_at, t.category ?? '—',
                <span key="a" style={{ color: t.amount_cents > 0 ? '#16a34a' : undefined, fontWeight: 600 }}>{cents(t.amount_cents)}</span>,
                <select key="s" value={t.deal_id ?? ''} onChange={(e) => void tag(t.id, e.target.value ? Number(e.target.value) : null)}
                  style={{ height: '26px', maxWidth: '220px', borderRadius: '6px', border: '1px solid #e4e4e7', fontSize: '12px', background: '#fff' }}>
                  <option value="">Untagged</option>
                  {dealOptions.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>,
              ])} />
          )}
        </>
      )}
    </div>
  );
}
