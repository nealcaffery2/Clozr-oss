// lib/nav-hash.ts: the address codec and the Back decision.
// Run with:  npx tsx tools/nav-hash.test.ts
import { backAction, decodeNavHash, encodeNavHash, formatFrom, parseFrom, safeNext, sameRef } from '../lib/nav-hash';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

// ---- from ----
check('formatFrom screen', formatFrom({ screen: 'deals', id: null }) === 'deals');
check('formatFrom record', formatFrom({ screen: 'person', id: 's42' }) === 'person:s42');
check('formatFrom junk screen', formatFrom({ screen: 'a b', id: null }) === null);
check('formatFrom drops a junk id', formatFrom({ screen: 'person', id: 'x"><' }) === 'person');
check('parseFrom record', sameRef(parseFrom('person:s42'), { screen: 'person', id: 's42' }));
check('parseFrom screen', sameRef(parseFrom('deals'), { screen: 'deals', id: null }));
check('parseFrom empty', parseFrom('') === null && parseFrom(null) === null);
check('parseFrom junk', parseFrom('javascript:alert(1)') === null && parseFrom('a b:1') === null);

check('formatFrom with a deal', formatFrom({ screen: 'tc', id: 's42', deal: 'd9' }) === 'tc:s42:d9');
check('formatFrom a seller-less deal sheet', formatFrom({ screen: 'dealSheet', id: null, deal: 'd9' }) === 'dealSheet::d9');
const pd = parseFrom('tc:s42:d9');
check('parseFrom with a deal', !!pd && pd.screen === 'tc' && pd.id === 's42' && pd.deal === 'd9', pd);
const ps = parseFrom('dealSheet::d9');
check('parseFrom a seller-less deal sheet', !!ps && ps.id === null && ps.deal === 'd9', ps);
check('parseFrom too many parts', parseFrom('a:b:c:d') === null);
check('a different deal is a different place', !sameRef({ screen: 'tc', id: 's1', deal: 'd1' }, { screen: 'tc', id: 's1', deal: 'd2' }));

// ---- codec ----
check('home is bare', encodeNavHash({ screen: 'home', id: null, deal: null, from: null }) === '');
check('home not bare when asked', encodeNavHash({ screen: 'home', id: null, deal: null, from: null }, false) === '#screen=home');
check('person with from', encodeNavHash({ screen: 'person', id: 's42', deal: null, from: 'deals' }) === '#screen=person&id=s42&from=deals');
check('deal sheet from a seller', encodeNavHash({ screen: 'dealSheet', id: 's42', deal: 'd7', from: 'person:s42' }) === '#screen=dealSheet&id=s42&deal=d7&from=person%3As42');
check('top-level screens drop from', encodeNavHash({ screen: 'deals', id: null, deal: null, from: 'home' }) === '#screen=deals');
check('a junk from is dropped', encodeNavHash({ screen: 'person', id: 's1', deal: null, from: 'x y' }) === '#screen=person&id=s1');
const round = decodeNavHash(encodeNavHash({ screen: 'tc', id: 's9', deal: 'd3', from: 'dispoProperty:s9' }));
check('round trip', !!round && round.screen === 'tc' && round.id === 's9' && round.deal === 'd3' && round.from === 'dispoProperty:s9', round);
check('decode without screen', decodeNavHash('#id=s1') === null);
check('decode old addresses (no from)', decodeNavHash('#screen=person&id=s42')?.from === null);
check('decode ignores from on a top-level screen', decodeNavHash('#screen=deals&from=home')?.from === null);
check('decode drops a junk from', decodeNavHash('#screen=person&id=s1&from=%3Cscript%3E')?.from === null);

// ---- back ----
const deals = { screen: 'deals', id: null };
const seller = { screen: 'person', id: 's42' };
const people = { screen: 'people', id: null };
check('previous entry is from: history back', backAction(seller, seller, people).kind === 'history');
const r1 = backAction(seller, deals, people);
check('previous entry differs: replace to from', r1.kind === 'replace' && sameRef(r1.to, seller), r1);
const r2 = backAction(null, deals, people);
check('no from: replace to fallback', r2.kind === 'replace' && sameRef(r2.to, people), r2);
const r3 = backAction(seller, null, people);
check('no previous entry (fresh tab): replace to from', r3.kind === 'replace' && sameRef(r3.to, seller), r3);
check('same screen, other record is not a match', backAction(seller, { screen: 'person', id: 's43' }, people).kind === 'replace');

// ---- login ?next= ----
check('next: app with a hash', safeNext('/app#screen=person&id=s42') === '/app#screen=person&id=s42');
check('next: app with a query', safeNext('/app?google=ok') === '/app?google=ok');
check('next: empty', safeNext(null) === '/app' && safeNext('') === '/app');
check('next: another site', safeNext('https://evil.example/app') === '/app');
check('next: protocol-relative', safeNext('//evil.example/app') === '/app');
check('next: backslash trick', safeNext('/\\evil.example') === '/app');
check('next: not under /app', safeNext('/login') === '/app' && safeNext('/apple') === '/app');
check('next: dot segments out of /app', safeNext('/app/../login') === '/app');
check('next: javascript', safeNext('javascript:alert(1)') === '/app');
check('next: control characters', safeNext('/app\n') === '/app');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
