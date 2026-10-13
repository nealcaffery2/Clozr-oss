// Local presence numbers (migration 150, docs/voice-agent.md): the workspace's
// AI caller numbers, one per market. Every AI call goes out from the number
// local to the lead (same area code, else same state, else the agent's
// default). Publish buys and wires the ones still wanted; here they are named,
// added, and wired again when one did not finish. Shared by every agent.
'use client';

import React, { useEffect, useState } from 'react';
import { invokeFn } from '@/app/components/phone/ui';
import { Banner, MUTED } from './kit';

type Num = {
  id: number; market: string; state: string | null; area_code: string; covers: string[]; label: string; answer_agent_key: string | null;
  phone_number: string | null; status: 'wanted' | 'ordered' | 'active' | 'failed'; el_phone_number_id: string | null; error: string | null;
};
type AgentOpt = { agent_key: string; name: string; status: string };
type Reply = { numbers?: Num[]; warnings?: string[]; errors?: { market: string; message: string }[]; error?: string };

const FN = 'voice-agent-admin';
const pretty = (e164: string | null) => {
  const d = String(e164 ?? '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : '';
};
const input: React.CSSProperties = { height: 30, padding: '0 8px', border: '1px solid #e4e4e7', borderRadius: 7, fontSize: 12.5, background: '#fff', minWidth: 0 };
const btn: React.CSSProperties = { height: 30, padding: '0 12px', borderRadius: 7, border: '1px solid #d4d4d8', background: '#fff', fontSize: 12.5, fontWeight: 650, cursor: 'pointer', whiteSpace: 'nowrap' };
const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, color: MUTED, fontWeight: 600, padding: '6px 8px', borderBottom: '1px solid #e4e4e7', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f0f0f1', fontSize: 12.5, verticalAlign: 'middle' };

function Status({ n }: { n: Num }) {
  const live = n.status === 'active' && !!n.el_phone_number_id;
  const bad = !!n.error || n.status === 'failed';
  return (
    <span title={n.error ?? undefined} style={{
      fontSize: 11, fontWeight: 650, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
      background: live ? 'var(--ok-bg)' : bad ? 'var(--danger-bg)' : 'var(--warn-bg)', color: live ? 'var(--ok-ink)' : bad ? 'var(--danger-ink)' : 'var(--warn-ink)',
    }}>
      {live ? 'Live' : bad ? 'Needs attention' : n.phone_number ? 'Bought, wiring' : 'Bought on publish'}
    </span>
  );
}

export function LocalNumbers({ workspaceId, agentKey, canEdit, published, epoch, demo }: {
  workspaceId: number | null; agentKey: string; canEdit: boolean; published: boolean; epoch: number; demo: boolean;
}) {
  const [nums, setNums] = useState<Num[] | null>(null);
  const [names, setNames] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [add, setAdd] = useState({ market: '', area: '', state: '' });
  const [agents, setAgents] = useState<AgentOpt[]>([]);

  const take = (list: Num[] | undefined) => {
    if (!list) return;
    setNums(list);
    setNames(Object.fromEntries(list.map((n) => [n.id, n.label])));
  };

  useEffect(() => {
    if (demo || !workspaceId) return;
    let gone = false;
    void (async () => {
      const [{ data, error }, list] = await Promise.all([
        invokeFn<Reply>(FN, { action: 'numbers', workspace_id: workspaceId }),
        invokeFn<{ agents?: AgentOpt[] }>(FN, { action: 'list_agents', workspace_id: workspaceId }),
      ]);
      if (gone) return;
      setAgents((list.data?.agents ?? []).filter((a) => a && a.agent_key));
      if (error && !data) setMsg({ tone: 'error', text: error });
      take(data?.numbers ?? []);
    })();
    return () => { gone = true; };
  }, [demo, workspaceId, epoch]);

  const run = async (tag: string, body: Record<string, unknown>, ok: (r: Reply) => string) => {
    if (!workspaceId) return;
    setBusy(tag); setMsg(null);
    const { data, error } = await invokeFn<Reply>(FN, { workspace_id: workspaceId, ...body });
    setBusy(null);
    take(data?.numbers);
    const errs = data?.errors ?? [];
    const e = data?.error ?? (data ? null : error);
    if (e) setMsg({ tone: 'error', text: e });
    else if (errs.length) setMsg({ tone: 'warn', text: errs.map((x) => `${x.market}: ${x.message}`).join(' · ') });
    else if (data?.warnings?.length) setMsg({ tone: 'warn', text: data.warnings.join(' ') });
    else setMsg({ tone: 'ok', text: ok(data ?? {}) });
  };

  if (demo) return <p style={{ margin: 0, fontSize: 12.5, color: MUTED }}>Local numbers are bought and wired on publish in a live workspace.</p>;
  if (!nums) return <p style={{ margin: 0, fontSize: 12.5, color: MUTED }}>Reading the local numbers…</p>;

  const pending = nums.filter((n) => !(n.status === 'active' && n.el_phone_number_id)).length;
  const areaOk = /^[2-9]\d{2}$/.test(add.area);
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <p style={{ margin: 0, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>
        Shared by every agent: Riley, Jordan, Avery and any you add all call out from these. Each call uses the number local to the lead
        (the same area code, else the same state, else the agent&apos;s default). Answers only decides who picks up when someone calls one of these numbers back.
      </p>
      {nums.length ? (
        <div style={{ overflowX: 'auto', border: '1px solid #e4e4e7', borderRadius: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr><th style={th}>Market</th><th style={th}>Local for</th><th style={th}>Number</th><th style={th}>Name</th><th style={th}>Callbacks ring</th><th style={th}>Status</th></tr>
            </thead>
            <tbody>
              {nums.map((n) => {
                const changed = (names[n.id] ?? n.label) !== n.label;
                return (
                  <tr key={n.id}>
                    <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>{n.market}{n.state ? <span style={{ color: MUTED, fontWeight: 400 }}> · {n.state}</span> : null}</td>
                    <td style={{ ...td, color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{n.covers.join(', ')}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{pretty(n.phone_number) || <span style={{ color: MUTED }}>{n.area_code} on publish</span>}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input aria-label={`Name for ${n.market}`} value={names[n.id] ?? n.label} maxLength={60} disabled={!canEdit}
                          onChange={(e) => setNames((m) => ({ ...m, [n.id]: e.target.value }))} style={{ ...input, flex: 1, width: 150 }} />
                        {changed && canEdit ? (
                          <button type="button" className="dc2" disabled={!!busy} onClick={() => run(`n${n.id}`, { action: 'set_number', id: n.id, label: names[n.id] }, () => (n.el_phone_number_id ? 'Renamed here, in ElevenLabs and in Telnyx.' : 'Renamed.'))} style={btn}>
                            {busy === `n${n.id}` ? '…' : 'Save'}
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td style={td}>
                      <select aria-label={`Who answers callbacks to ${n.market}`} value={n.answer_agent_key ?? ''} disabled={!canEdit || !!busy}
                        onChange={(e) => run(`a${n.id}`, { action: 'set_number', id: n.id, answer_agent_key: e.target.value || null }, () => (n.el_phone_number_id ? 'Callbacks to that number now ring the agent you picked, in ElevenLabs too.' : 'Saved. It applies when the number is wired.'))}
                        style={{ ...input, width: 130 }}>
                        {!n.answer_agent_key ? <option value="">Whoever publishes</option> : null}
                        {agents.map((a) => <option key={a.agent_key} value={a.agent_key}>{a.name || a.agent_key}{a.status === 'live' ? '' : ' (draft)'}</option>)}
                        {n.answer_agent_key && !agents.some((a) => a.agent_key === n.answer_agent_key) ? <option value={n.answer_agent_key}>{n.answer_agent_key}</option> : null}
                      </select>
                    </td>
                    <td style={td}><Status n={n} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p style={{ margin: 0, fontSize: 12.5, color: MUTED }}>No local numbers yet. Add a market below.</p>}

      {canEdit ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input aria-label="Market" placeholder="Market, like Tampa" value={add.market} maxLength={40} onChange={(e) => setAdd((a) => ({ ...a, market: e.target.value }))} style={{ ...input, width: 170 }} />
          <input aria-label="Area code" placeholder="Area code" inputMode="numeric" value={add.area} onChange={(e) => setAdd((a) => ({ ...a, area: e.target.value.replace(/\D/g, '').slice(0, 3) }))} style={{ ...input, width: 90 }} />
          <input aria-label="State" placeholder="State" value={add.state} maxLength={2} onChange={(e) => setAdd((a) => ({ ...a, state: e.target.value.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 2) }))} style={{ ...input, width: 64 }} />
          <button type="button" className="dc2" disabled={!!busy || !areaOk || !add.market.trim()} style={btn}
            onClick={() => run('add', { action: 'add_number', market: add.market, area_code: add.area, state: add.state, answer_agent_key: nums[0]?.answer_agent_key ?? null }, () => {
              setAdd({ market: '', area: '', state: '' });
              return 'Added. Publish (or Buy and wire now) gets the number.';
            })}>
            {busy === 'add' ? 'Adding…' : 'Add market'}
          </button>
          {published && pending ? (
            <button type="button" className="dc2" disabled={!!busy} onClick={() => run('wire', { action: 'wire_numbers', agent_key: agentKey }, () => 'Every local number is live.')}
              style={{ ...btn, border: '1px solid #1d4ed8', background: '#2563eb', color: '#fff' }}>
              {busy === 'wire' ? `Buying and wiring ${pending}…` : `Buy and wire ${pending} now`}
            </button>
          ) : null}
          {!published && pending ? <span style={{ fontSize: 12, color: MUTED }}>Publish buys the {pending} waiting {pending === 1 ? 'number' : 'numbers'} ($1 each, then $1 a month) and wires them.</span> : null}
        </div>
      ) : null}
      {msg ? <Banner tone={msg.tone}>{msg.text}</Banner> : null}
    </div>
  );
}
