// lib/link-views.ts: which texts carry a CLOZR tracked link, and what "Viewed" says.
// Run with:  npx tsx tools/link-views.test.ts
import { emailOpenLabel, firstView, readListingClaim, trackedLinks, viewLabel, viewStamp, viewTitle, type LinkView } from '../lib/link-views';
import { firstViewNotice } from '../supabase/functions/_shared/esign-session';

let failed = 0;
let passed = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''}`);
};

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
const listingToken = (c: object) => Buffer.from(JSON.stringify(c)).toString('base64url') + '.sigsigsig';

// ---- parsing ----
const sign = trackedLinks(`Kara, here is the offer: https://your-clozr-site.example.com/sign/?t=${TOKEN} No obligation.`);
check('a signing link is found', sign.length === 1 && sign[0]!.kind === 'sign' && sign[0]!.key === `sign:${TOKEN}`, sign);
check('without the trailing slash too', trackedLinks(`https://x.app/sign?t=${TOKEN}`).length === 1);
check('a token one character short is not a link', trackedLinks(`https://x.app/sign/?t=${TOKEN.slice(1)}`).length === 0);
check('a token too long is not a link', trackedLinks(`https://x.app/sign/?t=${TOKEN}f`).length === 0);
check('plain text has none', trackedLinks('Call me back when you can').length === 0);
check('null has none', trackedLinks(null).length === 0);
check('the same link twice counts once', trackedLinks(`/sign/?t=${TOKEN} and again /sign/?t=${TOKEN}`).length === 1);

const lt = listingToken({ w: 3, d: 41, b: 977 });
const listing = trackedLinks(`New deal for you: https://app.clozr.com/deal?s=1214-elm&t=${encodeURIComponent(lt)} reply YES`);
check('a buyer deal page link is found', listing.length === 1 && listing[0]!.kind === 'listing' && listing[0]!.key === 'listing:41:977', listing);
const fnLink = trackedLinks(`https://abc.supabase.co/functions/v1/listing/1214-elm?t=${lt}`);
check('the edge-function form of the deal link too', fnLink.length === 1 && fnLink[0]!.key === 'listing:41:977', fnLink);
check('a deal link without a token is not tracked', trackedLinks('https://app.clozr.com/deal?s=1214-elm').length === 0);
check('a junk token is not tracked', trackedLinks('https://app.clozr.com/deal?s=x&t=notbase64.sig').length === 0);
check('readListingClaim reads deal and buyer', JSON.stringify(readListingClaim(lt)) === JSON.stringify({ deal: 41, buyer: 977 }));
check('readListingClaim refuses a claim with no buyer', readListingClaim(listingToken({ w: 3, d: 41 })) === null);

// ---- labels ----
const now = Date.parse('2026-10-14T20:00:00Z');
const views = new Map<string, LinkView>([[`sign:${TOKEN}`, { firstAt: '2026-10-14T19:14:00Z', views: 3, seconds: 160 }]]);
check('no tracked link says nothing', viewLabel([], views, now) === null);
check('not opened yet', viewLabel(trackedLinks('/deal?s=a&t=' + lt), views, now) === 'Link not opened yet');
const label = viewLabel(sign, views, now) ?? '';
check('viewed with a time', /^Viewed \d{1,2}:\d{2} [AP]M · 3 times$/.test(label), label);
const once = new Map<string, LinkView>([[`sign:${TOKEN}`, { firstAt: '2026-10-14T19:14:00Z', views: 1 }]]);
check('viewed once does not count', !/times/.test(viewLabel(sign, once, now) ?? ''), viewLabel(sign, once, now));
check('yesterday reads Yesterday', viewStamp('2026-10-13T19:14:00Z', now).startsWith('Yesterday'), viewStamp('2026-10-13T19:14:00Z', now));
check('older reads the date', /^Oct \d+, /.test(viewStamp('2026-10-01T19:14:00Z', now)), viewStamp('2026-10-01T19:14:00Z', now));
check('a bad date reads empty', viewStamp('nope', now) === '');
const two = [...sign, ...listing];
const both = new Map<string, LinkView>([
  [`sign:${TOKEN}`, { firstAt: '2026-10-14T19:14:00Z', views: 2 }],
  ['listing:41:977', { firstAt: '2026-10-14T18:00:00Z', views: 1 }],
]);
const fv = firstView(two, both);
check('two links: the earliest open, views summed', fv?.firstAt === '2026-10-14T18:00:00Z' && fv?.views === 3, fv);
check('the tooltip names the signing link', /signing link/.test(viewTitle(sign, views)) && /3 times/.test(viewTitle(sign, views)) && /3 min/.test(viewTitle(sign, views)), viewTitle(sign, views));
check('the tooltip explains texts have no read receipts', /no read receipts/.test(viewTitle(sign, new Map())));

// ---- email receipts ----
check('an untracked email says nothing', emailOpenLabel(undefined, now) === null);
check('tracked, not opened', emailOpenLabel({ opens: 0, clicks: 0, first_opened_at: null }, now) === 'Not opened yet');
const opened = emailOpenLabel({ opens: 4, clicks: 1, first_opened_at: '2026-10-14T19:14:00Z' }, now) ?? '';
check('opened with time, opens and a click', /^Opened \d{1,2}:\d{2} [AP]M · 4 opens · 1 click$/.test(opened), opened);
check('opened once, no clicks', /^Opened \d{1,2}:\d{2} [AP]M$/.test(emailOpenLabel({ opens: 1, clicks: 0, first_opened_at: '2026-10-14T19:14:00Z' }, now) ?? ''));

// ---- the sender hears about the first open ----
const contract = { name: 'Cash offer: 1803 Cypress Lane', created_by: 'u-taylor' };
const notice = firstViewNotice(contract, { name: 'Kara Mitchell', role: 'seller' }, '2026-10-14T19:14:00Z');
check('the sender is told who opened what', notice?.user_id === 'u-taylor' && notice.title === 'Kara Mitchell opened Cash offer: 1803 Cypress Lane', notice);
check('the body says when, with no em dash', !!notice && /First opened Oct 14, 2026/.test(notice.body) && !notice.body.includes('—'), notice?.body);
check('no name: the party', !!firstViewNotice(contract, { role: 'seller' }, '2026-10-14T19:14:00Z')?.title.startsWith('Seller opened'));
check('a teammate’s own link is not news', firstViewNotice(contract, { name: 'Casey', user_id: 'u-casey' }, '2026-10-14T19:14:00Z') === null);
check('an approver or cc is not news', firstViewNotice(contract, { name: 'Sam', recipient_type: 'approver' }, 'x') === null && firstViewNotice(contract, { name: 'Title', recipient_type: 'cc' }, 'x') === null);
check('nobody sent it, nobody to tell', firstViewNotice({ name: 'X', created_by: null }, { name: 'Kara' }, 'x') === null);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
