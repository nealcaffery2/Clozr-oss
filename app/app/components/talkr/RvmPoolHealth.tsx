'use client';

/**
 * The RVM tab's Pool health card, for owners and admins: each pool line's
 * protection (registry, reputation, CNAM, branded calling, spam label,
 * attestation), what rotation retired and why, replacement requests to
 * approve, and the spending switch for buying replacements (migration 197).
 * The pool itself (which lines, their state and cap) is set under Settings →
 * Phone numbers; this card only reads it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatPhone } from '@/lib/talkr';
import { loadSettings } from '@/lib/integrations';
import { replaceSettings, type ReplaceMode } from '@/lib/rvm-rotation';
import { worseRisk } from '@/lib/rvm-pool';
import type { CallerLine, NumberHealth, RvmPoolEvent } from '@/lib/database.types';
import { Button } from './ui';

const small: React.CSSProperties = { font: '400 11.5px/1.4 var(--sans)', color: 'var(--muted)' };
const chip = (tone: 'good' | 'warn' | 'bad' | 'off'): React.CSSProperties => ({
  font: '600 10.5px/1 var(--sans)', padding: '3px 6px', borderRadius: 6, whiteSpace: 'nowrap',
  color: tone === 'good' ? '#0A8560' : tone === 'warn' ? '#b45309' : tone === 'bad' ? '#b91c1c' : '#52525b',
  background: tone === 'good' ? '#dcfce7' : tone === 'warn' ? '#fef3c7' : tone === 'bad' ? '#fee2e2' : '#f4f4f5',
});

const EVENT_LABEL: Record<RvmPoolEvent['action'], string> = {
  retired: 'Retired', restored: 'Restored', purchase_requested: 'Replacement requested', purchased: 'Bought',
  purchase_skipped: 'Not bought', purchase_failed: 'Purchase failed', dismissed: 'Request dismissed', policy_changed: 'Settings changed',
};

const FCR_LABEL: Record<string, string> = {
  queued: 'Registry queued', submitting: 'Registry submitting', submitted: 'Registry filed', code_ready: 'Registry code ready',
  verified: 'Registry verified', registered: 'Registered', failed: 'Registry refused',
};

export function RvmPoolHealth({ workspaceId }: { workspaceId: number | null }) {
  const [lines, setLines] = useState<CallerLine[] | null>(null);
  const [health, setHealth] = useState<Map<string, NumberHealth>>(new Map());
  const [events, setEvents] = useState<RvmPoolEvent[]>([]);
  const [mode, setMode] = useState<ReplaceMode>('off');
  const [cap, setCap] = useState('0');
  const [retireOn, setRetireOn] = useState<'high' | 'medium'>('high');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // The workspace the latest load is for: a slower answer for another workspace is dropped.
  const loadingFor = useRef<number | null>(null);
  const load = useCallback(async () => {
    if (!supabase || workspaceId == null) return;
    loadingFor.current = workspaceId;
    const [l, h, e, settings] = await Promise.all([
      supabase.from('caller_lines').select('*').eq('workspace_id', workspaceId).eq('pool', 'rvm').order('phone_e164'),
      supabase.from('number_health').select('*').eq('workspace_id', workspaceId),
      supabase.from('rvm_pool_events').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(40),
      loadSettings(workspaceId).catch(() => null),
    ]);
    if (loadingFor.current !== workspaceId) return;
    if (l.error) { setNote(`Could not load the pool: ${l.error.message}`); return; }
    setLines((l.data ?? []) as CallerLine[]);
    setHealth(new Map(((h.data ?? []) as NumberHealth[]).map((r) => [r.phone_e164, r])));
    // Before migration 197 there is no events table; the card still shows the lines.
    setEvents(e.error ? [] : (e.data ?? []) as RvmPoolEvent[]);
    const r = replaceSettings(settings?.rvm_pool ?? null);
    setMode(r.mode); setCap(String(r.monthlyCap));
    setRetireOn(settings?.rvm_pool?.replace?.retire_on === 'medium' ? 'medium' : 'high');
  }, [workspaceId]);
  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key); setNote(null);
    try { setNote(await fn()); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); }
    setBusy(null);
    void load();
  };
  type PoolReply = { ok?: boolean; error?: string; dryRun?: boolean; phone?: string; results?: { retired?: string[] }[] };
  const invoke = async (body: Record<string, unknown>): Promise<{ error: string } | { reply: PoolReply }> => {
    if (!supabase) return { error: 'Sign in first.' };
    const { data, error } = await supabase.functions.invoke('rvm-pool', { body: { workspace_id: workspaceId, ...body } });
    return error ? { error: error.message } : { reply: (data ?? {}) as PoolReply };
  };
  const check = () => run('check', async () => {
    const r = await invoke({ action: 'rotate' });
    if ('error' in r) return r.error;
    const retired = (r.reply.results ?? []).flatMap((x) => x.retired ?? []);
    return retired.length ? `Retired ${retired.map((p) => formatPhone(p)).join(', ')}.` : 'Every pool line passed.';
  });
  const approve = (id: number) => run(`approve:${id}`, async () => {
    const r = await invoke({ action: 'approve', event_id: id });
    if ('error' in r) return r.error;
    const out = r.reply;
    if (!out.ok) return out.error ?? 'Not bought.';
    return out.dryRun
      ? `Dry run: ${formatPhone(out.phone ?? '')} is for sale, but purchases are switched off on the server (RVM_POOL_LIVE_PURCHASES). The request stays open.`
      : `Bought ${formatPhone(out.phone ?? '')}. It joins the pool on day 1 of the warm-up.`;
  });
  const dismiss = (id: number) => run(`dismiss:${id}`, async () => {
    const { error } = await supabase!.rpc('rvm_pool_dismiss', { p_ws: workspaceId!, p_event: id });
    return error ? error.message : 'Dismissed. Nothing was bought.';
  });
  const restore = (phone: string) => run(`restore:${phone}`, async () => {
    const { error } = await supabase!.rpc('rvm_pool_restore', { p_ws: workspaceId!, p_phone: phone });
    return error ? error.message : `${formatPhone(phone)} is back in the pool.`;
  });
  const saveReplace = () => run('replace', async () => {
    const n = Math.max(0, Math.min(50, Math.floor(Number(cap) || 0)));
    const { error } = await supabase!.rpc('rvm_pool_set_replace', { p_ws: workspaceId!, p_mode: mode, p_monthly_cap: n, p_retire_on: retireOn });
    return error ? error.message : 'Saved.';
  });

  if (workspaceId == null) return null;
  // Still loading, or the load failed: say so rather than show nothing.
  if (lines === null) return note ? <span role="status" style={small}>{note}</span> : null;
  const open = events.filter((e) => e.action === 'purchase_requested' && e.status === 'open');
  const live = lines.filter((l) => !l.retired_at);

  return (
    <section className="flex flex-col gap-2" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', padding: 12 }} data-testid="rvm-pool-health">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto" style={{ font: '700 12.5px/1.2 var(--sans)' }}>Pool health · {live.length} of {lines.length} line{lines.length === 1 ? '' : 's'} carrying drops</span>
        <Button tone="ghost" disabled={busy !== null} onClick={() => void check()} style={{ padding: '6px 10px', font: '600 11.5px/1 var(--sans)' }}>
          {busy === 'check' ? 'Checking…' : 'Check now'}
        </Button>
      </div>
      {lines.length === 0 && <span style={small}>No line is in the RVM pool. An admin marks lines under Settings → Phone numbers.</span>}
      <ul className="flex flex-col" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {lines.map((l) => {
          const h = health.get(l.phone_e164);
          const risk = worseRisk(h?.spam_risk, l.spam_risk);
          const att = h?.attestation_calls_7d ? `${Math.round(Number(h.attestation_a_7d ?? 0) * 100)}% A of ${h.attestation_calls_7d} calls` : null;
          return (
            <li key={l.phone_e164} className="flex flex-col gap-1" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
              <span className="flex flex-wrap items-center gap-1.5">
                <span style={{ font: '600 12px/1 var(--sans)', fontVariantNumeric: 'tabular-nums', marginRight: 4 }}>{formatPhone(l.phone_e164)}</span>
                <span style={chip(l.market_state ? 'off' : 'warn')}>{l.market_state ?? 'No state set'}</span>
                {l.retired_at ? <span style={chip('bad')}>Retired</span> : <span style={chip('good')}>In rotation</span>}
                <span style={chip(l.fcr_status === 'failed' ? 'bad' : ['verified', 'registered', 'submitted'].includes(l.fcr_status) ? 'good' : 'warn')}>{FCR_LABEL[l.fcr_status] ?? l.fcr_status}</span>
                <span style={chip(l.reputation_enrolled ? 'good' : 'warn')}>{l.reputation_enrolled ? 'Reputation on' : 'Reputation not enrolled'}</span>
                <span style={chip(l.branded_attached ? 'good' : 'off')}>{l.branded_attached ? 'Branded' : 'Not branded'}</span>
                {(l.talkr_number_id || l.cnam_listed) ? null : <span style={chip('warn')}>CNAM not listed</span>}
                {h ? <span style={chip(h.ten_dlc_assigned ? 'good' : 'warn')}>{h.ten_dlc_assigned ? '10DLC' : 'Not on 10DLC'}</span> : null}
                {risk ? <span style={chip(risk === 'high' ? 'bad' : risk === 'medium' ? 'warn' : 'good')}>Spam {risk}{l.spam_category ? ` · ${l.spam_category}` : ''}</span> : null}
                {att ? <span style={chip(Number(h?.attestation_a_7d ?? 1) < 0.9 ? 'warn' : 'good')}>{att}</span> : null}
              </span>
              {l.retired_at && (
                <span className="flex flex-wrap items-center gap-2" style={small}>
                  <span className="mr-auto">Out since {new Date(l.retired_at).toLocaleDateString()}: {l.retired_reason ?? 'flagged'}.{l.replaced_by ? ` Replaced by ${formatPhone(l.replaced_by)}.` : ''} Callbacks to it are still credited.</span>
                  <Button tone="ghost" disabled={busy !== null} onClick={() => void restore(l.phone_e164)} style={{ padding: '5px 9px', font: '600 11px/1 var(--sans)' }}>Put back</Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {open.length > 0 && (
        <div className="flex flex-col gap-1.5" style={{ paddingTop: 8, borderTop: '1px solid var(--line)' }}>
          <span style={{ font: '700 11px/1 var(--sans)', color: 'var(--muted)' }}>Waiting for you</span>
          {open.map((e) => (
            <span key={e.id} className="flex flex-wrap items-center gap-2" style={small}>
              <span className="mr-auto">Replace {formatPhone(e.phone_e164 ?? '')} with a local number ({new Date(e.created_at).toLocaleDateString()}).</span>
              <Button tone="green" disabled={busy !== null} onClick={() => void approve(e.id)} style={{ padding: '5px 9px', font: '600 11px/1 var(--sans)' }}>{busy === `approve:${e.id}` ? 'Buying…' : 'Approve and buy'}</Button>
              <Button tone="ghost" disabled={busy !== null} onClick={() => void dismiss(e.id)} style={{ padding: '5px 9px', font: '600 11px/1 var(--sans)' }}>Dismiss</Button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5" style={{ paddingTop: 8, borderTop: '1px solid var(--line)' }}>
        <span style={{ font: '700 11px/1 var(--sans)', color: 'var(--muted)' }}>When a line is retired</span>
        <span className="flex flex-wrap items-center gap-2">
          <select aria-label="Replacement" value={mode} onChange={(e) => setMode(e.target.value as ReplaceMode)} style={{ height: 28, borderRadius: 7, border: '1px solid var(--line)', font: '500 12px/1 var(--sans)' }}>
            <option value="off">Don&apos;t buy a replacement</option>
            <option value="approve">Ask an admin to approve each purchase</option>
            <option value="auto">Buy a local replacement automatically</option>
          </select>
          <label style={small}>up to <input aria-label="Purchases a month" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, '').slice(0, 2))} style={{ width: 40, height: 26, borderRadius: 6, border: '1px solid var(--line)', textAlign: 'center' }} /> a month</label>
          <select aria-label="Retire on" value={retireOn} onChange={(e) => setRetireOn(e.target.value === 'medium' ? 'medium' : 'high')} style={{ height: 28, borderRadius: 7, border: '1px solid var(--line)', font: '500 12px/1 var(--sans)' }}>
            <option value="high">Retire on a high spam label</option>
            <option value="medium">Retire on a medium or high spam label</option>
          </select>
          <Button tone="ghost" disabled={busy !== null} onClick={() => void saveReplace()} style={{ padding: '6px 10px', font: '600 11.5px/1 var(--sans)' }}>Save</Button>
        </span>
        <span style={small}>A line is retired on a spam label, an At risk grade or a pause from the number guard, a Free Caller Registry refusal, or under 90% A-signed calls. It runs every morning after the number guard. Every retire and purchase is logged below, and owners and admins are told.</span>
      </div>

      {events.length > 0 && (
        <details>
          <summary style={{ ...small, cursor: 'pointer' }}>Log · last {events.length}</summary>
          <ul className="flex flex-col gap-0.5" style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
            {events.map((e) => (
              <li key={e.id} style={small}>
                {new Date(e.created_at).toLocaleString()} · <b style={{ fontWeight: 600, color: 'var(--text)' }}>{EVENT_LABEL[e.action] ?? e.action}</b>{e.phone_e164 ? ` · ${formatPhone(e.phone_e164)}` : ''}{e.reason ? ` · ${e.reason}` : ''}{e.status === 'open' ? ' · open' : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {note && <span role="status" style={{ ...small, color: 'var(--text)' }}>{note}</span>}
    </section>
  );
}
