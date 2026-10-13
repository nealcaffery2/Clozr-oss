// A notary seal rendered as SVG from the commission on file.
//
// The words on the seal follow the state statute, not a generic rubber stamp:
//   Texas    Gov't Code §406.013 — name, a five-point star, "Notary Public,
//            State of Texas", and the commission expiration date.
//   California Gov't Code §8207 — name, county, "Notary Public", commission
//            number, expiration, and California. Circular, the required elements.
//   Florida  §117.05(3) — "Notary Public-State of Florida", name, commission
//            number, and "My Commission Expires" with the date.
//   Elsewhere — name, "Notary Public", the state, expiration, and the
//            commission number when that state requires one on the seal.
//
// This is the image the notary applies. It is not a commission from the
// secretary of state; the commission dates and number have to be the real ones
// entered when the notary is added.

export type NotaryCommission = {
  name: string;
  /** Two-letter USPS code. */
  state: string;
  /** YYYY-MM-DD. */
  expires: string;
  commissionNumber?: string | null;
  county?: string | null;
};

const NEEDS_NUMBER = new Set(['CA', 'FL', 'NY', 'IL', 'AZ', 'NV', 'GA', 'NC', 'OH', 'PA', 'WA', 'MI']);
const NEEDS_COUNTY = new Set(['CA']);

const STATE_NAME: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
  WI: 'Wisconsin', WY: 'Wyoming',
};

export function stateName(code: string): string {
  return STATE_NAME[code.toUpperCase()] ?? code.toUpperCase();
}

export function formatExpiry(iso: string): string {
  const d = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return iso;
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** What is still missing before a lawful seal can be drawn. Empty means it can. */
export function stampGaps(c: NotaryCommission): string[] {
  const gaps: string[] = [];
  const state = c.state.trim().toUpperCase();
  if (!c.name.trim()) gaps.push('Notary name');
  if (!STATE_NAME[state]) gaps.push('Commission state');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.expires)) gaps.push('Commission expiration');
  if (NEEDS_NUMBER.has(state) && !String(c.commissionNumber ?? '').trim()) gaps.push('Commission number');
  if (NEEDS_COUNTY.has(state) && !String(c.county ?? '').trim()) gaps.push('County where the oath is filed');
  return gaps;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

/** Five-point star centered at cx,cy. Texas requires one inside the seal. */
function star(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = (Math.PI / 5) * i - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.4;
    pts.push(`${(cx + Math.cos(rad) * rr).toFixed(1)},${(cy + Math.sin(rad) * rr).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="none" stroke="#1e3a8a" stroke-width="2"/>`;
}

/**
 * Circular seal, 2 inches at 96dpi (192px) is the usual maximum; the viewBox
 * is 240 so it stays sharp. Every required phrase is real text, not a picture
 * of text, so it can be read by a title company that zooms in.
 */
export function renderNotaryStamp(c: NotaryCommission): string {
  const gaps = stampGaps(c);
  if (gaps.length) throw new Error(`Notary seal is missing: ${gaps.join(', ')}`);
  const state = c.state.trim().toUpperCase();
  const name = c.name.trim().toUpperCase();
  const exp = formatExpiry(c.expires);
  const county = String(c.county ?? '').trim();
  const num = String(c.commissionNumber ?? '').trim();
  let top = '';
  let mid: string[] = [];
  let bottom = '';
  if (state === 'TX') {
    top = 'NOTARY PUBLIC';
    mid = [name, 'STATE OF TEXAS'];
    bottom = `COMMISSION EXPIRES ${exp.toUpperCase()}`;
  } else if (state === 'CA') {
    top = 'NOTARY PUBLIC';
    mid = [name, county.toUpperCase() + ' COUNTY', 'CALIFORNIA'];
    bottom = `NO. ${num} · EXPIRES ${exp.toUpperCase()}`;
  } else if (state === 'FL') {
    top = 'NOTARY PUBLIC-STATE OF FLORIDA';
    mid = [name, num ? `COMMISSION NO. ${num}` : ''];
    bottom = `MY COMMISSION EXPIRES ${exp.toUpperCase()}`;
  } else {
    top = 'NOTARY PUBLIC';
    mid = [name, `STATE OF ${stateName(state).toUpperCase()}`, num ? `NO. ${num}` : ''];
    bottom = `COMMISSION EXPIRES ${exp.toUpperCase()}`;
  }
  const aria = state === 'TX'
    ? `Notary seal of ${c.name.trim()}, Notary Public, State of Texas, commission expires ${exp}`
    : `Notary seal of ${c.name.trim()}, Notary Public, State of ${stateName(state)}, commission expires ${exp}`;
  const lines = mid.filter(Boolean).map((line, i) => {
    const y = 118 + i * 16;
    return `<text x="120" y="${y}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="11" font-weight="700" fill="#1e3a8a">${esc(line)}</text>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240" role="img" aria-label="${esc(aria)}">
  <circle cx="120" cy="120" r="112" fill="#fff" stroke="#1e3a8a" stroke-width="4"/>
  <circle cx="120" cy="120" r="102" fill="none" stroke="#1e3a8a" stroke-width="1.25"/>
  <defs>
    <path id="seal-top" d="M36,124 A84,84 0 0,1 204,124"/>
    <path id="seal-bot" d="M44,132 A76,76 0 0,0 196,132"/>
  </defs>
  <text fill="#1e3a8a" font-family="Georgia, 'Times New Roman', serif" font-size="${top.length > 28 ? 9 : 11}" font-weight="700" letter-spacing="0.5">
    <textPath href="#seal-top" startOffset="50%" text-anchor="middle">${esc(top)}</textPath>
  </text>
  ${state === 'TX' ? star(120, 78, 16) : ''}
  ${lines}
  <text fill="#1e3a8a" font-family="Georgia, 'Times New Roman', serif" font-size="8" font-weight="700">
    <textPath href="#seal-bot" startOffset="50%" text-anchor="middle">${esc(bottom)}</textPath>
  </text>
</svg>`;
}
