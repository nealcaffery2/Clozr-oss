// One step in the sequence: what kind, how long after the last one, and the
// fields that kind needs. Drag the handle to reorder; the arrows do the same
// for a keyboard or a phone.
'use client';

import React, { useRef } from 'react';
import { RvmRecordingPicker } from '@/app/components/talkr/RvmRecordingPicker';
import { SELLER_STAGE_LABELS } from '@/lib/stages';
import { type DelayUnit, type PlanStepDraft, type Priority, type StepType, type Teammate, CAPABILITIES, CAPABILITY_LABEL, DELAY_UNITS, MERGE_FIELDS, STEP_TYPES, stepMeta } from '@/lib/plans';
import { Btn, FAINT, INK, LINE, MUTED, label, smallInput, smallSelect, textarea } from './ui';

export function StepCard({
  step, index, total, team, tags, dragging, onPatch, onRemove, onDuplicate, onMove, onAddAfter, onDragStart, onDragOver, onDrop, onDragEnd, workspaceId = null,
}: {
  step: PlanStepDraft; index: number; total: number; team: Teammate[]; tags: string[]; dragging: boolean;
  /** For an RVM step's recording picker; null in preview. */
  workspaceId?: number | null;
  onPatch: (p: Partial<PlanStepDraft>) => void; onRemove: () => void; onDuplicate: () => void;
  onMove: (dir: -1 | 1) => void; onAddAfter: (t: StepType) => void;
  onDragStart: () => void; onDragOver: (e: React.DragEvent) => void; onDrop: () => void; onDragEnd: () => void;
}) {
  const meta = stepMeta(step.type);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const compr = step.type === 'compr_report';
  const hasBody = step.type === 'sms' || step.type === 'email' || step.type === 'call' || step.type === 'task' || compr || step.type === 'rvm';
  const hasPriority = step.type === 'task' || step.type === 'call';
  const hasAssignee = hasPriority || step.type === 'assign';

  const insertField = (f: string) => {
    const el = bodyRef.current;
    const token = `{{${f}}}`;
    if (!el) return onPatch({ body: step.body + token });
    const a = el.selectionStart ?? step.body.length;
    const b = el.selectionEnd ?? a;
    const next = step.body.slice(0, a) + token + step.body.slice(b);
    onPatch({ body: next });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  };

  const bodyPlaceholder =
    compr ? 'The message that carries the report. Put {{report_link}} where the link goes, e.g. "Hi {{first_name}}, here is the numbers report on {{address}}: {{report_link}}"'
    : step.type === 'rvm' ? 'What the recording says, as its written record (and what the carrier reads aloud if no recording is picked). It goes out 8am–8pm their time, and it skips anyone marked do not call or spoken with in the last week.'
    : step.type === 'sms' ? 'The text to send. Keep it short, ask one thing, give an easy out. Use {{first_name}} and {{address}}.'
      : step.type === 'email' ? 'The email body.'
        : step.type === 'call' ? 'Talking points for the call — what to ask, what to listen for.'
          : 'What the rep needs to do.';

  return (
    <div
      onDragOver={onDragOver} onDrop={onDrop}
      style={{ display: 'grid', gridTemplateColumns: '26px minmax(0,1fr)', gap: '12px', marginBottom: '10px', opacity: dragging ? 0.4 : 1 }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span style={{ width: '26px', height: '26px', borderRadius: '999px', background: '#fff', border: `1px solid ${LINE}`, display: 'grid', placeItems: 'center', fontSize: '11px', fontWeight: 700, color: '#52525b', flex: 'none' }}>{index + 1}</span>
        <span style={{ flex: 1, width: '1px', background: LINE, marginTop: '6px' }} />
      </div>
      <div className="dc19" style={{ background: '#fff', border: `1px solid ${dragging ? '#0A8560' : LINE}`, borderRadius: '10px', padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span
            draggable onDragStart={onDragStart} onDragEnd={onDragEnd} title="Drag to reorder"
            style={{ cursor: 'grab', color: FAINT, fontSize: '15px', lineHeight: 1, padding: '2px 2px 2px 0', userSelect: 'none' }}
          >⋮⋮</span>
          <select
            value={step.type} onChange={(e) => onPatch({ type: e.target.value as StepType, ...(e.target.value === 'ai_agent' && !step.allowed ? { allowed: [...CAPABILITIES] } : {}) })}
            style={{ ...smallSelect, width: 'auto', height: '26px', padding: '0 6px', fontSize: '11px', fontWeight: 700, color: meta.color, background: meta.bg, border: `1px solid ${LINE}` }}
          >
            {STEP_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
          </select>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: MUTED }}>
            {index === 0 ? 'after enrolment, wait' : 'then wait'}
            <input
              type="number" min={0} value={step.delay}
              onChange={(e) => onPatch({ delay: Math.max(0, Number(e.target.value) || 0) })}
              style={{ ...smallInput, width: '58px', height: '26px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
            />
            <select value={step.unit} onChange={(e) => onPatch({ unit: e.target.value as DelayUnit })} style={{ ...smallSelect, width: 'auto', height: '26px' }}>
              {DELAY_UNITS.map((u) => <option key={u.v} value={u.v}>{u.label}</option>)}
            </select>
          </span>
          {step.type !== 'wait' && step.type !== 'stage' && step.type !== 'tag' && step.type !== 'assign' ? (
            <input
              value={step.title} onChange={(e) => onPatch({ title: e.target.value })} placeholder="Step name"
              style={{ ...smallInput, flex: 1, minWidth: '140px', height: '26px', fontWeight: 600 }}
            />
          ) : <span style={{ flex: 1 }} />}
          <span style={{ display: 'inline-flex', gap: '4px' }}>
            <Btn small onClick={() => onMove(-1)} disabled={index === 0} title="Move up" style={{ width: '26px', padding: 0, justifyContent: 'center' }}>↑</Btn>
            <Btn small onClick={() => onMove(1)} disabled={index === total - 1} title="Move down" style={{ width: '26px', padding: 0, justifyContent: 'center' }}>↓</Btn>
            <Btn small onClick={onDuplicate} title="Duplicate step" style={{ width: '26px', padding: 0, justifyContent: 'center' }}>⧉</Btn>
            <Btn small onClick={onRemove} title="Remove step" style={{ width: '26px', padding: 0, justifyContent: 'center', fontSize: '14px' }}>×</Btn>
          </span>
        </div>

        {step.type === 'wait' ? (
          <div style={{ fontSize: '12px', color: MUTED, marginTop: '8px' }}>Nothing happens here — the next step is dated from the end of this wait.</div>
        ) : null}

        {step.type === 'rvm' ? (
          <div style={{ marginTop: '8px' }}>
            <RvmRecordingPicker workspaceId={workspaceId} value={step.libraryId ?? null} label="Recording this step drops"
              defaultName={step.title ? `Plan · ${step.title}` : 'Plan voicemail'} script={step.body}
              onChange={(c) => onPatch({ libraryId: c?.id ?? null })} />
          </div>
        ) : null}

        {step.type === 'rvm' && !step.libraryId ? (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: MUTED, marginTop: '8px' }}>
            Or rotate the recordings in group
            <input
              value={step.variantGroup ?? ''}
              onChange={(e) => onPatch({ variantGroup: e.target.value })}
              placeholder="default"
              style={{ ...smallInput, width: '140px', height: '26px' }}
            />
          </label>
        ) : null}

        {compr ? (
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: MUTED }}>
              Report
              <select value={step.audience ?? 'seller'} onChange={(e) => onPatch({ audience: e.target.value as 'seller' | 'buyer' })} style={{ ...smallSelect, width: 'auto', height: '26px' }}>
                <option value="seller">Compr Seller (to the seller)</option>
                <option value="buyer">Compr Buyer (to the deal&rsquo;s buyer)</option>
              </select>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: MUTED }}>
              Send by
              <select value={step.via ?? 'sms'} onChange={(e) => onPatch({ via: e.target.value as 'sms' | 'email' })} style={{ ...smallSelect, width: 'auto', height: '26px' }}>
                <option value="sms">Text</option>
                <option value="email">Email</option>
              </select>
            </label>
          </div>
        ) : null}

        {step.type === 'email' || (compr && step.via === 'email') ? (
          <input
            value={step.subject} onChange={(e) => onPatch({ subject: e.target.value })} placeholder="Subject line"
            style={{ ...smallInput, marginTop: '8px', height: '30px', fontSize: '12.5px' }}
          />
        ) : null}

        {step.type === 'stage' ? (
          <div style={{ marginTop: '8px' }}>
            <span style={label}>Move the seller to</span>
            <select value={step.stage} onChange={(e) => onPatch({ stage: e.target.value })} style={{ ...smallSelect, height: '30px' }}>
              <option value="">Choose a stage…</option>
              {SELLER_STAGE_LABELS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        ) : null}

        {step.type === 'ai_agent' ? (
          <div style={{ marginTop: '8px' }}>
            <span style={label}>Goal</span>
            <textarea
              value={step.goal ?? ''} onChange={(e) => onPatch({ goal: e.target.value })} rows={3} style={textarea}
              placeholder="What this step should get done, e.g. &quot;Get a walkthrough booked this week; if they are not selling, find out when to check back.&quot; Leave blank to let the AI decide from the record history."
            />
            <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }} role="radiogroup" aria-label="How the AI works this step">
              {([['once', 'Decide once'], ['agent', 'Hand to the AI agent']] as const).map(([v, text]) => {
                const on = v === 'once' ? !!step.allowed : !step.allowed;
                return (
                  <button
                    key={v} type="button" role="radio" aria-checked={on} className="dc23"
                    onClick={() => onPatch({ allowed: v === 'once' ? (step.allowed ?? [...CAPABILITIES]) : undefined })}
                    style={{ height: '26px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${on ? '#0f766e' : LINE}`, background: on ? '#f0fdfa' : '#fff', color: on ? '#0f766e' : MUTED, fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                  >
                    {text}
                  </button>
                );
              })}
            </div>
            {step.allowed ? (
              <div style={{ marginTop: '8px' }}>
                <span style={label}>It may</span>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  {CAPABILITIES.map((c) => {
                    const on = step.allowed!.includes(c);
                    return (
                      <label key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px', color: INK, cursor: 'pointer' }}>
                        <input
                          type="checkbox" checked={on}
                          onChange={() => onPatch({ allowed: on ? step.allowed!.filter((x) => x !== c) : CAPABILITIES.filter((x) => x === c || step.allowed!.includes(x)) })}
                        />
                        {CAPABILITY_LABEL[c].replace(/^./, (ch) => ch.toUpperCase())}
                      </label>
                    );
                  })}
                </div>
                <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '6px' }}>
                  {step.allowed.length
                    ? 'When the lead reaches this step the AI reads their texts, calls, earlier plans and open tasks, then does at most one of each — or nothing — and the run table shows what it did and why. Texts go out as the lead’s rep, 9am–8pm their time, with opt-out and STOP respected.'
                    : 'Nothing is ticked, so this step will only be marked done.'}
                </span>
              </div>
            ) : (
              <span style={{ display: 'block', fontSize: '11.5px', color: MUTED, marginTop: '6px' }}>
                Switches the workspace’s AI agent on for the record with this goal. It texts and emails over days until the goal is met or a rep switches it off.
              </span>
            )}
          </div>
        ) : null}

        {step.type === 'tag' ? (
          <div style={{ marginTop: '8px' }}>
            <span style={label}>Add the tag</span>
            <input list={`tags-${step.key}`} value={step.tag} onChange={(e) => onPatch({ tag: e.target.value })} placeholder="e.g. cold, follow-up, hot" style={{ ...smallInput, height: '30px' }} />
            <datalist id={`tags-${step.key}`}>{tags.map((t) => <option key={t} value={t} />)}</datalist>
          </div>
        ) : null}

        {hasBody ? (
          <>
            <textarea
              ref={bodyRef} value={step.body} onChange={(e) => onPatch({ body: e.target.value })} placeholder={bodyPlaceholder}
              rows={step.type === 'sms' ? 3 : 4} style={{ ...textarea, marginTop: '8px' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '6px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11.5px', color: FAINT, fontWeight: 600, marginRight: '2px' }}>Insert</span>
              {(compr ? [...MERGE_FIELDS, 'report_link'] : MERGE_FIELDS).map((f) => (
                <button key={f} type="button" className="dc23" onClick={() => insertField(f)} style={{ height: '20px', padding: '0 7px', borderRadius: '5px', border: `1px solid ${LINE}`, background: '#fafafa', fontSize: '11px', color: '#52525b', cursor: 'pointer', fontFamily: 'inherit' }}>
                  {`{{${f}}}`}
                </button>
              ))}
              {step.type === 'sms' || (compr && step.via !== 'email') ? <span style={{ marginLeft: 'auto', fontSize: '11px', color: step.body.length > 320 ? '#b91c1c' : FAINT, fontVariantNumeric: 'tabular-nums' }}>{step.body.length} chars</span> : null}
            </div>
          </>
        ) : null}

        {hasPriority || hasAssignee ? (
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
            {hasPriority ? (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: MUTED }}>
                Priority
                <select value={step.priority} onChange={(e) => onPatch({ priority: e.target.value as Priority })} style={{ ...smallSelect, width: 'auto', height: '26px' }}>
                  <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
                </select>
              </label>
            ) : null}
            {hasAssignee ? (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: MUTED }}>
                {step.type === 'assign' ? 'Hand to' : 'Assign to'}
                <select value={step.assignee} onChange={(e) => onPatch({ assignee: e.target.value })} style={{ ...smallSelect, width: 'auto', height: '26px', maxWidth: '200px' }}>
                  <option value="">{step.type === 'assign' ? 'The lead owner' : 'Whoever owns the lead'}</option>
                  {team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            ) : null}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: '5px', marginTop: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: FAINT }}>Add after:</span>
          {STEP_TYPES.map((t) => (
            <button key={t.v} type="button" className="dc23" onClick={() => onAddAfter(t.v)} title={t.hint} style={{ height: '20px', padding: '0 7px', borderRadius: '5px', border: `1px dashed #d4d4d8`, background: 'none', fontSize: '11px', color: INK, cursor: 'pointer', fontFamily: 'inherit' }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
