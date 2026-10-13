// One found buyer: who they are (the LLC and the person behind it), what they
// bought near this house and for how much, how likely they are to buy this one,
// and the numbers to reach them — click to call through the dialer, mark good
// or wrong, add one by hand. The purchase history and the listing agent on each
// buy fold away under the card.
'use client';

import React, { useState } from 'react';
import { reachClick } from '@/app/components/record/reach';
import { type Candidate, type MarkedPhone, type PhoneMark, KIND_BADGE, KIND_LABEL, METHOD_LABEL, emailsOf, headline, phonesOf } from '@/lib/genius';
import { Badge, GREEN, HAIR, ICON, INK, Icon, MUTED, PURPLE, PURPLE_TINT, RED, Ring, SHADOW, Stat, btn, input, money, sectionLabel, shortMoney, tier, when } from './parts';

type Props = {
  c: Candidate;
  isMobile: boolean; canWrite: boolean;
  selected: boolean; onSelect: () => void;
  open: boolean; onToggle: () => void;
  active: boolean; onHover: (on: boolean) => void;
  tracing: boolean; traceError?: string;
  adding: boolean;
  onTrace: () => void; onAdd: () => void;
  foundVia?: string;
  onMarketing?: () => void;
  /** Skip-trace if needed, then put this buyer on the call queue. */
  onQueue?: () => void;
  onCall?: (name: string, phone: string) => void;
  onOpenBuyer?: (id: number) => void;
  onMark: (number: string, mark: PhoneMark) => void;
  onAddPhone: (number: string) => void;
  onPortfolio: () => void;
};

const priceLine = (p: Candidate['purchases'][number]) =>
  p.price ? `${money(p.price)}${p.price_source === 'mls' ? ' (MLS est.)' : ''}` : p.non_disclosure ? 'Not disclosed' : '—';

export function BuyerCard(p: Props) {
  const { c, isMobile, canWrite } = p;
  const [newPhone, setNewPhone] = useState('');
  const t = tier(c.likelihood);
  const phones = phonesOf(c);
  const emails = emailsOf(c);
  const last = c.purchases[0];
  const person = c.corporate ? c.people[0] ?? phones.find((x) => x.person)?.person ?? null : null;
  const callName = person ?? c.owner_name;
  // How this buyer was found, and the proof: the strongest method up top, every piece of evidence under the reasons.
  const found = headline(c);
  const methodTint = (m: string): [string, string] => m === 'homefull' ? ['#9a3412', '#ffedd5'] : m === 'wholesale_snipe' ? ['#be123c', '#ffe4e6'] : m === 'wholesaler_buyers' ? ['#6d28d9', '#ede9fe'] : m === 'reverse_llc' ? ['#0369a1', '#e0f2fe'] : m === 'landlord' ? ['#15803d', '#dcfce7'] : ['#3f3f46', '#f4f4f5'];

  const phoneRow = (ph: MarkedPhone & { person: string | null }, compact: boolean) => (
    <div key={ph.number} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: compact ? '1px 0' : '3px 0', fontSize: '12px', opacity: ph.status === 'wrong' ? 0.5 : 1 }}>
      {p.onCall && !ph.dnc && ph.status !== 'wrong' ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); p.onCall!(ph.person ?? callName, ph.number); }} title="Call through the dialer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', border: 0, background: 'none', padding: '2px 0', color: INK, fontWeight: 600, cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ display: 'inline-grid', placeItems: 'center', width: '20px', height: '20px', borderRadius: '6px', background: '#E7F8F1', color: GREEN }}><Icon d={ICON.phone} size={11} /></span>{ph.number}
        </button>
      ) : <span style={{ color: INK, fontWeight: 600, textDecoration: ph.status === 'wrong' ? 'line-through' : 'none', fontVariantNumeric: 'tabular-nums' }}>{ph.number}</span>}
      <span style={{ color: MUTED, fontSize: '11px' }}>{ph.type ?? ''}</span>
      {ph.dnc ? <Badge color={RED} tint="#fef2f2" title="On the Do Not Call list: never texted in bulk or auto-dialed">DNC</Badge> : null}
      {ph.status === 'good' ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', color: GREEN, fontSize: '11px', fontWeight: 600 }}><Icon d={ICON.check} size={11} stroke={2.5} />Good</span> : null}
      {canWrite && !compact ? (
        <span style={{ display: 'inline-flex', gap: '3px', marginLeft: 'auto' }}>
          <button type="button" title="Mark good" aria-label={`Mark ${ph.number} good`} onClick={(e) => { e.stopPropagation(); p.onMark(ph.number, 'good'); }} style={{ ...btn('ghost', true), height: '24px', width: '24px', padding: 0, color: GREEN }}><Icon d={ICON.check} size={12} stroke={2.5} /></button>
          <button type="button" title="Wrong number" aria-label={`Mark ${ph.number} as a wrong number`} onClick={(e) => { e.stopPropagation(); p.onMark(ph.number, 'wrong'); }} style={{ ...btn('ghost', true), height: '24px', width: '24px', padding: 0, color: RED }}><Icon d={ICON.x} size={12} stroke={2.5} /></button>
        </span>
      ) : null}
    </div>
  );

  const actions = (
    <>
      {canWrite && !c.contacts && !p.tracing ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); p.onTrace(); }} style={{ ...btn('ghost'), flex: isMobile ? 1 : 'none' }}>{p.traceError ? 'Retry skip trace' : 'Skip trace'}</button>
      ) : null}
      {p.tracing ? <span role="status" style={{ fontSize: '12px', color: MUTED }}>Tracing…</span> : null}
      {c.matched_buyer_id ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); p.onOpenBuyer?.(c.matched_buyer_id!); }} style={{ ...btn('ghost'), color: GREEN, flex: isMobile ? 1 : 'none' }}><Icon d={ICON.check} size={13} stroke={2.5} />In buyers</button>
      ) : canWrite ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); p.onAdd(); }} disabled={p.adding} style={{ ...btn('solid'), flex: isMobile ? 1 : 'none', opacity: p.adding ? 0.6 : 1 }}>{p.adding ? 'Adding…' : 'Add to buyers'}</button>
      ) : null}
      {canWrite && p.onMarketing ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); p.onMarketing?.(); }} disabled={p.adding} style={{ ...btn('ghost'), flex: isMobile ? 1 : 'none' }}>Add to marketing list</button>
      ) : null}
      {canWrite && p.onQueue ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); p.onQueue?.(); }} disabled={p.adding} style={{ ...btn('ghost'), flex: isMobile ? 1 : 'none' }}>Add to call queue</button>
      ) : null}
    </>
  );

  return (
    <div onMouseEnter={() => p.onHover(true)} onMouseLeave={() => p.onHover(false)} data-active={p.active || undefined}
      style={{ borderBottom: `1px solid ${HAIR}`, background: p.active ? '#F0FAF5' : p.open ? '#fcfcfd' : '#fff', boxShadow: p.active ? `inset 3px 0 0 ${PURPLE}` : 'none' }}>
      <div role="button" tabIndex={0} onClick={p.onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onToggle(); } }}
        style={{ display: 'flex', alignItems: 'flex-start', gap: isMobile ? '10px' : '12px', padding: isMobile ? '12px 12px 10px' : '13px 14px', cursor: 'pointer' }}>
        <input type="checkbox" checked={p.selected} onClick={(e) => e.stopPropagation()} onChange={p.onSelect} aria-label={`Select ${c.owner_name}`}
          style={{ width: '15px', height: '15px', marginTop: '15px', accentColor: PURPLE, flex: 'none' }} />
        <Ring value={c.likelihood} color={t.color} text={t.text} label={t.label} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <span title={c.owner_name} style={{ fontSize: '13.5px', fontWeight: 650, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{c.owner_name}</span>
            <Badge {...KIND_BADGE[c.kind]}>{KIND_LABEL[c.kind]}</Badge>
          </div>
          {person || (!c.corporate && c.people.length > 1) ? (
            <div style={{ fontSize: '12px', color: '#3f3f46', marginTop: '2px' }}>{c.corporate ? `Behind it: ${person}` : c.people.join(' · ')}</div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
            {c.smart_match ? <Badge color="#08694C" tint={PURPLE_TINT} title="Top tier for this deal"><Icon d={ICON.sparkle} size={10} stroke={2.4} />SmartMatch #{c.smart_rank}</Badge> : null}
            {c.matched_buyer_id ? <Badge color={GREEN} tint="#E7F8F1" title={`Matched by ${c.match_by}`}>In your buyers</Badge> : null}
            {found ? (c.methods ?? [found.method]).map((m) => { const [col, tint] = methodTint(m); return <Badge key={m} color={col} tint={tint} title={c.evidence?.find((e) => e.method === m)?.summary ?? METHOD_LABEL[m]}>{METHOD_LABEL[m]}</Badge>; })
              : p.foundVia ? <Badge color="#3f3f46" tint="#f4f4f5">{p.foundVia}</Badge> : null}
            {c.sources?.length ? (
              <Badge title="Which data source found this buyer" {...(c.sources.length > 1 ? { color: '#15803d', tint: '#dcfce7' } : c.sources[0] === 'attom' ? { color: '#0369a1', tint: '#e0f2fe' } : {})}>
                {c.sources.length > 1 ? 'Both sources' : c.sources[0] === 'attom' ? 'ATTOM only' : 'RealEstateAPI only'}
              </Badge>
            ) : null}
            {c.institutional ? <Badge color="#92400e" tint="#fef3c7">Institutional</Badge> : null}
            {c.portfolio_count && c.portfolio_count > 1 ? (
              <button type="button" onClick={(e) => { e.stopPropagation(); p.onPortfolio(); }} title="See their portfolio"
                style={{ border: 0, boxShadow: SHADOW.ring, background: '#fff', borderRadius: '6px', fontSize: '11px', fontWeight: 600, lineHeight: '16px', minHeight: '24px', color: '#3f3f46', padding: '0 7px', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
                {c.portfolio_count.toLocaleString('en-US')} owned
              </button>
            ) : null}
          </div>
          {last ? (
            <div style={{ fontSize: '12px', color: MUTED, marginTop: '6px', lineHeight: 1.45 }}>
              <span style={{ color: '#3f3f46' }}>{last.role === 'flip' && last.resale_date ? 'Flipped' : last.role === 'build' ? 'Built on' : 'Bought'} {last.address}</span>
              {last.distance_mi != null ? ` · ${last.distance_mi} mi` : ''}
              {` · ${last.beds ?? '?'}bd/${last.baths ?? '?'}ba`}{last.sqft ? ` · ${last.sqft.toLocaleString('en-US')} sf` : ''}{last.year_built ? ` · ${last.year_built}` : ''}
              {` · ${priceLine(last)} · ${when(last.date)}`}
              {last.days_held ? ` · held ${last.days_held}d` : ''}{last.resale_price ? `, resold ${shortMoney(last.resale_price)}` : ''}
              {last.non_disclosure && !last.price ? <span title="Non-disclosure state: the price is not public record" style={{ marginLeft: '5px' }}><Badge>ND</Badge></span> : null}
            </div>
          ) : null}
          <div style={isMobile ? { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '6px 16px', marginTop: '8px' } : { display: 'flex', flexWrap: 'wrap', gap: '6px 20px', marginTop: '8px' }}>
            <Stat label="Avg paid" value={isMobile ? shortMoney(c.avg_price) : money(c.avg_price)} strong hint={c.non_disclosure ? 'Some prices not disclosed' : undefined} />
            <Stat label="Buys here" value={c.purchase_count} />
            <Stat label="Last buy" value={when(c.last_purchase)} />
            {!isMobile ? <Stat label="Pays" value={c.cash === null ? '—' : c.cash ? 'Cash' : 'Financed'} /> : null}
            {!isMobile && c.avg_days_held ? <Stat label="Avg hold" value={`${c.avg_days_held}d`} /> : null}
          </div>
          {c.evidence?.length ? (
            <div style={{ marginTop: '7px', display: 'grid', gap: '3px' }}>
              {c.evidence.map((e, i) => { const [col] = methodTint(e.method); return (
                <div key={i} style={{ fontSize: '11.5px', color: '#3f3f46', lineHeight: 1.45 }}>
                  <b style={{ color: col }}>{METHOD_LABEL[e.method]}:</b> {e.summary}{e.confidence != null && e.confidence < 0.95 ? <span style={{ color: MUTED }}> · {Math.round(e.confidence * 100)}% sure</span> : null}
                </div>
              ); })}
            </div>
          ) : null}
          {c.reasons.length ? <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '7px', lineHeight: 1.45 }}>{c.reasons.join(' · ')}</div> : null}
          {phones.length ? (
            <div style={{ marginTop: '7px', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
              {phones.slice(0, 3).map((ph) => phoneRow(ph, true))}
              {emails[0] ? <a href={`mailto:${emails[0]}`} onClick={(e) => reachClick(e, 'email', { name: callName ?? '', email: emails[0], audience: 'buyer' })} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: INK, marginTop: '2px', textDecoration: 'none' }}><span style={{ display: 'inline-grid', placeItems: 'center', width: '20px', height: '20px', borderRadius: '6px', background: '#f4f4f5', color: MUTED }}><Icon d={ICON.mail} size={11} /></span>{emails[0]}</a> : null}
            </div>
          ) : c.contacts ? <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '7px' }}>Skip trace found no phones or emails.</div> : null}
          {p.traceError ? <div style={{ fontSize: '11.5px', color: RED, marginTop: '6px' }}>{p.traceError}</div> : null}
        </div>
        {!isMobile ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px', flex: 'none' }} onClick={(e) => e.stopPropagation()}>
            <Ring value={c.pct_of_arv} color="#52525b" label="% of ARV" suffix="%" size={40} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'stretch' }}>{actions}</div>
          </div>
        ) : null}
      </div>

      {isMobile && canWrite ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '0 12px 12px', flexWrap: 'wrap' }}>
          <Ring value={c.pct_of_arv} color="#52525b" suffix="%" size={34} />
          {actions}
        </div>
      ) : null}

      {p.open ? (
        <div style={{ padding: isMobile ? '0 12px 14px' : '0 14px 14px 85px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '14px' }}>
          <div>
            <div style={sectionLabel}>What they bought here</div>
            {c.purchases.map((x, i) => (
              <div key={i} style={{ padding: '7px 0', borderTop: i ? `1px solid ${HAIR}` : undefined, fontSize: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: INK, fontWeight: 600 }}>
                    {x.address}<span style={{ color: MUTED, fontWeight: 400 }}>, {x.city} {x.zip}</span>
                  </span>
                  <span style={{ fontWeight: 650, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: INK }}>{priceLine(x)}</span>
                </div>
                <div style={{ color: MUTED, marginTop: '2px', lineHeight: 1.5 }}>
                  <Badge {...KIND_BADGE[x.role === 'flip' ? 'flipper' : x.role === 'build' ? 'builder' : 'landlord']}>{x.role === 'flip' ? (x.resale_date ? 'Flip' : 'Flip in progress') : x.role === 'build' ? 'Build' : 'Hold'}</Badge>
                  {` ${x.beds ?? '?'}/${x.baths ?? '?'} · ${x.sqft ? x.sqft.toLocaleString('en-US') + ' sf' : '—'}${x.year_built ? ` · ${x.year_built}` : ''} · ${when(x.date)}`}
                  {x.distance_mi != null ? ` · ${x.distance_mi} mi` : ''}{x.price_per_sqft ? ` · $${x.price_per_sqft}/sf` : ''}
                  {x.resale_price || x.resale_date ? ` · resold ${x.resale_price ? money(x.resale_price) : ''} ${when(x.resale_date)}${x.days_held ? ` (${x.days_held}d)` : ''}` : ''}
                  {x.financed === false ? ' · cash' : x.financed ? ' · financed' : ''}
                  {x.zillow ? <> · <a href={x.zillow} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: PURPLE }}>Zillow</a></> : null}
                </div>
                {x.agent?.name ? (
                  <div style={{ color: MUTED, marginTop: '2px' }}>Agent on the sale: {x.agent.name}{x.agent.office ? `, ${x.agent.office}` : ''}{x.agent.phone ? ` · ${x.agent.phone}` : ''}{x.agent.email ? ` · ${x.agent.email}` : ''}</div>
                ) : null}
              </div>
            ))}
            {c.mailing ? <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '9px' }}>Mails to {c.mailing}</div> : null}
            {c.portfolio_count && c.portfolio_count > 1 ? (
              <button type="button" onClick={(e) => { e.stopPropagation(); p.onPortfolio(); }} style={{ ...btn('ghost', true), marginTop: '9px' }}>View all {c.portfolio_count} properties</button>
            ) : null}
          </div>
          <div onClick={(e) => e.stopPropagation()}>
            <div style={sectionLabel}>Contact</div>
            {!c.contacts ? (
              <div style={{ fontSize: '12px', color: MUTED, lineHeight: 1.45 }}>{p.tracing ? 'Tracing…' : 'Skip trace to pull phones and emails. An owner already traced in the last 90 days comes back free.'}</div>
            ) : (
              <>
                {phones.map((ph) => phoneRow(ph, false))}
                {emails.map((e) => <div key={e} style={{ fontSize: '12px', padding: '2px 0', overflow: 'hidden', textOverflow: 'ellipsis' }}><a href={`mailto:${e}`} onClick={(ev) => reachClick(ev, 'email', { name: callName ?? '', email: e, audience: 'buyer' })} style={{ color: INK }}>{e}</a></div>)}
                {c.contacts.map((h, i) => h.name ? <div key={i} style={{ fontSize: '11.5px', color: MUTED, marginTop: '4px' }}>{h.name}{h.mailing ? ` · ${h.mailing}` : ''}</div> : null)}
              </>
            )}
            {canWrite ? (
              <form onSubmit={(e) => { e.preventDefault(); const n = newPhone.replace(/[^\d+]/g, ''); if (n.replace(/\D/g, '').length >= 10) { p.onAddPhone(newPhone.trim()); setNewPhone(''); } }}
                style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Add a phone" aria-label={`Add a phone for ${c.owner_name}`} inputMode="tel" style={{ ...input, height: '28px', flex: 1, fontSize: '12px' }} />
                <button type="submit" style={btn('ghost', true)}>Add</button>
              </form>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
