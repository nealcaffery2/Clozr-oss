// What /demo shows on the Genius page: one finished search and a rail of past
// ones, held in memory. The page only reads this on the /demo route, where
// there is no workspace to search with (screens/Genius.tsx). It never reaches
// Supabase, the discover function or a paid data source.

import type { Candidate, PastRun, Purchase, Run } from './genius';
import { DEFAULT_FILTERS } from './genius';

const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const SUBJECT = {
  address: '318 Harvest Moon', city: 'San Antonio', state: 'TX', zip: '78209', lat: 29.4966, lng: -98.4642,
  reapi_id: null, beds: 3, baths: 2, sqft: 1620, year_built: 1974, property_type: 'SFR',
  est_value: 268000, suggested_rent: 2150, arv: 285000, price: 168000, deal_id: null,
};

function purchase(i: number, o: Partial<Purchase>): Purchase {
  return {
    reapi_id: `demo-${i}`, role: 'flip', address: `${1200 + i * 37} Ridgecrest Dr`, city: 'San Antonio', state: 'TX', zip: '78209',
    lat: 29.49 + i * 0.004, lng: -98.46 - i * 0.003, distance_mi: Math.round((0.3 + i * 0.16) * 100) / 100, property_type: 'SFR', beds: 3, baths: 2, sqft: 1500 + i * 40, year_built: 1968 + i,
    price: 150000 + i * 6000, price_source: 'recorded', non_disclosure: false, date: day(60 + i * 40),
    resale_price: null, resale_date: null, days_held: null, financed: false, est_value: 250000, pct_of_arv: 62, price_per_sqft: 101,
    agent: null, zillow: 'https://www.zillow.com/homes/', ...o,
  };
}

function cand(i: number, o: Partial<Candidate> & Pick<Candidate, 'owner_name' | 'kind'>, ps: Purchase[]): Candidate {
  const prices = ps.map((p) => p.price ?? 0);
  return {
    key: `demo-${i}`, people: [], corporate: /LLC|Homes|Capital|Holdings/.test(o.owner_name), institutional: false, absentee: false,
    mailing: '4410 Bluebonnet Trail, Fort Worth, TX 76107', mail_parts: null, purchases: ps, purchase_count: ps.length,
    flips: ps.filter((p) => p.role === 'flip').length, holds: ps.filter((p) => p.role === 'hold').length, builds: ps.filter((p) => p.role === 'build').length,
    last_purchase: ps[0]?.date ?? null, nearest_mi: Math.min(...ps.map((p) => p.distance_mi ?? 9)), lat: ps[0]?.lat ?? null, lng: ps[0]?.lng ?? null,
    avg_price: Math.round(prices.reduce((a, b) => a + b, 0) / Math.max(1, prices.length)), min_price: Math.min(...prices), max_price: Math.max(...prices),
    avg_ppsf: 104, avg_days_held: 96, cash: true, non_disclosure: false, portfolio_count: ps.length + 4, portfolio_value: 1_400_000,
    likelihood: 70, smart_match: false, smart_rank: null, pct_of_arv: 61, reasons: ['Bought 3 houses within 1 mi in 12 months', 'Pays cash'],
    matched_buyer_id: null, match_by: null, contacts: null, contacts_at: null, ...o,
  };
}

const flip = (i: number, o: Partial<Purchase> = {}) => purchase(i, { role: 'flip', resale_price: 236000 + i * 4000, resale_date: day(20 + i * 10), days_held: 88 + i * 6, ...o });
const hold = (i: number, o: Partial<Purchase> = {}) => purchase(i, { role: 'hold', price: 138000 + i * 5000, ...o });

const CANDIDATES: Candidate[] = [
  cand(1, { owner_name: 'Lone Star Rentals LLC', kind: 'landlord', likelihood: 91, smart_match: true, smart_rank: 1, matched_buyer_id: 7, match_by: 'entity', reasons: ['4 buys within 1 mi in 12 months', 'Matches your buy box', 'Already in your buyers'], contacts: [{ name: 'Marcus Webb', phones: [{ number: '(210) 555-0188', type: 'mobile', dnc: false, score: 92 }], emails: ['marcus@lonestarrentals.example'], mailing: null }], contacts_at: day(3) }, [hold(1), hold(2), hold(3), hold(4)]),
  cand(2, { owner_name: 'Harbor Capital Partners', kind: 'flipper', likelihood: 84, smart_match: true, smart_rank: 2, reasons: ['3 flips inside 18 months', 'Buys at 58 to 64 percent of ARV'] }, [flip(1), flip(2), flip(3)]),
  cand(3, { owner_name: 'Derek Ross', kind: 'flipper', likelihood: 76, absentee: true, reasons: ['2 flips nearby', 'Absentee owner'] }, [flip(4), flip(5)]),
  cand(4, { owner_name: 'Alamo City Homes LLC', kind: 'builder', likelihood: 68, reasons: ['Builds on infill lots'] }, [purchase(6, { role: 'build', price: 92000 }), purchase(7, { role: 'build', price: 88000 })]),
  cand(5, { owner_name: 'Priya Nair', kind: 'landlord', likelihood: 63, cash: false, reasons: ['Buy and hold, financed'] }, [hold(5), hold(6)]),
  cand(6, { owner_name: 'Redline Holdings LLC', kind: 'flipper', likelihood: 57, reasons: ['1 flip nearby', 'Portfolio of 9'] }, [flip(7)]),
  cand(7, { owner_name: 'Tomas Herrera', kind: 'landlord', likelihood: 49, reasons: ['1 hold nearby'] }, [hold(8)]),
  cand(8, { owner_name: 'Cypress Ventures', kind: 'flipper', likelihood: 41, reasons: ['1 flip, 21 months ago'] }, [flip(9)]),
];

export const DEMO_GENIUS_RUN: Run = {
  run_id: 9001, deal_id: null, subject: SUBJECT, filters: { ...DEFAULT_FILTERS, radius_mi: 2, months: 24 },
  candidates: CANDIDATES, sales_scanned: 412, properties_scanned: 388, credits: { records: 388 }, created_at: new Date().toISOString(), status: 'done',
};

export const DEMO_GENIUS_PAST: PastRun[] = [
  { id: 9001, address: '318 Harvest Moon, San Antonio, TX', deal_id: null, buyer_count: CANDIDATES.length, top_score: 91, created_at: new Date().toISOString(), status: 'done', radius_mi: 2, months: 24, filters: null },
  { id: 9000, address: '7302 Sagebrush Ct, Plano, TX', deal_id: null, buyer_count: 27, top_score: 88, created_at: new Date(Date.now() - 2 * 864e5).toISOString(), status: 'done', radius_mi: 3, months: 18, filters: null },
  { id: 8999, address: '2115 Alamo Heights Blvd, Austin, TX', deal_id: null, buyer_count: 19, top_score: 79, created_at: new Date(Date.now() - 9 * 864e5).toISOString(), status: 'done', radius_mi: 2, months: 24, filters: null },
];
