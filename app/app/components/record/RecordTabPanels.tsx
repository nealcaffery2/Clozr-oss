'use client';

// The record's non-feed tabs (record-tabs.ts): Automations, History, Details
// and Submission. The feed tabs draw the activity stream with the composer
// under it; these draw what the deal page used to stack around the feed.

import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ActivityStream } from './ActivityStream';
import { PropertyDetails } from './DealOverview';
import { Identity } from './PropertyCard';
import { RecordActionPlans } from './RailCards';
import { KnowRows, WhatWeKnow } from './WhatWeKnow';
import { label } from './ui';
import { DEAL_SHEET_BTN } from './deal-sheet-style';
import { PriceAmendments } from '@/components/PriceAmendments';
import { Mark } from '@/components/ds/mark';

const money = (n: number | null) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="rec2-row">
      <dt style={label}>{k}</dt>
      <dd style={{ margin: 0, minWidth: 0, fontSize: '13px', fontWeight: 500, color: '#18181b', overflowWrap: 'anywhere' }}>{children}</dd>
    </div>
  );
}

const plain = (v: string | null | undefined) => (v && v.trim() && v.trim() !== '—' ? v : '—');

/** What automations did to this record, beside what is running on it now. */
export function AutomationsPanel({ V, me }: { V: ClozrView; me: string | null }) {
  return (
    <div className="rec2-panel rec2-split">
      <section aria-labelledby="rec2-auto-running" className="rec2-sec">
        <h2 id="rec2-auto-running" className="rec2-title">Running on this record</h2>
        <p className="rec2-hint">An action plan or an AI agent, one at a time.</p>
        <RecordActionPlans V={V} />
      </section>
      <section aria-labelledby="rec2-auto-log" className="rec2-sec">
        <h2 id="rec2-auto-log" className="rec2-title">What automations did</h2>
        <p className="rec2-hint">Plan steps, AI agent runs and the messages an agent sent, newest first.</p>
        <ActivityStream V={V} me={me}
          empty="Nothing automated has touched this record yet. Plan steps and AI agent messages list here as they run." />
      </section>
    </div>
  );
}

/** Changes to the record itself: stage moves, offers, COMPR runs, and the deal's amended prices. */
export function HistoryPanel({ V, me }: { V: ClozrView; me: string | null }) {
  const live = V.liveIds;
  const dealId = V.P.dealDbId ?? live?.dealId ?? null;
  return (
    <div className="rec2-panel">
      <section aria-labelledby="rec2-hist-log" className="rec2-sec">
        <h2 id="rec2-hist-log" className="rec2-title">Stage moves, offers and COMPR runs</h2>
        <p className="rec2-hint">Who changed what, and when. Filter by who with User.</p>
        <ActivityStream V={V} me={me}
          empty="No stage moves, offers or COMPR runs on this record yet. Each one lists here with who made it." />
      </section>
      <section aria-labelledby="rec2-hist-price" className="rec2-sec rec2-sec-rule" data-testid="record-price-history">
        <h2 id="rec2-hist-price" className="rec2-title">Price changes</h2>
        {live && dealId != null ? (
          <div style={{ marginTop: '8px' }}><PriceAmendments workspaceId={live.workspaceId} dealId={dealId} /></div>
        ) : (
          <p className="rec2-hint">Amended prices on the deal list here once this record has a deal in a signed-in workspace.</p>
        )}
      </section>
    </div>
  );
}

/**
 * The house, who works the deal, and what we know. On a phone the property
 * card above the tabs already holds the house's facts, so Details starts at
 * the deal.
 */
export function DetailsPanel({ V, hasSubmission }: { V: ClozrView; hasSubmission: boolean }) {
  return (
    <div className="rec2-panel rec2-details">
      <div className="rec2-details-col">
        {V.isMobile ? null : <PropertyDetails V={V} bare />}
        <section aria-labelledby="rec2-deal-people" className={'rec2-sec' + (V.isMobile ? '' : ' rec2-sec-rule')} data-testid="deal-people">
          <h2 id="rec2-deal-people" className="rec2-title">Deal</h2>
          <div style={{ marginTop: '10px' }}><Identity V={V} compact /></div>
          <dl className="rec2-list" style={{ marginTop: '8px' }}>
            <Row k="Stage">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                <span style={{ color: V.P.stageColor, display: 'inline-flex' }}><Mark label={V.P.stage} /></span>{V.P.stage}
              </span>
            </Row>
            <Row k="Source">{plain(V.P.source)}</Row>
            <Row k="Market">{plain(V.P.market)}</Row>
            {V.recordDate ? <Row k={V.recordDate.startsWith('Submitted') ? 'Submitted' : 'Added'}>{V.recordDate.replace(/^(Submitted|Added) /, '')}</Row> : null}
          </dl>
        </section>
      </div>
      <section aria-labelledby="rec2-know-title" className="rec2-sec rec2-details-col">
        <div className="rec2-card-head" style={{ marginBottom: 0 }}>
          <h2 id="rec2-know-title" className="rec2-title">What we know</h2>
          <span style={label}>{V.liveIds && !V.liveIds.canWrite ? 'Read-only' : 'Click a value to edit'}</span>
        </div>
        {/* The form's answers sit on the Submission tab when the record has one. */}
        <WhatWeKnow V={V} bare omit={hasSubmission ? ['form'] : undefined} />
      </section>
    </div>
  );
}

/** What the record came in with: who sent it, when, at what stage and price, and the form's answers. */
export function SubmissionPanel({ V }: { V: ClozrView }) {
  const sub = V.recordSubmission;
  const focus = V.submissionFocus;
  if (!sub) {
    return (
      <div className="rec2-panel">
        <p className="rec2-empty">This record did not come in as a submission, so there is nothing to show here.</p>
      </div>
    );
  }
  const openSheet = focus ? focus.openDealSheet : V.can.dealSheet ? () => V.openDealSheet() : null;
  return (
    <div className="rec2-panel rec2-details" data-testid="record-submission">
      <section aria-labelledby="rec2-sub-title" className="rec2-sec rec2-details-col">
        <div className="rec2-card-head" style={{ minHeight: '28px', alignItems: 'center' }}>
          <h2 id="rec2-sub-title" className="rec2-title">Submission</h2>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {focus ? (
              <button type="button" className="rec2-chip rec-press" onClick={focus.showAll}>
                {focus.others ? `All from ${sub.from} (${focus.others + 1})` : `All from ${sub.from}`}
              </button>
            ) : null}
            {openSheet ? (
              <button type="button" className="dc2 rec-press" onClick={openSheet} style={{ ...DEAL_SHEET_BTN, height: '28px', padding: '0 12px', fontSize: '12.5px' }}>Deal sheet</button>
            ) : null}
          </div>
        </div>
        <dl className="rec2-list">
          <Row k={sub.fromPartner ? 'Submitted by' : 'Sent in by'}>{sub.from}</Row>
          {sub.vendors.length ? <Row k={sub.vendors.length === 1 ? 'Vendor on the deal' : 'Vendors on the deal'}>{sub.vendors.join(', ')}</Row> : null}
          <Row k="Submitted"><span className="rec-money">{plain(sub.submitted)}</span></Row>
          <Row k="Lead stage">{plain(sub.leadStage ?? V.P.stage)}</Row>
          <Row k="Source">{plain(sub.source)}</Row>
          <Row k="Asking"><span className="rec-money">{sub.asking != null ? money(sub.asking) : plain(V.P.asking)}</span></Row>
          {sub.offer != null ? <Row k="Our offer"><span className="rec-money">{money(sub.offer)}</span></Row> : null}
          {sub.targetAssignment != null ? <Row k="Target assignment"><span className="rec-money">{money(sub.targetAssignment)}</span></Row> : null}
          {sub.owner ? <Row k="Acquisitions">{sub.owner}</Row> : null}
          {sub.underwriter ? <Row k="Underwriter">{sub.underwriter}</Row> : null}
          {sub.comprReportUrl ? (
            <Row k="COMPR report">
              <a href={sub.comprReportUrl} target="_blank" rel="noreferrer" className="rec2-link" style={{ display: 'inline-flex', alignItems: 'center' }}>Open the report</a>
            </Row>
          ) : null}
        </dl>
        {sub.notes ? (
          <div style={{ marginTop: '12px' }}>
            <div style={label}>Submission notes</div>
            <p style={{ margin: '4px 0 0', fontSize: '13px', lineHeight: 1.5, color: '#27272a', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{sub.notes}</p>
          </div>
        ) : null}
      </section>
      <section aria-labelledby="rec2-form-title" className="rec2-sec rec2-details-col">
        <div className="rec2-card-head" style={{ minHeight: '28px', alignItems: 'center' }}>
          <h2 id="rec2-form-title" className="rec2-title">Form answers</h2>
          {sub.hasForm ? <span style={label}>{V.liveIds && !V.liveIds.canWrite ? 'Read-only' : 'Click a value to correct it'}</span> : null}
        </div>
        {sub.hasForm ? (
          <dl style={{ margin: 0 }}><KnowRows V={V} sections={['form']} heads={false} /></dl>
        ) : (
          <p className="rec2-hint" style={{ marginTop: 0 }}>No disposition form came with this submission. What the partner told us is on Details, under What we know.</p>
        )}
      </section>
    </div>
  );
}
