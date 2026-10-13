// Cutting a SQL script into statements, for the migration runner's Management
// API path (scripts/migrate.mjs), which must send CREATE INDEX CONCURRENTLY
// one statement per request.

/**
 * A script cut into its statements: at each `;` outside quotes, dollar-quoted
 * bodies and comments. Comment-only pieces are dropped. Tested in
 * tools/sql-split.test.ts.
 */
export function splitStatements(script) {
  const out = [];
  let cur = '';
  let i = 0;
  const push = () => { if (cur.replace(/--[^\n]*/g, '').trim()) out.push(cur.trim()); cur = ''; };
  while (i < script.length) {
    const c = script[i];
    const rest = script.slice(i);
    if (c === '-' && script[i + 1] === '-') { const end = script.indexOf('\n', i); const stop = end < 0 ? script.length : end; cur += script.slice(i, stop); i = stop; continue; }
    if (c === '/' && script[i + 1] === '*') { const end = script.indexOf('*/', i + 2); const stop = end < 0 ? script.length : end + 2; cur += script.slice(i, stop); i = stop; continue; }
    if (c === "'" || c === '"') {
      // '' (or "") inside doubles the quote; an E'…' string also escapes with a backslash.
      const escapes = c === "'" && /[eE]$/.test(cur) && !/[A-Za-z0-9_][eE]$/.test(cur);
      let j = i + 1;
      while (j < script.length) {
        if (escapes && script[j] === '\\') { j += 2; continue; }
        if (script[j] === c) { if (script[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      cur += script.slice(i, j + 1); i = j + 1; continue;
    }
    const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (tag) { const end = script.indexOf(tag[0], i + tag[0].length); const stop = end < 0 ? script.length : end + tag[0].length; cur += script.slice(i, stop); i = stop; continue; }
    if (c === ';') { cur += c; push(); i++; continue; }
    cur += c; i++;
  }
  push();
  return out;
}
