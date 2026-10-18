// One tab per browser sends the presence heartbeat.
// Run: npx tsx tools/presence-leader.test.ts
import { createPresenceLeader, leadsBeat, parseLeaderRow, PRESENCE_LEADER_KEY, type LeaderStorage, type StorageEvents } from '../lib/presence-leader';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('a blank row is nobody', parseLeaderRow(null), null);
eq('junk is nobody', parseLeaderRow('{oops'), null);
eq('a row without a tab is nobody', parseLeaderRow('{"until":5}'), null);
eq('a row round-trips', parseLeaderRow('{"tabId":"a","until":5,"phone":true}'), { tabId: 'a', until: 5, phone: true });
eq('phone defaults to false', parseLeaderRow('{"tabId":"a","until":5}'), { tabId: 'a', until: 5, phone: false });

eq('nobody leads: I do', leadsBeat(null, 'me', 1_000, false), true);
eq('my own row: I do', leadsBeat({ tabId: 'me', until: 5_000, phone: false }, 'me', 1_000, false), true);
eq('a live other tab: I do not', leadsBeat({ tabId: 'them', until: 5_000, phone: false }, 'me', 1_000, false), false);
eq('an expired other tab: I do', leadsBeat({ tabId: 'them', until: 1_000, phone: true }, 'me', 1_000, false), true);
eq('I hold the phone, they do not: I do', leadsBeat({ tabId: 'them', until: 5_000, phone: false }, 'me', 1_000, true), true);
eq('we both hold a phone: the leader keeps it', leadsBeat({ tabId: 'them', until: 5_000, phone: true }, 'me', 1_000, true), false);

// Two tabs over one storage. A write in one tab is a storage event in the others, as browsers do it.
type StorageEventLike = { key: string | null; newValue: string | null };
type Fn = (e: StorageEventLike) => void;
const map = new Map<string, string>();
const tabs: Array<Set<Fn>> = [];
function tab(): { events: StorageEvents; storage: LeaderStorage } {
  const fns = new Set<Fn>();
  tabs.push(fns);
  const fire = (e: StorageEventLike) => { for (const t of tabs) if (t !== fns) for (const fn of t) fn(e); };
  return {
    events: { addEventListener: (_t, fn) => { fns.add(fn); }, removeEventListener: (_t, fn) => { fns.delete(fn); } },
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => { map.set(k, v); fire({ key: k, newValue: v }); },
      removeItem: (k) => { map.delete(k); fire({ key: k, newValue: null }); },
    },
  };
}
let clock = 10_000;
const ta = tab();
const tb = tab();
const A = createPresenceLeader('u1', { ...ta, now: () => clock, tabId: 'A', ttlMs: 90_000 });
const B = createPresenceLeader('u1', { ...tb, now: () => clock, tabId: 'B', ttlMs: 90_000 });
let bFreed = 0;
const offB = B.onFreed(() => { bFreed++; });

eq('first tab to beat leads', A.claim(false), true);
eq('the row is keyed by user', [...map.keys()], [PRESENCE_LEADER_KEY + 'u1']);
eq('second tab follows', B.claim(false), false);
clock += 60_000;
eq('the leader renews', A.claim(false), true);
eq('the follower still follows', B.claim(false), false);
A.release();
eq('the follower hears the release', bFreed, 1);
eq('and takes over', B.claim(false), true);
eq('the old leader now follows', A.claim(false), false);
B.release();
B.release();
eq('releasing twice frees once', bFreed, 1);
eq('A takes it back', A.claim(false), true);
eq('B with the phone takes over from A without it', B.claim(true), true);
eq('A follows the phone tab', A.claim(false), false);
A.release();
eq('release by a follower leaves the row', parseLeaderRow(map.get(PRESENCE_LEADER_KEY + 'u1'))?.tabId, 'B');
clock += 91_000;
eq('a leader gone quiet past its time is replaced', A.claim(false), true);
offB();
A.release();
eq('unsubscribed: no more freed calls', bFreed, 1);
const C = createPresenceLeader('u2', { storage: ta.storage, events: null, now: () => clock, tabId: 'C' });
eq('another user has their own leader', C.claim(false), true);

const throwing: LeaderStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};
const D = createPresenceLeader('u1', { storage: throwing, events: null, tabId: 'D' });
eq('blocked storage: every tab beats', D.claim(false), true);
D.release();
eq('no storage: every tab beats', createPresenceLeader('u1', { storage: null, events: null }).claim(false), true);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
