import { acquireLock, keepLock, lockHolder, releaseSql, takeSql } from '../scripts/migrate-lock.mjs';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

async function throws(name: string, fn: () => Promise<unknown>, match: RegExp) {
  try {
    await fn();
    console.error('FAIL', name, '(did not throw)');
    process.exitCode = 1;
  } catch (e) {
    eq(name, match.test(String((e as Error).message)), true);
  }
}

// ---- holder ----------------------------------------------------------------

eq('Vercel deployment first', lockHolder({ VERCEL_DEPLOYMENT_ID: 'dpl_1', GITHUB_RUN_ID: '9' }), 'vercel:dpl_1');
eq('then the workflow run and attempt', lockHolder({ GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '2' }), 'github:9.2');
eq('else a random id', lockHolder({}, () => 'abc'), 'local:abc');
eq('two local runs differ', lockHolder({}) === lockHolder({}), false);

// ---- SQL -------------------------------------------------------------------

eq('take quotes the holder', takeSql("o'k", 30).includes("holder = 'o''k'"), true);
eq('take honours the stale window', /locked_at < now\(\) - interval '30 minutes'/.test(takeSql('x', 30)), true);
eq('release clears only its own lock', releaseSql('x').includes("where id = 1 and holder = 'x'"), true);

// ---- a fake row that behaves like the table ---------------------------------

type Row = { holder: string | null; locked_at: number | null };
function fakeDb(start: Row | null, clock: { t: number }) {
  const db = { row: start, takes: 0 };
  return {
    db,
    rows: async (q: string) => {
      if (q.includes('to_regclass')) return [{ present: db.row !== null }];
      return db.row ? [{ holder: db.row.holder, locked_at: db.row.locked_at }] : [];
    },
    exec: async (q: string) => {
      if (!db.row) throw new Error('relation "public.migration_lock" does not exist');
      const who = /holder = '([^']*)'/.exec(q)?.[1] ?? null;
      if (q.includes('set holder = null')) { if (db.row.holder === who) db.row = { holder: null, locked_at: null }; return; }
      if (q.startsWith('update') && q.includes('set locked_at = now()')) { if (db.row.holder === who) db.row.locked_at = clock.t; return; }
      db.takes++;
      const stale = /interval '(\d+) minutes'/.exec(q)![1];
      const free = db.row.holder === null || db.row.holder === who || db.row.locked_at === null || db.row.locked_at < clock.t - Number(stale) * 60_000;
      if (free) db.row = { holder: who, locked_at: clock.t };
    },
  };
}

async function main() {
  {
    const clock = { t: 0 };
    const f = fakeDb(null, clock);
    eq('no table: no lock, no error', await acquireLock({ ...f, holder: 'a', sleep: async () => {}, now: () => clock.t }), { taken: false });
  }
  {
    const clock = { t: 0 };
    const f = fakeDb({ holder: null, locked_at: null }, clock);
    eq('a free lock is taken', await acquireLock({ ...f, holder: 'a', sleep: async () => {}, now: () => clock.t }), { taken: true });
    eq('holder recorded', f.db.row?.holder, 'a');
  }
  {
    // b holds it and finishes after three polls; a waits, then takes it.
    const clock = { t: 0 };
    const f = fakeDb({ holder: 'b', locked_at: 0 }, clock);
    let polls = 0;
    const sleep = async (ms: number) => { clock.t += ms; if (++polls === 3) f.db.row = { holder: null, locked_at: null }; };
    eq('waits for the other run', await acquireLock({ ...f, holder: 'a', sleep, now: () => clock.t, pollMs: 10_000 }), { taken: true });
    eq('after three polls', polls, 3);
  }
  {
    // b never finishes and keeps its heartbeat fresh: a gives up after the wait.
    const clock = { t: 0 };
    const f = fakeDb({ holder: 'b', locked_at: 0 }, clock);
    const sleep = async (ms: number) => { clock.t += ms; f.db.row!.locked_at = clock.t; };
    await throws('gives up after the wait', () => acquireLock({ ...f, holder: 'a', sleep, now: () => clock.t, waitMs: 60_000, pollMs: 10_000 }), /waited 1 minutes .* held by b/);
    eq('b still holds it', f.db.row?.holder, 'b');
  }
  {
    // b died 31 minutes ago: taken over at once.
    const clock = { t: 31 * 60_000 };
    const f = fakeDb({ holder: 'b', locked_at: 0 }, clock);
    eq('a stale lock is taken over', await acquireLock({ ...f, holder: 'a', sleep: async () => { throw new Error('should not wait'); }, now: () => clock.t }), { taken: true });
  }
  {
    const clock = { t: 0 };
    const f = fakeDb({ holder: 'a', locked_at: 0 }, clock);
    clock.t = 5 * 60_000;
    await keepLock({ ...f, holder: 'a' });
    eq('heartbeat refreshes locked_at', f.db.row?.locked_at, 5 * 60_000);
    f.db.row = { holder: 'b', locked_at: clock.t };
    await throws('a lost lock stops the run', () => keepLock({ ...f, holder: 'a' }), /lost the migration lock to b/);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
