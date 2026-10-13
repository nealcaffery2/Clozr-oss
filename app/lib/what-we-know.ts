// What we know about a seller, in the order the acquisitions SOP works it.
//
// Due diligence comes first: condition, motivation, asking price and timeline
// are the four answers a rep needs on the first call (the Webb formula), and
// the record shows how many of them are in. Then the property, the deal's
// numbers (COMPR's, read-only here), the rest of what we were told, and the
// disposition form's answers. Phone and email sit above this list.
//
// Pure: tools/what-we-know.test.ts runs it with tsx.

export type KnowType = 'text' | 'textarea' | 'money' | 'number';
export type KnowSection = 'dd' | 'property' | 'deal' | 'seller' | 'form';

export type KnowField = {
  /** The label. */
  k: string;
  /** Where it saves: a seller column, `intake.<key>`, `property.<key>`, or `deal.<key>` (read-only). */
  field: string;
  /** How it reads: "—" when empty. */
  v: string;
  /** What the edit box starts with: a number for money and counts, text otherwise, null when empty. */
  value: string | number | null;
  type: KnowType;
  section: KnowSection;
  /** Why it can't be typed here; absent when it can. */
  readOnly?: string;
  /** One of the four due-diligence answers, and whether it is in. */
  dd?: { done: boolean };
  /** A second, read-only line under the value (the form's own notes). */
  note?: string;
};

export type KnowPerson = {
  motivation: string;
  timeline: string;
  condition: string;
  occupancy: string;
  mortgage: string;
  asking: string;
  desiredClose: string;
  decisionMakers: string;
  /** sellers.notes: the record's one notes field. */
  notes?: string | null;
  intake?: Record<string, unknown> | null;
  property: { beds: number; baths: number; sqft: number; year: number; type: string };
};

export const DUE_DILIGENCE = ['condition', 'motivation', 'asking_price', 'timeline'] as const;

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const money = (v: unknown): string => {
  const n = num(v);
  return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
};

const text = (v: unknown): string => {
  const s = v == null ? '' : String(v).trim();
  return s && s !== '—' ? s : '—';
};
const raw = (shown: string): string | null => (shown === '—' ? null : shown);

function intake(p: KnowPerson, key: string): unknown {
  const bag = p.intake;
  if (!bag || typeof bag !== 'object') return undefined;
  return bag[key];
}

/** The property row wins once it has a value. Intake covers a form that arrived with no street address. */
function fact(propertyValue: string, fromIntake: unknown): string {
  if (propertyValue && propertyValue !== '—') return propertyValue;
  return text(fromIntake);
}

const COMPR_OWNS = 'COMPR sets this. Open in COMPR to change it.';

/** One row per fact. An empty answer reads "—" and is still editable unless it says why not. */
export function whatWeKnowFields(p: KnowPerson, deal?: { arv?: number | null; rehab?: number | null } | null): KnowField[] {
  const out: KnowField[] = [];
  const add = (section: KnowSection, k: string, field: string, v: string, type: KnowType = 'text', extra: Partial<KnowField> = {}) => {
    const value = type === 'money' || type === 'number' ? num(v) : raw(v);
    out.push({ k, field, v, value, type, section, ...extra });
  };
  const dd = (v: string) => ({ dd: { done: v !== '—' } });

  // Due diligence, in the order the call asks it.
  const condition = text(p.condition);
  const motivation = text(p.motivation);
  const asking = text(p.asking);
  const timeline = text(p.timeline);
  add('dd', 'Condition', 'condition', condition, 'text', dd(condition));
  add('dd', 'Motivation', 'motivation', motivation, 'text', dd(motivation));
  add('dd', 'Asking price', 'asking_price', asking, 'money', dd(asking));
  add('dd', 'Timeline', 'timeline', timeline, 'text', dd(timeline));

  // The house.
  add('property', 'Property type', 'property.type', fact(text(p.property.type), intake(p, 'property_type')));
  add('property', 'Year built', 'property.year', fact(p.property.year ? String(p.property.year) : '—', intake(p, 'year_built')), 'number');
  add('property', 'Bedrooms', 'property.beds', fact(p.property.beds ? String(p.property.beds) : '—', intake(p, 'beds')), 'number');
  add('property', 'Bathrooms', 'property.baths', fact(p.property.baths ? String(p.property.baths) : '—', intake(p, 'baths')), 'number');
  const sqftIn = intake(p, 'sqft');
  add('property', 'Sqft', 'property.sqft', fact(p.property.sqft ? p.property.sqft.toLocaleString('en-US') : '—', typeof sqftIn === 'number' ? sqftIn.toLocaleString('en-US') : sqftIn), 'number');
  add('property', 'Occupied', 'occupancy', text(p.occupancy));

  // The deal's numbers: one source, the deal (COMPR). A form that sent its own
  // ARV before there was a deal still shows it, marked as the form's.
  const formArv = num(intake(p, 'arv'));
  const formRehab = num(intake(p, 'rehab'));
  const arv = num(deal?.arv);
  const rehab = num(deal?.rehab);
  add('deal', 'ARV', 'deal.arv', money(arv ?? formArv), 'money', { readOnly: COMPR_OWNS, ...(arv == null && formArv != null ? { note: 'From the form, not run in COMPR yet' } : {}) });
  add('deal', 'Rehab', 'deal.rehab', money(rehab ?? formRehab), 'money', { readOnly: COMPR_OWNS, ...(rehab == null && formRehab != null ? { note: 'From the form, not run in COMPR yet' } : {}) });

  // The rest of what they told us.
  add('seller', 'Closing needed', 'desired_close', text(p.desiredClose));
  add('seller', 'Mortgage', 'mortgage', text(p.mortgage));
  add('seller', 'Decision makers', 'decision_makers', text(p.decisionMakers));
  // One notes field: the seller's own. The form's notes (intake.notes) show
  // under it, read-only, until someone folds them in.
  const formNotes = text(intake(p, 'notes'));
  const notes = text(p.notes);
  add('seller', 'Notes', 'notes', notes, 'textarea',
    formNotes !== '—' && !notes.includes(formNotes) ? { note: 'From the form: ' + formNotes } : {});

  // The disposition form's answers.
  add('form', 'Entity', 'intake.entity', text(intake(p, 'entity')));
  add('form', 'Disposition', 'intake.disposition', text(intake(p, 'disposition')));
  add('form', 'Location', 'intake.location', text(intake(p, 'location')));
  add('form', 'Portfolio', 'intake.portfolio', text(intake(p, 'portfolio')));
  add('form', 'Garage', 'intake.garage', text(intake(p, 'garage')));
  add('form', 'Photos', 'intake.photos', text(intake(p, 'photos')));
  add('form', 'Lease end', 'intake.lease_end', text(intake(p, 'lease_end')));
  add('form', 'Lease amount', 'intake.lease_amount', money(intake(p, 'lease_amount')), 'money');
  add('form', 'Listed on MLS', 'intake.mls', text(intake(p, 'mls')));
  add('form', 'InvestorLift', 'intake.investorlift', text(intake(p, 'investorlift')));
  add('form', 'Purchase contract', 'intake.contract', text(intake(p, 'contract')));
  add('form', 'Data tape', 'intake.data_tape', text(intake(p, 'data_tape')));
  return out;
}

/** How many of the four due-diligence answers are in. */
export function dueDiligence(rows: readonly KnowField[]): { done: number; of: number } {
  const dd = rows.filter((r) => r.dd);
  return { done: dd.filter((r) => r.dd!.done).length, of: dd.length };
}
