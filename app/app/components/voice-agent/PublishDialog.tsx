// Publish: push the saved draft to ElevenLabs and make it what calls use. The
// dialog shows what will change (the live agent against the draft), warnings
// worth a look, and for a first publish the things the template left for the
// owner to confirm (company promises the agent would otherwise say to sellers).
// Then it shows the result: checks, manual steps, model fallback, errors.
'use client';

import React, { useEffect, useState } from 'react';
import type { Api, PublishOutcome } from '@/lib/voice-agent-client';
import type { DiffResult, PromptWarning, PublishResult, TemplateInfo } from '@/lib/voice-agent';
import { Banner, Dialog, GREEN, INK, LINE, MUTED, Skeleton, Spinner, ghost, linkBtn, primary } from './kit';
import { DiffView } from './DiffView';
import { PublishResultView } from './PublishResult';

type Diff = { at: 'loading' } | { at: 'ready'; diff: DiffResult } | { at: 'error'; error: string } | { at: 'first' };

export function PublishDialog({ api, agentKey, liveVersion, templateId, chosenModel, mode = 'publish', rollbackTo, onClose, onDone, onOpenPreview }: {
  api: Api; agentKey: string; liveVersion: number; templateId: string; chosenModel: string; mode?: 'publish' | 'rollback'; rollbackTo?: number;
  onClose: () => void; onDone: (r: PublishResult) => void; onOpenPreview?: () => void;
}) {
  const first = liveVersion <= 0;
  const [diff, setDiff] = useState<Diff>(first ? { at: 'first' } : { at: 'loading' });
  const [warnings, setWarnings] = useState<PromptWarning[]>([]);
  const [template, setTemplate] = useState<TemplateInfo | null>(null);
  const [ticked, setTicked] = useState<Record<number, boolean>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);

  useEffect(() => {
    let live = true;
    if (mode === 'rollback' && rollbackTo) {
      void api.diff(agentKey, 'live', rollbackTo).then((r) => { if (live) setDiff(r.ok ? { at: 'ready', diff: r.data } : { at: 'error', error: r.error }); });
    } else if (!first) {
      void api.diff(agentKey, 'live', 'draft').then((r) => { if (live) setDiff(r.ok ? { at: 'ready', diff: r.data } : { at: 'error', error: r.error }); });
    }
    if (mode === 'publish') {
      void api.previewPrompt(agentKey).then((r) => { if (live && r.ok) setWarnings(r.data.warnings.filter((w) => w.level === 'warning')); });
      if (first && templateId) void api.templates().then((r) => { if (live && r.ok) setTemplate(r.data.templates.find((t) => t.id === templateId) ?? null); });
    }
    return () => { live = false; };
  }, [api, agentKey, first, mode, rollbackTo, templateId]);

  const items = template?.open_items ?? [];
  const allTicked = items.every((_, i) => ticked[i]);
  const blocked = mode === 'publish' && first && items.length > 0 && !allTicked;
  const noChanges = mode === 'publish' && !first && diff.at === 'ready' && diff.diff.changes.length === 0 && diff.diff.prompt.added.length === 0 && diff.diff.prompt.removed.length === 0;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    const r = mode === 'rollback' && rollbackTo ? await api.rollback(agentKey, rollbackTo, note) : await api.publish(agentKey, note);
    setBusy(false);
    setOutcome(r);
    if (r.ok) onDone(r.data);
  };

  const title = mode === 'rollback' ? `Roll back to v${rollbackTo}` : first ? 'Publish this agent' : `Publish v${liveVersion + 1}`;
  const done = outcome?.ok === true;
  return (
    <Dialog title={outcome ? (done ? (mode === 'rollback' ? 'Rolled back' : 'Published') : 'Publish did not finish') : title} titleId="va-publish-title" onClose={onClose} busy={busy} width={680}
      footer={outcome ? (
        <>
          {!done ? <button type="button" className="va-btn va-ghost" style={ghost} onClick={() => setOutcome(null)}>Back</button> : null}
          <button type="button" className="va-btn va-prim" style={primary()} onClick={onClose} data-autofocus>Close</button>
        </>
      ) : (
        <>
          <button type="button" className="va-btn va-ghost" style={ghost} disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="va-btn va-prim" style={{ ...primary(busy || blocked || noChanges), minWidth: 130 }} disabled={busy || blocked || noChanges} onClick={() => void run()} data-autofocus>
            {busy ? <Spinner size={14} /> : null}{busy ? 'Publishing…' : mode === 'rollback' ? `Roll back to v${rollbackTo}` : first ? 'Publish' : `Publish v${liveVersion + 1}`}
          </button>
        </>
      )}>
      {outcome ? (
        outcome.data ? <PublishResultView result={outcome.data} chosenModel={chosenModel} error={outcome.ok ? undefined : outcome.error} /> : <Banner tone="error">{outcome.ok ? '' : outcome.error}</Banner>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: INK }}>
            {mode === 'rollback'
              ? `This publishes the settings from v${rollbackTo} as a new version. History is kept, nothing is deleted.`
              : first
                ? 'This creates the agent in ElevenLabs, connects its webhooks and tool, and makes these settings what calls use.'
                : 'This sends the saved draft to ElevenLabs. Calls started after it use the new version; a call already in progress finishes on the old one.'}
          </p>

          {diff.at === 'loading' ? <div aria-busy="true" aria-label="Loading changes" style={{ display: 'grid', gap: 8 }}><Skeleton h={18} w="40%" /><Skeleton h={54} /><Skeleton h={54} /></div> : null}
          {diff.at === 'error' ? <Banner tone="warn">Could not compare with the live agent. {diff.error} You can still publish.</Banner> : null}
          {diff.at === 'first' ? <Banner tone="info">First publish: there is no live version to compare with.</Banner> : null}
          {diff.at === 'ready' ? <DiffView diff={diff.diff} /> : null}
          {noChanges ? <Banner tone="info">Nothing has changed since v{liveVersion}, so there is nothing to publish.</Banner> : null}

          {warnings.length ? (
            <Banner tone="warn" action={onOpenPreview ? <button type="button" className="va-btn" style={linkBtn} onClick={onOpenPreview}>Review in the preview</button> : undefined}>
              <strong>{warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'} worth a look:</strong> {warnings.slice(0, 2).map((w) => w.message).join(' ')}{warnings.length > 2 ? ` And ${warnings.length - 2} more.` : ''}
            </Banner>
          ) : null}

          {mode === 'publish' && first && items.length ? (
            <fieldset style={{ margin: 0, padding: '12px 14px', border: `1px solid ${LINE}`, borderRadius: 10 }}>
              <legend style={{ padding: '0 6px', fontSize: 12.5, fontWeight: 600, color: INK }}>Confirm before the first publish</legend>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>The {template?.name.toLowerCase()} template left these for you to decide. Tick each once it is settled.</p>
              <div style={{ display: 'grid', gap: 8 }}>
                {items.map((t, i) => (
                  <label key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.5, color: INK, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!ticked[i]} onChange={(e) => setTicked((s) => ({ ...s, [i]: e.target.checked }))} style={{ width: 16, height: 16, marginTop: 2, accentColor: GREEN, flex: 'none' }} />
                    <span>{t}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <div>
            <label htmlFor="va-publish-note" style={{ display: 'block', fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>Note (optional)</label>
            <input id="va-publish-note" className="va-field" value={note} maxLength={200} placeholder="What changed and why" onChange={(e) => setNote(e.target.value)}
              style={{ width: '100%', height: 36, padding: '0 11px', border: `1px solid ${LINE}`, borderRadius: 9, fontSize: 13, outline: 0, background: '#fafafa', color: INK, fontFamily: 'inherit', boxSizing: 'border-box' }} />
            <p style={{ margin: '5px 0 0', fontSize: 12, color: MUTED }}>Shown in History next to the version.</p>
          </div>
        </div>
      )}
    </Dialog>
  );
}
