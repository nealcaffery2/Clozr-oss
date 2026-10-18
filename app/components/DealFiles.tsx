// A deal's files and photos: bulk upload (pick or drop many), paste links —
// photo links show as photos — open, remove. `mode="photos"` is property media.
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DOC_LABEL, DOC_TYPES, FOLDER_HOST, IMAGE_URL, type DealFile, type DocType, addDealLinks, docLabelOf, fileUrl, listDealFiles, pullComprPhotos, pullDrivePhotos, removeDealFile, setDealFileCover, setDealFileNotary, setDealFileType, uploadDealFiles } from '@/lib/deal-files';
import { InteractiveFolderGallery } from '@/components/ui/interactive-folder-gallery';
import { photoKey } from '@/lib/house-photos';
import { PhotoOrderPanel } from '@/components/PhotoOrderPanel';

const btn: React.CSSProperties = { height: '30px', padding: '0 11px', borderRadius: '8px', border: '1px solid var(--divider, #e4e4e7)', background: 'var(--surface, #fff)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', color: 'var(--ink, #18181b)', whiteSpace: 'nowrap' };
const isPhotoLink = (f: DealFile) => f.kind === 'link' && f.category === 'photos';
const DRIVE = /drive\.google\.com/i;
/** A shared folder or album, not one image: opened where it lives. */
const isPhotoFolder = (f: DealFile) => !!f.url && !IMAGE_URL.test(f.url)
  && (isPhotoLink(f) || (f.kind === 'photo' && !f.storage_path && FOLDER_HOST.test(f.url)));
/** "Google Drive photo folder" — what the rep will open. */
function folderLabel(url: string | null): string {
  const u = url ?? '';
  if (/drive\.google\.com|docs\.google\.com/i.test(u)) return 'Google Drive photo folder';
  if (/dropbox\.com/i.test(u)) return 'Dropbox photo folder';
  if (/photos\.app\.goo\.gl|photos\.google\.com/i.test(u)) return 'Google Photos album';
  if (/icloud\.com/i.test(u)) return 'iCloud photo album';
  if (/companycam/i.test(u)) return 'CompanyCam photos';
  if (/onedrive|sharepoint|1drv\.ms/i.test(u)) return 'OneDrive photo folder';
  try { return `Photos on ${new URL(u).hostname.replace(/^www\./, '')}`; } catch { return 'Photo folder'; }
}

/** Front of the house first, then a Vuer's iVueit set, then COMPR's set in COMPR's order, then everything else oldest first. */
function orderPhotos(list: DealFile[]): DealFile[] {
  const rank = (f: DealFile) => (f.is_cover ? 0 : f.source === 'ivueit' ? 1 : f.source === 'compr' ? 2 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b)
    || (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
    || a.created_at.localeCompare(b.created_at));
}
const size = (n: number | null) => (n == null ? '' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');

export function DealFiles({ workspaceId, dealId, canWrite, mode = 'files', onToast, onOpenPhotos, fallbackPhotos, orderRequest = 0 }: {
  workspaceId: number | null; dealId: number | null; canWrite: boolean; mode?: 'files' | 'photos';
  /** Photos the screen already shows (front first), for the folder while the deal has no photo rows yet. */
  fallbackPhotos?: string[];
  /** Bumped by a screen's own Order photos button: scroll here and open the iVueit form. */
  orderRequest?: number;
  onToast?: (m: string) => void;
  /** When set, photo clicks open a slideshow instead of dumping to Drive / a new tab. */
  onOpenPhotos?: (title: string, urls: string[], startIndex: number) => void;
}) {
  const [rows, setRows] = useState<DealFile[] | null>(null);
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState<'photo' | 'link' | null>(null);
  const [text, setText] = useState('');
  const [drag, setDrag] = useState(false);
  const [driveReading, setDriveReading] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const autoDrive = useRef<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const toast = onToast ?? (() => {});

  const load = useCallback(async () => {
    if (!dealId) return;
    const list = await listDealFiles(dealId);
    setRows(list);
    // Photos need a src up front; files resolve on Open.
    const photos = list.filter((f) => f.kind === 'photo');
    const pairs = await Promise.all(photos.map(async (f) => [f.id, await fileUrl(f)] as const));
    setUrls(Object.fromEntries(pairs.filter((p): p is readonly [number, string] => !!p[1])));
  }, [dealId]);
  // Load after paint; the async setState lands in a callback, not the effect body.
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  const readDrive = useCallback(async (force: boolean) => {
    if (!workspaceId || !dealId) return;
    setDriveReading(true);
    const r = await pullDrivePhotos(workspaceId, dealId, force);
    setDriveReading(false);
    if (force) {
      onToast?.(!r.ok ? r.message
        : r.count ? `${r.count} photo${r.count === 1 ? '' : 's'} from the Drive folder, subfolders included`
          : r.failed ? 'Drive would not open that folder. Share it as "Anyone with the link" and pull again.'
            : 'No photos in the Drive folder.');
    }
    if (r.ok && r.count) void load();
  }, [workspaceId, dealId, load, onToast]);
  useEffect(() => {
    if (!orderRequest) return;
    const t = setTimeout(() => {
      setOrdering(true);
      root.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 0);
    return () => clearTimeout(t);
  }, [orderRequest]);
  // A Drive photo folder nothing has read yet: read it once, as the card opens.
  useEffect(() => {
    if (!canWrite || !rows || !dealId || rows.some((f) => f.kind === 'photo')) return;
    if (!rows.some((f) => (isPhotoLink(f) || f.kind === 'photo') && DRIVE.test(f.url ?? ''))) return;
    const t = setTimeout(() => {
      if (autoDrive.current === dealId) return;
      autoDrive.current = dealId;
      void readDrive(false);
    }, 0);
    return () => clearTimeout(t);
  }, [canWrite, rows, dealId, readDrive]);

  if (!workspaceId || !dealId) {
    return <div style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)', padding: '12px 0' }}>No deal on this record yet — files attach to a deal.</div>;
  }

  const upload = async (files: File[]) => {
    if (!files.length) return;
    const list = mode === 'photos' ? files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i.test(f.name)) : files;
    if (!list.length) return toast('Only images go in property media.');
    setBusy(true);
    const r = await uploadDealFiles(workspaceId, dealId, list);
    setBusy(false);
    toast(r.ok ? `${r.count} uploaded` : r.message);
    void load();
  };
  const addLinks = async () => {
    if (!paste) return;
    setBusy(true);
    const r = await addDealLinks(workspaceId, dealId, text, paste);
    setBusy(false);
    if (!r.ok) return toast(r.message);
    toast(`${r.count} link${r.count === 1 ? '' : 's'} added`);
    setText(''); setPaste(null);
    void load();
  };
  const shown = (rows ?? []).filter((f) => (mode === 'photos' ? f.kind === 'photo' || isPhotoLink(f) : true));
  // A photo link that is an image goes in the gallery; a Drive / Dropbox /
  // Podio folder is opened where it lives. Neither is a document.
  const rawPhotos = orderPhotos(shown.filter((f) => (f.kind === 'photo' || isPhotoLink(f)) && !isPhotoFolder(f)));
  // One tile per real shot: COMPR proxy URLs rotate tokens but share lead_id+pos.
  const photos = (() => {
    const out: DealFile[] = [];
    const seen = new Set<string>();
    for (const f of rawPhotos) {
      const src = urls[f.id] || f.url || '';
      const key = photoKey(src) || `id:${f.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  })();
  const folders = shown.filter(isPhotoFolder);
  const driveFolder = folders.some((f) => DRIVE.test(f.url ?? ''));
  const photoSrc = (f: DealFile) => urls[f.id] || f.url || '';
  const fallback = photos.length ? [] : (fallbackPhotos ?? []).filter(Boolean);
  const gallery = photos.length
    ? photos.map((f, i) => ({ id: f.id, image: photoSrc(f), label: i === 0 && (f.is_cover || photos.length > 1) ? 'Front' : undefined })).filter((g) => g.image)
    : fallback.map((u, i) => ({ id: 'fb' + i, image: u, label: i === 0 ? 'Front' : undefined }));
  const others = mode === 'photos' ? [] : shown.filter((f) => f.kind !== 'photo' && !isPhotoLink(f));
  const hasPhotoSection = photos.length > 0 || folders.length > 0 || fallback.length > 0;
  const open = async (f: DealFile) => {
    if (f.kind === 'photo' && onOpenPhotos) {
      const withSrc = photos.filter((p) => !!(urls[p.id] || p.url));
      const list = withSrc.map((p) => (urls[p.id] || p.url) as string);
      if (list.length) {
        const idx = Math.max(0, withSrc.findIndex((p) => p.id === f.id));
        onOpenPhotos('Property photos', list, idx);
        return;
      }
    }
    const u = urls[f.id] ?? await fileUrl(f);
    if (u) window.open(u, '_blank', 'noopener,noreferrer'); else toast('Could not open that file.');
  };
  // Edits land on screen before the write, and only a failure re-reads: a full
  // load() re-signs every photo URL, which is the wait reps saw after each pick.
  const patchRow = (id: number, patch: Partial<DealFile>) => setRows((rs) => rs && rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const markNotary = async (f: DealFile) => {
    const next = !f.needs_notary;
    patchRow(f.id, { needs_notary: next, notary_status: next ? 'needed' : null });
    const r = await setDealFileNotary(f.id, next);
    toast(r.ok ? (next ? 'Marked for notarization' : 'Notary flag cleared') : r.message);
    if (!r.ok) void load();
  };
  const relabel = async (f: DealFile, type: DocType | null) => {
    patchRow(f.id, { category: type });
    const r = await setDealFileType(f.id, type);
    toast(r.ok ? (type ? `Labelled ${DOC_LABEL[type]} · ${f.name}` : `Label cleared · ${f.name}`) : r.message);
    if (!r.ok) void load();
  };
  const makeFront = async (f: DealFile) => {
    const r = await setDealFileCover(f);
    toast(r.ok ? 'Front of the house set — deals, dispo and blasts lead with it' : r.message);
    void load();
  };
  const pullCompr = async () => {
    setBusy(true);
    const r = await pullComprPhotos(workspaceId, dealId);
    setBusy(false);
    toast(r.ok ? `${r.count} COMPR photo${r.count === 1 ? '' : 's'} synced, front of the house first` : r.message);
    void load();
  };
  const remove = async (f: DealFile) => {
    if (!window.confirm(`Remove ${f.name} from this deal?`)) return;
    setRows((rs) => rs && rs.filter((r) => r.id !== f.id));
    const r = await removeDealFile(f);
    toast(r.ok ? 'Removed' : r.message);
    if (!r.ok) void load();
  };

  return (
    <div
      ref={root}
      onDragOver={canWrite ? (e) => { e.preventDefault(); setDrag(true); } : undefined}
      onDragLeave={() => setDrag(false)}
      onDrop={canWrite ? (e) => { e.preventDefault(); setDrag(false); void upload(Array.from(e.dataTransfer.files)); } : undefined}
      style={{ border: drag ? '2px dashed #0A8560' : '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', background: 'var(--surface, #fff)', padding: '12px 14px' }}
    >
      {canWrite ? (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input ref={input} type="file" multiple accept={mode === 'photos' ? 'image/*' : undefined} hidden
            onChange={(e) => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <button type="button" style={{ ...btn, background: '#0A8560', borderColor: '#0A8560', color: '#fff' }} disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'Working…' : mode === 'photos' ? 'Upload photos' : 'Upload files'}
          </button>
          <button type="button" data-testid="order-photos" style={{ ...btn, display: 'inline-flex', alignItems: 'center', gap: '6px' }} aria-expanded={ordering} onClick={() => setOrdering((v) => !v)}
            title="A local iVueit Vuer photographs this house. The photos land here when they are done.">
            <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}>
              <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" />
            </svg>
            Order photos
          </button>
          <button type="button" style={btn} onClick={() => setPaste(paste === 'photo' ? null : 'photo')}>Add photo links</button>
          <button type="button" style={btn} disabled={busy} onClick={() => void pullCompr()} title="Photo set and front photo from this deal's COMPR report. Nothing is billed.">Pull COMPR photos</button>
          {driveFolder ? (
            <button type="button" style={btn} disabled={driveReading} onClick={() => void readDrive(true)} title="Every photo in this deal's Google Drive folder, subfolders included. Nothing is copied.">
              {driveReading ? 'Reading Drive…' : 'Pull Drive photos'}
            </button>
          ) : null}
          {mode === 'files' ? <button type="button" style={btn} onClick={() => setPaste(paste === 'link' ? null : 'link')}>Add links</button> : null}
          <span style={{ fontSize: '11.5px', color: 'var(--subtle, #a1a1aa)' }}>or drop {mode === 'photos' ? 'photos' : 'files'} here · many at once</span>
        </div>
      ) : null}
      <PhotoOrderPanel workspaceId={workspaceId} dealId={dealId} canWrite={canWrite} open={canWrite && ordering}
        onClose={() => setOrdering(false)} onToast={toast} onPhotosIn={() => void load()} />
      {paste ? (
        <div style={{ marginTop: '10px', display: 'grid', gap: '6px' }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus
            placeholder={paste === 'photo' ? 'Paste photo links — one per line (Drive, Dropbox, CompanyCam, direct image links)' : 'Paste links — one per line'}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '8px', fontSize: '12.5px', resize: 'vertical', background: 'var(--canvas, #fafafa)' }} />
          <div><button type="button" style={{ ...btn, background: 'var(--c-primary)', color: '#fff', borderColor: 'var(--c-primary)' }} disabled={busy || !text.trim()} onClick={() => void addLinks()}>Add</button></div>
        </div>
      ) : null}

      {rows === null ? <div style={{ fontSize: '12px', color: 'var(--subtle, #a1a1aa)', marginTop: '10px' }}>Loading…</div> : null}
      {rows !== null && shown.length === 0 && !fallback.length ? (
        <div style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)', marginTop: '10px' }}>{mode === 'photos' ? 'No photos on this deal yet.' : 'No files on this deal yet.'}{canWrite ? ' Order photos sends a Vuer to shoot the house.' : ''}</div>
      ) : null}

      {hasPhotoSection ? (
        <div style={{ marginTop: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--ink, #18181b)' }}>Property photos</span>
            <span style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)' }}>
              {[photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : '', folders.length ? `${folders.length} folder${folders.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'front of the house'}
            </span>
          </div>
          {gallery.length ? (
            <div style={{ marginTop: '8px', padding: '6px 0', display: 'flex', justifyContent: 'center', background: 'transparent' }}>
              <InteractiveFolderGallery
                size="sm"
                photos={gallery}
                folderName={photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : folders.length ? folderLabel(folders[0].url) : 'Front of house'}
                dragHintText="Tap a photo to view · drag down to close"
                onPhotoClick={(i) => {
                  // `gallery` drops photos with no URL yet, so look the tile up by id, not position.
                  const f = photos.length ? photos.find((p) => p.id === gallery[i]?.id) : undefined;
                  if (f) void open(f);
                  else if (!photos.length) onOpenPhotos?.('Property photos', fallback, i);
                }}
              />
            </div>
          ) : null}
          {folders.length ? (
            <div style={{ display: 'grid', gap: '6px', marginTop: '8px' }}>
              {folders.map((f) => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', background: 'var(--canvas, #fafafa)' }}>
                  <span aria-hidden style={{ width: '30px', height: '24px', flex: '0 0 30px', position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 0, top: 0, width: '13px', height: '6px', background: '#2a2a2a', borderRadius: '3px 3px 0 0' }} />
                    <span style={{ position: 'absolute', left: 0, right: 0, top: '4px', bottom: 0, background: 'linear-gradient(#2a2a2a,#111)', borderRadius: '0 4px 4px 4px' }} />
                  </span>
                  <a href={f.url ?? '#'} target="_blank" rel="noopener noreferrer" style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'var(--ink, #18181b)' }}>
                    <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{folderLabel(f.url)}</div>
                    <div style={{ fontSize: '11px', color: 'var(--meta, #71717a)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {f.source === 'podio' ? 'From Podio' : 'Photo link'} · {new Date(f.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                  </a>
                  <a href={f.url ?? '#'} target="_blank" rel="noopener noreferrer" style={{ ...btn, display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>Open ↗</a>
                  {canWrite ? <button type="button" onClick={() => void remove(f)} title="Remove" style={{ border: 0, background: 'none', color: 'var(--subtle, #a1a1aa)', cursor: 'pointer' }}>✕</button> : null}
                </div>
              ))}
            </div>
          ) : null}
          {!photos.length && (fallback.length || folders.length) ? (
            <div style={{ fontSize: '11.5px', color: 'var(--meta, #71717a)', marginTop: '6px' }}>
              {driveReading ? 'Reading the Google Drive folder, subfolders included…'
                : <>{fallback.length ? 'Front of the house on file. ' : ''}Pull COMPR photos for the full set{folders.length ? ', or open the folder' : ''}.</>}
            </div>
          ) : null}
          {photos.length ? (
          <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', padding: '10px 0 2px' }}>
            {photos.map((f, i) => {
              const src = photoSrc(f);
              const front = i === 0;
              return (
                <div key={f.id} style={{ flex: '0 0 112px', border: front ? '2px solid #0A8560' : '1px solid var(--divider, #e4e4e7)', borderRadius: '10px', overflow: 'hidden', background: 'var(--surface-2, #f4f4f5)' }}>
                  <button type="button" onClick={() => void open(f)} title={f.name}
                    style={{ position: 'relative', display: 'block', width: '100%', height: '76px', border: 0, padding: 0, cursor: 'pointer', background: src ? `#e9ebf0 url("${src.replace(/"/g, '%22')}") center/cover no-repeat` : '#e9ebf0' }}>
                    {front ? <span style={{ position: 'absolute', top: '5px', left: '5px', background: '#0A8560', color: '#fff', fontSize: '11px', fontWeight: 700, padding: '2px 6px', borderRadius: '999px' }}>Front</span> : null}
                    {f.source === 'ivueit' ? <span style={{ position: 'absolute', bottom: '5px', right: '5px', background: 'rgba(12,14,18,.72)', color: '#fff', fontSize: '9.5px', fontWeight: 600, padding: '1px 5px', borderRadius: '5px' }}>iVueit</span> : null}
                    {f.source === 'compr' ? <span style={{ position: 'absolute', bottom: '5px', right: '5px', background: 'rgba(12,14,18,.72)', color: '#fff', fontSize: '9.5px', fontWeight: 600, padding: '1px 5px', borderRadius: '5px' }}>COMPR</span> : null}
                    {!src || (f.url && f.source !== 'compr' && !IMAGE_URL.test(f.url)) ? <span style={{ fontSize: '11px', color: 'var(--muted, #52525b)', padding: '0 6px' }}>Photo link ↗</span> : null}
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 6px', fontSize: '11px' }}>
                    {canWrite && !front && f.kind === 'photo' ? (
                      <button type="button" onClick={() => void makeFront(f)} title="Use this as the front of the house" style={{ border: 0, background: 'none', color: 'var(--tx-mint, #0a8560)', fontWeight: 600, cursor: 'pointer', padding: 0, fontSize: '11px' }}>Make front</button>
                    ) : (
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--muted, #52525b)' }}>{front ? 'Front of house' : f.name}</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {canWrite ? <button type="button" onClick={() => void remove(f)} title="Remove" style={{ border: 0, background: 'none', color: 'var(--subtle, #a1a1aa)', cursor: 'pointer' }}>✕</button> : null}
                  </div>
                </div>
              );
            })}
          </div>
          ) : null}
        </div>
      ) : null}

      {others.length ? (
        // Grouped by what each document is, the TC's order: commitment, contract, CD…; unlabelled last.
        <div style={{ marginTop: '10px' }}>
          {[...DOC_TYPES, null].map((type) => {
            const list = others.filter((f) => (docLabelOf(f) ? f.category : null) === type);
            if (!list.length) return null;
            return (
              <div key={type ?? 'none'} style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '11px', color: 'var(--meta, #71717a)', fontWeight: 600, padding: '4px 0' }}>
                  {type ? DOC_LABEL[type] : 'Not labelled'} · {list.length}
                </div>
                {list.map((f) => (
                  // Stacked, not five columns: the record's side panel is narrow, and a
                  // grid squeezed the name to a sliver.
                  <div key={f.id} style={{ padding: '9px 0', borderTop: '1px solid var(--divider-2, #f0f0f1)', display: 'grid', gap: '6px' }}>
                    <button type="button" onClick={() => void open(f)} title={`Open ${f.name}`}
                      style={{ display: 'block', minWidth: 0, width: '100%', textAlign: 'left', border: 0, background: 'none', padding: 0, cursor: 'pointer', color: 'var(--ink, #18181b)' }}>
                      <span style={{ display: 'block', fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                      <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {f.kind === 'link' ? 'Link' : 'File'}{f.byte_size ? ' · ' + size(f.byte_size) : ''} · {new Date(f.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        {f.source === 'gmail' ? <span style={{ color: 'var(--tx-mint, #0a8560)', fontWeight: 600 }}> · from email</span> : null}
                        {f.needs_notary ? <span style={{ color: 'var(--tx-amber, #b45309)', fontWeight: 600 }}> · notary {f.notary_status || 'needed'}</span> : null}
                      </span>
                    </button>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                      <button type="button" style={{ ...btn, height: '26px' }} onClick={() => void open(f)}>Open</button>
                      {canWrite ? (
                        <select aria-label={`What ${f.name} is`} value={docLabelOf(f) ? f.category! : ''} onChange={(e) => void relabel(f, (e.target.value || null) as DocType | null)}
                          style={{ height: '26px', minWidth: 0, maxWidth: '150px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '7px', fontSize: '11.5px', background: 'var(--surface, #fff)', color: 'var(--ink, #18181b)' }}>
                          <option value="">Label…</option>
                          {DOC_TYPES.map((t) => <option key={t} value={t}>{DOC_LABEL[t]}</option>)}
                        </select>
                      ) : null}
                      {canWrite ? (
                        <button type="button" style={{ ...btn, height: '26px', color: f.needs_notary ? 'var(--tx-amber, #b45309)' : 'var(--ink, #18181b)' }} onClick={() => void markNotary(f)}>
                          {f.needs_notary ? 'Needs notary' : 'Notarize'}
                        </button>
                      ) : null}
                      <span style={{ flex: 1 }} />
                      {canWrite ? <button type="button" onClick={() => void remove(f)} title={`Remove ${f.name}`} aria-label={`Remove ${f.name}`} style={{ border: 0, background: 'none', color: 'var(--subtle, #a1a1aa)', cursor: 'pointer', fontSize: '13px' }}>✕</button> : null}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
