// The ⌘K command bar: the grammar (lib/command.ts) and the rows it builds
// (app/app/clozr/command-rows.ts), against plain inputs.
// Run with:  npx tsx tools/command.test.ts
import {
  VERBS, allowedVerbs, apptFields, dueField, dueLabel, matchScreens, matchTier, matches, parseCommand, phoneQuery,
  rankRecords, splitDue, verbCompletions,
} from '../lib/command';
import { parseDue } from '../lib/crm-write';
import { DEMO_ROLE, canSee, type Role } from '../lib/team';
import { buildCommandRows, rowText, type CmdData, type CmdPerson } from '../app/clozr/command-rows';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

// Wednesday 23 Sep 2026, 10:05 local: the demo's clock.
const now = new Date(2026, 8, 23, 10, 5, 0);
const same = (iso: string | null, y: number, m: number, d: number, h: number, min = 0) => {
  if (!iso) return false;
  const t = new Date(iso);
  return t.getFullYear() === y && t.getMonth() === m && t.getDate() === d && t.getHours() === h && t.getMinutes() === min;
};

// ---- parser: verbs and targets ------------------------------------------------
{
  const p = parseCommand('text kara');
  check('parse "text kara" → text + kara', p.verb?.id === 'text' && p.rest === 'kara', p);
  const g = parseCommand('go to reports');
  check('parse "go to reports" → go (longest phrase) + reports', g.verb?.id === 'go' && g.said === 'go to' && g.rest === 'reports', g);
  check('parse "go reports" → go + reports', parseCommand('go reports').verb?.id === 'go' && parseCommand('go reports').rest === 'reports');
  const o = parseCommand('send offer Kara');
  check('parse "send offer Kara" → offer, case kept in the target', o.verb?.id === 'offer' && o.rest === 'Kara', o);
  check('parse "offer kara" → offer', parseCommand('offer kara').verb?.id === 'offer');
  const n = parseCommand('new lead Jane Doe');
  check('parse "new lead Jane Doe" → newLead + "Jane Doe"', n.verb?.id === 'newLead' && n.rest === 'Jane Doe', n);
  const sp = parseCommand('  CALL    kara  ');
  check('parse collapses case and spaces', sp.verb?.id === 'call' && sp.rest === 'kara', sp);
  check('parse "calendar" is not "call"', parseCommand('calendar').verb === null);
  check('parse "Kara" has no verb, rest is the query', parseCommand('Kara').verb === null && parseCommand('Kara').rest === 'Kara');
  check('parse "task kara tomorrow 10am" → task', parseCommand('task kara tomorrow 10am').verb?.id === 'task' && parseCommand('task kara tomorrow 10am').rest === 'kara tomorrow 10am');
  check('parse "filter oak" → filter + oak', parseCommand('filter oak').verb?.id === 'filter' && parseCommand('filter oak').rest === 'oak');
  check('parse "move kara" → stage', parseCommand('move kara').verb?.id === 'stage');
  check('parse "go deal machine" → go, not the Deal Machine verb', parseCommand('go deal machine').verb?.id === 'go' && parseCommand('go deal machine').rest === 'deal machine');
  check('parse "deal machine" → dealMachine', parseCommand('deal machine').verb?.id === 'dealMachine');
  check('parse "buyr" → buyr', parseCommand('buyr').verb?.id === 'buyr');
  check('parse "homefull" → buyr', parseCommand('homefull').verb?.id === 'buyr');
  check('parse "call" alone → call, empty target', parseCommand('call').verb?.id === 'call' && parseCommand('call').rest === '');
  const comp = verbCompletions('ta').map((c) => c.verb.id);
  check('complete "ta" → task', comp.includes('task'), comp);
  const news = verbCompletions('new').map((c) => c.verb.id);
  check('complete "new" → every New …', ['newLead', 'newBuyer', 'newProperty', 'newDeal', 'newVendor'].every((id) => news.includes(id as never)), news);
  check('complete needs two letters', verbCompletions('t').length === 0);
  check('complete skips a verb typed in full', !verbCompletions('call').some((c) => c.verb.id === 'call'));
  check('every Quick Add kind has a verb', ['newLead', 'newBuyer', 'newProperty', 'newDeal', 'task', 'appointment', 'note', 'newVendor'].every((id) => VERBS.some((v) => v.id === id)));
}

// ---- matching: every word must match -------------------------------------------
{
  const kara = 'Kara Mitchell (210) 555-0136 2105550136 kara.mitchell@gmail.com 123 Oakview Drive San Antonio 78254 Google PPC Motivated';
  check('match one word', matches('kara', kara));
  check('match every word, any order', matches('mitchell kara', kara));
  check('match fails when one word misses', !matches('kara smith', kara));
  check('match is case-insensitive', matches('OAKVIEW', kara));
  check('match a formatted phone against the digits', matches('210-555-0136', kara));
  check('match a phone fragment', matches('555-0136', kara));
  check('match an empty query matches nothing', !matches('   ', kara));
}

// ---- ranking: exact > starts-with > word start > contains ------------------------
{
  const items = [
    { name: 'Broak Smith', find: 'broak smith' },
    { name: 'Joaquin Oakes', find: 'joaquin oakes' },
    { name: 'Oakley Price', find: 'oakley price' },
    { name: 'Oak', find: 'oak' },
  ];
  const order = rankRecords(items, 'oak', (x) => x).map((x) => x.name);
  check('rank exact > starts-with > word start > contains', order.join('|') === 'Oak|Oakley Price|Joaquin Oakes|Broak Smith', order);
  check('tiers 4/3/2/1', [matchTier('oak', 'Oak', ''), matchTier('oak', 'Oakley Price', ''), matchTier('oak', 'Joaquin Oakes', ''), matchTier('oak', 'Broak Smith', '')].join() === '4,3,2,1');
  check('rank drops non-matches', rankRecords(items, 'zzz', (x) => x).length === 0);
  // Recents break a tie; list order breaks the rest.
  const tie = [{ name: 'Kara Adams', find: '', recent: undefined }, { name: 'Kara Mitchell', find: '', recent: 0 }];
  const t = rankRecords(tie, 'kara', (x) => x).map((x) => x.name);
  check('rank: the recently opened record wins a tie', t[0] === 'Kara Mitchell', t);
  check('rank: exact still beats recent', rankRecords([{ name: 'Kara', find: '' }, { name: 'Kara Mitchell', find: '', recent: 0 }], 'kara', (x) => x)[0]!.name === 'Kara');
}

// ---- phone numbers ------------------------------------------------------------------
{
  check('phone "2105550199"', phoneQuery('2105550199')?.display === '(210) 555-0199');
  check('phone "+1 (210) 555-0199"', phoneQuery('+1 (210) 555-0199')?.display === '(210) 555-0199');
  check('phone "210.555.0199"', phoneQuery('210.555.0199')?.digits === '2105550199');
  check('phone: too short', phoneQuery('210555') === null);
  check('phone: a name with a number is not one', phoneQuery('kara 2105550199') === null);
  check('phone: 12 digits is not one', phoneQuery('221055501999') === null);
}

// ---- due dates after the name (parseDue) --------------------------------------------
{
  const a = splitDue('kara tomorrow 10am', now);
  check('due "kara tomorrow 10am" → kara, Thu Sep 24 10:00', a.target === 'kara' && same(a.due, 2026, 8, 24, 10), a);
  check('due label reads "Thu, Sep 24, 10:00 AM"', !!a.due && dueLabel(a.due) === 'Thu, Sep 24, 10:00 AM', a.due && dueLabel(a.due));
  check('due field round-trips through parseDue', !!a.due && parseDue(dueField(a.due, now), now) === a.due, a.due && dueField(a.due, now));
  const today = splitDue('kara 3pm', now);
  check('due "kara 3pm" → today 15:00, field "Today 3:00 PM"', same(today.due, 2026, 8, 23, 15) && dueField(today.due!, now) === 'Today 3:00 PM' && parseDue(dueField(today.due!, now), now) === today.due, today);
  const fri = splitDue('call the title company fri 2pm', now);
  check('due "call the title company fri 2pm" keeps the words', fri.target === 'call the title company' && same(fri.due, 2026, 8, 25, 14), fri);
  const sept = splitDue('kara sept 30', now);
  check('due "kara sept 30" → Sep 30 9:00', sept.target === 'kara' && same(sept.due, 2026, 8, 30, 9), sept);
  const addr = splitDue('44 benton court', now);
  check('due: an address keeps its number', addr.target === '44 benton court' && addr.due === null, addr);
  check('due: a lone number is not a date', splitDue('john 3', now).due === null && splitDue('john 3', now).target === 'john 3');
  check('due: no date at all', splitDue('kara', now).due === null && splitDue('kara', now).target === 'kara');
  const dueWord = splitDue('kara due tomorrow at 9:30am', now);
  check('due "due tomorrow at 9:30am"', dueWord.target === 'kara' && same(dueWord.due, 2026, 8, 24, 9, 30), dueWord);
  const inN = splitDue('kara in 3 days', now);
  check('due "in 3 days"', inN.target === 'kara' && same(inN.due, 2026, 8, 26, 9), inN);
  const ap = apptFields(a.due!, now);
  check('appointment day/time for tomorrow', ap.day === 'Tomorrow' && ap.time === '10:00 AM', ap);
  check('appointment day for Friday reads like the day picker', apptFields(fri.due!, now).day === 'Fri, Sep 25', apptFields(fri.due!, now));
}

// ---- permissions ------------------------------------------------------------------------
const verbsOf = (role: Role | null) => allowedVerbs((s) => canSee(role, s)).map((v) => v.id);
{
  const tc = verbsOf('tc');
  check('TC gets no new lead, new property, filter or offer', !tc.includes('newLead') && !tc.includes('newProperty') && !tc.includes('filter') && !tc.includes('offer'), tc);
  check('TC gets no buyers, Genius or Deal Machine', !tc.includes('newBuyer') && !tc.includes('genius') && !tc.includes('dealMachine') && !tc.includes('buyr'));
  check('TC keeps call, text, task, go', ['call', 'text', 'task', 'go'].every((id) => tc.includes(id as never)));
  const acq = verbsOf('acquisitions');
  check('acquisitions gets no buyers and no Genius', !acq.includes('newBuyer') && !acq.includes('genius'), acq);
  check('acquisitions keeps new lead, offer, filter, Deal Machine', ['newLead', 'offer', 'filter', 'dealMachine', 'buyr'].every((id) => acq.includes(id as never)));
  const dispo = verbsOf('dispositions');
  check('dispositions gets buyers, Genius and new lead (full access)', dispo.includes('newBuyer') && dispo.includes('genius') && dispo.includes('buyr') && dispo.includes('newLead'), dispo);
  check('owner gets every verb', verbsOf('owner').length === VERBS.length);
  check('the demo (DEMO_ROLE) gets every verb', verbsOf(DEMO_ROLE).length === VERBS.length);
  check('no role (a membership that did not load) gets only the verbs that need no screen', verbsOf(null).length === VERBS.filter((v) => !v.needs).length);
  const tcScreens = matchScreens('', (s) => canSee('tc', s)).map((s) => s.key);
  check('go: TC is offered only its screens', !tcScreens.includes('people') && !tcScreens.includes('buyers') && tcScreens.includes('reporting') && tcScreens.includes('tasks'), tcScreens);
  check('go "reports" → Reporting', matchScreens('reports', () => true)[0]?.key === 'reporting');
  check('dispositions can open TC', canSee('dispositions', 'tc'));
  check('acquisitions cannot open buyers or dispo', !canSee('acquisitions', 'buyers') && !canSee('acquisitions', 'buyer') && !canSee('acquisitions', 'dispo') && !canSee('acquisitions', 'genius'));
}

// ---- rows -------------------------------------------------------------------------------------
const P = (id: string, name: string, phone: string, addr: string, stage: string, extra: Partial<CmdPerson> = {}): CmdPerson => ({
  id, name, phone, email: name.toLowerCase().replace(' ', '.') + '@mail.com', addr, stage, dot: '#000',
  lastComm: 'Call · 42m ago', nextTask: 'Call seller · 1:30 PM', assigned: 'Taylor Reed', assignedId: 'taylor',
  find: [name, phone, phone.replace(/\D/g, ''), addr].join(' '), ...extra,
});
const base = (role: Role | null, over: Partial<CmdData> = {}): CmdData => {
  const can: Record<string, boolean> = {};
  for (const s of ['home', 'people', 'person', 'buyers', 'buyer', 'dispo', 'dispoProperty', 'tc', 'genius', 'dealMachine', 'buyr', 'reporting', 'tasks', 'today', 'inbox', 'dialer']) can[s] = canSee(role, s);
  return {
    role, can, screen: 'home', focus: null, focusBuyer: null, recentIds: [],
    people: [
      P('p1', 'Kara Mitchell', '(210) 555-0136', '123 Oakview Drive', 'Qualified'),
      P('p2', 'Ronald Moore', '(713) 555-0192', '1803 Cypress Lane', 'Offer Sent'),
      P('p8', 'Linda Barnes', '(817) 555-0155', '388 Pine Terrace', 'Closing'),
    ],
    buyers: [{ id: 'b1', name: 'Chris Anderson', company: 'Harbor Capital', phone: '(214) 555-0101', status: 'Active', find: 'Chris Anderson Harbor Capital (214) 555-0101 2145550101' }],
    deals: [{ id: 'p8', addr: '388 Pine Terrace', contract: '$176,000', stage: 'Closing', close: 'Sept 6', dot: '#000' }],
    tasks: [{ id: 't1', title: 'Call seller', due: 'Today', who: 'Taylor Reed' }],
    vendors: [],
    reps: [{ id: 'taylor', name: 'Taylor Reed' }, { id: 'diego', name: 'Diego Ortiz' }],
    stages: [{ label: 'New Lead', dot: '#000' }, { label: 'Qualified', dot: '#000' }, { label: 'Offer Sent', dot: '#000' }],
    peopleQ: '', now, ...over,
  };
};
const flat = (r: ReturnType<typeof buildCommandRows>) => r.groups.flatMap((g) => g.rows);
{
  const r = buildCommandRows(base('acquisitions'), 'text kara', null);
  const first = flat(r)[0]!;
  check('rows "text kara": first is Text Kara Mitchell', rowText(first) === 'Text Kara Mitchell', rowText(first));
  check('rows "text kara": its sub-line has her number', !!first.sub?.includes('(210) 555-0136') && first.num === true, first.sub);
  check('rows "text kara": runs the record composer on Text', first.action.t === 'compose' && first.action.pid === 'p1' && first.action.channel === 'Text', first.action);
  check('rows "text kara": verbs first, then her record and her texts', r.groups.map((g) => g.label).join('|').startsWith('Text|Go to') && flat(r).some((x) => x.action.t === 'thread'), r.groups.map((g) => g.label));
  check('rows: ids are unique', new Set(flat(r).map((x) => x.id)).size === flat(r).length);

  const t = flat(buildCommandRows(base('acquisitions'), 'task kara tomorrow 10am', null))[0]!;
  check('rows "task kara tomorrow 10am": Task for Kara Mitchell', rowText(t) === 'Task for Kara Mitchell', rowText(t));
  check('rows "task kara tomorrow 10am": sub-line shows the parsed date', t.sub === 'Due Thu, Sep 24, 10:00 AM', t.sub);
  check('rows "task kara tomorrow 10am": opens the task dialog prefilled', t.action.t === 'add' && t.action.kind === 'task' && t.action.seed.personId === 'p1' && t.action.seed.due === 'Thu, Sep 24, 10:00 AM', t.action);
  const t0 = flat(buildCommandRows(base('acquisitions'), 'task kara', null))[0]!;
  check('rows "task kara": asks for a date', /tomorrow 10am/.test(t0.sub ?? ''), t0.sub);

  const call = flat(buildCommandRows(base('acquisitions'), 'call kara', null))[0]!;
  check('rows "call kara": starts a call with her record', call.action.t === 'call' && call.action.personId === 'p1' && call.action.phone === '(210) 555-0136', call.action);

  const go = flat(buildCommandRows(base('owner'), 'go reports', null))[0]!;
  check('rows "go reports" (owner): Go to Reporting', rowText(go) === 'Go to Reporting' && go.action.t === 'go' && go.action.screen === 'reporting', rowText(go));
  const goTc = flat(buildCommandRows(base('tc'), 'go', null)).map((x) => x.action.t === 'go' ? x.action.screen : '');
  check('rows "go" (TC): only screens TC can see', !goTc.includes('people') && !goTc.includes('dispo') && goTc.includes('tasks'), goTc);

  const f = flat(buildCommandRows(base('acquisitions', { screen: 'people' }), 'filter oak', null))[0]!;
  check('rows "filter oak" on People: Filter this list', rowText(f) === 'Filter this list for ‘oak’' && f.action.t === 'filter' && f.action.q === 'oak', rowText(f));
  const fx = flat(buildCommandRows(base('acquisitions', { screen: 'people', peopleQ: 'oak' }), 'filter', null))[0]!;
  check('rows "filter" with a filter on: Clear it', fx.action.t === 'filter' && fx.action.q === '', rowText(fx));

  const z = flat(buildCommandRows(base('acquisitions'), 'zzzz', null));
  check('rows "zzzz": New lead named ‘zzzz’', rowText(z[0]!) === 'New lead named ‘zzzz’' && z[0]!.action.t === 'add', z.map(rowText));
  const zp = flat(buildCommandRows(base('acquisitions', { screen: 'people' }), 'zzzz', null)).map(rowText);
  check('rows "zzzz" on People: New lead first, the list filter after', zp[0] === 'New lead named ‘zzzz’' && zp[zp.length - 1] === 'Filter this list for ‘zzzz’', zp);
  const ztc = flat(buildCommandRows(base('tc'), 'zzzz', null)).map(rowText);
  check('rows "zzzz" (TC): no New lead', !ztc.some((x) => x.startsWith('New lead')) && ztc.includes('New task ‘zzzz’'), ztc);
  const ph = flat(buildCommandRows(base('acquisitions'), '2105550199', null))[0]!;
  check('rows "2105550199": Call (210) 555-0199', rowText(ph) === 'Call (210) 555-0199' && ph.action.t === 'call' && ph.num === true, rowText(ph));

  const nb = flat(buildCommandRows(base('acquisitions'), 'new buyer Sam', null)).map(rowText);
  check('rows "new buyer Sam" (acquisitions): not offered', !nb.some((x) => x.startsWith('New buyer')), nb);
  const nbd = flat(buildCommandRows(base('dispositions'), 'new buyer Sam', null))[0]!;
  check('rows "new buyer Sam" (dispositions): New buyer named ‘Sam’', rowText(nbd) === 'New buyer named ‘Sam’' && nbd.action.t === 'add' && nbd.action.seed.name === 'Sam', rowText(nbd));
  const nl = flat(buildCommandRows(base('acquisitions'), 'new lead 2105550199', null))[0]!;
  check('rows "new lead <phone>": seeds the phone', nl.action.t === 'add' && nl.action.seed.phone === '(210) 555-0199', nl.action);

  const offer = flat(buildCommandRows(base('acquisitions'), 'send offer kara', null))[0]!;
  check('rows "send offer kara": the offer sheet', offer.action.t === 'offer' && offer.action.pid === 'p1', offer.action);
  check('rows "send offer kara" (TC): not offered', !flat(buildCommandRows(base('tc'), 'send offer kara', null)).some((x) => x.action.t === 'offer'));
  const uw = flat(buildCommandRows(base('acquisitions'), 'underwrite kara', null))[0]!;
  check('rows "underwrite kara": COMPR on 123 Oakview Drive', rowText(uw) === 'Underwrite 123 Oakview Drive' && uw.action.t === 'underwrite' && uw.mark === 'compr', rowText(uw));
  const textBuyerAcq = flat(buildCommandRows(base('acquisitions'), 'call chris', null));
  check('rows "call chris" (acquisitions): buyers are not offered', !textBuyerAcq.some((x) => x.action.t === 'call' && x.action.buyerId), textBuyerAcq.map(rowText));
  const callBuyer = flat(buildCommandRows(base('dispositions'), 'call chris', null))[0]!;
  check('rows "call chris" (dispositions): Call Chris Anderson', rowText(callBuyer) === 'Call Chris Anderson' && callBuyer.action.t === 'call' && callBuyer.action.buyerId === 'b1', rowText(callBuyer));

  // The record in focus is the target when nothing follows the verb.
  const foc = flat(buildCommandRows(base('acquisitions', { focus: 'p2', screen: 'person' }), 'text', null))[0]!;
  check('rows "text" on a record: Text <that seller>', rowText(foc) === 'Text Ronald Moore', rowText(foc));
  const task0 = flat(buildCommandRows(base('acquisitions', { focus: 'p2', screen: 'person' }), 'task fri 2pm', null))[0]!;
  check('rows "task fri 2pm" on a record: that seller, due Friday', rowText(task0) === 'Task for Ronald Moore' && task0.action.t === 'add' && task0.action.seed.due === 'Fri, Sep 25, 2:00 PM', task0.action);

  // Empty query: recents first.
  const e = buildCommandRows(base('acquisitions', { recentIds: ['person:p2', 'person:p1', 'buyer:b1'], focus: 'p2', screen: 'person' }), '', null);
  check('rows empty: Recent first, newest first', e.groups[0]!.label === 'Recent' && rowText(e.groups[0]!.rows[0]!) === 'Ronald Moore' && rowText(e.groups[0]!.rows[1]!) === 'Kara Mitchell', e.groups.map((g) => g.label));
  check('rows empty: a buyer the role cannot see is not listed', !e.groups[0]!.rows.some((x) => x.action.t === 'open' && x.action.rec === 'buyer'));
  check('rows empty: then the record in focus, Text first (⏎ never rings anyone)', e.groups[1]!.label === 'Ronald Moore' && rowText(e.groups[1]!.rows[0]!) === 'Text Ronald Moore' && rowText(e.groups[1]!.rows[1]!) === 'Call Ronald Moore', e.groups[1]);
  check('rows empty: Create mirrors Quick Add for the role', e.groups.find((g) => g.label === 'Create')!.rows.map(rowText).join('|') === 'New lead|New property|New deal|New task|New appointment|New note|New vendor');
  const e2 = buildCommandRows(base('owner', { recentIds: ['buyer:b1'] }), '', null);
  check('rows empty (owner): a recent buyer is listed', rowText(e2.groups[0]!.rows[0]!) === 'Chris Anderson');

  // A bare name: the best match's own actions first (open, call, text, task).
  const bare = buildCommandRows(base('acquisitions'), 'kara', null);
  check('rows "kara": best match first, Open then Call, Text, Task', bare.groups[0]!.label === 'Best match' && bare.groups[0]!.rows.map(rowText).join('|') === 'Kara Mitchell|Call Kara Mitchell|Text Kara Mitchell|Task for Kara Mitchell', bare.groups[0]!.rows.map(rowText));
  check('rows "kara": the record row’s ⌘⏎ is Call', bare.groups[0]!.rows[0]!.alt?.label === 'Call');
  const ta = buildCommandRows(base('acquisitions'), 'ta', null);
  check('rows "ta": completes the verb, never runs it', ta.groups[0]!.label === 'Verbs' && ta.groups[0]!.rows.some((x) => x.action.t === 'type' && x.action.text === 'task '), ta.groups[0]);

  // Deals open where the role works them.
  const dealRow = (role: Role | null) => flat(buildCommandRows(base(role), 'pine', null)).find((x) => x.action.t === 'deal');
  check('deal (TC) → the closing file', dealRow('tc')?.action.t === 'deal' && (dealRow('tc')!.action as { where: string }).where === 'tc');
  check('deal (dispositions) → the dispo desk', (dealRow('dispositions')!.action as { where: string }).where === 'dispo');
  check('deal (owner) → the record, ⌘⏎ the closing file', (dealRow('owner')!.action as { where: string }).where === 'person' && dealRow('owner')!.alt?.label === 'Open the closing file');

  // Every deal and submission by its own address, opening pinned to that deal.
  const subs = base('owner', {
    people: [...base('owner').people, P('p20', 'Offerpad', '(800) 555-0100', '2 Partner Way', 'New Submission')],
    deals: [
      ...base('owner').deals,
      { id: 'p20', dealId: 'd71', addr: '4410 Ridgecrest Dr', contract: '', stage: 'New Submission', close: '', dot: '#000', who: 'Offerpad', find: '4410 Ridgecrest Dr San Antonio 78228 New Submission Offerpad' },
      { id: '', dealId: 'd72', addr: '918 Hemlock Ln', contract: '', stage: 'Under Contract Seller', close: '', dot: '#000', find: '918 Hemlock Ln Houston' },
      { id: 'p1', dealId: 'd73', addr: '123 Oakview Drive', contract: '', stage: 'Qualified', close: '', dot: '#000', who: 'Kara Mitchell', ownAddr: true },
    ],
  });
  const ridge = flat(buildCommandRows(subs, 'ridgecrest', null)).find((x) => x.action.t === 'deal');
  check('a submission is found by its own address', !!ridge && rowText(ridge) === '4410 Ridgecrest Dr' && ridge.sub === 'New Submission · Offerpad', ridge && rowText(ridge));
  check('a submission opens its partner pinned to that house', ridge?.action.t === 'deal' && ridge.action.id === 'p20' && ridge.action.dealId === 'd71', ridge?.action);
  check('a submission is found by its city too', flat(buildCommandRows(subs, 'san antonio', null)).some((x) => x.action.t === 'deal' && x.action.dealId === 'd71'));
  const noSeller = flat(buildCommandRows(subs, 'hemlock', null)).find((x) => x.action.t === 'deal');
  check('a deal with no seller opens its deal sheet, with no seller actions', noSeller?.action.t === 'deal' && noSeller.action.id === '' && noSeller.action.dealId === 'd72' && !noSeller.alt && !noSeller.more, noSeller);
  check('a lead’s own deal is not listed twice beside its record', !flat(buildCommandRows(subs, 'oakview', null)).some((x) => x.action.t === 'deal'), flat(buildCommandRows(subs, 'oakview', null)).map(rowText));

  // Vendors are records too.
  const withVendor = base('owner', { vendors: [{ id: 'v4', name: 'Alamo Title', kind: 'Title Company', find: 'Alamo Title Jen Park 210-555-0199 Title Company' }] });
  const vendor = flat(buildCommandRows(withVendor, 'alamo', null)).find((x) => x.action.t === 'vendor');
  check('"alamo": the vendor, opening its contact', vendor?.action.t === 'vendor' && vendor.action.id === 'v4' && vendor.sub === 'Vendor · Title Company', vendor);
  check('vendors are not offered to a role without People', !flat(buildCommandRows(base('tc', { vendors: withVendor.vendors }), 'alamo', null)).some((x) => x.action.t === 'vendor'));

  // A task opens the record it is on; one on nobody, Tasks. A deal-only checklist opens that deal's seller.
  const tasked = base('owner', {
    deals: [{ id: 'p1', addr: '123 Oakview', contract: '', stage: 'Under Contract Seller', close: '', dot: '#0A8560', dealId: 'd5', who: 'Kara Mitchell' }],
    tasks: [
      { id: 't2', title: 'Roof quote', due: 'Today', who: 'Taylor Reed', personId: 'p1' },
      { id: 't3', title: 'Renew title insurance', due: 'Today', who: 'Taylor Reed', personId: '' },
      { id: 't4', title: 'Order lockbox', due: 'Today', who: 'Taylor Reed', personId: '', dealId: 'd5' },
    ],
  });
  const onKara = flat(buildCommandRows(tasked, 'roof', null)).find((x) => x.label === 'Roof quote')!;
  check('a task opens its seller’s record, ⌘⏎ Tasks', onKara.action.t === 'open' && onKara.action.id === 'p1' && onKara.alt?.action.t === 'task', onKara);
  const loose = flat(buildCommandRows(tasked, 'renew', null)).find((x) => x.label === 'Renew title insurance');
  check('a task on nobody opens Tasks on it', loose?.action.t === 'task' && loose.action.id === 't3', loose?.action);
  const checklist = flat(buildCommandRows(tasked, 'lockbox', null)).find((x) => x.label === 'Order lockbox');
  check('a checklist task with only a deal opens that deal’s seller', checklist?.action.t === 'open' && checklist.action.id === 'p1', checklist?.action);

  // An appointment is with the seller it was made for.
  const appt = flat(buildCommandRows(base('acquisitions'), 'appointment kara', null))[0]!;
  check('"appointment kara": the dialog has Kara as its seller', appt.action.t === 'add' && appt.action.kind === 'appointment' && appt.action.seed.personId === 'p1', appt.action);
  const apptFocus = buildCommandRows(base('acquisitions', { focus: 'p2', screen: 'person' }), '', null).groups.find((x) => x.label === 'Create')!.rows.find((x) => x.label === 'New appointment')!;
  check('New appointment on a record: that seller', apptFocus.action.t === 'add' && apptFocus.action.seed.personId === 'p2' && apptFocus.sub === 'For Ronald Moore', apptFocus);

  // Tab: every action for the record; assign and stage are second lists.
  const more = buildCommandRows(base('acquisitions'), '', 'more:person:p1');
  const moreLabels = flat(more).map(rowText);
  check('Tab: every action for Kara', more.title === 'Kara Mitchell' && ['Call Kara Mitchell', 'Email Kara Mitchell', 'Underwrite 123 Oakview Drive', 'Send offer to Kara Mitchell', 'Kara Mitchell · texts'].every((x) => moreLabels.includes(x)), moreLabels);
  check('Tab: narrowed by what is typed', flat(buildCommandRows(base('acquisitions'), 'email', 'more:person:p1')).map(rowText).join() === 'Email Kara Mitchell');
  const assign = buildCommandRows(base('acquisitions'), '', 'assign:p1');
  check('assign step: reps then Unassigned, the current one marked', assign.title === 'Assign Kara Mitchell to' && flat(assign).map(rowText).join('|') === 'Taylor Reed|Diego Ortiz|Unassigned' && flat(assign)[0]!.sub === 'Assigned now');
  const pick = flat(buildCommandRows(base('acquisitions'), 'dieg', 'assign:p1'))[0]!;
  check('assign step: "dieg" → Diego', pick.action.t === 'assign' && pick.action.rep === 'diego', pick.action);
  const stage = flat(buildCommandRows(base('acquisitions'), 'offer', 'stage:p1'))[0]!;
  check('stage step: "offer" → Offer Sent', stage.action.t === 'stage' && stage.action.stage === 'Offer Sent', stage.action);

  // A name that starts with a verb still finds the record.
  const lane = buildCommandRows(base('acquisitions', { people: [...base('acquisitions').people, P('p9', 'Lane Smith', '(512) 555-0100', '9 Elm St', 'New Lead')] }), 'lane smith', null);
  check('"lane smith" still lists Lane Smith', flat(lane).some((x) => rowText(x) === 'Lane Smith'), flat(lane).map(rowText));
}

// ---- go: every screen the nav has is reachable ----------------------------------
{
  const all = (s: string) => canSee(DEMO_ROLE, s);
  check('"go contracts" offers Contracts', matchScreens('contracts', all)[0]?.key === 'contracts', matchScreens('contracts', all).map((x) => x.key));
  check('"go coaching" offers Coaching', matchScreens('coaching', all)[0]?.key === 'coaching', matchScreens('coaching', all).map((x) => x.key));
  check('"go tc" offers the closing files', matchScreens('tc', all)[0]?.key === 'tc');
  const tc = (s: string) => canSee('tc', s);
  check('a TC sees Contracts but not Coaching', matchScreens('', tc).some((x) => x.key === 'contracts') && !matchScreens('', tc).some((x) => x.key === 'coaching'));
}

console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall ${passed} command checks passed`);
if (failed) process.exitCode = 1;
