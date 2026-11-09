'use client';

// The Campaigns list: a left rail of status folders with counts, a table of
// campaigns (name, status, contacts, audience, created, last sent) and the
// row actions SmarterContact has: follow-up, export CSV, duplicate, delete.

import React, { useMemo, useState } from 'react';
import { Copy, Download, FileText, Megaphone, Plus, Repeat, Search, Send, Trash2 } from 'lucide-react';
import { useConfirm } from '@/components/ds/Confirm';
import { ScreenHeader } from '@/components/ds/Screen';
import { STATUS_LABEL, audienceCount, audienceLabel, type CampaignStatus, type SmsCampaign } from '@/lib/sms-campaigns';

type Folder = 'all' | 'blasts' | CampaignStatus;
const FOLDERS: { key: Folder; label: string }[] = [
  { key: 'all', label: 'All campaigns' }, { key: 'active', label: 'Active' }, { key: 'scheduled', label: 'Scheduled' },
  { key: 'paused', label: 'Paused' }, { key: 'draft', label: 'Draft' }, { key: 'completed', label: 'Completed' },
];
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: 'numeric', minute: '2-digit' }) : '');
const n = (x: number) => x.toLocaleString('en-US');

export function CampaignsList({ rows, loading, error, isMobile, onOpen, onNew, onFollowUp, onDuplicate, onDelete, onExport, onTemplates, blasts }: {
  rows: SmsCampaign[]; loading: boolean; error: string | null; isMobile: boolean;
  /** Every deal's buyer blasts (DealBlasts), a folder of their own; running ones counted on it. */
  blasts?: { running: number; node: React.ReactNode };
  onOpen: (c: SmsCampaign) => void; onNew: () => void; onFollowUp: (c: SmsCampaign) => void; onDuplicate: (c: SmsCampaign) => void;
  onDelete: (c: SmsCampaign) => Promise<void>; onExport: (c: SmsCampaign) => Promise<void>; onTemplates: () => void;
}) {
  const [folder, setFolder] = useState<Folder>('all');
  const [q, setQ] = useState('');
  const { confirm } = useConfirm();
  const counts = useMemo(() => {
    const c: Record<Folder, number> = { all: rows.length, blasts: 0, active: 0, scheduled: 0, paused: 0, draft: 0, completed: 0 };
    for (const r of rows) c[r.status]++;
    return c;
  }, [rows]);
  const shown = rows.filter((r) => (folder === 'all' || r.status === folder) && (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())));
  const del = async (c: SmsCampaign) => {
    const ok = await confirm({ title: `Delete ${c.name}?`, body: c.status === 'active' ? 'Texts that have not gone out are cancelled. Sent texts stay on the records.' : 'The campaign and its recipient list go away. Sent texts stay on the records.', confirmLabel: 'Delete campaign', tone: 'danger' });
    if (ok) await onDelete(c);
  };
  return (
    <section className="cp" data-screen-label="Campaigns">
      <aside className="cp-rail" aria-label="Campaign folders">
        {!isMobile ? <div className="cp-rail-head"><Megaphone size={14} aria-hidden />Campaigns</div> : null}
        <div className="cp-rail-body">
          {FOLDERS.map((f) => (
            <button key={f.key} type="button" className="cp-rail-row" aria-current={folder === f.key ? 'page' : undefined} onClick={() => setFolder(f.key)}>
              {f.key !== 'all' ? <span className="cp-dot" data-s={f.key} aria-hidden /> : null}
              <span className="cp-lbl">{f.label}</span>
              <span className="cp-n">{n(counts[f.key])}</span>
            </button>
          ))}
          {blasts ? (
            <button type="button" className="cp-rail-row" aria-current={folder === 'blasts' ? 'page' : undefined} onClick={() => setFolder('blasts')} data-testid="folder-deal-blasts">
              <Send size={13} aria-hidden /><span className="cp-lbl">Deal blasts</span>
              {blasts.running ? <span className="cp-n" title="Running now">{n(blasts.running)}</span> : null}
            </button>
          ) : null}
          <div className="cp-rail-sep" />
          <button type="button" className="cp-rail-row" onClick={onTemplates}><FileText size={13} aria-hidden /><span className="cp-lbl">Message templates</span></button>
        </div>
      </aside>
      <div className="cp-main">
        <ScreenHeader className="cp-screen-head" title="Campaigns" actions={<>
          <label className="cp-search"><Search size={13} aria-hidden /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search campaigns" aria-label="Search campaigns" /></label>
          <button type="button" className="cp-btn" data-kind="primary" onClick={onNew}><Plus size={14} aria-hidden />New campaign</button>
        </>} />
        {folder === 'blasts' && blasts ? blasts.node : <>
        {error ? <div className="cp-alert" role="alert" style={{ margin: 12 }}>Campaigns did not load: {error}</div> : null}
        {loading && !rows.length ? <div className="cp-empty" role="status">Loading campaigns…</div>
          : !shown.length ? (
            <div className="cp-empty">
              <h3>{rows.length ? 'Nothing in this folder' : 'No campaigns yet'}</h3>
              <span>{rows.length ? 'Pick another folder or clear the search.' : 'Pick people on the People screen and choose Push to campaign, or start one here.'}</span>
              {!rows.length ? <button type="button" className="cp-btn" data-kind="primary" onClick={onNew}><Plus size={14} aria-hidden />New campaign</button> : null}
            </div>
          ) : (
            <table className="cp-table">
              <thead><tr><th>Campaign</th><th>Status</th><th>Contacts</th><th>Audience</th><th>Created</th><th>Last sent</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id} className="cp-row" tabIndex={0} onClick={() => onOpen(c)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(c); }}>
                    <td className="cp-name" title={c.name}>{c.name}</td>
                    <td><span className="cp-status"><span className="cp-dot" data-s={c.status} aria-hidden />{STATUS_LABEL[c.status]}</span></td>
                    <td>{n(c.total_count || audienceCount(c.audience))}{c.sent_count ? <span className="cp-sub"> · {n(c.sent_count)} sent</span> : null}</td>
                    <td className="cp-aud" title={audienceLabel(c.audience)}>{audienceLabel(c.audience)}</td>
                    <td className="cp-sub">{fmt(c.created_at)}</td>
                    <td className="cp-sub">{fmt(c.last_sent_at) || '–'}</td>
                    <td className="cp-acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <button type="button" className="cp-icon-btn" aria-label={`Follow-up campaign to ${c.name}`} title="Create a follow-up to the ones who did not reply" onClick={() => onFollowUp(c)} disabled={!c.sent_count}><Repeat size={14} aria-hidden /></button>
                      <button type="button" className="cp-icon-btn" aria-label={`Export ${c.name} as CSV`} title="Export recipients as CSV" onClick={() => void onExport(c)}><Download size={14} aria-hidden /></button>
                      <button type="button" className="cp-icon-btn" aria-label={`Duplicate ${c.name}`} title="Duplicate as a new draft" onClick={() => onDuplicate(c)}><Copy size={14} aria-hidden /></button>
                      <button type="button" className="cp-icon-btn" data-kind="danger" aria-label={`Delete ${c.name}`} title="Delete" onClick={() => void del(c)}><Trash2 size={14} aria-hidden /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>}
      </div>
    </section>
  );
}
