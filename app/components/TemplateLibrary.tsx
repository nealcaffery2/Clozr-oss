// The template library, opened from the Contracts screen's Templates button:
// folders on the left, the templates in the chosen folder, and the editor.
// A template that contracts were made from is never changed underneath them —
// saving it makes the next version (the contracts function decides; see
// supabase/functions/_shared/doc-library.ts), and History shows every version
// with what changed, line by line, and can bring an old one back.
// The Sections tab is the clause library: reusable text a template places as
// {{block:<id>}}. Locked sections are only placed by reference, so their words
// stay the same everywhere they are used.
'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  type DocBlock, type Library, type LibraryTemplate, type ListedTemplate, type ReminderPolicy, type TemplateVersion,
  KIND_LABELS, TOKEN_HELP, addStarterBlocks, archiveTemplate, deleteBlock, duplicateTemplate, folderOp, loadLibrary, moveTemplate,
  restoreTemplateVersion, saveBlock, saveLibraryTemplate, templateVersions,
} from '@/lib/contracts';
import { VAR_HELP } from '@/supabase/functions/_shared/doc-vars';
import { type PdfTemplate, updatePdfTemplate } from '@/lib/pdf-docs';
import { loadSettings } from '@/lib/integrations';
import { DocImport } from '@/components/DocImport';
import { type Letterhead, TemplateCard, TemplatePreview } from '@/components/TemplateGallery';

// The field editor and pdf.js load only when a PDF template's fields are opened.
const TemplateFieldsDialog = React.lazy(() => import('@/components/PdfFieldDialogs').then((m) => ({ default: m.TemplateFieldsDialog })));
import { blockToken, blocksIn } from '@/supabase/functions/_shared/doc-blocks';
import { diffLines, diffStat, folderAndBelow, folderTree, versionLabel } from '@/supabase/functions/_shared/doc-library';

const INK = '#18181b';
const MUTED = '#71717a';
const LINE = '#e4e4e7';
const HAIR = '#f0f0f1';
const GREEN = '#0A8560';
const MONO = 'ui-monospace, Menlo, monospace';

const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: MUTED, fontWeight: 600, marginBottom: '5px' };
const field: React.CSSProperties = { width: '100%', height: '32px', padding: '0 9px', border: `1px solid ${LINE}`, borderRadius: '8px', fontSize: '12.5px', outline: 0, background: '#fff', color: INK, fontFamily: 'inherit' };
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  height: '30px', padding: '0 11px', borderRadius: '8px', fontSize: '12px', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit',
  border: `1px solid ${primary ? GREEN : LINE}`, background: primary ? (disabled ? '#7fcbb2' : GREEN) : '#fff', color: primary ? '#fff' : INK, opacity: !primary && disabled ? 0.6 : 1,
});
const link: React.CSSProperties = { fontSize: '12px', color: GREEN, background: 'none', border: 0, cursor: 'pointer', padding: 0, fontWeight: 600, fontFamily: 'inherit' };
const panel: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: '12px', minWidth: 0 };
const badge = (color: string, bg: string): React.CSSProperties => ({ fontSize: '11px', fontWeight: 700, color, background: bg, borderRadius: '999px', padding: '2px 7px', whiteSpace: 'nowrap' });

type FolderSel = 'all' | 'none' | number;
type Draft = {
  template_id: number | null; name: string; kind: string; body_md: string; signers: string; folder_id: number | null;
  expiry: string; order: '' | 'parallel' | 'sequential'; remindFirst: string; remindRepeat: string;
};
type BlockDraft = { id: number | null; name: string; body: string; tags: string; locked: boolean };

const draftOf = (t: ListedTemplate | TemplateVersion): Draft => ({
  template_id: t.id, name: t.name, kind: t.kind, body_md: t.body_md, signers: JSON.stringify(t.signers ?? []), folder_id: t.folder_id ?? null,
  expiry: t.default_expiry_days ? String(t.default_expiry_days) : '', order: t.default_signing_order ?? '',
  remindFirst: t.reminder_policy ? String(t.reminder_policy.first_after_days) : '', remindRepeat: t.reminder_policy ? String(t.reminder_policy.repeat_every_days) : '',
});
const NEW_DRAFT: Draft = {
  template_id: null, name: 'New template', kind: 'other', body_md: '# Title\n\nThis agreement is between {{company.entity}} and {{seller.name}} for {{property.address}}.\n\n{{sign:seller}}\n\n{{sign:company}}\n',
  signers: JSON.stringify([{ role: 'seller', label: 'Seller', party: 'seller' }, { role: 'company', label: 'Company', party: 'company' }]),
  folder_id: null, expiry: '', order: '', remindFirst: '', remindRepeat: '',
};

export function TemplateLibrary({ workspaceId, onToast, onUse }: {
  workspaceId: number;
  onToast: (m: string) => void;
  /** Start a new contract from this template. The caller picks the person or buyer. */
  onUse?: (template: ListedTemplate) => void;
}) {
  const [loaded, setLoaded] = useState<{ key: number; lib: Library | null; err?: string } | null>(null);
  const [rev, setRev] = useState(0);
  const [tab, setTab] = useState<'templates' | 'sections'>('templates');
  const [folderSel, setFolderSel] = useState<FolderSel>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [view, setView] = useState<'edit' | 'history'>('edit');
  const [versions, setVersions] = useState<TemplateVersion[] | null>(null);
  const [compareId, setCompareId] = useState<number | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [kindSel, setKindSel] = useState('');
  const [preview, setPreview] = useState<ListedTemplate | null>(null);
  const [pdfFields, setPdfFields] = useState<PdfTemplate | null>(null);
  const [showBuiltIns, setShowBuiltIns] = useState<boolean | null>(null);
  const [head, setHead] = useState<Letterhead>({});
  useEffect(() => {
    let live = true;
    void loadSettings(workspaceId).then((v) => { if (live) setHead(v.company ?? {}); });
    return () => { live = false; };
  }, [workspaceId]);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let live = true;
    void loadLibrary(workspaceId).then((r) => {
      if (!live) return;
      setLoaded(r.ok ? { key: workspaceId, lib: r.data } : { key: workspaceId, lib: null, err: r.message });
    });
    return () => { live = false; };
  }, [workspaceId, rev]);

  const lib = loaded && loaded.key === workspaceId ? loaded.lib : null;
  const ro = !lib?.can_edit;
  const tree = useMemo(() => folderTree(lib?.folders ?? []), [lib]);
  const reload = () => setRev((r) => r + 1);
  const selected = draft?.template_id != null ? lib?.templates.find((t) => t.id === draft.template_id) ?? null : null;

  const inFolder = (t: ListedTemplate) => {
    if (folderSel === 'all') return true;
    if (folderSel === 'none') return t.folder_id == null || !tree.some((f) => f.id === t.folder_id);
    return t.folder_id != null && folderAndBelow(lib?.folders ?? [], folderSel).has(t.folder_id);
  };
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (lib?.templates ?? []).filter((t) => (showArchived ? true : !t.archived_at) && inFolder(t) && terms.every((w) => `${t.name} ${KIND_LABELS[t.kind as keyof typeof KIND_LABELS] ?? t.kind}`.toLowerCase().includes(w)));
  const archivedCount = (lib?.templates ?? []).filter((t) => t.archived_at).length;
  const isPdf = (t: ListedTemplate) => (t as PdfTemplate).mode === 'pdf';
  const typed = shown.filter((t) => !kindSel || t.kind === kindSel);
  // Your own documents first (uploaded PDFs, then your text templates); CLOZR's built-in text ones fold away below.
  const mine = typed.filter((t) => !t.built_in).sort((a, b) => Number(isPdf(b)) - Number(isPdf(a)) || a.name.localeCompare(b.name));
  const builtIns = typed.filter((t) => t.built_in);
  const builtInsOpen = showBuiltIns ?? !(lib?.templates ?? []).some((t) => isPdf(t) && !t.archived_at);
  const countIn = (id: number) => (lib?.templates ?? []).filter((t) => !t.archived_at && t.folder_id != null && folderAndBelow(lib?.folders ?? [], id).has(t.folder_id)).length;

  function open(t: ListedTemplate) {
    setDraft(draftOf(t)); setView('edit'); setVersions(null); setCompareId(null); setPicker(false);
  }

  // ------------------------------------------------------------ template actions
  async function save() {
    if (!draft) return;
    let signers: ListedTemplate['signers'];
    try { signers = JSON.parse(draft.signers); if (!Array.isArray(signers)) throw new Error('signers must be a list'); } catch (e) { return onToast(`Signers is not valid JSON: ${(e as Error).message}`); }
    const reminders: ReminderPolicy | null = draft.remindFirst === '' && draft.remindRepeat === '' ? null : { first_after_days: Number(draft.remindFirst || 0), repeat_every_days: Number(draft.remindRepeat || 0) };
    setBusy(true);
    const r = await saveLibraryTemplate(workspaceId, {
      template_id: draft.template_id, name: draft.name, kind: draft.kind, body_md: draft.body_md, signers, folder_id: draft.folder_id,
      default_expiry_days: draft.expiry ? Number(draft.expiry) : null, default_signing_order: draft.order || null, reminder_policy: reminders,
    });
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    onToast(r.data.versioned ? `Saved as v${r.data.template.version ?? 1}. Contracts already made keep the version they were made from.` : 'Template saved');
    setDraft((d) => (d ? { ...d, template_id: r.data.template.id } : d));
    setVersions(null);
    reload();
  }
  async function act(p: Promise<{ ok: true; data: { template: LibraryTemplate } } | { ok: false; message: string }>, done: string, openAfter = true) {
    setBusy(true);
    const r = await p;
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    onToast(done);
    // Open what came back: the copy after Duplicate, this workspace's own row after filing or hiding a built-in.
    if (openAfter) setDraft(draftOf({ ...r.data.template, family_id: 0, used: 0, used_this: 0, built_in: false }));
    setVersions(null); setView('edit');
    reload();
  }
  async function showHistory() {
    if (!selected) return;
    setView('history'); setCompareId(null);
    const r = await templateVersions(workspaceId, selected.id);
    if (!r.ok) return onToast(r.message);
    setVersions(r.data.versions);
  }
  async function afterRestore(v: TemplateVersion) {
    if (!window.confirm(`Bring back v${v.version ?? 1} as the newest version? Nothing is deleted; the current text stays in history.`)) return;
    setBusy(true);
    const r = await restoreTemplateVersion(workspaceId, v.id);
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    onToast(`v${r.data.restored_from} is back, as v${r.data.template.version ?? 1}`);
    setDraft(draftOf({ ...r.data.template, family_id: 0, used: 0, used_this: 0, built_in: false }));
    setView('edit'); setVersions(null);
    reload();
  }
  async function move(templateId: number, folderId: number | null) {
    const t = lib?.templates.find((x) => x.id === templateId);
    if (!t || (t.folder_id ?? null) === folderId) return;
    const editing = draft?.template_id === templateId ? draft : null;
    setBusy(true);
    const r = await moveTemplate(workspaceId, templateId, folderId);
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    onToast(folderId ? `Moved to ${tree.find((f) => f.id === folderId)?.path ?? 'folder'}` : 'Moved out of folders');
    // Unsaved edits in the open editor are kept; a built-in now points at this workspace's own copy.
    if (editing) setDraft({ ...editing, template_id: r.data.template.id, folder_id: folderId });
    reload();
  }

  async function openHistory(t: ListedTemplate) {
    open(t); setView('history');
    const r = await templateVersions(workspaceId, t.id);
    if (!r.ok) return onToast(r.message);
    setVersions(r.data.versions);
  }
  async function renamePdf(t: ListedTemplate) {
    const name = window.prompt('Rename template', t.name);
    if (!name?.trim() || name.trim() === t.name) return;
    const r = await updatePdfTemplate(t.id, { name: name.trim() });
    if (!r.ok) return onToast(r.message);
    setPreview({ ...t, name: name.trim() });
    reload();
  }
  /** The buttons beside a preview. */
  function previewActions(t: ListedTemplate) {
    const pdf = isPdf(t);
    const close = () => setPreview(null);
    const useIt = onUse && !t.archived_at ? (
      <button type="button" onClick={() => { close(); onUse(t); }} style={{ ...btn(true), height: '34px' }}>Use this template</button>
    ) : null;
    if (ro) {
      return useIt ?? <div style={{ fontSize: '12px', color: MUTED }}>Only an owner or admin can change templates.</div>;
    }
    return (
      <>
        {useIt}
        {pdf ? <button type="button" onClick={() => { close(); setPdfFields(t as PdfTemplate); }} style={{ ...btn(!useIt), height: '34px' }}>Edit fields</button>
          : <button type="button" onClick={() => { close(); open(t); }} style={{ ...btn(!useIt), height: '34px' }}>{t.built_in ? 'Customize text' : 'Edit text'}</button>}
        {pdf ? <button type="button" onClick={() => void renamePdf(t)} style={{ ...btn(), height: '34px' }}>Rename</button> : null}
        {!pdf ? <button type="button" onClick={() => { close(); void openHistory(t); }} style={{ ...btn(), height: '34px' }}>History</button> : null}
        {!pdf ? <button type="button" disabled={busy} onClick={() => { close(); void act(duplicateTemplate(workspaceId, t.id), 'Duplicated. You are now editing the copy.'); }} style={{ ...btn(false, busy), height: '34px' }}>Duplicate</button> : null}
        <select value={t.folder_id ?? ''} onChange={(e) => { const id = e.target.value ? Number(e.target.value) : null; void move(t.id, id); setPreview({ ...t, folder_id: id }); }} aria-label="Move to folder" style={{ ...field, height: '34px' }}>
          <option value="">Folder: none</option>
          {tree.map((f) => <option key={f.id} value={f.id}>{'\u00a0\u00a0'.repeat(f.depth)}{f.name}</option>)}
        </select>
        <button type="button" disabled={busy} onClick={() => {
          if (!t.archived_at && !window.confirm(`Archive ${t.name}? It leaves the template list and the New contract picker; Show archived brings it back.`)) return;
          close();
          void act(archiveTemplate(workspaceId, t.id, !t.archived_at), t.archived_at ? 'Restored' : 'Archived', false);
        }} style={{ ...btn(false, busy), height: '34px', color: t.archived_at ? INK : '#b91c1c' }}>{t.archived_at ? 'Unarchive' : 'Archive'}</button>
      </>
    );
  }

  // ------------------------------------------------------------ folders
  async function folder(op: 'create' | 'rename' | 'delete') {
    const cur = typeof folderSel === 'number' ? tree.find((f) => f.id === folderSel) : undefined;
    if (op === 'create') {
      const name = window.prompt(cur ? `New folder inside ${cur.path}` : 'New folder name');
      if (!name?.trim()) return;
      const r = await folderOp(workspaceId, 'templates', 'create', { name: name.trim(), parent_id: cur?.id ?? null });
      if (!r.ok) return onToast(r.message);
    } else if (cur && op === 'rename') {
      const name = window.prompt('Rename folder', cur.name);
      if (!name?.trim() || name.trim() === cur.name) return;
      const r = await folderOp(workspaceId, 'templates', 'rename', { id: cur.id, name: name.trim() });
      if (!r.ok) return onToast(r.message);
    } else if (cur && op === 'delete') {
      if (!window.confirm(`Delete the folder ${cur.path}? Its templates and folders move up a level; nothing is deleted with it.`)) return;
      const r = await folderOp(workspaceId, 'templates', 'delete', { id: cur.id });
      if (!r.ok) return onToast(r.message);
      setFolderSel(cur.parent_id ?? 'all');
    }
    reload();
  }

  // ------------------------------------------------------------ editor helpers
  function insertAtCursor(text: string) {
    if (!draft) return;
    const el = bodyRef.current;
    const at = el ? el.selectionStart : draft.body_md.length;
    const end = el ? el.selectionEnd : at;
    const body = draft.body_md.slice(0, at) + text + draft.body_md.slice(end);
    setDraft({ ...draft, body_md: body });
    setPicker(false);
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = at + text.length; } });
  }
  const blocksById = new Map((lib?.blocks ?? []).map((x) => [x.id, x]));
  const placed = draft ? blocksIn(draft.body_md) : [];

  const willVersion = !!selected && (selected.built_in || selected.used_this > 0);
  const saveLabel = !draft?.template_id ? 'Create template' : willVersion ? `Save as v${(selected?.version ?? 1) + 1}` : 'Save';

  if (!lib) return <div style={{ padding: '24px', textAlign: 'center', color: loaded?.err ? '#b91c1c' : MUTED, fontSize: '13px' }}>{loaded && loaded.key === workspaceId && loaded.err ? loaded.err : 'Loading templates…'}</div>;

  const tabBtn = (id: 'templates' | 'sections', text: string) => (
    <button type="button" onClick={() => setTab(id)} style={{ height: '30px', padding: '0 12px', borderRadius: '999px', fontSize: '12.5px', fontWeight: tab === id ? 650 : 500, cursor: 'pointer', border: `1px solid ${tab === id ? GREEN : LINE}`, background: tab === id ? '#E7F8F1' : '#fff', color: tab === id ? GREEN : '#27272a', fontFamily: 'inherit' }}>{text}</button>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {tabBtn('templates', `Templates · ${lib.templates.filter((t) => !t.archived_at).length}`)}
        {tabBtn('sections', `Sections · ${lib.blocks.length}`)}
        <span style={{ flex: 1 }} />
        {ro ? <span style={{ fontSize: '12px', color: MUTED }}>Only an owner or admin can change templates.</span> : null}
      </div>

      {tab === 'sections' ? <SectionsTab workspaceId={workspaceId} lib={lib} ro={ro} onToast={onToast} onChanged={reload} /> : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-start' }}>
          {/* Folders */}
          <div style={{ ...panel, flex: '1 1 190px', maxWidth: '240px', padding: '8px' }}>
            {([['all', 'All templates'], ['none', 'Not in a folder']] as const).map(([id, text]) => (
              <FolderRow key={id} text={text} depth={0} on={folderSel === id} onClick={() => setFolderSel(id)}
                onDrop={id === 'none' && !ro && dragId != null ? () => { void move(dragId, null); setDragId(null); } : undefined} />
            ))}
            {tree.map((f) => (
              <FolderRow key={f.id} text={f.name} count={countIn(f.id)} depth={f.depth + 1} on={folderSel === f.id} onClick={() => setFolderSel(f.id)}
                onDrop={!ro && dragId != null ? () => { void move(dragId, f.id); setDragId(null); } : undefined} />
            ))}
            {!ro ? (
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', padding: '8px 6px 2px', borderTop: `1px solid ${HAIR}`, marginTop: '6px' }}>
                <button type="button" onClick={() => void folder('create')} style={link}>+ Folder</button>
                {typeof folderSel === 'number' ? <button type="button" onClick={() => void folder('rename')} style={{ ...link, color: '#52525b' }}>Rename</button> : null}
                {typeof folderSel === 'number' ? <button type="button" onClick={() => void folder('delete')} style={{ ...link, color: '#b91c1c' }}>Delete</button> : null}
              </div>
            ) : null}
            {!ro && tree.length ? <div style={{ fontSize: '11px', color: '#a1a1aa', padding: '6px' }}>Drag a template onto a folder to file it.</div> : null}
          </div>

          {/* Gallery */}
          {!draft ? (
            <div style={{ flex: '4 1 520px', minWidth: 0 }}>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
                <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates…" aria-label="Search templates" style={{ ...field, width: 'min(260px, 100%)', height: '32px' }} />
                <select value={kindSel} onChange={(e) => setKindSel(e.target.value)} aria-label="Type" style={{ ...field, width: 'auto', height: '32px' }}>
                  <option value="">All types</option>
                  {Object.entries(KIND_LABELS).filter(([k]) => (lib.templates).some((t) => t.kind === k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <span style={{ flex: 1 }} />
                {!ro ? <DocImport compact workspaceId={workspaceId} onToast={onToast} onSaved={() => reload()} /> : null}
                {!ro ? <button type="button" onClick={() => { setDraft({ ...NEW_DRAFT, folder_id: typeof folderSel === 'number' ? folderSel : null }); setView('edit'); setVersions(null); }} style={btn()} title="A template CLOZR lays out from text, under your letterhead">+ Text template</button> : null}
              </div>
              {!mine.length && !builtIns.length ? <div style={{ ...panel, padding: '30px', textAlign: 'center', fontSize: '13px', color: MUTED }}>{terms.length || kindSel ? 'No templates match.' : 'No templates here yet.'}</div> : null}
              {mine.length ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '14px' }}>
                  {mine.map((t) => (
                    <TemplateCard key={t.id} t={t} head={head} folder={folderSel === 'all' && t.folder_id != null ? tree.find((f) => f.id === t.folder_id)?.name ?? null : null}
                      draggable={!ro} onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(t.id)); setDragId(t.id); }} onDragEnd={() => setDragId(null)}
                      onOpen={() => setPreview(t)} />
                  ))}
                </div>
              ) : !ro && !terms.length && !kindSel && folderSel === 'all' ? (
                <div style={{ ...panel, padding: '18px' }}>
                  <div style={{ fontSize: '14px', fontWeight: 650, marginBottom: '4px' }}>Bring in your own documents</div>
                  <div style={{ fontSize: '12.5px', color: MUTED, lineHeight: 1.5, marginBottom: '12px' }}>Download your templates from PandaDoc (or anywhere) as PDFs and drop them all here at once. Each keeps its own logo, letterhead and design, gets its signature, initials and date fields placed, and is filed by type.</div>
                  <DocImport workspaceId={workspaceId} onToast={onToast} onSaved={() => reload()} />
                </div>
              ) : null}
              {builtIns.length ? (
                <div style={{ marginTop: '18px' }}>
                  <button type="button" onClick={() => setShowBuiltIns(!builtInsOpen)} style={{ ...link, color: '#52525b', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <span aria-hidden style={{ display: 'inline-block', transform: builtInsOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>›</span>
                    Built-in text templates · {builtIns.length}
                    <span style={{ fontWeight: 400, color: MUTED }}>— CLOZR’s plain fallbacks, laid out under your letterhead</span>
                  </button>
                  {builtInsOpen ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '14px', marginTop: '10px' }}>
                      {builtIns.map((t) => <TemplateCard key={t.id} t={t} head={head} onOpen={() => setPreview(t)} />)}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {archivedCount ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '14px', fontSize: '12px', color: '#52525b' }}>
                  <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived ({archivedCount})
                </label>
              ) : null}
            </div>
          ) : null}

          {/* Editor / history (text templates) */}
          {draft ? (
          <div style={{ ...panel, flex: '4 1 520px', padding: '14px 16px' }}>
            <button type="button" onClick={() => setDraft(null)} style={{ ...link, color: '#52525b', marginBottom: '10px' }}>← All templates</button>
            {view === 'history' && selected ? (
              <History
                current={selected} versions={versions} compareId={compareId} busy={busy || ro}
                onCompare={setCompareId} onRestore={(v) => void afterRestore(v)} onBack={() => setView('edit')}
              />
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
                  <div style={{ flex: 1, minWidth: '160px' }}>
                    <div style={{ fontSize: '14px', fontWeight: 700 }}>{selected ? selected.name : 'New template'}</div>
                    <div style={{ fontSize: '11.5px', color: MUTED }}>
                      {selected ? `${versionLabel(selected.version, selected.used)}${selected.used !== selected.used_this ? ` (this version ${selected.used_this}×)` : ''}${selected.built_in ? ' · built-in' : ''}` : 'Not saved yet'}
                    </div>
                  </div>
                  {selected ? <button type="button" onClick={() => void showHistory()} style={btn()}>History</button> : null}
                  {selected && !ro ? <button type="button" disabled={busy} onClick={() => void act(duplicateTemplate(workspaceId, selected.id), 'Duplicated. You are now editing the copy.')} style={btn(false, busy)}>Duplicate</button> : null}
                  {selected && !ro ? (
                    <button type="button" disabled={busy} onClick={() => {
                      if (!selected.archived_at && !window.confirm(`Archive ${selected.name}? It leaves the template list and the New contract picker; Show archived brings it back.`)) return;
                      void act(archiveTemplate(workspaceId, selected.id, !selected.archived_at), selected.archived_at ? 'Restored' : 'Archived');
                    }} style={btn(false, busy)}>{selected.archived_at ? 'Unarchive' : 'Archive'}</button>
                  ) : null}
                  {selected && !ro ? (
                    <select value={selected.folder_id ?? ''} onChange={(e) => void move(selected.id, e.target.value ? Number(e.target.value) : null)} aria-label="Move to folder" title="Move to…" style={{ ...field, width: 'auto', height: '30px' }}>
                      <option value="">Move to… (no folder)</option>
                      {tree.map((f) => <option key={f.id} value={f.id}>{'  '.repeat(f.depth)}{f.name}</option>)}
                    </select>
                  ) : null}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px 10px' }}>
                  <div style={{ gridColumn: '1 / -1' }}><label style={label}>Name</label><input value={draft.name} disabled={ro} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={field} /></div>
                  <div>
                    <label style={label}>Type</label>
                    <select value={draft.kind} disabled={ro} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} style={field}>
                      {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                  {!draft.template_id ? (
                    <div>
                      <label style={label}>Folder</label>
                      <select value={draft.folder_id ?? ''} disabled={ro} onChange={(e) => setDraft({ ...draft, folder_id: e.target.value ? Number(e.target.value) : null })} style={field}>
                        <option value="">No folder</option>
                        {tree.map((f) => <option key={f.id} value={f.id}>{f.path}</option>)}
                      </select>
                    </div>
                  ) : null}
                  <div><label style={label}>Sign by (days)</label><input value={draft.expiry} disabled={ro} inputMode="numeric" placeholder="14" onChange={(e) => setDraft({ ...draft, expiry: e.target.value.replace(/\D/g, '').slice(0, 3) })} style={field} /></div>
                  <div>
                    <label style={label}>Signing order</label>
                    <select value={draft.order} disabled={ro} onChange={(e) => setDraft({ ...draft, order: e.target.value as Draft['order'] })} style={field}>
                      <option value="">Everyone at once (default)</option>
                      <option value="parallel">Everyone at once</option>
                      <option value="sequential">In order, top to bottom</option>
                    </select>
                  </div>
                  <div>
                    <label style={label}>First reminder after</label>
                    <input value={draft.remindFirst} disabled={ro} inputMode="numeric" placeholder="1 day" onChange={(e) => setDraft({ ...draft, remindFirst: e.target.value.replace(/\D/g, '').slice(0, 2) })} style={field} />
                  </div>
                  <div>
                    <label style={label}>Then every (days)</label>
                    <input value={draft.remindRepeat} disabled={ro} inputMode="numeric" placeholder="2" onChange={(e) => setDraft({ ...draft, remindRepeat: e.target.value.replace(/\D/g, '').slice(0, 2) })} style={field} />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={label}>Signers (role, label, party: seller · seller2 · buyer · company)</label>
                    <input value={draft.signers} disabled={ro} onChange={(e) => setDraft({ ...draft, signers: e.target.value })} style={{ ...field, fontFamily: MONO, fontSize: '11.5px' }} />
                  </div>
                </div>
                <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '6px' }}>Blank defaults leave the New contract form as it is (14 days, everyone at once, a reminder after 1 day then every 2). 0 and 0 turns reminders off.</div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '12px 0 5px' }}>
                  <label style={{ ...label, margin: 0, flex: 1 }}>Body</label>
                  {!ro ? <button type="button" onClick={() => setPicker((x) => !x)} style={btn(picker)}>Insert section</button> : null}
                </div>
                {picker ? <SectionPicker blocks={lib.blocks} onPick={(b, asCopy) => insertAtCursor(asCopy ? b.body : blockToken(b.id))} onClose={() => setPicker(false)} /> : null}
                <textarea ref={bodyRef} value={draft.body_md} disabled={ro} onChange={(e) => setDraft({ ...draft, body_md: e.target.value })} rows={20} spellCheck={false}
                  style={{ ...field, height: 'auto', padding: '10px', fontFamily: MONO, fontSize: '12px', lineHeight: 1.5, resize: 'vertical' }} />
                {placed.length ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px', fontSize: '11.5px', color: '#52525b' }}>
                    Sections placed:
                    {placed.map((id) => {
                      const b = blocksById.get(id);
                      return <span key={id} style={badge(b ? (b.locked ? '#6d28d9' : GREEN) : '#b91c1c', b ? (b.locked ? '#ede9fe' : '#E7F8F1') : '#fee2e2')}>{b ? `${b.name}${b.locked ? ' · locked' : ''}` : `#${id} deleted`}</span>;
                    })}
                  </div>
                ) : null}
                <details style={{ marginTop: '8px', fontSize: '12px', color: '#52525b' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Variables and tokens you can use</summary>
                  <p style={{ margin: '6px 0', lineHeight: 1.5 }}>
                    {'{{deal.purchase_price|currency}}'} fills from the deal (formatters: currency, words, date:long, upper, default:&quot;N/A&quot;); {'{{#if property.state == "TX"}}…{{/if}}'} adds a rider; [Deal.EMD]-style tokens still work; {'{{sign:role}}'} places a signature; a line with --- starts a new page; {'{{block:12}}'} places a saved section. Click one to insert it.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '2px 12px' }}>
                    {VAR_HELP.map(([k, v]) => (
                      <button key={k} type="button" disabled={ro} onClick={() => insertAtCursor(`{{${k}}}`)} style={{ ...link, fontWeight: 400, color: '#52525b', textAlign: 'left' }}>
                        <code style={{ fontSize: '11px', color: GREEN }}>{`{{${k}}}`}</code> {v}
                      </button>
                    ))}
                    {TOKEN_HELP.filter(([n]) => /^[A-Z]/.test(n)).map(([n, v]) => (
                      <button key={n} type="button" disabled={ro} onClick={() => insertAtCursor(`[${n}]`)} style={{ ...link, fontWeight: 400, color: '#52525b', textAlign: 'left' }}>
                        <code style={{ fontSize: '11px' }}>[{n}]</code> {v}
                      </button>
                    ))}
                  </div>
                </details>
                {!ro ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px', flexWrap: 'wrap' }}>
                    <button type="button" disabled={busy} onClick={() => void save()} style={btn(true, busy)}>{busy ? 'Saving…' : saveLabel}</button>
                    <button type="button" onClick={() => setDraft(null)} style={btn()}>Close</button>
                    {willVersion && selected ? (
                      <span style={{ fontSize: '12px', color: MUTED }}>
                        {selected.built_in ? 'Built-in templates are not changed; this saves your own copy.' : `${selected.used_this} contract${selected.used_this === 1 ? ' was' : 's were'} made from v${selected.version ?? 1}, so it stays as it was and this becomes v${(selected.version ?? 1) + 1}.`}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
          ) : null}
        </div>
      )}
      {preview ? (
        <TemplatePreview t={preview} head={head} folder={preview.folder_id != null ? tree.find((f) => f.id === preview.folder_id)?.path ?? null : null} onClose={() => setPreview(null)}>
          {previewActions(preview)}
        </TemplatePreview>
      ) : null}
      {pdfFields ? (
        <React.Suspense fallback={null}>
          <TemplateFieldsDialog workspaceId={workspaceId} template={pdfFields} onClose={() => setPdfFields(null)} onSaved={(n) => { onToast(`Saved ${n} field${n === 1 ? '' : 's'} on ${pdfFields.name}`); reload(); }} />
        </React.Suspense>
      ) : null}
    </div>
  );
}

function FolderRow({ text, count, depth, on, onClick, onDrop }: { text: string; count?: number; depth: number; on: boolean; onClick: () => void; onDrop?: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <button type="button" onClick={onClick}
      onDragOver={onDrop ? (e) => { e.preventDefault(); setOver(true); } : undefined}
      onDragLeave={onDrop ? () => setOver(false) : undefined}
      onDrop={onDrop ? (e) => { e.preventDefault(); setOver(false); onDrop(); } : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', textAlign: 'left', padding: `6px 8px 6px ${8 + depth * 12}px`, borderRadius: '7px', border: over ? `1px dashed ${GREEN}` : '1px solid transparent', background: on ? '#E7F8F1' : over ? '#F0FBF6' : 'transparent', color: on ? GREEN : INK, fontSize: '12.5px', fontWeight: on ? 650 : 500, cursor: 'pointer', fontFamily: 'inherit' }}>
      {depth > 0 ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg> : null}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
      {count ? <span style={{ fontSize: '11px', color: MUTED }}>{count}</span> : null}
    </button>
  );
}

/** Pick a saved section to place in the body. Locked ones go in by reference only. */
function SectionPicker({ blocks, onPick, onClose }: { blocks: DocBlock[]; onPick: (b: DocBlock, asCopy: boolean) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = blocks.filter((b) => terms.every((t) => `${b.name} ${(b.tags ?? []).join(' ')}`.toLowerCase().includes(t)));
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: '10px', padding: '8px', marginBottom: '8px', background: '#fafafa' }}>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
        <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sections by name or tag…" aria-label="Search sections" style={field} />
        <button type="button" onClick={onClose} style={btn()}>Close</button>
      </div>
      {!blocks.length ? <div style={{ fontSize: '12px', color: MUTED, padding: '6px' }}>No sections yet. Add some on the Sections tab (there is a button for starter clauses).</div> : null}
      <div style={{ maxHeight: '220px', overflow: 'auto' }}>
        {shown.map((b) => (
          <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px', borderBottom: `1px solid ${HAIR}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600 }}>{b.name} {b.locked ? <span style={badge('#6d28d9', '#ede9fe')}>Locked</span> : null}</div>
              <div style={{ fontSize: '11.5px', color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.body}</div>
            </div>
            <button type="button" onClick={() => onPick(b, false)} title="Places {{block:id}}: the section's current text goes in when a contract is made" style={btn(true)}>Insert</button>
            {!b.locked ? <button type="button" onClick={() => onPick(b, true)} title="Pastes the text itself, which this template then owns and can change" style={btn()}>Paste copy</button> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function History({ current, versions, compareId, busy, onCompare, onRestore, onBack }: {
  current: ListedTemplate; versions: TemplateVersion[] | null; compareId: number | null; busy: boolean;
  onCompare: (id: number | null) => void; onRestore: (v: TemplateVersion) => void; onBack: () => void;
}) {
  const cmp = versions?.find((v) => v.id === compareId) ?? null;
  const diff = useMemo(() => (cmp ? diffLines(cmp.body_md, current.body_md) : null), [cmp, current.body_md]);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>{current.name} · history</div>
          <div style={{ fontSize: '11.5px', color: MUTED }}>Every version is kept. Contracts point at the version they were made from.</div>
        </div>
        <button type="button" onClick={onBack} style={btn()}>Back to editor</button>
      </div>
      {!versions ? <div style={{ fontSize: '12.5px', color: MUTED }}>Loading versions…</div> : versions.map((v) => {
        const st = diffStat(diffLines(v.body_md, current.body_md));
        return (
          <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px', borderTop: `1px solid ${HAIR}`, fontSize: '12.5px' }}>
            <span style={{ fontWeight: 700, width: '34px' }}>v{v.version ?? 1}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{v.name}</span>
              <span style={{ color: MUTED }}> · {new Date(v.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · used {v.used}×{v.built_in ? ' · built-in' : ''}</span>
              {v.id !== current.id ? <span style={{ color: MUTED }}> · <span style={{ color: '#15803d' }}>+{st.added}</span> <span style={{ color: '#b91c1c' }}>−{st.removed}</span> lines to current</span> : null}
            </span>
            {v.id === current.id ? <span style={badge(GREEN, '#E7F8F1')}>Current</span> : (
              <>
                <button type="button" onClick={() => onCompare(compareId === v.id ? null : v.id)} style={btn(compareId === v.id)}>{compareId === v.id ? 'Hide changes' : 'Compare'}</button>
                <button type="button" disabled={busy} onClick={() => onRestore(v)} style={btn(false, busy)}>Restore</button>
              </>
            )}
          </div>
        );
      })}
      {cmp && diff ? (
        <div style={{ marginTop: '10px' }}>
          <div style={{ fontSize: '12px', color: MUTED, marginBottom: '5px' }}>v{cmp.version ?? 1} → v{current.version ?? 1} (current). Red lines were taken out, green lines were added.</div>
          <div style={{ border: `1px solid ${LINE}`, borderRadius: '8px', maxHeight: '48vh', overflow: 'auto', fontFamily: MONO, fontSize: '11.5px', lineHeight: 1.5 }}>
            {diff.map((d, i) => (
              <div key={i} style={{ display: 'flex', background: d.op === 'add' ? '#dcfce7' : d.op === 'del' ? '#fee2e2' : '#fff' }}>
                <span style={{ width: '36px', flex: 'none', textAlign: 'right', paddingRight: '6px', color: '#a1a1aa', userSelect: 'none' }}>{d.a ?? ''}</span>
                <span style={{ width: '36px', flex: 'none', textAlign: 'right', paddingRight: '6px', color: '#a1a1aa', userSelect: 'none' }}>{d.b ?? ''}</span>
                <span style={{ width: '14px', flex: 'none', color: d.op === 'add' ? '#15803d' : d.op === 'del' ? '#b91c1c' : '#a1a1aa', userSelect: 'none' }}>{d.op === 'add' ? '+' : d.op === 'del' ? '−' : ' '}</span>
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: INK, textDecoration: d.op === 'del' ? 'line-through' : 'none' }}>{d.text || ' '}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The clause library: sections a template places as {{block:id}}. */
function SectionsTab({ workspaceId, lib, ro, onToast, onChanged }: { workspaceId: number; lib: Library; ro: boolean; onToast: (m: string) => void; onChanged: () => void }) {
  const [draft, setDraft] = useState<BlockDraft | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = lib.blocks.filter((b) => terms.every((t) => `${b.name} ${(b.tags ?? []).join(' ')} ${b.body}`.toLowerCase().includes(t)));
  const usedBy = (id: number) => lib.templates.filter((t) => !t.archived_at && blocksIn(t.body_md).includes(id)).map((t) => t.name);

  async function save() {
    if (!draft) return;
    setBusy(true);
    const r = await saveBlock(workspaceId, { id: draft.id, name: draft.name, body: draft.body, tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean), locked: draft.locked });
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    onToast('Section saved. Templates that place it use the new text from the next contract on.');
    const again = r.data.blocks.find((b) => b.name === draft.name.trim());
    setDraft(again ? { id: again.id, name: again.name, body: again.body, tags: (again.tags ?? []).join(', '), locked: again.locked } : null);
    onChanged();
  }
  async function remove() {
    if (!draft?.id || !window.confirm(`Delete the section ${draft.name}?`)) return;
    setBusy(true);
    const r = await deleteBlock(workspaceId, draft.id);
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    setDraft(null); onChanged();
  }
  async function starters() {
    setBusy(true);
    const r = await addStarterBlocks(workspaceId);
    setBusy(false);
    if (!r.ok) return onToast(r.message);
    onToast(r.data.added ? `Added ${r.data.added} starter clause${r.data.added === 1 ? '' : 's'}. Read them over before you use them.` : 'You already have all the starter clauses.');
    onChanged();
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-start' }}>
      <div style={{ ...panel, flex: '1 1 280px', maxWidth: '380px', overflow: 'hidden' }}>
        <div style={{ padding: '8px', borderBottom: `1px solid ${HAIR}`, display: 'flex', gap: '6px' }}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sections…" aria-label="Search sections" style={field} />
          {!ro ? <button type="button" onClick={() => setDraft({ id: null, name: '', body: '', tags: '', locked: false })} style={btn(true)}>+ New</button> : null}
        </div>
        <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
          {shown.map((b) => (
            <button key={b.id} type="button" className="dc2" onClick={() => setDraft({ id: b.id, name: b.name, body: b.body, tags: (b.tags ?? []).join(', '), locked: b.locked })}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 0, borderBottom: `1px solid ${HAIR}`, background: draft?.id === b.id ? '#F0FBF6' : '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, flex: 1, minWidth: 0 }}>{b.name}</span>
                {b.locked ? <span style={badge('#6d28d9', '#ede9fe')}>Locked</span> : null}
              </div>
              <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '2px' }}>{(b.tags ?? []).map((t) => `#${t}`).join(' ') || 'No tags'} · in {usedBy(b.id).length} template{usedBy(b.id).length === 1 ? '' : 's'}</div>
            </button>
          ))}
          {!lib.blocks.length ? (
            <div style={{ padding: '16px', fontSize: '12.5px', color: MUTED, lineHeight: 1.5 }}>
              No sections yet. Sections are clauses you write once and place in any template: earnest money, the option period, as-is language, assignment, the title company.
            </div>
          ) : null}
        </div>
        {!ro ? (
          <div style={{ padding: '8px', borderTop: `1px solid ${HAIR}` }}>
            <button type="button" disabled={busy} onClick={() => void starters()} style={btn(false, busy)}>Add starter clauses</button>
            <div style={{ fontSize: '11px', color: '#a1a1aa', marginTop: '4px' }}>EMD, inspection and option period, as-is, assignment, title company. Plain-language starting points for Texas; have your attorney review them.</div>
          </div>
        ) : null}
      </div>
      <div style={{ ...panel, flex: '3 1 420px', padding: '14px 16px' }}>
        {!draft ? (
          <div style={{ padding: '30px 10px', textAlign: 'center', color: MUTED, fontSize: '13px' }}>Pick a section to edit it, or press + New.</div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px 10px' }}>
              <div><label style={label}>Name</label><input value={draft.name} disabled={ro} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Earnest money" style={field} /></div>
              <div><label style={label}>Tags (comma separated)</label><input value={draft.tags} disabled={ro} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="emd, tx" style={field} /></div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', margin: '10px 0' }}>
              <input type="checkbox" checked={draft.locked} disabled={ro} onChange={(e) => setDraft({ ...draft, locked: e.target.checked })} />
              Locked: templates can only place it as it is, never paste and change a copy
            </label>
            <label style={label}>Text</label>
            <textarea value={draft.body} disabled={ro} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={12} spellCheck
              placeholder={'Buyer will deposit {{deal.inhouse_emd|currency}} with {{title.company}} within three business days.'}
              style={{ ...field, height: 'auto', padding: '10px', fontFamily: MONO, fontSize: '12px', lineHeight: 1.5, resize: 'vertical' }} />
            <div style={{ fontSize: '11.5px', color: MUTED, marginTop: '5px' }}>
              Same variables as templates: {'{{deal.purchase_price|currency}}'}, {'{{title.company}}'}, [Deal.EMD]. {draft.id ? `Placed as {{block:${draft.id}}}.` : ''}
              {draft.id && usedBy(draft.id).length ? ` Used in ${usedBy(draft.id).join(', ')}.` : ''}
            </div>
            {!ro ? (
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                <button type="button" disabled={busy || !draft.name.trim()} onClick={() => void save()} style={btn(true, busy || !draft.name.trim())}>{busy ? 'Saving…' : 'Save section'}</button>
                <button type="button" onClick={() => setDraft(null)} style={btn()}>Close</button>
                <span style={{ flex: 1 }} />
                {draft.id ? <button type="button" disabled={busy} onClick={() => void remove()} style={{ ...btn(false, busy), color: '#b91c1c' }}>Delete</button> : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

