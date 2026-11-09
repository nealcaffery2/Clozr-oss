'use client';

// Bulk SMS campaigns: the list, and the builder for one. Reads and writes
// sms_campaigns directly (lib/sms-campaigns.ts); the scheduled-send tick
// delivers. Takes from the shell the workspace, the mobile layout, the toast,
// the saved smart lists and the way to Settings' templates.

import React, { useCallback, useEffect, useState } from 'react';
import type { ClozrView } from '@/app/clozr/view';
import { CampaignEditor } from '@/app/components/campaigns/CampaignEditor';
import { CampaignsList } from '@/app/components/campaigns/CampaignsList';
import { DealBlasts } from '@/app/components/campaigns/DealBlasts';
import { type Blast, loadBlasts } from '@/lib/dispo-campaign';
import { takeCampaignHandoff } from '@/app/components/campaigns/handoff';
import { openSettings } from '@/lib/settings-sections';
import { deleteCampaign, exportRecipients, listCampaigns, newDraft, type Draft, type SmsCampaign } from '@/lib/sms-campaigns';
import { useSmsLines } from '@/lib/sms-from';
import '@/app/components/campaigns/campaigns.css';

type Open = { campaign: SmsCampaign | null; draft: Draft } | null;

export function Campaigns({ V }: { V: ClozrView }) {
  const workspaceId = V.liveIds?.workspaceId ?? null;
  const live = !!V.liveIds;
  const [rows, setRows] = useState<SmsCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A push from People, the Inbox or a smart list lands straight in the builder.
  const [handoff] = useState(takeCampaignHandoff);
  const [open, setOpen] = useState<Open>(handoff && !handoff.campaignId ? { campaign: null, draft: newDraft(handoff.audience, handoff.contact) } : null);
  const smsLines = useSmsLines();
  const lists = (V.savedListRows || []).map((l) => ({ label: l.label, count: l.count ?? null }));

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await listCampaigns(workspaceId)); setError(null); } catch (e) { setError(e instanceof Error ? e.message : 'Read failed'); } finally { setLoading(false); }
  }, [workspaceId]);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  // Every deal's buyer blasts, a folder of the list (DealBlasts).
  const [blasts, setBlasts] = useState<{ rows: Blast[]; loading: boolean; error: string | null }>({ rows: [], loading: true, error: null });
  const loadDealBlasts = useCallback(async () => {
    if (workspaceId == null) { setBlasts({ rows: [], loading: false, error: null }); return; }
    const r = await loadBlasts(workspaceId);
    setBlasts((b) => (r.ok ? { rows: r.data, loading: false, error: null } : { ...b, loading: false, error: r.message }));
  }, [workspaceId]);
  useEffect(() => { const t = setTimeout(() => void loadDealBlasts(), 0); return () => clearTimeout(t); }, [loadDealBlasts]);

  // Pushed into an existing campaign: open it once its row is read.
  useEffect(() => {
    const h = handoff;
    if (!h?.campaignId) return;
    let on = true;
    listCampaigns(workspaceId).then((all) => {
      const c = all.find((x) => x.id === h.campaignId);
      if (on && c) setOpen({ campaign: c, draft: { ...toDraft(c), ...(h.audience.kind !== 'none' ? { audience: h.audience } : {}) } });
    }).catch(() => undefined);
    return () => { on = false; };
  }, [handoff, workspaceId]);

  const onSaved = (c: SmsCampaign) => { setRows((r) => (r.some((x) => x.id === c.id) ? r.map((x) => (x.id === c.id ? c : x)) : [c, ...r])); setOpen((o) => (o ? { ...o, campaign: c } : o)); };
  const followUp = (c: SmsCampaign) => setOpen({ campaign: null, draft: {
    ...toDraft(c), name: `${c.name} follow-up`, status: 'draft', parent_id: c.id, start_at: null,
    audience: { kind: 'followup', campaign_id: c.id, label: `${c.name}, no reply`, count: Math.max(0, c.sent_count - c.responded_count) },
  } });
  const duplicate = (c: SmsCampaign) => setOpen({ campaign: null, draft: { ...toDraft(c), name: `${c.name} copy`, status: 'draft', start_at: null, parent_id: null } });
  const remove = async (c: SmsCampaign) => {
    try { await deleteCampaign(c.id); setRows((r) => r.filter((x) => x.id !== c.id)); V.showToast(`Deleted ${c.name}.`); }
    catch (e) { V.showToast(e instanceof Error ? e.message : 'Delete failed', 'error'); }
  };
  const exportCsv = async (c: SmsCampaign) => {
    const csv = await exportRecipients(c);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${c.name.replace(/[^\w-]+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (open) {
    return (
      <CampaignEditor key={open.campaign?.id ?? 'new'} campaign={open.campaign} draft={open.draft} workspaceId={workspaceId} isMobile={V.isMobile} live={live}
        lines={live ? (smsLines ? smsLines.lines : null) : null} lists={lists} specForList={V.peopleSpecFor} toast={V.showToast}
        onBack={() => { setOpen(null); void load(); }} onSaved={onSaved} onFollowUp={followUp} />
    );
  }
  return (
    <CampaignsList rows={rows} loading={loading} error={error} isMobile={V.isMobile}
      onOpen={(c) => setOpen({ campaign: c, draft: toDraft(c) })} onNew={() => setOpen({ campaign: null, draft: newDraft() })}
      onFollowUp={followUp} onDuplicate={duplicate} onDelete={remove} onExport={exportCsv}
      onTemplates={() => openSettings('sequences/templates')}
      blasts={{
        running: blasts.rows.filter((b) => b.status === 'running').length,
        node: <DealBlasts rows={blasts.rows} loading={blasts.loading} error={blasts.error} canWrite={!!V.liveIds?.canWrite}
          onOpenDeal={V.openBuyerCampaign} onChanged={() => void loadDealBlasts()} toast={V.showToast} />,
      }} />
  );
}

function toDraft(c: SmsCampaign): Draft {
  const { name, status, audience, contact_kind, opted_in_only, template_ids, from_numbers, tz, start_at, send_all_at_once, batch_size, batch_every_minutes, window_start, window_end, window_days, reply_action, parent_id } = c;
  return { name, status, audience, contact_kind, opted_in_only, template_ids, from_numbers, tz, start_at, send_all_at_once, batch_size, batch_every_minutes, window_start, window_end, window_days, reply_action, parent_id };
}
