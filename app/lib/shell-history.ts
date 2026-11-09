// Back and Forward inside the operator app, without a page load.
//
// The shell's address is a path (`/app/people/s42`, lib/routes.ts) and every
// screen change is a history.pushState. Next's router (vinext) also listens
// for popstate: when a traversal lands on a path its own snapshot does not
// hold, it fetches `<path>?_rsc`. On the static export there is no RSC for
// `/app/people/s42` (the host rewrites it to app.html), so vinext falls back
// to a hard navigation. That reload drops the softphone and a live dial
// session on every Back.
//
// So an inline <head> script registers a popstate listener before vinext's
// module entry runs. For an entry the shell wrote (history.state carries
// `clozrIdx`, or `clozrPhone` for the full-screen phone's own entry) on an
// /app or /demo path, it stops the event before vinext sees it and
// re-dispatches it as `clozr:popstate`, which the shell's listeners hear
// instead. Entries vinext owns (no clozr keys, or a path outside the shell,
// such as Back to /login) pass through untouched.
//
// This depends on vinext internals, pinned at vinext 1.0.0-beta.3
// (package.json, exact version; keep it pinned):
//   - vinext/dist/server/app-browser-entry.js registers
//     `window.addEventListener("popstate", …)` at module evaluation. That
//     handler checks isSameAppRoutePopstateTarget() (path + search against its
//     navigationSnapshot) and otherwise starts an RSC traversal (handlePopstate).
//   - vinext/dist/shims/navigation.js registers a second popstate listener
//     and patches history.pushState/replaceState to keep its metadata
//     (createExternalHistoryStatePreservingMetadata); it never navigates.
// Module scripts run after inline scripts, so a listener added here is first,
// and stopImmediatePropagation keeps both of vinext's from running. Before
// upgrading vinext, run `node tools/nav-paths.e2e.mjs` against a build: it
// fails if Back or Forward fetches `?_rsc` or reloads the page.

/** The event the shell's Back/Forward listeners hear (detail: history.state). */
export const SHELL_POPSTATE = 'clozr:popstate';

/** Set on window by the inline script, so the shell knows the guard is in. */
const GUARD_FLAG = '__clozrPopGuard';

/** The paths the shell owns. Same test as lib/routes.ts underBase for /app and /demo. */
const SHELL_PATH = /^\/(app|demo)(\/|$)/;

/** True for history.state the shell wrote. */
export function isShellState(st: unknown): boolean {
  if (!st || typeof st !== 'object') return false;
  const s = st as { clozrIdx?: unknown; clozrPhone?: unknown };
  return typeof s.clozrIdx === 'number' || !!s.clozrPhone;
}

/**
 * The guard, as an inline <head> script (app/layout.tsx). It is registered on
 * every page, not only when the tab starts on /app: login hands over to /app
 * with a client navigation, and the guard has to be in place for that too.
 * The same script forwards an old app link that landed on the marketing page
 * (`/#screen=coaching`, the AI Sales Manager email) to /app, which reads it.
 * Kept in step with isShellState above.
 */
export const SHELL_HISTORY_SCRIPT = `(function(){
var R=${SHELL_PATH.toString()};
try{if(location.pathname==='/'&&/^#(.*&)?screen=/.test(location.hash)){location.replace('/app'+location.hash);return;}}catch(e){}
window.${GUARD_FLAG}=1;
addEventListener('popstate',function(e){
var s=e.state;
if(!R.test(location.pathname)||!s||typeof s!=='object'||(typeof s.clozrIdx!=='number'&&!s.clozrPhone))return;
e.stopImmediatePropagation();
try{dispatchEvent(new CustomEvent(${JSON.stringify(SHELL_POPSTATE)},{detail:s}));}catch(x){}
});
})();`;

/**
 * Listen for Back/Forward between the shell's own entries. With the guard in
 * place that is `clozr:popstate`; without it (a page whose layout did not
 * run the script) the plain popstate event, filtered the same way, so a
 * missing guard costs the no-reload behaviour, never Back itself.
 * Returns the unsubscribe.
 */
export function onShellPopstate(cb: (state: unknown) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const guarded = !!(window as unknown as Record<string, unknown>)[GUARD_FLAG];
  if (guarded) {
    const on = (e: Event) => cb((e as CustomEvent).detail);
    window.addEventListener(SHELL_POPSTATE, on);
    return () => window.removeEventListener(SHELL_POPSTATE, on);
  }
  const on = (e: PopStateEvent) => {
    if (SHELL_PATH.test(window.location.pathname) && isShellState(e.state)) cb(e.state);
  };
  window.addEventListener('popstate', on);
  return () => window.removeEventListener('popstate', on);
}
