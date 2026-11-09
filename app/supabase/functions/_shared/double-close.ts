/**
 * A double close from Compr's sale rolls (Compr's clozr_double_closes, its
 * migration 161) into the wholesaler database: the wholesaler (B) and the end
 * buyer (C) as entities, the pair of sales as one deed leg with the fee.
 *
 * Pure, so the mapping is tested without either database
 * (npx tsx tools/double-close.test.ts).
 */
import { cleanEntity, entityKey } from './podio-keys.ts';

export type DoubleClose = {
  source: string; state: string; county_code: string | null; apn: string;
  situs_addr: string | null; situs_city: string | null; situs_zip: string | null;
  wholesaler: string; bought_on: string; bought_for: number | null;
  end_buyer: string; sold_on: string; sold_for: number | null;
  gap_days: number; fee: number | null;
};

export type EntityRow = { workspace_id: number; name: string; name_key: string; kind: 'wholesaler' | 'buyer'; source: 'deed'; state: string | null; meta: Record<string, unknown> };
export type DealRow = {
  workspace_id: number; assignor_name: string; assignee_name: string; property_address: string | null; city: string | null; state: string | null; zip: string | null;
  county: string | null; purchase_price: number | null; assignment_fee: number | null; total_price: number | null; contract_date: string; closing_date: string;
  leg: 'deed'; source: 'deed'; source_id: string; raw: Record<string, unknown>;
};

/** "SMITH, JOHN;SMITH, JANE" is two owners on one deed: the first is the name. */
const firstParty = (s: string) => s.split(/;|\s+&\s+|\s+AND\s+/)[0].trim();

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function doubleCloseRows(ws: number, rows: DoubleClose[]): { entities: EntityRow[]; deals: DealRow[] } {
  const entities = new Map<string, EntityRow>();
  const deals = new Map<string, DealRow>();
  for (const r of rows) {
    const b = cleanEntity(r.wholesaler).name;
    const c = cleanEntity(firstParty(String(r.end_buyer ?? ''))).name;
    const bk = entityKey(b);
    const ck = entityKey(c);
    if (!b || !c || !bk || !ck || bk === ck) continue;
    const roll = { from: 'compr_rolls', roll: r.source };
    if (!entities.has(bk)) entities.set(bk, { workspace_id: ws, name: b, name_key: bk, kind: 'wholesaler', source: 'deed', state: r.state ?? null, meta: roll });
    if (!entities.has(ck)) entities.set(ck, { workspace_id: ws, name: c, name_key: ck, kind: 'buyer', source: 'deed', state: r.state ?? null, meta: roll });
    const id = `compr:${r.source}:${r.apn}:${r.bought_on}:${r.sold_on}`;
    const bought = num(r.bought_for);
    const sold = num(r.sold_for);
    deals.set(id, {
      workspace_id: ws, assignor_name: b, assignee_name: c,
      property_address: r.situs_addr ?? null, city: r.situs_city ?? null, state: r.state ?? null, zip: r.situs_zip ?? null, county: r.county_code ?? null,
      purchase_price: bought, assignment_fee: bought && sold && sold > bought ? sold - bought : null, total_price: sold,
      contract_date: r.bought_on, closing_date: r.sold_on, leg: 'deed', source: 'deed', source_id: id.slice(0, 250),
      raw: { via: 'compr_rolls', roll: r.source, apn: r.apn, gap_days: r.gap_days, end_buyer_as_recorded: r.end_buyer },
    });
  }
  return { entities: [...entities.values()], deals: [...deals.values()] };
}

/** Month windows from `from` up to (not including) `to`, newest first: the backfill walks back one at a time. */
export function monthWindows(from: string, to: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let end = new Date(`${to}T00:00:00Z`);
  const stop = new Date(`${from}T00:00:00Z`);
  while (end > stop) {
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, end.getUTCDate()));
    const s = start < stop ? stop : start;
    out.push({ from: s.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) });
    end = s;
  }
  return out;
}
