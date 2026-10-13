// Which record and which deal an email files under.  Run:  deno run supabase/functions/_shared/gmail-match.test.ts
import { type Book, type DealRef, addressesOf, conversationKey, emptyLink, fillable, linkFor, mergeLink, pickFromAi, refsOf, reroute, repFor, routeFor, streetKey, subjectNames, threadLink } from './gmail-match.ts';

let failed = 0;
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`);
  }
}

// ------------------------------------------------------------------ headers
eq('addresses: display names, a comma inside quotes, case', addressesOf('"Doe, Jane" <Jane@X.com>, b@y.org; Title Co <close@TitleCo.com>'), ['jane@x.com', 'b@y.org', 'close@titleco.com']);
eq('addresses: none', addressesOf('undisclosed-recipients:;'), []);
eq('refs: References then In-Reply-To, deduped', refsOf('<b@m>', '<a@m> <b@m>'), ['<a@m>', '<b@m>']);

// ------------------------------------------------------------------ streets
eq('street: suffix and direction folded', streetKey('123 N. Main Street, Apt 4'), '123 n main st');
eq('street: no house number is not a key', streetKey('Main Street'), null);
eq('street: a number alone is not a key', streetKey('4521'), null);
eq('subject: full street', subjectNames('RE: Title commitment - 123 North Main St', '123 n main st'), true);
eq('subject: street without its suffix', subjectNames('123 Main - closing Friday', '123 main st'), true);
eq('subject: another house number', subjectNames('1234 Main St', '123 main st'), false);
eq('subject: another street', subjectNames('123 Maple St', '123 main st'), false);

// ------------------------------------------------------------------ book
const deal = (id: number, seller: number | null, street: string | null, property = id * 10): DealRef => ({ id, property_id: property, seller_id: seller, street });
const d1 = deal(1, 100, '123 main st');
const d2 = deal(2, 100, '9 oak ave');           // the same seller's second property, older
const d3 = deal(3, 300, '55 elm dr');
const d4 = deal(4, 400, '77 pine rd');
const book: Book = {
  sellers: new Map([['sam@seller.com', 100], ['kim@seller.com', 300]]),
  buyers: new Map([['bo@buyer.com', 200]]),
  vendors: new Map([['close@titleco.com', 500]]),
  parties: new Map([['agent@realty.com', [3]], ['lender@bank.com', [3, 4]]]),
  dealsBySeller: new Map([[100, [d1, d2]], [300, [d3]], [400, [d4]]]),
  dealsByBuyer: new Map([[200, [d3]]]),
  dealsByVendor: new Map([[500, [d1, d3]]]),
  deals: new Map([[1, d1], [2, d2], [3, d3], [4, d4]]),
  ours: new Set(['rep@clozr.com', 'tc@clozr.com']),
};

eq('seller in To (a sent email): seller and their latest deal',
  linkFor(book, ['rep@clozr.com', 'sam@seller.com'], 'Our offer'),
  { seller_id: 100, buyer_id: null, vendor_id: null, deal_id: 1, property_id: 10 });
eq('seller only in Cc, mixed case',
  linkFor(book, ['rep@clozr.com', 'someone@else.com', 'SAM@Seller.com'], 'fyi'),
  { seller_id: 100, buyer_id: null, vendor_id: null, deal_id: 1, property_id: 10 });
eq('seller with two deals: the subject picks the older one',
  linkFor(book, ['sam@seller.com'], 'Re: 9 Oak Avenue walkthrough'),
  { seller_id: 100, buyer_id: null, vendor_id: null, deal_id: 2, property_id: 20 });
eq('title company on two deals, subject names one',
  linkFor(book, ['close@titleco.com'], 'Closing disclosure: 55 Elm Drive'),
  { seller_id: null, buyer_id: null, vendor_id: 500, deal_id: 3, property_id: 30 });
eq('title company on two deals, subject names neither: no guess',
  linkFor(book, ['close@titleco.com'], 'Wire instructions'),
  { seller_id: null, buyer_id: null, vendor_id: 500, deal_id: null, property_id: null });
eq('buyer on one deal',
  linkFor(book, ['bo@buyer.com'], 'EMD sent'),
  { seller_id: null, buyer_id: 200, vendor_id: null, deal_id: 3, property_id: 30 });
eq('deal party with no CRM row (listing agent)',
  linkFor(book, ['agent@realty.com'], 'Access'),
  { seller_id: null, buyer_id: null, vendor_id: null, deal_id: 3, property_id: 30 });
eq('party on two deals and no street: nothing',
  linkFor(book, ['lender@bank.com'], 'Appraisal'),
  { seller_id: null, buyer_id: null, vendor_id: null, deal_id: null, property_id: null });
eq('nobody known, the street in the subject: the deal and its seller',
  linkFor(book, ['escrow@unknown.com'], 'RE: 77 Pine Road - payoff'),
  { seller_id: 400, buyer_id: null, vendor_id: null, deal_id: 4, property_id: 40 });
eq('bulk mail naming the street alone is not filed',
  linkFor(book, ['alerts@portal.com'], 'Price change: 77 Pine Rd', true),
  emptyLink());
eq('our own addresses never match',
  linkFor({ ...book, sellers: new Map([['tc@clozr.com', 999]]) }, ['tc@clozr.com'], 'hi'),
  emptyLink());
const morganBook: Book = {
  ...book,
  buyers: new Map([['morgan3@deals.yourcompany.com', 9], ['bo@buyer.com', 200]]),
  ours: new Set(['rep@clozr.com', 'tc@clozr.com', 'morgan3@deals.yourcompany.com', 'morgan@yourcompany.com']),
  reps: new Map([['morgan3@deals.yourcompany.com', 'morgan'], ['morgan@yourcompany.com', 'morgan']]),
};
eq('a blast address is ours, so it is not the buyer',
  linkFor(morganBook, ['bo@buyer.com', 'morgan3@deals.yourcompany.com'], 'offer'),
  { seller_id: null, buyer_id: 200, vendor_id: null, deal_id: 3, property_id: 30 });
eq('inbound to a blast address credits that rep', repFor(morganBook, 'bo@buyer.com', ['morgan3@deals.yourcompany.com']), 'morgan');
eq('outbound from a blast address credits that rep', repFor(morganBook, 'morgan3@deals.yourcompany.com', ['bo@buyer.com']), 'morgan');
eq('a reply to the real inbox credits the same rep', repFor(morganBook, 'bo@buyer.com', ['morgan@yourcompany.com']), 'morgan');

// ------------------------------------------------------------------ threads
const sellerLink = linkFor(book, ['sam@seller.com'], 'x');
eq('thread lends its link to an unmatched reply', mergeLink(emptyLink(), threadLink([emptyLink(), sellerLink])), sellerLink);
eq('own match wins over the thread', mergeLink({ ...emptyLink(), buyer_id: 200, deal_id: 3, property_id: 30 }, sellerLink),
  { seller_id: 100, buyer_id: 200, vendor_id: null, deal_id: 3, property_id: 30 });
eq('no match in the thread: nothing to lend', threadLink([emptyLink(), emptyLink()]), null);
eq('thread deal comes from whichever message had one',
  threadLink([{ ...emptyLink(), vendor_id: 500 }, { ...emptyLink(), buyer_id: 200, deal_id: 3, property_id: 30 }]),
  { seller_id: null, buyer_id: null, vendor_id: 500, deal_id: 3, property_id: 30 });

// ------------------------------------------------------------------ relink
eq('fill only the gaps', fillable({ seller_id: 100, buyer_id: null, vendor_id: null, deal_id: null, property_id: null }, { seller_id: 7, buyer_id: 200, vendor_id: null, deal_id: 1, property_id: 10 }),
  { buyer_id: 200, deal_id: 1, property_id: 10 });
eq('nothing new', fillable({ seller_id: 100, deal_id: 1 }, sellerLink), {});

// ------------------------------------------------------------------ bodies and other deals
eq('seller with two deals: the body names the older one',
  linkFor(book, ['sam@seller.com'], 'Question', false, 'Hi, about the house at 9 Oak Ave, is Friday still ok?'),
  { seller_id: 100, buyer_id: null, vendor_id: null, deal_id: 2, property_id: 20 });
eq('title company on two deals, body names one',
  linkFor(book, ['close@titleco.com'], 'Wire instructions', false, 'Attached are the wire instructions for 55 Elm Dr.'),
  { seller_id: null, buyer_id: null, vendor_id: 500, deal_id: 3, property_id: 30 });
eq('title company on two deals, body names both: no guess',
  linkFor(book, ['close@titleco.com'], 'Wires', false, '123 Main St and 55 Elm Dr both fund Friday'),
  { seller_id: null, buyer_id: null, vendor_id: 500, deal_id: null, property_id: null });
eq('buyer on one deal asking about another by street files on that one',
  linkFor(book, ['bo@buyer.com'], 'Is 77 Pine Rd still available?'),
  { seller_id: null, buyer_id: 200, vendor_id: null, deal_id: 4, property_id: 40 });
eq('nobody known, the street only in the body',
  linkFor(book, ['escrow@unknown.com'], 'Payoff request', false, 'Please send the payoff for 77 Pine Road.'),
  { seller_id: 400, buyer_id: null, vendor_id: null, deal_id: 4, property_id: 40 });
eq('bulk mail naming the street in the body is not filed',
  linkFor(book, ['alerts@portal.com'], 'New listings', true, '77 Pine Rd just dropped its price'),
  emptyLink());
eq('why: a street', routeFor(book, ['close@titleco.com'], 'CD for 55 Elm Drive').why, 'street');
eq('why: the person', routeFor(book, ['bo@buyer.com'], 'EMD sent').why, 'person');
eq('ambiguous route hands its deals to the AI',
  routeFor(book, ['close@titleco.com'], 'Wire instructions').candidates.map((d) => d.id), [1, 3]);
eq('a placed route has no candidates', routeFor(book, ['bo@buyer.com'], 'EMD sent').candidates, []);

// ------------------------------------------------------------------ conversations
eq('conversation: inbound keys on the sender', conversationKey(book, 'Close@TitleCo.com', ['rep@clozr.com'], 'RE: Fwd: Wire instructions'), 'close@titleco.com|wire instructions');
eq('conversation: outbound keys on the first outside recipient', conversationKey(book, 'rep@clozr.com', ['tc@clozr.com', 'close@titleco.com'], 'Wire instructions'), 'close@titleco.com|wire instructions');
eq('conversation: a generic subject never joins', conversationKey(book, 'close@titleco.com', [], 'Re: Hi'), null);
eq('conversation: only our own people is not a conversation', conversationKey(book, 'rep@clozr.com', ['tc@clozr.com'], 'Wire instructions'), null);

// ------------------------------------------------------------------ reroute
const streetTo4 = routeFor(book, ['escrow@unknown.com'], 'RE: 77 Pine Road - payoff');
eq('reroute: a rule-filed row moves when a street now names another deal', reroute(book, { deal_id: 1, routed_by: 'rule' }, streetTo4), true);
eq('reroute: an AI-filed row moves the same way', reroute(book, { deal_id: 1, routed_by: 'ai' }, streetTo4), true);
eq('reroute: a hand-filed row never moves', reroute(book, { deal_id: 1, routed_by: 'manual' }, streetTo4), false);
eq('reroute: a row filed before routing was recorded never moves', reroute(book, { deal_id: 1, routed_by: null }, streetTo4), false);
eq('reroute: a person match does not move a filed row', reroute(book, { deal_id: 4, routed_by: 'rule' }, routeFor(book, ['bo@buyer.com'], 'EMD sent')), false);
eq('reroute: a row on a deal that is gone is unfiled', reroute(book, { deal_id: 99, routed_by: 'rule' }, routeFor(book, ['bo@buyer.com'], 'EMD sent')), true);
eq('reroute: already there', reroute(book, { deal_id: 4, routed_by: 'rule' }, streetTo4), false);

// ------------------------------------------------------------------ attachments and duplicate deals
{
  const sheet: DealRef = { id: 10, property_id: 1000, seller_id: null, street: '1206 harbor blvd', rank: 1 };
  const live: DealRef = { id: 11, property_id: 1001, seller_id: 88, street: '1206 harbor blvd', rank: 3 };
  const dup: Book = { ...book, deals: new Map([...book.deals, [10, sheet], [11, live]]) };
  eq('files: an attachment named for the street files the mail there',
    linkFor(dup, ['rep@clozr.com', 'bo@buyer.com'], 'frontside frontside', false, '', '1206 Harbor Blvd - AB Contract.pdf').deal_id, 11);
  eq('duplicates: two deals on one street, the one further along wins',
    linkFor(dup, ['escrow@unknown.com'], 'RE: 1206 Harbor Blvd title').deal_id, 11);
  eq('duplicates: two different streets named is still no guess',
    linkFor(dup, ['escrow@unknown.com'], '1206 Harbor Blvd and 77 Pine Rd').deal_id, null);
}

// ------------------------------------------------------------------ AI answer
eq('ai: a candidate id is kept', pickFromAi('{"deal_id": 3}', [d1, d3]), 3);
eq('ai: an id outside the candidates is dropped', pickFromAi('{"deal_id": 4}', [d1, d3]), null);
eq('ai: null is no deal', pickFromAi({ deal_id: null }, [d1, d3]), null);
eq('ai: garbage is no deal', pickFromAi('I think deal 3', [d1, d3]), null);

if (failed) { console.log(`${failed} failed`); Deno.exit(1); }
console.log('gmail-match: ok');
