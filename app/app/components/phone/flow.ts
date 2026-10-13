// Call flow ⇄ editor tree.
//
// Talkr stores a flow as a graph of steps with pointers (validated server side:
// no loops, nothing unreachable). People edit a vertical list of cards, so the
// editor works on a tree: each step's "then" pointer is the next card in the
// same list, and its other exits (closed, busy, press 1…) are nested lists.
// A step two branches share is simply copied into both on load.

import type { CallFlowDto, FlowNode } from '@/lib/talkr';

export type StepType = FlowNode['type'];

/** A card: the node's own settings (pointers ignored) plus its nested branches. */
export type Step = { key: string; node: FlowNode; branches: Record<string, Step[]> };

let seq = 0;
export const newKey = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The pointer that continues the list; terminal steps have none. */
const THEN: Partial<Record<StepType, 'open' | 'no_answer' | 'no_input'>> = { hours: 'open', ring: 'no_answer', menu: 'no_input', forward: 'no_answer' };
export const isTerminal = (t: StepType) => !THEN[t];

function branchEdges(node: FlowNode): Array<[string, string | null]> {
  if (node.type === 'hours') return [['closed', node.closed]];
  if (node.type === 'ring') return node.busy !== undefined ? [['busy', node.busy ?? null]] : [];
  if (node.type === 'menu') return Object.entries(node.options);
  return [];
}

export function toTree(flow: CallFlowDto | null): Step[] {
  if (!flow) return [];
  const chain = (id: string | null, depth = 0): Step[] => {
    const out: Step[] = [];
    while (id && flow.nodes[id] && depth < 60) {
      const node = flow.nodes[id]!;
      const branches: Record<string, Step[]> = {};
      for (const [edge, target] of branchEdges(node)) branches[edge] = chain(target, depth + 1);
      out.push({ key: newKey(), node, branches });
      const then = THEN[node.type];
      id = then ? ((node as Record<string, unknown>)[then] as string | null) : null;
      depth++;
    }
    return out;
  };
  return chain(flow.start);
}

/** Tree → graph with fresh ids. An empty list becomes null (Talkr: voicemail). */
export function toFlow(steps: Step[], settings: Omit<CallFlowDto, 'version' | 'start' | 'nodes'>): CallFlowDto | null {
  const nodes: Record<string, FlowNode> = {};
  let n = 0;
  const build = (list: Step[]): string | null => {
    let next: string | null = null;
    // Steps after a terminal one would never run.
    const end = list.findIndex((s) => isTerminal(s.node.type));
    const live = end >= 0 ? list.slice(0, end + 1) : list;
    for (let i = live.length - 1; i >= 0; i--) {
      const step = live[i]!;
      const id = `s${++n}`;
      const node = { ...step.node } as Record<string, unknown>;
      const then = THEN[step.node.type];
      if (then) node[then] = next;
      if (step.node.type === 'hours') node.closed = build(step.branches.closed ?? []);
      if (step.node.type === 'ring') {
        if (step.branches.busy) node.busy = build(step.branches.busy);
        else delete node.busy;
      }
      if (step.node.type === 'menu') {
        node.options = Object.fromEntries(Object.keys(step.node.options).sort().map((d) => [d, build(step.branches[d] ?? [])]));
      }
      nodes[id] = node as FlowNode;
      next = id;
    }
    return next;
  };
  const start = build(steps);
  return start ? { version: 2, ...settings, start, nodes } : null;
}

export const STEP_LABEL: Record<StepType, string> = {
  hours: 'Business hours',
  ring: 'Ring',
  menu: 'Menu',
  forward: 'Forward',
  number_flow: 'Send to another number',
  voicemail: 'Voicemail',
  hangup: 'Hang up',
};

export function blankNode(type: StepType): FlowNode {
  switch (type) {
    case 'hours': {
      const day: Array<[string, string]> = [['09:00', '17:00']];
      return { type, timezone: 'America/Chicago', schedule: { mon: day, tue: day, wed: day, thu: day, fri: day }, holidays: [], open: null, closed: null };
    }
    case 'ring': return { type, strategy: 'all', targets: [{ kind: 'everyone' }], timeout_seconds: 20, no_answer: null };
    case 'menu': return { type, greeting: { tts: 'Thanks for calling. Press 1 to reach our team.' }, options: { '1': null }, timeout_seconds: 6, repeat: 1, no_input: null };
    case 'forward': return { type, to: { kind: 'e164', e164: '' }, timeout_seconds: 25, no_answer: null };
    case 'number_flow': return { type, phone_number_id: '' };
    case 'voicemail': return { type, greeting: null, user_id: null };
    case 'hangup': return { type, message: null };
  }
}

export function blankBranches(type: StepType): Record<string, Step[]> {
  if (type === 'hours') return { closed: [{ key: newKey(), node: blankNode('voicemail'), branches: {} }] };
  if (type === 'menu') return { '1': [] };
  return {};
}

/** "Hours → Ring all → Forward → Voicemail" from a number's step types. */
export function routingSummary(mode: string | undefined, steps: string[] | undefined, standby: boolean | undefined): string {
  if (mode === 'flow' && steps?.length) {
    const names = steps.map((t) => STEP_LABEL[t as StepType] ?? t);
    return names.length > 4 ? `${names.slice(0, 4).join(' → ')} +${names.length - 4}` : names.join(' → ');
  }
  if (mode === 'menu') return 'Older digit menu';
  if (mode === 'queue') return 'Call queue';
  return standby ? 'Standby · company flow or voicemail' : 'Default · owner, then voicemail';
}
