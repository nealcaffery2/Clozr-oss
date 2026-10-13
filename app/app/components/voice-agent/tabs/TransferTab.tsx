// AI Agent, Live transfer: when the agent hands a live call to a person, who
// it hands it to, and what it does when nobody answers. Publishing maps this
// to ElevenLabs' transfer_to_number tool; what it cannot express (whisper,
// ring timeouts, ring groups) comes back as manual steps.
'use client';

import React from 'react';
import { Plus } from 'lucide-react';
import { LIMITS, type Destination, type DestinationType, type TransferFallback } from '@/lib/voice-agent';
import { daysSummary, fieldId, hoursSummary, moveItem, removeAt, uniqueId } from '@/lib/voice-agent-console';
import { AreaField, Badge, Banner, ChoiceCards, Empty, Field, HoursEditor, ItemControls, LINE, RangeField, Section, Segmented, SettingRow, Switch, TextField, ghost, grid, linkBtn, INK, MUTED } from '../kit';
import type { TabCtx } from '../types';

const TRIGGERS: { key: 'asks_for_person' | 'hot_lead' | 'angry_or_escalating' | 'above_range' | 'legal_or_complex'; label: string; hint: string }[] = [
  { key: 'asks_for_person', label: 'Asks for a person', hint: 'The caller says "let me talk to someone".' },
  { key: 'hot_lead', label: 'Ready to move forward', hint: 'The caller is clearly ready, like "let\'s do it today".' },
  { key: 'angry_or_escalating', label: 'Angry or escalating', hint: 'A human is better placed to calm the call.' },
  { key: 'above_range', label: 'Wants more than the range', hint: 'They insist on a price above the approved range.' },
  { key: 'legal_or_complex', label: 'Legal or complex', hint: 'Contracts, liens, probate, litigation.' },
];

const TYPES: { id: DestinationType; label: string; hint: string }[] = [
  { id: 'rep_assigned', label: 'Assigned rep', hint: 'Dials the phone of the rep on the record.' },
  { id: 'fixed', label: 'A number', hint: 'Always the same number.' },
  { id: 'ring_group', label: 'Ring group', hint: 'Rings a group of phones.' },
];

export function TransferTab({ form, canEdit, goTo }: TabCtx) {
  const { draft, errors, set } = form;
  const lt = draft.live_transfer;
  const off = !canEdit;
  const toolOff = !draft.tools.transfer.enabled;
  const addDest = () => set(['live_transfer', 'destinations'], [...lt.destinations, { id: uniqueId('dest', lt.destinations.map((d) => d.id)), label: '', number: '', type: 'fixed', ring_timeout_s: 25 } satisfies Destination]);
  const addCustom = () => set(['live_transfer', 'triggers', 'custom'], [...lt.triggers.custom, { id: uniqueId('trigger', lt.triggers.custom.map((c) => c.id)), text: '' }]);
  const setDest = (i: number, patch: Partial<Destination>) => set(['live_transfer', 'destinations', i], { ...lt.destinations[i]!, ...patch });
  return (
    <>
      <Section id="va-transfer" title="Live transfer" description="Hand a live call to a person when it matters.">
        <SettingRow first title="Transfer live calls" help="When off, the agent offers a callback instead of transferring.">
          <Switch label="Transfer live calls" on={lt.enabled} disabled={off} onChange={(v) => set(['live_transfer', 'enabled'], v)} />
        </SettingRow>
        {toolOff && lt.enabled ? <div style={{ marginTop: 6 }}><Banner tone="warn">The Transfer tool is switched off on the Tools tab, so the agent still cannot transfer. <button type="button" className="va-btn" style={linkBtn} onClick={() => goTo('tools')}>Open Tools</button></Banner></div> : null}
        {lt.enabled ? (
          <div className="va-in" style={{ paddingTop: 10 }}>
            <span style={{ display: 'block', fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>How it hands over</span>
            <Segmented<'warm' | 'cold'> id={fieldId('live_transfer.mode')} label="How it hands over" value={lt.mode} disabled={off} onChange={(v) => set(['live_transfer', 'mode'], v)}
              options={[{ id: 'warm', label: 'Warm', hint: 'The agent stays on and introduces the caller.' }, { id: 'cold', label: 'Cold', hint: 'The call is passed straight over.' }]} />
            <p style={{ margin: '6px 0 0', fontSize: 12, color: MUTED, lineHeight: 1.5 }}>Warm stays on the line and introduces the caller before dropping off. Cold passes the call straight over.</p>
          </div>
        ) : null}
      </Section>

      {lt.enabled ? (
        <>
          <Section id={fieldId('live_transfer.destinations')} title="Where calls go" description="Up to six destinations, tried in this order."
            aside={canEdit && lt.destinations.length < LIMITS.destinations ? <button type="button" className="va-btn va-ghost" style={ghost} onClick={addDest}><Plus size={14} aria-hidden="true" /> Add a destination</button> : undefined}>
            {errors['live_transfer.destinations'] ? <div style={{ marginBottom: 10 }}><Banner tone="warn">{errors['live_transfer.destinations']}</Banner></div> : null}
            {lt.destinations.length === 0 ? <Empty title="No destinations yet">Add the number a caller should reach, like the acquisitions line or the rep on the record.</Empty> : (
              <div style={{ display: 'grid', gap: 10 }}>
                {lt.destinations.map((d, i) => {
                  const base = `live_transfer.destinations[${d.id}]`;
                  return (
                    <div key={d.id} id={fieldId(base)} style={{ border: '1px solid var(--inset-line)', borderRadius: 10, padding: '12px 14px', background: 'var(--inset)', boxShadow: 'var(--elev-inset)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: INK }}>{d.label || `Destination ${i + 1}`}</span>
                        <Badge tone="grey">{TYPES.find((t) => t.id === d.type)?.label}</Badge>
                        {i === 0 ? <Badge tone="green">First choice</Badge> : null}
                        <span style={{ flex: 1 }} />
                        {canEdit ? <ItemControls i={i} count={lt.destinations.length} what={d.label || `destination ${i + 1}`} onMove={(dir) => set(['live_transfer', 'destinations'], moveItem(lt.destinations, i, dir))} onRemove={() => set(['live_transfer', 'destinations'], removeAt(lt.destinations, i))} /> : null}
                      </div>
                      <div style={grid(220)}>
                        <Field label="Name" htmlFor={fieldId(`${base}.label`)} error={errors[`${base}.label`]}>
                          <TextField id={fieldId(`${base}.label`)} value={d.label} disabled={off} maxLength={LIMITS.destLabel + 10} placeholder="Acquisitions line" error={errors[`${base}.label`]} onChange={(v) => setDest(i, { label: v })} />
                        </Field>
                        <Field label="Phone number" htmlFor={fieldId(`${base}.number`)} error={errors[`${base}.number`]}
                          hint={d.type === 'rep_assigned' ? 'Optional. Leave empty to dial the assigned rep.' : 'A full number, like (512) 555-0142.'}>
                          <TextField id={fieldId(`${base}.number`)} type="tel" inputMode="tel" value={d.number} disabled={off} placeholder="(512) 555-0142" error={errors[`${base}.number`]} onChange={(v) => setDest(i, { number: v })} />
                        </Field>
                      </div>
                      <div style={{ marginTop: 12 }}>
                        <span style={{ display: 'block', fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>Goes to</span>
                        <Segmented<DestinationType> label={`Type of destination ${i + 1}`} value={d.type} disabled={off} onChange={(v) => setDest(i, { type: v })} options={TYPES} />
                      </div>
                      <div style={{ marginTop: 12, maxWidth: 360 }}>
                        <RangeField id={fieldId(`${base}.ring_timeout_s`)} label="Ring for" value={d.ring_timeout_s} min={5} max={60} step={5} unit=" s" disabled={off} hint="How long to ring before giving up on this one." onChange={(v) => setDest(i, { ring_timeout_s: v })} />
                      </div>
                      <SettingRow title="Only at certain hours" help={d.hours ? hoursSummary(d.hours) : 'Available any time the agent is on a call.'}>
                        <Switch label={`Hours for ${d.label || `destination ${i + 1}`}`} on={!!d.hours} disabled={off}
                          onChange={(v) => setDest(i, v ? { hours: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '18:00', tz: draft.call_handling.call_hours.tz } } : { hours: undefined })} />
                      </SettingRow>
                      {d.hours ? (
                        <div className="va-in">
                          <HoursEditor id={fieldId(`${base}.hours`)} value={d.hours} disabled={off} error={errors[`${base}.hours`]} onChange={(h) => setDest(i, { hours: h })} />
                          <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED }}>{daysSummary(d.hours.days)}. Outside these hours the agent skips this destination and uses the fallback below.</p>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          <Section id="va-triggers" title="When to transfer" description="Tick the moments a transfer is right. The agent transfers only when one of them applies.">
            <div role="group" aria-label="Transfer triggers" style={grid(260)}>
              {TRIGGERS.map((t) => {
                const on = lt.triggers[t.key];
                return (
                  <label key={t.key} id={fieldId(`live_transfer.triggers.${t.key}`)} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, cursor: off ? 'not-allowed' : 'pointer',
                    border: `1px solid ${on ? '#0A8560' : LINE}`, background: on ? '#E7F8F1' : '#fff' }}>
                    <input type="checkbox" checked={on} disabled={off} onChange={(e) => set(['live_transfer', 'triggers', t.key], e.target.checked)} style={{ width: 16, height: 16, marginTop: 2, accentColor: '#0A8560', flex: 'none' }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: on ? '#0A8560' : INK }}>{t.label}</span>
                      <span style={{ display: 'block', fontSize: 12, color: MUTED, lineHeight: 1.4 }}>{t.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {lt.triggers.above_range && draft.offer_authority.mode === 'none' ? <div style={{ marginTop: 10 }}><Banner tone="info">&ldquo;Wants more than the range&rdquo; does nothing while offer authority is Never.</Banner></div> : null}
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: INK }}>Your own triggers</span>
                {canEdit && lt.triggers.custom.length < LIMITS.customTriggers ? <button type="button" className="va-btn va-ghost" style={ghost} onClick={addCustom}><Plus size={14} aria-hidden="true" /> Add</button> : null}
              </div>
              {lt.triggers.custom.length === 0 ? <p style={{ margin: 0, fontSize: 12, color: MUTED }}>None. For example: &ldquo;the caller mentions a tenant who will not leave&rdquo;.</p> : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {lt.triggers.custom.map((c, i) => {
                    const p = `live_transfer.triggers.custom[${c.id}]`;
                    const err = errors[`${p}.text`] ?? errors[p];
                    return (
                      <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <TextField id={fieldId(`${p}.text`)} value={c.text} disabled={off} placeholder="the caller mentions a tenant who will not leave" error={err} onChange={(v) => set(['live_transfer', 'triggers', 'custom', i, 'text'], v)} />
                          {err ? <p id={`${fieldId(`${p}.text`)}-err`} role="alert" style={{ margin: '4px 0 0', fontSize: 12, color: '#b91c1c' }}>{err}</p> : null}
                        </div>
                        {canEdit ? <ItemControls i={i} count={lt.triggers.custom.length} what={`trigger ${i + 1}`} onMove={(dir) => set(['live_transfer', 'triggers', 'custom'], moveItem(lt.triggers.custom, i, dir))} onRemove={() => set(['live_transfer', 'triggers', 'custom'], removeAt(lt.triggers.custom, i))} /> : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Section>

          <Section id="va-whisper" title="Handover and fallback" description="What the person hears first, and what happens when no one picks up.">
            <Field label="Message to the person answering" htmlFor={fieldId('live_transfer.whisper_message_template')} error={errors['live_transfer.whisper_message_template']}
              hint="A short private note only they hear, like &quot;Kara Mitchell on 123 Oakview, ready to sell.&quot; ElevenLabs cannot play it on SIP; publishing lists that as a manual step.">
              <AreaField id={fieldId('live_transfer.whisper_message_template')} value={lt.whisper_message_template} rows={2} max={LIMITS.whisper} disabled={off} error={errors['live_transfer.whisper_message_template']}
                placeholder="{{first_name}} on {{property_address}} wants to talk to someone." onChange={(v) => set(['live_transfer', 'whisper_message_template'], v)} />
            </Field>
            <div style={{ marginTop: 14 }}>
              <span style={{ display: 'block', fontSize: 11.5, color: MUTED, fontWeight: 600, marginBottom: 6 }}>If nobody answers</span>
              <ChoiceCards<TransferFallback> label="If nobody answers" value={lt.fallback} disabled={off} min={200} onChange={(v) => set(['live_transfer', 'fallback'], v)}
                options={[
                  { id: 'book_callback', label: 'Book a callback', hint: 'Agree a time for a rep to call them back.' },
                  { id: 'voicemail', label: 'Take a message', hint: 'Record what they want the rep to know.' },
                  { id: 'apologize_end', label: 'Apologize and end', hint: 'Say the team is unavailable and end politely.' },
                ]} />
            </div>
          </Section>
        </>
      ) : null}
    </>
  );
}
