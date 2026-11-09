'use client';

// The record's header: where you came from, who this is, and one toolbar to
// reach them — Call, Text, Email — plus More for everything that moved off
// the page. On a phone: back, the name, a 44px Call, then the same toolbar.

import { EditableName } from './PropertyCard';
import { BackLink } from '@/components/ds/BackLink';
import React from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { Button } from '@/components/ds/Button';
import { MoreMenu, type MoreItem } from './MoreMenu';
import { AiAgentToggle } from '@/app/components/ai-agent/AiAgentToggle';
import { dbId } from '@/lib/crm';
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
  // A 390px phone fits Call (top row), Text and More. Email, the meeting
  // invite and TC move to the top of More instead of running off the screen.
  const phoneMore: MoreItem[] = [
    { key: 'email', label: 'Email', note: noEmail ? 'No address yet' : undefined, group: 'Reach', run: onEmail },
    ...(onMeet ? [{ key: 'meet', label: 'Send a meeting invite', group: 'Reach', run: onMeet }] : []),
    ...(V.can.tc && !V.hasTcFile ? [{ key: 'tc', label: 'Transaction coordination', group: 'Deal', run: () => V.openClosingFile() }] : []),
    ...moreItems,
  ];
  const toolbar = (mobile: boolean) => mobile ? (
    <div role="toolbar" aria-label={'Contact ' + first} style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: '1', minWidth: 0 }}>
      <Button className="rec-tool" onClick={onText} title="Text (T)" aria-label="Text" icon={<MessageSquare size={15} aria-hidden />}
        style={{ flex: 1, height: '44px' }}>
        <span className="rec-tool-label">Text</span>
      </Button>
      <MoreMenu items={phoneMore} mobile />
    </div>
  ) : (
    <div role="toolbar" aria-label={'Contact ' + first} style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: mobile ? '1' : 'none' }}>
      {mobile ? null : (
        <Button className="rec-tool" onClick={V.callPerson} title="Call (C)" aria-label="Call" icon={<PhoneIcon />}>
          <span className="rec-tool-label">Call</span>
        </Button>
      )}
      <Button className="rec-tool" onClick={onText} title="Text (T)" aria-label="Text" icon={mobile ? undefined : <MessageSquare size={13} aria-hidden />}
        style={mobile ? { flex: 1, height: '36px' } : undefined}>
        <span className="rec-tool-label">Text</span>
      </Button>
      <Button className="rec-tool" onClick={onEmail} aria-label="Email" icon={mobile ? undefined : <Mail size={13} aria-hidden />}
        title={noEmail ? 'No email address on this record yet: add one under What we know' : 'Email (E)'}
        style={mobile ? { flex: 1, height: '36px' } : undefined}>
        <span className="rec-tool-label">Email</span>
      </Button>
      {onMeet ? (
        <Button data-testid="record-meet" onClick={onMeet} icon={<CalendarIcon size={13} />}
          title="Send a meeting invite with a Google Meet link" aria-label={mobile ? 'Send meeting invite' : undefined}
          style={mobile ? { flex: 'none', width: '40px', height: '36px', padding: 0 } : undefined}>
          {mobile ? null : <span className="rec-tool-label">Meeting</span>}
        </Button>
      ) : null}
      {mobile && V.can.tc ? (
        <Button data-testid="record-tc" onClick={() => V.openClosingFile()} title="Open transaction coordination" style={{ flex: 1, height: '36px' }}>
          TC
        </Button>
      ) : null}
      <MoreMenu items={moreItems} mobile={mobile} />
    </div>
  );

  if (V.isMobile) {
    return (
      <div style={{ flex: 'none', background: 'var(--surface, #fff)', borderBottom: '1px solid var(--divider, #e4e4e7)', padding: '8px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <BackLink to={V.recordBack} style={{ height: '44px', flex: 'none' }} />
          <span style={{ minWidth: 0, flex: 1, textAlign: 'center' }}>
            {/* The back link already names where you came from, so the title is the name alone. */}
            <h1 className="ds-title" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}><EditableName as="span" V={V} style={{ font: 'inherit', letterSpacing: 'inherit' }} /></h1>
            <span title={V.P.addr} style={{ display: 'block', fontSize: '12.5px', fontWeight: 500, color: 'var(--ink-3, #3f3f46)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{V.P.addr}</span>
            {V.recordDate ? <span data-testid="record-date" style={{ display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)' }}>{V.recordDate}</span> : null}
          </span>
          <Button kind="solid" onClick={V.callPerson} aria-label={'Call ' + first} title="Call" icon={<PhoneIcon size={16} />}
            style={{ height: '44px', padding: '0 14px' }}>
            Call
          </Button>
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
            style={{ flex: 'none', width: '24px', height: '24px', display: 'inline-grid', placeItems: 'center', border: 0, borderRadius: '6px', background: 'none', padding: 0, color: 'var(--meta, #71717a)', cursor: 'pointer' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
        ) : null}
        {V.recordDate ? <span data-testid="record-date" style={{ flex: 'none', fontSize: '12px', fontWeight: 500, color: 'var(--meta, #71717a)', whiteSpace: 'nowrap' }}>{V.recordDate}</span> : null}
      </div>
      <div className="rec-head-tools">
        {V.can.dealSheet ? (
          <Button kind="solid" data-testid="deal-sheet" onClick={() => V.openDealSheet()} title="Open the deal sheet">
            Deal sheet
          </Button>
        ) : null}
        {V.can.tc ? (
          <Button data-testid="record-tc" onClick={() => V.openClosingFile()} title="Open transaction coordination">
            TC
          </Button>
        ) : null}
        {toolbar(false)}
      </div>
    </>
  );
}
