'use client';

/**
 * The right rail of the dialer: the record of whoever is on the line. A
 * seller gets the contact card, the Smart Summary brief (lead memory, the
 * same brief the record shows), the property with COMPR's numbers, and the
 * open tasks. A buyer gets the contact card, the buy box, markets, purchases
 * and the deal they are on. Everything reads from the ClozrRecord the view
 * builds for the number (facts by label), so the rail works before a call,
 * on the sample graph, and on a live workspace alike.
 *
 * Styles: `.rr-*` in clozr/talkr-dialer.css.
 */

import { useState, type ReactNode } from 'react';
import { CheckSquare, ChevronDown, Home, Mail, MapPin, Phone, Sparkles } from 'lucide-react';
import type { ClozrView } from '@/app/clozr/view';
import type { ClozrRecord } from './CallContext';
import { useLeadMemory } from '@/app/components/record/LeadMemoryCard';
import { demoLeadMemory } from '@/lib/lead-memory-client';

const fact = (r: ClozrRecord, label: string) => r.facts.find(([k]) => k === label)?.[1] ?? '';

export function RecordRail({ V, record, onText, actions, between }: {
  V: ClozrView;
  record: ClozrRecord;
  onText: (phone: string) => void;
  /** Request contract and the like, beside Open record. */
  actions?: ReactNode;
  /** Under the Smart Summary, above the property / buy box: the dialer's text thread. */
  between?: ReactNode;
}) {
  return (
    <div className="rr">
      <ContactCard record={record} onText={onText} actions={actions} />
      <SmartBrief V={V} record={record} />
      {between}
      {record.kind === 'seller' ? <SellerCards record={record} /> : <BuyerCards record={record} />}
    </div>
  );
}

function ContactCard({ record, onText, actions }: { record: ClozrRecord; onText: (phone: string) => void; actions?: ReactNode }) {
  return (
    <section className="rr-card" aria-label="Contact">
      <h2 className="rr-name">{record.name}</h2>
      <p className="rr-meta">{record.kind === 'buyer' ? 'Buyer' : 'Seller'}{record.stage ? ` · ${record.stage}` : ''}</p>
      <ul className="rr-rows">
        <li><Phone size={13} aria-hidden /><span>{record.phone || 'No phone'}</span>{record.phone && <button type="button" className="rr-link" onClick={() => onText(record.phone)}>Text</button>}</li>
        {record.email && <li><Mail size={13} aria-hidden /><span className="rr-ellipsis">{record.email}</span></li>}
        {record.address && <li><MapPin size={13} aria-hidden /><span>{record.address}</span></li>}
      </ul>
      <div className="rr-actions">
        <button type="button" className="rr-btn" onClick={record.open}>Open record</button>
        {actions}
      </div>
    </section>
  );
}

// Open or shut, the Smart Summary stays the way the rep left it from one number to the next.
let briefOpen = false;

/**
 * The record's AI brief: lead memory on a signed-in workspace, the scripted
 * brief on the sample graph. Shut by default, like the People record's Smart
 * Summary: one line with its state, the brief a click away.
 */
function SmartBrief({ V, record }: { V: ClozrView; record: ClozrRecord }) {
  const kind = record.kind;
  const recordId = (kind === 'buyer' ? record.buyerId : record.sellerId) ?? null;
  const demo = V.isLiveData ? null : demoLeadMemory(kind, { id: record.name, name: record.name, address: record.address, fields: record.facts.map(([k, v]) => ({ k, v })) });
  const { state, busy, refresh } = useLeadMemory(kind, V.liveIds?.workspaceId ?? null, recordId, demo);
  const [open, setOpenState] = useState(briefOpen);
  const setOpen = (next: boolean) => { briefOpen = next; setOpenState(next); };
  const m = state.at === 'ready' ? state.memory : null;
  if (state.at === 'offline') return null;
  const brief = m?.brief.trim() || null;
  const status = state.at === 'loading' ? 'Reading…'
    : state.at === 'error' ? 'Could not read the brief'
      : !brief ? 'No summary yet'
        : `Updated ${new Date(m!.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  return (
    <section className="rr-card" aria-label="Smart Summary">
      <div className="rr-head">
        <button type="button" className="rr-toggle" aria-expanded={open} aria-controls="rr-brief-body" onClick={() => setOpen(!open)}>
          <Sparkles size={13} aria-hidden />
          <span className="rr-h">Smart Summary</span>
          <span className="rr-status">{status}</span>
          <ChevronDown size={16} aria-hidden className="rr-chev" data-open={open || undefined} />
        </button>
        {open && <button type="button" className="rr-link" onClick={refresh} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</button>}
      </div>
      {open && (
        <div id="rr-brief-body">
          {state.at === 'error' ? <p role="alert" className="rr-brief" style={{ color: 'var(--red)' }}>Could not read the brief. Open the record and refresh it there.</p>
            : <p className="rr-brief">{state.at === 'loading' ? 'Reading the record…' : brief ?? 'Nothing written yet. Refresh reads the calls, texts and notes on the record and writes it.'}</p>}
        </div>
      )}
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  const shown = rows.filter(([, v]) => v && v !== '—');
  if (shown.length === 0) return null;
  return (
    <dl className="rr-facts">
      {shown.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

function SellerCards({ record }: { record: ClozrRecord }) {
  const beds = fact(record, 'Beds/baths');
  const sqft = fact(record, 'Sqft');
  const line = [beds, sqft ? `${sqft} sf` : ''].filter(Boolean).join(' · ');
  return (
    <>
      <section className="rr-card" aria-label="Property">
        <h2 className="rr-h"><Home size={13} aria-hidden />Property</h2>
        {record.address && <p className="rr-addr">{record.address}</p>}
        {line && <p className="rr-meta">{line}</p>}
        <Facts rows={[
          ['Condition', fact(record, 'Condition')],
          ['ARV', fact(record, 'ARV')],
          ['COMPR MAO', fact(record, 'MAO')],
          ['Our offer', fact(record, 'Last offer')],
          ['Asking', fact(record, 'Asking')],
          ['Motivation', fact(record, 'Motivation')],
          ['Timeline', fact(record, 'Timeline')],
        ]} />
      </section>
      <section className="rr-card" aria-label="Open tasks">
        <h2 className="rr-h"><CheckSquare size={13} aria-hidden />Open tasks</h2>
        {record.openTasks.length === 0 ? (
          <p className="rr-meta">Nothing open. The wrap-up adds the next one.</p>
        ) : (
          <ul className="rr-tasks">
            {record.openTasks.map((t, i) => (
              <li key={i}><span>{t.title}</span><span className="rr-due">{t.due}</span></li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function BuyerCards({ record }: { record: ClozrRecord }) {
  const markets = record.address ? record.address.split(',').map((m) => m.trim()).filter(Boolean) : [];
  return (
    <>
      <section className="rr-card" aria-label="Buy box">
        <h2 className="rr-h"><Home size={13} aria-hidden />Buy box</h2>
        <Facts rows={[
          ['Price', fact(record, 'Buy box')],
          ['Type', fact(record, 'Property type')],
          ['Strategy', fact(record, 'Strategy')],
          ['Rehab', fact(record, 'Rehab')],
          ['Ceiling', fact(record, 'Ceiling')],
        ]} />
        {markets.length > 0 && (
          <div className="rr-markets" role="list" aria-label="Markets">
            {markets.map((m) => <span key={m} role="listitem" className="rr-tag">{m}</span>)}
          </div>
        )}
      </section>
      <section className="rr-card" aria-label="Purchases and offers">
        <h2 className="rr-h"><CheckSquare size={13} aria-hidden />Purchases and offers</h2>
        <Facts rows={[
          ['Last purchase', fact(record, 'Last purchase')],
          ['Offers', fact(record, 'Offers')],
          ['Latest offer', fact(record, 'Latest offer')],
          ['On deal', fact(record, 'On deal')],
          ['Last touch', fact(record, 'Last touch')],
        ]} />
        {!fact(record, 'Last purchase') && !fact(record, 'Offers') && <p className="rr-meta">No purchases or offers on record yet.</p>}
      </section>
    </>
  );
}
