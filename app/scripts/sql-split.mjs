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

/**
 * The script without its `--` and `/* … *\/` comments. Quotes and
 * dollar-quoted bodies are left whole, so a comment marker inside a string
 * stays.
 */
export function stripComments(script) {
  let out = '';
  let i = 0;
  while (i < script.length) {
    const c = script[i];
    if (c === '-' && script[i + 1] === '-') { const end = script.indexOf('\n', i); i = end < 0 ? script.length : end; continue; }
    if (c === '/' && script[i + 1] === '*') { const end = script.indexOf('*/', i + 2); i = end < 0 ? script.length : end + 2; continue; }
    if (c === "'" || c === '"') {
      const escapes = c === "'" && /[eE]$/.test(out) && !/[A-Za-z0-9_][eE]$/.test(out);
      let j = i + 1;
      while (j < script.length) {
        if (escapes && script[j] === '\\') { j += 2; continue; }
        if (script[j] === c) { if (script[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      out += script.slice(i, j + 1); i = j + 1; continue;
    }
    const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i));
    if (tag) { const end = script.indexOf(tag[0], i + tag[0].length); const stop = end < 0 ? script.length : end + tag[0].length; out += script.slice(i, stop); i = stop; continue; }
    out += c; i++;
  }
  return out;
}

const AUTOCOMMIT_ONLY = /^(?:create\s+(?:unique\s+)?index\s+concurrently|drop\s+index\s+concurrently|reindex\s+\w+\s+concurrently|vacuum)\b/i;

/**
 * True when a statement of the script cannot run inside a transaction
 * (CREATE / DROP / REINDEX … CONCURRENTLY, VACUUM). Decided per statement
 * with comments stripped, so a header that mentions CONCURRENTLY does not
 * count.
 */
export function runsOutsideTransaction(script) {
  return splitStatements(script).some((s) => AUTOCOMMIT_ONLY.test(stripComments(s).trim()));
}

const CREATE_CONCURRENTLY = /^create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?("([^"]+)"|[A-Za-z_][A-Za-z0-9_$]*)/i;

/**
 * The names of the indexes the script's CREATE INDEX CONCURRENTLY statements
 * build, as Postgres stores them (a bare name lowercased, a quoted one as
 * written, no schema), in order and without repeats.
 */
export function concurrentIndexNames(script) {
  const names = [];
  for (const s of splitStatements(script)) {
    const m = CREATE_CONCURRENTLY.exec(stripComments(s).trim());
    if (!m) continue;
    const name = m[2] ?? m[1].toLowerCase();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
