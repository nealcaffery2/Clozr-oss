// Browser-leg failures the softphone recovers from.
// Run: npx tsx tools/browser-leg.test.ts
import { BrowserLegError, RELOAD_AND_TRY, browserLegSipKind, isBrowserLegError } from '../lib/browser-leg';

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
eq('busy asks the rep to reload', busy.message, RELOAD_AND_TRY);
eq('the code marks a browser-leg error', isBrowserLegError(timeout) && timeout.kind, 'timeout');
eq('busy keeps its kind', busy.kind, 'busy');
eq('a plain error is not a browser-leg error', isBrowserLegError(new Error(RELOAD_AND_TRY)), false);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
