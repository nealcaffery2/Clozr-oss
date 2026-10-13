// Duplicate review for bulk import — pure, so it can be tested without a database.
//
// Every incoming row is classified against the rows before it in the file and
// against what CLOZR already has, and gets a default action. Nothing is ever
// created twice, and nothing already in CLOZR is touched or skipped without a
// person saying so: a record CLOZR already has, and a seller whose address is
// on an existing property under a different name, both wait for a choice.
//
// The merge rules (patchFor, mergePatch) are shared with Quick Add, which asks
// the same question when one record typed by hand is already there.

/** What a row is matched on. `address` is the database's address_key, not the raw text. */
export type Keys = { name: string; phone: string | null; email: string | null; address: string | null; sourceId: string | null };
/** A record already in CLOZR, with what to show beside the incoming row. */
export type Existing = Keys & { id: number; propertyId?: number | null; show: string[] };

export type MatchBy = 'record id' | 'phone' | 'email' | 'address';
export type Match =
  | { kind: 'new' }
  | { kind: 'file'; row: number; by: MatchBy }
  | { kind: 'existing'; id: number; by: MatchBy }
  | { kind: 'conflict'; id: number; propertyId: number | null };

/** create: write a new record. fill: update the match's empty fields. overwrite: replace with non-empty incoming values.
 *  coseller: another seller on the matched property. merge: fold into the first row of the file with the same key. */
export type Action = 'create' | 'skip' | 'fill' | 'overwrite' | 'coseller' | 'merge';

/** Last ten digits, so "(210) 555-0100" and "+12105550100" are one phone. */
export const phoneKey = (v: string | null | undefined) => {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : null;
};
export const emailKey = (v: string | null | undefined) => (v ?? '').trim().toLowerCase() || null;
/**
 * A phone as the database keys it: `normalize_phone()`, which fills the
 * generated `phone_key` on sellers and buyers (and `sellers_phone_uniq`). Ten
 * digits are US, eleven starting with 1 already carry the code, 8–15 digits are
 * kept as they are, anything else does not key.
 */
export const dbPhoneKey = (v: string | null | undefined): string | null => {
  const d = (v ?? '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return d.length >= 8 && d.length <= 15 ? '+' + d : null;
};

const nameTokens = (n: string) => n.toLowerCase().replace(/^owner of .*/, '').split(/[^a-z]+/).filter((t) => t.length > 1);
/** Same person, loosely: any shared name token ("Karen Daniels" / "Karen E. Daniels"). A placeholder name matches anyone. */
export function sameName(a: string, b: string): boolean {
  const x = nameTokens(a); const y = nameTokens(b);
  if (!x.length || !y.length) return true;
  return x.some((t) => y.includes(t));
}

export function classify(rows: Keys[], existing: Existing[]): Match[] {
  const index = () => ({ sourceId: new Map<string, number>(), phone: new Map<string, number>(), email: new Map<string, number>(), address: new Map<string, number[]>() });
  const ex = index();
  existing.forEach((e, i) => {
    if (e.sourceId) ex.sourceId.set(e.sourceId, i);
    const p = phoneKey(e.phone); if (p && !ex.phone.has(p)) ex.phone.set(p, i);
    const em = emailKey(e.email); if (em && !ex.email.has(em)) ex.email.set(em, i);
    if (e.address) ex.address.set(e.address, [...(ex.address.get(e.address) ?? []), i]);
  });
  const seen = index();

  return rows.map((r, i) => {
    const p = phoneKey(r.phone); const em = emailKey(r.email);
    let match: Match | null = null;

    const hit = (by: MatchBy, at: number | undefined) => { if (!match && at != null) match = { kind: 'existing', id: existing[at].id, by }; };
    if (r.sourceId) hit('record id', ex.sourceId.get(r.sourceId));
    if (p) hit('phone', ex.phone.get(p));
    if (em) hit('email', ex.email.get(em));
    if (!match && r.address) {
      const onProperty = (ex.address.get(r.address) ?? []).map((k) => existing[k]);
      const same = onProperty.find((e) => sameName(e.name, r.name));
      if (same) match = { kind: 'existing', id: same.id, by: 'address' };
      else if (onProperty.length) match = { kind: 'conflict', id: onProperty[0].id, propertyId: onProperty[0].propertyId ?? null };
    }

    const earlier = (by: MatchBy, at: number | undefined) => { if (!match && at != null) match = { kind: 'file', row: at, by }; };
    if (r.sourceId) earlier('record id', seen.sourceId.get(r.sourceId));
    if (p) earlier('phone', seen.phone.get(p));
    if (em) earlier('email', seen.email.get(em));
    if (r.address) earlier('address', seen.address.get(r.address)?.[0]);

    if (r.sourceId && !seen.sourceId.has(r.sourceId)) seen.sourceId.set(r.sourceId, i);
    if (p && !seen.phone.has(p)) seen.phone.set(p, i);
    if (em && !seen.email.has(em)) seen.email.set(em, i);
    if (r.address && !seen.address.has(r.address)) seen.address.set(r.address, [i]);
    return match ?? { kind: 'new' };
  });
}

/**
 * New rows create and a repeat inside the file skips. A record CLOZR already
 * has and an address conflict have no default: someone has to say whether the
 * file adds to them, overrides them or leaves them alone.
 */
export const defaultAction = (m: Match): Action | null =>
  m.kind === 'new' ? 'create' : m.kind === 'file' ? 'skip' : null;

/** The actions a person can pick for a match. */
export const actionsFor = (m: Match): Action[] =>
  m.kind === 'new' ? ['create', 'skip']
    : m.kind === 'file' ? ['skip', 'merge']
      : m.kind === 'existing' ? ['skip', 'fill', 'overwrite']
        : ['skip', 'coseller', 'fill'];

export function summarize(matches: Match[], actions: (Action | null)[], problems: (string | null)[] = []) {
  const s = { create: 0, skipped: 0, updates: 0, cosellers: 0, unresolved: 0 };
  matches.forEach((m, i) => {
    const a = actions[i];
    if (problems[i]) s.skipped++;
    else if (a == null) s.unresolved++;
    else if (a === 'create') s.create++;
    else if (a === 'fill' || a === 'overwrite') s.updates++;
    else if (a === 'coseller') s.cosellers++;
    else s.skipped++;
  });
  return s;
}

const blank = (v: unknown) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/** The update for a match: `fill` touches only the record's empty fields, `overwrite` any field the file has a value for. */
export function patchFor(current: Record<string, unknown>, incoming: Record<string, unknown>, mode: 'fill' | 'overwrite'): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (blank(v) || (v && typeof v === 'object' && !Array.isArray(v))) continue;
    if (mode === 'overwrite' ? current[k] !== v : blank(current[k])) out[k] = v;
  }
  return out;
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A key/value bag (sellers.import_extra, properties.facts) by the same rule,
 * key by key: `fill` adds the keys the record has no value for, `overwrite`
 * also replaces the ones the file has a different value for. A blank incoming
 * value never clears one, and keys only the record has are kept. Null when
 * nothing changes.
 */
export function mergeObject(current: unknown, incoming: unknown, mode: 'fill' | 'overwrite'): Record<string, unknown> | null {
  if (!plain(incoming)) return null;
  const have = plain(current) ? current : {};
  const out: Record<string, unknown> = { ...have };
  let changed = false;
  for (const [k, v] of Object.entries(incoming)) {
    if (blank(v)) continue;
    if (mode === 'overwrite' ? JSON.stringify(have[k]) !== JSON.stringify(v) : blank(have[k])) { out[k] = v; changed = true; }
  }
  return changed ? out : null;
}

/**
 * patchFor, for a person adding information to a record: the list fields
 * (tags, other emails) gain the incoming entries, the text fields that are a
 * running log (notes) gain the incoming text on a new line unless it is already
 * there, and the key/value bags (`objects`) merge key by key (mergeObject). In
 * both modes — Override writes over the other fields, never over what a person
 * tagged or wrote down.
 */
export function mergePatch(
  current: Record<string, unknown>, incoming: Record<string, unknown>, mode: 'fill' | 'overwrite',
  { lists = ['tags'], append = ['notes'], objects = [] }: { lists?: string[]; append?: string[]; objects?: string[] } = {},
): Record<string, unknown> {
  const special = new Set([...lists, ...append, ...objects]);
  const out = patchFor(current, Object.fromEntries(Object.entries(incoming).filter(([k]) => !special.has(k))), mode);
  for (const k of objects) {
    const merged = mergeObject(current[k], incoming[k], mode);
    if (merged) out[k] = merged;
  }
  for (const k of lists) {
    const have = Array.isArray(current[k]) ? (current[k] as unknown[]).map(String) : [];
    const seen = new Set(have.map((x) => x.trim().toLowerCase()));
    const extra: string[] = [];
    for (const x of Array.isArray(incoming[k]) ? (incoming[k] as unknown[]).map((v) => String(v ?? '').trim()) : []) {
      if (x && !seen.has(x.toLowerCase())) { seen.add(x.toLowerCase()); extra.push(x); }
    }
    if (extra.length) out[k] = [...have, ...extra];
  }
  for (const k of append) {
    const add = typeof incoming[k] === 'string' ? (incoming[k] as string).trim() : '';
    const have = typeof current[k] === 'string' ? (current[k] as string).trim() : '';
    if (add && !have.includes(add)) out[k] = have ? `${have}\n${add}` : add;
  }
  return out;
}

// ---- a matched seller's deal --------------------------------------------------

/** A deal still being worked: not closed, terminated or referred out (the Podio import's rule too). */
export const isOpenDealStage = (stage: string | null | undefined) => !['Closed', 'Terminated', 'Realtor Referral'].includes(stage ?? '');

export type DealOnFile = { id: number; stage: string; arv: number | null; rehab: number | null; offer_amount: number | null };
export type ImportDealPlan =
  | { kind: 'none' }
  /** The seller's open deal takes the row's numbers (`patch`, possibly empty) and photos. */
  | { kind: 'update'; dealId: number; patch: Record<string, unknown>; photos: string[] }
  /** The seller has no deal at all: one is opened with the row's numbers and photos. */
  | { kind: 'create'; fields: { arv: number | null; rehab: number | null; offer_amount: number | null }; photos: string[] }
  /** Only closed or terminated deals: their numbers are history and stay; photos go on the latest as before. */
  | { kind: 'closed'; dealId: number; photos: string[] };

/**
 * What an import row does to the deal of a seller it updates (Add new info or
 * Override). The same fill / overwrite rule as the seller: the newest open deal
 * takes the row's ARV, rehab and offer, a seller with no deal at all gets one,
 * and a seller whose deals are all closed keeps them as they are. `deals` is
 * newest first.
 */
export function planImportDeal(
  row: { arv: number | null; rehab: number | null; offer: number | null; photos: string[] },
  deals: DealOnFile[], mode: 'fill' | 'overwrite',
): ImportDealPlan {
  const fields = { arv: row.arv, rehab: row.rehab, offer_amount: row.offer };
  const hasNumbers = Object.values(fields).some((v) => v != null);
  if (!hasNumbers && !row.photos.length) return { kind: 'none' };
  const open = deals.find((d) => isOpenDealStage(d.stage));
  if (open) return { kind: 'update', dealId: open.id, patch: patchFor(open as unknown as Record<string, unknown>, fields, mode), photos: row.photos };
  if (deals.length) return { kind: 'closed', dealId: deals[0].id, photos: row.photos };
  return { kind: 'create', fields, photos: row.photos };
}
