'use client';

/**
 * The RVM tab: recordings the dialer can drop, and the drops action plans
 * have queued. Starting a session walks the ready rows in predictive mode.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { supabase } from '@/lib/supabase';
import { RVM_SKIP_SENTENCES } from '@/lib/rvm';
import { Button } from './ui';
import { useVmLibrary } from './useVmLibrary';
import { openVoicemailRecorder } from './VoicemailDrop';
import { blastSummaries, type BlastDrop, type BlastSummary } from '@/lib/rvm-blasts';
import { loadSettings } from '@/lib/integrations';
import { formatPhone } from '@/lib/talkr';
import { RvmPoolHealth } from './RvmPoolHealth';

type DropRow = {
  id: number;
  seller_id: number | null;
  buyer_id: number | null;
  phone_e164: string | null;
  script: string | null;
  status: string;
  skip_reason: string | null;
  scheduled_at: string;
  last_error: string | null;
  provider: string | null;
  sent_at: string | null;
};

const STATUS_LABEL: Record<string, { label: string; color: string; bg: string }> = {
  queued: { label: 'Queued', color: '#3f3f46', bg: '#f4f4f5' },
  ready: { label: 'Ready for the tab', color: '#3f3f46', bg: '#f4f4f5' },
  sending: { label: 'With the carrier', color: '#b45309', bg: '#fef3c7' },
  dialing: { label: 'Dropping', color: '#b45309', bg: '#fef3c7' },
  dropped: { label: 'Dropped', color: '#0A8560', bg: '#dcfce7' },
  failed: { label: 'Failed', color: '#b91c1c', bg: '#fee2e2' },
};
const PROVIDER: Record<string, string> = { dropcowboy: 'Drop Cowboy', slybroadcast: 'Slybroadcast', telnyx: 'Telnyx' };

export function RvmPanel({ V }: { V: ClozrView }) {
  const workspaceId = V.templatesWorkspaceId;
  const lib = useVmLibrary(workspaceId);
  const [drops, setDrops] = useState<DropRow[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const loadDrops = useCallback(async () => {
    if (!supabase || workspaceId == null) return;
    // Open drops plus the last week's failures, so a drop that did not go out
    // says why instead of quietly leaving the list.
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data, error } = await supabase.from('rvm_drops')
      .select('id, seller_id, buyer_id, phone_e164, script, status, skip_reason, scheduled_at, last_error, provider, sent_at')
      .eq('workspace_id', workspaceId)
      .or(`status.in.(queued,ready,dialing,sending),and(status.eq.failed,scheduled_at.gte.${since})`)
      .order('scheduled_at', { ascending: false })
      .limit(60);
    if (error) { setNote(`Could not load the drops: ${error.message}`); return; }
    setDrops((data ?? []) as DropRow[]);
  }, [workspaceId]);

  useEffect(() => { void loadDrops(); }, [loadDrops]);

  // Blast results: the last 30 days of drops, by send.
  const [blasts, setBlasts] = useState<BlastSummary[] | null>(null);
  const [openBlast, setOpenBlast] = useState<string | null>(null);
  const loadBlasts = useCallback(async () => {
    if (!supabase || workspaceId == null) return;
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    let res = await supabase.from('rvm_drops')
      .select('id, blast_id, enrollment_id, created_by, created_at, status, from_e164, callback_at, pool_tier')
      .eq('workspace_id', workspaceId).gte('created_at', since).order('created_at', { ascending: false }).limit(5000);
    // Before migration 198 there is no pool_tier.
    if (res.error) {
      res = await supabase.from('rvm_drops')
        .select('id, blast_id, enrollment_id, created_by, created_at, status, from_e164, callback_at')
        .eq('workspace_id', workspaceId).gte('created_at', since).order('created_at', { ascending: false }).limit(5000) as unknown as typeof res;
    }
    // Before migration 135: no blast_id or callback columns, so sends group by sender and hour.
    if (res.error) {
      res = await supabase.from('rvm_drops')
        .select('id, enrollment_id, created_by, created_at, status, from_e164')
        .eq('workspace_id', workspaceId).gte('created_at', since).order('created_at', { ascending: false }).limit(5000) as unknown as typeof res;
    }
    const settings = await loadSettings(workspaceId).catch(() => null);
    setBlasts(blastSummaries((res.data ?? []) as unknown as BlastDrop[], settings?.rvm_pool?.cost_per_drop ?? null));
  }, [workspaceId]);
  useEffect(() => { void loadBlasts(); }, [loadBlasts]);

  const ready = drops.filter((d) => d.status === 'ready' || d.status === 'queued');
  const failed = drops.filter((d) => d.status === 'failed');
  const start = async () => {
    if (!supabase) return;
    const dialable = ready.filter((d) => d.phone_e164);
    if (!dialable.length) { setNote('Nothing with a number is ready to drop.'); return; }
    // The setup sheet opens first; the drops are marked dialing only once the session runs.
    const started = await V.startCallList('RVM', dialable.map((d) => ({
      name: d.script?.slice(0, 42) || 'Voicemail',
      phone: d.phone_e164!,
      ...(d.seller_id ? { personId: 's' + d.seller_id } : {}),
      ...(d.buyer_id ? { buyerId: 'b' + d.buyer_id } : {}),
    })), 'predictive');
    if (!started) return;
    await supabase.from('rvm_drops').update({ status: 'dialing' }).in('id', dialable.map((d) => d.id)).in('status', ['ready', 'queued']);
    void loadDrops();
  };

  return (
    <div className="flex flex-col gap-3 px-1" data-testid="rvm-panel">
      <p style={{ font: '400 12px/1.45 var(--sans)', color: 'var(--muted)', margin: 0 }}>
        Ringless voicemail goes out through Drop Cowboy or Slybroadcast when those accounts are connected, between 8am and 8pm the property’s time. It skips do-not-call, anyone you spoke with in the last week, and a number that already got a drop in the last three days. Recordings take turns, and a repeat is the one they heard longest ago. Without a ringless account, this tab walks the list and drops the recording on the live call.
      </p>
      <div className="flex flex-wrap items-center gap-2" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', padding: 12 }}>
        <span className="mr-auto" style={{ font: '600 12px/1.35 var(--sans)' }}>Record a voicemail, hear it back, then save it.</span>
        <Button tone="green" onClick={() => openVoicemailRecorder()}>Record voicemail</Button>
      </div>
      {lib.clips.length > 0 && (
        <ul className="flex flex-col gap-1" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {lib.clips.map((c) => (
            <li key={c.id} style={{ font: '500 12px/1.3 var(--sans)' }}>
              {c.name}{c.seconds ? ` · ${c.seconds}s` : ''}{c.audio_path ? (/\.webm$/i.test(c.audio_path) ? (c.script ? ' · WebM, the script is spoken instead' : ' · WebM, record again to drop it') : '') : ' · script only'}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <span style={{ font: '600 12px/1 var(--sans)' }}>{ready.length} waiting</span>
        <Button tone="green" disabled={!ready.length || !!V.queueSession} onClick={() => void start()}>Drop these</Button>
      </div>
      {drops.length > 0 && (
        <div className="flex items-center justify-between">
          <span style={{ font: '500 11.5px/1 var(--sans)', color: 'var(--muted)' }}>{failed.length ? `${failed.length} failed this week` : 'Drops'}</span>
          <Button tone="ghost" onClick={() => void loadDrops()} style={{ padding: '6px 10px', font: '600 11.5px/1 var(--sans)' }}>Refresh</Button>
        </div>
      )}
      <ul className="flex flex-col gap-1" style={{ margin: 0, padding: 0, listStyle: 'none' }} data-testid="rvm-drops">
        {drops.map((d) => {
          const st = STATUS_LABEL[d.status] ?? { label: d.status, color: '#3f3f46', bg: '#f4f4f5' };
          const why = d.status === 'failed' || d.status === 'ready' ? d.last_error : null;
          return (
            <li key={d.id} style={{ font: '400 12px/1.35 var(--sans)', color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0', borderTop: '1px solid var(--line)' }}>
              <span className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{d.phone_e164 || 'No number'}</span>
                <span style={{ font: '600 11px/1 var(--sans)', padding: '3px 6px', borderRadius: 6, color: st.color, background: st.bg }}>{st.label}</span>
                {d.provider ? <span>via {PROVIDER[d.provider] ?? d.provider}</span> : null}
              </span>
              {d.skip_reason && d.status === 'queued' ? <span>{RVM_SKIP_SENTENCES[d.skip_reason] ?? d.skip_reason}</span> : null}
              {why ? <span role={d.status === 'failed' ? 'alert' : undefined} style={{ color: d.status === 'failed' ? '#b91c1c' : 'var(--muted)' }}>{why}</span> : null}
            </li>
          );
        })}
      </ul>
      {V.rvmPoolAdmin && <RvmPoolHealth workspaceId={workspaceId} />}
      <BlastResults blasts={blasts} open={openBlast} onToggle={(k) => setOpenBlast(openBlast === k ? null : k)} onRefresh={() => void loadBlasts()} me={V.callbackUserId} />
      {(note || lib.error) && <span role="status" style={{ font: '500 12px/1.35 var(--sans)', color: 'var(--muted)' }}>{note || lib.error}</span>}
    </div>
  );
}

const pctOf = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—');
const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Each RVM send in the last 30 days: delivered, failed, callbacks, cost, and the same per line. */
function BlastResults({ blasts, open, onToggle, onRefresh, me }: {
  blasts: BlastSummary[] | null; open: string | null; onToggle: (key: string) => void; onRefresh: () => void; me: string | null;
}) {
  if (!blasts) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="rvm-blasts" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <div className="flex items-center justify-between">
        <span style={{ font: '600 12px/1 var(--sans)' }}>Blast results · 30 days</span>
        <Button tone="ghost" onClick={onRefresh} style={{ padding: '6px 10px', font: '600 11.5px/1 var(--sans)' }}>Refresh</Button>
      </div>
      {!blasts.length ? <span style={{ font: '400 12px/1.35 var(--sans)', color: 'var(--muted)' }}>No ringless sends in the last 30 days.</span> : null}
      {blasts.map((b) => (
        <div key={b.key} style={{ borderTop: '1px solid var(--line)', padding: '5px 0', font: '400 12px/1.4 var(--sans)', color: 'var(--muted)' }}>
          <button type="button" onClick={() => onToggle(b.key)} aria-expanded={open === b.key}
            style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexWrap: 'wrap', gap: '2px 8px', width: '100%' }}>
            <span style={{ color: 'var(--text)', fontWeight: 600 }}>
              {b.kind === 'plan' ? 'Action plans' : new Date(b.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              {b.kind === 'blast' && b.created_by && b.created_by === me ? ' · yours' : ''}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {b.total} queued · {b.delivered} delivered ({pctOf(b.delivered, b.total)}) · {b.failed ? <span style={{ color: '#b91c1c' }}>{b.failed} failed</span> : '0 failed'}
              {b.pending ? ` · ${b.pending} waiting` : ''}{b.skipped ? ` · ${b.skipped} skipped` : ''}
              {' · '}<b style={{ color: 'var(--text)' }}>{b.callbacks} callback{b.callbacks === 1 ? '' : 's'}</b> ({pctOf(b.callbacks, b.delivered)})
              {b.cost != null ? ` · ${money(b.cost)}` : ''}
              {b.tiered ? ` · ${pctOf(b.local, b.tiered)} local caller ID` : ''}
            </span>
          </button>
          {open === b.key && b.lines.length ? (
            <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none' }}>
              {b.lines.map((l) => (
                <li key={l.line} style={{ display: 'flex', gap: 8, fontVariantNumeric: 'tabular-nums' }}>
                  <span style={{ color: 'var(--text)', minWidth: 112 }}>{formatPhone(l.line)}</span>
                  <span>{l.sent} sent · {l.delivered} delivered · {l.failed} failed · {l.callbacks} callbacks</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}
