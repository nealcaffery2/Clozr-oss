'use client';

// The deal's buyer-facing page: publish it, copy the link, and control what a
// buyer without a login is allowed to see.
//
// Two links are in play and they are not the same thing. This one is the bare
// page URL, for pasting somewhere that is not a buyer — a Facebook group, a
// text you type yourself. A campaign mints a *signed* version per buyer
// (lib/dispo.ts, mintBuyerLinks) so views and offers come back attributed;
// that happens in the Marketing tab's composer, not here.
//
// It sits at the top of the Marketing tab as the first part of the same flow:
// the page every campaign message links to, whether it is live, and what it
// shows. On /demo (`demo` set) it reads a sample page and saves nothing.

import React, { useEffect, useState } from 'react';
import { type DealPublicLink, getPublicLink, listingUrl, publishDeal, updatePublicLink } from '@/lib/dispo';
import { Btn, C, Disclosure, Eyebrow, Icon, Status, Svg, Switch } from './dispo-campaign/ui';

export function BuyerPagePanel({
  dealId, canWrite, defaultHeadline, onToast, photoUrl, demo,
}: {
  dealId: number | null;
  canWrite: boolean;
  /** Suggested headline, usually the address. */
  defaultHeadline?: string;
  onToast: (m: string) => void;
  /** The deal's photo, for the page thumbnail. */
  photoUrl?: string | null;
  /** /demo: a sample page, and every write is a "(demo)" toast. */
  demo?: { page: DealPublicLink; url: string } | null;
}) {
  const [link, setLink] = useState<DealPublicLink | null>(() => demo?.page ?? null);
  // Which deal's link is in state. `loading` is derived from it rather than
  // being its own flag, so the effect never calls setState synchronously.
  const [loadedFor, setLoadedFor] = useState<number | null>(() => (demo ? -1 : null));
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [headline, setHeadline] = useState(demo?.page.headline ?? defaultHeadline ?? '');
  const [description, setDescription] = useState(demo?.page.description ?? '');

  useEffect(() => {
    if (!dealId || demo) return;
    let live = true;
    getPublicLink(dealId).then((r) => {
      if (!live) return;
      setLoadedFor(dealId);
      if (!r.ok) return onToast(r.message);
      setLink(r.data);
      if (r.data) {
        setHeadline(r.data.headline ?? defaultHeadline ?? '');
        setDescription(r.data.description ?? '');
      }
    });
    return () => { live = false; };
    // onToast is recreated per render upstream; the deal is what this depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, defaultHeadline, demo]);

  if (!dealId && !demo) return null;
  const loading = !demo && loadedFor !== dealId;

  const save = async () => {
    if (demo) { setEditing(false); return onToast(link ? 'Buyer page updated (demo)' : 'Buyer page published (demo)'); }
    setBusy(true);
    const r = await publishDeal(dealId!, { headline, description });
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    setLink(r.data);
    setEditing(false);
    onToast(link ? 'Buyer page updated.' : 'Buyer page published.');
  };

  const patch = async (p: Parameters<typeof updatePublicLink>[1]) => {
    if (!link) return;
    if (demo) return onToast('Buyer page setting saved (demo)');
    setBusy(true);
    const r = await updatePublicLink(link.id, p);
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    setLink(r.data);
  };

  const url = link ? (demo ? demo.url : listingUrl(link.slug)) : '';
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(url); onToast(demo ? 'Link copied (demo)' : 'Link copied.'); }
    catch { onToast('Could not copy — select the link and copy it by hand.'); }
  };

  if (loading) return <div className="mk-card" role="status" style={{ ...card, padding: '14px 16px', fontSize: '12.5px', color: C.muted2 }}>Loading the buyer page…</div>;

  const thumb = (
    <div role="img" aria-label="Deal photo" style={{ width: '72px', height: '54px', borderRadius: '8px', flex: 'none', background: photoUrl ? `#e9ebf0 url(${JSON.stringify(photoUrl)}) center/cover no-repeat` : '#e9ebf0' }} />
  );
  const status = !link ? <Status tone="amber">Not published</Status> : link.active ? <Status tone="green">Live</Status> : <Status tone="grey">Off</Status>;

  return (
    <section className="mk-card mk" aria-label="Buyer page" style={card} data-testid="buyer-page">
      <div style={{ display: 'flex', gap: '14px', alignItems: 'center', padding: '14px 16px', flexWrap: 'wrap' }}>
        {thumb}
        <div style={{ minWidth: 0, flex: '1 1 240px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}><Eyebrow>Buyer page</Eyebrow>{status}</div>
          <div style={{ fontSize: '14px', fontWeight: 600, marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{link?.headline || headline || defaultHeadline || 'Untitled deal'}</div>
          <div style={{ fontSize: '12px', color: C.muted2, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {link ? <span className="mk-num">{link.view_count.toLocaleString('en-US')} view{link.view_count === 1 ? '' : 's'} from {link.unique_viewers.toLocaleString('en-US')} visitor{link.unique_viewers === 1 ? '' : 's'} · every campaign message carries the buyer&apos;s own tracked copy</span>
              : 'Photos, numbers and an offer form. A campaign publishes it for you; publish now to share the link yourself.'}
          </div>
        </div>
        {link && !editing ? (
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flex: '1 1 320px', minWidth: 0, justifyContent: 'flex-end' }}>
            <code title={url} style={{ flex: '1 1 auto', minWidth: 0, maxWidth: '360px', fontSize: '11.5px', background: '#fafafa', border: `1px solid ${C.line}`, borderRadius: '8px', padding: '0 10px', height: '32px', lineHeight: '30px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.muted, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Svg d={Icon.link} size={12} color={C.muted2} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{url.replace(/^https:\/\//, '')}</span>
            </code>
            <Btn onClick={copy}>Copy</Btn>
            {demo ? <Btn onClick={() => onToast('The sample page does not open outside a workspace (demo)')}>Open</Btn>
              : <a className="mk-btn mk-press" href={url} target="_blank" rel="noreferrer">Open</a>}
          </div>
        ) : !link && !editing ? (
          <Btn kind="primary" disabled={!canWrite || busy} title={!canWrite ? 'A dispositions role is needed to publish' : undefined} onClick={() => setEditing(true)}>Publish buyer page</Btn>
        ) : null}
      </div>

      {editing ? (
        <div className="mk-reveal" style={{ padding: '0 16px 14px', display: 'grid', gap: '10px', borderTop: `1px solid ${C.line2}`, paddingTop: '12px' }}>
          <label style={{ display: 'grid', gap: '4px' }}>
            <span style={{ fontSize: '11.5px', color: C.muted }}>Headline</span>
            <input className="mk-field" value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="Brick ranch, 3/2, needs cosmetics" disabled={!canWrite} />
          </label>
          <label style={{ display: 'grid', gap: '4px' }}>
            <span style={{ fontSize: '11.5px', color: C.muted }}>Description</span>
            <textarea className="mk-area" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What a buyer should know that the numbers do not say." disabled={!canWrite} />
          </label>
          <div style={{ fontSize: '11.5px', color: C.muted2 }}>The address is only ever in the link, never guessable.</div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn kind="primary" disabled={busy || !canWrite} onClick={save}>{busy ? 'Saving…' : link ? 'Save' : 'Publish buyer page'}</Btn>
            <Btn onClick={() => setEditing(false)}>Cancel</Btn>
          </div>
          {!canWrite ? <div style={{ fontSize: '11.5px', color: C.muted2 }}>A dispositions role is needed to publish.</div> : null}
        </div>
      ) : link ? (
        <div style={{ padding: '0 16px 10px', borderTop: `1px solid ${C.line2}` }}>
          <div style={{ paddingTop: '6px' }}>
            <Disclosure title="Page settings" open={settingsOpen} onToggle={() => setSettingsOpen(!settingsOpen)}
              summary={[link.active ? 'live' : 'off', link.allow_offers ? 'takes offers' : 'no offers', link.show_address ? 'full address' : 'address hidden', link.on_marketplace ? 'on the marketplace' : ''].filter(Boolean).join(' · ')}>
              <div style={{ display: 'grid', gap: '10px', paddingBottom: '6px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '8px' }}>
                  {([
                    ['active', 'Page is live'],
                    ['allow_offers', 'Accept offers on the page'],
                    ['show_address', 'Show the full address'],
                    ['on_marketplace', 'List on the Acme Homes marketplace'],
                  ] as const).map(([k, text]) => (
                    <Switch key={k} on={link[k]} disabled={busy || !canWrite} set={(v) => void patch({ [k]: v })}>{text}</Switch>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Btn size="sm" onClick={() => setEditing(true)} disabled={!canWrite} title={!canWrite ? 'A dispositions role is needed to edit' : undefined}>Edit headline and description</Btn>
                  {link.on_marketplace && link.active ? (demo ? <Btn size="sm" kind="quiet" onClick={() => onToast('The marketplace does not open outside a workspace (demo)')}>Open marketplace</Btn>
                    : <a href="/marketplace" target="_blank" rel="noreferrer" className="mk-btn mk-btn--quiet mk-btn--sm mk-press">Open marketplace</a>) : null}
                </div>
              </div>
            </Disclosure>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const card: React.CSSProperties = { background: '#fff', border: `1px solid ${C.line}`, borderRadius: '12px' };
