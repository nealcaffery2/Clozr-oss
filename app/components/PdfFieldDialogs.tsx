// The field editor wired to where fields live: a draft contract's (through
// the contracts function) or a PDF template's (doc_template_fields, as the
// signed-in admin). Loaded lazily with pdf.js, only when someone opens one.
'use client';

import React, { useEffect, useState } from 'react';
import PdfFieldEditor, { type EditorRole } from '@/components/PdfFieldEditor';
import { type ContractRow, sendClozr } from '@/lib/contracts';
import { type PdfRole, type PdfTemplate, contractPdfFields, docSourceUrl, saveContractPdfFields, saveTemplateFields, templateFields } from '@/lib/pdf-docs';
import type { FieldDef } from '@/supabase/functions/_shared/pdf-fields';

type Loaded = { key: string; url: string | null; roles: EditorRole[]; fields: FieldDef[]; error: string | null };

function Loading({ onClose, text }: { onClose: () => void; text: string }) {
  return (
    <div role="dialog" aria-modal="true" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 150, background: 'rgba(24,24,27,.45)', display: 'grid', placeItems: 'center' }}>
      <div style={{ background: '#fff', borderRadius: '12px', padding: '18px 22px', fontSize: '13px', color: '#52525b' }}>{text}</div>
    </div>
  );
}

/**
 * A draft contract on its own pages, filled in from the record: change what any
 * box says, move or add fields, then Send. A sent contract opens read-only.
 */
export function ContractFieldsDialog({ workspaceId, contract, onClose, onToast }: { workspaceId: number; contract: ContractRow; onClose: () => void; onToast: (m: string) => void }) {
  // Bumped after a save so newly bound fields come back with the record's values.
  const [rev, setRev] = useState(0);
  const key = `${workspaceId}:${contract.id}:${rev}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    void contractPdfFields(workspaceId, contract.id).then((r) => {
      if (!live) return;
      if (!r.ok) { setLoaded({ key, url: null, roles: [], fields: [], error: r.message }); return; }
      const roles = r.data.signers
        .filter((s) => !['cc', 'viewer'].includes(String(s.recipient_type ?? 'signer')))
        // A one-off upload names its people by role (seller, buyer…); that is who they are for auto-mapping.
        .map((s) => ({ role: s.role, label: [s.label || s.role, s.name].filter(Boolean).join(' · '), recipient_type: s.recipient_type, party: ['seller', 'seller2', 'buyer', 'company'].includes(s.role) ? s.role : null }));
      setLoaded({ key, url: r.data.source_url, roles, fields: r.data.fields, error: null });
    });
    return () => { live = false; };
  }, [workspaceId, contract.id, key]);
  const cur = loaded && loaded.key === key ? loaded : null;
  if (!cur) return <Loading onClose={onClose} text="Opening the fields…" />;
  if (cur.error) return <Loading onClose={onClose} text={cur.error} />;
  const draft = contract.status === 'draft';
  return (
    <PdfFieldEditor
      key={key}
      title={`${draft ? 'Review' : 'Fields'} · ${contract.name}`}
      sourceUrl={cur.url}
      roles={cur.roles}
      initial={cur.fields}
      readOnly={!draft}
      autoMap={{ name: contract.name ?? '', kind: contract.kind ?? 'other' }}
      note={!cur.roles.length ? 'Nobody on this contract fills in fields yet. Add a signer or form filler first.' : null}
      onClose={onClose}
      onSave={async (fields) => {
        const r = await saveContractPdfFields(workspaceId, contract.id, fields);
        if (!r.ok) return r;
        onToast(`Saved ${r.data.fields} field${r.data.fields === 1 ? '' : 's'}${r.data.missing.length ? ` · the record has no value for ${r.data.missing.join(', ')}` : ''}`);
        setRev((x) => x + 1);
        return { ok: true };
      }}
      prepare={draft ? {
        onSend: async (fields) => {
          const saved = await saveContractPdfFields(workspaceId, contract.id, fields);
          if (!saved.ok) return saved;
          const r = await sendClozr(workspaceId, contract.id);
          if (!r.ok) return r;
          onToast(r.data.awaiting_approval ? 'Sent to the approver first. It goes out for signature when approved.'
            : r.data.emailed || r.data.texted ? `Sent · ${[r.data.emailed ? `${r.data.emailed} emailed` : null, r.data.texted ? `${r.data.texted} texted` : null].filter(Boolean).join(', ')}`
            : 'Ready. Copy each signing link from the contract.');
          onClose();
          return { ok: true };
        },
      } : null}
    />
  );
}

/** Place the fields on a PDF template; every contract made from it starts with them. */
export function TemplateFieldsDialog({ workspaceId, template, onClose, onSaved }: { workspaceId: number; template: PdfTemplate; onClose: () => void; onSaved?: (n: number) => void }) {
  const key = `${workspaceId}:${template.id}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const [url, fields] = await Promise.all([template.pdf_path ? docSourceUrl(template.pdf_path) : Promise.resolve(null), templateFields(template.id)]);
      if (!live) return;
      const roles = ((template.signers ?? []) as PdfRole[]).map((r) => ({ role: r.role, label: r.label || r.role, recipient_type: r.recipient_type ?? 'signer', party: r.party ?? null }));
      setLoaded({ key, url: url && url.ok ? url.data : null, roles, fields, error: url && !url.ok ? url.message : null });
    })();
    return () => { live = false; };
  }, [template, key]);
  const cur = loaded && loaded.key === key ? loaded : null;
  if (!cur) return <Loading onClose={onClose} text="Opening the template…" />;
  return (
    <PdfFieldEditor
      title={`Fields · ${template.name}`}
      sourceUrl={cur.url}
      roles={cur.roles}
      initial={cur.fields}
      note={cur.error ? `Could not open the PDF: ${cur.error}` : null}
      autoMap={{ name: template.name, kind: template.kind }}
      onClose={onClose}
      onSave={async (fields) => {
        const r = await saveTemplateFields(workspaceId, template.id, fields);
        if (!r.ok) return r;
        onSaved?.(r.data);
        return { ok: true };
      }}
    />
  );
}
