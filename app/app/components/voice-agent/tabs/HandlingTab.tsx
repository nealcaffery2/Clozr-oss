// AI Agent, Call handling: how long, how patient, what to do with voicemail,
// when to call, and which directions the agent works. The first pause has no
// ElevenLabs setting through the API; the prompt preview lists it under "not
// applied" and this screen says so rather than pretending.
'use client';

import React from 'react';
import { CALL_MAX_SECONDS, CALL_MIN_SECONDS, LIMITS, formatLimit, type TurnEagerness } from '@/lib/voice-agent';
import { callHoursOutsideQuiet, fieldId, hoursSummary } from '@/lib/voice-agent-console';
import { AreaField, Banner, Field, HoursEditor, RangeField, Scale, Section, Segmented, SettingRow, Switch, TextField, grid, MUTED } from '../kit';
import type { TabCtx } from '../types';
import { LocalNumbers } from '../LocalNumbers';

const SENS = ['Very hard to interrupt', 'Hard to interrupt', 'Balanced', 'Easy to interrupt', 'Very easy to interrupt'];

export function HandlingTab({ form, canEdit, agentKey, workspaceId, published, epoch, demo }: TabCtx) {
  const { draft, errors, set } = form;
  const ch = draft.call_handling;
  const off = !canEdit;
  const vm = ch.voicemail;
  const outside = callHoursOutsideQuiet(draft);
  return (
    <>
      <Section id="va-length" title="Length and pauses" description="When the agent hangs up and how it takes turns.">
        <div style={{ ...grid(280), gap: '18px 24px' }}>
          <RangeField id={fieldId('call_handling.max_call_seconds')} label="Longest call" value={ch.max_call_seconds} min={CALL_MIN_SECONDS} max={CALL_MAX_SECONDS} step={30} format={formatLimit} disabled={off}
            hint="The agent wraps up and ends the call at this point." error={errors['call_handling.max_call_seconds']} onChange={(v) => set(['call_handling', 'max_call_seconds'], v)} />
          <RangeField id={fieldId('call_handling.silence_timeout_s')} label="Hang up after silence" value={ch.silence_timeout_s} min={0} max={300} step={5} format={(n) => (n === 0 ? 'Never' : `${n} s`)} disabled={off}
            hint="How long it waits on a dead line before ending the call. 0 means it never does." error={errors['call_handling.silence_timeout_s']} onChange={(v) => set(['call_handling', 'silence_timeout_s'], v)} />
          <RangeField id={fieldId('call_handling.first_response_delay_ms')} label="Pause before the first word" value={ch.first_response_delay_ms} min={0} max={3000} step={100} format={(n) => (n === 0 ? 'None' : `${(n / 1000).toFixed(1)} s`)} disabled={off}
            hint="A beat before it speaks feels less abrupt on pickup." error={errors['call_handling.first_response_delay_ms']} onChange={(v) => set(['call_handling', 'first_response_delay_ms'], v)} />
          <Scale id={fieldId('call_handling.interruption_sensitivity')} label="Interruptions" value={ch.interruption_sensitivity} min={1} max={5} ends={['Hard to interrupt', 'Easy to interrupt']} words={SENS} disabled={off}
            hint="Harder to interrupt lets “uh huh” and “yeah” pass while it talks. “Yes”, “wait” or any real words still stop it." onChange={(v) => set(['call_handling', 'interruption_sensitivity'], v)} />
        </div>
        <div style={{ marginTop: 16 }}>
          <span style={{ display: 'block', fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>Taking turns</span>
          <Segmented<TurnEagerness> id={fieldId('call_handling.turn_eagerness')} label="Taking turns" value={ch.turn_eagerness} disabled={off} onChange={(v) => set(['call_handling', 'turn_eagerness'], v)}
            options={[{ id: 'patient', label: 'Patient' }, { id: 'normal', label: 'Normal' }, { id: 'eager', label: 'Eager' }]} />
          <p style={{ margin: '6px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>Patient waits out long pauses. Eager jumps in quickly, which suits short answers.</p>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>ElevenLabs has no API setting for the first pause. It is saved here and listed as not applied in the prompt preview.</p>
      </Section>

      <Section id="va-voicemail" title="Voicemail" description="What the agent does when a machine picks up.">
        <SettingRow first title="Detect voicemail" help="Recognize an answering machine instead of talking to it.">
          <Switch label="Detect voicemail" on={vm.detect} disabled={off} onChange={(v) => set(['call_handling', 'voicemail', 'detect'], v)} />
        </SettingRow>
        {vm.detect ? (
          <div className="va-in" style={{ display: 'grid', gap: 12, paddingTop: 4 }}>
            <Segmented<'leave_message' | 'hang_up'> id={fieldId('call_handling.voicemail.action')} label="On voicemail" value={vm.action} disabled={off} onChange={(v) => set(['call_handling', 'voicemail', 'action'], v)}
              options={[{ id: 'leave_message', label: 'Leave a message' }, { id: 'hang_up', label: 'Hang up' }]} />
            {vm.action === 'leave_message' ? (
              <Field label="The message" htmlFor={fieldId('call_handling.voicemail.message_template')} error={errors['call_handling.voicemail.message_template']}
                hint="Keep it short. Use {{agent_name}}, {{company}} and {{property_address}}; leave out prices and details of their situation.">
                <AreaField id={fieldId('call_handling.voicemail.message_template')} value={vm.message_template} rows={3} max={LIMITS.voicemail} disabled={off} error={errors['call_handling.voicemail.message_template']}
                  placeholder="Hi, this is {{agent_name}} with {{company}}. Please call us back when you can." onChange={(v) => set(['call_handling', 'voicemail', 'message_template'], v)} />
              </Field>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section id="va-hours" title="Call hours" description="When the agent places calls. Answering inbound calls is never held back."
        aside={<span style={{ fontSize: 12, color: MUTED, textAlign: 'right' }}>{hoursSummary(ch.call_hours)}</span>}>
        <HoursEditor id={fieldId('call_handling.call_hours')} value={ch.call_hours} disabled={off} error={errors['call_handling.call_hours']} onChange={(h) => set(['call_handling', 'call_hours'], h)} />
        {outside ? <div style={{ marginTop: 12 }}><Banner tone="warn">These hours reach outside your quiet hours ({hoursSummary(draft.rules.compliance.quiet_hours)}). Outbound calls outside quiet hours are not placed, so the window is really the overlap.</Banner></div> : null}
      </Section>

      <Section id="va-retry" title="Trying again" description="If nobody picks up on an outbound call.">
        <div style={grid(240)}>
          <RangeField id={fieldId('call_handling.retry.max_attempts')} label="Extra attempts" value={ch.retry.max_attempts} min={0} max={10} step={1} format={(n) => (n === 0 ? 'None' : String(n))} disabled={off}
            hint="0 means one try and no more." error={errors['call_handling.retry.max_attempts']} onChange={(v) => set(['call_handling', 'retry', 'max_attempts'], v)} />
          <RangeField id={fieldId('call_handling.retry.gap_hours')} label="Wait between tries" value={ch.retry.gap_hours} min={1} max={168} step={1} format={(n) => (n === 1 ? '1 hour' : n % 24 === 0 ? `${n / 24} ${n === 24 ? 'day' : 'days'}` : `${n} hours`)} disabled={off}
            hint="Retries still stay inside the call hours." error={errors['call_handling.retry.gap_hours']} onChange={(v) => set(['call_handling', 'retry', 'gap_hours'], v)} />
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>ElevenLabs has no retry setting through the API. Retries are listed as a manual step when you publish.</p>
      </Section>

      <Section id="va-numbers" title="Local presence numbers" description="One number per market. Each call goes out from the number local to the lead.">
        <LocalNumbers workspaceId={workspaceId} agentKey={agentKey} canEdit={canEdit} published={published} epoch={epoch} demo={demo} />
      </Section>

      <Section id="va-channels" title="Channels" description="Which way calls flow through this agent.">
        <SettingRow first title="Answers inbound calls" help="Sellers and buyers who ring back or call the number.">
          <Switch label="Answers inbound calls" on={draft.channels.inbound} disabled={off} onChange={(v) => set(['channels', 'inbound'], v)} />
        </SettingRow>
        <SettingRow title="Places outbound calls" help="Calls the agent starts, inside the call hours and quiet hours above.">
          <Switch label="Places outbound calls" on={draft.channels.outbound} disabled={off} onChange={(v) => set(['channels', 'outbound'], v)} />
        </SettingRow>
        <div style={{ paddingTop: 6 }}>
          <Field label="ElevenLabs phone number id" htmlFor={fieldId('channels.phone_number_id')} error={errors['channels.phone_number_id']} hint="This agent's default number, filled in on publish from the local numbers above. Used when none is local to the lead.">
            <TextField id={fieldId('channels.phone_number_id')} value={draft.channels.phone_number_id ?? ''} disabled={off} placeholder="phnum_..." error={errors['channels.phone_number_id']}
              onChange={(v) => set(['channels', 'phone_number_id'], v || null)} />
          </Field>
        </div>
      </Section>
    </>
  );
}
