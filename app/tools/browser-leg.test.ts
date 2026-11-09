// Browser-leg failures the softphone recovers from.
// Run: npx tsx tools/browser-leg.test.ts
import { BrowserLegError, RELOAD_AND_TRY, SIGNED_IN_ELSEWHERE, SOCKET_QUIET_MS, browserLegSipKind, isBrowserLegError, legEndedOnServer, socketHeardRecently } from '../lib/browser-leg';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('486 is another softphone busy', browserLegSipKind(486), 'busy');
eq('487 is a ring that nobody answered', browserLegSipKind(487), 'timeout');
eq('a normal hangup is not a browser-leg failure', browserLegSipKind(200), null);
eq('a missing code is not a browser-leg failure', browserLegSipKind(undefined), null);

const timeout = new BrowserLegError('timeout');
const busy = new BrowserLegError('busy');
eq('timeout asks the rep to reload', timeout.message, RELOAD_AND_TRY);
eq('busy says the line is signed in somewhere else', busy.message, SIGNED_IN_ELSEWHERE);
eq('the code marks a browser-leg error', isBrowserLegError(timeout) && timeout.kind, 'timeout');
eq('busy keeps its kind', busy.kind, 'busy');
eq('a plain error is not a browser-leg error', isBrowserLegError(new Error(RELOAD_AND_TRY)), false);

const now = 1_000_000;
eq('a socket never heard from is not registered', socketHeardRecently(0, now), false);
eq('a socket heard a second ago is trusted', socketHeardRecently(now - 1_000, now), true);
eq('just inside the quiet window is trusted', socketHeardRecently(now - (SOCKET_QUIET_MS - 1), now), true);
eq('quiet past the window (a sleep) re-registers', socketHeardRecently(now - SOCKET_QUIET_MS, now), false);

for (const st of ['completed', 'failed', 'canceled', 'no_answer', 'busy']) eq(`Talkr ${st} ends the connecting leg`, legEndedOnServer(st), true);
for (const st of ['queued', 'initiated', 'ringing', 'in_progress', null]) eq(`Talkr ${st} keeps waiting for the leg`, legEndedOnServer(st), false);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
