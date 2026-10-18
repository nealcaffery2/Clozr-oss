'use client';

// The Templates manager: every SMS and email template this member can see,
// filtered the same way the composer's picker is, with create, edit,
// duplicate, share and delete — and a one-shot import of Talkr's SMS templates.
//
// Layout: a narrow channel rail on the left (All / SMS / Email + counts), a
// filtered list in the middle, and the editor replacing the list when you
// create or edit. Settings embeds it without the fullscreen chrome.

import React, { useMemo, useState } from 'react';
import {
  AUDIENCE_LABEL, type Channel, type MessageTemplate, type TemplateDraft,
  archiveTemplate, importTalkrTemplates, newBlock, saveTemplate, toBlocks,
} from '@/lib/message-templates';
import { api } from '@/lib/talkr-web/api';
import type { Teammate } from '@/lib/team';
import { Icon } from '@/app/components/talkr/Icon';
import { Button } from '@/app/components/talkr/ui';
import { TemplateFilters, ownerLabel } from './TemplatePicker';
import { type TemplateFilter, filterTemplates } from './useTemplates';
import { type EditorContext, TemplateEditor } from './TemplateEditor';
import { TalkrMark } from '@/app/components/brand/TalkrMark';

const blank = (channel: Channel): TemplateDraft => ({
  name: '', channel, audience: 'seller', category: null, shared: false,
  subject: channel === 'email' ? '' : null, body_text: '', body_html: null,
  blocks: channel === 'email' ? [newBlock('paragraph'), newBlock('signature')] : null,
});

const draftOf = (t: MessageTemplate): TemplateDraft => ({
  id: t.id, name: t.name, channel: t.channel, audience: t.audience, category: t.category, shared: t.shared,
  subject: t.subject, body_text: t.body_text, body_html: t.body_html,
  blocks: t.channel === 'email' ? (toBlocks(t.blocks).length ? toBlocks(t.blocks) : [{ ...newBlock('paragraph'), text: t.body_text } as ReturnType<typeof newBlock>]) : null,
});

const ACCENT = '#0A8560';
const LINE = 'var(--line, #e4e4e7)';
const MUTED = 'var(--muted, #71717a)';

export function TemplatesManager({ data, userId, isAdmin, talkrAuthed, ctx, initialChannel = 'any', onClose, embedded }: {
  data: { templates: MessageTemplate[]; team: Teammate[]; loading: boolean; error: string | null; reload: () => void };
  userId: string | null; isAdmin: boolean; talkrAuthed: boolean; ctx: EditorContext;
  initialChannel?: TemplateFilter['channel']; onClose: () => void;
  /** When true, fills the parent pane instead of covering the viewport. */
  embedded?: boolean;
}) {
  const [f, setF] = useState<TemplateFilter>({ channel: initialChannel, audience: 'any', owner: 'any', q: '' });
  const [editing, setEditing] = useState<TemplateDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = filterTemplates(data.templates, f, userId);
  const canEdit = (t: MessageTemplate) => t.owner_id === userId || (t.shared && isAdmin);

  const counts = useMemo(() => ({
    any: data.templates.length,
    sms: data.templates.filter((t) => t.channel === 'sms').length,
    email: data.templates.filter((t) => t.channel === 'email').length,
  }), [data.templates]);

  const byCategory = useMemo(() => {
    const map = new Map<string, MessageTemplate[]>();
    for (const t of shown) {
      const key = (t.category || 'Uncategorized').trim() || 'Uncategorized';
      const list = map.get(key) ?? [];
      list.push(t);
      map.set(key, list);
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === 'Uncategorized') return 1;
      if (b[0] === 'Uncategorized') return -1;
      return a[0].localeCompare(b[0]);
    });
  }, [shown]);

  const act = async (p: Promise<{ ok: boolean; message?: string }>, done: string) => {
    setBusy(true);
    const r = await p;
    setBusy(false);
    ctx.toast(r.ok ? done : (r as { message: string }).message);
    if (r.ok) data.reload();
  };

  const importTalkr = async () => {
    setBusy(true);
    try {
      const { templates } = await api.listMessageTemplates({ include_inactive: false });
      const r = await importTalkrTemplates(ctx.workspaceId, data.templates, templates);
      ctx.toast(r.ok ? (r.data ? `Imported ${r.data} Talkr template${r.data === 1 ? '' : 's'}` : 'Nothing new to import from Talkr') : r.message);
      if (r.ok) data.reload();
    } catch (e) {
      ctx.toast((e as Error).message || 'Could not read Talkr templates');
    } finally {
      setBusy(false);
    }
  };

  const shellStyle: React.CSSProperties = embedded
    ? { position: 'relative', inset: 'auto', zIndex: 'auto', minHeight: '70vh', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg, #fafafa)' }
    : { position: 'fixed', inset: 0, zIndex: 60, background: 'var(--bg)', display: 'flex', flexDirection: 'column' };

  return (
    <div role={embedded ? 'region' : 'dialog'} aria-label="Templates" className="flex flex-col" style={shellStyle}>
      <header className="glass-bar flex items-center gap-2 px-4 py-3" style={{ borderBottom: `1px solid ${LINE}`, flex: 'none', background: 'var(--panel, #fff)' }}>
        {!embedded || editing ? (
          <button type="button" aria-label="Back" onClick={editing ? () => setEditing(null) : onClose} style={{ color: ACCENT, cursor: 'pointer' }}>
            <Icon name="chevron-left" size={20} strokeWidth={2.4} />
          </button>
        ) : null}
        <div className="mr-auto flex flex-col gap-0.5 min-w-0">
          <h1 style={{ font: '700 15px/1 var(--sans)', margin: 0 }}>
            {editing ? (editing.id ? `Edit ${editing.channel === 'sms' ? 'SMS' : 'email'}` : `New ${editing.channel === 'sms' ? 'SMS' : 'email'} template`) : 'Templates'}
          </h1>
          <p style={{ font: '500 11px/1 var(--sans)', color: MUTED, margin: 0 }}>
            {editing ? (editing.name || 'Untitled') : `${data.templates.length} template${data.templates.length === 1 ? '' : 's'} · pick a channel, then insert from any composer`}
          </p>
        </div>
        {!editing && (
          <>
            {talkrAuthed && (
              <Button tone="ghost" className="dc2" disabled={busy} onClick={() => void importTalkr()} title="Copy Talkr's SMS templates into CLOZR (shared)">
                <TalkrMark size={13} /> Import from Talkr
              </Button>
            )}
            <Button tone="ghost" className="dc2" onClick={() => setEditing(blank('sms'))}><Icon name="plus" size={13} /> SMS</Button>
            <Button tone="accent" className="dc3" onClick={() => setEditing(blank('email'))}><Icon name="plus" size={13} /> Email</Button>
          </>
        )}
        {!embedded && (
          <button type="button" aria-label="Close templates" onClick={onClose} style={{ color: 'var(--muted-2)', cursor: 'pointer', marginLeft: 4 }}>
            <Icon name="x" size={16} />
          </button>
        )}
      </header>

      {editing ? (
        <TemplateEditor key={editing.id ?? `new-${editing.channel}`} initial={editing} ctx={ctx} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); data.reload(); }} />
      ) : (
        <div className="flex min-h-0 flex-1" style={{ flexDirection: embedded && typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches ? 'column' : 'row' }}>
          <aside style={{
            width: 168, flex: 'none', borderRight: `1px solid ${LINE}`, background: 'var(--panel, #fff)',
            padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 4, overflow: 'auto',
          }}>
            <span style={{ font: '700 11px/1 var(--sans)', color: MUTED, padding: '4px 8px 8px' }}>Channel</span>
            {([
              ['any', 'All templates', counts.any],
              ['sms', 'SMS', counts.sms],
              ['email', 'Email', counts.email],
            ] as const).map(([ch, label, n]) => {
              const on = f.channel === ch;
              return (
                <button
                  key={ch}
                  type="button"
                  onClick={() => setF((cur) => ({ ...cur, channel: ch }))}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                    height: 34, padding: '0 10px', borderRadius: 8, border: 0, cursor: 'pointer',
                    background: on ? 'var(--tint-green, #ecfdf5)' : 'transparent', color: on ? ACCENT : 'var(--ink-2, #27272a)',
                    font: `${on ? 650 : 500} 12.5px/1 var(--sans)`, textAlign: 'left',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <Icon name={ch === 'email' ? 'send' : ch === 'sms' ? 'msg' : 'template'} size={13} />
                    {label}
                  </span>
                  <span style={{ font: '600 11px/1 var(--sans)', color: on ? ACCENT : 'var(--muted-2, #a1a1aa)' }}>{n}</span>
                </button>
              );
            })}
            <div style={{ height: 1, background: LINE, margin: '10px 4px' }} />
            <p style={{ margin: 0, padding: '0 8px', font: '400 11px/1.45 var(--sans)', color: MUTED }}>
              Merge fields fill when you insert. Share a template so the whole team can use it.
            </p>
          </aside>

          <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3 p-4" style={{ minWidth: 0 }}>
            <TemplateFilters f={f} set={(p) => setF((cur) => ({ ...cur, ...p }))} team={data.team} lockChannel />
            <div className="min-h-0 flex-1 overflow-auto rounded-xl" style={{ background: 'var(--panel, #fff)', border: `1px solid ${LINE}` }}>
              {data.error && <p className="p-4" style={{ font: '400 12.5px/1.5 var(--sans)', color: 'var(--red)' }}>{data.error}</p>}
              {!data.error && !data.loading && shown.length === 0 && (
                <div className="flex flex-col items-center gap-3 p-10 text-center">
                  <span className="inline-grid place-items-center rounded-full" style={{ width: 48, height: 48, background: 'var(--tint-green, #ecfdf5)', color: ACCENT }}>
                    <Icon name="template" size={22} />
                  </span>
                  <p style={{ margin: 0, font: '600 14px/1.3 var(--sans)' }}>No templates here yet</p>
                  <p style={{ margin: 0, font: '400 12.5px/1.5 var(--sans)', color: MUTED, maxWidth: 320 }}>
                    Start with + SMS or + Email. Categories group the list so follow-ups, offers and closing copy stay easy to find.
                  </p>
                  <div className="flex gap-2">
                    <Button tone="ghost" className="dc2" onClick={() => setEditing(blank('sms'))}>+ SMS</Button>
                    <Button tone="accent" className="dc3" onClick={() => setEditing(blank('email'))}>+ Email</Button>
                  </div>
                </div>
              )}
              {byCategory.map(([cat, items]) => (
                <div key={cat}>
                  <div style={{
                    position: 'sticky', top: 0, zIndex: 1, padding: '8px 16px',
                    background: 'var(--panel-2, #f4f4f5)', borderBottom: `1px solid ${LINE}`,
                    font: '700 11px/1 var(--sans)', color: MUTED,
                  }}>
                    {cat} · {items.length}
                  </div>
                  {items.map((t) => (
                    <div key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--panel-2, #f4f4f5)' }}>
                      <span className="inline-grid shrink-0 place-items-center rounded-full" style={{ width: 34, height: 34, background: t.channel === 'sms' ? 'var(--c-talkr-soft, #ffe9ec)' : 'var(--tint-blue, #eff6ff)', color: t.channel === 'sms' ? '#e6142e' : '#2563eb' }}>
                        <Icon name={t.channel === 'sms' ? 'msg' : 'send'} size={15} />
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="truncate" style={{ font: '600 13px/1.2 var(--sans)' }}>{t.name}</span>
                          <span style={{ font: '700 11px/1 var(--sans)', color: ACCENT, flex: 'none' }}>
                            {t.channel === 'sms' ? 'SMS' : 'Email'} · {AUDIENCE_LABEL[t.audience]}
                          </span>
                        </span>
                        <span className="truncate" style={{ font: '400 12px/1.3 var(--sans)', color: MUTED }}>
                          {t.subject ? `${t.subject} — ` : ''}{t.body_text.replace(/\s+/g, ' ').slice(0, 160)}
                        </span>
                        <span style={{ font: '500 10.5px/1 var(--sans)', color: 'var(--muted-2, #a1a1aa)' }}>
                          {ownerLabel(t, userId, data.team)} · edited {new Date(t.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {canEdit(t) && <Button tone="ghost" className="dc2" style={{ padding: '6px 10px' }} onClick={() => setEditing(draftOf(t))}>Edit</Button>}
                        <Button tone="ghost" className="dc2" style={{ padding: '6px 10px' }} disabled={busy}
                          onClick={() => void act(saveTemplate(ctx.workspaceId, { ...draftOf(t), id: undefined, name: `${t.name} (copy)`, shared: false }), `Duplicated “${t.name}”`)}>Duplicate</Button>
                        {t.owner_id === userId && (
                          <Button tone="ghost" className="dc2" style={{ padding: '6px 10px' }} disabled={busy}
                            onClick={() => void act(saveTemplate(ctx.workspaceId, { ...draftOf(t), shared: !t.shared }), t.shared ? 'Now private' : 'Shared with the team')}>
                            {t.shared ? 'Unshare' : 'Share'}
                          </Button>
                        )}
                        {canEdit(t) && (
                          <button type="button" aria-label={`Delete ${t.name}`} disabled={busy} style={{ color: 'var(--red)', cursor: 'pointer', padding: 6 }}
                            onClick={() => { if (window.confirm(`Delete “${t.name}”?`)) void act(archiveTemplate(t.id), 'Template deleted'); }}>
                            <Icon name="trash" size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
