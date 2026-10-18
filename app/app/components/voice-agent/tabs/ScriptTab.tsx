// AI Agent, Script: what the agent says. Sections are the editable pieces of
// the conversation; the palette drops a {{variable}} where the cursor is; the
// master script and a raw prompt override sit below, the override behind an
// Advanced warning because it replaces personality and every section.
'use client';

import React, { useCallback, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Plus } from 'lucide-react';
import { LIMITS, type ScriptSection } from '@/lib/voice-agent';
import {
  PROMPT_VARIABLES, SCRIPT_SOURCE_TEXT, fieldId, insertAtCursor, moveItem, removeAt, scriptSource, uniqueId, unknownVariables,
} from '@/lib/voice-agent-console';
import { AreaField, Badge, Banner, Empty, Field, ItemControls, LINE, Section, Switch, TextField, ghost, linkBtn, MUTED, INK, RED, danger } from '../kit';
import type { TabCtx } from '../types';

type Target = { el: HTMLTextAreaElement; path: (string | number)[] };

export function ScriptTab({ form, canEdit }: TabCtx) {
  const { draft, errors, set } = form;
  const sc = draft.script;
  const off = !canEdit;
  const target = useRef<Target | null>(null);
  const [hasTarget, setHasTarget] = useState(false);
  const [advOpen, setAdvOpen] = useState<boolean | null>(null);
  const source = scriptSource(sc);
  const overrideOn = sc.raw_prompt_override !== null;
  const showAdv = advOpen ?? overrideOn;

  const remember = useCallback((el: HTMLTextAreaElement, path: (string | number)[]) => { target.current = { el, path }; setHasTarget(true); }, []);
  const insert = (name: string) => {
    const t = target.current;
    if (!t || !document.contains(t.el)) return;
    const r = insertAtCursor(t.el.value, t.el.selectionStart, t.el.selectionEnd, `{{${name}}}`);
    set(t.path, r.text);
    requestAnimationFrame(() => { t.el.focus(); t.el.setSelectionRange(r.cursor, r.cursor); });
  };
  const bodyProps = (path: (string | number)[]) => ({
    onFocus: (e: React.FocusEvent<HTMLTextAreaElement>) => remember(e.currentTarget, path),
    onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => remember(e.currentTarget, path),
  });

  const addSection = () => set(['script', 'sections'], [...sc.sections, { id: uniqueId('section', sc.sections.map((x) => x.id)), title: '', body: '', enabled: true } satisfies ScriptSection]);

  return (
    <>
      <Banner tone="info">{SCRIPT_SOURCE_TEXT[source]}</Banner>
      <div style={{ height: 12 }} />

      <Section id="va-palette" title="Variables" description="Click into a section, then click a variable to put it where the cursor is. The agent fills each one in on every call."
        help={'A {{name}} that is not in this list is stripped of its braces by the server. To keep a line off when a tool does not exist, write <<if tool_name>>text<<else>>other text<<end>>.'}>
        <div role="group" aria-label="Insert a variable" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PROMPT_VARIABLES.map((v) => (
            <button key={v.name} type="button" className="va-btn va-ghost" disabled={off || !hasTarget} title={v.hint}
              onMouseDown={(e) => e.preventDefault()} onClick={() => insert(v.name)}
              style={{ ...ghost, height: 28, padding: '0 9px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5, fontWeight: 500, opacity: off || !hasTarget ? 0.55 : 1, borderStyle: v.empty ? 'dashed' : 'solid' }}>
              {`{{${v.name}}}`}
            </button>
          ))}
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED }}>{off ? 'Read only.' : hasTarget ? 'Inserting into the section you last clicked.' : 'Click into a section or the master script first.'} Dashed ones are always empty for now.</p>
      </Section>

      <Section id="va-sections" title="Script sections" description="Each section is a part of the conversation. Turn one off to leave it out; use the arrows to reorder."
        aside={canEdit && sc.sections.length < LIMITS.sections ? <button type="button" className="va-btn va-ghost" style={ghost} onClick={addSection}><Plus size={14} aria-hidden="true" /> Add a section</button> : undefined}>
        {sc.sections.length === 0 ? (
          <Empty title="No sections of its own">{sc.template_id ? 'This agent uses the template\'s sections until you add your own.' : 'Add a section to give the agent something to say.'}</Empty>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {sc.sections.map((x, i) => {
              const base = `script.sections[${x.id}]`;
              const unknown = unknownVariables(`${x.title}\n${x.body}`);
              const err = errors[base] ?? errors[`${base}.title`];
              return (
                <div key={x.id} id={fieldId(base)} style={{ border: `1px solid ${err ? '#f87171' : LINE}`, borderRadius: 10, padding: '10px 12px', background: x.enabled ? 'var(--surface, #fff)' : 'var(--canvas, #fafafa)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                    <Switch label={`${x.title || x.id} is on`} on={x.enabled} disabled={off} onChange={(v) => set(['script', 'sections', i, 'enabled'], v)} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: x.enabled ? INK : MUTED }}>{x.enabled ? 'On' : 'Off, left out of the prompt'}</span>
                    {canEdit ? <ItemControls i={i} count={sc.sections.length} what={`section ${x.title || i + 1}`} onMove={(d) => set(['script', 'sections'], moveItem(sc.sections, i, d))} onRemove={() => set(['script', 'sections'], removeAt(sc.sections, i))} /> : null}
                  </div>
                  <Field label="Title" htmlFor={fieldId(`${base}.title`)} error={errors[`${base}.title`]}>
                    <TextField id={fieldId(`${base}.title`)} value={x.title} disabled={off} maxLength={LIMITS.sectionTitle + 10} placeholder="Call flow" error={errors[`${base}.title`]} onChange={(v) => set(['script', 'sections', i, 'title'], v)} />
                  </Field>
                  <div style={{ marginTop: 10 }}>
                    <Field label="What to say" htmlFor={fieldId(`${base}.body`)} error={errors[`${base}.body`] ?? (errors[base] && !errors[`${base}.title`] ? errors[base] : undefined)}>
                      <AreaField id={fieldId(`${base}.body`)} value={x.body} rows={7} max={LIMITS.sectionBody} disabled={off} placeholder="Opening: &quot;Hey, is this {{first_name}}?&quot;" error={errors[`${base}.body`] ?? (errors[base] && !errors[`${base}.title`] ? errors[base] : undefined)}
                        onChange={(v) => set(['script', 'sections', i, 'body'], v)} {...bodyProps(['script', 'sections', i, 'body'])} />
                    </Field>
                  </div>
                  {unknown.length ? <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--tx-amber-deep, #92400e)' }}>{unknown.map((u) => `{{${u}}}`).join(', ')} {unknown.length === 1 ? 'is' : 'are'} not {unknown.length === 1 ? 'a variable' : 'variables'} the agent has, so the braces will be removed.</p> : null}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section id="va-master" title="Master script" description="Paste a whole script instead of sections. Used only when no section above has text." >
        <Field label="Master script" htmlFor={fieldId('script.master_script_text')} error={errors['script.master_script_text']} hint="The agent follows it in order and adapts the wording, never reading it word for word.">
          <AreaField id={fieldId('script.master_script_text')} value={sc.master_script_text} rows={6} max={LIMITS.master} disabled={off} placeholder="1. Intro and intent&#10;2. Price discovery&#10;3. Motivation..." error={errors['script.master_script_text']}
            onChange={(v) => set(['script', 'master_script_text'], v)} {...bodyProps(['script', 'master_script_text'])} />
        </Field>
      </Section>

      <section style={{ background: 'var(--surface, #fff)', border: `1px solid ${overrideOn ? 'var(--tint-red-2, #fecaca)' : LINE}`, borderRadius: 12, padding: '14px 18px', marginBottom: 12 }} aria-labelledby="va-advanced">
        <button type="button" className="va-btn" aria-expanded={showAdv} aria-controls="va-advanced-body" onClick={() => setAdvOpen(!showAdv)}
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: 0, border: 0, background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span id="va-advanced" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600, color: INK }}>Advanced: prompt override {overrideOn ? <Badge tone="red">Override active</Badge> : null}</span>
            <span style={{ display: 'block', marginTop: 3, fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>Write the whole prompt yourself. Most agents should not.</span>
          </span>
          <ChevronDown size={18} aria-hidden="true" style={{ color: MUTED, flex: 'none', transform: showAdv ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
        </button>
        {showAdv ? (
          <div id="va-advanced-body" className="va-in" style={{ marginTop: 14 }}>
            <div role="alert" style={{ display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--tint-red, #fef2f2)', border: '1px solid var(--tint-red-2, #fecaca)', color: RED, fontSize: 12.5, lineHeight: 1.5 }}>
              <AlertTriangle size={16} aria-hidden="true" style={{ flex: 'none', marginTop: 2 }} />
              <span>An override <strong>replaces the personality and every script section</strong>. Rules, offer authority, tools and the locked safety block still apply, and a prompt that tells the agent to deny being an AI is refused. Nothing here is checked for you: preview the prompt before you publish.</span>
            </div>
            {!overrideOn ? (
              canEdit ? <button type="button" className="va-btn" style={{ ...danger(), marginTop: 12 }} onClick={() => set(['script', 'raw_prompt_override'], '')}>Use a prompt override</button> : <p style={{ margin: '12px 0 0', fontSize: 12.5, color: MUTED }}>No override is set.</p>
            ) : (
              <div style={{ marginTop: 12 }}>
                <Field label="Prompt override" htmlFor={fieldId('script.raw_prompt_override')} error={errors['script.raw_prompt_override']}
                  aside={canEdit ? <button type="button" className="va-btn" style={linkBtn} onClick={() => set(['script', 'raw_prompt_override'], null)}>Remove the override</button> : undefined}>
                  <AreaField id={fieldId('script.raw_prompt_override')} value={sc.raw_prompt_override ?? ''} rows={12} max={LIMITS.override} mono disabled={off} placeholder="You are Sam, a lead manager for {{company}}..." error={errors['script.raw_prompt_override']}
                    onChange={(v) => set(['script', 'raw_prompt_override'], v)} {...bodyProps(['script', 'raw_prompt_override'])} />
                </Field>
              </div>
            )}
          </div>
        ) : null}
      </section>
    </>
  );
}
