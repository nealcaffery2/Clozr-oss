// Contract names a person can scan: the street, then what the document is,
// and for an amendment, what it changed ("2016 Meadow Lane closing date
// change to 11/30"). No template file names, no "(1)" copy counters.
//
// A name a person typed is kept: contracts.name_auto is true only while the
// name is one CLOZR made, and a rename turns it off (migration 454).
// Imported by the edge functions (_shared/docs.ts), so no path aliases here.

export type NameField = { label?: string | null; key?: string | null; type?: string | null; value?: string | null };
export type Change = { short: string; long: string };

const KIND_NAME: Record<string, string> = {
  psa: 'purchase agreement', assignment: 'assignment', amendment: 'amendment', addendum: 'addendum',
  termination: 'termination', option: 'option agreement', novation: 'novation', jv: 'JV agreement', offer: 'offer',
};

const SUFFIX = /^(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|ct|court|way|trace|trce|pl|place|cir|circle|pkwy|parkway|hwy|highway|trl|trail|ter|terrace|loop|run|path|pike|sq|square|xing|crossing|cv|cove)\.?$/i;
const DIRECTION = /^(n|s|e|w|ne|nw|se|sw|north|south|east|west|northeast|northwest|southeast|southwest)\.?$/i;

/** "2016 Meadow lane, Richmond, TX 77469" → "2016 Meadow Lane". Null when there is no street. */
export function streetOf(address: string | null | undefined): string | null {
  let s = String(address ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.split(',')[0].trim();
  // No commas ("5056 Larch Ave East Point Ga 30344"): stop after the street suffix and any direction.
  const words = s.split(' ');
  const at = words.findIndex((w, i) => i > 0 && SUFFIX.test(w));
  if (at > 0) {
    // "Ln SW" keeps its direction; "Ave East Point" is the city, so a spelled-out one counts only as the last word.
    const next = words[at + 1];
    const keep = next != null && DIRECTION.test(next) && (next.replace('.', '').length <= 2 || at + 2 === words.length);
    const end = keep ? at + 2 : at + 1;
    s = words.slice(0, end).join(' ');
  }
  // Capitalize words typed all lowercase; leave "NE", "McKinney", "1st" alone.
  s = s.split(' ').map((w) => (/^[a-z][a-z.]*$/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  return s.slice(0, 80) || null;
}

/** "Acme Homes Amendment (1)" → "Acme Homes Amendment"; "PCS (1)" → "PCS". */
export function cleanTemplateName(name: string | null | undefined): string {
  return String(name ?? '').replace(/\s*\(\d+\)\s*$/, '').replace(/\s+/g, ' ').trim();
}

/** The name a new contract gets: "327 S Hillcrest Dr assignment", or the template's own name where the kind says little. */
export function defaultContractName(i: { kind: string; templateName?: string | null; address?: string | null; party?: string | null }): string {
  const street = streetOf(i.address);
  const what = KIND_NAME[i.kind] ?? (cleanTemplateName(i.templateName) || 'contract');
  if (street) return `${street} ${what}`.slice(0, 200);
  const doc = cleanTemplateName(i.templateName) || KIND_NAME[i.kind] || 'Contract';
  return (i.party ? `${doc} - ${i.party}` : doc).slice(0, 200);
}

const EMPTY = /^(n\/?a|none|no|-+|_+|0|\$?0(\.00)?)$/i;
const filled = (v: string | null | undefined) => {
  const s = String(v ?? '').trim();
  return s && !EMPTY.test(s) && !s.startsWith('data:') ? s : null;
};

function shortDate(v: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return `${Number(iso[2])}/${Number(iso[3])}`;
  const mdy = /^(\d{1,2})\/(\d{1,2})\/\d{2,4}$/.exec(v);
  return mdy ? `${Number(mdy[1])}/${Number(mdy[2])}` : null;
}

function money(v: string): string | null {
  const n = Number(v.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? `$${Math.round(n).toLocaleString('en-US')}` : null;
}

const tag = (f: NameField) => `${f.key ?? ''} ${f.label ?? ''}`.toLowerCase();
const SKIP = /(property\.address|property address|date signed|doc\.date|signature|initial)/;
const OTHER = /(other|modification|amend\.other)/;

/** The free-text "Other modifications" on an amendment, if anyone wrote one. */
export function otherModifications(fields: NameField[]): string | null {
  const parts = fields.filter((f) => OTHER.test(tag(f)) || (!f.label && !f.key && f.type === 'text')).map((f) => filled(f.value)).filter((v): v is string => !!v);
  return parts.length ? parts.join(' ').replace(/\s+/g, ' ').slice(0, 1500) : null;
}

/** What an amendment's filled fields change, in the order a TC reads them. Free text is left to otherModifications. */
export function amendmentChanges(fields: NameField[]): Change[] {
  const out: Change[] = [];
  const add = (c: Change) => { if (!out.some((x) => x.short === c.short)) out.push(c); };
  for (const f of fields) {
    const t = tag(f);
    const v = filled(f.value);
    if (!v || SKIP.test(t) || OTHER.test(t)) continue;
    if (/waive/.test(t)) {
      if (/^(y|yes|true|x|waive)/i.test(v)) add({ short: 'option waiver', long: 'option waived' });
    } else if (/option/.test(t) && /(end|extend|date|period)/.test(t)) {
      const d = shortDate(v);
      add({ short: 'option date', long: d ? `option extended to ${d}` : 'option date change' });
    } else if (/clos/.test(t)) {
      const d = shortDate(v);
      add({ short: 'closing date', long: d ? `closing date change to ${d}` : 'closing date change' });
    } else if (/(price|cash portion|purchase amount)/.test(t)) {
      const m = money(v);
      add({ short: 'price', long: m ? `price change to ${m}` : 'price change' });
    } else if (/repair/.test(t)) {
      add({ short: 'repairs', long: 'repairs' });
    } else if (/financ/.test(t)) {
      add({ short: 'financing', long: 'financing change' });
    }
  }
  return out;
}

/** An Amend.* token list as name fields (the markdown amendment template). */
export const tokenFields = (tokens: { name: string; value: string }[] | null | undefined): NameField[] =>
  (tokens ?? []).filter((t) => /^amend\./i.test(String(t?.name ?? ''))).map((t) => ({ key: t.name, value: t.value }));

/**
 * "2016 Meadow Lane closing date change to 11/30". One change reads in full;
 * two or more read short ("closing date and price change"). `extra` is a
 * phrase for the free-text modifications ("lender credit $750").
 */
export function amendmentName(street: string | null, changes: Change[], extra?: string | null, kind = 'amendment'): string {
  const phrases = [...changes];
  const x = String(extra ?? '').trim();
  if (x) phrases.push({ short: x, long: x });
  const lead = street ?? (kind === 'addendum' ? 'Addendum' : 'Amendment');
  let what: string;
  if (!phrases.length) what = street ? (KIND_NAME[kind] ?? 'amendment') : '';
  else if (phrases.length === 1) what = phrases[0].long;
  else {
    const s = phrases.map((p) => p.short);
    const list = s.length === 2 ? `${s[0]} and ${s[1]}` : `${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}`;
    what = x ? list : `${list} change`;
  }
  return `${lead}${what ? ` ${what}` : ''}`.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** A name another contract on the deal already has gets the signing date, never "(1)". */
export function uniqueName(name: string, taken: string[], signedOn: string | null): string {
  const lower = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const d = signedOn ? shortDate(signedOn) : null;
  const dated = d ? `${name} signed ${d}` : name;
  if (!lower.has(dated.toLowerCase())) return dated.slice(0, 200);
  for (let n = 2; n < 50; n++) if (!lower.has(`${dated} #${n}`.toLowerCase())) return `${dated} #${n}`.slice(0, 200);
  return dated;
}

/** A phrase from the model, cleaned to fit a name: lowercase lead, no trailing period, short. Null when unusable. */
export function cleanPhrase(raw: string | null | undefined): string | null {
  let s = String(raw ?? '').replace(/[\r\n"“”]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, '');
  if (!s || s.length > 60 || s.split(' ').length > 8) return null;
  if (/^[A-Z][a-z]/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}
