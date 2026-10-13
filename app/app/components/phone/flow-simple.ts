// The smrtPhone-shaped call flow: optional business hours, ring these people
// (all at once, in order or round-robin) for N seconds, optionally forward,
// then voicemail. Closed hours go straight to voicemail. It is a subset of
// Talkr's flow graph (flow.ts): fromFlow returns null for anything richer
// (menus, branches on busy, greetings per step), which opens in the full
// editor instead.

import type { CallFlowDto, DayKey, FlowNode, FlowTarget } from '@/lib/talkr';

export type SimpleHours = { timezone: string; schedule: Partial<Record<DayKey, Array<[string, string]>>>; holidays: string[] };
export type SimpleFlow = {
  hours: SimpleHours | null;
  ring: { strategy: 'all' | 'sequential' | 'round_robin'; targets: FlowTarget[]; timeout_seconds: number };
  forward: { e164: string; timeout_seconds: number } | null;
  voicemail_user_id: string | null;
};
export type FlowSettings = Omit<CallFlowDto, 'version' | 'start' | 'nodes'>;

export const DEFAULT_FLOW_SETTINGS: FlowSettings = { recording: true, announce: null, whisper: null, voicemail_greeting: null, missed_call_text: null };

const WEEKDAY: Array<[string, string]> = [['09:00', '17:00']];
export const DEFAULT_SIMPLE_HOURS: SimpleHours = { timezone: 'America/Chicago', schedule: { mon: WEEKDAY, tue: WEEKDAY, wed: WEEKDAY, thu: WEEKDAY, fri: WEEKDAY }, holidays: [] };

/** A starting flow: ring these targets for 20 seconds, then this person's voicemail. */
export function starterFlow(targets: FlowTarget[], voicemailUserId: string | null): SimpleFlow {
  return { hours: null, ring: { strategy: 'all', targets: targets.length ? targets : [{ kind: 'everyone' }], timeout_seconds: 20 }, forward: null, voicemail_user_id: voicemailUserId };
}

type Node<T extends FlowNode['type']> = Extract<FlowNode, { type: T }>;

/** The simple form of a saved flow, or null when the flow does more than the simple editor shows. */
export function fromFlow(flow: CallFlowDto | null | undefined): SimpleFlow | null {
  if (!flow) return null;
  const at = (id: string | null | undefined): FlowNode | null => (id ? flow.nodes[id] ?? null : null);
  const plainVoicemail = (n: FlowNode | null): n is Node<'voicemail'> => n?.type === 'voicemail' && !n.greeting;

  let first = at(flow.start);
  let hours: SimpleHours | null = null;
  let closedVm: Node<'voicemail'> | null = null;
  if (first?.type === 'hours') {
    const closed = at(first.closed);
    if (!plainVoicemail(closed)) return null;
    closedVm = closed;
    hours = { timezone: first.timezone, schedule: first.schedule, holidays: first.holidays };
    first = at(first.open);
  }
  if (first?.type !== 'ring' || first.busy !== undefined) return null;
  const ring = first;
  let next = at(ring.no_answer);
  let forward: SimpleFlow['forward'] = null;
  if (next?.type === 'forward') {
    if (next.to.kind !== 'e164') return null;
    forward = { e164: next.to.e164, timeout_seconds: next.timeout_seconds };
    next = at(next.no_answer);
  }
  if (!plainVoicemail(next)) return null;
  const vmUser = next.user_id ?? null;
  if (closedVm && (closedVm.user_id ?? null) !== vmUser) return null;
  return { hours, ring: { strategy: ring.strategy, targets: ring.targets, timeout_seconds: ring.timeout_seconds }, forward, voicemail_user_id: vmUser };
}

/** The Talkr flow for a simple one. */
export function toFlowDto(s: SimpleFlow, settings: FlowSettings): CallFlowDto {
  const nodes: Record<string, FlowNode> = {};
  nodes.vm = { type: 'voicemail', greeting: null, user_id: s.voicemail_user_id };
  if (s.forward) nodes.fwd = { type: 'forward', to: { kind: 'e164', e164: s.forward.e164 }, timeout_seconds: s.forward.timeout_seconds, no_answer: 'vm' };
  nodes.ring = { type: 'ring', strategy: s.ring.strategy, targets: s.ring.targets, timeout_seconds: s.ring.timeout_seconds, no_answer: s.forward ? 'fwd' : 'vm' };
  let start = 'ring';
  if (s.hours) {
    nodes.hours = { type: 'hours', timezone: s.hours.timezone, schedule: s.hours.schedule, holidays: s.hours.holidays, open: 'ring', closed: 'vm' };
    start = 'hours';
  }
  return { version: 2, ...settings, start, nodes };
}

/** What is wrong with a simple flow before Talkr is asked, or null. */
export function simpleFlowError(s: SimpleFlow): string | null {
  if (!s.ring.targets.length) return 'Pick who it rings';
  if (s.ring.timeout_seconds < 5 || s.ring.timeout_seconds > 120) return 'Ring for 5 to 120 seconds';
  if (s.forward && !/^\+1\d{10}$/.test(s.forward.e164)) return 'Enter the forward number in full';
  if (s.hours && !Object.values(s.hours.schedule).some((r) => r && r.length)) return 'Open at least one day, or turn business hours off';
  return null;
}

/** "Ring Morgan, Casey · 20s → voicemail" for the row under a number. */
export function describeSimple(s: SimpleFlow, nameOf: (t: FlowTarget) => string): string {
  const who = s.ring.targets.map(nameOf);
  const names = who.length <= 2 ? who.join(', ') : `${who[0]} +${who.length - 1}`;
  const order = s.ring.strategy === 'sequential' ? ' in order' : s.ring.strategy === 'round_robin' ? ' round-robin' : '';
  return [s.hours ? 'Hours' : null, `Ring ${names}${order} · ${s.ring.timeout_seconds}s`, s.forward ? 'Forward' : null, 'Voicemail'].filter(Boolean).join(' → ');
}
