// AI Agent, History: every published version, what changed in it, and a way
// back. History is append-only: a rollback publishes the old settings as a new
// version, so nothing is ever lost.
'use client';

import React, { useEffect, useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import type { DiffResult, Result, VersionRow } from '@/lib/voice-agent';
import type { DiffRef } from '@/lib/voice-agent-client';
import { timeAgo } from '@/lib/voice-agent';
import { Badge, Banner, Empty, LINE, MUTED, INK, Section, Segmented, Skeleton, ghost, GREEN } from '../kit';
import { DiffView } from '../DiffView';
import { PublishDialog } from '../PublishDialog';
import type { TabCtx } from '../types';

type Load = { at: 'loading' } | { at: 'ready'; live: number; versions: VersionRow[] } | { at: 'error'; error: string };
type Sel = { kind: 'draft' } | { kind: 'version'; v: number };
type Against = 'previous' | 'live' | 'draft';
type DiffLoad = { at: 'idle' } | { at: 'loading' } | { at: 'ready'; diff: DiffResult } | { at: 'error'; error: string };

export function HistoryTab({ api, agentKey, epoch, canEdit, detail, form, jump, onRolledBack }: TabCtx) {
  const [load, setLoad] = useState<Load>({ at: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [sel, setSel] = useState<Sel>({ kind: 'draft' });
  const [against, setAgainst] = useState<Against>('previous');
  const [rollback, setRollback] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void api.versions(agentKey).then((r) => {
      if (!live) return;
      setLoad(r.ok ? { at: 'ready', live: r.data.live_version, versions: r.data.versions } : { at: 'error', error: r.error });
      setNow(Date.now());
    });
    return () => { live = false; };
  }, [api, agentKey, nonce, epoch]);

  const versions = load.at === 'ready' ? load.versions : [];
  const oldest = versions.length ? versions[versions.length - 1]!.version : 0;
  const selVersion = sel.kind === 'version' ? sel.v : 0;
  const effAgainst: Against = sel.kind === 'version' && against === 'previous' && selVersion <= oldest ? 'live' : against;

  // The diff being asked for. `got` holds the last answer with the request it was for, so a stale answer reads as loading.
  const liveV = load.at === 'ready' ? load.live : 0;
  const reqKey = load.at !== 'ready' ? '' : sel.kind === 'draft' ? (liveV > 0 ? 'live>draft' : 'none') : effAgainst === 'previous' ? `${selVersion - 1}>${selVersion}` : effAgainst === 'live' ? `${selVersion}>live` : `${selVersion}>draft`;
  const [got, setGot] = useState<{ key: string; r: Result<DiffResult> } | null>(null);
  useEffect(() => {
    if (!reqKey || reqKey === 'none') return;
    let live = true;
    const [from, to] = reqKey.split('>') as [string, string];
    const ref = (x: string): DiffRef => (x === 'live' || x === 'draft' ? x : Number(x));
    void api.diff(agentKey, ref(from), ref(to)).then((r) => { if (live) setGot({ key: reqKey, r }); });
    return () => { live = false; };
  }, [api, agentKey, reqKey, epoch]);
  const diff: DiffLoad = reqKey === 'none' ? { at: 'idle' } : !reqKey || got?.key !== reqKey ? { at: 'loading' } : got.r.ok ? { at: 'ready', diff: got.r.data } : { at: 'error', error: got.r.error };

  return (
    <>
      <Section id="va-history" title="Versions" description="Each publish is a version. Pick one to see what it changed, or roll back to it."
        aside={<button type="button" className="va-btn va-ghost" style={ghost} onClick={() => { setLoad({ at: 'loading' }); setNonce((n) => n + 1); }} disabled={load.at === 'loading'}>Refresh</button>}>
        {load.at === 'loading' ? (
          <div aria-busy="true" aria-label="Loading versions" style={{ display: 'grid', gap: 8 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={54} style={{ borderRadius: 10 }} />)}</div>
        ) : load.at === 'error' ? (
          <Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={() => { setLoad({ at: 'loading' }); setNonce((n) => n + 1); }}>Try again</button>}>Could not load the versions. {load.error}</Banner>
        ) : (
          <div role="radiogroup" aria-label="Version to inspect" style={{ display: 'grid', gap: 6 }}>
            <button type="button" role="radio" aria-checked={sel.kind === 'draft'} className="va-btn va-row" onClick={() => setSel({ kind: 'draft' })}
              style={{ display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '10px 12px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${sel.kind === 'draft' ? GREEN : LINE}`, background: sel.kind === 'draft' ? '#E7F8F1' : '#fff', boxShadow: sel.kind === 'draft' ? `0 0 0 1px ${GREEN}` : 'none' }}>
              <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 999, flex: 'none', display: 'grid', placeItems: 'center', background: '#fef3c7', color: '#92400e' }}><History size={15} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: INK }}>Draft against live</span>
                <span style={{ display: 'block', fontSize: 12, color: MUTED }}>{detail.has_unpublished_changes || form.dirty ? 'What publishing would change' : 'The draft matches what is live'}</span>
              </span>
              {detail.has_unpublished_changes ? <Badge tone="amber">Unpublished</Badge> : null}
            </button>
            {versions.length === 0 ? <Empty title="No versions yet">The first publish creates version 1.</Empty> : versions.map((v) => {
              const on = sel.kind === 'version' && sel.v === v.version;
              return (
                <div key={v.version} style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 10, border: `1px solid ${on ? GREEN : LINE}`, background: on ? '#E7F8F1' : '#fff', boxShadow: on ? `0 0 0 1px ${GREEN}` : 'none', flexWrap: 'wrap', padding: '2px 4px 2px 0' }}>
                  <button type="button" role="radio" aria-checked={on} className="va-btn" onClick={() => setSel({ kind: 'version', v: v.version })}
                    style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', padding: '9px 12px', border: 0, background: 'transparent', cursor: 'pointer', fontFamily: 'inherit' }}>
                    <span style={{ width: 34, height: 34, borderRadius: 9, flex: 'none', display: 'grid', placeItems: 'center', background: v.is_live ? GREEN : '#f4f4f5', color: v.is_live ? '#fff' : INK, fontSize: 12.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>v{v.version}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>{v.note || 'No note'}</span>
                        {v.is_live ? <Badge tone="green">Live</Badge> : null}
                      </span>
                      <span style={{ display: 'block', fontSize: 12, color: MUTED }}>{timeAgo(v.created_at, now) || 'Unknown time'} · {v.prompt_tokens.toLocaleString('en-US')} tokens{v.created_by ? ` · ${v.created_by}` : ''}</span>
                    </span>
                  </button>
                  {!v.is_live ? (
                    <button type="button" className="va-btn va-ghost" disabled={!canEdit} title={canEdit ? undefined : 'Only owners and admins can roll back'} aria-label={`Roll back to version ${v.version}`} onClick={() => setRollback(v.version)} style={{ ...ghost, height: 30, marginRight: 6 }}>
                      <RotateCcw size={14} aria-hidden="true" /> Roll back
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {load.at === 'ready' ? (
        <Section id="va-diff" title={sel.kind === 'draft' ? 'Draft against live' : `Version ${selVersion}`} description={sel.kind === 'draft' ? 'The settings and prompt lines that publishing would change.' : 'Choose what to compare it with.'}>
          {sel.kind === 'version' ? (
            <div style={{ marginBottom: 12 }}>
              <Segmented<Against> label="Compare with" value={effAgainst} onChange={setAgainst}
                options={[{ id: 'previous', label: `What v${selVersion} changed` }, { id: 'live', label: 'Compare with live' }, { id: 'draft', label: 'Compare with draft' }].filter((o) => o.id !== 'previous' || selVersion > oldest) as { id: Against; label: string }[]} />
            </div>
          ) : null}
          {diff.at === 'loading' ? <div aria-busy="true" aria-label="Comparing" style={{ display: 'grid', gap: 8 }}><Skeleton h={18} w="40%" /><Skeleton h={54} /><Skeleton h={54} /></div> : null}
          {diff.at === 'error' ? <Banner tone="error">Could not compare. {diff.error}</Banner> : null}
          {diff.at === 'idle' ? <Empty title="Nothing published yet">Publish the agent and its first version appears here.</Empty> : null}
          {diff.at === 'ready' ? <DiffView diff={diff.diff} onJump={sel.kind === 'draft' || effAgainst === 'draft' ? jump : undefined} /> : null}
          {form.dirty && (sel.kind === 'draft' || effAgainst === 'draft') ? <div style={{ marginTop: 12 }}><Banner tone="info">This compares the saved draft. Your unsaved edits are not in it.</Banner></div> : null}
        </Section>
      ) : null}

      {rollback ? (
        <PublishDialog api={api} agentKey={agentKey} liveVersion={detail.live_version} templateId="" chosenModel={detail.settings.voice.tts_model} mode="rollback" rollbackTo={rollback}
          onClose={() => setRollback(null)} onDone={() => onRolledBack()} />
      ) : null}
    </>
  );
}
