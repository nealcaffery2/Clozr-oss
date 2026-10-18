// Settings → Phone numbers → RVM number pool. Which lines carry ringless
// voicemail (and which are kept for live dialing), the state each serves,
// today's drops against its warm-up cap, and how many lines per state the
// lead mix suggests. Informational about buying: nothing here buys a number.
//
// Writes go through caller_line_set() (migration 135, owner/admin) and the
// workspace's settings.rvm_pool. rvm-tick reads both (lib/rvm-pool.ts).
'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { formatPhone } from '@/lib/talkr';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session';
import { loadSettings, saveSettings } from '@/lib/integrations';
import { forgetLinePools } from '@/lib/line-pools';
import { lineOwner, useLineNames } from '@/lib/line-names';
import { localMidnightIso } from '@/lib/rvm';
import { DEFAULT_RVM_CEILING, DEFAULT_RVM_RAMP, lineUsable, rampCap, rampDay, stateCode2, stateOfPhone, suggestPool, type RvmPoolSettings } from '@/lib/rvm-pool';
import { Btn, INK, LINE, MUTED, NoteBox, card, errText, field, label, type Note } from './ui';

type Row = {
  phone_e164: string; label: string | null; assigned_user_id?: string | null;
  pool: 'rvm' | 'dialer' | null; market_state: string | null; daily_cap: number | null; ramp_started_at: string | null;
  spam_risk: string | null;
};
type Health = { phone_e164: string; paused: boolean; grade: string | null; spam_risk: string | null };

const POOL_LABEL: Record<string, string> = { rvm: 'RVM pool', dialer: 'Dialer pool', '': 'Not pooled' };

export function RvmPool({ numbers, admin, onBuy }: { numbers: { phone_e164: string; label: string | null; assigned_user_id?: string | null }[]; admin: boolean; onBuy?: () => void }) {
  const wsId = useSession().workspace?.id ?? null;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [health, setHealth] = useState<Map<string, Health>>(new Map());
  const [used, setUsed] = useState<Record<string, number>>({});
  const [byState, setByState] = useState<Record<string, number>>({});
  const [settings, setSettings] = useState<RvmPoolSettings>({});
  const [want, setWant] = useState(10);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [rampText, setRampText] = useState('');
  const [ceiling, setCeiling] = useState('');
  const [cost, setCost] = useState('');

  const load = useCallback(async () => {
    if (!supabase || wsId == null) return;
    const sb = supabase;
    let res = await sb.from('caller_lines').select('phone_e164, pool, market_state, daily_cap, ramp_started_at, spam_risk').eq('workspace_id', wsId);
    const lacksColumns = !!res.error;
    if (res.error) res = await sb.from('caller_lines').select('phone_e164, spam_risk').eq('workspace_id', wsId) as typeof res;
    setMissing(lacksColumns);
    const have = new Map(((res.data ?? []) as unknown as Partial<Row>[]).map((r) => [r.phone_e164!, r]));
    const all = new Map<string, Row>();
    for (const n of numbers) {
      const r = have.get(n.phone_e164);
      all.set(n.phone_e164, { phone_e164: n.phone_e164, label: n.label, assigned_user_id: n.assigned_user_id ?? null, pool: (r?.pool as Row['pool']) ?? null, market_state: r?.market_state ?? null, daily_cap: r?.daily_cap ?? null, ramp_started_at: r?.ramp_started_at ?? null, spam_risk: r?.spam_risk ?? null });
    }
    for (const [phone, r] of have) if (!all.has(phone)) all.set(phone, { phone_e164: phone, label: null, pool: (r.pool as Row['pool']) ?? null, market_state: r.market_state ?? null, daily_cap: r.daily_cap ?? null, ramp_started_at: r.ramp_started_at ?? null, spam_risk: r.spam_risk ?? null });
    setRows([...all.values()].sort((a, b) => a.phone_e164.localeCompare(b.phone_e164)));

    const { data: h } = await sb.from('number_health').select('phone_e164, paused, grade, spam_risk').eq('workspace_id', wsId);
    setHealth(new Map(((h ?? []) as Health[]).map((x) => [x.phone_e164, x])));

    const midnight = localMidnightIso(new Date(), 'America/Chicago');
    const { data: today } = await sb.from('rvm_drops').select('from_e164').eq('workspace_id', wsId).gte('sent_at', midnight).not('from_e164', 'is', null).limit(20_000);
    const counts: Record<string, number> = {};
    for (const d of (today ?? []) as { from_e164: string | null }[]) if (d.from_e164) counts[d.from_e164] = (counts[d.from_e164] ?? 0) + 1;
    setUsed(counts);

    const { data: leads } = await sb.from('sellers').select('properties(state)').eq('workspace_id', wsId).is('archived_at', null).limit(10_000);
    const st: Record<string, number> = {};
    for (const l of (leads ?? []) as unknown as { properties: { state: string | null } | { state: string | null }[] | null }[]) {
      const p = Array.isArray(l.properties) ? l.properties[0] : l.properties;
      const code = stateCode2(p?.state);
      if (code) st[code] = (st[code] ?? 0) + 1;
    }
    setByState(st);

    const s = (await loadSettings(wsId)).rvm_pool ?? {};
    setSettings(s);
    setRampText((s.ramp ?? DEFAULT_RVM_RAMP).join(', '));
    setCeiling(String(s.ceiling ?? DEFAULT_RVM_CEILING));
    setCost(s.cost_per_drop != null ? String(s.cost_per_drop) : '');
  }, [wsId, numbers]);

  // Load when the workspace or the line list changes. Done during render rather
  // than in an effect: load() writes state, and set-state-in-effect fails CI.
  // The assignment is in the key too, so reassigning a line refreshes its owner.
  const loadKey = `${wsId}|${numbers.map((n) => `${n.phone_e164}:${n.assigned_user_id ?? ''}`).join(',')}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  if (wsId != null && loadedKey !== loadKey) {
    setLoadedKey(loadKey);
    void load();
  }

  const suggestion = useMemo(() => suggestPool(byState, want), [byState, want]);
  const pooled = (rows ?? []).filter((r) => r.pool === 'rvm');
  // A rep's own line (assigned in Talkr, or named in rep_phone_numbers) is
  // their caller ID. The pool keeps its lines off live calls, so a rep's line
  // in it blocks their dialer: one rep's line sat there for days.
  useLineNames();
  const ownerOf = (r: Row) => lineOwner(r);
  const haveByState = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of pooled) { const s = stateCode2(r.market_state) ?? stateOfPhone(r.phone_e164) ?? '?'; m[s] = (m[s] ?? 0) + 1; }
    return m;
  }, [pooled]);

  if (wsId == null || !supabase) return null;

  const save = async (r: Row, patch: Partial<Row>) => {
    if (!supabase) return;
    const next = { ...r, ...patch };
    // An assigned line is blocked even before the names load (or when its owner has none on file).
    const owner = ownerOf(r) || (r.assigned_user_id ? 'a teammate' : '');
    if (next.pool === 'rvm' && r.pool !== 'rvm' && owner) {
      setNote({ ok: false, text: `${formatPhone(r.phone_e164)} is ${owner}'s line. Lines in the RVM pool are kept off live calls, so ${owner} could not dial from it. Unassign it in Talkr first, or pick another line.` });
      return;
    }
    setBusy(r.phone_e164); setNote(null);
    const { error } = await supabase.rpc('caller_line_set', {
      p_workspace: wsId, p_phone: next.phone_e164, p_pool: next.pool, p_state: next.market_state,
      p_daily_cap: next.daily_cap, p_ramp_started_at: next.ramp_started_at,
    });
    setBusy(null);
    if (error) { setNote({ ok: false, text: /caller_line_set/.test(error.message) ? 'The RVM pool needs migration 135 applied first.' : errText(error) }); return; }
    forgetLinePools();
    await load();
  };

  const saveRamp = async () => {
    const ramp = rampText.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0).map(Math.floor);
    const ceil = Number(ceiling);
    const c = cost.trim() === '' ? null : Number(cost);
    if (c != null && (!Number.isFinite(c) || c < 0)) { setNote({ ok: false, text: 'Cost per drop is a dollar amount, like 0.05.' }); return; }
    setBusy('ramp'); setNote(null);
    const next: RvmPoolSettings = { ramp: ramp.length ? ramp : null, ceiling: Number.isFinite(ceil) && ceil > 0 ? Math.floor(ceil) : null, cost_per_drop: c };
    const r = await saveSettings(wsId, { rvm_pool: next });
    setBusy(null);
    setNote(r.ok ? { ok: true, text: 'Warm-up saved. The next tick uses it.' } : { ok: false, text: r.message ?? 'Not saved.' });
    if (r.ok) setSettings(next);
  };

  const now = new Date();
  return (
    <div style={card} data-testid="rvm-pool">
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 600, flex: 1 }}>RVM number pool</h2>
        <span style={{ fontSize: '12px', color: MUTED }}>{pooled.length} line{pooled.length === 1 ? '' : 's'} in the pool</span>
        <Btn small onClick={() => void load()}>Refresh</Btn>
      </div>
      <p style={{ margin: '0 0 10px', fontSize: '12.5px', color: MUTED, lineHeight: 1.5 }}>
        Lines in the RVM pool carry ringless voicemail (Slybroadcast shows the line as the caller ID) and stay off live calls. A drop goes out on a line in the lead&rsquo;s state, then a neighbouring state or their area code, then any pool line, and never past the line&rsquo;s cap for today. A new line warms up: {DEFAULT_RVM_RAMP[0]} drops on day one, rising to {DEFAULT_RVM_CEILING} a day by day {DEFAULT_RVM_RAMP.length}. A line the guard paused or graded At risk is skipped. With no pool set, drops rotate across every line as before. CLOZR tells Talkr who sent each drop; turn on &ldquo;Ring the rep who last reached out first&rdquo; on a line above and a callback rings that rep first.
      </p>
      {missing ? <div style={{ fontSize: '12px', color: 'var(--tx-amber-deep, #92400e)', background: 'var(--caution-soft, #fef3c7)', borderRadius: '8px', padding: '7px 10px', marginBottom: '10px' }}>The pool columns arrive with migration 135. Until it is applied, drops rotate across every line.</div> : null}

      {rows === null ? <div style={{ fontSize: '12.5px', color: MUTED }}>Loading lines…</div> : (
        <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px', minWidth: '560px' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: MUTED }}>
                {['Line', 'Pool', 'State', 'Today / cap', 'Ramp day', 'Max/day', 'Health'].map((h) => <th key={h} style={{ ...label, padding: '8px 10px', margin: 0 }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const h = health.get(r.phone_e164);
                const ok = lineUsable({ paused: h?.paused, grade: h?.grade, spam_risk: h?.spam_risk ?? r.spam_risk });
                const day = rampDay(r.ramp_started_at, now);
                const cap = rampCap(day, settings, r.daily_cap);
                const st = stateCode2(r.market_state) ?? stateOfPhone(r.phone_e164);
                const dis = !admin || busy === r.phone_e164 || missing;
                const owner = ownerOf(r);
                return (
                  <tr key={r.phone_e164} style={{ borderTop: '1px solid var(--divider-2, #f0f0f1)' }}>
                    <td style={{ padding: '7px 10px', color: INK, whiteSpace: 'nowrap' }}>
                      {formatPhone(r.phone_e164)}{owner ? <span style={{ color: MUTED }}> · {owner}</span> : null}{r.label && r.label.toLowerCase() !== owner.toLowerCase() ? <span style={{ color: MUTED }}> · {r.label}</span> : null}
                      {r.pool === 'rvm' && owner ? <div style={{ fontSize: '11.5px', color: 'var(--tx-red, #b91c1c)', whiteSpace: 'normal' }}>{owner}&rsquo;s line, blocked from live calls while pooled.</div> : null}
                    </td>
                    <td style={{ padding: '7px 10px' }}>
                      <select aria-label={`Pool for ${r.phone_e164}`} disabled={dis} value={r.pool ?? ''} style={field}
                        onChange={(e) => void save(r, { pool: (e.target.value || null) as Row['pool'], ramp_started_at: e.target.value === 'rvm' && r.pool !== 'rvm' ? null : r.ramp_started_at })}>
                        {Object.entries(POOL_LABEL).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '7px 10px' }}>
                      <input aria-label={`State for ${r.phone_e164}`} disabled={dis} defaultValue={r.market_state ?? ''} placeholder={st ?? 'ST'} maxLength={2}
                        style={{ ...field, width: '52px' }}
                        onBlur={(e) => { const v = stateCode2(e.target.value); if ((v ?? null) !== (r.market_state ?? null)) void save(r, { market_state: v }); }} />
                    </td>
                    <td style={{ padding: '7px 10px', fontVariantNumeric: 'tabular-nums', color: r.pool === 'rvm' && (used[r.phone_e164] ?? 0) >= cap ? '#b91c1c' : INK }}>
                      {r.pool === 'rvm' ? `${used[r.phone_e164] ?? 0} / ${cap}` : used[r.phone_e164] ? `${used[r.phone_e164]} today` : '—'}
                    </td>
                    <td style={{ padding: '7px 10px', color: MUTED }}>{r.pool === 'rvm' ? (day == null ? 'warm' : `day ${day + 1}`) : '—'}</td>
                    <td style={{ padding: '7px 10px' }}>
                      <input aria-label={`Daily cap for ${r.phone_e164}`} disabled={dis} defaultValue={r.daily_cap ?? ''} placeholder="ramp" inputMode="numeric"
                        style={{ ...field, width: '64px' }}
                        onBlur={(e) => { const raw = e.target.value.trim(); const v = raw === '' ? null : Math.max(0, Math.floor(Number(raw))); if (raw !== '' && !Number.isFinite(v)) return; if (v !== r.daily_cap) void save(r, { daily_cap: v }); }} />
                    </td>
                    <td style={{ padding: '7px 10px', color: ok ? 'var(--tx-green, #15803d)' : '#b91c1c', whiteSpace: 'nowrap' }}>{h?.paused ? 'Paused' : !ok ? 'Skipped (at risk)' : h?.grade === 'watch' ? 'Watch' : 'Good'}</td>
                  </tr>
                );
              })}
              {!rows.length ? <tr><td colSpan={7} style={{ padding: '10px', color: MUTED }}>No lines yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: `1px solid ${LINE}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span style={{ ...label, margin: 0 }}>Suggested pool</span>
          <span style={{ fontSize: '12.5px', color: INK }}>for</span>
          <input aria-label="Lines in the pool" value={want} inputMode="numeric" onChange={(e) => setWant(Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0))))} style={{ ...field, width: '56px' }} />
          <span style={{ fontSize: '12.5px', color: INK }}>lines, from where your leads are</span>
          {onBuy && admin ? <Btn small onClick={onBuy}>Buy a number…</Btn> : null}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
          {suggestion.map((s) => {
            const have = haveByState[s.state] ?? 0;
            return (
              <span key={s.state} style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '8px', border: `1px solid ${LINE}`, background: have >= s.lines ? 'var(--positive-soft, #dcfce7)' : 'var(--canvas, #fafafa)' }}>
                <b>{s.state}</b> {s.lines} line{s.lines === 1 ? '' : 's'} <span style={{ color: MUTED }}>· {s.leads} leads · have {have}</span>
              </span>
            );
          })}
          {!suggestion.length ? <span style={{ fontSize: '12px', color: MUTED }}>No lead states on file yet.</span> : null}
        </div>
        <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '6px' }}>
          No state gets more than half the pool; states left without a line use a neighbouring state&rsquo;s line. Buy local numbers in each state&rsquo;s biggest area codes, then mark them RVM pool here. Nothing is bought from this card.
        </div>
      </div>

      {admin ? (
        <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: `1px solid ${LINE}`, display: 'grid', gap: '6px' }}>
          <span style={{ ...label, margin: 0 }}>Warm-up and cost</span>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <input aria-label="Warm-up ramp" value={rampText} onChange={(e) => setRampText(e.target.value)} style={{ ...field, flex: '1 1 260px' }} title="Drops per line on day 1, day 2, …" />
            <input aria-label="Ceiling per line" value={ceiling} onChange={(e) => setCeiling(e.target.value)} style={{ ...field, width: '72px' }} title="Most drops per line per day once warm" />
            <input aria-label="Cost per drop" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="$/drop" style={{ ...field, width: '72px' }} title="Slybroadcast's price per delivered drop, for the blast results" />
            <Btn small primary disabled={busy === 'ramp'} onClick={() => void saveRamp()}>{busy === 'ramp' ? 'Saving…' : 'Save'}</Btn>
          </div>
          <div style={{ fontSize: '11.5px', color: MUTED }}>Drops per line on day 1, day 2, … (the last number holds after), the most per line per day once warm, and the price per delivered drop.</div>
        </div>
      ) : null}
      <NoteBox note={note} />
    </div>
  );
}
