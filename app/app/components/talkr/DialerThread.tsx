'use client';

/**
 * The dialer's text thread: the Inbox app's own conversation view
 * (MessagesScreen), held on the number that is up. Same bubbles, sender
 * lines, receipts, scheduled texts, suggested replies and record suggestions
 * as the Inbox; no list and no way off this number.
 */

import { useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { MessagesScreen } from './MessagesScreen';
import { TemplatePicker } from '@/app/components/templates/TemplatePicker';
import type { useTemplates } from '@/app/components/templates/useTemplates';
import { useRep } from '@/app/components/record/QuickReach';
import { useSenders } from '@/app/components/inbox/senders';
import { useScheduled } from '@/lib/use-scheduled';
import { setTalkrDemo } from '@/lib/talkr-web/api';
import { DEMO_TEAM, demoTalkr } from '@/lib/inbox-demo';
import { useSession } from '@/lib/session';
import { fieldsFor, renderMerge } from '@/lib/sms';
// Styles: talkr-inbox.css, loaded once by ClozrShell (see the note there).

/**
 * `demo`: /demo without a Talkr sign-in; the thread reads lib/inbox-demo, as the Inbox does.
 * `fill`: take the height the column leaves; otherwise a fixed height, so the composer stays in reach.
 */
export function DialerThread({ V, e164, demo, fill, templates, onManage }: {
  V: ClozrView; e164: string; demo: boolean; fill: boolean;
  templates: ReturnType<typeof useTemplates>;
  onManage: () => void;
}) {
  const session = useSession();
  // Installed during the first render, before MessagesScreen asks Talkr.
  useState(() => { if (demo) setTalkrDemo(demoTalkr); return null; });
  useEffect(() => {
    if (!demo) return;
    setTalkrDemo(demoTalkr);
    return () => setTalkrDemo(null);
  }, [demo]);
  const userId = session.user?.id ?? null;
  const workspaceId = demo ? null : V.liveIds?.workspaceId ?? null;
  const scheduled = useScheduled(workspaceId);
  const senderFor = useSenders(workspaceId, !!workspaceId, demo ? DEMO_TEAM : V.talkrPhone.data.team);
  const rep = useRep(V);

  return (
    <div className={`talkr-inbox flex flex-col ${fill ? 'min-h-0 flex-1' : 'h-[480px]'}`}>
      <MessagesScreen
        key={e164}
        authed={V.talkrAuthed || demo}
        threadOnly
        onePane
        to={e164}
        receiptsWorkspace={workspaceId}
        placeCall={V.dialE164}
        onNewCall={V.openDialer}
        onRead={V.bellReadNumber}
        recordFor={V.recordForContact}
        scheduled={scheduled}
        live={V.liveIds && !demo ? { workspaceId: V.liveIds.workspaceId, canWrite: V.liveIds.canWrite, me: userId, toast: V.showToast, reload: V.reloadCrm } : null}
        senders={senderFor}
        orgName={V.workspaceName}
        clozrTemplates={({ record, name, phone, insert, close }) => (
          <TemplatePicker
            channel="sms" audience={record?.kind ?? 'any'} templates={templates.templates} team={templates.team} userId={userId}
            loading={templates.loading} error={workspaceId ? templates.error : 'Templates run on a signed-in workspace.'}
            onPick={(t) => insert(renderMerge(t.body_text, fieldsFor(record?.recipient ?? { sellerId: null, name: name ?? '', phone: null }, rep, phone ?? '')))}
            onClose={close} onManage={() => { close(); onManage(); }}
          />
        )}
      />
    </div>
  );
}
