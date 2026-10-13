// The command bar's rows, from plain inputs.
//
// Pure: the view-model hands over the records as plain objects (CmdData) and
// this returns what the bar lists. A row carries its action as data
// (CmdAction); the bar runs it through the view-model, so nothing here can
// reach state, and tools/command.test.ts can run it as it stands.
//
// Order, per the plan's §9.2: verbs first, then records. An empty query lists
// the records opened last, then what can be done to the record in focus.

import {
  type Mark, type Verb, type VerbId,
  allowedVerbs, apptFields, dueField, dueLabel, matchScreens, matches, parseCommand, parseRecent, phoneQuery,
  rankRecords, splitDue, verbCompletions,
} from '../../lib/command';
import { taskRecordOf } from '../../lib/task-record';

export type CmdPerson = {
  id: string; name: string; phone: string; email: string; addr: string; stage: string;
  /** The stage's colour, for the row's dot. */
  dot: string;
  lastComm: string; nextTask: string;
  /** The rep's name, and their id ('' for nobody). */
  assigned: string; assignedId: string;
  /** Everything a query matches: name, phone, digits-only phone, email, address, city, ZIP, APN, source, tags. */
  find: string;
};
export type CmdBuyer = { id: string; name: string; company: string; phone: string; status: string; find: string };
/**
 * A deal or a submission, on its own property: `id` is its seller ('' for a
 * deal with no seller), `dealId` the deal itself, so a partner's house opens
 * pinned to that house and not to the contact's best deal.
 */
export type CmdDeal = {
  id: string; addr: string; contract: string; stage: string; close: string; dot: string;
  dealId?: string;
  /** The seller or partner it is on, for the sub-line. */
  who?: string;
  /** The seller's own address: a deal with no contract on it is that seller's record, already listed under People. */
  ownAddr?: boolean;
  /** Everything a query matches: the address, city, ZIP, stage, who. */
  find?: string;
};
/** `personId` is the seller the task is on ('' for none). Checklist tasks may only have `dealId`. */
export type CmdTask = { id: string; title: string; due: string; who: string; personId?: string; dealId?: string | null; buyerId?: string | null };
/** A vendor contact: title, lender, contractor, wholesaler, partner. */
export type CmdVendor = { id: string; name: string; kind: string; find: string };

export type CmdData = {
  /** lib/team.ts Role; null in the demo with no ?as. */
  role: string | null;
  /** Which screens this role may open (the view-model's `can`). */
  can: Record<string, boolean>;
  screen: string;
  /** The seller in front of the rep: the open record, dispo property, closing file, or the party on a call. */
  focus: string | null;
  /** The buyer record in view, if that is the screen. */
  focusBuyer: string | null;
  recentIds: string[];
  people: CmdPerson[];
  buyers: CmdBuyer[];
  deals: CmdDeal[];
  tasks: CmdTask[];
  /** Empty for a role that cannot open People (where vendors live). */
  vendors: CmdVendor[];
  reps: { id: string; name: string }[];
  stages: { label: string; dot: string }[];
  /** The People list's current filter. */
  peopleQ: string;
  now: Date | null;
};

export type AddKind = 'seller' | 'buyer' | 'property' | 'deal' | 'task' | 'appointment' | 'note' | 'vendor';

export type CmdAction =
  | { t: 'open'; rec: 'person' | 'buyer'; id: string }
  /** A deal, opened where the role works it: the seller record, the dispo desk, or the closing file; pinned to `dealId`. With no seller (`id` ''), its deal sheet. */
  | { t: 'deal'; id: string; where: 'person' | 'dispo' | 'tc'; dealId?: string }
  /** A vendor contact: their list in People, searched to them. */
  | { t: 'vendor'; id: string; name: string }
  /** A task with no seller: Tasks, on the list it is due in. */
  | { t: 'task'; id: string }
  /** The seller's texts: the record with the Texts filter on. Inbox cannot open one named thread. */
  | { t: 'thread'; id: string }
  | { t: 'call'; name: string; phone: string; personId?: string; buyerId?: string }
  | { t: 'compose'; pid: string; channel: 'Text' | 'Email' | 'Note' }
  | { t: 'offer'; pid: string }
  | { t: 'underwrite'; pid: string }
  | { t: 'add'; kind: AddKind; seed: Record<string, string> }
  | { t: 'assign'; pid: string; rep: string | null }
  | { t: 'stage'; pid: string; stage: string }
  | { t: 'filter'; q: string }
  | { t: 'go'; screen: string }
  | { t: 'lane'; pid: string | null }
  /** Stays in the bar: a second list (more actions, a rep, a stage). */
  | { t: 'step'; step: string }
  /** Stays in the bar: completes the input ("ta" → "task "). */
  | { t: 'type'; text: string };

export type CmdRow = {
  /** Unique within one result, for aria-activedescendant. */
  id: string;
  /** The verb, set apart from its object: "Text" + "Kara Mitchell". */
  verb?: string;
  label: string;
  sub?: string;
  /** The sub-line leads with a phone number: tabular digits. */
  num?: boolean;
  mark: Mark;
  /** A colour of its own (a record's stage) in place of the mark's. */
  dot?: string;
  action: CmdAction;
  /** ⌘⏎. */
  alt?: { label: string; action: CmdAction };
  /** The record Tab lists every action for: 'person:p1' or 'buyer:b1'. */
  more?: string;
};
export type CmdGroup = { label: string; rows: CmdRow[] };
export type CmdResult = {
  groups: CmdGroup[];
  /** The step the bar is in, shown in front of the input ("Assign Kara Mitchell to"). */
  title: string | null;
  placeholder: string;
  /** Said when there are no rows. */
  empty: string;
};

const firstName = (name: string) => name.split(' ')[0] || name;
/** The row's whole text, as a screen reader and a test read it. */
export const rowText = (r: Pick<CmdRow, 'verb' | 'label'>) => (r.verb ? r.verb + ' ' : '') + r.label;
const phoneLine = (phone: string, rest?: string) => [phone || 'No phone on file', rest].filter(Boolean).join(' · ');

type Row = Omit<CmdRow, 'id'>;
type PersonVerb = 'open' | 'thread' | VerbId;

export function buildCommandRows(data: CmdData, raw: string, step: string | null): CmdResult {
  const can = (screen: string) => data.can[screen] !== false;
  const verbs = allowedVerbs(can);
  const allowed = (id: VerbId) => verbs.some((v) => v.id === id);
  const person = (id: string | null | undefined) => (id ? data.people.find((p) => p.id === id) : undefined);
  const buyer = (id: string | null | undefined) => (id && can('buyers') ? data.buyers.find((b) => b.id === id) : undefined);
  const recentAt = new Map(data.recentIds.map((k, i) => [k, i]));
  const rankPeople = (q: string) => rankRecords(data.people, q, (p) => ({ name: p.name, find: p.find, recent: recentAt.get('person:' + p.id) }));
  const rankBuyers = (q: string) => (can('buyers') ? rankRecords(data.buyers, q, (b) => ({ name: b.name, find: b.find, recent: recentAt.get('buyer:' + b.id) })) : []);
  const now = data.now ?? new Date(0);

  // ---- rows for one record --------------------------------------------------
  const openPerson = (id: string): CmdAction => ({ t: 'open', rec: 'person', id });
  const callPerson = (p: CmdPerson): CmdAction => ({ t: 'call', name: p.name, phone: p.phone, personId: p.id });
  const personRow = (p: CmdPerson, v: PersonVerb, due: string | null = null): Row | null => {
    if (v !== 'open' && v !== 'thread' && !allowed(v)) return null;
    const more = 'person:' + p.id;
    switch (v) {
      case 'open':
        return { label: p.name, sub: ['Seller', p.addr, p.stage].filter(Boolean).join(' · '), mark: 'neutral', dot: p.dot, action: openPerson(p.id), alt: { label: 'Call', action: callPerson(p) }, more };
      case 'thread':
        return { label: p.name + ' · texts', sub: 'The texts on ' + firstName(p.name) + '’s record', mark: 'talkr', action: { t: 'thread', id: p.id }, alt: { label: 'Text', action: { t: 'compose', pid: p.id, channel: 'Text' } }, more };
      case 'call':
        return { verb: 'Call', label: p.name, sub: phoneLine(p.phone, p.nextTask && p.nextTask !== 'No task scheduled' ? 'next: ' + p.nextTask : ''), num: true, mark: 'talkr', action: callPerson(p), alt: { label: 'Open record', action: openPerson(p.id) }, more };
      case 'text':
        return { verb: 'Text', label: p.name, sub: phoneLine(p.phone, p.lastComm && p.lastComm !== '—' ? 'last: ' + p.lastComm : ''), num: true, mark: 'talkr', action: { t: 'compose', pid: p.id, channel: 'Text' }, alt: { label: 'Call', action: callPerson(p) }, more };
      case 'email':
        return { verb: 'Email', label: p.name, sub: p.email || 'No email on file yet', mark: 'clozr', action: { t: 'compose', pid: p.id, channel: 'Email' }, alt: { label: 'Open record', action: openPerson(p.id) }, more };
      case 'note':
        return { verb: 'Note on', label: p.name, sub: 'Only your team sees notes', mark: 'neutral', action: { t: 'compose', pid: p.id, channel: 'Note' }, alt: { label: 'Note dialog', action: { t: 'add', kind: 'note', seed: { personId: p.id } } }, more };
      case 'task':
        return {
          verb: 'Task for', label: p.name,
          sub: due ? 'Due ' + dueLabel(due) : 'Type a date: ‘tomorrow 10am’',
          mark: 'clozr',
          action: { t: 'add', kind: 'task', seed: { personId: p.id, title: 'Follow up with ' + firstName(p.name), type: 'Follow-up', ...(due ? { due: dueField(due, now) } : {}) } },
          alt: { label: 'Open record', action: openPerson(p.id) }, more,
        };
      case 'appointment':
        return {
          verb: 'Appointment with', label: p.name, sub: due ? dueLabel(due) : 'Lands on the calendar', mark: 'clozr',
          action: { t: 'add', kind: 'appointment', seed: { personId: p.id, title: 'Appointment with ' + p.name, ...(due ? apptFields(due, now) : {}) } },
          alt: { label: 'Open record', action: openPerson(p.id) }, more,
        };
      case 'underwrite':
        return { verb: 'Underwrite', label: p.addr || p.name, sub: 'Opens COMPR on this property · ' + p.name, mark: 'compr', action: { t: 'underwrite', pid: p.id }, alt: { label: 'Open record', action: openPerson(p.id) }, more };
      case 'offer':
        return { verb: 'Send offer to', label: p.name, sub: 'Opens Make offer on the record', mark: 'clozr', action: { t: 'offer', pid: p.id }, alt: { label: 'Open record', action: openPerson(p.id) }, more };
      case 'assign':
        return { verb: 'Assign', label: p.name + '…', sub: 'Now ' + p.assigned + ' · pick a rep', mark: 'neutral', action: { t: 'step', step: 'assign:' + p.id }, more };
      case 'stage':
        return { verb: 'Move', label: p.name + ' to a stage…', sub: 'Now ' + p.stage + ' · pick a stage', mark: 'neutral', action: { t: 'step', step: 'stage:' + p.id }, more };
      case 'lane':
        return { verb: 'Ask Lane about', label: p.name, sub: 'The TC assistant, on this file · L', mark: 'lane', action: { t: 'lane', pid: p.id }, more };
      case 'newDeal':
        return { verb: 'New deal for', label: p.name, sub: 'Moves them into the pipeline', mark: 'clozr', action: { t: 'add', kind: 'deal', seed: { personId: p.id } }, more };
      default:
        return null;
    }
  };
  const buyerRow = (b: CmdBuyer, v: 'open' | 'call' | 'text'): Row | null => {
    if (v !== 'open' && !allowed(v)) return null;
    const call: CmdAction = { t: 'call', name: b.name, phone: b.phone, buyerId: b.id };
    const open: CmdAction = { t: 'open', rec: 'buyer', id: b.id };
    const more = 'buyer:' + b.id;
    if (v === 'open') return { label: b.name, sub: ['Buyer', b.company, b.status].filter(Boolean).join(' · '), mark: 'genius', action: open, alt: { label: 'Call', action: call }, more };
    if (v === 'call') return { verb: 'Call', label: b.name, sub: phoneLine(b.phone, b.company), num: true, mark: 'talkr', action: call, alt: { label: 'Open record', action: open }, more };
    return { verb: 'Text', label: b.name, sub: phoneLine(b.phone, 'the text box on their record'), num: true, mark: 'talkr', action: open, alt: { label: 'Call', action: call }, more };
  };
  const PERSON_ALL: PersonVerb[] = ['open', 'call', 'text', 'email', 'note', 'task', 'appointment', 'underwrite', 'offer', 'assign', 'stage', 'thread', 'lane', 'newDeal'];
  const PERSON_TOP: PersonVerb[] = ['open', 'call', 'text', 'task'];
  const rowsFor = (p: CmdPerson, list: PersonVerb[]) => list.map((v) => personRow(p, v)).filter((r): r is Row => !!r);

  // Deals open where the role works them; the other place is ⌘⏎.
  const dealWhere: 'person' | 'dispo' | 'tc' = data.role === 'tc' && can('tc') ? 'tc'
    : data.role === 'dispositions' && can('dispoProperty') ? 'dispo' : 'person';
  const dealRow = (d: CmdDeal): Row => {
    const pin = d.dealId ? { dealId: d.dealId } : {};
    const inDispo = /^(dispo|assigned)$/i.test(d.stage) && can('dispoProperty');
    const inTc = /^closing$/i.test(d.stage) && can('tc');
    const alt = !d.id ? undefined
      : dealWhere !== 'person' ? { label: 'Open the seller', action: openPerson(d.id) }
        : inDispo ? { label: 'Open in Dispo', action: { t: 'deal', id: d.id, where: 'dispo', ...pin } as CmdAction }
          : inTc ? { label: 'Open the closing file', action: { t: 'deal', id: d.id, where: 'tc', ...pin } as CmdAction } : undefined;
    // A submission has no contract or close date yet: who sent it says more.
    const sub = d.contract || d.close ? [d.stage, 'close ' + (d.close || 'TBD')] : [d.stage, d.who];
    return { label: d.addr + (d.contract ? ' · ' + d.contract : ''), sub: sub.filter(Boolean).join(' · '), mark: 'neutral', dot: d.dot, action: { t: 'deal', id: d.id, where: dealWhere, ...pin }, ...(alt ? { alt } : {}), ...(d.id ? { more: 'person:' + d.id } : {}) };
  };

  const done = (groups: CmdGroup[], title: string | null = null, placeholder = 'Search or type a command', empty = 'Nothing matches'): CmdResult => {
    let n = 0;
    const out = groups.filter((g) => g.rows.length).map((g) => ({ ...g, rows: g.rows.map((r) => ({ ...r, id: 'cmd-row-' + n++ })) }));
    return { groups: out, title, placeholder, empty };
  };
  const g = (label: string, rows: (Row | null | undefined)[]): CmdGroup => ({ label, rows: rows.filter((r): r is Row => !!r) as CmdRow[] });
  /** In a step, what is typed narrows the list. */
  const narrow = (rows: Row[]) => (raw.trim() ? rows.filter((r) => matches(raw, rowText(r) + ' ' + (r.sub ?? ''))) : rows);

  // ---- a second list inside the bar -----------------------------------------
  if (step) {
    const [kind, ...restKey] = step.split(':');
    const id = restKey.join(':');
    if (kind === 'more') {
      const rec = parseRecent(id);
      const p = rec?.kind === 'person' ? person(rec.id) : undefined;
      const b = rec?.kind === 'buyer' ? buyer(rec.id) : undefined;
      if (p) return done([g('Everything for ' + p.name, narrow(rowsFor(p, PERSON_ALL)))], p.name, 'Filter the actions', 'No action matches');
      if (b) return done([g('Everything for ' + b.name, narrow((['open', 'call', 'text'] as const).map((v) => buyerRow(b, v)).filter((r): r is Row => !!r)))], b.name, 'Filter the actions', 'No action matches');
    }
    const p = person(id);
    if (kind === 'assign' && p) {
      const reps: Row[] = [...data.reps.map((r) => ({ id: r.id, name: r.name })), { id: '', name: 'Unassigned' }].map((r) => ({
        label: r.name, sub: r.id === p.assignedId ? 'Assigned now' : undefined, mark: 'neutral' as Mark,
        action: { t: 'assign', pid: p.id, rep: r.id || null } as CmdAction,
      }));
      return done([g('Reps', narrow(reps))], 'Assign ' + p.name + ' to', 'Find a rep', 'No rep matches');
    }
    if (kind === 'stage' && p) {
      const stages: Row[] = data.stages.map((st) => ({
        label: st.label, sub: st.label === p.stage ? 'Stage now' : undefined, mark: 'neutral' as Mark, dot: st.dot,
        action: { t: 'stage', pid: p.id, stage: st.label } as CmdAction,
      }));
      return done([g('Stages', narrow(stages))], 'Move ' + p.name + ' to', 'Find a stage', 'No stage matches');
    }
    // A step whose record went away: back to the main list.
  }

  const parsed = parseCommand(raw, verbs);
  const fp = person(data.focus);
  const fb = buyer(data.focusBuyer);

  // ---- nothing typed: recents, then the record in focus, then create --------
  if (!parsed.q) {
    const recents = data.recentIds.map(parseRecent).map((r) => (r?.kind === 'person' ? (() => { const p = person(r.id); return p ? personRow(p, 'open') : null; })()
      : r?.kind === 'buyer' ? (() => { const b = buyer(r.id); return b ? buyerRow(b, 'open') : null; })() : null)).filter(Boolean).slice(0, 5);
    // Text leads, not Call: ⏎ straight after ⌘K should never ring anyone.
    const focusRows = fp ? rowsFor(fp, ['text', 'call', 'email', 'note', 'task', 'underwrite'])
      : fb ? (['call', 'text'] as const).map((v) => buyerRow(fb, v)) : [];
    const seed: Record<string, string> = fp ? { personId: fp.id } : {};
    // The same kinds, and the same dialog, as Quick Add. With a seller in
    // focus, a deal, a task, an appointment or a note starts out as theirs.
    const forFocus = fp ? 'For ' + fp.name : '';
    const create: [VerbId, AddKind, string, Record<string, string>, string][] = [
      ['newLead', 'seller', 'New lead', {}, 'A seller and their property'],
      ['newBuyer', 'buyer', 'New buyer', {}, 'Starts matching against dispo inventory'],
      ['newProperty', 'property', 'New property', {}, 'The property, its seller and a deal'],
      ['newDeal', 'deal', 'New deal', seed, forFocus || 'Moves a seller into the pipeline'],
      ['task', 'task', 'New task', seed, forFocus || 'On Tasks and on the seller’s record'],
      ['appointment', 'appointment', 'New appointment', seed, forFocus || 'Lands on the calendar'],
      ['note', 'note', 'New note', seed, forFocus || 'On the seller’s timeline'],
      ['newVendor', 'vendor', 'New vendor', {}, 'Title, contractors, lenders'],
    ];
    const verbOf = (id: VerbId) => verbs.find((v) => v.id === id);
    return done([
      g('Recent', recents),
      g(fp ? fp.name : fb ? fb.name : '', focusRows),
      g('Create', create.filter(([id]) => allowed(id)).map(([id, kind, label, s, sub]) => ({ label, sub, mark: verbOf(id)!.mark, action: { t: 'add', kind, seed: s } }))),
      g('Tools', [
        fp && allowed('underwrite') ? null : { label: 'COMPR', sub: 'Type underwrite and a seller', mark: 'compr', action: { t: 'type', text: 'underwrite ' } },
        allowed('lane') ? { label: 'Lane', sub: 'The TC assistant, on the file · L', mark: 'lane', action: { t: 'lane', pid: fp?.id ?? null } } : null,
        allowed('genius') ? { label: 'Genius', sub: 'Every investor buying around any address', mark: 'genius', action: { t: 'go', screen: 'genius' } } : null,
        allowed('dealMachine') ? { label: 'Deal Machine', sub: 'The scraper: run, pause, its log and finds', mark: 'dealMachine', action: { t: 'go', screen: 'dealMachine' } } : null,
        allowed('buyr') ? { label: 'Buyr', sub: 'Wholesale sniping and Facebook buyer groups', mark: 'buyr', action: { t: 'go', screen: 'buyr' } } : null,
        { label: 'Go to a screen…', sub: 'Type go and its name', mark: 'neutral', action: { t: 'type', text: 'go ' } },
      ]),
    ]);
  }

  // Records the whole input names, for when a name starts with a verb ("Lane Smith").
  const alsoRecords = (shown: Set<string>): CmdGroup => g('People', rankPeople(parsed.q).filter((p) => !shown.has(p.id)).slice(0, 4).map((p) => personRow(p, 'open')));

  // ---- a verb ------------------------------------------------------------------
  const verb: Verb | null = parsed.verb;
  if (verb) {
    const rest = parsed.rest;
    if (verb.target === 'person' || verb.target === 'contact') {
      const dated = verb.id === 'task' || verb.id === 'appointment';
      const split = dated ? splitDue(rest, now) : { target: rest, due: null, dueText: '' };
      const target = split.target;
      const due = split.due;
      const v = verb.id as PersonVerb;
      const shown = new Set<string>();
      const rows: Row[] = [];
      const goTo: Row[] = [];
      if (!target) {
        // The record in focus; then the ones opened last, then the list.
        if (fp) { const r = personRow(fp, v, due); if (r) { rows.push(r); shown.add(fp.id); } }
        if (fb && verb.target === 'contact') { const r = buyerRow(fb, v as 'call' | 'text'); if (r) rows.push(r); }
        if (verb.id === 'task' || verb.id === 'note' || verb.id === 'appointment' || verb.id === 'newDeal') {
          const kind: AddKind = verb.id === 'newDeal' ? 'deal' : verb.id;
          rows.push({
            label: verb.id === 'newDeal' ? 'New deal' : 'New ' + verb.label.toLowerCase(), sub: due ? 'Due ' + dueLabel(due) : verb.hint, mark: verb.mark,
            action: { t: 'add', kind, seed: kind === 'task' && due ? { due: dueField(due, now) } : kind === 'appointment' && due ? apptFields(due, now) : {} },
          });
        }
        if (verb.id === 'lane' && !fp) rows.push({ label: 'Ask Lane', sub: verb.hint, mark: 'lane', action: { t: 'lane', pid: null } });
        const others = [
          ...data.recentIds.map(parseRecent).filter((r) => r?.kind === 'person').map((r) => person(r!.id)),
          ...data.people,
        ].filter((p): p is CmdPerson => !!p && !shown.has(p.id));
        for (const p of others) {
          if (rows.length >= 7) break;
          if (shown.has(p.id)) continue;
          const r = personRow(p, v, due);
          if (r) { rows.push(r); shown.add(p.id); }
        }
      } else {
        const ph = verb.id === 'call' ? phoneQuery(target) : null;
        const people = rankPeople(target).slice(0, 6);
        const buyers = verb.target === 'contact' ? rankBuyers(target).slice(0, 3) : [];
        for (const p of people) { const r = personRow(p, v, due); if (r) { rows.push(r); shown.add(p.id); } }
        for (const b of buyers) { const r = buyerRow(b, v as 'call' | 'text'); if (r) rows.push(r); }
        if (ph && !people.length && !buyers.length) rows.push({ verb: 'Call', label: ph.display, sub: 'Not in CLOZR yet · Talkr', num: true, mark: 'talkr', action: { t: 'call', name: ph.display, phone: ph.display } });
        if (!rows.length) {
          if (verb.id === 'task') rows.push({ label: 'New task ‘' + target + '’', sub: due ? 'Due ' + dueLabel(due) : 'No seller matches · a task on its own', mark: 'clozr', action: { t: 'add', kind: 'task', seed: { title: target, ...(due ? { due: dueField(due, now) } : {}) } } });
          if (verb.id === 'note') rows.push({ label: 'New note ‘' + target + '’', sub: 'No seller matches · pick one in the dialog', mark: 'neutral', action: { t: 'add', kind: 'note', seed: { body: target } } });
          if (verb.id === 'appointment') rows.push({ label: 'New appointment ‘' + target + '’', sub: due ? dueLabel(due) : 'Lands on the calendar', mark: 'clozr', action: { t: 'add', kind: 'appointment', seed: { title: target, ...(due ? apptFields(due, now) : {}) } } });
        }
        // "text kara": her record and her texts after the verb rows.
        const top = people[0];
        if (top) {
          goTo.push(personRow(top, 'open')!);
          if (verb.id === 'text') goTo.push(personRow(top, 'thread')!);
        }
      }
      const fallback = !rows.length && target && allowed('newLead')
        ? [{ label: 'New lead named ‘' + target + '’', sub: 'No one matches · add them', mark: 'clozr' as Mark, action: { t: 'add', kind: 'seller', seed: { name: target } } as CmdAction }]
        : [];
      return done([g(verb.label, rows), g('Go to', goTo), g('Create', fallback), alsoRecords(shown)], null, 'Search or type a command', target ? 'No one matches ‘' + target + '’' : 'Nothing to ' + verb.label.toLowerCase());
    }
    if (verb.target === 'name') {
      const ph = phoneQuery(rest);
      const kind: AddKind = verb.id === 'newLead' ? 'seller' : verb.id === 'newBuyer' ? 'buyer' : verb.id === 'newProperty' ? 'property' : 'vendor';
      const seed: Record<string, string> = !rest ? {} : kind === 'property' ? { addr: rest } : ph && kind !== 'vendor' ? { phone: ph.display } : { name: rest };
      const label = !rest ? verb.label : kind === 'property' ? verb.label + ' at ‘' + rest + '’' : ph ? verb.label + ' with ' + ph.display : verb.label + ' named ‘' + rest + '’';
      return done([g(verb.label, [{ label, sub: verb.hint, mark: verb.mark, action: { t: 'add', kind, seed } }]), alsoRecords(new Set())]);
    }
    if (verb.target === 'screen') {
      const screens = matchScreens(parsed.rest, can).map((s): Row => ({ verb: 'Go to', label: s.label, sub: s.hint, mark: s.mark, action: { t: 'go', screen: s.key } }));
      const people = parsed.rest ? rankPeople(parsed.rest).slice(0, 4).map((p) => personRow(p, 'open')) : [];
      const buyers = parsed.rest ? rankBuyers(parsed.rest).slice(0, 3).map((b) => buyerRow(b, 'open')) : [];
      return done([g('Go to', screens), g('People', people), g('Buyers', buyers)], null, 'Search or type a command', 'No screen or record matches ‘' + parsed.rest + '’');
    }
    if (verb.target === 'text') {
      const onPeople = data.screen === 'people';
      const rows: Row[] = parsed.rest
        ? [{ verb: 'Filter', label: (onPeople ? 'this list' : 'People') + ' for ‘' + parsed.rest + '’', sub: 'Shows in the list’s search box; clear it there', mark: 'neutral', action: { t: 'filter', q: parsed.rest } }]
        : data.peopleQ ? [{ verb: 'Clear', label: 'the filter ‘' + data.peopleQ + '’', sub: 'Shows the whole list again', mark: 'neutral', action: { t: 'filter', q: '' } }] : [];
      return done([g('People list', rows)], null, 'Search or type a command', 'Type what to filter People for');
    }
    // Genius, Deal Machine, Buyr.
    const screen = verb.id === 'genius' ? 'genius' : verb.id === 'buyr' ? 'buyr' : 'dealMachine';
    return done([g(verb.label, [{ verb: 'Open', label: verb.label, sub: verb.hint, mark: verb.mark, action: { t: 'go', screen } }]), alsoRecords(new Set())]);
  }

  // ---- no verb: records, with the top hit's verbs first ----------------------
  const q = parsed.rest;
  const ph = phoneQuery(q);
  const people = rankPeople(q);
  const buyers = rankBuyers(q);
  const completions = verbCompletions(q, verbs).map(({ verb: v, phrase }): Row => ({ label: v.label + '…', sub: v.hint, mark: v.mark, action: { t: 'type', text: phrase + ' ' } }));
  const topPerson = people[0];
  const topBuyer = buyers[0];
  const buyerFirst = !!topBuyer && (!topPerson || rankRecords([
    { k: 'p', name: topPerson.name, find: topPerson.find }, { k: 'b', name: topBuyer.name, find: topBuyer.find },
  ], q, (x) => x)[0]?.k === 'b');
  const top: CmdGroup = buyerFirst
    ? g('Best match', (['open', 'call', 'text'] as const).map((v) => buyerRow(topBuyer!, v)))
    : topPerson ? g('Best match', rowsFor(topPerson, PERSON_TOP)) : g('', []);
  const phoneRows: Row[] = ph && !people.length && !buyers.length ? [
    ...(allowed('call') ? [{ verb: 'Call', label: ph.display, sub: 'Not in CLOZR yet · Talkr', num: true, mark: 'talkr' as Mark, action: { t: 'call', name: ph.display, phone: ph.display } as CmdAction }] : []),
    ...(allowed('newLead') ? [{ verb: 'New lead', label: 'with ' + ph.display, sub: 'A seller and their property', mark: 'clozr' as Mark, action: { t: 'add', kind: 'seller', seed: { phone: ph.display } } as CmdAction }] : []),
  ] : [];
  // Every deal and submission by its own address. One with no contract on the
  // seller's own address is that seller's record, already a People row.
  const listed = new Set(people.slice(0, 6).map((p) => p.id));
  const deals = rankRecords(data.deals, q, (d) => ({ name: d.addr, find: d.find ?? d.stage }))
    .filter((d) => !(d.ownAddr && !d.contract && listed.has(d.id))).slice(0, 4).map(dealRow);
  // A task opens the record it is on (seller, deal's seller, or buyer); one on nobody, the Tasks list.
  const taskLook = {
    hasPerson: (id: string) => !!person(id),
    sellerOfDeal: (dealId: string) => data.deals.find((d) => d.dealId === dealId)?.id || null,
    hasBuyer: (id: string) => data.buyers.some((b) => b.id === id),
  };
  const tasks = data.tasks.filter((t) => matches(q, t.title)).slice(0, 3).map((t): Row => {
    const rec = taskRecordOf(t, taskLook);
    let action: CmdAction = can('tasks') ? { t: 'task', id: t.id } : { t: 'go', screen: 'tasks' };
    if (rec?.kind === 'person' && rec.id && person(rec.id)) action = openPerson(rec.id);
    else if (rec?.kind === 'person' && rec.dealId) action = { t: 'deal', id: rec.id, where: 'person', dealId: rec.dealId };
    else if (rec?.kind === 'buyer') action = { t: 'open', rec: 'buyer', id: rec.id };
    return {
      label: t.title, sub: [t.due, t.who].filter(Boolean).join(' · '), mark: 'neutral',
      action,
      ...(action.t !== 'task' && can('tasks') ? { alt: { label: 'Open Tasks', action: { t: 'task', id: t.id } as CmdAction } } : {}),
    };
  });
  const vendors = can('people') ? rankRecords(data.vendors ?? [], q, (v) => ({ name: v.name, find: v.find })).slice(0, 3)
    .map((v): Row => ({ label: v.name, sub: ['Vendor', v.kind].filter(Boolean).join(' · '), mark: 'neutral', action: { t: 'vendor', id: v.id, name: v.name } })) : [];
  const screens = matchScreens(q, can).slice(0, 3).map((s): Row => ({ verb: 'Go to', label: s.label, sub: s.hint, mark: s.mark, action: { t: 'go', screen: s.key } }));
  const list = data.screen === 'people' && allowed('filter')
    ? [{ verb: 'Filter', label: 'this list for ‘' + q + '’', sub: 'Shows in the list’s search box', mark: 'neutral' as Mark, action: { t: 'filter', q } as CmdAction }] : [];
  const groups = [
    g('Phone number', phoneRows),
    g('Verbs', completions),
    top,
    g('People', people.filter((p) => buyerFirst || p !== topPerson).slice(0, 5).map((p) => personRow(p, 'open'))),
    g('Buyers', buyers.filter((b) => !buyerFirst || b !== topBuyer).slice(0, 3).map((b) => buyerRow(b, 'open'))),
    g('Deals', deals),
    g('Vendors', vendors),
    g('Tasks', tasks),
    g('Go to', screens),
  ];
  // Nothing found: offer to make it. (Filtering the People list for it is not a match.)
  if (!groups.some((x) => x.rows.length)) {
    groups.push(g('Nothing matches', [
      allowed('newLead') ? { label: 'New lead named ‘' + q + '’', sub: 'A seller and their property', mark: 'clozr', action: { t: 'add', kind: 'seller', seed: { name: q } } } : null,
      allowed('task') ? { label: 'New task ‘' + q + '’', sub: 'A task on its own', mark: 'clozr', action: { t: 'add', kind: 'task', seed: { title: q } } } : null,
    ]));
  }
  groups.push(g('People list', list));
  return done(groups, null, 'Search or type a command', 'Nothing matches ‘' + q + '’');
}
