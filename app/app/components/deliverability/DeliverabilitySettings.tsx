'use client';

// Settings → Outbound OS → Email deliverability. Reputation decides whether
// email reaches the inbox, so this is where its signals live: domain
// authentication, what Gmail reports, each mailbox's volume and bounces, the
// suppression list, warm-up, and the checklist that gates bulk sends. No part
// of it can promise the Primary tab; it shows and protects what drives placement.
//
// In plain words, the page has four parts, top to bottom:
//   1. One sentence on where things stand, the problems behind it with a
//      link to the box that fixes each, and the one button to press next.
//   2. Cold email: first-contact email from separate outreach inboxes.
//   3. Warm email: deal blasts to buyers already on the list (Resend), and
//      each rep's own Gmail for one-to-one replies.
//   4. Every email: the sending domains (cold and company in one list, one
//      DNS report each) and the do-not-email list every send checks first.
// This file loads the data for all of it once and hands it to each box.

import React, { useCallback, useState } from 'react';
import { type Overview, type Postmaster, type Warmup, deliverability } from '@/lib/deliverability';
import { type ColdOverview, coldPool } from '@/lib/cold-pool';
import { coldStatus, nextAction, warmStatus } from '@/lib/deliverability-summary';
import { Domains } from './Domains';
import { Mailboxes } from './Mailboxes';
import { Suppressions } from './Suppressions';
import { ResendCard } from './ResendCard';
import { ChecklistCard, PostmasterCard, WarmupCard } from './Signals';
import { ColdPool } from './ColdPool';
import { StatusSummary } from './StatusSummary';
import { DLV_CSS, GroupHeading, card, ghost } from './ui';

type Snap = {
  ws: number | null;
  data: Overview | null;
  err: string | null;
  pm: Postmaster | null;
  wu: Warmup | null;
  accountId: number | null;
  cold: ColdOverview | null;
  coldErr: string | null;
};

const blank = (ws: number | null): Snap => ({ ws, data: null, err: null, pm: null, wu: null, accountId: null, cold: null, coldErr: null });

export function DeliverabilitySettings({ workspaceId, demo }: { workspaceId: number | null; demo: boolean }) {
  const [snap, setSnap] = useState<Snap>(blank(workspaceId));
  const [requested, setRequested] = useState<number | null>(null);

  // A response is applied only when the screen is still on the workspace that asked.
  const load = useCallback(async () => {
    if (!workspaceId) return;
    const ws = workspaceId;
    const r = await deliverability<Overview>(ws, 'overview');
    setSnap((cur) => {
      if (cur.ws !== ws) return cur;
      if (!r.ok) return { ...cur, err: r.message ?? 'Could not load.', data: null };
      const accountId = cur.accountId ?? r.data.mailboxes.find((m) => m.user_id === r.data.me.user_id)?.account_id ?? r.data.mailboxes[0]?.account_id ?? null;
      return { ...cur, err: null, data: r.data, accountId };
    });
  }, [workspaceId]);

  // The cold-email rows come from a different server function (cold-pool).
  // They load here, not inside the cold boxes, so the top sentence can count them.
  const loadCold = useCallback(async () => {
    if (!workspaceId) return;
    const ws = workspaceId;
    const r = await coldPool<ColdOverview>(ws, 'overview');
    setSnap((cur) => (cur.ws !== ws ? cur : r.ok ? { ...cur, cold: r.data, coldErr: null } : { ...cur, coldErr: r.message }));
  }, [workspaceId]);

  const loadPm = useCallback(async (verify = false) => {
    if (!workspaceId) return;
    const ws = workspaceId;
    const r = await deliverability<Postmaster>(ws, 'postmaster', verify ? { verify: true } : {});
    const pm = r.ok ? r.data : { connected: false, granted: false, error: r.message, domains: [], unverified: [] };
    setSnap((cur) => (cur.ws !== ws ? cur : { ...cur, pm }));
  }, [workspaceId]);
  const loadWu = async () => {
    if (!workspaceId) return;
    const ws = workspaceId;
    const r = await deliverability<Warmup>(ws, 'warmup');
    const wu: Warmup = r.ok ? r.data : { instantly: { connected: true, own: false, error: r.message }, inboxkit: { connected: false, own: false, error: null }, mailboxes: [] };
    setSnap((cur) => (cur.ws !== ws ? cur : { ...cur, wu }));
  };

  // Load from the workspace prop during render instead of an effect: load()
  // writes React state, and set-state-in-effect fails CI.
  const wantId = workspaceId && !demo ? workspaceId : null;
  if (snap.ws !== workspaceId) {
    setSnap(blank(workspaceId));
  }
  if (requested !== wantId) {
    setRequested(wantId);
    if (wantId) { void load(); void loadCold(); }
  }

  const mine = snap.ws === workspaceId;
  const data = mine ? snap.data : null;
  const err = mine ? snap.err : null;
  const pm = mine ? snap.pm : null;
  const wu = mine ? snap.wu : null;
  const cold = mine ? snap.cold : null;
  const coldErr = mine ? snap.coldErr : null;
  const accountId = mine ? snap.accountId : null;
  const setAccountId = (id: number) => setSnap((cur) => (cur.ws !== workspaceId ? cur : { ...cur, accountId: id }));

  const reloadPm = useCallback(async (verify?: boolean) => { await load(); await loadPm(verify); }, [load, loadPm]);
  const me = data?.mailboxes.find((m) => m.user_id === data.me.user_id) ?? null;
  const coldNow = coldStatus(cold);
  const warmNow = warmStatus(data, pm, accountId);
  const live = !demo && !!workspaceId;

  if (!live || !workspaceId) return <p style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)', margin: 0 }}>Email settings need the live database. Sign in to a real workspace to see them.</p>;

  return (
    <div id="email-deliverability" data-dlv style={{ minWidth: 0 }}>
      <style>{DLV_CSS}</style>
      <StatusSummary
        cold={coldNow} coldErr={coldErr} coldLoading={!cold && !coldErr}
        warm={warmNow} warmLoading={!data && !err}
        next={nextAction(cold, warmNow)}
      />

      <GroupHeading id="cold-email" title="Cold email (new outreach inboxes)" why="First-contact email to buyers who have never heard from you. It goes out from separate inboxes on spare domains, so your main address stays safe." />
      <ColdPool workspaceId={workspaceId} demo={false} data={cold} err={coldErr} reload={loadCold} />

      <GroupHeading id="warm-email" title="Warm email (Resend blasts to your buyer list)" why="Deal blasts to buyers already on your list, sent through Resend, plus each rep's own Gmail for one-to-one replies." />
      {err ? (
        <section style={card} aria-label="Warm email">
          <p role="alert" style={{ margin: 0, fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)' }}>Couldn&apos;t load the warm email settings: {err.replace(/\.$/, '')}. Nothing was changed.</p>
          <button type="button" style={{ ...ghost, marginTop: '10px' }} onClick={() => void load()}>Try again</button>
        </section>
      ) : !data ? (
        <section style={card} aria-label="Warm email" aria-busy="true"><p role="status" style={{ margin: 0, fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>Loading buyer blast settings…</p></section>
      ) : (
        <>
          <ChecklistCard overview={data} postmaster={pm} accountId={accountId} setAccountId={setAccountId} />
          <ResendCard workspaceId={workspaceId} admin={data.me.admin} overview={data} onChange={() => void load()} />
          <PostmasterCard workspaceId={workspaceId} me={me} data={pm} onLoad={reloadPm} />
          <Mailboxes workspaceId={workspaceId} mailboxes={data.mailboxes} admin={data.me.admin} onChange={() => void load()} />
          <WarmupCard workspaceId={workspaceId} admin={data.me.admin} keys={data.warmup} data={wu} onLoad={loadWu} onChange={() => void load()} />
        </>
      )}

      {data || cold ? (
        <>
          <GroupHeading id="all-email" title="Every email" why="Domains and rules that apply to cold email, buyer blasts and one-to-one mail alike." />
          <Domains workspaceId={workspaceId} domains={data?.domains ?? []} admin={data?.me.admin ?? cold?.admin ?? false} onChange={() => void load()} cold={cold ? { data: cold, reload: loadCold } : null} />
          {data ? <Suppressions workspaceId={workspaceId} rows={data.suppressions} admin={data.me.admin} onChange={() => void load()} /> : null}
        </>
      ) : null}
    </div>
  );
}
