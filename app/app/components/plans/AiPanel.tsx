// The AI box. Describe the plan and the tone and it drafts one; with a plan
// open, say what to change and it revises it. Either way the result lands
// in the editor for review and is not saved until Save.
'use client';

import React, { useState } from 'react';
import type { AiReview } from './usePlans';
import { Btn, INK, LINE, MINT, MINT_BG, MUTED, label, smallInput, smallSelect, textarea } from './ui';

const TONES = ['Warm and plain', 'Direct, no fluff', 'Friendly neighbour', 'Professional', 'Casual, texting a friend', 'Urgent but respectful'];

export function AiPanel({
  hasPlan, busy, review, tone, onGenerate, onEdit, onUndo, onDismiss,
}: {
  hasPlan: boolean; busy: boolean; review: AiReview | null; tone: string;
  onGenerate: (goal: string, tone: string, steps: number | null) => void;
  onEdit: (instruction: string, tone: string) => void;
  onUndo: () => void; onDismiss: () => void;
}) {
  const [mode, setMode] = useState<'goal' | 'edit'>(hasPlan ? 'edit' : 'goal');
  const [goal, setGoal] = useState('');
  const [instruction, setInstruction] = useState('');
  const [toneText, setToneText] = useState(tone);
  const [steps, setSteps] = useState<string>('');

  const effective = hasPlan ? mode : 'goal';

  const run = () => {
    if (busy) return;
    if (effective === 'goal') onGenerate(goal, toneText, steps ? Number(steps) : null);
    else { onEdit(instruction, toneText); setInstruction(''); }
  };

  return (
    <div style={{ background: '#141419', color: '#fff', borderRadius: '12px', padding: '14px 16px', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'radial-gradient(120% 90% at 90% -10%, rgba(10, 133, 96,0.34), transparent 58%)' }} />
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '11.5px', color: 'rgba(255,255,255,.6)', fontWeight: 600 }}>Draft with AI</span>
          {hasPlan ? (
            <span style={{ display: 'inline-flex', background: 'rgba(255,255,255,.08)', borderRadius: '7px', padding: '2px' }}>
              {(['edit', 'goal'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} style={{ height: '22px', padding: '0 9px', borderRadius: '5px', border: 0, background: mode === m ? '#fff' : 'transparent', color: mode === m ? INK : 'rgba(255,255,255,.75)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {m === 'edit' ? 'Edit this plan' : 'Start over'}
                </button>
              ))}
            </span>
          ) : null}
        </div>
        {effective === 'goal' ? (
          <textarea
            value={goal} onChange={(e) => setGoal(e.target.value)} rows={3}
            placeholder="Describe the plan and the tone… e.g. “A 7-touch sequence for a cold direct-mail lead who never answered. Two texts, a call, an email, another text, a task to check the record, and a last text with an easy out. Warm, not salesy.”"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run(); }}
            style={{ ...textarea, marginTop: '10px', background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)', color: '#fff' }}
          />
        ) : (
          <textarea
            value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2}
            placeholder="What should change? e.g. “make the texts shorter”, “add a call on day 5”, “drop the email and add a stage change to Nurture at the end”"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') run(); }}
            style={{ ...textarea, marginTop: '10px', background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)', color: '#fff' }}
          />
        )}
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label style={{ flex: 1, minWidth: '160px' }}>
            <span style={{ ...label, color: 'rgba(255,255,255,.6)' }}>Tone</span>
            <input list="plan-tones" value={toneText} onChange={(e) => setToneText(e.target.value)} placeholder="Warm and plain" style={{ ...smallInput, height: '30px', background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)', color: '#fff' }} />
            <datalist id="plan-tones">{TONES.map((t) => <option key={t} value={t} />)}</datalist>
          </label>
          {effective === 'goal' ? (
            <label style={{ width: '110px' }}>
              <span style={{ ...label, color: 'rgba(255,255,255,.6)' }}>Steps</span>
              <select value={steps} onChange={(e) => setSteps(e.target.value)} style={{ ...smallSelect, height: '30px', background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.14)', color: '#fff' }}>
                <option value="" style={{ color: INK }}>Let it decide</option>
                {[3, 4, 5, 6, 7, 8, 10, 12].map((n) => <option key={n} value={n} style={{ color: INK }}>{n} steps</option>)}
              </select>
            </label>
          ) : null}
          <Btn kind="primary" onClick={run} disabled={busy || (effective === 'goal' ? !goal.trim() : !instruction.trim())} style={{ height: '30px' }}>
            {busy ? 'Thinking…' : effective === 'goal' ? 'Draft plan' : 'Revise plan'}
          </Btn>
        </div>
        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,.5)', marginTop: '6px' }}>
          ⌘/Ctrl + Enter to run. Nothing is saved until you press Save.
        </div>
      </div>
      {review ? (
        <div style={{ position: 'relative', marginTop: '12px', background: '#fff', color: INK, borderRadius: '10px', padding: '10px 12px', border: `1px solid ${LINE}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '11.5px', color: MINT, fontWeight: 700 }}>
              {review.kind === 'edit' ? 'What the AI changed' : review.before ? 'Replaced the plan' : 'Drafted'}
            </span>
            <span style={{ flex: 1 }} />
            {review.before ? <Btn small onClick={onUndo}>Undo</Btn> : null}
            <Btn small onClick={onDismiss}>Looks good</Btn>
          </div>
          {review.changes.length ? (
            <ul style={{ margin: '8px 0 0', padding: '0 0 0 16px', fontSize: '12.5px', color: '#27272a', lineHeight: 1.55 }}>
              {review.changes.slice(0, 20).map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          ) : (
            <div style={{ fontSize: '12.5px', color: MUTED, marginTop: '6px' }}>Read through the steps below, edit anything by hand, then Save.</div>
          )}
          {review.kind === 'goal' && review.before ? (
            <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '6px', background: MINT_BG, borderRadius: '6px', padding: '5px 8px' }}>The trigger and “when it ends” link were kept from the plan you had open.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
