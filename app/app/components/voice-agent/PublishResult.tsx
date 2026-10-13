// What a publish (or rollback) came back with: the checks that now pass, the
// steps ElevenLabs does not let CLOZR do (with the value to paste), a notice if
// the speech model was swapped, and anything that failed.
'use client';

import React from 'react';
import { Check, Minus } from 'lucide-react';
import { CHECK_ROWS, modelDiffers, ttsLabel, type PublishResult } from '@/lib/voice-agent';
import { Banner, CopyButton, GREEN, INK, LINE, MUTED, mono } from './kit';

export function PublishResultView({ result, chosenModel, error }: { result: PublishResult; chosenModel: string; error?: string }) {
  const fellBack = modelDiffers(chosenModel, result.tts_model_used);
  const ok = !error && !result.errors.length;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {error ? <Banner tone="error">{error}</Banner> : <Banner tone={result.errors.length ? 'warn' : 'ok'}>{result.errors.length ? `Published v${result.live_version}, but some steps failed.` : `Published. Version ${result.live_version} is live.`}</Banner>}

      {result.errors.length ? (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
          {result.errors.map((e, i) => <li key={i}><Banner tone="error">{e.step ? <strong>{e.step}: </strong> : null}{e.message}</Banner></li>)}
        </ul>
      ) : null}

      {fellBack ? (
        <Banner tone="warn">You chose <strong>{ttsLabel(chosenModel)}</strong>, but the agent is running on <strong>{ttsLabel(result.tts_model_used ?? '')}</strong>. ElevenLabs refused the first for phone agents. Your choice is kept and tried again on the next publish.</Banner>
      ) : null}

      <div>
        <div style={{ fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>Checks</div>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, border: `1px solid ${LINE}`, borderRadius: 10, overflow: 'hidden' }}>
          {CHECK_ROWS.map((c, i) => {
            const pass = result.checks[c.key];
            return (
              <li key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderTop: i ? '1px solid #f0f0f1' : 'none' }}>
                <span aria-hidden="true" style={{ width: 20, height: 20, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 999, background: pass ? GREEN : '#f4f4f5', color: pass ? '#fff' : '#a1a1aa', border: pass ? 0 : `1px solid ${LINE}` }}>
                  {pass ? <Check size={13} strokeWidth={3} /> : <Minus size={13} strokeWidth={3} />}
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: INK }}>{c.label}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: pass ? GREEN : '#92400e' }}>{pass ? 'Ready' : 'Needs attention'}</span>
              </li>
            );
          })}
        </ul>
      </div>

      {result.manual.length ? (
        <div style={{ padding: '12px 14px', borderRadius: 10, background: '#fffbeb', border: '1px solid #fde68a' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#92400e' }}>{result.manual.length === 1 ? 'One step' : `${result.manual.length} steps`} ElevenLabs does not let CLOZR do</div>
          <p style={{ margin: '2px 0 10px', fontSize: 12, color: '#92400e', lineHeight: 1.45 }}>Copy each value into the place named. Publish again afterwards to confirm.</p>
          <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
            {result.manual.map((m, i) => (
              <li key={i} style={{ background: '#fff', border: '1px solid #fde68a', borderRadius: 9, padding: '10px 12px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>{i + 1}. {m.step}</div>
                {m.where ? <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{m.where}</div> : null}
                {m.value_to_paste ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                    <span style={{ ...mono, flex: '1 1 200px', minWidth: 0, padding: '7px 10px', border: `1px solid ${LINE}`, borderRadius: 8, background: '#fafafa' }}>{m.value_to_paste}</span>
                    <CopyButton value={m.value_to_paste} />
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </div>
      ) : ok ? <p style={{ margin: 0, fontSize: 12.5, color: MUTED }}>No manual steps this time.</p> : null}
    </div>
  );
}
