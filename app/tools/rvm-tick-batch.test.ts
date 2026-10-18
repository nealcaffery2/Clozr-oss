// rvm-tick's batch reads, the caller line, the claim, and the per-tick caches
// (supabase/functions/rvm-tick/batch.ts).
// Run: npx tsx tools/rvm-tick-batch.test.ts
import {
  claimQueued, historyFacts, notesByText, once, readGates, ReadFailed, signedUrlUsable, takeLine,
  type CallerPool, type Chain, type GateDb, type GateDrop, type Prior,
} from '../supabase/functions/rvm-tick/batch';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};
const rejects = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e instanceof ReadFailed ? [e.reason, e.message] : String(e));

type Row = Record<string, unknown>;
const MAX_ROWS = 1000; // PostgREST's row cap on a select; an RPC's json comes back whole.
const longCall = (r: Row) => r.channel === 'call' && Number(r.duration_s) >= 20;
const latest = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;

/**
 * An in-memory PostgREST: select and update with in, eq, gte, or (`a.eq.1` / `a.in.(1,2)`), order and limit,
 * capped at MAX_ROWS, plus rvm_gate_history (migration 331) unless `noRpc`.
 */
function fakeDb(tables: Record<string, Row[]>, opts: { fail?: Record<string, string>; noRpc?: boolean; noPoolTier?: boolean } = {}) {
  const calls: string[] = [];
  const db: GateDb = {
    rpc(fn, args) {
      calls.push(`rpc:${fn}`);
      if (opts.fail?.[`rpc:${fn}`]) return Promise.resolve({ data: null, error: { message: opts.fail[`rpc:${fn}`]! } });
      if (opts.noRpc) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}(p_drop_ids) in the schema cache` } });
      const drops = (tables.rvm_drops ?? []).filter((d) => (args.p_drop_ids as number[]).includes(d.id as number));
      const data = drops.map((d) => {
        const mine = (r: Row) => (d.seller_id ? r.seller_id === d.seller_id : r.seller_id == null && r.buyer_id === d.buyer_id);
        const groups = new Map<string, Prior>();
        for (const r of (tables.rvm_drops ?? []).filter((r) => r.workspace_id === d.workspace_id && mine(r) && ['dropped', 'answered'].includes(r.status as string))) {
          const k = `${r.library_id}|${r.status}`;
          const g = groups.get(k) ?? { library_id: r.library_id as number | null, status: r.status as string, sent_at: null };
          g.sent_at = latest([g.sent_at, r.sent_at as string | null]);
          groups.set(k, g);
        }
        const talks = (tables.communications ?? []).filter((c) => longCall(c) && (d.seller_id ? c.seller_id === d.seller_id : c.buyer_id === d.buyer_id));
        return { id: d.id, last_talk: latest(talks.map((c) => c.occurred_at as string)), prior: [...groups.values()] };
      });
      return Promise.resolve({ data, error: null });
    },
    from(table) {
      const filters: ((r: Row) => boolean)[] = [];
      let patch: Row | null = null;
      let returning = false;
      let sort: { c: string; asc: boolean } | null = null;
      let cap = MAX_ROWS;
      const run = () => {
        calls.push(table);
        if (opts.fail?.[table]) return { data: null, error: { message: opts.fail[table]! } };
        if (patch && opts.noPoolTier && 'pool_tier' in patch) return { data: null, error: { message: 'column "pool_tier" of relation "rvm_drops" does not exist' } };
        // Filter and write in one synchronous step, like one UPDATE statement.
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (patch) {
          for (const r of rows) Object.assign(r, patch);
          return { data: returning ? rows.map((r) => ({ id: r.id })) : null, error: null };
        }
        if (sort) rows.sort((a, b) => String(a[sort!.c]).localeCompare(String(b[sort!.c])) * (sort!.asc ? 1 : -1));
        return { data: rows.slice(0, Math.min(cap, MAX_ROWS)), error: null };
      };
      const chain: Chain = {
        select() { if (patch) returning = true; return chain; },
        update(p) { patch = p; return chain; },
        in(c, vs) { filters.push((r) => vs.map(String).includes(String(r[c]))); return chain; },
        eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return chain; },
        gte(c, v) { filters.push((r) => Number(r[c]) >= Number(v)); return chain; },
        or(f) {
          const any = f.split(/,(?![^(]*\))/).map((part) => {
            const [c, op, ...rest] = part.split('.');
            const vs = op === 'in' ? rest.join('.').replace(/^\(|\)$/g, '').split(',') : [rest.join('.')];
            return { c: c!, vs };
          });
          filters.push((r) => any.some(({ c, vs }) => vs.includes(String(r[c]))));
          return chain;
        },
        order(c, o) { sort = { c, asc: o.ascending }; return chain; },
        limit(n) { cap = n; return chain; },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return chain;
    },
  };
  return { db, calls };
}

const drops: GateDrop[] = [
  { id: 1, workspace_id: 1, seller_id: 10, buyer_id: null },
  { id: 2, workspace_id: 1, seller_id: 11, buyer_id: null },
  { id: 3, workspace_id: 2, seller_id: null, buyer_id: 20 },
  { id: 4, workspace_id: 1, seller_id: 10, buyer_id: null }, // a second drop for seller 10
];
const seed = (): Record<string, Row[]> => ({
  sellers: [
    { id: 10, phone: '+12105550110', tags: ['hot'], properties: [{ state: 'TX', zip: '78201' }] },
    { id: 11, phone: '+12105550111', tags: ['DNC'], properties: [] },
  ],
  buyers: [{ id: 20, phone: '+12105550120', tags: [], blacklisted_at: null, wants_calls: true, markets: ['TX'], opted_in_at: '2026-10-01T00:00:00+00:00' }],
  communications: [
    { seller_id: 10, buyer_id: null, channel: 'call', duration_s: 45, occurred_at: '2026-10-01T15:00:00+00:00' },
    { seller_id: 10, buyer_id: null, channel: 'call', duration_s: 120, occurred_at: '2026-10-12T15:00:00+00:00' },
    { seller_id: 10, buyer_id: null, channel: 'call', duration_s: 5, occurred_at: '2026-10-15T15:00:00+00:00' }, // too short
    { seller_id: 10, buyer_id: null, channel: 'sms', duration_s: null, occurred_at: '2026-10-16T15:00:00+00:00' }, // not a call
    { seller_id: 99, buyer_id: 20, channel: 'call', duration_s: 30, occurred_at: '2026-10-09T15:00:00+00:00' }, // names buyer 20 too
  ],
  rvm_drops: [
    ...drops.map((d) => ({ ...d, status: 'queued', library_id: null, sent_at: null })),
    { id: 100, workspace_id: 1, seller_id: 10, buyer_id: null, library_id: 7, status: 'dropped', sent_at: '2026-10-02T15:00:00+00:00' },
    { id: 101, workspace_id: 1, seller_id: 10, buyer_id: null, library_id: 8, status: 'answered', sent_at: '2026-10-05T15:00:00+00:00' },
    { id: 102, workspace_id: 1, seller_id: 10, buyer_id: null, library_id: 9, status: 'failed', sent_at: '2026-10-06T15:00:00+00:00' },
    { id: 103, workspace_id: 3, seller_id: 10, buyer_id: null, library_id: 7, status: 'dropped', sent_at: '2026-10-06T15:00:00+00:00' }, // another workspace
    { id: 104, workspace_id: 2, seller_id: null, buyer_id: 20, library_id: 7, status: 'dropped', sent_at: '2026-10-03T15:00:00+00:00' },
  ],
});
const consent = (asked: number[] = []) => async (ws: number) => { asked.push(ws); return ws === 2; };

// ---- the batch read: sellers, buyers and one history call for the whole batch
{
  const { db, calls } = fakeDb(seed());
  const asked: number[] = [];
  const gates = await readGates(db, drops, consent(asked));
  eq('one read each for four drops', calls.sort(), ['buyers', 'rpc:rvm_gate_history', 'sellers']);
  eq('consent flag asked once per workspace', asked, [1, 2]);
  const g1 = gates.get(1)!;
  eq('clean seller passes the shared check', [g1.person.blocked, g1.person.dnc, g1.person.row?.phone], [null, false, '+12105550110']);
  eq('last call is the latest of 20 s or more', g1.lastTalk, '2026-10-12T15:00:00+00:00');
  eq('earlier drops: dropped and answered, this workspace only', g1.prior.map((p) => p.sent_at), ['2026-10-02T15:00:00+00:00', '2026-10-05T15:00:00+00:00']);
  eq('a second drop for the same person gets the same reads', gates.get(4), g1);
  const g2 = gates.get(2)!;
  eq('DNC seller is do not call, nothing else on file', [g2.person.blocked, g2.person.dnc, g2.lastTalk, g2.prior], ['do_not_call', true, null, []]);
  const g3 = gates.get(3)!;
  eq('buyer: consent needed in a Compr workspace, opt-in read with the row', [g3.consentNeeded, (g3.person.row as { opted_in_at?: string }).opted_in_at], [true, '2026-10-01T00:00:00+00:00']);
  eq('buyer: a call naming them and a seller counts for them', g3.lastTalk, '2026-10-09T15:00:00+00:00');
  eq('buyer: their own earlier drop', g3.prior.map((p) => p.sent_at), ['2026-10-03T15:00:00+00:00']);
  eq('history facts', historyFacts(g1.prior), {
    heard: ['7'], heardAt: { 7: '2026-10-02T15:00:00+00:00' }, lastDrop: '2026-10-02T15:00:00+00:00', lastAnswered: '2026-10-05T15:00:00+00:00',
  });
}

// ---- grouped history (one row per recording and status) gives the same facts as every row
{
  const every: Prior[] = [
    { library_id: 7, status: 'dropped', sent_at: '2026-09-01T15:00:00+00:00' },
    { library_id: 7, status: 'dropped', sent_at: '2026-10-01T15:00:00+00:00' },
    { library_id: 8, status: 'dropped', sent_at: '2026-09-15T15:00:00+00:00' },
    { library_id: null, status: 'dropped', sent_at: '2026-10-04T15:00:00+00:00' },
    { library_id: 9, status: 'dropped', sent_at: null },
    { library_id: 7, status: 'answered', sent_at: '2026-10-02T15:00:00+00:00' },
    { library_id: 7, status: 'answered', sent_at: '2026-08-02T15:00:00+00:00' },
  ];
  const grouped: Prior[] = [
    { library_id: 7, status: 'dropped', sent_at: '2026-10-01T15:00:00+00:00' },
    { library_id: 8, status: 'dropped', sent_at: '2026-09-15T15:00:00+00:00' },
    { library_id: null, status: 'dropped', sent_at: '2026-10-04T15:00:00+00:00' },
    { library_id: 9, status: 'dropped', sent_at: null },
    { library_id: 7, status: 'answered', sent_at: '2026-10-02T15:00:00+00:00' },
  ];
  const facts = (p: Prior[]) => { const f = historyFacts(p); return { ...f, heard: [...new Set(f.heard)].sort() }; };
  eq('grouped history: same heard set, heardAt, last drop, last answered', facts(grouped), facts(every));
}

// ---- a busy batch: more calls and drops than one select may return still reads in full
{
  const tables: Record<string, Row[]> = { sellers: [], communications: [], rvm_drops: [] };
  const busy: GateDrop[] = Array.from({ length: 48 }, (_, i) => ({ id: i + 1, workspace_id: 1, seller_id: 500 + i, buyer_id: null }));
  for (const d of busy) {
    tables.sellers!.push({ id: d.seller_id, phone: `+1210555${String(d.id).padStart(4, '0')}`, tags: [] });
    tables.rvm_drops!.push({ ...d, status: 'queued' });
    for (let k = 0; k < 30; k++) {
      tables.communications!.push({ seller_id: d.seller_id, channel: 'call', duration_s: 60, occurred_at: `2026-09-${String(k + 1).padStart(2, '0')}T15:00:00+00:00` });
      tables.rvm_drops!.push({ workspace_id: 1, seller_id: d.seller_id, buyer_id: null, library_id: k % 3, status: 'dropped', sent_at: `2026-08-${String(k + 1).padStart(2, '0')}T15:00:00+00:00` });
    }
  }
  eq('the fixture is over the row cap', [tables.communications!.length > MAX_ROWS, tables.rvm_drops!.length > MAX_ROWS], [true, true]);
  const gates = await readGates(fakeDb(tables).db, busy, async () => false);
  eq('48 busy sellers: every last call is the latest', [...gates.values()].every((g) => g.lastTalk === '2026-09-30T15:00:00+00:00'), true);
  eq('48 busy sellers: every last drop is the latest', [...gates.values()].every((g) => historyFacts(g.prior).lastDrop === '2026-08-30T15:00:00+00:00'), true);
}

// ---- before migration 331: a batch is not read; one drop reads as main did (limit 1 on the call)
{
  const tables = seed();
  for (let k = 0; k < 1500; k++) tables.communications!.push({ seller_id: 10, channel: 'call', duration_s: 30, occurred_at: `2026-0${1 + (k % 9)}-01T00:00:00+00:00` });
  tables.communications!.push({ seller_id: 10, channel: 'call', duration_s: 30, occurred_at: '2026-10-14T15:00:00+00:00' });
  eq('a batch without the function falls back to per-drop reads', await rejects(readGates(fakeDb(tables, { noRpc: true }).db, drops, consent())),
    ['check_failed', 'could not check a batch of earlier drops and calls: rvm_gate_history is not in the database yet']);
  const { db, calls } = fakeDb(tables, { noRpc: true });
  const one = (await readGates(db, [drops[0]!], consent())).get(1)!;
  eq('one drop, one person with 1,500 long calls: the latest, never cut short', one.lastTalk, '2026-10-14T15:00:00+00:00');
  eq('one drop: its earlier drops as before', one.prior.map((p) => p.sent_at), ['2026-10-02T15:00:00+00:00', '2026-10-05T15:00:00+00:00']);
  eq('one drop: the old reads', calls.sort(), ['communications', 'rpc:rvm_gate_history', 'rvm_drops', 'sellers']);
}

// ---- a failed read never reads as "nothing there"
eq('failed person read holds, in the old words', await rejects(readGates(fakeDb(seed(), { fail: { sellers: 'down' } }).db, drops, consent())),
  ['blacklist_check_failed', 'could not check the blacklist: down']);
eq('a failed seller read does not hold a batch of buyers', await rejects(readGates(fakeDb(seed(), { fail: { sellers: 'down' } }).db, [drops[2]!], consent())), null);
eq('failed history call holds', await rejects(readGates(fakeDb(seed(), { fail: { 'rpc:rvm_gate_history': 'timeout' } }).db, drops, consent())),
  ['check_failed', 'could not check their earlier drops and calls: timeout']);
eq('a drop missing from the history call holds', await rejects(readGates(fakeDb(seed()).db, [...drops, { id: 77, workspace_id: 1, seller_id: 10, buyer_id: null }], consent())),
  ['check_failed', 'could not check their earlier drops and calls: the drop was not found']);
eq('failed per-drop call read holds', await rejects(readGates(fakeDb(seed(), { noRpc: true, fail: { communications: 'down' } }).db, [drops[0]!], consent())),
  ['check_failed', 'could not check their last call: down']);
eq('a failed consent flag holds', await rejects(readGates(fakeDb(seed()).db, drops, async () => { throw new ReadFailed('check_failed', 'flag down'); })),
  ['check_failed', 'flag down']);

// ---- the second look before a send sees what changed after the batch read
{
  const tables = seed();
  const { db } = fakeDb(tables);
  const batch = await readGates(db, drops, consent());
  tables.sellers![0]!.tags = ['DNC'];
  tables.rvm_drops!.push({ id: 105, workspace_id: 1, seller_id: 10, buyer_id: null, library_id: 7, status: 'dropped', sent_at: '2026-10-17T15:00:00+00:00' });
  const fresh = (await readGates(db, [drops[0]!], consent())).get(1)!;
  eq('batch read still says clean', batch.get(1)!.person.blocked, null);
  eq('per-drop read sees the new DNC and the new drop', [fresh.person.blocked, historyFacts(fresh.prior).lastDrop], ['do_not_call', '2026-10-17T15:00:00+00:00']);
}

// ---- two overlapping runs: both batch reads say send, the claim picks one
{
  const due = [1, 2, 3, 4, 5].map((id) => ({ id, workspace_id: 1, seller_id: 10 + id, buyer_id: null }));
  const tables: Record<string, Row[]> = {
    rvm_drops: due.map((d) => ({ ...d, status: 'queued' })),
    sellers: due.map((d) => ({ id: d.seller_id, phone: `+1210555010${d.id}`, tags: [] })),
    communications: [],
  };
  const { db } = fakeDb(tables);
  const sent: string[] = [];
  const run = async (name: string, order: number[]) => {
    const gates = await readGates(db, due, async () => false); // read before either run claims anything
    for (const id of order) {
      if (gates.get(id)!.person.blocked) continue;
      await new Promise((r) => setTimeout(r, Math.random() * 3)); // the other run gets in between
      if (await claimQueued(db, id, { status: 'sending', provider: 'telnyx', pool_tier: null })) sent.push(`${name}${id}`);
    }
  };
  await Promise.all([run('A', [1, 2, 3, 4, 5]), run('B', [5, 4, 3, 2, 1])]);
  eq('each drop goes out once across two overlapping runs', sent.map((s) => Number(s.slice(1))).sort(), [1, 2, 3, 4, 5]);
  eq('every row is claimed', tables.rvm_drops!.map((r) => r.status), ['sending', 'sending', 'sending', 'sending', 'sending']);
  const late: string[] = [];
  const stale = await readGates(db, due, async () => false);
  for (const d of due) if (!stale.get(d.id)!.person.blocked && await claimQueued(db, d.id, { status: 'sending' })) late.push(String(d.id));
  eq('a third run on the same reads sends nothing', late, []);
}
{
  const tables: Record<string, Row[]> = { rvm_drops: [{ id: 9, status: 'queued' }] };
  const ok = await claimQueued(fakeDb(tables, { noPoolTier: true }).db, 9, { status: 'sending', pool_tier: 'state' });
  eq('before migration 198 the claim goes without pool_tier', [ok, tables.rvm_drops![0]], [true, { id: 9, status: 'sending' }]);
}

// ---- caller lines: a drop that is not claimed gives its line back
{
  const pool = (): CallerPool => ({ lines: [], counts: {}, seq: 0, rvm: [{ e164: '+12105550900', state: 'TX', cap: 1, usable: true }], usedToday: {} });
  const p = pool();
  const first = takeLine(p, '+12105550101', 'TX');
  eq('one left on the line: the first drop takes it', [first.from, first.full], ['+12105550900', false]);
  eq('a second drop finds the pool full', takeLine(p, '+12105550102', 'TX').full, true);
  const q = pool();
  takeLine(q, '+12105550101', 'TX').release!(); // held on a failed read, never claimed
  const next = takeLine(q, '+12105550102', 'TX');
  eq('after a held drop gives it back, the next drop still gets the line', [next.from, next.full, q.usedToday], ['+12105550900', false, { '+12105550900': 1 }]);
  const plain: CallerPool = { lines: ['+12105550801', '+12105550802'], counts: { '+12105550801': 0, '+12105550802': 0 }, seq: 0, rvm: [], usedToday: {} };
  const t = takeLine(plain, '+12105550101', null);
  t.release!();
  eq('without a pool the week count goes back too', plain.counts, { '+12105550801': 0, '+12105550802': 0 });
  const dead: CallerPool = { lines: [], counts: {}, seq: 0, rvm: [{ e164: '+12105550900', cap: 5, usable: false }], usedToday: {} };
  const none = takeLine(dead, '+12105550101', 'TX');
  eq('no usable pool line: nothing taken, nothing to give back', [none.noLine, none.release], [true, undefined]);
}

// ---- per-tick caches
{
  const cache = new Map<string, Promise<unknown>>();
  let loads = 0;
  const a = once(cache, 'k', async () => ++loads);
  const b = once(cache, 'k', async () => ++loads);
  eq('one load shared by every worker', [await a, await b, loads], [1, 1, 1]);
  await once(cache, 'x', async () => { throw new ReadFailed('check_failed', 'down'); }).catch(() => undefined);
  await Promise.resolve();
  eq('a failed load is forgotten, so the next drop asks again', [cache.has('x'), await once(cache, 'x', async () => 'ok')], [false, 'ok']);
}
{
  const t0 = Date.parse('2026-10-17T15:00:00Z');
  const link = { expiresAt: t0 + 3600_000 };
  eq('a link made at the start of a minute-long tick still has 59 minutes at its last send', signedUrlUsable(link, t0 + 60_000), true);
  eq('a link with under 55 minutes left is made again', signedUrlUsable(link, t0 + 6 * 60_000), false);
}

// ---- Talkr notes: one update per distinct note
eq('notes grouped by text', [...notesByText([
  { ref: 'rvm:1', ok: false, note: 'Talkr not told' },
  { ref: 'rvm:2', ok: false, note: 'Talkr not told' },
  { ref: 'rvm:3', ok: true, note: null },
  { ref: 'rvm:4', ok: false, note: 'other' },
  { ref: 'rvm:5', ok: false, note: null },
])], [['Talkr not told', [1, 2]], ['other', [4]]]);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
