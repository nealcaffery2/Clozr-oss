// One tab holds the Telnyx softphone.
// Run: npx tsx tools/softphone-lock.test.ts
import {
  callWhileLockedElsewhere, createSoftphoneLock, lockDecision, mayAutoAcquirePhone, parseSoftphoneLock, PHONE_OTHER_TAB,
  SOFTPHONE_LOCK_KEY, USE_PHONE_HERE, type LockStorage, type WebLockManager,
} from '../lib/softphone-lock';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('a blank row is free', parseSoftphoneLock(null), null);
eq('junk is free', parseSoftphoneLock('nope'), null);
eq('a row round-trips', parseSoftphoneLock('{"tabId":"a","at":5}'), { tabId: 'a', at: 5 });

eq('no row is free', lockDecision(null, 'me', 10_000), 'free');
eq('my fresh row is mine', lockDecision({ tabId: 'me', at: 9_000 }, 'me', 10_000, 8_000), 'mine');
eq('a fresh other tab blocks', lockDecision({ tabId: 'them', at: 9_000 }, 'me', 10_000, 8_000), 'other');
eq('a stale other tab is free', lockDecision({ tabId: 'them', at: 1_000 }, 'me', 10_000, 8_000), 'free');

const listeners: Array<(event: { data?: unknown }) => void> = [];
function channel() {
  const mine: typeof listeners = [];
  return {
    postMessage(data: unknown) {
      for (const fn of [...listeners]) fn({ data });
    },
    close() {
      for (const fn of mine) {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      }
    },
    addEventListener(_type: 'message', fn: (event: { data?: unknown }) => void) {
      listeners.push(fn);
      mine.push(fn);
    },
  };
}

const mem = new Map<string, string>();
const storage = {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => { mem.set(key, value); },
  removeItem: (key: string) => { mem.delete(key); },
};
let now = 1_000_000;
const clock = () => now;
let lost = 0;
const first = createSoftphoneLock({
  tabId: 'first', now: clock, storage, channel: channel(), heartbeatMs: null, staleMs: 8_000,
  onLost: () => { lost += 1; },
});
const second = createSoftphoneLock({
  tabId: 'second', now: clock, storage, channel: channel(), heartbeatMs: null, staleMs: 8_000,
});

eq('the first tab takes the phone', first.tryHold(), 'ok');
eq('the second tab does not register', second.tryHold(), 'other');
eq('the copy names the other tab', PHONE_OTHER_TAB, 'Phone is open in another tab');
second.takeover();
eq('takeover tells the holder', lost, 1);
eq('the holder no longer has the lock', first.holding(), false);
eq('the second tab holds it', second.holding(), true);
eq('the first tab is now the other one', first.tryHold(), 'other');
now += 8_000;
eq('a crashed tab goes stale', first.tryHold(), 'ok');
first.release();
eq('release frees the phone', second.tryHold(), 'ok');
second.destroy();
first.destroy();

eq('a hidden tab does not auto-acquire', mayAutoAcquirePhone({ visibilityState: 'hidden', hasFocus: () => true }), false);
eq('a visible unfocused tab does not auto-acquire', mayAutoAcquirePhone({ visibilityState: 'visible', hasFocus: () => false }), false);
eq('a visible focused tab may auto-acquire', mayAutoAcquirePhone({ visibilityState: 'visible', hasFocus: () => true }), true);
eq('no document does not auto-acquire', mayAutoAcquirePhone(null), false);
eq('call against another tab names it', callWhileLockedElsewhere('other'), { message: PHONE_OTHER_TAB, action: USE_PHONE_HERE });
eq('call on our own lock dials', callWhileLockedElsewhere('mine'), null);
eq('call on a free lock dials', callWhileLockedElsewhere('free'), null);

function memStorage(): LockStorage {
  const box = new Map<string, string>();
  return {
    getItem: (key) => box.get(key) ?? null,
    setItem: (key, value) => { box.set(key, value); },
    removeItem: (key) => { box.delete(key); },
  };
}

// A reload keeps the tab id, so the fresh page reclaims its own row at once.
const session = memStorage();
const local = memStorage();
const reloaded = createSoftphoneLock({
  session, storage: local, channel: channel(), heartbeatMs: null, locks: null, unload: null, staleMs: 8_000, now: clock,
});
eq('the reloaded tab takes the phone', reloaded.tryHold(), 'ok');
const again = createSoftphoneLock({
  session, storage: local, channel: channel(), heartbeatMs: null, locks: null, unload: null, staleMs: 8_000, now: clock,
});
eq('the same tab id comes back', again.tabId, reloaded.tabId);
eq('a reload reclaims its own lock', again.tryHold(), 'ok');
const stranger = createSoftphoneLock({
  session: memStorage(), storage: local, channel: channel(), heartbeatMs: null, locks: null, unload: null, staleMs: 8_000, now: clock,
});
eq('a different tab still waits', stranger.tryHold(), 'other');
reloaded.release();
eq('the dying page does not clear the reloaded row', again.holding(), true);
eq('the reloaded row is still there', parseSoftphoneLock(local.getItem(SOFTPHONE_LOCK_KEY))?.tabId, again.tabId);
again.release();
stranger.destroy();
reloaded.destroy();
again.destroy();

const events = new Map<string, () => void>();
const unload = {
  addEventListener(type: 'pagehide' | 'beforeunload', fn: () => void) { events.set(type, fn); },
  removeEventListener(type: 'pagehide' | 'beforeunload', fn: () => void) { if (events.get(type) === fn) events.delete(type); },
};
const heldLocal = memStorage();
const page = createSoftphoneLock({
  tabId: 'page', storage: heldLocal, session: memStorage(), channel: channel(), heartbeatMs: null, locks: null, unload, staleMs: 8_000, now: clock,
});
eq('pagehide is watched', events.has('pagehide'), true);
eq('beforeunload is watched', events.has('beforeunload'), true);
page.tryHold();
events.get('pagehide')!();
eq('pagehide releases the lock', page.holding(), false);
eq('pagehide clears the row', heldLocal.getItem(SOFTPHONE_LOCK_KEY), null);
page.tryHold();
events.get('beforeunload')!();
eq('beforeunload releases the lock', page.holding(), false);
page.destroy();
eq('destroy drops the listeners', events.has('pagehide'), false);

// Web Locks: a second tab is refused even when the storage row was wiped,
// and a reload of the owning tab can steal its own dying hold.
function fakeWebLocks(): WebLockManager {
  type Holder = { release: () => void };
  let holder: Holder | null = null;
  return {
    request(_name, options, cb) {
      const blocked = !!holder && !options.steal;
      if (blocked) {
        cb(null);
        return Promise.resolve();
      }
      if (holder && options.steal) {
        const prev = holder;
        holder = null;
        prev.release();
      }
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const mine: Holder = { release };
      holder = mine;
      const result = cb({ name: _name });
      void Promise.race([Promise.resolve(result).then(() => undefined), released]).finally(() => {
        if (holder === mine) holder = null;
      });
      return Promise.resolve(result);
    },
  };
}

const web = fakeWebLocks();
const webLocal = memStorage();
const webNow = 5_000_000;
const owner = createSoftphoneLock({
  tabId: 'owner', storage: webLocal, session: memStorage(), channel: channel(), heartbeatMs: null, locks: web, unload: null, now: () => webNow,
});
const rival = createSoftphoneLock({
  tabId: 'rival', storage: webLocal, session: memStorage(), channel: channel(), heartbeatMs: null, locks: web, unload: null, now: () => webNow,
});
eq('web lock: the owner registers', owner.tryHold(), 'ok');
webLocal.removeItem(SOFTPHONE_LOCK_KEY);
eq('web lock: a wiped row still blocks the other tab', rival.tryHold(), 'other');
eq('web lock: the owner writes its row again', owner.tryHold(), 'ok');
const ownerSession = memStorage();
ownerSession.setItem('clozr-softphone-tab', 'owner');
const reborn = createSoftphoneLock({
  session: ownerSession, storage: webLocal, channel: channel(), heartbeatMs: null, locks: web, unload: null, now: () => webNow,
});
eq('web lock: the same tab steals its own hold back', reborn.tryHold(), 'ok');
eq('web lock: the same tab id survived', reborn.tabId, 'owner');
rival.takeover();
eq('web lock: an explicit takeover wins', rival.holding(), true);
eq('web lock: the previous tab let go', reborn.holding(), false);
owner.destroy();
rival.destroy();
reborn.destroy();

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
