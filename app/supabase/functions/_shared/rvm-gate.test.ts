// rvm-tick's per-drop person check: the blacklist, dnc, and a failed read.
// Run:  npx tsx supabase/functions/_shared/rvm-gate.test.ts
import { loadRvmPerson, type RvmGateDb } from './rvm-gate.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got); const w = JSON.stringify(want);
  if (g !== w) { console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`); failed++; }
  else console.log(`PASS  ${name}`);
}

const db = (data: unknown, error: { message: string } | null = null): RvmGateDb & { table: string[] } => {
  const table: string[] = [];
  return {
    table,
    from: (t) => { table.push(t); return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }; },
  };
};
const seller = (drop = { seller_id: 1, buyer_id: null }) => drop;

const a = await loadRvmPerson(db({ phone: '+1', tags: ['secret-blacklist'] }), seller());
eq('secret-blacklisted seller is blocked', a.ok && [a.blocked, a.dnc], ['blacklisted', false]);
const b = await loadRvmPerson(db({ phone: '+1', tags: ['DNC'] }), seller());
eq('dnc seller is do_not_call', b.ok && [b.blocked, b.dnc], ['do_not_call', true]);
const c = await loadRvmPerson(db({ phone: '+1', tags: ['hot'] }), seller());
eq('clean seller passes', c.ok && [c.blocked, c.dnc], [null, false]);
const buyers = db({ phone: '+1', tags: [], blacklisted_at: '2026-01-01', wants_calls: true });
const d = await loadRvmPerson(buyers, { seller_id: null, buyer_id: 4 });
eq('blacklisted_at buyer is blocked, from the buyers table', [d.ok && d.blocked, buyers.table], ['blacklisted', ['buyers']]);
const e = await loadRvmPerson(db({ phone: '+1', tags: [], blacklisted_at: null, wants_calls: false }), { seller_id: null, buyer_id: 4 });
eq('buyer who does not want calls stays dnc (unchanged)', e.ok && [e.blocked, e.dnc], [null, true]);
const f = await loadRvmPerson(db(null, { message: 'down' }), seller());
eq('a failed read holds the drop', f, { ok: false, message: 'could not check the blacklist: down' });
const g = await loadRvmPerson(db(null), seller());
eq('a missing row is not blocked', g.ok && [g.row, g.blocked], [null, null]);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
