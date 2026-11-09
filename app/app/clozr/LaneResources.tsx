'use client';

// Lane's Resources: the team's reference docs (TC Bible, scripts, title
// company vetting, SOPs, templates) inside the Lane drawer. Browse by
// category, search the text, read a doc in place, add one (a file, pasted
// text or a Google Drive link), and, for owners and admins, manage the
// categories and remove docs. Lane cites these docs in its answers; a
// citation opens the doc here (openResources(id) in lib/resources.ts).
//
// The data layer is lib/resources.ts; the panel's open state is a module
// store there too, so opening a doc from a Lane chip does not rebuild the
// workspace view model.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import {
  ACCEPT, addResources, closeResources, loadDoc, loadLibrary, removeCategory, removeResource, saveCategory, searchResources,
  updateResource, useResourcesPanel, type Library, type ResourceDoc, type ResourceFull, type ResourceHit,
} from '@/lib/resources';
import { snippetParts } from '@/supabase/functions/_shared/resource-text';
import './lane-resources.css';

/** Lucide geometry, currentColor (DESIGN.md §1). */
const P = {
  book: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
  back: 'm15 18-6-6 6-6',
  file: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8',
  plus: 'M5 12h14M12 5v14',
  trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  external: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  search: 'm21 21-4.3-4.3M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
};
export function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
      <path d={d} />
    </svg>
  );
}
export const RESOURCES_ICON = P.book;

const when = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
};
/** The body without a leading H1 that repeats the title shown above it. */
const withoutTitle = (body: string, title: string) => {
  const m = /^\s*#\s+(.+?)\s*\n/.exec(body);
  return m && m[1].replace(/[*_`]/g, '').trim().toLowerCase() === title.trim().toLowerCase() ? body.slice(m[0].length) : body;
};
const readTime = (chars: number) => `${Math.max(1, Math.round(chars / 1200))} min read`;
const sourceOf = (d: ResourceDoc) =>
  d.source === 'drive' || (d.source === 'import' && d.driveUrl) ? 'Google Drive'
    : d.source === 'upload' ? (d.fileName ?? 'Uploaded file')
      : d.source === 'import' ? 'Imported' : 'Pasted text';

type View = 'list' | 'doc' | 'add' | 'cats';
type Props = { ws: number | null; canAdd: boolean; admin: boolean };

export function LaneResources({ ws, canAdd, admin }: Props) {
  const panel = useResourcesPanel();
  const [lib, setLib] = useState<Library | null>(null);
  const [libErr, setLibErr] = useState<string | null>(null);
  const [view, setView] = useState<View>('list');
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ term: string; hits: ResourceHit[] | null; err: string | null }>({ term: '', hits: null, err: null });
  const [doc, setDoc] = useState<ResourceFull | null>(null);
  const [docErr, setDocErr] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [libNonce, setLibNonce] = useState(0);
  const [docNonce, setDocNonce] = useState(0);
  const qId = useId();

  useEffect(() => {
    let gone = false;
    loadLibrary(ws).then((l) => { if (!gone) { setLib(l); setLibErr(null); } }, (e: Error) => { if (!gone) setLibErr(e.message || 'Resources did not load.'); });
    return () => { gone = true; };
  }, [ws, libNonce]);
  const refresh = useCallback(() => { setLibErr(null); setLibNonce((n) => n + 1); }, []);

  const openDoc = useCallback((id: string) => { setView('doc'); setDocId(id); setDoc(null); setDocErr(null); setDocNonce((n) => n + 1); }, []);
  useEffect(() => {
    if (!docId) return;
    let gone = false;
    loadDoc(ws, docId).then((d) => { if (!gone) setDoc(d); }, (e: Error) => { if (!gone) setDocErr(e.message || 'That doc did not open.'); });
    return () => { gone = true; };
  }, [ws, docId, docNonce]);

  // A Lane citation (or any openResources(id)) opens that doc: adjusted
  // while rendering, the way React suggests for state that follows a store.
  const [seenSeq, setSeenSeq] = useState(-1);
  if (panel.seq !== seenSeq) {
    setSeenSeq(panel.seq);
    if (panel.docId) openDoc(panel.docId); else setView('list');
  }

  // Search the text, a beat after typing stops. A result belongs to the term
  // it was asked for, so a stale one reads as "Searching…".
  const term = q.trim();
  useEffect(() => {
    if (!term) return;
    let gone = false;
    const t = setTimeout(() => {
      searchResources(ws, term).then(
        (h) => { if (!gone) setFound({ term, hits: h, err: null }); },
        (e: Error) => { if (!gone) setFound({ term, hits: null, err: e.message || 'Search failed.' }); },
      );
    }, 250);
    return () => { gone = true; clearTimeout(t); };
  }, [term, ws]);
  const hits = found.term === term ? found.hits : null;
  const searchErr = found.term === term ? found.err : null;

  const catName = useMemo(() => new Map((lib?.categories ?? []).map((c) => [c.id, c.name])), [lib]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of lib?.docs ?? []) m.set(d.categoryId ?? 'none', (m.get(d.categoryId ?? 'none') ?? 0) + 1);
    return m;
  }, [lib]);
  const shown = useMemo(() => (lib?.docs ?? []).filter((d) => cat === 'all' || d.categoryId === cat), [lib, cat]);

  const back = () => { setView('list'); setDoc(null); setDocId(null); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (view !== 'list') back(); else closeResources();
  };

  return (
    <section className="lr" aria-label="Resources" onKeyDown={onKey} data-screen-label="Lane resources">
      {view === 'list' ? (
        <>
          <div className="lr-top">
            <h2 className="lr-h">Resources</h2>
            {lib ? <span className="lr-meta lr-num">{lib.docs.length} {lib.docs.length === 1 ? 'doc' : 'docs'}</span> : null}
            <div style={{ flex: 1 }} />
            {admin && lib ? <button type="button" className="lr-btn" onClick={() => setView('cats')}>Categories</button> : null}
            {canAdd ? (
              <button type="button" className="lr-btn lr-btn-primary" onClick={() => setView('add')} disabled={!lib}>
                <Icon d={P.plus} size={13} />Add doc
              </button>
            ) : null}
          </div>
          <div className="lr-search">
            <label htmlFor={qId} className="lr-label">Search resources</label>
            <div className="lr-input-wrap">
              <Icon d={P.search} size={14} />
              <input id={qId} className="lr-input lr-input-icon" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title company, earnest money, closing script…" autoComplete="off" />
            </div>
          </div>
          {lib && !q.trim() ? (
            <div className="lr-chips" role="group" aria-label="Category">
              <button type="button" className="lr-chip" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>All <span className="lr-num">{lib.docs.length}</span></button>
              {lib.categories.map((c) => (
                <button key={c.id} type="button" className="lr-chip" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>
                  {c.name} <span className="lr-num">{counts.get(c.id) ?? 0}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="lr-body">
            {libErr ? (
              <div className="lr-state" role="alert">
                <p className="lr-state-t">Resources did not load</p>
                <p className="lr-state-s">{libErr}</p>
                <button type="button" className="lr-btn" onClick={refresh}>Try again</button>
              </div>
            ) : !lib ? (
              <div role="status" aria-live="polite">
                <span className="lr-sr">Loading resources…</span>
                {[0, 1, 2, 3].map((i) => <div key={i} className="lr-skel" aria-hidden="true"><span /><span /></div>)}
              </div>
            ) : q.trim() ? (
              searchErr ? (
                <div className="lr-state" role="alert"><p className="lr-state-t">Search failed</p><p className="lr-state-s">{searchErr}</p></div>
              ) : hits === null ? (
                <p className="lr-meta" role="status">Searching…</p>
              ) : !hits.length ? (
                <div className="lr-state" role="status">
                  <p className="lr-state-t">Nothing matches “{q.trim()}”</p>
                  <p className="lr-state-s">Try fewer or different words. Search reads the text of every doc, not only titles.</p>
                </div>
              ) : (
                <ul className="lr-list" aria-label="Search results">
                  <li className="lr-meta lr-num" role="status">{hits.length} {hits.length === 1 ? 'match' : 'matches'}</li>
                  {hits.map((h) => (
                    <li key={h.resourceId + h.heading}>
                      <button type="button" className="lr-row" onClick={() => openDoc(h.resourceId)}>
                        <Icon d={P.file} size={15} />
                        <span className="lr-row-main">
                          <span className="lr-row-t">{h.title}</span>
                          <span className="lr-row-s">{[h.category, h.heading.split(' > ').slice(1).join(' > ')].filter(Boolean).join(' · ')}</span>
                          <span className="lr-snip">{snippetParts(h.snippet).map((p, i) => (p.hit ? <mark key={i} className="lr-mark">{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : !lib.docs.length ? (
              <div className="lr-state">
                <p className="lr-state-t">No resources yet</p>
                <p className="lr-state-s">Add the TC Bible, call scripts, title company checklists and SOPs. Lane reads them when it answers and names the doc it used.</p>
                {canAdd ? <button type="button" className="lr-btn lr-btn-primary" onClick={() => setView('add')}><Icon d={P.plus} size={13} />Add the first doc</button> : null}
              </div>
            ) : !shown.length ? (
              <div className="lr-state">
                <p className="lr-state-t">Nothing in {catName.get(cat) ?? 'this category'} yet</p>
                <p className="lr-state-s">Add a doc here, or file one from another category from its reader.</p>
                {canAdd ? <button type="button" className="lr-btn" onClick={() => setView('add')}><Icon d={P.plus} size={13} />Add a doc to {catName.get(cat) ?? 'this category'}</button> : null}
              </div>
            ) : (
              <ul className="lr-list">
                {shown.map((d) => (
                  <li key={d.id}>
                    <button type="button" className="lr-row" onClick={() => openDoc(d.id)}>
                      <Icon d={P.file} size={15} />
                      <span className="lr-row-main">
                        <span className="lr-row-head">
                          <span className="lr-row-t" title={d.title}>{d.title}</span>
                          {d.pinned ? <span className="lr-badge">Pinned</span> : null}
                        </span>
                        <span className="lr-row-s">{[cat === 'all' ? catName.get(d.categoryId ?? '') : null, sourceOf(d), readTime(d.chars), when(d.updatedAt)].filter(Boolean).join(' · ')}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : view === 'doc' ? (
        <Reader
          key={docId ?? ''}
          ws={ws} doc={doc} err={docErr} lib={lib} admin={admin}
          onBack={back}
          onChanged={(patch) => { setDoc((d) => (d ? { ...d, ...patch } : d)); refresh(); }}
          onRemoved={() => { back(); refresh(); }}
          onRetry={() => { setDocErr(null); setDocNonce((n) => n + 1); }}
        />
      ) : view === 'add' && lib ? (
        <AddDoc ws={ws} lib={lib} defaultCat={cat === 'all' ? null : cat} onBack={back}
          onAdded={(ids) => { refresh(); if (ids.length === 1) openDoc(ids[0]); else back(); }} />
      ) : view === 'cats' && lib ? (
        <Categories ws={ws} lib={lib} onBack={back} onChanged={refresh} />
      ) : null}
    </section>
  );
}

function BackBar({ onBack, label = 'All resources' }: { onBack: () => void; label?: string }) {
  return (
    <div className="lr-top">
      <button type="button" className="lr-btn lr-btn-quiet" onClick={onBack}><Icon d={P.back} size={14} />{label}</button>
    </div>
  );
}

function Reader({ ws, doc, err, lib, admin, onBack, onChanged, onRemoved, onRetry }: {
  ws: number | null; doc: ResourceFull | null; err: string | null; lib: Library | null; admin: boolean;
  onBack: () => void; onChanged: (patch: Partial<ResourceFull>) => void; onRemoved: () => void; onRetry: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [actErr, setActErr] = useState<string | null>(null);
  const catId = useId();
  const cats = lib?.categories ?? [];
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (doc) head.current?.focus(); }, [doc]);

  const refile = (categoryId: string) => {
    if (!doc) return;
    setBusy('category'); setActErr(null);
    updateResource(ws, doc.id, { categoryId: categoryId || null })
      .then(() => onChanged({ categoryId: categoryId || null }), (e: Error) => setActErr(e.message))
      .finally(() => setBusy(null));
  };
  const pin = () => {
    if (!doc) return;
    setBusy('pin'); setActErr(null);
    updateResource(ws, doc.id, { pinned: !doc.pinned })
      .then(() => onChanged({ pinned: !doc.pinned }), (e: Error) => setActErr(e.message))
      .finally(() => setBusy(null));
  };
  const remove = () => {
    if (!doc) return;
    if (!window.confirm(`Remove "${doc.title}" from Resources? Lane stops reading it, and the uploaded file is deleted. This cannot be undone.`)) return;
    setBusy('remove'); setActErr(null);
    removeResource(ws, doc.id).then(onRemoved, (e: Error) => { setActErr(e.message); setBusy(null); });
  };

  return (
    <>
      <BackBar onBack={onBack} />
      <div className="lr-body lr-reader">
        {err ? (
          <div className="lr-state" role="alert">
            <p className="lr-state-t">That doc did not open</p>
            <p className="lr-state-s">{err}</p>
            <button type="button" className="lr-btn" onClick={onRetry}>Try again</button>
          </div>
        ) : !doc ? (
          <div role="status"><span className="lr-sr">Opening the doc…</span><div className="lr-skel lr-skel-doc" aria-hidden="true"><span /><span /><span /><span /></div></div>
        ) : (
          <article>
            <h2 className="lr-doc-t" tabIndex={-1} ref={head}>{doc.title}</h2>
            <p className="lr-meta">{[cats.find((c) => c.id === doc.categoryId)?.name ?? 'No category', sourceOf(doc), readTime(doc.chars), `updated ${when(doc.updatedAt)}`].join(' · ')}</p>
            <div className="lr-doc-actions">
              {doc.fileUrl ? <a className="lr-btn" href={doc.fileUrl} target="_blank" rel="noopener noreferrer"><Icon d={P.external} size={13} />Open original</a> : null}
              {doc.driveUrl ? <a className="lr-btn" href={doc.driveUrl} target="_blank" rel="noopener noreferrer"><Icon d={P.external} size={13} />Open in Drive</a> : null}
              {admin ? (
                <>
                  <button type="button" className="lr-btn" aria-pressed={doc.pinned} onClick={pin} disabled={busy !== null}>
                    {busy === 'pin' ? 'Saving…' : doc.pinned ? 'Unpin' : 'Pin to top'}
                  </button>
                  <label className="lr-inline-label" htmlFor={catId}>Category</label>
                  <select id={catId} className="lr-select" value={doc.categoryId ?? ''} onChange={(e) => refile(e.target.value)} disabled={busy !== null}>
                    <option value="">No category</option>
                    {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button type="button" className="lr-btn lr-btn-danger" onClick={remove} disabled={busy !== null} aria-label={`Remove ${doc.title}`}>
                    <Icon d={P.trash} size={13} />{busy === 'remove' ? 'Removing…' : 'Remove'}
                  </button>
                </>
              ) : null}
            </div>
            {actErr ? <p className="lr-err" role="alert">{actErr}</p> : null}
            <div className="lr-doc-body">
              {doc.body.trim() ? <Markdown text={withoutTitle(doc.body, doc.title)} /> : <p className="lr-meta">This doc has no text. Open the original to read it.</p>}
            </div>
          </article>
        )}
      </div>
    </>
  );
}

type Kind = 'file' | 'text' | 'drive';

function AddDoc({ ws, lib, defaultCat, onBack, onAdded }: { ws: number | null; lib: Library; defaultCat: string | null; onBack: () => void; onAdded: (ids: string[]) => void }) {
  const [kind, setKind] = useState<Kind>('file');
  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState<string>(defaultCat ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ids = { title: useId(), cat: useId(), file: useId(), text: useId(), link: useId() };
  const many = kind === 'file' && files.length > 1;
  const ready = kind === 'file' ? files.length > 0 : kind === 'text' ? !!text.trim() : !!link.trim();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setErr(null);
    const base = { title: title.trim(), categoryId: categoryId || null };
    const input = kind === 'file' ? { kind, files, ...base } as const : kind === 'text' ? { kind, text, ...base } as const : { kind, link: link.trim(), ...base } as const;
    addResources(ws, input).then(onAdded, (x: Error) => { setErr(x.message || 'That doc was not added.'); setBusy(false); });
  };

  return (
    <>
      <BackBar onBack={onBack} />
      <form className="lr-body lr-form" onSubmit={submit} noValidate>
        <h2 className="lr-h">Add a doc</h2>
        <div className="lr-chips" role="group" aria-label="Add from">
          <button type="button" className="lr-chip" aria-pressed={kind === 'file'} onClick={() => setKind('file')}>Upload a file</button>
          <button type="button" className="lr-chip" aria-pressed={kind === 'text'} onClick={() => setKind('text')}>Paste text</button>
          <button type="button" className="lr-chip" aria-pressed={kind === 'drive'} onClick={() => setKind('drive')}>Google Drive link</button>
        </div>

        {kind === 'file' ? (
          <div className="lr-field">
            <label className="lr-label" htmlFor={ids.file}>Files</label>
            <input id={ids.file} className="lr-file" type="file" accept={ACCEPT} multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
            <p className="lr-help">PDF, Word (.docx), Markdown or text, up to 25 MB each. Several files add one doc each. A Google Doc can be saved as .docx or PDF first.</p>
          </div>
        ) : kind === 'text' ? (
          <div className="lr-field">
            <label className="lr-label" htmlFor={ids.text}>Text</label>
            <textarea id={ids.text} className="lr-input lr-textarea" value={text} onChange={(e) => setText(e.target.value)} rows={9} />
            <p className="lr-help">Markdown headings (#, ##) become the sections Lane searches and cites.</p>
          </div>
        ) : (
          <div className="lr-field">
            <label className="lr-label" htmlFor={ids.link}>Drive or Docs link</label>
            <input id={ids.link} className="lr-input" type="url" inputMode="url" value={link} onChange={(e) => setLink(e.target.value)} disabled={!lib.driveConnected} placeholder="https://docs.google.com/document/d/…" />
            <p className="lr-help">
              {lib.driveConnected
                ? 'Read with your Google account: Docs, Sheets, Slides, PDF and Word files. The link stays on the doc.'
                : ws === null ? 'Drive links work in a signed-in workspace with Google Drive connected.' : 'Connect Drive first: Settings → Google → Connect Drive. Until then, upload the file or paste its text.'}
            </p>
          </div>
        )}

        <div className="lr-field">
          <label className="lr-label" htmlFor={ids.title}>Title</label>
          <input id={ids.title} className="lr-input" value={many ? '' : title} onChange={(e) => setTitle(e.target.value)} disabled={many} placeholder={many ? 'Each file keeps its own title' : 'Taken from the doc when left empty'} maxLength={200} />
        </div>
        <div className="lr-field">
          <label className="lr-label" htmlFor={ids.cat}>Category</label>
          <select id={ids.cat} className="lr-select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">No category</option>
            {lib.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        {err ? <p className="lr-err" role="alert">{err}</p> : null}
        <div className="lr-form-actions">
          <button type="button" className="lr-btn" onClick={onBack} disabled={busy}>Cancel</button>
          <button type="submit" className="lr-btn lr-btn-primary" disabled={!ready || busy || (kind === 'drive' && !lib.driveConnected)}>
            {busy ? (kind === 'file' && files.length > 1 ? `Adding ${files.length} docs…` : 'Adding…') : 'Add to resources'}
          </button>
        </div>
      </form>
    </>
  );
}

function Categories({ ws, lib, onBack, onChanged }: { ws: number | null; lib: Library; onBack: () => void; onChanged: () => void }) {
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(lib.categories.map((c) => [c.id, c.name])));
  const [fresh, setFresh] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const freshId = useId();
  const counts = new Map<string, number>();
  for (const d of lib.docs) if (d.categoryId) counts.set(d.categoryId, (counts.get(d.categoryId) ?? 0) + 1);

  const run = (key: string, p: Promise<void>) => {
    setBusy(key); setErr(null);
    p.then(onChanged, (e: Error) => setErr(e.message)).finally(() => setBusy(null));
  };
  const rename = (id: string, position: number) => {
    const name = (names[id] ?? '').trim();
    const was = lib.categories.find((c) => c.id === id)?.name;
    if (!name || name === was) { setNames((n) => ({ ...n, [id]: was ?? '' })); return; }
    run(id, saveCategory(ws, { id, name, position }));
  };
  const remove = (id: string, name: string) => {
    const n = counts.get(id) ?? 0;
    if (!window.confirm(n ? `Remove the category "${name}"? Its ${n} ${n === 1 ? 'doc stays' : 'docs stay'} in Resources with no category.` : `Remove the category "${name}"?`)) return;
    run(id, removeCategory(ws, id));
  };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    if (!fresh.trim()) return;
    run('new', saveCategory(ws, { name: fresh, position: lib.categories.length }).then(() => setFresh('')));
  };

  return (
    <>
      <BackBar onBack={onBack} />
      <div className="lr-body lr-form">
        <h2 className="lr-h">Categories</h2>
        <p className="lr-help">Rename a category by editing it; the change saves when you leave the field.</p>
        <ul className="lr-list">
          {lib.categories.map((c) => (
            <li key={c.id} className="lr-cat">
              <input className="lr-input" aria-label={`Category name, ${c.name}`} value={names[c.id] ?? c.name} maxLength={60}
                onChange={(e) => setNames((n) => ({ ...n, [c.id]: e.target.value }))}
                onBlur={() => rename(c.id, c.position)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
              <span className="lr-meta lr-num" style={{ minWidth: 44, textAlign: 'right' }}>{counts.get(c.id) ?? 0} {(counts.get(c.id) ?? 0) === 1 ? 'doc' : 'docs'}</span>
              <button type="button" className="lr-icon-btn" aria-label={`Remove category ${c.name}`} title="Remove category" onClick={() => remove(c.id, c.name)} disabled={busy !== null}>
                <Icon d={P.trash} size={14} />
              </button>
            </li>
          ))}
        </ul>
        <form className="lr-cat-add" onSubmit={add}>
          <div className="lr-field" style={{ flex: 1, margin: 0 }}>
            <label className="lr-label" htmlFor={freshId}>New category</label>
            <input id={freshId} className="lr-input" value={fresh} onChange={(e) => setFresh(e.target.value)} maxLength={60} />
          </div>
          <button type="submit" className="lr-btn" disabled={!fresh.trim() || busy !== null}>{busy === 'new' ? 'Adding…' : 'Add category'}</button>
        </form>
        {err ? <p className="lr-err" role="alert">{err}</p> : null}
        {busy && busy !== 'new' ? <p className="lr-meta" role="status">Saving…</p> : null}
      </div>
    </>
  );
}
