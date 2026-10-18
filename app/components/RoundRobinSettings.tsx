'use client';

/**
 * Settings → Workspace → Round robin (migration 121).
 *
 * Acquisitions rotations deal new inbound leads; each lead source (the
 * yourcompany.com form, a Jotform form, Zapier, Deal Machine) picks the
 * rotation its leads go to. Dispositions rotations deal deals of one type —
 * novations by default — to a dispo rep as soon as the deal type is set.
 *
 * Any teammate can be added; pausing someone takes them out of the rotation
 * without forgetting their place, removing them takes them off the list. Only
 * an owner or admin edits; everyone else sees who is in and who is up next.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { INGEST_SOURCES, type IngestKey, listKeys, setKeySetting } from '@/lib/ingest';
import {
  DEAL_TYPE_OPTIONS, type RoundRobin, type RoundRobinTeam,
  addRoundRobinMember, createRoundRobin, deleteRoundRobin, listRoundRobins, nextUp,
  removeRoundRobinMember, setRoundRobinMemberActive, updateRoundRobin,
} from '@/lib/round-robin';
import { ROLE_LABEL, type Teammate, listTeam } from '@/lib/team';

const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const muted: React.CSSProperties = { margin: '0 0 8px', fontSize: '12px', color: 'var(--meta, #71717a)', lineHeight: 1.55 };
const sub: React.CSSProperties = { margin: '14px 0 6px', fontSize: '12.5px', fontWeight: 600, color: 'var(--ink, #18181b)' };
const field: React.CSSProperties = { height: '32px', padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '12.5px', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)', outline: 0, minWidth: 0, fontFamily: 'inherit' };
const btn: React.CSSProperties = { height: '30px', padding: '0 11px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', color: 'var(--ink, #18181b)', flex: 'none' };
const primary: React.CSSProperties = { ...btn, border: '1px solid #0A8560', background: '#0A8560', color: '#fff' };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--divider-2, #f0f0f1)' };
const pill = (on: boolean): React.CSSProperties => ({
  padding: '2px 9px', borderRadius: '999px', fontSize: '11px', fontWeight: 700,
  background: on ? 'var(--positive-soft, #dcfce7)' : 'var(--surface-2, #f4f4f5)', color: on ? 'var(--tx-green, #15803d)' : 'var(--meta, #71717a)', flex: 'none',
});

type Run = (fn: () => Promise<{ ok: boolean; message?: string }>, done?: string) => Promise<boolean>;

/** Ingest sources that can file a seller lead (not the read-only TV key, not Talkr's call events). */
const LEAD_SOURCES = new Set(['zapier', 'jotform', 'deal_machine', 'compr', 'flipradar']);
const sourceLabel = (k: IngestKey) =>
  k.label || INGEST_SOURCES.find((s) => s.name === k.name)?.label || k.name;

export function RoundRobinSettings({ workspaceId, admin, demo, isMobile }: {
  workspaceId: number | null; admin: boolean; demo: boolean; isMobile: boolean;
}) {
  const [rows, setRows] = useState<RoundRobin[]>([]);
  const [missing, setMissing] = useState(false);
  const [team, setTeam] = useState<Teammate[]>([]);
  const [keys, setKeys] = useState<IngestKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!workspaceId || demo) return;
    let live = true;
    void Promise.all([listRoundRobins(workspaceId), listTeam(workspaceId), admin ? listKeys(workspaceId) : Promise.resolve([])])
      .then(([rr, t, k]) => {
        if (!live) return;
        setRows(rr.rows);
        setMissing(rr.missing);
        setTeam(t);
        setKeys(k.filter((x) => LEAD_SOURCES.has(x.name)));
      });
    return () => { live = false; };
  }, [workspaceId, admin, demo, nonce]);

  const run: Run = async (fn, done) => {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    setNote(r.ok ? (done ? { ok: true, text: done } : null) : { ok: false, text: r.message ?? 'That did not save.' });
    refresh();
    return r.ok;
  };

  const nameOf = (id: string) => {
    const t = team.find((m) => m.user_id === id);
    return t ? t.full_name || t.email || 'Teammate' : 'Former teammate';
  };

  async function create(teamKind: RoundRobinTeam) {
    if (!workspaceId) return;
    const name = teamKind === 'acquisitions' ? 'Acquisitions' : 'Dispositions · Novations';
    await run(() => createRoundRobin(workspaceId, teamKind, name), 'Round robin created — add the reps who should be in it.');
  }

  if (demo) return <div style={card}><p style={muted}>Supabase isn&rsquo;t configured for this deployment.</p></div>;
  if (missing) {
    return (
      <div style={card}>
        <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Round robin</h2>
        <p style={muted}>This database doesn&rsquo;t have round robins yet. Apply <code>supabase/migrations/121_round_robin_underwriter.sql</code> and reload.</p>
      </div>
    );
  }

  const acq = rows.filter((r) => r.team === 'acquisitions');
  const dispo = rows.filter((r) => r.team === 'dispositions');

  return (
    <>
      {note ? (
        <div role="status" style={{ ...card, padding: '11px 13px', background: note.ok ? 'var(--positive-soft, #dcfce7)' : 'var(--negative-soft, #fee2e2)', borderColor: note.ok ? 'var(--tint-green-3, #bbf7d0)' : 'var(--tint-red-2, #fecaca)', color: note.ok ? 'var(--tx-green, #15803d)' : '#b91c1c', fontSize: '12.5px' }}>
          {note.text}
        </div>
      ) : null}

      <div style={card}>
        <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Acquisitions — new leads</h2>
        <p style={muted}>
          A new lead from a source below goes to whoever in its rotation was dealt a lead longest ago. A lead that is already
          assigned (the same seller submitting again) keeps its rep and doesn&rsquo;t use a turn.
        </p>
        {acq.map((r) => <Rotation key={r.id} r={r} team={team} nameOf={nameOf} admin={admin} busy={busy} run={run} isMobile={isMobile} workspaceId={workspaceId!} />)}
        {admin ? <button type="button" className="dc3" style={{ ...primary, marginTop: '6px' }} disabled={busy} onClick={() => void create('acquisitions')}>New acquisitions round robin</button> : null}

        {admin ? (
          <>
            <div style={sub}>Lead sources</div>
            {keys.length ? keys.map((k) => (
              <div key={k.id} style={row}>
                <span style={{ flex: '1 1 200px', fontSize: '12.5px', fontWeight: 600, color: k.active ? 'var(--ink, #18181b)' : 'var(--subtle, #a1a1aa)' }}>
                  {sourceLabel(k)} <span style={{ fontWeight: 400, color: 'var(--subtle, #a1a1aa)', fontFamily: 'ui-monospace, monospace' }}>{k.key_prefix}…</span>
                </span>
                <label style={{ fontSize: '12px', color: 'var(--muted, #52525b)' }}>
                  New leads go to{' '}
                  <select value={k.round_robin} disabled={busy} style={field} aria-label={`Round robin for ${sourceLabel(k)}`}
                    onChange={(e) => void run(() => setKeySetting(k.id, 'round_robin', e.target.value),
                      e.target.value === 'off' ? `${sourceLabel(k)} leads now land unassigned.` : `${sourceLabel(k)} leads are now round-robined.`)}>
                    <option value="off">Nobody (unassigned)</option>
                    {acq.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
                  </select>
                </label>
              </div>
            )) : (
              <p style={muted}>No lead sources yet. Create a Zapier key for the yourcompany.com form, or a Jotform key, under Integrations → Zapier &amp; webhooks.</p>
            )}
          </>
        ) : null}
      </div>

      <div style={card}>
        <h2 style={{ margin: '0 0 4px', fontSize: '14px', fontWeight: 600 }}>Dispositions — deals by type</h2>
        <p style={muted}>
          Novation with no dispo yet is dealt to the next rep in the novation rotation (an every-type rotation covers it too)
          and that rep joins the deal team. Assignment and double close are not dealt: the dispo is whoever sells the deal.
          A rotation for the exact type wins over an &ldquo;Every deal type&rdquo; one.
        </p>
        {dispo.map((r) => <Rotation key={r.id} r={r} team={team} nameOf={nameOf} admin={admin} busy={busy} run={run} isMobile={isMobile} workspaceId={workspaceId!} />)}
        {admin ? <button type="button" className="dc3" style={{ ...primary, marginTop: '6px' }} disabled={busy} onClick={() => void create('dispositions')}>New dispositions round robin</button> : null}
      </div>
    </>
  );
}

function Rotation({ r, team, nameOf, admin, busy, run, isMobile, workspaceId }: {
  r: RoundRobin; team: Teammate[]; nameOf: (id: string) => string; admin: boolean; busy: boolean; run: Run; isMobile: boolean; workspaceId: number;
}) {
  const [name, setName] = useState(r.name);
  const [pick, setPick] = useState('');
  const up = nextUp(r);
  const inIt = new Set(r.members.map((m) => m.user_id));
  // The team the rotation is for first, then everyone else: anyone can be dealt leads.
  const addable = team.filter((t) => !inIt.has(t.user_id))
    .sort((a, b) => Number(b.role === r.team) - Number(a.role === r.team));

  return (
    <div style={{ margin: '8px 0', padding: '11px 13px', borderRadius: '10px', background: 'var(--canvas, #fafafa)', border: '1px solid var(--divider, #e4e4e7)' }}>
      <div style={{ ...row, borderTop: 0, padding: 0 }}>
        {admin ? (
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} aria-label="Round robin name"
            onBlur={() => { if (name.trim() && name.trim() !== r.name) void run(() => updateRoundRobin(r.id, { name: name.trim() }), 'Renamed.'); }}
            style={{ ...field, flex: '1 1 180px', fontWeight: 600 }} />
        ) : <span style={{ flex: '1 1 180px', fontSize: '13px', fontWeight: 600 }}>{r.name}</span>}
        <span style={pill(r.active)}>{r.active ? 'On' : 'Off'}</span>
        {admin ? (
          <>
            <button type="button" className="dc2" style={btn} disabled={busy}
              onClick={() => void run(() => updateRoundRobin(r.id, { active: !r.active }), r.active ? 'Round robin turned off — new leads land unassigned.' : 'Round robin turned on.')}>
              {r.active ? 'Turn off' : 'Turn on'}
            </button>
            <button type="button" className="dc2" style={{ ...btn, color: 'var(--tx-red, #b91c1c)' }} disabled={busy}
              onClick={() => { if (window.confirm(`Delete the ${r.name} round robin? Sources that use it will assign nobody.`)) void run(() => deleteRoundRobin(r.id), 'Round robin deleted.'); }}>
              Delete
            </button>
          </>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', marginTop: '8px', fontSize: '12px', color: 'var(--muted, #52525b)' }}>
        {r.team === 'dispositions' ? (
          <label>
            Deals out{' '}
            <select value={r.deal_type ?? 'novation'} disabled={!admin || busy} style={field} aria-label="Deal type"
              onChange={(e) => void run(() => updateRoundRobin(r.id, { deal_type: e.target.value as RoundRobin['deal_type'] }), 'Saved.')}>
              {DEAL_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        ) : (
          <label style={{ display: 'flex', gap: '6px', alignItems: 'center', cursor: admin ? 'pointer' : 'default' }}>
            <input type="checkbox" checked={r.underwriter === 'same'} disabled={!admin || busy} style={{ accentColor: 'var(--tx-mint, #0a8560)' }}
              onChange={(e) => void run(() => updateRoundRobin(r.id, { underwriter: e.target.checked ? 'same' : 'none' }), 'Saved.')} />
            The rep is also the lead&rsquo;s underwriter
          </label>
        )}
        <span>Next up: <strong style={{ color: 'var(--ink, #18181b)' }}>{up ? nameOf(up.user_id) : 'nobody — add someone'}</strong></span>
      </div>

      <div style={{ marginTop: '8px' }}>
        {r.members.map((m) => (
          <div key={m.user_id} style={{ ...row, padding: '6px 0' }}>
            <span style={{ flex: '1 1 160px', fontSize: '12.5px', fontWeight: 600, color: m.active ? 'var(--ink, #18181b)' : 'var(--subtle, #a1a1aa)' }}>
              {nameOf(m.user_id)}
              <span style={{ fontWeight: 400, color: 'var(--subtle, #a1a1aa)' }}>
                {' '}· {ROLE_LABEL[team.find((t) => t.user_id === m.user_id)?.role ?? 'member'] ?? ''}
              </span>
            </span>
            <span style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)', flex: isMobile ? '1 1 100%' : '0 1 220px' }}>
              {m.assigned_count} dealt{m.last_assigned_at ? ` · last ${new Date(m.last_assigned_at).toLocaleString()}` : ''}
            </span>
            <span style={pill(m.active)}>{m.active ? 'In rotation' : 'Out'}</span>
            {admin ? (
              <>
                <button type="button" className="dc2" style={btn} disabled={busy}
                  onClick={() => void run(() => setRoundRobinMemberActive(r.id, m.user_id, !m.active),
                    m.active ? `${nameOf(m.user_id)} is out of the rotation.` : `${nameOf(m.user_id)} is back in the rotation.`)}>
                  {m.active ? 'Take out' : 'Put back in'}
                </button>
                <button type="button" className="dc2" style={{ ...btn, color: 'var(--tx-red, #b91c1c)' }} disabled={busy}
                  onClick={() => void run(() => removeRoundRobinMember(r.id, m.user_id), `${nameOf(m.user_id)} removed.`)}>
                  Remove
                </button>
              </>
            ) : null}
          </div>
        ))}
        {!r.members.length ? <p style={{ ...muted, margin: '6px 0 0' }}>Nobody in this rotation yet, so nothing is assigned.</p> : null}
      </div>

      {admin && addable.length ? (
        <div style={{ ...row, borderTop: 0, padding: '8px 0 0' }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ ...field, flex: '1 1 200px' }} aria-label="Teammate to add">
            <option value="">Add a teammate…</option>
            {addable.map((t) => <option key={t.user_id} value={t.user_id}>{t.full_name || t.email} · {ROLE_LABEL[t.role] ?? t.role}</option>)}
          </select>
          <button type="button" className="dc3" style={primary} disabled={busy || !pick}
            onClick={() => void run(() => addRoundRobinMember(workspaceId, r.id, pick), `${nameOf(pick)} added.`).then(() => setPick(''))}>
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}
