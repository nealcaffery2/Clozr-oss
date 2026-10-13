// Settings → Numbers: a line's call flow and SMS flow, edited the way
// smrtPhone does it. Calls: business hours, ring these people for N seconds,
// forward, voicemail (Talkr runs the flow; flow-simple.ts maps it). Anything
// richer opens in the full editor (FlowEditor). Texts: who gets notified and an
// auto-reply (line_sms_flows, migration 200; talkr-webhook sends the reply).
'use client';

import React, { useEffect, useState } from 'react';
import { formatPhone, talkr, toE164, type CallFlowDto, type FlowTarget, type PhoneNumberDto } from '@/lib/talkr';
import { DEFAULT_HOURS, SMS_DAYS, blankSmsFlow, cleanSmsFlow, type SmsDay, type SmsFlow, type SmsHours } from '@/lib/sms-flow';
import type { BookLine } from '@/lib/number-book';
import { supabase } from '@/lib/supabase';
import { Button, FIELD, Modal, Segmented, Toggle } from '@/app/components/talkr/ui';
import { FlowEditor } from './FlowEditor';
import { DEFAULT_FLOW_SETTINGS, DEFAULT_SIMPLE_HOURS, fromFlow, simpleFlowError, starterFlow, toFlowDto, type FlowSettings, type SimpleFlow, type SimpleHours } from './flow-simple';
import { refreshPhoneAdmin } from './store';
import { errText } from './ui';

export type Person = { talkrId: string; name: string };
export type ClozrPerson = { userId: string; name: string };

const ZONES: Array<[string, string]> = [['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'], ['America/Los_Angeles', 'Pacific']];
const DAY_NAME: Record<SmsDay, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const LABEL: React.CSSProperties = { font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted)' };
const ROW: React.CSSProperties = { font: '500 12.5px/1.3 var(--sans)' };

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="num-section flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <span className="mr-auto" style={{ font: '650 13px/1.2 var(--sans)' }}>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Check({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5" style={ROW}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
      {children}
    </label>
  );
}

/** Open hours by weekday, one range a day, in one zone. */
export function HoursEditor({ value, onChange }: { value: SmsHours; onChange: (v: SmsHours) => void }) {
  const set = (d: SmsDay, r: [string, string] | null) => {
    const days = { ...value.days };
    if (r) days[d] = r; else delete days[d];
    onChange({ ...value, days });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <select value={value.timezone} onChange={(e) => onChange({ ...value, timezone: e.target.value })} aria-label="Time zone" className="outline-none" style={{ ...FIELD, height: 32, padding: '0 10px', maxWidth: 220 }}>
        {[...new Set([value.timezone, ...ZONES.map(([z]) => z)])].map((z) => <option key={z} value={z}>{ZONES.find(([k]) => k === z)?.[1] ?? z} time</option>)}
      </select>
      {SMS_DAYS.map((d) => {
        const r = value.days[d];
        return (
          <div key={d} className="flex flex-wrap items-center gap-2" style={ROW}>
            <span style={{ width: 64 }}><Check on={!!r} onChange={(on) => set(d, on ? ['09:00', '17:00'] : null)}>{DAY_NAME[d]}</Check></span>
            {r ? (
              <>
                <input type="time" value={r[0]} onChange={(e) => set(d, [e.target.value, r[1]])} aria-label={`${DAY_NAME[d]} opens`} className="outline-none" style={{ ...FIELD, height: 30 }} />
                <span style={LABEL}>to</span>
                <input type="time" value={r[1]} onChange={(e) => set(d, [r[0], e.target.value])} aria-label={`${DAY_NAME[d]} closes`} className="outline-none" style={{ ...FIELD, height: 30 }} />
              </>
            ) : <span style={LABEL}>Closed</span>}
          </div>
        );
      })}
    </div>
  );
}

const toSmsHours = (h: SimpleHours): SmsHours => ({
  timezone: h.timezone,
  days: Object.fromEntries(SMS_DAYS.filter((d) => h.schedule[d]?.length).map((d) => [d, h.schedule[d]![0]!])) as SmsHours['days'],
});
const toSimpleHours = (h: SmsHours, holidays: string[]): SimpleHours => ({
  timezone: h.timezone,
  schedule: Object.fromEntries(SMS_DAYS.map((d) => [d, h.days[d] ? [h.days[d]!] : []])) as SimpleHours['schedule'],
  holidays,
});

function Footer({ error, children }: { error: string | null; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-3" style={{ borderTop: '1px solid var(--line-soft)' }}>
      {error ? <span className="mr-auto" role="alert" style={{ font: '500 12px/1.4 var(--sans)', color: 'var(--red)', whiteSpace: 'pre-wrap' }}>{error}</span> : <span className="mr-auto" />}
      {children}
    </div>
  );
}

// ── Calls ────────────────────────────────────────────────────────────────────

const SPECIAL: Array<[FlowTarget, string]> = [[{ kind: 'last_contact' }, 'Rep who last reached out'], [{ kind: 'lead_owner' }, 'Seller’s owner'], [{ kind: 'everyone' }, 'Everyone']];
const sameTarget = (a: FlowTarget, b: FlowTarget) => a.kind === b.kind && (a.kind !== 'user' || (b.kind === 'user' && a.user_id === b.user_id));

export function CallFlowModal({ line, people, ownerTalkrId, isMobile, onClose }: { line: BookLine; people: Person[]; ownerTalkrId: string | null; isMobile: boolean; onClose: () => void }) {
  // The book keeps Talkr's number as it came: a PhoneNumberDto.
  const n = line.talkr as unknown as PhoneNumberDto;
  const [loaded, setLoaded] = useState<{ flow: CallFlowDto | null } | null>(null);
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  const [simple, setSimple] = useState<SimpleFlow>(() => starterFlow(ownerTalkrId ? [{ kind: 'user', user_id: ownerTalkrId }] : [{ kind: 'everyone' }], ownerTalkrId));
  const [settings, setSettings] = useState<FlowSettings>(DEFAULT_FLOW_SETTINGS);
  const [lastContact, setLastContact] = useState(!!n.route_callbacks_to_last_contact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    talkr.routing(n.id).then((r) => {
      if (!live) return;
      setLoaded({ flow: r.flow });
      if (r.flow) {
        const f = r.flow;
        setSettings({ recording: f.recording, announce: f.announce ?? null, whisper: f.whisper ?? null, voicemail_greeting: f.voicemail_greeting ?? null, missed_call_text: f.missed_call_text ?? null });
        const s = fromFlow(r.flow);
        if (s) setSimple(s); else setMode('advanced');
      }
    }).catch((err) => live && setError(errText(err)));
    return () => { live = false; };
  }, [n.id]);

  const toggle = (t: FlowTarget, on: boolean) => setSimple((s) => ({ ...s, ring: { ...s.ring, targets: on ? [...s.ring.targets, t] : s.ring.targets.filter((x) => !sameTarget(x, t)) } }));
  const order = (t: FlowTarget) => simple.ring.targets.findIndex((x) => sameTarget(x, t));

  async function save(clear = false) {
    const problem = clear ? null : simpleFlowError(simple);
    if (problem) return setError(problem);
    setBusy(true); setError(null);
    try {
      await talkr.saveRouting(n.id, clear ? null : toFlowDto(simple, settings));
      if (lastContact !== !!n.route_callbacks_to_last_contact) await talkr.updateNumber(n.id, { route_callbacks_to_last_contact: lastContact });
      await refreshPhoneAdmin();
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const title = `Call flow · ${formatPhone(line.phone)}`;
  if (mode === 'advanced') {
    return (
      <Modal title={title} onClose={onClose} width={860}>
        <div className="flex flex-col gap-2">
          {loaded && fromFlow(loaded.flow) === null && loaded.flow ? <span style={LABEL}>This flow has steps the simple editor does not show.</span> : null}
          <FlowEditor number={n} isMobile={isMobile} />
          <div><Button tone="quiet" onClick={() => setMode('simple')}>Back to simple editor</Button></div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={title} onClose={onClose} width={620}>
      {!loaded ? <span style={LABEL}>{error ?? 'Loading…'}</span> : (
        <div className="flex flex-col">
          {!loaded.flow ? <span className="pb-3" style={LABEL}>Now: default routing (owner, then voicemail). Saving switches to this flow.</span> : null}
          <Section title="Business hours" right={<Toggle on={!!simple.hours} label="Business hours" onChange={(on) => setSimple({ ...simple, hours: on ? DEFAULT_SIMPLE_HOURS : null })} />}>
            {simple.hours ? (
              <>
                <HoursEditor value={toSmsHours(simple.hours)} onChange={(h) => setSimple({ ...simple, hours: toSimpleHours(h, simple.hours?.holidays ?? []) })} />
                <span style={LABEL}>Closed: straight to voicemail.</span>
              </>
            ) : <span style={LABEL}>Off: rings any time.</span>}
          </Section>
          <Section title="Ring" right={<Segmented value={simple.ring.strategy} onChange={(strategy) => setSimple({ ...simple, ring: { ...simple.ring, strategy } })} options={[{ value: 'all', label: 'All at once' }, { value: 'sequential', label: 'In order' }, { value: 'round_robin', label: 'Round-robin' }]} />}>
            <div className="grid gap-x-4 gap-y-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
              {people.map((p) => {
                const t: FlowTarget = { kind: 'user', user_id: p.talkrId };
                const i = order(t);
                return <Check key={p.talkrId} on={i >= 0} onChange={(on) => toggle(t, on)}>{p.name}{simple.ring.strategy === 'sequential' && i >= 0 ? <span style={LABEL}> #{i + 1}</span> : null}</Check>;
              })}
              {SPECIAL.map(([t, name]) => <Check key={t.kind} on={order(t) >= 0} onChange={(on) => toggle(t, on)}>{name}</Check>)}
            </div>
            <div className="flex flex-wrap items-center gap-2" style={ROW}>
              Ring for
              <input type="number" min={5} max={120} value={simple.ring.timeout_seconds} onChange={(e) => setSimple({ ...simple, ring: { ...simple.ring, timeout_seconds: Number(e.target.value) || 20 } })} aria-label="Ring seconds" className="outline-none" style={{ ...FIELD, width: 72, height: 30 }} />
              seconds{simple.ring.strategy === 'all' ? '' : ' each'}
            </div>
            <Check on={lastContact} onChange={setLastContact}>Callbacks ring the rep who last reached out first</Check>
          </Section>
          <Section title="If nobody answers">
            <Check on={!!simple.forward} onChange={(on) => setSimple({ ...simple, forward: on ? { e164: '', timeout_seconds: 25 } : null })}>Forward to another phone first</Check>
            {simple.forward ? (
              <div className="flex flex-wrap items-center gap-2" style={ROW}>
                <input value={simple.forward.e164} placeholder="(210) 555-0100…" inputMode="tel" autoComplete="off" aria-label="Forward to" onChange={(e) => setSimple({ ...simple, forward: { ...simple.forward!, e164: toE164(e.target.value) ?? e.target.value } })} className="outline-none" style={{ ...FIELD, width: 170 }} />
                for
                <input type="number" min={5} max={120} value={simple.forward.timeout_seconds} onChange={(e) => setSimple({ ...simple, forward: { ...simple.forward!, timeout_seconds: Number(e.target.value) || 25 } })} aria-label="Forward seconds" className="outline-none" style={{ ...FIELD, width: 72, height: 30 }} />
                seconds
              </div>
            ) : null}
            <label className="flex flex-wrap items-center gap-2" style={ROW}>
              Then voicemail:
              <select value={simple.voicemail_user_id ?? ''} onChange={(e) => setSimple({ ...simple, voicemail_user_id: e.target.value || null })} className="outline-none" style={{ ...FIELD, height: 32, padding: '0 10px', minWidth: 200 }}>
                <option value="">This line’s</option>
                {people.map((p) => <option key={p.talkrId} value={p.talkrId}>{p.name}’s</option>)}
              </select>
            </label>
          </Section>
          <Section title="Options">
            <Check on={settings.recording} onChange={(recording) => setSettings({ ...settings, recording })}>Record calls</Check>
            <Check on={!!settings.missed_call_text?.enabled} onChange={(enabled) => setSettings({ ...settings, missed_call_text: { body: settings.missed_call_text?.body ?? 'Hi {first_name}, sorry we missed your call. We will call you right back.', cooldown_hours: settings.missed_call_text?.cooldown_hours ?? 24, enabled } })}>Text callers we miss</Check>
            {settings.missed_call_text?.enabled ? (
              <textarea rows={2} maxLength={480} value={settings.missed_call_text.body} aria-label="Missed-call text" onChange={(e) => setSettings({ ...settings, missed_call_text: { ...settings.missed_call_text!, body: e.target.value } })} className="outline-none" style={{ ...FIELD, height: 'auto', padding: '7px 9px', resize: 'vertical' }} />
            ) : null}
          </Section>
          <Footer error={error}>
            <Button tone="quiet" onClick={() => setMode('advanced')}>Advanced editor</Button>
            {loaded.flow ? <Button tone="ghost" disabled={busy} onClick={() => { if (window.confirm('Go back to default routing (owner, then voicemail)?')) void save(true); }}>Use default</Button> : null}
            <Button tone="accent" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save call flow'}</Button>
          </Footer>
        </div>
      )}
    </Modal>
  );
}

// ── Texts ────────────────────────────────────────────────────────────────────

export function SmsFlowModal({ line, workspaceId, userId, people, saved, onClose, onSaved }: {
  line: BookLine; workspaceId: number; userId: string | null; people: ClozrPerson[]; saved: SmsFlow | null; onClose: () => void; onSaved: () => void;
}) {
  const [f, setF] = useState<SmsFlow>(() => saved ?? blankSmsFlow(line.phone, line.talkr?.id ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(clear = false) {
    if (!supabase) return;
    setBusy(true); setError(null);
    try {
      if (clear) {
        const { error: e } = await supabase.from('line_sms_flows' as never).delete().eq('workspace_id', workspaceId).eq('phone_e164', line.phone);
        if (e) throw new Error(e.message);
      } else {
        const clean = cleanSmsFlow({ ...f, talkr_number_id: line.talkr?.id ?? f.talkr_number_id });
        if (!clean.ok) { setError(clean.error); return; }
        const { error: e } = await supabase.from('line_sms_flows' as never).upsert({ ...clean.flow, workspace_id: workspaceId, updated_by: userId, updated_at: new Date().toISOString() } as never, { onConflict: 'workspace_id,phone_e164' });
        if (e) throw new Error(/line_sms_flows/.test(e.message) ? 'SMS flows need migration 200 (applies when this merges).' : e.message);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const notify = (id: string, on: boolean) => setF({ ...f, notify_user_ids: on ? [...f.notify_user_ids, id] : f.notify_user_ids.filter((x) => x !== id) });
  return (
    <Modal title={`SMS flow · ${formatPhone(line.phone)}`} onClose={onClose} width={580}>
      <div className="flex flex-col">
        <Section title="Texts notify">
          <span style={LABEL}>None picked: the conversation’s rep, else the line’s owner.</span>
          <div className="grid gap-x-4 gap-y-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
            {people.map((p) => <Check key={p.userId} on={f.notify_user_ids.includes(p.userId)} onChange={(on) => notify(p.userId, on)}>{p.name}</Check>)}
          </div>
        </Section>
        <Section title="Auto-reply" right={<Toggle on={f.auto_reply_enabled} label="Auto-reply" onChange={(on) => setF({ ...f, auto_reply_enabled: on })} />}>
          {f.auto_reply_enabled ? (
            <>
              <textarea rows={3} maxLength={480} value={f.auto_reply_body ?? ''} aria-label="Auto-reply message" onChange={(e) => setF({ ...f, auto_reply_body: e.target.value })} className="outline-none" style={{ ...FIELD, height: 'auto', padding: '7px 9px', resize: 'vertical' }} />
              <div className="flex flex-wrap items-center gap-2" style={ROW}>
                <Segmented value={f.auto_reply_when} onChange={(auto_reply_when) => setF({ ...f, auto_reply_when, hours: auto_reply_when === 'after_hours' ? (f.hours ?? DEFAULT_HOURS) : f.hours })} options={[{ value: 'always', label: 'Always' }, { value: 'after_hours', label: 'After hours' }]} />
                <span style={LABEL}>Once per texter every</span>
                <input type="number" min={0} max={720} value={f.cooldown_hours} onChange={(e) => setF({ ...f, cooldown_hours: Number(e.target.value) })} aria-label="Cooldown hours" className="outline-none" style={{ ...FIELD, width: 72, height: 30 }} />
                <span style={LABEL}>hours</span>
              </div>
              {f.auto_reply_when === 'after_hours' ? <HoursEditor value={f.hours ?? DEFAULT_HOURS} onChange={(hours) => setF({ ...f, hours })} /> : null}
              {!line.talkr ? <span style={{ ...LABEL, color: 'var(--amber)' }}>Not a Talkr line: replies cannot be sent from it.</span> : null}
            </>
          ) : <span style={LABEL}>Off. STOP and HELP never get one.</span>}
        </Section>
        <Footer error={error}>
          {saved ? <Button tone="ghost" disabled={busy} onClick={() => void save(true)}>Use default</Button> : null}
          <Button tone="accent" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save SMS flow'}</Button>
        </Footer>
      </div>
    </Modal>
  );
}
