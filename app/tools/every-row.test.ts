// Every page of a capped read. Run: npx tsx tools/every-row.test.ts
import { everyRow, everyRowResult } from '../lib/every-row';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

const table = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
const fake = (rows: { id: number }[], calls: [number, number][]) => () => ({
  range: (from: number, to: number) => { calls.push([from, to]); return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
});

void (async () => {
  let calls: [number, number][] = [];
  eq('three pages, in order', (await everyRow(fake(table(2345), calls), 1000)).map((r) => r.id).slice(-3), [2343, 2344, 2345]);
  eq('stops after the short page', calls, [[0, 999], [1000, 1999], [2000, 2999]]);
  calls = [];
  eq('a full last page asks once more and gets nothing', (await everyRow(fake(table(1000), calls), 1000)).length, 1000);
  eq('two reads for exactly one page', calls.length, 2);
  eq('empty table', await everyRow(fake([], []), 1000), []);
  let threw = '';
  try { await everyRow(() => ({ range: () => Promise.resolve({ data: null, error: { message: 'nope' } }) })); } catch (e) { threw = (e as Error).message; }
  eq('an error throws', threw, 'nope');
  eq('everyRowResult pages into data', (await everyRowResult(fake(table(1500), []), 1000)).data?.length, 1500);
  eq('everyRowResult hands back the error instead of throwing', await everyRowResult(() => ({ range: () => Promise.resolve({ data: null, error: { message: 'nope' } }) })), { data: null, error: { message: 'nope' } });
  if (failed) { console.error(`every-row: ${failed} failed`); process.exit(1); }
  console.log('every-row: ok');
})();
