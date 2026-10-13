// Vendors attached as the seller on a deal (deal_parties.role = 'seller' and
// vendor_id set). The deal's seller_id still points at a sellers-table person
// when there is one. These vendors are extra: they show on the submission and
// can be opened, and they never replace that person's name, phone, or email.

export type VendorSeller = {
  /** Prefixed vendor id, 'v12'. */
  id: string;
  name: string;
  phone: string;
  email: string;
  company: string;
};

export type SellerPartyRow = {
  deal_id: number;
  vendor_id: number | null;
  role: string;
  name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
};

export type VendorSellerSource = {
  id: number;
  business_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
};

const blank = (v: string | null | undefined) => {
  const t = (v ?? '').trim();
  return !t || t === '—' ? '' : t;
};

/** One list per deal. The same vendor on a deal twice is one row. Other roles are ignored. */
export function vendorSellersByDeal(parties: SellerPartyRow[], vendors: VendorSellerSource[]): Map<number, VendorSeller[]> {
  const byId = new Map(vendors.map((v) => [v.id, v]));
  const out = new Map<number, VendorSeller[]>();
  for (const p of parties) {
    if (p.role !== 'seller' || p.vendor_id == null) continue;
    const v = byId.get(p.vendor_id);
    const company = blank(p.company) || blank(v?.business_name);
    const name = blank(p.name) || blank(v?.contact_name) || company || 'Vendor';
    const row: VendorSeller = {
      id: 'v' + p.vendor_id,
      name,
      phone: blank(p.phone) || blank(v?.phone) || '—',
      email: blank(p.email) || blank(v?.email) || '—',
      company: company || name,
    };
    const list = out.get(p.deal_id) ?? [];
    if (list.some((x) => x.id === row.id)) continue;
    list.push(row);
    out.set(p.deal_id, list);
  }
  return out;
}

export type SubmissionIdentity = {
  name: string;
  phone: string;
  email: string;
  /** Vendor-sellers that are not already the row's name, so a real seller stays and the vendors still show. */
  vendorLabels: string[];
};

const usable = (v: string | null | undefined) => {
  const t = (v ?? '').trim();
  return !!t && t !== '—' && t !== 'No name' && t !== 'Submission';
};

/**
 * The submission row. A sellers-table person keeps their own name, phone, and
 * email. A blank of those is filled from the first vendor attached as seller.
 * Every other vendor-seller is a label, so nothing already on the seller is dropped.
 */
export function submissionIdentity(
  seller: { name?: string | null; phone?: string | null; email?: string | null } | undefined,
  vendors: VendorSeller[],
  addr: string,
): SubmissionIdentity {
  const v = vendors[0];
  const named = usable(seller?.name);
  const name = named ? seller!.name!.trim() : (v?.name || v?.company || addr);
  const phone = usable(seller?.phone) ? seller!.phone!.trim() : (v && usable(v.phone) ? v.phone : '—');
  const email = usable(seller?.email) ? seller!.email!.trim() : (v && usable(v.email) ? v.email : '—');
  const label = (x: VendorSeller) => (x.company && x.company !== x.name ? `${x.name} · ${x.company}` : x.name);
  // The vendor whose name filled a blank seller is already the row. The rest still show.
  const usedAsName = named || !v ? '' : v.id;
  const vendorLabels = vendors.filter((x) => x.id !== usedAsName).map(label);
  return { name, phone, email, vendorLabels };
}

/** A submission opens its seller when that person is in the graph, and the deal sheet otherwise. */
export function submissionOpenTarget(personId: string, personInGraph: boolean): 'person' | 'sheet' {
  return personId && personInGraph ? 'person' : 'sheet';
}
