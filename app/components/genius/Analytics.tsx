// The Analytics tab: what the investors around this house actually pay. Flippers
// as a share of ARV, landlords against the 1% rule, and Investor Comps — the
// run's own investor purchases, filtered like comps, giving an Est. Investor
// Price to set next to COMPR's ARV before the assignment price is set.
'use client';

import React, { useMemo, useState } from 'react';
import { type Candidate, type CompOpts, type Subject, analytics, investorComps, investorPrice, KIND_COLOR, KIND_LABEL } from '@/lib/genius';
import { Control, FAINT, GREEN, HAIR, INK, LINE, MUTED, Modal, PURPLE, Pill, btn, money, sectionLabel, when } from './parts';

function Card({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: '12px', padding: '13px 14px', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '10px' }}>
        <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: color }} />
        <span style={{ fontSize: '13px', fontWeight: 700, color: INK }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function Row({ k, v, hint }: { k: string; v: React.ReactNode; hint?: string }) {
  return (
    <div title={hint} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '5px 0', borderTop: `1px solid ${HAIR}`, fontSize: '12.5px' }}>
      <span style={{ color: MUTED }}>{k}</span>
      <span style={{ fontWeight: 650, color: INK, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{v}</span>
    </div>
  );
}

/** A bar from 0 to 120% with a marker; green when the number sits where it should. */
function Meter({ value, max, good, label, suffix }: { value: number | null; max: number; good: (v: number) => boolean; label: string; suffix: string }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const col = value == null ? FAINT : good(value) ? GREEN : '#b45309';
  return (
    <div style={{ marginTop: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: MUTED, marginBottom: '4px' }}>
        <span>{label}</span><strong style={{ color: col }}>{value == null ? '—' : `${value}${suffix}`}</strong>
      </div>
      <div style={{ height: '7px', borderRadius: '99px', background: HAIR, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: col, borderRadius: '99px' }} />
      </div>
    </div>
  );
}

const range = (r: [number, number] | null, f: (n: number) => string) => (r ? `${f(r[0])} – ${f(r[1])}` : '—');

export function Analytics({ cands, subject, isMobile }: { cands: Candidate[]; subject: Subject | null; isMobile: boolean }) {
  const a = useMemo(() => analytics(cands, subject), [cands, subject]);
  const [comps, setComps] = useState(false);
  const psf = (n: number) => `$${Math.round(n)}`;
  return (
    <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: '8px' }}>
        {[
          ['Unique buyers', a.unique_buyers.toLocaleString('en-US')],
          ['Properties', a.properties.toLocaleString('en-US')],
          ['Avg flip hold', a.avg_days_held ? `${Math.round(a.avg_days_held)} days` : '—'],
          ['Est. rent', a.rent ? `${money(a.rent)}/mo` : '—'],
        ].map(([k, v]) => (
          <div key={k} style={{ background: '#fafafa', border: `1px solid ${HAIR}`, borderRadius: '10px', padding: '9px 11px' }}>
            <div style={{ fontSize: '11.5px', fontWeight: 500, color: MUTED }}>{k}</div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: INK, marginTop: '2px', fontVariantNumeric: 'tabular-nums' }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '12px' }}>
        <Card title={`Flippers · ${a.flips.buyers}`} color={KIND_COLOR.flipper}>
          <Row k="Avg purchase" v={money(a.flips.avg)} hint={`${a.flips.priced} of ${a.flips.purchases} buys have a price`} />
          <Row k="Range" v={range(a.flips.range, money)} />
          <Row k="Avg $/sqft" v={a.flips.avg_ppsf ? psf(a.flips.avg_ppsf) : '—'} />
          <Row k="$/sqft range" v={range(a.flips.ppsf_range, psf)} />
          <Meter value={a.flip_pct_arv} max={120} good={(v) => v <= 75} label={`Paid as % of ARV${a.arv ? ` (${money(a.arv)})` : ''}`} suffix="%" />
        </Card>
        <Card title={`Landlords · ${a.holds.buyers}`} color={KIND_COLOR.landlord}>
          <Row k="Avg purchase" v={money(a.holds.avg)} hint={`${a.holds.priced} of ${a.holds.purchases} buys have a price`} />
          <Row k="Range" v={range(a.holds.range, money)} />
          <Row k="Avg $/sqft" v={a.holds.avg_ppsf ? psf(a.holds.avg_ppsf) : '—'} />
          <Row k="$/sqft range" v={range(a.holds.ppsf_range, psf)} />
          <Meter value={a.one_pct} max={1.6} good={(v) => v >= 1} label={`1% rule (rent ${a.rent ? money(a.rent) : '—'} ÷ avg price)`} suffix="%" />
        </Card>
      </div>
      {a.non_disclosure ? (
        <div style={{ fontSize: '11.5px', color: MUTED, lineHeight: 1.5 }}>Some sales here are in a non-disclosure state: prices come from MLS where it has them, and sales with no price are counted but not averaged.</div>
      ) : null}
      <div>
        <button type="button" onClick={() => setComps(true)} style={btn('purple')}>Investor comps</button>
      </div>
      {comps ? <CompsModal cands={cands} subject={subject} isMobile={isMobile} onClose={() => setComps(false)} /> : null}
    </div>
  );
}

function CompsModal({ cands, subject, isMobile, onClose }: { cands: Candidate[]; subject: Subject | null; isMobile: boolean; onClose: () => void }) {
  const [o, setO] = useState<CompOpts>({ radius_mi: 1, months: 12, beds: null, baths: null, sqft_band: 0.2, year_min: null, year_max: null });
  const [off, setOff] = useState<Record<string, boolean>>({});
  const rows = useMemo(() => investorComps(cands, subject, o), [cands, subject, o]);
  const est = useMemo(() => investorPrice(rows.filter((r) => !off[r.id]), subject), [rows, off, subject]);
  const set = (p: Partial<CompOpts>) => setO((x) => ({ ...x, ...p }));
  const arv = subject?.arv ?? null;
  return (
    <Modal title="Investor comps" onClose={onClose} isMobile={isMobile} width={880}>
      <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(3, 1fr)', gap: '10px', borderBottom: `1px solid ${HAIR}` }}>
        <div>
          <div style={sectionLabel}>Est. investor price</div>
          <div style={{ fontSize: '22px', fontWeight: 750, color: PURPLE }}>{money(est.price)}</div>
          <div style={{ fontSize: '11.5px', color: MUTED }}>{est.ppsf ? `$${est.ppsf}/sqft` : '—'} · {est.n} comp{est.n === 1 ? '' : 's'}{subject?.sqft ? ` × ${subject.sqft.toLocaleString('en-US')} sf` : ''}</div>
        </div>
        <div>
          <div style={sectionLabel}>ARV (deal / COMPR)</div>
          <div style={{ fontSize: '22px', fontWeight: 750, color: INK }}>{money(arv)}</div>
          <div style={{ fontSize: '11.5px', color: MUTED }}>{est.price && arv ? `Investors pay ~${Math.round((est.price / arv) * 100)}% of ARV here` : 'Set the ARV on the deal to compare'}</div>
        </div>
        {!isMobile ? (
          <div>
            <div style={sectionLabel}>Subject</div>
            <div style={{ fontSize: '12.5px', color: INK, fontWeight: 600 }}>{subject?.address ?? '—'}</div>
            <div style={{ fontSize: '11.5px', color: MUTED }}>{subject ? `${subject.beds ?? '?'}bd/${subject.baths ?? '?'}ba · ${subject.sqft?.toLocaleString('en-US') ?? '?'} sf · ${subject.year_built ?? '?'}` : ''}</div>
          </div>
        ) : null}
      </div>
      <div style={{ padding: '12px 16px', display: 'flex', gap: '14px 20px', flexWrap: 'wrap', borderBottom: `1px solid ${HAIR}`, background: '#fcfcfd' }}>
        <Control label="Radius">{[0.5, 1, 2, 3, 5].map((r) => <Pill key={r} on={o.radius_mi === r} onClick={() => set({ radius_mi: r })}>{r} mi</Pill>)}</Control>
        <Control label="Purchased">{[6, 12, 24, 36].map((m) => <Pill key={m} on={o.months === m} onClick={() => set({ months: m })}>{m < 12 ? `${m} mo` : `${m / 12} yr`}</Pill>)}</Control>
        <Control label="Beds">{[null, 2, 3, 4, 5].map((b) => <Pill key={String(b)} on={o.beds === b} onClick={() => set({ beds: b })}>{b ?? 'Any'}</Pill>)}</Control>
        <Control label="Baths">{[null, 1, 2, 3].map((b) => <Pill key={String(b)} on={o.baths === b} onClick={() => set({ baths: b })}>{b ?? 'Any'}</Pill>)}</Control>
        <Control label="Sqft">{[0.1, 0.2, 0.3, null].map((b) => <Pill key={String(b)} on={o.sqft_band === b} onClick={() => set({ sqft_band: b })}>{b ? `±${b * 100}%` : 'Any'}</Pill>)}</Control>
        <Control label="Year built">
          {([[null, null, 'Any'], [null, 1959, '< 1960'], [1960, 1989, '1960–89'], [1990, null, '1990+']] as [number | null, number | null, string][]).map(([lo, hi, l]) => (
            <Pill key={l} on={o.year_min === lo && o.year_max === hi} onClick={() => set({ year_min: lo, year_max: hi })}>{l}</Pill>
          ))}
        </Control>
      </div>
      <div style={{ padding: '4px 16px 14px' }}>
        {rows.length === 0 ? <div style={{ padding: '22px 0', textAlign: 'center', fontSize: '12.5px', color: FAINT }}>No priced investor purchases match. Loosen a filter.</div> : rows.map((r) => (
          <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderTop: `1px solid ${HAIR}`, fontSize: '12px', cursor: 'pointer', opacity: off[r.id] ? 0.45 : 1 }}>
            <input type="checkbox" checked={!off[r.id]} onChange={() => setOff((x) => ({ ...x, [r.id]: !x[r.id] }))} style={{ accentColor: PURPLE }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.address}, {r.city}</span>
              <span style={{ display: 'block', color: MUTED }}>{KIND_LABEL[r.kind]} · {r.buyer} · {r.beds ?? '?'}/{r.baths ?? '?'} · {r.sqft?.toLocaleString('en-US') ?? '?'} sf · {r.year_built ?? '?'} · {r.distance_mi ?? '?'} mi · {when(r.date)}</span>
            </span>
            <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              <span style={{ display: 'block', fontWeight: 700, color: INK }}>{money(r.price)}{r.price_source === 'mls' ? '*' : ''}</span>
              <span style={{ display: 'block', color: MUTED }}>{r.price_per_sqft ? `$${r.price_per_sqft}/sf` : '—'}</span>
            </span>
          </label>
        ))}
        {rows.some((r) => r.price_source === 'mls') ? <div style={{ fontSize: '11px', color: FAINT, marginTop: '6px' }}>* MLS sold price, used where the deed price is not public.</div> : null}
      </div>
    </Modal>
  );
}
