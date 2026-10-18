// Buyr: aged Deal Machine deals sync into Genius in the background, and Facebook
// buyer finding (groups, the deal-post commenter, pasted comments) lives here.
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { BUYR, BUYR_TINT } from '@/app/clozr/brand';
import { FbGroupsPanel } from '@/components/FbGroupsPanel';
import { useSession } from '@/lib/session';
import { DEFAULT_FILTERS, dealsSyncedVia, discover } from '@/lib/genius';
import {
  type FbGroup, type FiledProspect, type SnipeDeal, type SnipeOptin,
  filePastedComments, loadFbGroups, loadFbProspects, loadSnipeQueue, queueFacebookScrape,
} from '@/lib/buyr';

type Mode = 'snipe' | 'facebook';

const MODES: { id: Mode; label: string }[] = [
  { id: 'snipe', label: 'Wholesale sniping' },
  { id: 'facebook', label: 'Facebook buyers' },
];

const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '14px', padding: '14px 16px' };
const muted: React.CSSProperties = { margin: '6px 0 0', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 };

export function Buyr({ V }: { V: ClozrView }) {
  const session = useSession();
  const workspaceId = V.liveIds?.workspaceId ?? null;
  const [mode, setMode] = useState<Mode>('snipe');
  const [days, setDays] = useState(90);
  const [deals, setDeals] = useState<SnipeDeal[]>([]);
  const [optins, setOptins] = useState<SnipeOptin[]>([]);
  const [queueMsg, setQueueMsg] = useState('Loading the aged queue…');
  const [syncNote, setSyncNote] = useState('Aged deals sync into Genius in the background. Buyers there are labeled Buyr.');

  const loadQueue = useCallback(async (d: number) => {
    if (!workspaceId) return { deals: [] as SnipeDeal[], optins: [] as SnipeOptin[], error: 'Sign in to a workspace to load Deal Machine deals.' };
    return loadSnipeQueue(workspaceId, d);
  }, [workspaceId]);

  useEffect(() => {
    let live = true;
    void loadQueue(days).then((r) => {
      if (!live) return;
      if (r.error) { setQueueMsg(r.error); setDeals([]); setOptins([]); return; }
      setDeals(r.deals);
      setOptins(r.optins);
      setQueueMsg(`${r.deals.length} deals older than ${days} days · ${r.optins.length} wholesaler lists opted in`);
    });
    return () => { live = false; };
  }, [loadQueue, days]);

  useEffect(() => {
    if (!workspaceId || !V.liveIds?.canWrite || !deals.length) return;
    let live = true;
    const ac = new AbortController();
    const queued = deals;
    void dealsSyncedVia(workspaceId, 'buyr').then(async (done) => {
      if (!live) return;
      const due = queued.filter((d) => !done.has(d.id)).slice(0, 2);
      if (!due.length) {
        setSyncNote('These aged deals are already in Genius, labeled Buyr.');
        return;
      }
      setSyncNote(`Syncing ${due.length} aged deal${due.length === 1 ? '' : 's'} into Genius…`);
      let ok = 0;
      for (const d of due) {
        const r = await discover(workspaceId, { deal_id: d.id }, { ...DEFAULT_FILTERS, found_via: 'buyr' }, { skipTrace: false }, () => {}, ac.signal);
        if (!live) return;
        if (r.ok) ok += 1;
      }
      if (!live) return;
      setSyncNote(ok
        ? `Synced ${ok} deal${ok === 1 ? '' : 's'} into Genius. Open Genius to see the buyers, labeled Buyr.`
        : 'Could not sync those deals into Genius this time.');
    });
    return () => { live = false; ac.abort(); };
  }, [workspaceId, deals, V.liveIds?.canWrite]);

  return (
    <section data-screen-label="Buyr" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ background: 'var(--surface, #fff)', borderBottom: '1px solid var(--divider, #e4e4e7)', padding: V.isMobile ? '10px 12px 0' : '12px 20px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: BUYR, flex: 'none' }} />
          <h1 style={{ margin: 0, fontSize: '16px', fontWeight: 700, letterSpacing: '-0.02em' }}>Buyr</h1>
          <span style={{ fontSize: '12px', color: 'var(--meta, #71717a)' }}>Wholesale sniping · Facebook buyers</span>
          <div style={{ flex: 1 }} />
          <button type="button" onClick={() => V.goBuyerProspects()} style={ghost}>Buyer Prospects</button>
        </div>
        <div style={{ display: 'flex', gap: '2px', marginTop: '10px', overflow: 'auto' }}>
          {MODES.map((m) => {
            const on = mode === m.id;
            return (
              <button key={m.id} type="button" onClick={() => setMode(m.id)} style={{ height: '36px', padding: '0 12px', border: 0, borderBottom: `2px solid ${on ? BUYR : 'transparent'}`, background: 'none', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: on ? 'var(--ink, #18181b)' : 'var(--meta, #71717a)', whiteSpace: 'nowrap' }}>
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: V.isMobile ? '12px 12px 40px' : '16px 20px 48px', background: 'var(--canvas, #fafafa)' }}>
        {mode === 'facebook' ? (
          workspaceId ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '1100px' }}>
              <FbGroupsPanel workspaceId={workspaceId} canOperate={!!V.liveIds?.canWrite} onToast={V.showToast} />
              <Facebook V={V} workspaceId={workspaceId} userId={session.user?.id ?? null} />
            </div>
          ) : (
            <div style={card}>
              <div style={{ fontSize: '14px', fontWeight: 700 }}>Facebook buyers</div>
              <p style={muted}>Sign in to a workspace. Groups, the deal-post commenter, and pasted comments live here.</p>
            </div>
          )
        ) : workspaceId ? (
          <SnipeQueue
            days={days}
            setDays={setDays}
            deals={deals}
            optins={optins}
            queueMsg={queueMsg}
            syncNote={syncNote}
            onOpenGenius={() => V.goGenius()}
          />
        ) : (
          <div style={card}>
            <div style={{ fontSize: '14px', fontWeight: 700 }}>Aged deals to snipe</div>
            <p style={muted}>Sign in to load Deal Machine deals. They sync into Genius in the background, and the buyers are labeled Buyr.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function SnipeQueue({ days, setDays, deals, optins, queueMsg, syncNote, onOpenGenius }: {
  days: number;
  setDays: (n: number) => void;
  deals: SnipeDeal[];
  optins: SnipeOptin[];
  queueMsg: string;
  syncNote: string;
  onOpenGenius: () => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>Aged deals to snipe</div>
          <label style={{ fontSize: '12px', color: 'var(--meta, #71717a)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            Older than
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ height: '28px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12px' }}>
              {[30, 60, 90, 180].map((n) => <option key={n} value={n}>{n} days</option>)}
            </select>
          </label>
        </div>
        <p style={muted}>Deal Machine deals, including the deals@yourcompany.com list once it has aged. Buyr searches them in Genius automatically. The buyers are labeled Buyr.</p>
        <p style={{ ...muted, color: 'var(--ink-3, #3f3f46)' }}>{queueMsg}</p>
        <p style={{ ...muted, color: 'var(--ink-3, #3f3f46)' }}>{syncNote}</p>
        <button type="button" onClick={onOpenGenius} style={{ ...ghost, marginTop: '8px' }}>Open Genius</button>
        <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, maxHeight: '280px', overflow: 'auto' }}>
          {deals.map((d) => (
            <li key={d.id} style={{ padding: '7px 8px', fontSize: '12.5px', color: 'var(--ink, #18181b)' }}>
              {d.address}
              <span style={{ display: 'block', fontSize: '11px', color: 'var(--subtle, #a1a1aa)' }}>{d.createdAt.slice(0, 10)}{d.leadSource ? ` · ${d.leadSource}` : ''}</span>
            </li>
          ))}
        </ul>
      </div>
      <div style={card}>
        <div style={{ fontSize: '14px', fontWeight: 700 }}>Wholesaler lists opted in</div>
        <p style={muted}>Lists the Deal Machine opt-in bot joined. Aged deals from these lists are the sniping queue.</p>
        <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, maxHeight: '280px', overflow: 'auto' }}>
          {optins.map((o) => (
            <li key={o.domain} style={{ padding: '6px 0', borderTop: '1px solid var(--surface-2, #f4f4f5)', fontSize: '12.5px' }}>
              {o.url ? <a href={o.url} target="_blank" rel="noreferrer" style={{ color: BUYR }}>{o.domain}</a> : o.domain}
            </li>
          ))}
          {!optins.length ? <li style={muted}>No opted-in lists yet.</li> : null}
        </ul>
      </div>
    </div>
  );
}

function Facebook({ V, workspaceId, userId }: { V: ClozrView; workspaceId: number; userId: string | null }) {
  const [groups, setGroups] = useState<FbGroup[]>([]);
  const [filed, setFiled] = useState<FiledProspect[]>([]);
  const [paste, setPaste] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([loadFbGroups(workspaceId), loadFbProspects(workspaceId)]).then(([g, p]) => {
      if (!live) return;
      setGroups(g.groups);
      if (g.error) setNote(g.error);
      setFiled(p);
    });
    return () => { live = false; };
  }, [workspaceId, tick]);

  async function scrape() {
    setBusy(true);
    const r = await queueFacebookScrape(workspaceId);
    setBusy(false);
    setNote(r.ok
      ? 'Facebook scrape queued. The extension picks it up on its next check-in and files comment emails into Buyer Prospects.'
      : (r.message ?? 'Could not queue the scrape.'));
  }

  async function filePaste() {
    setBusy(true);
    const r = await filePastedComments(workspaceId, paste, userId);
    setBusy(false);
    if (r.filed) { setPaste(''); V.reloadCrm(); }
    setNote(r.error && !r.filed
      ? r.error
      : `Found ${r.found}. Filed ${r.filed} in Buyer Prospects${r.skipped ? `. ${r.skipped} already on file` : ''}.`);
    if (r.filed) setTick((n) => n + 1);
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px' }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>Scrape comment emails</div>
          <button type="button" disabled={busy || !V.liveIds?.canWrite} onClick={() => void scrape()} style={primary}>Scrape comment emails</button>
        </div>
        <p style={muted}>Reads buyer names and emails from comments on the groups above, and skips deals@yourcompany.com. They file into Buyer Prospects, labeled Facebook.</p>
        {note ? <p style={{ ...muted, color: 'var(--ink-3, #3f3f46)' }}>{note}</p> : null}
        <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, maxHeight: '180px', overflow: 'auto' }}>
          {groups.slice(0, 8).map((g) => (
            <li key={g.id} style={{ padding: '7px 0', borderTop: '1px solid var(--surface-2, #f4f4f5)', fontSize: '12.5px' }}>
              <a href={g.url} target="_blank" rel="noreferrer" style={{ color: 'var(--ink, #18181b)', fontWeight: 600 }}>{g.name || g.url}</a>
            </li>
          ))}
          {!groups.length ? <li style={muted}>No active groups yet. Add them above.</li> : null}
        </ul>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ ...card, background: BUYR_TINT, borderColor: `${BUYR}33` }}>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>Paste comments</div>
          <p style={muted}>One person per line. Name, then the comment. They file into Buyer Prospects, labeled Facebook.</p>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} placeholder={'Jane Doe: send it to jane@buyer.com'} style={{ width: '100%', marginTop: '8px', borderRadius: '10px', border: '1px solid var(--divider, #e4e4e7)', padding: '8px 10px', fontSize: '12.5px', fontFamily: 'inherit', resize: 'vertical', background: 'var(--surface, #fff)' }} />
          <button type="button" disabled={busy || !paste.trim() || !V.liveIds?.canWrite} onClick={() => void filePaste()} style={{ ...primary, marginTop: '8px' }}>File buyer prospects</button>
        </div>
        <div style={card}>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>Filed from comments</div>
          <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, maxHeight: '220px', overflow: 'auto' }}>
            {filed.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => V.genius.openBuyer(p.id)} style={{ width: '100%', textAlign: 'left', border: 0, background: 'transparent', padding: '6px 0', cursor: 'pointer', fontSize: '12.5px' }}>
                  <span style={{ fontWeight: 600, color: 'var(--ink, #18181b)' }}>{p.name}</span>
                  <span style={{ marginLeft: '6px', fontSize: '11px', fontWeight: 700, color: 'var(--ink-3, #3f3f46)' }}>Facebook</span>
                  {p.email ? <span style={{ color: 'var(--meta, #71717a)' }}> · {p.email}</span> : null}
                </button>
              </li>
            ))}
            {!filed.length ? <li style={muted}>None yet.</li> : null}
          </ul>
        </div>
      </div>
    </div>
  );
}

const ghost: React.CSSProperties = { height: '30px', padding: '0 10px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', color: 'var(--ink, #18181b)' };
const primary: React.CSSProperties = { height: '30px', padding: '0 10px', borderRadius: '8px', border: `1px solid ${BUYR}`, background: BUYR, color: 'var(--on-dark, #fff)', fontSize: '12px', fontWeight: 650, cursor: 'pointer' };
