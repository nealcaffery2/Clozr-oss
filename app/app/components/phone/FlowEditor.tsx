// The routing editor for one number: a vertical flow of cards (Hours → Menu /
// Ring → Forward → Voicemail …), branches nested under the card they leave
// from, flow-wide settings (recording, announce, whisper, voicemail greeting,
// missed-call text), and a test-call simulator that runs the draft on Talkr's
// server — the same executor live calls use.
'use client';

import React, { useEffect, useState } from 'react';
import { IosSegmented } from '@/app/components/talkr/ios';
import { formatPhone, talkr, toE164, type CallFlowDto, type DayKey, type FlowNode, type FlowSimulationDto, type FlowTarget, type PhoneNumberDto } from '@/lib/talkr';
import { STEP_LABEL, blankBranches, blankNode, isTerminal, newKey, toFlow, toTree, type Step, type StepType } from './flow';
import { GreetingEditor } from './Greeting';
import { refreshPhoneAdmin, usePhoneAdmin } from './store';
import { Btn, GREEN, LINE, MUTED, NoteBox, errText, field, label, type Note } from './ui';

type Settings = Omit<CallFlowDto, 'version' | 'start' | 'nodes'>;
type Ctx = { members: Array<{ id: string; display_name: string }>; numbers: PhoneNumberDto[]; selfId: string };

const DEFAULT_SETTINGS: Settings = { recording: true, announce: null, whisper: null, voicemail_greeting: null, missed_call_text: null };
const DAYS: Array<[DayKey, string]> = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles'];
const ADDABLE: StepType[] = ['hours', 'menu', 'ring', 'forward', 'voicemail', 'number_flow', 'hangup'];
const OUTCOME: Record<string, string> = { answered: 'Answered', forwarded: 'Answered on a forwarded phone', voicemail: 'Ended in voicemail', hangup: 'Hung up', default_routing: 'Handed to default routing' };

export function FlowEditor({ number, isMobile }: { number: PhoneNumberDto; isMobile: boolean }) {
  const admin = usePhoneAdmin();
  const [loaded, setLoaded] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [legacy, setLegacy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ctx: Ctx = { members: admin.members.filter((m) => m.status === 'active'), numbers: admin.numbers.filter((n) => n.status === 'active'), selfId: number.id };

  useEffect(() => {
    let live = true;
    void talkr.routing(number.id).then((r) => {
      if (!live) return;
      setLegacy(Boolean(r.legacy_ivr));
      if (r.flow) {
        const f = r.flow;
        setSettings({ recording: f.recording, announce: f.announce ?? null, whisper: f.whisper ?? null, voicemail_greeting: f.voicemail_greeting ?? null, missed_call_text: f.missed_call_text ?? null });
        setSteps(toTree(r.flow));
      }
      setLoaded(true);
    }).catch((err) => setNote({ ok: false, text: errText(err) }));
    return () => { live = false; };
  }, [number.id]);

  const draft = () => toFlow(steps, settings);

  async function save(clear = false) {
    setBusy(clear ? 'clear' : 'save'); setNote(null);
    try {
      await talkr.saveRouting(number.id, clear ? null : draft());
      if (clear) setSteps([]);
      setNote({ ok: true, text: clear ? 'Flow removed — the number uses default routing again.' : 'Routing saved. The next call follows it.' });
      await refreshPhoneAdmin();
    } catch (err) {
      setNote({ ok: false, text: errText(err) });
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) return <div style={{ padding: '10px 12px', fontSize: '12px', color: MUTED }}>{note ? <NoteBox note={note} /> : 'Loading routing…'}</div>;

  return (
    <div style={{ padding: '12px', background: '#fafafa', borderTop: `1px solid ${LINE}` }}>
      {legacy && steps.length === 0 ? <div style={{ fontSize: '12px', color: '#92400e', marginBottom: '8px' }}>This number has the older digit menu. Saving a flow here replaces it.</div> : null}
      {steps.length === 0 ? (
        <div style={{ fontSize: '12.5px', color: MUTED, marginBottom: '8px' }}>No flow yet — calls use the default routing (the seller&rsquo;s owner, the line&rsquo;s owner, then voicemail). Add a first step to take control.</div>
      ) : null}

      <StepList steps={steps} onChange={setSteps} ctx={ctx} depth={0} />

      <div style={{ marginTop: '14px', padding: '12px', background: '#fff', border: `1px solid ${LINE}`, borderRadius: '10px', display: 'grid', gap: '10px' }}>
        <span style={label}>On every call to {formatPhone(number.phone_e164)}</span>
        <label style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12.5px' }}>
          <input type="checkbox" checked={settings.recording} onChange={(e) => setSettings({ ...settings, recording: e.target.checked })} style={{ accentColor: GREEN }} />
          Record calls
        </label>
        <TextSetting title="Caller hears first (announce)" placeholder="This call may be recorded." value={settings.announce} onChange={(v) => setSettings({ ...settings, announce: v })} />
        <TextSetting title="Teammate hears on pickup (whisper)" placeholder="Call from the main line." value={settings.whisper} onChange={(v) => setSettings({ ...settings, whisper: v })} />
        <div>
          <span style={label}>This number&rsquo;s voicemail greeting</span>
          <GreetingEditor value={settings.voicemail_greeting} onChange={(g) => setSettings({ ...settings, voicemail_greeting: g })} allowDefault defaultLabel="The line owner’s greeting, else the workspace default." />
        </div>
        <div>
          <label style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12.5px' }}>
            <input
              type="checkbox"
              checked={Boolean(settings.missed_call_text?.enabled)}
              onChange={(e) => setSettings({ ...settings, missed_call_text: { body: settings.missed_call_text?.body ?? 'Hi {first_name}, sorry we missed your call. We will call you right back.', cooldown_hours: settings.missed_call_text?.cooldown_hours ?? 24, enabled: e.target.checked } })}
              style={{ accentColor: GREEN }}
            />
            Text callers we miss (voicemail or hang-up)
          </label>
          {settings.missed_call_text?.enabled ? (
            <div style={{ display: 'grid', gap: '6px', marginTop: '6px' }}>
              <textarea rows={2} maxLength={480} value={settings.missed_call_text.body} onChange={(e) => setSettings({ ...settings, missed_call_text: { ...settings.missed_call_text!, body: e.target.value } })} style={{ ...field, height: 'auto', padding: '7px 9px', width: '100%' }} />
              <div style={{ fontSize: '12px', color: MUTED, display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                Merge fields like {'{first_name}'} fill in when the caller is a contact. At most one text per caller every
                <input type="number" min={0} max={720} value={settings.missed_call_text.cooldown_hours} onChange={(e) => setSettings({ ...settings, missed_call_text: { ...settings.missed_call_text!, cooldown_hours: Number(e.target.value) || 0 } })} style={{ ...field, width: '64px' }} />
                hours. Opt-outs and quiet hours still apply.
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <Simulator numberId={number.id} draft={draft} ctx={ctx} isMobile={isMobile} />

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
        <Btn primary disabled={Boolean(busy) || steps.length === 0} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save routing'}</Btn>
        <Btn danger disabled={Boolean(busy)} onClick={() => { if (window.confirm('Remove this flow? The number goes back to default routing.')) void save(true); }}>Remove flow</Btn>
      </div>
      <NoteBox note={note} />
    </div>
  );
}

function TextSetting({ title, value, placeholder, onChange }: { title: string; value: string | null | undefined; placeholder: string; onChange: (v: string | null) => void }) {
  return (
    <label style={{ display: 'grid', gap: '4px' }}>
      <span style={label}>{title}</span>
      <input value={value ?? ''} placeholder={placeholder} maxLength={300} onChange={(e) => onChange(e.target.value || null)} style={{ ...field, width: '100%' }} />
    </label>
  );
}

function StepList({ steps, onChange, ctx, depth, emptyText }: { steps: Step[]; onChange: (s: Step[]) => void; ctx: Ctx; depth: number; emptyText?: string }) {
  const ended = steps.some((s) => isTerminal(s.node.type));
  const put = (i: number, next: Step | null) => onChange(next ? steps.map((s, j) => (j === i ? next : s)) : steps.filter((_, j) => j !== i));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const copy = [...steps];
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    onChange(copy);
  };
  return (
    <div style={{ display: 'grid', gap: '6px' }}>
      {steps.length === 0 && emptyText ? <div style={{ fontSize: '12px', color: MUTED }}>{emptyText}</div> : null}
      {steps.map((step, i) => (
        <React.Fragment key={step.key}>
          {i > 0 ? <div style={{ fontSize: '11px', color: MUTED, paddingLeft: '14px' }}>↓ {thenLabel(steps[i - 1]!.node)}</div> : null}
          <StepCard step={step} ctx={ctx} depth={depth} onChange={(s) => put(i, s)} onRemove={() => put(i, null)} onUp={i > 0 ? () => move(i, -1) : undefined} onDown={i < steps.length - 1 ? () => move(i, 1) : undefined} />
        </React.Fragment>
      ))}
      {!ended ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {steps.length > 0 ? <span style={{ fontSize: '11px', color: MUTED }}>↓ {thenLabel(steps[steps.length - 1]!.node)} —</span> : null}
          <select
            value=""
            onChange={(e) => {
              const type = e.target.value as StepType;
              if (type) onChange([...steps, { key: newKey(), node: blankNode(type), branches: blankBranches(type) }]);
            }}
            style={{ ...field, height: '28px' }}
          >
            <option value="">{steps.length ? '+ Add next step' : '+ Add a step'}{steps.length ? ' (else voicemail)' : ''}</option>
            {ADDABLE.map((t) => <option key={t} value={t}>{STEP_LABEL[t]}</option>)}
          </select>
        </div>
      ) : null}
    </div>
  );
}

function thenLabel(node: FlowNode): string {
  if (node.type === 'hours') return 'when open';
  if (node.type === 'menu') return 'no key pressed';
  return 'if no answer';
}

function StepCard({ step, ctx, depth, onChange, onRemove, onUp, onDown }: {
  step: Step; ctx: Ctx; depth: number; onChange: (s: Step) => void; onRemove: () => void; onUp?: () => void; onDown?: () => void;
}) {
  const node = step.node;
  const set = (patch: Partial<FlowNode>) => onChange({ ...step, node: { ...node, ...patch } as FlowNode });
  const setBranch = (edge: string, list: Step[] | undefined) => {
    const branches = { ...step.branches };
    if (list) branches[edge] = list; else delete branches[edge];
    return branches;
  };
  const who = (id: string | null | undefined) => ctx.members.find((m) => m.id === id)?.display_name ?? 'someone';

  return (
    <div style={{ background: '#fff', border: `1px solid ${LINE}`, borderLeft: `3px solid ${GREEN}`, borderRadius: '10px', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
        <span style={{ fontSize: '12.5px', fontWeight: 700, flex: 1 }}>{STEP_LABEL[node.type]}</span>
        {onUp ? <Btn small title="Move up" onClick={onUp}>↑</Btn> : null}
        {onDown ? <Btn small title="Move down" onClick={onDown}>↓</Btn> : null}
        <Btn small danger title="Remove step" onClick={onRemove}>✕</Btn>
      </div>

      {node.type === 'hours' ? (
        <div style={{ display: 'grid', gap: '6px' }}>
          <select value={node.timezone} onChange={(e) => set({ timezone: e.target.value })} style={{ ...field, width: '220px' }}>
            {[...new Set([node.timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z.replace('America/', '').replace('_', ' ')} time</option>)}
          </select>
          {DAYS.map(([d, name]) => {
            const range = node.schedule[d]?.[0];
            return (
              <div key={d} style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' }}>
                <label style={{ width: '58px', display: 'flex', gap: '5px', alignItems: 'center' }}>
                  <input type="checkbox" checked={Boolean(range)} onChange={(e) => set({ schedule: { ...node.schedule, [d]: e.target.checked ? [['09:00', '17:00']] : [] } })} style={{ accentColor: GREEN }} />{name}
                </label>
                {range ? (
                  <>
                    <input type="time" value={range[0]} onChange={(e) => set({ schedule: { ...node.schedule, [d]: [[e.target.value, range[1]]] } })} style={{ ...field, height: '28px' }} />
                    –
                    <input type="time" value={range[1]} onChange={(e) => set({ schedule: { ...node.schedule, [d]: [[range[0], e.target.value]] } })} style={{ ...field, height: '28px' }} />
                  </>
                ) : <span style={{ color: MUTED }}>closed</span>}
              </div>
            );
          })}
          <label style={{ display: 'grid', gap: '3px' }}>
            <span style={{ fontSize: '11.5px', color: MUTED }}>Holidays (closed all day), comma-separated YYYY-MM-DD</span>
            <input value={node.holidays.join(', ')} placeholder="2026-11-26, 2026-12-25" onChange={(e) => set({ holidays: e.target.value.split(/[,\s]+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) })} style={{ ...field, width: '100%' }} />
          </label>
          <Branch title="When closed" steps={step.branches.closed ?? []} ctx={ctx} depth={depth} onChange={(l) => onChange({ ...step, branches: setBranch('closed', l) })} />
        </div>
      ) : null}

      {node.type === 'ring' ? (
        <div style={{ display: 'grid', gap: '8px' }}>
          <IosSegmented
            value={node.strategy}
            options={[{ value: 'all', label: 'All at once' }, { value: 'sequential', label: 'In order' }, { value: 'round_robin', label: 'Round-robin' }]}
            onChange={(strategy) => set({ strategy })}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: '12.5px' }}>
            {([['last_contact', 'Rep who last reached out'], ['everyone', 'Everyone'], ['lead_owner', 'Seller’s owner']] as const).map(([kind, name]) => (
              <TargetBox key={kind} label={name} target={{ kind }} node={node} set={set} />
            ))}
            {ctx.members.map((m) => <TargetBox key={m.id} label={m.display_name} target={{ kind: 'user', user_id: m.id }} node={node} set={set} />)}
          </div>
          {node.strategy !== 'all' ? <div style={{ fontSize: '11.5px', color: MUTED }}>Rings one person at a time{node.strategy === 'round_robin' ? ', starting with whoever was rung longest ago' : ', in the order checked'}. Away teammates are skipped.</div> : null}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', flexWrap: 'wrap' }}>
            Ring for <input type="number" min={5} max={120} value={node.timeout_seconds} onChange={(e) => set({ timeout_seconds: Number(e.target.value) || 20 })} style={{ ...field, width: '64px', height: '28px' }} /> seconds{node.strategy === 'all' ? '' : ' each'}
            <label style={{ marginLeft: 'auto', display: 'flex', gap: '5px', alignItems: 'center' }}>
              <input type="checkbox" checked={step.branches.busy !== undefined} onChange={(e) => onChange({ ...step, branches: setBranch('busy', e.target.checked ? [] : undefined) })} style={{ accentColor: GREEN }} />
              Different path when busy
            </label>
          </div>
          {step.branches.busy ? <Branch title="If busy" steps={step.branches.busy} ctx={ctx} depth={depth} onChange={(l) => onChange({ ...step, branches: setBranch('busy', l) })} /> : null}
        </div>
      ) : null}

      {node.type === 'menu' ? (
        <div style={{ display: 'grid', gap: '8px' }}>
          <GreetingEditor value={node.greeting} onChange={(g) => set({ greeting: g ?? { tts: '' } })} />
          {Object.keys(node.options).sort().map((digit) => (
            <div key={digit} style={{ display: 'grid', gap: '4px' }}>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <span style={{ fontSize: '12px', fontWeight: 700 }}>Press {digit}</span>
                <Btn small danger onClick={() => {
                  const options = { ...node.options };
                  delete options[digit];
                  onChange({ ...step, node: { ...node, options }, branches: setBranch(digit, undefined) });
                }}>Remove key</Btn>
              </div>
              <Branch steps={step.branches[digit] ?? []} ctx={ctx} depth={depth} onChange={(l) => onChange({ ...step, branches: setBranch(digit, l) })} />
            </div>
          ))}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', flexWrap: 'wrap' }}>
            <select value="" onChange={(e) => {
              const d = e.target.value;
              if (d) onChange({ ...step, node: { ...node, options: { ...node.options, [d]: null } }, branches: setBranch(d, []) });
            }} style={{ ...field, height: '28px' }}>
              <option value="">+ Add a key</option>
              {'1234567890*#'.split('').filter((d) => !(d in node.options)).map((d) => <option key={d} value={d}>Press {d}</option>)}
            </select>
            Wait <input type="number" min={3} max={30} value={node.timeout_seconds} onChange={(e) => set({ timeout_seconds: Number(e.target.value) || 6 })} style={{ ...field, width: '56px', height: '28px' }} />s, replay
            <input type="number" min={0} max={3} value={node.repeat} onChange={(e) => set({ repeat: Math.max(0, Math.min(3, Number(e.target.value) || 0)) })} style={{ ...field, width: '52px', height: '28px' }} /> times on no/invalid key
          </div>
        </div>
      ) : null}

      {node.type === 'forward' ? (
        <div style={{ display: 'grid', gap: '6px' }}>
          <IosSegmented
            value={node.to.kind}
            options={[{ value: 'personal', label: 'A teammate’s own phone' }, { value: 'e164', label: 'Any number' }]}
            onChange={(kind) => set({ to: kind === 'personal' ? { kind, user_id: ctx.members[0]?.id ?? '' } : { kind, e164: '' } })}
          />
          {node.to.kind === 'personal' ? (
            <select value={node.to.user_id} onChange={(e) => set({ to: { kind: 'personal', user_id: e.target.value } })} style={{ ...field, width: '240px' }}>
              {ctx.members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
          ) : (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <input value={node.to.e164} placeholder="(210) 555-0100" onChange={(e) => set({ to: { kind: 'e164', e164: toE164(e.target.value) ?? e.target.value } })} style={{ ...field, width: '170px' }} />
              <select value="" onChange={(e) => e.target.value && set({ to: { kind: 'e164', e164: e.target.value } })} style={field}>
                <option value="">or a Talkr line…</option>
                {ctx.numbers.filter((n) => n.id !== ctx.selfId).map((n) => <option key={n.id} value={n.phone_e164}>{formatPhone(n.phone_e164)}{n.assigned_user_name ? ` · ${n.assigned_user_name}` : ''}</option>)}
              </select>
            </div>
          )}
          {node.to.kind === 'personal' ? <div style={{ fontSize: '11.5px', color: MUTED }}>Uses the personal phone saved on {who(node.to.user_id)} in Team; skipped if none.</div> : null}
          <div style={{ fontSize: '12px' }}>Ring for <input type="number" min={5} max={120} value={node.timeout_seconds} onChange={(e) => set({ timeout_seconds: Number(e.target.value) || 25 })} style={{ ...field, width: '64px', height: '28px' }} /> seconds</div>
        </div>
      ) : null}

      {node.type === 'number_flow' ? (
        <select value={node.phone_number_id} onChange={(e) => set({ phone_number_id: e.target.value })} style={{ ...field, width: '280px' }}>
          <option value="">Choose a number…</option>
          {ctx.numbers.filter((n) => n.id !== ctx.selfId).map((n) => <option key={n.id} value={n.id}>{formatPhone(n.phone_e164)}{n.routing_mode === 'flow' ? '' : ' (no flow — voicemail)'}</option>)}
        </select>
      ) : null}

      {node.type === 'voicemail' ? (
        <div style={{ display: 'grid', gap: '6px' }}>
          <select value={node.user_id ?? ''} onChange={(e) => set({ user_id: e.target.value || null })} style={{ ...field, width: '260px' }}>
            <option value="">The line&rsquo;s voicemail</option>
            {ctx.members.map((m) => <option key={m.id} value={m.id}>{m.display_name}&rsquo;s voicemail</option>)}
          </select>
          <GreetingEditor value={node.greeting} onChange={(g) => set({ greeting: g })} allowDefault defaultLabel="Their personal greeting, else this number’s, else the workspace default." />
        </div>
      ) : null}

      {node.type === 'hangup' ? (
        <input value={node.message ?? ''} placeholder="Optional goodbye message" onChange={(e) => set({ message: e.target.value || null })} style={{ ...field, width: '100%' }} />
      ) : null}
    </div>
  );
}

function TargetBox({ label: text, target, node, set }: { label: string; target: FlowTarget; node: Extract<FlowNode, { type: 'ring' }>; set: (p: Partial<FlowNode>) => void }) {
  const same = (t: FlowTarget) => t.kind === target.kind && (t.kind !== 'user' || (target.kind === 'user' && t.user_id === target.user_id));
  const on = node.targets.some(same);
  return (
    <label style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
      <input type="checkbox" checked={on} onChange={() => set({ targets: on ? node.targets.filter((t) => !same(t)) : [...node.targets, target] })} style={{ accentColor: GREEN }} />
      {text}
    </label>
  );
}

function Branch({ title, steps, ctx, depth, onChange }: { title?: string; steps: Step[]; ctx: Ctx; depth: number; onChange: (s: Step[]) => void }) {
  return (
    <div style={{ marginLeft: '6px', paddingLeft: '10px', borderLeft: `2px dashed ${LINE}` }}>
      {title ? <div style={{ fontSize: '11.5px', fontWeight: 700, color: '#52525b', margin: '2px 0 4px' }}>{title}</div> : null}
      <StepList steps={steps} onChange={onChange} ctx={ctx} depth={depth + 1} emptyText="Nothing here yet — goes to voicemail." />
    </div>
  );
}

function Simulator({ numberId, draft, ctx, isMobile }: { numberId: string; draft: () => CallFlowDto | null; ctx: Ctx; isMobile: boolean }) {
  const [at, setAt] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  });
  const [from, setFrom] = useState('');
  const [digits, setDigits] = useState('');
  const [answeredBy, setAnsweredBy] = useState('');
  const [away, setAway] = useState<string[]>([]);
  const [result, setResult] = useState<FlowSimulationDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function simulate() {
    const flow = draft();
    if (!flow) return setError('Add a step first.');
    setBusy(true); setError(null);
    try {
      setResult(await talkr.simulateRouting(numberId, {
        flow,
        at: new Date(at).toISOString(),
        from: toE164(from) ?? undefined,
        digits: digits || undefined,
        answered_by: answeredBy || null,
        unavailable_user_ids: away,
      }));
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: '12px', padding: '12px', background: '#fff', border: `1px solid ${LINE}`, borderRadius: '10px' }}>
      <span style={label}>Test call</span>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, minmax(0,1fr))', gap: '6px' }}>
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} style={field} title="When the call comes in (your time)" />
        <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Caller (optional)" style={field} />
        <input value={digits} onChange={(e) => setDigits(e.target.value.replace(/[^0-9*#]/g, '').slice(0, 10))} placeholder="Keys pressed, e.g. 1" style={field} />
        <select value={answeredBy} onChange={(e) => setAnsweredBy(e.target.value)} style={field}>
          <option value="">Nobody answers</option>
          <option value="forward">A forwarded phone answers</option>
          {ctx.members.map((m) => <option key={m.id} value={m.id}>{m.display_name} answers</option>)}
        </select>
      </div>
      {ctx.members.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: '12px', color: MUTED, marginTop: '6px' }}>
          Away:
          {ctx.members.map((m) => (
            <label key={m.id} style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
              <input type="checkbox" checked={away.includes(m.id)} onChange={(e) => setAway(e.target.checked ? [...away, m.id] : away.filter((x) => x !== m.id))} style={{ accentColor: GREEN }} />
              {m.display_name}
            </label>
          ))}
        </div>
      ) : null}
      <div style={{ marginTop: '8px' }}><Btn disabled={busy} onClick={() => void simulate()}>{busy ? 'Running…' : 'Run test call'}</Btn></div>
      {error ? <div style={{ fontSize: '12px', color: '#b91c1c', marginTop: '6px', whiteSpace: 'pre-wrap' }}>{error}</div> : null}
      {result ? (
        result.valid ? (
          <ol style={{ margin: '8px 0 0', paddingLeft: '18px', fontSize: '12.5px', lineHeight: 1.7 }}>
            {result.path.map((p, i) => <li key={i}><b>{STEP_LABEL[p.type as StepType] ?? p.type.replace(/_/g, ' ')}</b> — {p.detail}</li>)}
            <li style={{ listStyle: 'none', marginLeft: '-18px', marginTop: '4px', fontWeight: 700, color: GREEN }}>{OUTCOME[result.outcome ?? ''] ?? result.outcome}</li>
          </ol>
        ) : (
          <div style={{ fontSize: '12px', color: '#b91c1c', marginTop: '6px' }}>This flow would be refused:<br />• {result.errors.join('\n• ')}</div>
        )
      ) : null}
    </div>
  );
}
