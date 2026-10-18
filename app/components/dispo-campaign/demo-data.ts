// Sample data for the Marketing tab on /demo: the buyers matched to d6,
// 2207 Willow Street, the workspace's dispo templates, and one past campaign's
// results. Nothing here reaches Supabase or Talkr — the demo reads these rows
// in place of loadCampaignData / loadResults / getPublicLink, and every write
// on the tab ends in a toast instead.
//
// The past campaign is the funnel the Overview tab already shows (243 sent,
// 236 delivered, 67 clicked, 21 replied, 4 offers), so the two tabs agree.
// The new campaign's audience is the 64 buyers matched since that send.

import { CLOZR_DATA } from '@/lib/clozr-data';
import type { CampaignBuyer, CampaignData, CampaignResults, MatchLite } from '@/lib/dispo-campaign';
import type { DealPublicLink, DispoCampaignRow, DispoMessageRow, DispoRecipientRow } from '@/lib/database.types';
import type { LinkMap } from '@/lib/dispo';
import type { ResendStatus } from '@/lib/deliverability';
import type { MeDto } from '@/lib/talkr';
import { type ClosedDealRow, milesBetween } from '@/supabase/functions/_shared/dispo-rules';
import { SAMPLE_EMAIL_HTML, SAMPLE_EMAIL_SUBJECT, SAMPLE_EMAIL_TEXT } from './sample-email';

export const DEMO_WORKSPACE_ID = 0;
export const DEMO_DEAL_ID = 6;
const DEMO_CAMPAIGN_ID = 41;
const SLUG = 'willow-st-7k2q';
const DAY = 86_400_000;

/** Deterministic, so the demo reads the same on every load. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Marcus', 'Elena', 'Darnell', 'Priya', 'Tom', 'Keisha', 'Luis', 'Hannah', 'Andre', 'Mei', 'Victor', 'Rosa', 'Jamal', 'Claire', 'Omar', 'Tessa',
  'Brandon', 'Yolanda', 'Grant', 'Nadia', 'Derek', 'Paula', 'Reggie', 'Sofia', 'Wes', 'Imani', 'Cody', 'Lena', 'Hector', 'Brooke', 'Ty', 'Gloria', 'Ray', 'Monica'];
const LAST = ['Alvarez', 'Brooks', 'Chen', 'Dawson', 'Ellis', 'Fuentes', 'Grant', 'Hughes', 'Ibarra', 'Jensen', 'Kaur', 'Lawson', 'Moreno', 'Nguyen', 'Owens',
  'Patel', 'Quinn', 'Ramos', 'Sutton', 'Tran', 'Underwood', 'Vasquez', 'Walker', 'Young', 'Zamora', 'Holt', 'Pierce', 'Mendez', 'Carter', 'Boone'];
const CO_A = ['Trinity', 'Oak Cliff', 'Bishop Arts', 'Lakewood', 'Cedar Crest', 'Elm Fork', 'Red Bird', 'Kessler', 'Lone Star', 'Mockingbird', 'Pleasant Grove',
  'Casa View', 'Wynnewood', 'Kiest', 'Hampton', 'Singing Hills', 'Westmoreland', 'Glen Oaks'];
const CO_B = ['Holdings', 'Home Buyers', 'Properties', 'Rentals', 'Renovations', 'Capital', 'Investments', 'Realty Group', 'Homes'];
const STREETS = ['W Illinois Ave', 'S Hampton Rd', 'Wright St', 'Pierce St', 'N Edgefield Ave', 'W Jefferson Blvd', 'Kessler Pkwy', 'S Polk St', 'Garrett Ave',
  'W Davis St', 'Clarendon Dr', 'S Morgan St', 'Granger St', 'Plymouth Rd', 'W 10th St', 'Nomas St', 'Bickers St', 'Canada Dr'];
const DEAL = { lat: 32.7349, lng: -96.8981 };

type Gen = { b: CampaignBuyer; match: MatchLite | null; history: MatchLite[]; closed: ClosedDealRow[]; offers: CampaignData['offers'] };

/** The sample graph's buyers (b1–b7) as campaign rows, keeping their names, numbers and buy boxes. */
function namedBuyers(): CampaignBuyer[] {
  const strat: Record<string, string[]> = { Rental: ['buy_and_hold'], Flip: ['fix_and_flip'], BRRRR: ['brrrr'] };
  return CLOZR_DATA.buyers.map((b, i) => ({
    id: i + 1, name: b.name, company: b.company, phone: b.phone, email: b.email, status: /inactive/i.test(b.status) ? 'Inactive' : 'Active',
    vip: b.status === 'VIP', vetted: b.stars >= 4, blacklisted: false,
    preferredChannel: b.pref === 'Email' ? 'email_only' : 'email_and_sms', wantsFollowUps: true,
    tags: [], markets: b.markets, strategies: strat[b.strategy] ?? [], priceMin: null, priceMax: null, cities: [], zips: [],
    buyerType: b.type, notes: null, source: 'import', lastActivityAt: null,
  }));
}

function build(now: Date) {
  const r = rng(2207);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const iso = (t: number) => new Date(t).toISOString();
  const sentAt = campaignStart(now);
  const gens: Gen[] = [];
  let nextId = 101;
  let dealSeq = 900;

  const person = (i: number) => `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + 3) % LAST.length]}`;
  const company = () => `${pick(CO_A)} ${pick(CO_B)}`;
  const phone = (id: number) => `+1214555${String(1000 + (id * 37) % 9000).padStart(4, '0')}`;
  const purchase = (buyerId: number, daysAgo: number, miles: number): ClosedDealRow => {
    const ang = r() * Math.PI * 2;
    return {
      buyer_id: buyerId, line1: `${100 + Math.floor(r() * 3800)} ${pick(STREETS)}`, city: 'Dallas', zip: pick(['75211', '75208', '75224', '75212']),
      lat: DEAL.lat + (miles / 69) * Math.sin(ang), lng: DEAL.lng + (miles / 57.5) * Math.cos(ang), sqft: 1500 + Math.floor(r() * 700),
      closed_on: iso(now.getTime() - daysAgo * DAY).slice(0, 10),
    };
  };
  const history = (buyerId: number, sent: number, replied: number): MatchLite[] => Array.from({ length: sent }, (_, j) => ({
    deal_id: dealSeq++, buyer_id: buyerId, score: 60 + Math.floor(r() * 30), reasons: [], status: j < replied ? 'replied' : 'sent',
    sent_at: iso(now.getTime() - (20 + j * 17) * DAY), replied_at: j < replied ? iso(now.getTime() - (20 + j * 17) * DAY + 3600_000) : null, updated_at: iso(now.getTime() - 5 * DAY),
  }));
  const base = (id: number, p: Partial<CampaignBuyer>): CampaignBuyer => ({
    id, name: person(id), company: company(), phone: phone(id), email: `${person(id).split(' ')[0].toLowerCase()}@${pick(CO_A).toLowerCase().replace(/\s+/g, '')}homes.com`,
    status: 'Active', vip: false, vetted: r() < 0.4, blacklisted: false, preferredChannel: 'email_and_sms', wantsFollowUps: true, tags: [], markets: ['DFW'],
    strategies: [r() < 0.55 ? 'fix_and_flip' : 'buy_and_hold'], priceMin: 90000, priceMax: 260000 + Math.floor(r() * 12) * 10000, cities: ['Dallas'], zips: [],
    buyerType: null, notes: null, source: 'import', lastActivityAt: iso(now.getTime() - Math.floor(r() * 40) * DAY), ...p,
  });
  const reasons = (score: number) => [
    'Buys Dallas', score >= 80 ? 'Heavy rehab OK' : 'Rehab within range', 'Price fits buy box', score >= 85 ? 'Bought within 2 mi' : 'SFR',
  ];
  const match = (buyerId: number, score: number, sent: boolean): MatchLite => ({
    deal_id: DEMO_DEAL_ID, buyer_id: buyerId, score, reasons: reasons(score), status: sent ? 'sent' : 'matched',
    sent_at: sent ? iso(sentAt) : null, replied_at: null, updated_at: iso(now.getTime() - 2 * 3600_000),
  });

  // ---- already sent: the sample graph's buyers (bar b5 and b6, who buy San Antonio) and 238 more.
  const named = namedBuyers();
  const namedScore = [96, 91, 86, 96, 0, 0, 78];
  named.forEach((b, i) => {
    const sent = namedScore[i] > 0;
    gens.push({
      b, match: sent ? match(b.id, namedScore[i], true) : null, history: history(b.id, [7, 7, 7, 5, 4, 3, 7][i], [5, 4, 5, 2, 2, 1, 4][i]),
      closed: i < 4 || i === 6 ? [purchase(b.id, 40 + i * 25, 0.8 + i * 1.3)] : [], offers: [],
    });
  });
  for (let i = 0; i < 238; i++) {
    const id = nextId++;
    const score = 58 + Math.floor(r() * 38);
    const quirks: Partial<CampaignBuyer> = i % 19 === 5 ? { email: null } : i % 23 === 7 ? { phone: null } : i % 31 === 4 ? { preferredChannel: 'email_only' } : {};
    gens.push({
      b: base(id, quirks),
      match: match(id, score, true), history: history(id, Math.floor(r() * 6), Math.floor(r() * 2)),
      closed: r() < 0.5 ? [purchase(id, 30 + Math.floor(r() * 300), 0.4 + r() * 9)] : [], offers: [],
    });
  }

  // ---- new since that send: 64 buyers, the audience of a new campaign. The
  // first few are written out so the preview has someone real to show.
  const featured: [Partial<CampaignBuyer>, number, number, number, number][] = [
    // buyer, score, deals sent, replied, closed-with-us days ago (0 = none)
    [{ name: 'Marisol Vega', company: 'Oak Cliff Renovations', vip: true, vetted: true, strategies: ['fix_and_flip'] }, 94, 6, 4, 64],
    [{ name: 'Devon Price', company: 'Trinity Groves Capital', vetted: true, strategies: ['buy_and_hold'] }, 92, 5, 3, 120],
    [{ name: 'Alicia Warren', company: 'Kessler Park Homes', strategies: ['fix_and_flip'] }, 90, 4, 2, 0],
    [{ name: 'Sam Okafor', company: null, strategies: ['brrrr'] }, 88, 3, 1, 210],
    [{ name: 'Ruth Delgado', company: 'Red Bird Rentals', strategies: ['buy_and_hold'] }, 87, 2, 0, 0],
  ];
  for (let i = 0; i < 64; i++) {
    const id = nextId++;
    const f = featured[i];
    const quirks: Partial<CampaignBuyer> =
      i === 10 || i === 27 ? { tags: ['DNC'] }
        : i === 33 ? { blacklisted: true }
          : i === 14 || i === 22 || i === 41 || i === 50 ? { phone: null }
            : i === 18 || i === 45 ? { email: null }
              : i === 57 ? { phone: null, email: null }
                : i === 30 ? { preferredChannel: 'email_only' }
                  : i === 36 || i === 48 || i === 60 ? { wantsFollowUps: false }
                    : {};
    const score = f ? f[1] : 58 + Math.floor(r() * 30);
    const closed = f ? (f[4] ? [purchase(id, f[4], 0.6 + i * 0.7)] : [purchase(id, 45 + i * 20, 2 + i)]) : r() < 0.6 ? [purchase(id, 20 + Math.floor(r() * 400), 0.3 + r() * 12)] : [];
    const hist = f ? history(id, f[2], f[3]) : history(id, Math.floor(r() * 4), Math.floor(r() * 2));
    gens.push({
      b: base(id, { ...(f ? f[0] : {}), ...quirks }),
      match: match(id, score, false), history: hist, closed,
      offers: f && f[3] >= 3 ? [{ buyer_id: id, deal_id: hist[0].deal_id, amount: 180000, sent_at: hist[0].sent_at as string }] : [],
    });
  }
  // A closed-with-us deal is what makes the first two buyers Closers (L5).
  gens.filter((g) => g.b.name === 'Marisol Vega' || g.b.name === 'Devon Price').forEach((g) => { g.closed.push({ ...g.closed[0], line1: `${1200 + g.b.id} Wright St`, closed_on: iso(now.getTime() - 200 * DAY).slice(0, 10) }); });

  // ---- everyone else: scored below the bar, or not matched to this deal at all.
  for (let i = 0; i < 40; i++) {
    const id = nextId++;
    gens.push({
      b: base(id, { markets: i % 3 ? ['DFW'] : ['Fort Worth'], cities: i % 3 ? ['Dallas'] : ['Fort Worth'] }),
      match: i < 25 ? { ...match(id, 30 + Math.floor(r() * 24), false), reasons: ['Buys DFW', 'Price above ceiling'] } : null,
      history: history(id, Math.floor(r() * 3), 0), closed: r() < 0.3 ? [purchase(id, 90 + Math.floor(r() * 300), 8 + r() * 20)] : [], offers: [],
    });
  }
  return { gens, sentAt };
}

/** The last campaign went out yesterday at 9:00 AM Central. */
function campaignStart(now: Date): number {
  const d = new Date(now.getTime() - DAY);
  const noonUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 14, 0, 0); // 9:00 CDT
  return noonUtc;
}

const TEMPLATES: CampaignData['templates'] = [
  {
    id: 11, name: 'Dispo · New deal text', channel: 'sms', category: 'dispo', subject: null, body_html: null,
    body_text: 'New off-market in {{city}}: {{address}}, {{beds}}/{{baths}}, {{sqft}} sf. {{price}}, ARV {{arv}}. {{purchase_note}} Photos + numbers: {{listing_url}} Reply YES for a walkthrough.',
  },
  {
    id: 12, name: 'Intro · last purchase nearby', channel: 'sms', category: 'dispo-intro', subject: null, body_html: null,
    body_text: "Hey {{first_name}} - it's {{rep_first_name}} with Acme Homes. {{purchase_note}} I've got a {{property_type}} in {{city}} that fits what you buy. Want the numbers?",
  },
  {
    id: 13, name: 'Intro · flip follow-on', channel: 'sms', category: 'dispo-intro', subject: null, body_html: null,
    body_text: "Hey {{first_name}} - {{rep_first_name}} here. Saw you wrapped up {{last_purchase_address}} about {{last_purchase_ago}} ago. I've got a {{property_type}} {{deal_distance}} from it. Interested?",
  },
  { id: 21, name: 'Dispo blast · Acme Homes deal', channel: 'email', category: 'dispo-blast', subject: SAMPLE_EMAIL_SUBJECT, body_text: SAMPLE_EMAIL_TEXT, body_html: SAMPLE_EMAIL_HTML },
  {
    id: 22, name: 'New deal email (plain)', channel: 'email', category: 'dispo', subject: 'New deal: {{address}} · {{price}}', body_html: null,
    body_text: 'Hi {{first_name}},\n\nWe just got {{address}}, {{city}} under contract at {{price}} ({{beds}} bd / {{baths}} ba). {{purchase_note}}\n\nPhotos and numbers: {{listing_url}}\n\nReply if you want a walkthrough.',
  },
  { id: 31, name: 'Follow-up · still available', channel: 'sms', category: 'dispo-followup', subject: null, body_html: null, body_text: 'Hi {{first_name}}, {{address}} is still open at {{price}}. Want to walk it this week?' },
  { id: 32, name: 'Follow-up · offers due', channel: 'sms', category: 'dispo-followup', subject: null, body_html: null, body_text: '{{first_name}} - taking offers on {{address}} through Friday. Want the numbers?' },
  { id: 33, name: 'Follow-up email', channel: 'email', category: 'dispo-followup', subject: 'Following up: {{address}}', body_html: null, body_text: 'Hi {{first_name}},\n\nChecking in on {{address}} in {{city}}. Photos and numbers are here: {{listing_url}}\n\nHappy to set up a walkthrough.' },
];

const PHOTOS: CampaignData['photos'] = [
  { id: 1, name: 'Front', url: CLOZR_DATA.IMG.f },
  { id: 2, name: 'Kitchen', url: CLOZR_DATA.IMG.kitchen },
  { id: 3, name: 'Bath', url: CLOZR_DATA.IMG.bath },
  { id: 4, name: 'Living', url: CLOZR_DATA.IMG.living },
];

export type DemoMarketing = {
  data: CampaignData;
  results: CampaignResults;
  /** Buyers who opened their tracked link (the Overview's "Clicked"). */
  viewed: number;
  links: LinkMap;
  talkrMe: MeDto;
  resend: ResendStatus;
  page: DealPublicLink;
  pageUrl: string;
  names: Map<number, { name: string; company: string | null; phone: string | null }>;
  /** Free-agent realtors who work Dallas, for the Realtors segment. */
  realtors?: CampaignBuyer[];
};

// Agents who work Dallas: the free-agent list a push can add as a segment.
const REALTORS: CampaignBuyer[] = [
  ['Alicia Ramos', 'Oak Cliff Realty Group'], ['Ben Whitfield', 'Keller Williams Dallas'], ['Carla Nguyen', 'Compass Dallas'],
  ['Derek Olsen', 'eXp Realty'], ['Erin Castillo', 'Ebby Halliday'], ['Frank Mbeki', null], ['Gina Patel', 'Redfin Dallas'], ['Hector Lane', 'Coldwell Banker'],
].map(([name, company], i) => ({
  id: 90001 + i, name: name as string, company, phone: i === 5 ? null : `+1469555${String(2100 + i * 13).padStart(4, '0')}`,
  email: `${(name as string).split(' ')[0].toLowerCase()}@${company ? (company as string).split(' ')[0].toLowerCase() : 'agent'}realty.com`,
  status: 'active', vip: false, vetted: false, blacklisted: false, preferredChannel: 'email_and_sms', wantsFollowUps: true, tags: ['realtors'],
  markets: ['Dallas, TX'], strategies: [], priceMin: null, priceMax: null, cities: ['Dallas'], zips: [], buyerType: 'realtors', notes: null,
  source: 'dispogenius-free-agents', lastActivityAt: null,
}));

let cache: DemoMarketing | null = null;

/** The whole demo, built once per page load. `listingBase` is lib/dispo's listingUrl(slug). */
export function demoMarketing(listingBase: (slug: string) => string, now = new Date()): DemoMarketing {
  if (cache) return cache;
  const { gens, sentAt } = build(now);
  const iso = (t: number) => new Date(t).toISOString();
  const buyers = gens.map((g) => g.b);
  const matches = gens.flatMap((g) => [...(g.match ? [g.match] : []), ...g.history]);
  // Deals closed with us make a Closer (L5); everything else a buyer bought is
  // what a Genius run for this deal saw, measured against it.
  const CLOSERS = new Set(['Marisol Vega', 'Devon Price', 'Chris Anderson', 'Dana Ortiz']);
  const closed = gens.filter((g) => CLOSERS.has(g.b.name)).flatMap((g) => g.closed);
  const candidates = gens.filter((g) => !CLOSERS.has(g.b.name) && g.closed.length).map((g) => ({
    matched_buyer_id: g.b.id, owner_name: g.b.name, kind: g.b.strategies.includes('fix_and_flip') ? 'flipper' : 'landlord',
    purchases: g.closed.map((c) => ({
      address: c.line1 as string, city: c.city ?? undefined, zip: c.zip ?? undefined, date: c.closed_on, sqft: c.sqft,
      distance_mi: Number(milesBetween({ lat: c.lat as number, lng: c.lng as number }, DEAL).toFixed(1)),
    })),
  }));
  const offers = [
    ...gens.flatMap((g) => g.offers),
    // The four offers on the Offer desk (b1, b2, b3, b7).
    ...[[1, 238500], [2, 241000], [3, 235750], [7, 233000]].map(([b, amount], i) => ({ buyer_id: b, deal_id: DEMO_DEAL_ID, amount, sent_at: iso(sentAt + (5 + i * 3) * 3600_000) })),
  ];
  const data: CampaignData = {
    deal: {
      id: DEMO_DEAL_ID, sellerId: null, price: 236000, updatedAt: iso(now.getTime() - 3 * DAY),
      address: '2207 Willow Street', city: 'Dallas', zip: '75211', lat: DEAL.lat, lng: DEAL.lng, sqft: 1850, beds: 3, baths: 2, propertyType: 'single_family',
    },
    buyers, matches, offers, closed, runs: [{ deal_id: DEMO_DEAL_ID, candidates }], inbound: [], photos: PHOTOS, templates: TEMPLATES,
    gmail: [{ id: 1, email: 'morgan@yourcompany.com', user_id: 'demo' }],
  };

  // ---- the past campaign: every buyer with this deal sent, and what came back.
  const sent = gens.filter((g) => g.match?.sent_at);
  const campaign: DispoCampaignRow = {
    id: DEMO_CAMPAIGN_ID, workspace_id: DEMO_WORKSPACE_ID, deal_id: DEMO_DEAL_ID, created_by: 'demo', status: 'running', settings: {}, timezone: 'America/Chicago',
    from_phone_number_id: 'n1', from_phone: '+12145550188', email_account_id: null, from_name: 'Morgan', email_provider: 'resend', email_sender_id: 1,
    starts_at: iso(sentAt), created_at: iso(sentAt - 4 * 60_000), updated_at: iso(now.getTime() - 3600_000),
  };
  const recipients: DispoRecipientRow[] = [];
  const messages: CampaignResults['messages'] = [];
  // Who answered: the four offers, ten more interested, three passes, four plain replies.
  const offered = new Set([1, 2, 3, 7]);
  const others = sent.filter((g) => !offered.has(g.b.id) && g.b.phone);
  const interested = new Set(others.slice(3, 13).map((g) => g.b.id));
  const passed = new Set(others.slice(20, 23).map((g) => g.b.id));
  const replied = new Set(others.slice(40, 44).map((g) => g.b.id));
  const optedOut = new Set(others.slice(60, 62).map((g) => g.b.id));
  // Four texts that never landed (landlines) whose email is not confirmed either, and three email-only buyers whose mail is unconfirmed.
  const failed = new Set(others.filter((g) => g.b.email && g.b.preferredChannel !== 'email_only').slice(100, 104).map((g) => g.b.id));
  let mid = 1;
  let unconfirmedLeft = 3;
  sent.forEach((g, i) => {
    const b = g.b;
    const rid = 5000 + i;
    const replyAt = sentAt + (1 + (i % 9)) * 1800_000;
    const status: DispoRecipientRow['status'] = offered.has(b.id) ? 'offered' : interested.has(b.id) ? 'interested' : passed.has(b.id) ? 'not_interested'
      : replied.has(b.id) ? 'replied' : optedOut.has(b.id) ? 'opted_out' : 'active';
    const answered = status !== 'active' && status !== 'opted_out';
    recipients.push({
      id: rid, workspace_id: DEMO_WORKSPACE_ID, campaign_id: DEMO_CAMPAIGN_ID, deal_id: DEMO_DEAL_ID, buyer_id: b.id, phone: b.phone, email: b.email,
      level: null, probability: null, status, talkr_conversation_id: null,
      replied_at: answered ? iso(replyAt) : null, replied_channel: answered ? (b.id === 4 || i % 7 === 3 ? 'email' : 'sms') : null,
      offered_at: status === 'offered' ? iso(replyAt + 2 * 3600_000) : null, checked_at: null, created_at: campaign.created_at, updated_at: campaign.updated_at,
    });
    const msg = (channel: 'sms' | 'email', kind: DispoMessageRow['kind'], at: number, st: DispoMessageRow['status'], body: string, err: string | null = null) => messages.push({
      id: mid++, campaign_id: DEMO_CAMPAIGN_ID, recipient_id: rid, buyer_id: b.id, channel, kind, status: st,
      send_at: iso(at), sent_at: st === 'sent' || st === 'delivered' ? iso(at + 20_000) : null, last_error: err, body, media_urls: [],
    });
    const t0 = sentAt + i * 75_000;
    const textable = !!b.phone && b.preferredChannel !== 'email_only';
    if (textable) {
      const bad = failed.has(b.id);
      msg('sms', 'intro', t0, bad ? 'failed' : 'delivered', `Hey ${b.name.split(' ')[0]} - it's Morgan with Acme Homes. Got a 3/2 in Dallas that fits what you buy. Want the numbers?`, bad ? 'Landline: cannot receive texts' : null);
      if (!bad) msg('sms', 'brief', t0 + 5 * 60_000, 'delivered', 'New off-market in Dallas: 2207 Willow Street, 3/2, 1,850 sf. $236,000, ARV $345,000.');
    }
    // Resend reports delivery; three email-only buyers' mail is still unconfirmed.
    const unconfirmed = failed.has(b.id) || (!textable && unconfirmedLeft-- > 0);
    if (b.email) msg('email', 'brief', t0 + 65 * 60_000, unconfirmed ? 'sent' : 'delivered', 'Off-market: 2207 Willow Street, Dallas · $236,000');
    if (status === 'active' && textable && !failed.has(b.id)) msg('sms', 'followup', t0 + 125 * 60_000, 'delivered', 'Hi, 2207 Willow Street is still open at $236,000. Want to walk it this week?');
    if (status === 'active' && b.email) msg('email', 'followup', t0 + 24 * 3600_000 + 125 * 60_000, 'queued', 'Following up: 2207 Willow Street');
  });

  const links: LinkMap = Object.fromEntries(buyers.map((b) => [String(b.id), `${listingBase(SLUG)}${listingBase(SLUG).includes('?') ? '&' : '?'}b=${(b.id * 7919).toString(36)}`]));
  const page: DealPublicLink = {
    id: 1, workspace_id: DEMO_WORKSPACE_ID, deal_id: DEMO_DEAL_ID, slug: SLUG, active: true, show_viewers: false, show_address: false, allow_offers: true, on_marketplace: true,
    headline: '2207 Willow Street · 3/2 value-add in Oak Cliff',
    description: 'Vacant 1972 brick ranch on a 0.22 ac lot with alley access. Original kitchen and baths, roof at end of life. Closes Sept 22.',
    expires_at: null, view_count: 412, unique_viewers: 67, created_at: iso(sentAt - DAY), updated_at: iso(sentAt),
  };
  cache = {
    data,
    results: { campaigns: [campaign], recipients, messages, offers: 4 },
    viewed: 67,
    links,
    talkrMe: {
      id: 'demo', display_name: 'Morgan Lane', email: 'morgan@yourcompany.com', role: 'agent', timezone: 'America/Chicago', city: 'Dallas', org: { id: 'o', name: 'Acme Homes', slug: 'acme-homes' },
      numbers: [{ id: 'n1', phone_e164: '+12145550188', label: 'Dispo line' }],
      org_numbers: [
        { id: 'n1', phone_e164: '+12145550188', label: 'Dispo line', area_code: '214', assigned_user_id: 'demo' },
        { id: 'n2', phone_e164: '+14695550122', label: 'Dispo overflow', area_code: '469', assigned_user_id: null },
      ],
      default_phone_number_id: 'n1', caller_id_mode: 'dedicated',
    },
    resend: {
      configured: true, from: 'Acme Homes <deals@deals.yourcompany.com>', email: 'deals@deals.yourcompany.com', domain: 'deals.yourcompany.com',
      own_key: false, own_from: null, key_source: 'project', webhook_url: '', webhook_secret_set: true,
      sender: {
        id: 1, from_email: 'deals@deals.yourcompany.com', from_name: 'Acme Homes', domain: 'deals.yourcompany.com', active: true,
        settings: {
          daily_cap: 500, hourly_cap: 120, min_gap_seconds: 4, window_start: 8, window_end: 20, window_days: [1, 2, 3, 4, 5, 6], timezone: 'America/Chicago',
          ramp_enabled: true, ramp_start: 50, ramp_increase_pct: 20, ramp_target: 500, ramp_started_on: '2026-08-01', paused: false, paused_reason: null, paused_at: null, paused_auto: false,
        },
        sent_today: 0, allowance: 500, ramp_day: 21, sent_7d: 1180, bounced_7d: 6,
      },
      senders: [
        {
          id: 1, from_email: 'deals@deals.yourcompany.com', from_name: 'Acme Homes', domain: 'deals.yourcompany.com', active: true,
          settings: {
            daily_cap: 500, hourly_cap: 120, min_gap_seconds: 4, window_start: 8, window_end: 20, window_days: [1, 2, 3, 4, 5, 6], timezone: 'America/Chicago',
            ramp_enabled: true, ramp_start: 50, ramp_increase_pct: 20, ramp_target: 500, ramp_started_on: '2026-08-01', paused: false, paused_reason: null, paused_at: null, paused_auto: false,
          },
          sent_today: 0, allowance: 500, ramp_day: 21, sent_7d: 1180, bounced_7d: 6,
        },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: i + 2,
          from_email: `morgan${i + 1}@deals.yourcompany.com`,
          from_name: 'Morgan Lane',
          reply_to: 'morgan@yourcompany.com',
          user_id: '55555555-5555-4555-8555-555555555555',
          domain: 'deals.yourcompany.com',
          active: true,
          settings: {
            daily_cap: 100, hourly_cap: 40, min_gap_seconds: 20, window_start: 8, window_end: 18, window_days: [1, 2, 3, 4, 5], timezone: 'America/Chicago',
            ramp_enabled: true, ramp_start: 50, ramp_increase_pct: 20, ramp_target: 100, ramp_started_on: '2026-09-26', paused: false, paused_reason: null, paused_at: null, paused_auto: false,
          },
          sent_today: 0, allowance: 50, ramp_day: 1, sent_7d: 0, bounced_7d: 0,
        })),
      ],
    },
    page,
    pageUrl: listingBase(SLUG),
    names: new Map([...buyers, ...REALTORS].map((b) => [b.id, { name: b.name, company: b.company, phone: b.phone }])),
    realtors: REALTORS,
  };
  return cache;
}

/**
 * The demo for one sample property. 2207 Willow Street (d6) has the past
 * campaign and its buyer page; any other sample property opens straight into
 * the composer on the same buyer pool, with a page of its own.
 */
export function demoFor(dealKey: string, address: string, listingBase: (slug: string) => string): DemoMarketing {
  const m = demoMarketing(listingBase);
  if (dealKey === 'd6') return m;
  const hit = perDeal.get(dealKey);
  if (hit) return hit;
  const d: DemoMarketing = {
    ...m,
    results: { campaigns: [], recipients: [], messages: [], offers: 0 },
    viewed: 0,
    page: { ...m.page, headline: address, description: null, view_count: 0, unique_viewers: 0 },
  };
  perDeal.set(dealKey, d);
  return d;
}
const perDeal = new Map<string, DemoMarketing>();

// ---- the AI, on sample data --------------------------------------------------
/**
 * What the dispo-intro function would write, per tone, from the same facts it
 * is allowed to use. Only the demo calls this; a workspace calls the model.
 */
export function demoIntro(tone: string, f: { first: string; rep: string; note: string; hook?: string; city: string; type: string }): string {
  const hi = (w: string) => (f.first ? `${w} ${f.first}` : w);
  // A purchase on file is the whole point of the text. The hook names their
  // street, how far it is from this one, and asks for an offer.
  if (f.hook) return `${f.first ? `${f.first} - ` : ''}${f.rep ? `${f.rep} here. ` : ''}${f.hook}`;
  const note = f.note ? ` ${f.note}` : '';
  const what = `a ${f.type || 'house'} in ${f.city || 'town'}`;
  switch (tone) {
    case 'casual': return `${hi('Hey')} - ${f.rep} here. Got ${what} you might like.${note} Want the details?`;
    case 'professional': return `${hi('Hello')}, this is ${f.rep} with Acme Homes. We have ${what} under contract that matches your criteria.${note} Would you like the numbers?`;
    case 'direct': return `${f.first ? `${f.first}, ` : ''}${f.rep} here. Off-market 3/2 in ${f.city}, heavy rehab.${note} Want the numbers?`;
    case 'urgent': return `${f.first ? `${f.first} - ` : ''}${f.rep}. Just locked up ${what} and it will go fast.${note} Want first look before I send it wide?`;
    default: return `${hi('Hi')}! It's ${f.rep}. I just got ${what} that looks right up your alley.${note} Want me to send it over?`;
  }
}
