'use client';

// The template editors. SMS: a textarea with merge chips, the carrier's
// segment count on what the sample recipient would actually receive, and the
// bubble they would see. Email: two panes — the blocks on the left, the
// rendered email on the right at desktop or phone width, sent to yourself on
// demand — and an AI assist that writes a first draft from a goal and a tone.

import React, { useMemo, useState } from 'react';
import {
  AUDIENCES, AUDIENCE_LABEL, BLOCK_LABEL, MERGE_FIELDS, SAMPLE_FIELDS,
  type Audience, type Block, type BlockType, type TemplateDraft,
  blocksToEmail, draftTemplate, newBlock, renderEmail, saveTemplate, toBlocks,
} from '@/lib/message-templates';
import { renderMerge } from '@/lib/sms';
import { sendEmail } from '@/lib/google';
import { EmailHtml } from '@/app/components/email/EmailHtml';
import { Icon } from '@/app/components/talkr/Icon';
import { Button, FIELD } from '@/app/components/talkr/ui';
import { MergeChips } from '@/app/components/talkr/MessageTemplates';
import { insertAtCaret } from '@/app/components/talkr/EmojiPicker';
import { Bubble } from '@/app/components/talkr/Bubble';
import { firstNonGsmChar, smsSegments } from '@/app/components/talkr/contacts';
import { seg, segWrap } from './TemplatePicker';
import { SpamRiskBadge } from '@/app/components/deliverability/SpamRiskBadge';

type Field = HTMLInputElement | HTMLTextAreaElement;
const label: React.CSSProperties = { display: 'block', font: '600 11px/1 var(--sans)', color: 'var(--muted)', marginBottom: 5 };
const input: React.CSSProperties = { ...FIELD, width: '100%', font: '500 13px/1.3 var(--sans)' };
const iconBtn: React.CSSProperties = { width: 24, height: 24, display: 'inline-grid', placeItems: 'center', borderRadius: 6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--muted)', cursor: 'pointer' };
const BLOCK_TYPES: BlockType[] = ['heading', 'paragraph', 'button', 'image', 'property', 'signature', 'divider', 'spacer'];

export type EditorContext = {
  workspaceId: number;
  /** The rep's own values, laid over the audience's sample so the preview signs as them. */
  rep: Record<string, string>;
  /** Where "Send test to me" goes; null when Gmail is not connected. */
  testTo: string | null;
  toast: (msg: string) => void;
};

export function TemplateEditor({ initial, ctx, onSaved, onCancel }: {
  initial: TemplateDraft; ctx: EditorContext; onSaved: () => void; onCancel: () => void;
}) {
  const [d, setD] = useState<TemplateDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Partial<TemplateDraft>) => setD((cur) => ({ ...cur, ...patch }));
  const sample = useMemo(() => ({ ...SAMPLE_FIELDS[d.audience], ...ctx.rep }), [d.audience, ctx.rep]);

  // The last field the rep typed in, so a chip lands where the caret is.
  const [last, setLast] = useState<{ el: Field; apply: (v: string) => void } | null>(null);
  const track = (apply: (v: string) => void) => ({ onFocus: (e: React.FocusEvent<Field>) => { const el = e.currentTarget; setLast({ el, apply }); } });
  const insert = (token: string) => {
    const t = last;
    if (!t) return;
    t.apply(insertAtCaret(t.el as HTMLTextAreaElement, t.el.value, token));
  };

  const save = async () => {
    setSaving(true); setErr(null);
    const r = await saveTemplate(ctx.workspaceId, d);
    setSaving(false);
    if (!r.ok) return setErr(r.message);
    ctx.toast(`Saved “${r.data.name}”`);
    onSaved();
  };

  const head = (
    <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
      <label style={{ gridColumn: '1 / -1' }}><span style={label}>Name</span>
        <input style={input} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Seller · day-3 follow-up" /></label>
      <label><span style={label}>Audience</span>
        <select style={input} value={d.audience} onChange={(e) => set({ audience: e.target.value as Audience })}>
          {AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}
        </select></label>
      <label><span style={label}>Category</span>
        <input style={input} value={d.category ?? ''} onChange={(e) => set({ category: e.target.value })} placeholder="follow-up, offer, closing…" /></label>
      <label className="flex items-center gap-2" style={{ gridColumn: '1 / -1', font: '500 12.5px/1.3 var(--sans)' }}>
        <input type="checkbox" checked={d.shared} onChange={(e) => set({ shared: e.target.checked })} style={{ accentColor: 'var(--accent)' }} />
        Share with the team <span style={{ color: 'var(--muted-2)' }}>— owners and admins can edit shared templates</span>
      </label>
    </div>
  );

  const footer = (
    <div className="flex items-center gap-2 px-4 py-3" style={{ borderTop: '1px solid var(--line)', background: 'var(--panel)' }}>
      {err && <span className="mr-auto" style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--red)' }}>{err}</span>}
      <span className="ml-auto" />
      <Button tone="ghost" className="dc2" onClick={onCancel}>Cancel</Button>
      <Button tone="accent" className="dc3" disabled={saving || !d.name.trim()} onClick={() => void save()}>{saving ? 'Saving…' : 'Save template'}</Button>
    </div>
  );

  if (d.channel === 'sms') {
    const out = renderMerge(d.body_text, sample);
    const s = smsSegments(out);
    const culprit = s.encoding === 'ucs2' ? firstNonGsmChar(out) : null;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="grid min-h-0 flex-1 gap-5 overflow-auto p-4 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            {head}
            <AiAssist ctx={ctx} channel="sms" audience={d.audience} onDraft={(r) => set({ name: d.name || r.name, body_text: r.body_text })} />
            <div>
              <span style={label}>Message</span>
              <textarea rows={6} style={{ ...input, resize: 'vertical', lineHeight: 1.45 }} value={d.body_text}
                onChange={(e) => set({ body_text: e.target.value })} {...track((v) => set({ body_text: v }))}
                placeholder="Hi {{first_name}}, this is {{rep_name}} with {{company}} — still thinking about {{address}}?" />
              <div className="mt-1.5"><MergeChips fields={MERGE_FIELDS} onInsert={insert} /></div>
              <p style={{ marginTop: 6, font: '500 11px/1.4 var(--sans)', color: s.segments > 1 && s.encoding === 'ucs2' ? 'var(--amber)' : 'var(--muted-2)' }}>
                {s.chars} chars · {s.segments} segment{s.segments === 1 ? '' : 's'} · {s.encoding === 'ucs2' ? `UCS-2 (${culprit && /\p{Extended_Pictographic}/u.test(culprit) ? 'an emoji' : `“${culprit}”`}) — 70 per segment` : 'GSM-7'} <span>(counted on the sample)</span>
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span style={label}>Preview · {AUDIENCE_LABEL[d.audience]} sample</span>
            <div className="flex flex-col rounded-xl p-4" style={{ background: 'var(--panel)', border: '1px solid var(--line)', minHeight: 160 }}>
              {out.trim() ? <Bubble mine tail maxWidth="85%">{out}</Bubble> : <span style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--muted-2)' }}>Type a message to preview it.</span>}
            </div>
          </div>
        </div>
        {footer}
      </div>
    );
  }

  return <EmailEditor d={d} set={set} ctx={ctx} sample={sample} head={head} footer={footer} track={track} insert={insert} />;
}

function EmailEditor({ d, set, ctx, sample, head, footer, track, insert }: {
  d: TemplateDraft; set: (p: Partial<TemplateDraft>) => void; ctx: EditorContext; sample: Record<string, string>;
  head: React.ReactNode; footer: React.ReactNode;
  track: (apply: (v: string) => void) => { onFocus: (e: React.FocusEvent<Field>) => void };
  insert: (token: string) => void;
}) {
  const blocks = useMemo(() => (d.blocks ?? []) as Block[], [d.blocks]);
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [drag, setDrag] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const setBlocks = (next: Block[]) => set({ blocks: next });
  const patch = (id: string, p: Partial<Block>) => setBlocks(blocks.map((b) => (b.id === id ? ({ ...b, ...p } as Block) : b)));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= blocks.length || from === to) return;
    const next = blocks.slice();
    const [b] = next.splice(from, 1);
    next.splice(to, 0, b);
    setBlocks(next);
  };

  const built = useMemo(() => blocksToEmail(blocks), [blocks]);
  const preview = useMemo(() => renderEmail({ subject: d.subject, body_html: built.html, body_text: built.text }, sample), [d.subject, built, sample]);

  const sendTest = async () => {
    if (!ctx.testTo) return;
    setTesting(true);
    const r = await sendEmail(ctx.workspaceId, { to: ctx.testTo, subject: `[Test] ${preview.subject || d.name}`, body_html: preview.html ?? undefined, body_text: preview.text, test: true });
    setTesting(false);
    ctx.toast(r.ok && r.data.ok ? `Test sent to ${ctx.testTo}` : r.ok ? r.data.message ?? 'Gmail refused that send.' : r.message);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(360px,440px)_1fr]">
        {/* ── Left: what the email is made of ─────────────────────────── */}
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4" style={{ borderRight: '1px solid var(--line)' }}>
          {head}
          <AiAssist ctx={ctx} channel="email" audience={d.audience} onDraft={(r) => set({ name: d.name || r.name, subject: r.subject ?? d.subject, blocks: r.blocks.length ? r.blocks : blocks })} />
          <label><span style={label}>Subject</span>
            <input style={input} value={d.subject ?? ''} onChange={(e) => set({ subject: e.target.value })} {...track((v) => set({ subject: v }))} placeholder="Your offer for {{address}}" /></label>
          <div>
            <span style={label}>Merge fields — click to insert where you are typing</span>
            <MergeChips fields={MERGE_FIELDS} onInsert={insert} />
          </div>

          <div className="flex flex-col gap-2">
            {blocks.map((b, i) => (
              <div
                key={b.id}
                draggable
                onDragStart={() => setDrag(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); }}
                onDragEnd={() => setDrag(null)}
                className="flex flex-col gap-2 rounded-xl p-2.5"
                style={{ border: `1px solid ${drag === i ? 'var(--accent)' : 'var(--line)'}`, background: 'var(--panel)' }}
              >
                <div className="flex items-center gap-1.5">
                  <span title="Drag to reorder" style={{ cursor: 'grab', color: 'var(--muted-2)', font: '700 12px/1 var(--sans)', letterSpacing: '-2px' }}>⋮⋮</span>
                  <span className="mr-auto" style={{ font: '700 11px/1 var(--sans)', color: 'var(--accent)' }}>{BLOCK_LABEL[b.type]}</span>
                  <button type="button" aria-label="Move up" style={iconBtn} disabled={i === 0} onClick={() => move(i, i - 1)}>↑</button>
                  <button type="button" aria-label="Move down" style={iconBtn} disabled={i === blocks.length - 1} onClick={() => move(i, i + 1)}>↓</button>
                  <button type="button" aria-label="Delete block" style={{ ...iconBtn, color: 'var(--red)' }} onClick={() => setBlocks(blocks.filter((x) => x.id !== b.id))}><Icon name="trash" size={12} /></button>
                </div>
                {b.type === 'heading' && <input style={input} value={b.text} onChange={(e) => patch(b.id, { text: e.target.value })} {...track((v) => patch(b.id, { text: v }))} />}
                {b.type === 'paragraph' && <textarea rows={4} style={{ ...input, resize: 'vertical', lineHeight: 1.45 }} value={b.text} onChange={(e) => patch(b.id, { text: e.target.value })} {...track((v) => patch(b.id, { text: v }))} />}
                {b.type === 'button' && (
                  <div className="grid grid-cols-2 gap-1.5">
                    <input style={input} value={b.label} placeholder="Label" onChange={(e) => patch(b.id, { label: e.target.value })} {...track((v) => patch(b.id, { label: v }))} />
                    <input style={input} value={b.url} placeholder="https://…" onChange={(e) => patch(b.id, { url: e.target.value })} {...track((v) => patch(b.id, { url: v }))} />
                  </div>
                )}
                {b.type === 'image' && (
                  <div className="grid grid-cols-2 gap-1.5">
                    <input style={input} value={b.url} placeholder="https://… or {{photo_url}}" onChange={(e) => patch(b.id, { url: e.target.value })} {...track((v) => patch(b.id, { url: v }))} />
                    <input style={input} value={b.alt} placeholder="Alt text" onChange={(e) => patch(b.id, { alt: e.target.value })} {...track((v) => patch(b.id, { alt: v }))} />
                  </div>
                )}
                {b.type === 'spacer' && (
                  <label className="flex items-center gap-2" style={{ font: '500 12px/1 var(--sans)', color: 'var(--muted)' }}>
                    <input type="range" min={4} max={64} value={b.size} onChange={(e) => patch(b.id, { size: Number(e.target.value) })} style={{ accentColor: 'var(--accent)' }} /> {b.size}px
                  </label>
                )}
                {b.type === 'signature' && <span style={{ font: '400 11.5px/1.4 var(--sans)', color: 'var(--muted)' }}>{'{{rep_name}} · {{company}} · {{rep_phone}} · {{rep_email}}'} — the sending rep’s own details.</span>}
                {b.type === 'property' && <span style={{ font: '400 11.5px/1.4 var(--sans)', color: 'var(--muted)' }}>Photo, address, price, beds and baths from the record: {'{{photo_url}} {{address}} {{asking_price}} {{beds}} {{baths}}'}.</span>}
              </div>
            ))}
            {blocks.length === 0 && <p style={{ font: '400 12px/1.5 var(--sans)', color: 'var(--muted)' }}>Add blocks below, or let AI write a first draft.</p>}
          </div>

          <div>
            <span style={label}>Add block</span>
            <div className="flex flex-wrap gap-1.5">
              {BLOCK_TYPES.map((t) => (
                <button key={t} type="button" className="dc2" onClick={() => setBlocks([...blocks, newBlock(t)])}
                  style={{ padding: '6px 9px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', font: '600 11.5px/1 var(--sans)', cursor: 'pointer' }}>
                  + {BLOCK_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: the email, as it lands ───────────────────────────── */}
        <div className="flex min-h-0 flex-col gap-3 overflow-auto p-4" style={{ background: 'var(--panel-2)' }}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto" style={label}>Live preview · {AUDIENCE_LABEL[d.audience]} sample</span>
            <SpamRiskBadge subject={preview.subject} html={preview.html} text={preview.text} />
            <span style={segWrap}>
              <button type="button" style={seg(width === 'desktop')} onClick={() => setWidth('desktop')}>Desktop</button>
              <button type="button" style={seg(width === 'mobile')} onClick={() => setWidth('mobile')}>Mobile</button>
            </span>
            <Button tone="ghost" className="dc2" disabled={!ctx.testTo || testing || blocks.length === 0} title={ctx.testTo ? `Sends to ${ctx.testTo} from your Gmail` : 'Connect Gmail to send a test'} onClick={() => void sendTest()} style={{ padding: '7px 11px' }}>
              <Icon name="send" size={13} /> {testing ? 'Sending…' : 'Send test to me'}
            </Button>
          </div>
          <div className="mx-auto flex w-full flex-col overflow-hidden rounded-xl" style={{ maxWidth: width === 'desktop' ? 680 : 390, background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-rest)', transition: 'max-width .18s ease' }}>
            <div className="flex flex-col gap-1 px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
              <span style={{ font: '700 14px/1.3 var(--sans)' }}>{preview.subject || <span style={{ color: 'var(--muted-2)' }}>(no subject)</span>}</span>
              <span style={{ font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted)' }}>{sample.rep_name} &lt;{sample.rep_email}&gt; → {sample.name}</span>
            </div>
            {/* Our own generated markup, merged with escaped values, in a sandbox with no scripts. */}
            <EmailHtml html={preview.html ?? ''} title="Email preview" scrollHeight={620} />
          </div>
        </div>
      </div>
      {footer}
    </div>
  );
}

function AiAssist({ ctx, channel, audience, onDraft }: {
  ctx: EditorContext; channel: 'sms' | 'email'; audience: Audience;
  onDraft: (r: { name: string; subject: string | null; blocks: Block[]; body_text: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [tone, setTone] = useState('friendly, direct');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open) {
    return (
      <button type="button" className="dc18" onClick={() => setOpen(true)} style={{ alignSelf: 'flex-start', padding: '7px 11px', borderRadius: 9, border: '1px solid rgba(10, 133, 96,.3)', background: 'var(--accent-soft)', color: 'var(--accent)', font: '600 12px/1 var(--sans)', cursor: 'pointer' }}>
        ✦ Write this template with AI
      </button>
    );
  }
  const run = async () => {
    setBusy(true); setErr(null);
    const r = await draftTemplate(ctx.workspaceId, { channel, audience, goal, tone });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    onDraft({ ...r.data, blocks: toBlocks(r.data.blocks) });
    setOpen(false);
  };
  return (
    <div className="flex flex-col gap-2 rounded-xl p-3" style={{ border: '1px solid rgba(10, 133, 96,.25)', background: 'rgba(10, 133, 96,.05)' }}>
      <span style={{ ...label, color: 'var(--accent)' }}>AI draft</span>
      <textarea rows={2} style={{ ...input, resize: 'vertical' }} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={channel === 'email' ? 'e.g. Send a cash offer on their house with a link to schedule a walkthrough' : 'e.g. Day-3 follow-up after no answer'} />
      <input style={input} value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Tone" />
      {err && <span style={{ font: '400 12px/1.4 var(--sans)', color: 'var(--red)' }}>{err}</span>}
      <div className="flex gap-2">
        <Button tone="accent" className="dc3" disabled={busy || !goal.trim()} onClick={() => void run()} style={{ padding: '7px 11px' }}>{busy ? 'Writing…' : 'Write it'}</Button>
        <Button tone="ghost" className="dc2" onClick={() => setOpen(false)} style={{ padding: '7px 11px' }}>Cancel</Button>
      </div>
      {channel === 'email' && <span style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--muted)' }}>Replaces the subject and blocks with the draft.</span>}
    </div>
  );
}
