// Everyone the dial box can find: sellers and buyers (with their other
// numbers), vendors, the people on deals (title, lenders, agents, attorneys,
// TCs…), wholesalers, and Talkr's own contacts. Each source is best-effort: a
// failed read drops that source, never the whole search. lib/dial-lookup.ts
// merges and labels; tools/dial-lookup.test.ts covers the pure parts.

import { supabase } from './supabase';
import { type Contact, ilikeSafe, parseQuery, rankContacts } from './contact-search';
import { searchContacts } from './contract-recipients';
import { api, type ContactDto } from './talkr-web/api';
import { partyTrade, talkrContact } from './dial-lookup';
import { isBadNumber, type OtherPhone } from './seller-phones';

/** The queue's skip rule (isBadNumber) on the flag columns alone. */
const bad = (r: { kind?: unknown; is_dnc?: unknown; is_wrong?: unknown }) => isBadNumber(r as OtherPhone);

type Rows<T> = Promise<{ data: T[] | null }>;
const rows = async <T>(q: PromiseLike<{ data: unknown }>): Promise<T[]> => {
  try {
    return (((await q) as Awaited<Rows<T>>).data ?? []) as T[];
  } catch {
    return [];
  }
};

type Extra = { owner: number; phone: string; kind: string | null };

/** Up to `limit` people to call for what was typed: a name, a company, a trade, an address or part of a number. */
export async function searchDialable(workspaceId: number, q: string, opts: { talkr: boolean }, limit = 24): Promise<Contact[]> {
  if (!supabase) return [];
  const sb = supabase;
  const { terms, digits } = parseQuery(q);
  const word = ilikeSafe([...terms].sort((a, b) => b.length - a.length)[0] ?? '');
  if (!word && !digits) return [];
  const like = `%${word}%`;
  const tail = digits ? `%${digits.slice(-4)}%` : null;
  const ors = (cols: string[]) => [...(digits ? [] : cols.map((c) => `${c}.ilike.${like}`)), ...(tail ? [`phone.ilike.${tail}`] : [])].join(',');

  const [base, sellersByAddr, parties, wholesalers, sellerExtras, buyerExtras, talkr] = await Promise.all([
    searchContacts(workspaceId, q, 40).catch(() => [] as Contact[]),
    digits
      ? Promise.resolve([])
      : rows<{ id: number; name: string; email: string | null; phone: string | null; property_address: string | null }>(
          sb.from('sellers').select('id, name, email, phone, property_address').eq('workspace_id', workspaceId).ilike('property_address', like).limit(15),
        ),
    rows<{ id: number; role: string; name: string | null; company: string | null; email: string | null; phone: string | null }>(
      sb.from('deal_parties').select('id, role, name, company, email, phone').eq('workspace_id', workspaceId)
        .not('role', 'in', '(seller,buyer)').not('phone', 'is', null).or(ors(['name', 'company', 'email', 'role'])).limit(25),
    ),
    rows<{ id: number; name: string; contact_name: string | null; email: string | null; phone: string | null; kind: string; state: string | null }>(
      sb.from('wholesaler_entities').select('id, name, contact_name, email, phone, kind, state').eq('workspace_id', workspaceId)
        .not('phone', 'is', null).or(ors(['name', 'contact_name', 'email'])).limit(15),
    ),
    // A number search also finds the other numbers on sellers and buyers.
    tail
      ? rows<{ seller_id: number; phone: string; kind: string | null; is_dnc: boolean | null; is_wrong: boolean | null }>(
          sb.from('seller_phones').select('seller_id, phone, kind, is_dnc, is_wrong').eq('workspace_id', workspaceId).ilike('phone', tail).limit(15),
        ).then((xs) => xs.filter((x) => !bad(x)))
      : Promise.resolve([]),
    tail
      ? rows<{ buyer_id: number; phone: string; kind: string | null; is_dnc: boolean | null }>(
          sb.from('buyer_phones').select('buyer_id, phone, kind, is_dnc').eq('workspace_id', workspaceId).ilike('phone', tail).limit(15),
        ).then((xs) => xs.filter((x) => !bad(x)))
      : Promise.resolve([]),
    opts.talkr
      ? api.listContacts({ q: q.trim(), limit: 10, has_phone: true }).then((r) => r.contacts, () => [] as ContactDto[])
      : Promise.resolve([] as ContactDto[]),
  ]);

  const list: Contact[] = [
    ...base.filter((c) => c.kind !== 'team'),
    ...sellersByAddr.map((s): Contact => ({ kind: 'seller', id: s.id, name: s.name, email: s.email, phone: s.phone, sub: s.property_address })),
    ...parties.map((p): Contact => ({
      kind: 'vendor', id: `dp${p.id}`, name: p.name || p.company || partyTrade(p.role), email: p.email, phone: p.phone,
      sub: [p.name ? p.company : null, partyTrade(p.role)].filter(Boolean).join(' · ') || null, trade: partyTrade(p.role),
    })),
    ...wholesalers.map((w): Contact => ({
      kind: 'vendor', id: `w${w.id}`, name: w.contact_name || w.name, email: w.email, phone: w.phone,
      sub: [w.contact_name ? w.name : null, w.state].filter(Boolean).join(' · ') || null, trade: w.kind === 'title' ? 'Title' : 'Wholesaler',
    })),
    ...talkr.flatMap((c) => talkrContact(c)),
  ];

  // Sellers and buyers: every number on file, not only the main one. Never a
  // do-not-call or wrong number (the queue's own rule, isBadNumber); a seller's
  // wrong number is is_wrong, a buyer's is kind 'wrong', and buyer_phones has no is_wrong.
  const extras = async (table: 'seller_phones' | 'buyer_phones', key: 'seller_id' | 'buyer_id', ids: number[]): Promise<Extra[]> =>
    ids.length
      ? (await rows<Record<string, unknown>>(
          sb.from(table).select(`${key}, phone, kind, is_dnc${table === 'seller_phones' ? ', is_wrong' : ''}`).eq('workspace_id', workspaceId).in(key, ids).limit(60),
        ))
          .filter((r) => !bad(r))
          .map((r) => ({ owner: Number(r[key]), phone: String(r.phone), kind: (r.kind as string | null) ?? null }))
      : [];
  const sellerIds = list.filter((c) => c.kind === 'seller' && typeof c.id === 'number').map((c) => c.id as number);
  const buyerIds = list.filter((c) => c.kind === 'buyer' && typeof c.id === 'number').map((c) => c.id as number);
  const [sx, bx] = await Promise.all([
    extras('seller_phones', 'seller_id', [...new Set([...sellerIds, ...sellerExtras.map((e) => e.seller_id)])].slice(0, 30)),
    extras('buyer_phones', 'buyer_id', [...new Set([...buyerIds, ...buyerExtras.map((e) => e.buyer_id)])].slice(0, 30)),
  ]);
  // Owners found only by one of their other numbers.
  const missing = async (table: 'sellers' | 'buyers', ids: number[]) =>
    ids.length ? rows<{ id: number; name: string; email: string | null; phone: string | null; sub: string | null }>(
      sb.from(table).select(table === 'sellers' ? 'id, name, email, phone, sub:property_address' : 'id, name, email, phone, sub:company').eq('workspace_id', workspaceId).in('id', ids),
    ) : Promise.resolve([]);
  const [ms, mb] = await Promise.all([
    missing('sellers', [...new Set(sellerExtras.map((e) => e.seller_id))].filter((id) => !sellerIds.includes(id))),
    missing('buyers', [...new Set(buyerExtras.map((e) => e.buyer_id))].filter((id) => !buyerIds.includes(id))),
  ]);
  const owners = new Map<string, Contact>();
  for (const c of [...list, ...ms.map((s): Contact => ({ kind: 'seller', ...s })), ...mb.map((b): Contact => ({ kind: 'buyer', ...b }))]) {
    if (c.kind === 'seller' || c.kind === 'buyer') owners.set(`${c.kind}:${c.id}`, c);
  }
  const more = (kind: 'seller' | 'buyer', xs: Extra[]): Contact[] => xs.flatMap((x) => {
    const o = owners.get(`${kind}:${x.owner}`);
    if (!o) return [];
    const other = `${x.kind ? x.kind[0].toUpperCase() + x.kind.slice(1) : 'Other'} number`;
    return [{ ...o, id: `${o.id}:${x.phone}`, phone: x.phone, sub: [other, o.sub].filter(Boolean).join(' · ') }];
  });

  const all = [...list, ...ms.map((s): Contact => ({ kind: 'seller', ...s })), ...mb.map((b): Contact => ({ kind: 'buyer', ...b })), ...more('seller', sx), ...more('buyer', bx)];
  // A number search ranks on the digits; a name search on the words, and an
  // owner's other numbers ride along with them.
  const ranked = rankContacts(all, q, limit * 2);
  if (digits) return ranked;
  // Each owner's other numbers sit right under them, inside the cap, so a busy
  // search trims the last people rather than everyone's other numbers.
  const ownerOf = (c: Contact) => `${c.kind}:${String(c.id).split(':')[0]}`;
  const out: Contact[] = [];
  const placed = new Set<string>();
  for (const c of ranked) {
    for (const row of [c, ...all.filter((x) => x !== c && String(x.id).includes(':') && ownerOf(x) === ownerOf(c) && !String(c.id).includes(':'))]) {
      const k = `${row.kind}:${row.id}`;
      if (placed.has(k)) continue;
      placed.add(k);
      out.push(row);
    }
    if (out.length >= limit * 2) break;
  }
  return out.slice(0, limit * 2);
}
