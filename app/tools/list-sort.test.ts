// List sort. Run: npx tsx tools/list-sort.test.ts
import { addedOn, cmpSort, inDrawnOrder, peopleColumnSort, peopleSortColumn, sortToken, toggleSort } from '../lib/list-sort';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

eq('date added label', addedOn('2026-09-26T15:00:00.000Z').includes('2026'), true);
eq('missing date', addedOn(null), '—');
eq('money token', sortToken('$1,250'), 1250);
eq('blank token', sortToken('—'), '');
eq('newest first', cmpSort('2026-01-02', '2026-03-01', 'desc') > 0, true);
eq('blanks last', cmpSort('', '2026-01-01', 'asc') > 0, true);
eq('toggle flips', toggleSort({ key: 'added', dir: 'desc' }, 'added', 'desc').dir, 'asc');
eq('toggle switches column', toggleSort({ key: 'added', dir: 'desc' }, 'name', 'asc'), { key: 'name', dir: 'asc' });
eq('people date added click', peopleColumnSort('Recent', 'created'), 'Date added');
eq('people date added toggles', peopleColumnSort('Date added', 'created'), 'Oldest added');
eq('people name does not sort a phone column', peopleColumnSort('Name', 'phone'), null);
eq('arrow on date added', peopleSortColumn('Date added'), { key: 'created', dir: 'desc' });
eq('record arrows follow the sorted list', inDrawnOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
eq('an archived row drops out', inDrawnOrder(['a', 'c'], ['c', 'b', 'a']), ['c', 'a']);
eq('a row the list never drew goes last', inDrawnOrder(['a', 'b', 'd'], ['b', 'a']), ['b', 'a', 'd']);
eq('nothing drawn yet: the list as it is', inDrawnOrder(['a', 'b'], []), ['a', 'b']);

if (failed) {
  console.error(failed + ' failed');
  process.exit(1);
}
console.log('ok');
