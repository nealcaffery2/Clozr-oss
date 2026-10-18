// "New contract" on a record: the templates and nothing else. Picking one opens
// the contract full size on that template, already filled from the record.
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { type ContractKind, type DocFolder, type LibraryTemplate, type Template, KIND_LABELS, importPandaTemplate, listDocTemplates, listTemplates, templateFolders } from '@/lib/contracts';
import { isPdfTemplate } from '@/lib/pdf-docs';
import { CenteredDialog } from '@/components/ContractsHub';

const MUTED = 'var(--meta, #71717a)';
const LINE = 'var(--divider, #e4e4e7)';

export function ContractTemplatePicker({ workspaceId, who, onPick, onOther, onClose }: {
  workspaceId: number; who: string;
  onPick: (templateId: number) => void;
  /** Upload a PDF or the PandaDoc packet: the full form without a template picked. */
  onOther: () => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<LibraryTemplate[] | null>(null);
  const [folders, setFolders] = useState<DocFolder[]>([]);
  const [q, setQ] = useState('');
  // Your own documents first: PDF templates (uploaded or copied from PandaDoc),
  // then the PandaDoc templates not copied yet. CLOZR's built-in text
  // templates are a click away.
  const [panda, setPanda] = useState<Template[] | null>(null);
  const [pandaError, setPandaError] = useState<string | null>(null);
  const [builtIn, setBuiltIn] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void listTemplates(workspaceId).then((r) => {
      if (!live) return;
      if (r.ok) setPanda(r.data.templates); else { setPanda([]); setPandaError(/not connected/i.test(r.message) ? null : r.message); }
    });
    return () => { live = false; };
  }, [workspaceId]);
  const copied = new Set((list ?? []).filter((t) => isPdfTemplate(t)).map((t) => t.name.trim().toLowerCase()));
  const pandaShown = (panda ?? []).filter((t) => !copied.has(t.name.trim().toLowerCase()) && (!q.trim() || t.name.toLowerCase().includes(q.trim().toLowerCase())));
  // A PandaDoc template is copied into CLOZR once (its PDF and signer roles), then opened like any CLOZR template.
  const importOne = async (t: Template) => {
    setImporting(t.id); setPandaError(null);
    const r = await importPandaTemplate(workspaceId, t.id);
    setImporting(null);
    if (!r.ok) { setPandaError(r.message); return; }
    onPick(r.data.template.id);
  };

  useEffect(() => {
    let live = true;
    void Promise.all([listDocTemplates(workspaceId), templateFolders(workspaceId)]).then(([t, f]) => {
      if (!live) return;
      setList(t);
      if (f.ok) setFolders(f.data.folders);
    });
    return () => { live = false; };
  }, [workspaceId]);

  // Grouped by folder, the library's order; a template in no folder goes under "Templates".
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const shown = (list ?? []).filter((t) => (builtIn || isPdfTemplate(t))).filter((t) => !needle || t.name.toLowerCase().includes(needle) || (KIND_LABELS[t.kind as ContractKind] ?? t.kind).toLowerCase().includes(needle));
    const byFolder = new Map<number | null, LibraryTemplate[]>();
    for (const t of shown) {
      const k = t.folder_id ?? null;
      (byFolder.get(k) ?? byFolder.set(k, []).get(k)!).push(t);
    }
    const name = (id: number | null) => (id == null ? 'Templates' : folders.find((f) => f.id === id)?.name ?? 'Templates');
    return [...byFolder.entries()].sort((a, b) => (a[0] == null ? -1 : b[0] == null ? 1 : name(a[0]).localeCompare(name(b[0])))).map(([id, ts]) => ({ id, name: name(id), ts }));
  }, [list, folders, q, builtIn]);

  return (
    <CenteredDialog title={`New contract · ${who}`} onClose={onClose} width={640} z={85}>
      <div style={{ display: 'grid', gap: '12px' }}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" aria-label="Search templates"
          style={{ height: '36px', padding: '0 12px', border: `1px solid ${LINE}`, borderRadius: '9px', fontSize: '13px', background: 'var(--surface, #fff)', width: '100%' }} />
        {panda === null || pandaShown.length || pandaError ? (
          <div>
            <div style={{ fontSize: '11px', color: MUTED, fontWeight: 600, padding: '0 2px 6px' }}>From PandaDoc · copied into CLOZR on first use</div>
            {panda === null ? <div style={{ fontSize: '12.5px', color: MUTED }}>Loading your PandaDoc templates…</div> : null}
            {pandaError ? <div role="alert" style={{ fontSize: '12.5px', color: 'var(--tx-red, #b91c1c)' }}>{pandaError}</div> : null}
            <div style={{ display: 'grid', gap: '6px' }}>
              {pandaShown.map((t) => (
                <button key={t.id} type="button" className="dc2" disabled={!!importing} onClick={() => void importOne(t)}
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left', padding: '11px 12px', border: `1px solid ${LINE}`, borderRadius: '10px', background: 'var(--surface, #fff)', cursor: 'pointer', color: 'var(--ink, #18181b)' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: '13.5px', fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                    <span style={{ display: 'block', fontSize: '11.5px', color: MUTED }}>{importing === t.id ? 'Copying it into CLOZR…' : 'Copy into CLOZR and use it'}</span>
                  </span>
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tx-mint, #0a8560)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="m9 18 6-6-6-6" /></svg>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {list === null ? <div style={{ fontSize: '12.5px', color: MUTED }}>Loading templates…</div> : null}
        {list !== null && !groups.length && !pandaShown.length ? <div style={{ fontSize: '12.5px', color: MUTED }}>{q ? 'No template matches that.' : 'No templates of your own yet. Upload one under Contracts → Templates.'}</div> : null}
        {groups.map((g) => (
          <div key={g.id ?? 'none'}>
            <div style={{ fontSize: '11px', color: MUTED, fontWeight: 600, padding: '0 2px 6px' }}>{g.name}</div>
            <div style={{ display: 'grid', gap: '6px' }}>
              {g.ts.map((t) => (
                <button key={t.id} type="button" className="dc2" onClick={() => onPick(t.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', textAlign: 'left', padding: '11px 12px', border: `1px solid ${LINE}`, borderRadius: '10px', background: 'var(--surface, #fff)', cursor: 'pointer', color: 'var(--ink, #18181b)' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: '13.5px', fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                    <span style={{ display: 'block', fontSize: '11.5px', color: MUTED }}>
                      {KIND_LABELS[t.kind as ContractKind] ?? t.kind}{t.signers?.length ? ` · ${t.signers.length} signer${t.signers.length === 1 ? '' : 's'}` : ''}
                    </span>
                  </span>
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--tx-mint, #0a8560)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none' }}><path d="m9 18 6-6-6-6" /></svg>
                </button>
              ))}
            </div>
          </div>
        ))}
        {!builtIn ? (
          <button type="button" onClick={() => setBuiltIn(true)} style={{ justifySelf: 'start', border: 0, background: 'none', padding: '2px', color: MUTED, fontSize: '12px', textDecoration: 'underline', cursor: 'pointer' }}>
            Show CLOZR’s built-in text templates
          </button>
        ) : null}
        <button type="button" onClick={onOther} style={{ justifySelf: 'start', border: 0, background: 'none', padding: '2px', color: MUTED, fontSize: '12px', textDecoration: 'underline', cursor: 'pointer' }}>
          Upload a one-off PDF instead
        </button>
      </div>
    </CenteredDialog>
  );
}
