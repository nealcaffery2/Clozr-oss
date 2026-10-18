'use client';

// The record's header: where you came from, who this is, and one toolbar to
// reach them — Call, Text, Email — plus More for everything that moved off
// the page. On a phone: back, the name, a 44px Call, then the same toolbar.

import { EditableName } from './PropertyCard';
import { BackLink } from '@/components/ds/BackLink';
import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { ghostBtn, talkrGhost } from './ui';
import { MoreMenu, type MoreItem } from './MoreMenu';
import { AiAgentToggle } from '@/app/components/ai-agent/AiAgentToggle';
import { dbId } from '@/lib/crm';
import { DEAL_SHEET_BTN } from './deal-sheet-style';
import { CalendarIcon } from '@/app/components/meeting/MeetingInvite';
import { Mail, MessageSquare } from 'lucide-react';

const PhoneIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

export function RecordHeader({ V, onText, onEmail, onMeet, moreItems, showBack = false }: { V: ClozrView; onText: () => void; onEmail: () => void; onMeet?: () => void; moreItems: MoreItem[]; showBack?: boolean }) {
  const first = V.P.name.split(' ')[0];
  // The AI agent switch (migration 123): live records only; the sample graph has no database ids.
  const aiAgent = (mobile: boolean) => (
    <AiAgentToggle workspaceId={V.liveIds?.workspaceId} kind="seller" recordId={V.liveIds && V.P.id ? dbId(V.P.id) : null}
      recordName={V.P.name} canWrite={!!V.liveIds?.canWrite} mobile={mobile} />
  );
  const noEmail = !V.P.email.includes('@');
  const toolbar = (mobile: boolean) => (
    <div role="toolbar" aria-label={'Contact ' + first} style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: mobile ? '1' : 'none' }}>
      {mobile ? null : (
        <button type="button" className="rec-press rec-talkr-ghost rec-tool" onClick={V.callPerson} title="Call (C)" aria-label="Call" style={talkrGhost}>
          <PhoneIcon /><span className="rec-tool-label">Call</span>
        </button>
      )}
      <button type="button" className="rec-press rec-talkr-ghost rec-tool" onClick={onText} title="Text (T)" aria-label="Text"
        style={{ ...talkrGhost, ...(mobile ? { flex: 1, height: '36px', justifyContent: 'center' } : {}) }}>
        {mobile ? null : <MessageSquare size={13} aria-hidden />}<span className="rec-tool-label">Text</span>
      </button>
      <button type="button" className="rec-press rec-ghost rec-tool" onClick={onEmail} aria-label="Email"
        title={noEmail ? 'No email address on this record yet: add one under What we know' : 'Email (E)'}
        style={{ ...ghostBtn, display: 'inline-flex', alignItems: 'center', gap: '6px', ...(mobile ? { flex: 1, height: '36px', justifyContent: 'center' } : {}) }}>
        {mobile ? null : <Mail size={13} aria-hidden />}<span className="rec-tool-label">Email</span>
      </button>
      {onMeet ? (
        <button type="button" data-testid="record-meet" className="rec-press rec-ghost" onClick={onMeet}
          title="Send a meeting invite with a Google Meet link" aria-label={mobile ? 'Send meeting invite' : undefined}
          style={{ ...ghostBtn, display: 'inline-flex', alignItems: 'center', gap: '6px', ...(mobile ? { flex: 'none', width: '40px', height: '36px', justifyContent: 'center', padding: 0 } : {}) }}>
          <CalendarIcon size={13} />{mobile ? null : <span className="rec-tool-label">Meeting</span>}
        </button>
      ) : null}
      {mobile && V.can.tc ? (
        <button type="button" data-testid="record-tc" className="rec-press rec-ghost" onClick={() => V.openClosingFile()} title="Open transaction coordination"
          style={{ ...ghostBtn, fontWeight: 700, color: '#1f7a4d', flex: 1, height: '36px' }}>
          TC
        </button>
      ) : null}
      <MoreMenu items={moreItems} mobile={mobile} />
    </div>
  );

  if (V.isMobile) {
    return (
      <div style={{ flex: 'none', background: '#fff', borderBottom: '1px solid #e4e4e7', padding: '8px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <BackLink to={V.recordBack} style={{ height: '44px', flex: 'none' }} />
          <span style={{ minWidth: 0, flex: 1, textAlign: 'center' }}>
            <h1 style={{ margin: 0, display: 'block', fontSize: '18px', fontWeight: 800, letterSpacing: '-0.03em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{V.recordBack.label} / <EditableName as="span" V={V} style={{ font: 'inherit', letterSpacing: 'inherit' }} /></h1>
            <span style={{ display: 'block', fontSize: '15px', fontWeight: 800, letterSpacing: '-0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{V.P.addr}</span>
            {V.recordDate ? <span data-testid="record-date" style={{ display: 'block', fontSize: '11.5px', color: '#71717a' }}>{V.recordDate}</span> : null}
          </span>
          <button type="button" className="clozr-talkr-btn rec-press" onClick={V.callPerson} aria-label={'Call ' + first} title="Call"
            style={{ width: '44px', height: '44px', borderRadius: '10px', border: 0, background: 'var(--c-talkr)', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer', flex: 'none' }}>
            <PhoneIcon size={18} />
          </button>
        </div>
        <div style={{ display: 'flex', marginTop: '8px', gap: '6px' }}>{aiAgent(true)}{toolbar(true)}</div>
      </div>
    );
  }

  return (
    <>
      {/* The AI agent switch sits at the left: the tools column can run long and spill over this cell's right edge. */}
      <div className="rec-head-addr" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        {/* With the left column folded away its back link goes too; the header keeps one. */}
        {showBack ? (
          <span data-testid="record-back" style={{ flex: 'none' }}><BackLink to={V.recordBack} /></span>
        ) : null}
        {aiAgent(false)}
        <span title={V.P.addr} style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{V.P.addr}</span>
        {V.canEditAddress ? (
          <button type="button" data-testid="edit-address" className="rec-press" onClick={V.editAddress}
            title={V.hasAddress ? 'Edit address' : 'Set address'} aria-label={V.hasAddress ? 'Edit address' : 'Set address'}
            style={{ flex: 'none', width: '24px', height: '24px', display: 'inline-grid', placeItems: 'center', border: 0, borderRadius: '6px', background: 'none', padding: 0, color: '#71717a', cursor: 'pointer' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        ) : null}
        {V.recordDate ? <span data-testid="record-date" style={{ flex: 'none', fontSize: '12px', fontWeight: 500, color: '#71717a', whiteSpace: 'nowrap' }}>{V.recordDate}</span> : null}
      </div>
      <div className="rec-head-tools">
        {V.can.dealSheet ? (
          <button type="button" data-testid="deal-sheet" className="rec-press" onClick={() => V.openDealSheet()} title="Open the deal sheet"
            style={DEAL_SHEET_BTN}>
            Deal sheet
          </button>
        ) : null}
        {V.can.tc ? (
          <button type="button" data-testid="record-tc" className="rec-press rec-ghost" onClick={() => V.openClosingFile()} title="Open transaction coordination"
            style={{ ...ghostBtn, fontWeight: 700, color: '#1f7a4d' }}>
            TC
          </button>
        ) : null}
        {toolbar(false)}
      </div>
    </>
  );
}
