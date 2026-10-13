// AI Agent, Rules: what the agent must and must not do. Always and Never rules
// carry a strictness (hard is never broken, soft may bend); the compliance
// block has two locked switches that protect callers and are never editable.
'use client';

import React from 'react';
import { Plus } from 'lucide-react';
import { LIMITS, addChip, type Rule } from '@/lib/voice-agent';
import { fieldId, firstError, moveItem, removeAt, uniqueId } from '@/lib/voice-agent-console';
import { AreaField, Banner, ChipList, Empty, Field, HoursEditor, ItemControls, LockedRow, RuleCard, Section, SettingRow, Switch, TextField, ghost, MUTED, eyebrow } from '../kit';
import type { TabCtx } from '../types';

function RuleList({ kind, ctx }: { kind: 'dos' | 'donts'; ctx: TabCtx }) {
  const { form, canEdit } = ctx;
  const { draft, errors, set } = form;
  const rules = draft.rules[kind];
  const label = kind === 'dos' ? 'Always' : 'Never';
  const add = () => set(['rules', kind], [...rules, { id: uniqueId(kind === 'dos' ? 'do' : 'dont', rules.map((r) => r.id)), text: '', severity: kind === 'donts' ? 'hard' : 'soft' } satisfies Rule]);
  return (
    <Section id={`va-${kind}`} title={kind === 'dos' ? 'Always do' : 'Never do'}
      description={kind === 'dos' ? 'Habits the agent keeps on every call.' : 'Lines the agent does not cross.'}
      help="A hard rule is never broken. A soft rule is a preference the agent may bend when the call clearly calls for it."
      aside={canEdit && rules.length < LIMITS.rules ? <button type="button" className="va-btn va-ghost" style={ghost} onClick={add}><Plus size={14} aria-hidden="true" /> Add a rule</button> : undefined}>
      {rules.length === 0 ? <Empty title={`No ${label.toLowerCase()} rules`}>{kind === 'dos' ? 'For example: ask one question at a time.' : 'For example: never quote a price outside the approved range.'}</Empty> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {rules.map((r, i) => {
            const base = `rules.${kind}[${r.id}]`;
            return (
              <RuleCard key={r.id} id={fieldId(base)} kind={kind === 'dos' ? 'always' : 'never'} severity={r.severity} text={r.text} i={i} count={rules.length} error={errors[`${base}.text`] ?? errors[base]}
                onText={canEdit ? (t) => set(['rules', kind, i, 'text'], t) : undefined} onSeverity={canEdit ? (s) => set(['rules', kind, i, 'severity'], s) : undefined}
                onMove={(d) => set(['rules', kind], moveItem(rules, i, d))} onRemove={() => set(['rules', kind], removeAt(rules, i))} />
            );
          })}
        </div>
      )}
      {kind === 'donts' ? <p style={{ margin: '10px 0 0', fontSize: 12, color: MUTED }}>Text that tells the agent to deny being an AI is refused when you save.</p> : null}
    </Section>
  );
}

export function RulesTab(ctx: TabCtx) {
  const { form, canEdit } = ctx;
  const { draft, errors, set } = form;
  const r = draft.rules;
  const c = r.compliance;
  const off = !canEdit;
  const nmErr = firstError(errors, 'rules.never_mention'); const fpErr = firstError(errors, 'rules.forbidden_phrases');
  return (
    <>
      <RuleList kind="dos" ctx={ctx} />
      <RuleList kind="donts" ctx={ctx} />

      <Section id="va-words" title="Words" description="Topics and phrases, kept short.">
        <label htmlFor={fieldId('rules.never_mention')} style={eyebrow}>Never bring up</label>
        <ChipList id={fieldId('rules.never_mention')} items={r.never_mention} onChange={(n) => set(['rules', 'never_mention'], n)} add={(l, t) => addChip(l, t, LIMITS.neverMention, LIMITS.neverMentionCount)} placeholder="A topic, then Enter" disabled={off} max={LIMITS.neverMentionCount} />
        <p style={{ margin: '5px 0 0', fontSize: 12, color: nmErr ? '#b91c1c' : MUTED }} role={nmErr ? 'alert' : undefined}>{nmErr ?? `Topics left alone unless the caller raises them. ${r.never_mention.length}/${LIMITS.neverMentionCount}`}</p>
        <div style={{ marginTop: 16 }}>
          <label htmlFor={fieldId('rules.forbidden_phrases')} style={eyebrow}>Never say</label>
          <ChipList id={fieldId('rules.forbidden_phrases')} items={r.forbidden_phrases} onChange={(n) => set(['rules', 'forbidden_phrases'], n)} add={(l, t) => addChip(l, t, LIMITS.forbidden, LIMITS.forbiddenCount)} placeholder="A phrase, then Enter" disabled={off} max={LIMITS.forbiddenCount} />
          <p style={{ margin: '5px 0 0', fontSize: 12, color: fpErr ? '#b91c1c' : MUTED }} role={fpErr ? 'alert' : undefined}>{fpErr ?? `Exact words the agent never uses, like "guaranteed price". ${r.forbidden_phrases.length}/${LIMITS.forbiddenCount}`}</p>
        </div>
      </Section>

      <Section id="va-required" title="Required wording" description="Lines the agent must say when a situation comes up."
        aside={canEdit && r.required_phrases.length < LIMITS.requiredCount ? (
          <button type="button" className="va-btn va-ghost" style={ghost} onClick={() => set(['rules', 'required_phrases'], [...r.required_phrases, { when: '', text: '' }])}><Plus size={14} aria-hidden="true" /> Add wording</button>
        ) : undefined}>
        {r.required_phrases.length === 0 ? <Empty title="None yet">For example: when the seller asks about fees, say &ldquo;We go over the actual terms before anything is agreed to.&rdquo;</Empty> : (
          <div style={{ display: 'grid', gap: 10 }}>
            {r.required_phrases.map((p, i) => (
              <div key={i} id={fieldId(`rules.required_phrases[${i}]`)} style={{ border: '1px solid var(--inset-line)', background: 'var(--inset)', boxShadow: 'var(--elev-inset)', borderRadius: 10, padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 10 }}>
                  <Field label="When" htmlFor={fieldId(`rules.required_phrases[${i}].when`)} error={errors[`rules.required_phrases[${i}].when`]}>
                    <TextField id={fieldId(`rules.required_phrases[${i}].when`)} value={p.when} disabled={off} placeholder="the seller asks about fees" error={errors[`rules.required_phrases[${i}].when`]} onChange={(v) => set(['rules', 'required_phrases', i, 'when'], v)} />
                  </Field>
                  <Field label="Say" htmlFor={fieldId(`rules.required_phrases[${i}].text`)} error={errors[`rules.required_phrases[${i}].text`] ?? errors[`rules.required_phrases[${i}]`]}>
                    <TextField id={fieldId(`rules.required_phrases[${i}].text`)} value={p.text} disabled={off} placeholder="We go over the actual terms before anything is agreed to." error={errors[`rules.required_phrases[${i}].text`]} onChange={(v) => set(['rules', 'required_phrases', i, 'text'], v)} />
                  </Field>
                </div>
                {canEdit ? <ItemControls i={i} count={r.required_phrases.length} what={`wording ${i + 1}`} onMove={(d) => set(['rules', 'required_phrases'], moveItem(r.required_phrases, i, d))} onRemove={() => set(['rules', 'required_phrases'], removeAt(r.required_phrases, i))} /> : null}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section id="va-compliance" title="Compliance" description="Protections for the people the agent talks to. Two are locked on for every agent.">
        <LockedRow first title="Honor do not contact requests" help="If someone asks to stop being contacted, the agent acknowledges it once and ends the call."
          why="Cannot be turned off." />
        <div style={{ margin: '0 0 6px' }}>
          <Banner tone="info">Until the mark_do_not_contact tool is built, a do not contact request is only recorded in the call log. It does not add the number to the do not contact list, so a rep still has to.</Banner>
        </div>
        <LockedRow title="Honest about being an AI" help="When someone sincerely asks if they are talking to a person, the agent says it is an AI and offers a person."
          why="Cannot be turned off, and rules or scripts that say otherwise are refused." />
        <SettingRow title="Quiet hours" help="Outbound calls are never placed outside this window, and the agent ends one it finds itself on.">
          <Switch label="Quiet hours" on={c.quiet_hours.enabled} disabled={off} onChange={(v) => set(['rules', 'compliance', 'quiet_hours', 'enabled'], v)} />
        </SettingRow>
        {c.quiet_hours.enabled ? (
          <div className="va-in" style={{ padding: '0 0 12px' }}>
            <HoursEditor id={fieldId('rules.compliance.quiet_hours')} noDays value={{ days: [], ...c.quiet_hours }} disabled={off} error={errors['rules.compliance.quiet_hours']}
              onChange={(h) => set(['rules', 'compliance', 'quiet_hours'], { enabled: true, start: h.start, end: h.end, tz: h.tz })} />
            <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED }}>Federal rules keep telemarketing calls between 8am and 9pm in the person&apos;s local time.</p>
          </div>
        ) : null}
        <SettingRow title="Recording notice" help="Have the agent say early in the call that it may be recorded. Whether you need one depends on the states you call into.">
          <Switch label="Recording notice" on={c.recording_notice.enabled} disabled={off} onChange={(v) => set(['rules', 'compliance', 'recording_notice', 'enabled'], v)} />
        </SettingRow>
        {c.recording_notice.enabled ? (
          <div className="va-in">
            <Field label="What it says" htmlFor={fieldId('rules.compliance.recording_notice.text')} error={errors['rules.compliance.recording_notice.text']}>
              <AreaField id={fieldId('rules.compliance.recording_notice.text')} rows={2} max={LIMITS.recordingText} value={c.recording_notice.text} disabled={off} error={errors['rules.compliance.recording_notice.text']}
                onChange={(v) => set(['rules', 'compliance', 'recording_notice', 'text'], v)} />
            </Field>
          </div>
        ) : null}
      </Section>
    </>
  );
}
