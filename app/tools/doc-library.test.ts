// Clozr Docs template library: versions, keys, diff, folders.  Run:  npx tsx tools/doc-library.test.ts
import assert from 'node:assert/strict';
import { baseKey, diffLines, diffStat, familyOf, folderAndBelow, folderTree, keyFor, latestByKey, nextVersion, saveMode, supersededKey, versionLabel } from '../supabase/functions/_shared/doc-library';

const WS = 7;
const sys = { id: 1, workspace_id: null, key: 'psa', name: 'PSA', version: 1, parent_id: null, sort: 10 };
const mine = { id: 20, workspace_id: WS, key: 'psa', name: 'PSA (ours)', version: 2, parent_id: 1, sort: 10 };
const old = { id: 15, workspace_id: WS, key: 'psa~v1', name: 'PSA old', version: 1, parent_id: null, superseded_at: '2026-01-01', sort: 10 };
const other = { id: 30, workspace_id: 99, key: 'psa', name: 'Theirs', version: 5, parent_id: 1, sort: 10 };
const offer = { id: 2, workspace_id: null, key: 'offer_letter', name: 'Offer', version: 1, parent_id: null, sort: 5 };

// Versioning decisions.
assert.equal(saveMode(sys, WS, 0), 'new_version', 'a built-in is never changed in place');
assert.equal(saveMode(mine, WS, 0), 'update', 'an unused workspace version is edited in place');
assert.equal(saveMode(mine, WS, 3), 'new_version', 'a used version is kept as signed');
assert.equal(saveMode({ ...mine, superseded_at: '2026-02-02' }, WS, 0), 'new_version', 'an old version is never edited');
assert.equal(saveMode(other, WS, 0), 'new_version');
assert.equal(familyOf(sys), 1);
assert.equal(familyOf(mine), 1);
assert.equal(nextVersion([sys, mine]), 3);
assert.equal(nextVersion([]), 1);
assert.equal(supersededKey('psa', 2), 'psa~v2');
assert.equal(supersededKey('psa~v1', 2), 'psa~v2');
assert.equal(baseKey('psa~v12'), 'psa');

// The list: current versions, workspace over built-in, other workspaces out.
assert.deepEqual(latestByKey([sys, mine, old, other, offer], WS).map((t) => t.id), [2, 20]);
assert.deepEqual(latestByKey([sys, offer], WS).map((t) => t.id), [2, 1]);
assert.deepEqual(latestByKey([sys, { ...mine, archived_at: '2026-03-03' }], WS).map((t) => t.id), [20], 'archived stays listed for the caller to hide');

assert.equal(keyFor('Cash Offer Letter', ['offer_letter']), 'cash_offer_letter');
assert.equal(keyFor('PSA', ['psa', 'psa~v2']), 'psa_2');
assert.equal(keyFor('!!!', []), 'template');
assert.equal(versionLabel(3, 12), 'v3 · used 12×');
assert.equal(versionLabel(null, 0), 'v1 · not used yet');

// Diff.
const d = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
assert.deepEqual(d.map((x) => `${x.op}:${x.text}`), ['same:a', 'del:b', 'add:B', 'same:c', 'same:d', 'add:e']);
assert.deepEqual(diffStat(d), { added: 2, removed: 1 });
assert.deepEqual(diffLines('same', 'same').map((x) => x.op), ['same']);
assert.deepEqual(diffLines('', 'x').map((x) => x.op), ['del', 'add']);
const d2 = diffLines('1\n2\n3', '1\n3');
assert.deepEqual(d2.filter((x) => x.op !== 'same').map((x) => [x.op, x.text, x.a]), [['del', '2', 2]]);

// Folders.
const folders = [
  { id: 1, name: 'Sellers', parent_id: null, sort: 0 },
  { id: 2, name: 'Buyers', parent_id: null, sort: 1 },
  { id: 3, name: 'Texas', parent_id: 1, sort: 0 },
  { id: 4, name: 'Orphan', parent_id: 404, sort: 0 },
  { id: 5, name: 'Deep', parent_id: 3, sort: 0 },
];
assert.deepEqual(folderTree(folders).map((f) => `${'-'.repeat(f.depth)}${f.name}`), ['Orphan', 'Sellers', '-Texas', '--Deep', 'Buyers']);
assert.equal(folderTree(folders).find((f) => f.id === 5)?.path, 'Sellers / Texas / Deep');
assert.deepEqual([...folderAndBelow(folders, 1)].sort(), [1, 3, 5]);
assert.deepEqual(folderTree([{ id: 1, name: 'Self', parent_id: 1 }]).map((f) => f.name), ['Self']);

console.log('doc-library ok');
