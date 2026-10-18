// Preview prompt: the exact system prompt the server would assemble from the
// current form (unsaved edits included), its size, and what to look at before
// publishing. Each warning names a settings path, which becomes a button that
// closes the drawer and takes you to that field.
'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import type { Api } from '@/lib/voice-agent-client';
import type { AgentSettings, FieldErrors, PromptPreview } from '@/lib/voice-agent';
import { groupWarnings, pathLabel, pathTab } from '@/lib/voice-agent-console';
import { Banner, CopyButton, Dialog, INK, LINE, MUTED, Skeleton, ghost, linkBtn, mono } from './kit';

type Load = { at: 'loading' } | { at: 'ready'; preview: PromptPreview } | { at: 'error'; error: string; errors: string[] };

export function PreviewDrawer({ api, agentKey, settings, sendDraft, onClose, onJump }: {
  api: Api; agentKey: string; settings: AgentSettings;
  /** True when the form differs from what is saved: the preview then uses the form, not the stored draft. */
  sendDraft: boolean; onClose: () => void; onJump: (path: string) => void; errors?: FieldErrors;
}) {
  const [load, setLoad] = useState<Load>({ at: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    void api.previewPrompt(agentKey, sendDraft ? settings : undefined).then((r) => {
      if (!live) return;
      setLoad(r.ok ? { at: 'ready', preview: r.data } : { at: 'error', error: r.error, errors: r.errors ?? [] });
    });
    return () => { live = false; };
    // The drawer previews what the form held when it opened; editing behind it is not possible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, agentKey, nonce]);

  const groups = load.at === 'ready' ? groupWarnings(load.preview.warnings) : null;
  const row = (w: { code: string; message: string; path: string | null; level: string }, i: number) => (
    <li key={`${w.code}${i}`} style={{ display: 'flex', gap: 10, padding: '9px 12px', borderTop: i ? '1px solid var(--divider-2, #f0f0f1)' : 'none', background: 'var(--surface, #fff)' }}>
      <span aria-hidden="true" style={{ flex: 'none', marginTop: 2, color: w.level === 'warning' ? '#b45309' : MUTED }}>{w.level === 'warning' ? <AlertTriangle size={15} /> : <Info size={15} />}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12.5, lineHeight: 1.5, color: INK }}>{w.message}</span>
        {w.path && pathTab(w.path) ? (
          <button type="button" className="va-btn" style={{ ...linkBtn, fontSize: 12, marginTop: 3 }} onClick={() => { onClose(); onJump(w.path!); }}>Go to {pathLabel(w.path).split(' · ').slice(0, 2).join(' · ')}</button>
        ) : null}
      </span>
    </li>
  );

  return (
    <Dialog title="Prompt preview" titleId="va-preview-title" placement="right" width={620} onClose={onClose}
      footer={<><button type="button" className="va-btn va-ghost" style={ghost} onClick={onClose} data-autofocus>Close</button></>}>
      {load.at === 'loading' ? (
        <div aria-busy="true" aria-label="Building the prompt" style={{ display: 'grid', gap: 10 }}><Skeleton h={20} w="45%" /><Skeleton h={60} /><Skeleton h={220} /></div>
      ) : load.at === 'error' ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <Banner tone="error" action={<button type="button" className="va-btn va-ghost" style={ghost} onClick={() => { setLoad({ at: 'loading' }); setNonce((n) => n + 1); }}>Try again</button>}>
            The prompt could not be built. {load.errors.length ? '' : load.error}
          </Banner>
          {load.errors.length ? <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--tx-red, #b91c1c)', lineHeight: 1.6 }}>{load.errors.map((e, i) => <li key={i}>{e}</li>)}</ul> : null}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: MUTED }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: INK, fontVariantNumeric: 'tabular-nums' }}>{load.preview.tokens.toLocaleString('en-US')} tokens</span>
            <span>about {(load.preview.prompt.length).toLocaleString('en-US')} characters. Shorter prompts answer faster.</span>
            {api.demo ? <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--surface-2, #f4f4f5)', color: 'var(--muted, #52525b)' }}>Demo, simplified</span> : null}
          </div>

          {groups && (groups.warnings.length || groups.notes.length) ? (
            <div>
              <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>Worth a look</div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
                {[...groups.warnings, ...groups.notes].map(row)}
              </ul>
            </div>
          ) : <Banner tone="ok">Nothing to flag.</Banner>}

          {load.preview.not_applied.length ? (
            <div>
              <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>Saved but not sent to ElevenLabs</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: INK, lineHeight: 1.6 }}>{load.preview.not_applied.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          ) : null}

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ flex: 1, fontSize: 11.5, color: MUTED, fontWeight: 600 }}>The prompt</span>
              <CopyButton value={load.preview.prompt} label="Copy prompt" />
            </div>
            <pre tabIndex={0} aria-label="Assembled prompt" style={{ ...mono, margin: 0, padding: '12px 14px', border: `1px solid ${LINE}`, borderRadius: 10, background: 'var(--canvas, #fafafa)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, maxHeight: 'none' }}>{load.preview.prompt}</pre>
          </div>
        </div>
      )}
    </Dialog>
  );
}
