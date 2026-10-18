// Many documents at once: every PDF dropped becomes a ready-to-send template
// with no screen per file. Each one is read in the browser (lib/pdfjs), its
// signers and blanks found (lib/pdf-autodetect), stored as a PDF template,
// its fields saved, and filed in a folder for its type. A built-in plain-text
// template the document stands in for (the PSA, the termination…) is archived,
// so New contract offers the real document and not the fallback; Show
// archived in the library brings one back.

import { type ContractKind, type DocFolder, type LibraryTemplate, archiveTemplate, folderOp, guessKind } from './contracts';
import { type PdfRole, type PdfTemplate, createPdfTemplate, saveTemplateFields, uploadDocSource } from './pdf-docs';
import { assignRoles, detectFields, partyOf, sideOf, type Who } from './pdf-autodetect';

/** The folder each type is filed in. */
export const KIND_FOLDERS: Record<ContractKind, string> = {
  psa: 'Purchase agreements', assignment: 'Assignments', amendment: 'Amendments', termination: 'Terminations', option: 'Options',
  novation: 'Novations', jv: 'Joint ventures', disclosure: 'Disclosures', addendum: 'Addendums', offer: 'Offers', other: 'Other documents',
};

/** Built-in templates by key, and the document names that stand in for them. */
const REPLACES: [string, RegExp][] = [
  ['trec_1_4', /\btrec\b|one to four|1-4 family/i],
  ['termination', /terminat/i],
  ['amendment', /amend/i],
  ['option', /option to purchase/i],
  ['leaseback', /lease ?n?back/i],
  ['escrow_holdback', /hold ?back/i],
  ['seller_info', /seller info/i],
  ['assignment', /assignment/i],
  ['offer_letter', /offer letter|cash offer/i],
  ['authorization', /authori[sz]ation to sign/i],
  // Last: an option or a termination agreement also says "purchase agreement".
  ['psa', /\bpsa\b|purchase (and|&) sale|buy and sell|purchase agreement/i],
];

/** The built-in a document of this name stands in for, if any. The specific ones are tried first. */
export function replacedBuiltIn(name: string, builtIns: { key: string }[]): string | null {
  const keys = new Set(builtIns.map((b) => b.key));
  for (const [key, re] of REPLACES) if (keys.has(key) && re.test(name)) return key;
  return null;
}

export const docName = (file: string) => file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+\d{1,2}$/, '').replace(/\s+/g, ' ').trim();

const LABEL: Record<Who, string> = { seller: 'Seller', seller2: 'Seller 2', buyer: 'Buyer', assignor: 'Assignor', assignee: 'Assignee', company: 'Company' };
const ORDER: Who[] = ['seller', 'seller2', 'buyer', 'assignor', 'assignee', 'company'];

export type Imported = { file: string; ok: boolean; message: string; template?: PdfTemplate; fields?: number; pages?: number; replaced?: string | null };

/**
 * A folder per type, made the first time a document of that type comes in.
 * Shares one lookup across a batch so two files of a type make one folder.
 */
export function folderMaker(workspaceId: number, folders: DocFolder[]) {
  let known = folders.filter((f) => f.scope === 'templates');
  const pending = new Map<string, Promise<number | null>>();
  return (kind: ContractKind): Promise<number | null> => {
    const name = KIND_FOLDERS[kind];
    const have = known.find((f) => f.parent_id == null && f.name.toLowerCase() === name.toLowerCase());
    if (have) return Promise.resolve(have.id);
    if (!pending.has(name)) {
      pending.set(name, folderOp(workspaceId, 'templates', 'create', { name, parent_id: null }).then((r) => {
        if (!r.ok) return null;
        known = r.data.folders;
        return known.find((f) => f.parent_id == null && f.name === name)?.id ?? null;
      }));
    }
    return pending.get(name)!;
  };
}

/** One PDF in, one template with its fields out. Never throws. */
export async function importPdf(workspaceId: number, file: File, opts: {
  folderFor: (kind: ContractKind) => Promise<number | null>;
  builtIns: LibraryTemplate[];
}): Promise<Imported> {
  const name = docName(file.name);
  const kind = guessKind(name);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const [{ openPdf }, { readLayout }] = await Promise.all([import('./pdfjs'), import('./pdf-shapes')]);
    // pdf.js takes the buffer over; the upload below reads the File again.
    const doc = await openPdf(bytes.slice());
    const layout = await readLayout(doc);
    const pages = doc.numPages;
    void doc.destroy();
    const { found, side } = detectFields(layout.items, layout.pages, layout.shapes, { name, kind, outlined: layout.outlined });
    let who = [...new Set(found.filter((f) => f.type === 'signature' || f.type === 'initials' || f.type === 'date_signed').map((f) => f.who).filter((w): w is Who => !!w))];
    if (!who.length) who = ['seller', 'buyer'];
    who.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    const roles: PdfRole[] = who.map((w) => ({ role: w, label: LABEL[w], party: partyOf(w, side ?? sideOf(name, kind)), optional: w === 'seller2', recipient_type: 'signer' }));

    const up = await uploadDocSource(workspaceId, file, 'templates');
    if (!up.ok) return { file: file.name, ok: false, message: up.message };
    const folderId = await opts.folderFor(kind);
    const t = await createPdfTemplate(workspaceId, { name, kind, pdfPath: up.data, roles, folderId }, null);
    if (!t.ok) return { file: file.name, ok: false, message: /row-level|permission/i.test(t.message) ? 'Only an owner or admin can add templates.' : t.message };
    const fields = assignRoles(found, roles, side);
    const saved = await saveTemplateFields(workspaceId, t.data.id, fields);
    const n = saved.ok ? saved.data : 0;

    let replaced: string | null = null;
    const key = replacedBuiltIn(name, opts.builtIns);
    const builtIn = key ? opts.builtIns.find((b) => b.key === key) : null;
    if (builtIn) {
      const r = await archiveTemplate(workspaceId, builtIn.id, true);
      if (r.ok) replaced = builtIn.name;
    }
    return {
      file: file.name, ok: true, template: t.data, fields: n, pages, replaced,
      message: saved.ok ? `${pages} page${pages === 1 ? '' : 's'} · ${n} field${n === 1 ? '' : 's'} mapped` : `Saved, but its fields were not: ${saved.message}`,
    };
  } catch (e) {
    const m = (e as Error).message || 'Could not read it.';
    return { file: file.name, ok: false, message: /password/i.test(m) ? 'It is password-protected; save an unlocked copy first.' : /invalid pdf|unexpected/i.test(m) ? 'It is not a readable PDF.' : m };
  }
}
