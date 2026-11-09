'use client';

// "Push to campaign" from People, the Inbox or Buyers: a new campaign with this
// audience, or add it to an existing draft of the same kind (sellers or
// buyers). Hands off to the Campaigns screen.

import React, { useEffect, useState } from 'react';
import { type Audience, type ContactKind, type SmsCampaign, audienceCount, audienceLabel, fillCampaign, listCampaigns } from '@/lib/sms-campaigns';
import { setCampaignHandoff } from './handoff';
import './campaigns.css';

export function PushToCampaign({ audience, contact = 'seller', workspaceId, onClose, onGo, toast }: {
  audience: Audience; contact?: ContactKind; workspaceId: number | null; onClose: () => void; onGo: () => void; toast: (m: string, tone?: 'info' | 'error' | 'success') => void;
}) {
  const [drafts, setDrafts] = useState<SmsCampaign[] | null>(null);
  const [pick, setPick] = useState('new');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    listCampaigns(workspaceId).then((rows) => { if (on) setDrafts(rows.filter((c) => c.contact_kind === contact && (c.status === 'draft' || c.status === 'paused'))); }).catch(() => { if (on) setDrafts([]); });
    return () => { on = false; };
  }, [workspaceId, contact]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const go = async () => {
    if (pick === 'new') { setCampaignHandoff({ audience, campaignId: null, contact }); onGo(); return; }
    const id = Number(pick);
    if (audience.kind !== 'ids') { setCampaignHandoff({ audience, campaignId: id, contact }); onGo(); return; }
    setBusy(true);
    try {
      const c = await fillCampaign(id, audience.ids, false, contact);
      toast(`${(c.added ?? 0).toLocaleString('en-US')} added to the campaign.`, 'success');
      setCampaignHandoff({ audience: { kind: 'none' }, campaignId: id, contact }); onGo();
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not add them', 'error'); } finally { setBusy(false); }
  };
  const count = audienceCount(audience);
  const noun = contact === 'buyer' ? (count === 1 ? 'contact' : 'contacts') : count === 1 ? 'person' : 'people';
  return (
    <div className="cp-dim" onClick={onClose}>
      <div className="cp-dialog cp" role="dialog" aria-modal="true" aria-labelledby="cp-push-t" onClick={(e) => e.stopPropagation()}>
        <div className="cp-card-h" id="cp-push-t">Push {count.toLocaleString('en-US')} {noun} to a campaign</div>
        <div className="cp-dialog-b">
          <span className="cp-help">{audienceLabel(audience)}</span>
          <label className="cp-help" htmlFor="cp-push-pick">Campaign</label>
          <select id="cp-push-pick" className="cp-select" value={pick} onChange={(e) => setPick(e.target.value)} autoFocus>
            <option value="new">New campaign</option>
            {(drafts ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.status}</option>)}
          </select>
          {drafts === null ? <span className="cp-help">Loading drafts…</span> : null}
        </div>
        <div className="cp-dialog-f">
          <button type="button" className="cp-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="cp-btn" data-kind="primary" disabled={busy} onClick={() => void go()}>{busy ? 'Adding…' : pick === 'new' ? 'Open the builder' : 'Add to campaign'}</button>
        </div>
      </div>
    </div>
  );
}
