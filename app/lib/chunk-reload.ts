// A tab that was open across a deploy asks for chunks the new deploy deleted.
//
// Every build names its chunks by content hash (/_next/static/chunks/bundle-
// B6hwCu0e.js), and a Vercel deploy serves only its own files, so the first
// lazy import or client navigation in an old tab fails with "Failed to fetch
// dynamically imported module". Nothing is wrong with the code or the data:
// the page is just older than the server. A reload fetches the new HTML, which
// names the new chunks.
//
// The reload is guarded in sessionStorage by time, not by a one-shot flag, so
// a chunk that is truly missing on the live deploy reloads once and then shows
// the error instead of looping, while a second deploy later in the same
// session still recovers.

const KEY = 'clozr:chunk-reload-at';
/** A second failure inside this window means the reload did not help. */
const WINDOW_MS = 30_000;

const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading (?:CSS )?chunk [\w-]+ failed|Unable to preload CSS/i;

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: unknown; message?: unknown };
  const text = `${typeof e.name === 'string' ? e.name : ''} ${typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : ''}`;
  return CHUNK_ERROR.test(text);
}

/** Reload once for a new deploy. False when a reload already ran moments ago (or storage is off), so the caller shows the error. */
export function reloadForNewDeploy(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const last = Number(window.sessionStorage.getItem(KEY)) || 0;
    if (Date.now() - last < WINDOW_MS) return false;
    window.sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * The same guard as an inline <head> script, so it is listening before any
 * module loads: the chunk that fails may be the one that would have installed
 * a React-side handler. Kept in step with the functions above.
 */
export const CHUNK_RELOAD_SCRIPT = `(function(){
var K=${JSON.stringify(KEY)},W=${WINDOW_MS},R=${CHUNK_ERROR.toString()};
function go(){try{var l=+sessionStorage.getItem(K)||0;if(Date.now()-l<W)return false;sessionStorage.setItem(K,String(Date.now()));}catch(e){return false;}location.reload();return true;}
function hit(x){if(!x)return false;var m=(x.name||'')+' '+(x.message||(typeof x==='string'?x:''));return R.test(m);}
addEventListener('vite:preloadError',function(e){if(go())e.preventDefault();});
addEventListener('unhandledrejection',function(e){if(hit(e.reason)&&go())e.preventDefault();});
addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.tagName==='SCRIPT'||t.tagName==='LINK')){var u=t.src||t.href||'';if(u.indexOf(location.origin+'/_next/static/')===0||u.indexOf(location.origin+'/assets/')===0)go();return;}if(hit(e.error)||R.test(e.message||''))go();},true);
})();`;
