// The @mention token in notes: parse, render, and the picker's caret query.
// Run with:  npx tsx tools/mentions.test.ts
import { deepStrictEqual as eq } from 'node:assert';
import { insertMention, mentionIds, mentionPlain, mentionQuery, mentionSegments, mentionTokens } from '../lib/mentions';

const u1 = '6f1c2d3e-0000-4000-8000-000000000001';
const u2 = '6f1c2d3e-0000-4000-8000-000000000002';
const body = `Hey @[Ann Lee](${u1}) and @[Bo Diaz](${u2}), seller wants Friday. cc @[Ann Lee](${u1})`;

eq(mentionIds(body), [u1, u2], 'distinct ids in order');
eq(mentionIds('no mentions, just an email a@b.co'), []);
eq(mentionPlain(body), 'Hey @Ann Lee and @Bo Diaz, seller wants Friday. cc @Ann Lee');
eq(mentionSegments(`@[Ann Lee](${u1}) call back`), [{ name: 'Ann Lee', id: u1 }, { text: ' call back' }]);
eq(mentionSegments('plain'), [{ text: 'plain' }]);
eq(mentionSegments(''), []);

eq(mentionQuery('Ping @an', 8), { start: 5, query: 'an' });
eq(mentionQuery('@', 1), { start: 0, query: '' });
eq(mentionQuery('email a@b', 9), null, 'an @ inside a word is not a mention');
eq(mentionQuery('line\n@bo', 8), { start: 5, query: 'bo' });
eq(mentionQuery(`@[Ann Lee](${u1}) x`, 3 + u1.length + 10), null, 'a finished token is not reopened');

const ins = insertMention('Ping @an today', 5, 8, 'Ann Lee', u1);
eq(ins.text, `Ping @[Ann Lee](${u1})  today`);
eq(ins.caret, 5 + `@[Ann Lee](${u1}) `.length);
eq(mentionIds(ins.text), [u1], 'an inserted token parses back');

// The note box shows "@Name" and stores tokens: longest name wins, emails are left alone, and it round-trips.
const roster = [{ id: 'w1', name: 'Casey Park' }, { id: 'w2', name: 'Casey' }, { id: 't1', name: 'Sam Rivera' }];
const shown = '@Casey Park send the amendment, cc @Sam Rivera and @Casey. a@b.com';
const stored = mentionTokens(shown, roster);
eq(stored, '@[Casey Park](w1) send the amendment, cc @[Sam Rivera](t1) and @[Casey](w2). a@b.com');
eq(mentionPlain(stored), shown);
eq(mentionTokens(mentionPlain(stored), roster), stored);
eq(mentionTokens('no one here', roster), 'no one here');

console.log('all mention checks passed');
