// A line's SMS auto-reply (supabase/functions/_shared/sms-auto-reply.ts):
// no reply to a text that asks to stop, or to a number that is blacklisted or
// do-not-call, and nothing is claimed for either. A fake client stands in for
// Supabase; a plain text gets as far as the claim and then stops at "Talkr not
// connected", which proves the gates let it through.
// Run with:  npx tsx tools/sms-auto-reply.test.ts
import assert from 'node:assert/strict';
import { smsAutoReply } from '../supabase/functions/_shared/sms-auto-reply';

type Row = Record<string, unknown>;

function fakeDb(tables: Record<string, Row[]>) {
  const inserted: { table: string; row: Row }[] = [];
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let insert: Row | null = null;
    let update = false;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const result = () => {
      if (insert) {
        inserted.push({ table, row: insert });
        return { data: { id: inserted.length }, error: null };
      }
      if (update) return { data: null, error: null };
      return { data: rows(), error: null };
    };
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
      not: () => q,
      order: () => q,
      limit: () => q,
      insert: (row: Row) => ((insert = row), q),
      update: () => ((update = true), q),
      maybeSingle: async () => {
        const r = result();
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null };
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, bad),
    };
    return q;
  };
  return { db: { from } as never, claims: () => inserted.filter((i) => i.table === 'line_sms_auto_replies').length };
}

const WS = 7;
const LINE = '+12105550100';
const THEIRS = '+15125550123';
const base = (more: Record<string, Row[]> = {}) => ({
  line_sms_flows: [{
    workspace_id: WS, phone_e164: LINE, talkr_number_id: null, auto_reply_enabled: true,
    auto_reply_body: 'Got it, back soon.', auto_reply_when: 'always', hours: null, cooldown_hours: 24, updated_by: 'u1',
  }],
  line_sms_auto_replies: [],
  workspaces: [{ id: WS, settings: {} }],
  talkr_connections: [],
  ...more,
});
const text = (body: string, ref = 'ev-1') => ({ ref, from: THEIRS, to: LINE, body });

async function run() {
  // A plain text reaches the claim.
  {
    const f = fakeDb(base());
    assert.equal(await smsAutoReply(f.db, WS, text('Is the house still for sale?')), 'auto-reply failed: Talkr not connected');
    assert.equal(f.claims(), 1);
  }

  // Asking to stop, in words or as a keyword with punctuation.
  for (const body of ['Please stop texting me', 'STOP.', 'take me off your list', 'Stop messaging me please']) {
    const f = fakeDb(base());
    const note = await smsAutoReply(f.db, WS, text(body));
    assert.match(String(note), /^auto-reply skipped/, body);
    assert.equal(f.claims(), 0, body);
  }

  // A blacklisted seller on the number.
  {
    const f = fakeDb(base({ sellers: [{ id: 11, workspace_id: WS, phone: '512-555-0123', phone_key: '5125550123', tags: ['secret-blacklist'] }] }));
    assert.equal(await smsAutoReply(f.db, WS, text('hi there')), 'auto-reply skipped: do not contact');
    assert.equal(f.claims(), 0);
  }

  // A seller tagged DNC.
  {
    const f = fakeDb(base({ sellers: [{ id: 12, workspace_id: WS, phone_key: '5125550123', tags: ['DNC'] }] }));
    assert.equal(await smsAutoReply(f.db, WS, text('hi there')), 'auto-reply skipped: do not contact');
  }

  // A blacklisted buyer, and a buyer whose number is flagged DNC.
  {
    const f = fakeDb(base({ buyers: [{ id: 21, workspace_id: WS, phone_key: '5125550123', tags: [], blacklisted_at: '2026-10-01T00:00:00Z' }] }));
    assert.equal(await smsAutoReply(f.db, WS, text('hi there')), 'auto-reply skipped: do not contact');
  }
  {
    const f = fakeDb(base({
      buyers: [{ id: 22, workspace_id: WS, phone_key: '5125550999', tags: [] }],
      buyer_phones: [{ buyer_id: 22, workspace_id: WS, phone_key: '5125550123', is_dnc: true }],
    }));
    assert.equal(await smsAutoReply(f.db, WS, text('hi there')), 'auto-reply skipped: do not contact');
  }

  // A clean seller on the number still gets the reply.
  {
    const f = fakeDb(base({ sellers: [{ id: 13, workspace_id: WS, phone_key: '5125550123', tags: ['Hot lead'] }] }));
    assert.equal(await smsAutoReply(f.db, WS, text('hi there')), 'auto-reply failed: Talkr not connected');
    assert.equal(f.claims(), 1);
  }

  console.log('sms-auto-reply ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
