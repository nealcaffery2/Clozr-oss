// Certificate of completion with the full audit trail (PandaDoc appends one;
// Clozr's certificate page listed signers only) and a verify routine that
// re-checks the hash chain and the stored PDF.
//
// appendAuditTrail(doc, ...) is called from completeContract right after the
// existing certificate page is added, before doc.save():
//
//   const events = await loadAudit(admin, row.id);
//   await appendAuditTrail(doc, { contract: row, signers, events, company });

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'npm:pdf-lib@1.17.1';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export type AuditEvent = {
  id: number; event: string; created_at: string; actor_type?: string | null; actor_id?: string | null;
  signer_id?: number | null; ip?: string | null; user_agent?: string | null; payload?: Record<string, unknown> | null; hash?: string | null;
};

const LABELS: Record<string, string> = {
  created: 'Document created', draft: 'Saved as draft', sent: 'Sent for signature', viewed: 'Opened',
  code_sent: 'Access code sent', code_failed: 'Wrong access code', access_denied: 'Access denied',
  consented: 'Agreed to sign electronically', field_filled: 'Filled fields', filled: 'Finished filling',
  signed: 'Signed', recipient_completed: 'Recipient completed', completed: 'Document completed',
  declined: 'Declined', voided: 'Voided', expired: 'Expired', reminded: 'Reminder sent', turn: 'Next signer notified',
  delegated: 'Reassigned', approved: 'Approved', rejected: 'Rejected', downloaded: 'Downloaded',
  corrected: 'Corrected and resent', expiry_extended: 'Expiration extended', attachment_added: 'File attached',
  forwarded: 'Forwarded', extracted: 'Terms extracted', notarized: 'Notarized',
};

export async function loadAudit(admin: SupabaseClient, contractId: number): Promise<AuditEvent[]> {
  const { data } = await admin.from('contract_events')
    .select('id, event, created_at, actor_type, actor_id, signer_id, ip, user_agent, payload, hash')
    .eq('contract_id', contractId).order('id');
  return (data ?? []) as AuditEvent[];
}

const WIN = /[^\t\n\x20-\x7E\xA0-\xFF]/g;
const clean = (s: unknown) => String(s ?? '').replace(WIN, '?');

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = clean(text).split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

const fmt = (iso: string) => {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(iso)) + ' CT';
  } catch { return iso; }
};

/** Appends "Audit Trail" pages (Letter) to an open pdf-lib document. */
export async function appendAuditTrail(
  doc: PDFDocument,
  p: { contract: Any; signers: Any[]; events: AuditEvent[]; company: { name?: string; legal?: string } },
): Promise<void> {
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 48, colW = W - M * 2;
  const ink = rgb(0.17, 0.17, 0.17), mute = rgb(0.42, 0.45, 0.5), accent = rgb(0.95, 0.42, 0.11);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const header = () => {
    page.drawText('Audit Trail', { x: M, y, size: 18, font: bold, color: ink });
    page.drawRectangle({ x: M, y: y - 8, width: colW, height: 2, color: accent });
    y -= 30;
    page.drawText(clean(`${p.contract.name}  ·  Ref ${p.contract.ref_number ?? 'CLZ-' + p.contract.id}`), { x: M, y, size: 10, font, color: mute });
    y -= 14;
    page.drawText(clean(`Document hash (SHA-256, unsigned): ${p.contract.sha256 ?? 'n/a'}`), { x: M, y, size: 7.5, font, color: mute });
    y -= 22;
  };
  const ensure = (need: number) => {
    if (y - need < M) { page = doc.addPage([W, H]); y = H - M; header(); }
  };
  header();

  const who = new Map(p.signers.map((s: Any) => [s.id, `${s.name || s.email || s.role}${s.label ? ' (' + s.label + ')' : ''}`]));
  for (const e of p.events) {
    const title = LABELS[e.event] ?? e.event.replace(/_/g, ' ');
    const actor = e.signer_id ? who.get(e.signer_id) : (e.actor_type === 'user' ? (e.actor_id ?? 'Clozr user') : (e.actor_type === 'system' ? 'Clozr' : (e.actor_id ?? '')));
    const detailBits: string[] = [];
    const pl = (e.payload ?? {}) as Record<string, unknown>;
    if (pl.reason) detailBits.push(`Reason: ${pl.reason}`);
    if (pl.email && !e.signer_id) detailBits.push(String(pl.email));
    if (pl.count) detailBits.push(`${pl.count} field(s)`);
    if (pl.drawn != null) detailBits.push(pl.drawn ? 'drawn signature' : 'typed signature');
    if (pl.channel) detailBits.push(`via ${pl.channel}`);
    if (e.ip) detailBits.push(`IP ${e.ip}`);
    const ua = e.user_agent ? e.user_agent.slice(0, 110) : '';
    const lines = wrap(detailBits.join('  ·  '), font, 8, colW - 150);
    const uaLines = ua ? wrap(ua, font, 7, colW - 150) : [];
    ensure(16 + lines.length * 10 + uaLines.length * 9 + 8);
    page.drawText(clean(fmt(e.created_at)), { x: M, y, size: 8, font, color: mute });
    page.drawText(clean(title), { x: M + 150, y, size: 9.5, font: bold, color: ink });
    if (actor) page.drawText(clean(actor).slice(0, 60), { x: M + 330, y, size: 9, font, color: ink });
    y -= 12;
    for (const l of lines) { page.drawText(l, { x: M + 150, y, size: 8, font, color: mute }); y -= 10; }
    for (const l of uaLines) { page.drawText(l, { x: M + 150, y, size: 7, font, color: mute }); y -= 9; }
    if (e.hash) { page.drawText(clean(`chain ${e.hash.slice(0, 24)}...`), { x: M + 150, y, size: 6.5, font, color: mute }); y -= 9; }
    y -= 6;
  }
  ensure(60);
  y -= 6;
  for (const l of wrap(
    `Each event above is recorded in an append-only, hash-chained log. Electronic signatures were captured under the U.S. ESIGN Act and the Uniform Electronic Transactions Act after each signer consented to do business electronically. Verify this document at ${Deno.env.get('APP_URL') ?? 'https://your-clozr-site.example.com'}/verify by uploading this PDF (reference ${p.contract.ref_number ?? 'CLZ-' + p.contract.id}).`,
    font, 8, colW,
  )) { page.drawText(l, { x: M, y, size: 8, font, color: mute }); y -= 10; }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify: (1) contract_events_verify() says the chain is intact,
 * (2) the stored signed PDF still hashes to final_sha256,
 * (3) optionally an uploaded file is byte-identical to it.
 */
export async function verifyContract(admin: SupabaseClient, where: { id?: number; ref?: string; sha256?: string }, upload?: Uint8Array) {
  let q = admin.from('contracts').select('id, name, status, ref_number, completed_at, pdf_path, final_sha256, sha256, workspace_id');
  if (where.id) q = q.eq('id', where.id);
  else if (where.ref) q = q.eq('ref_number', where.ref);
  else if (where.sha256) q = q.eq('final_sha256', where.sha256);
  else return { ok: false, error: 'Give a reference number or a file.' };
  const { data: row } = await q.maybeSingle();
  // A hash lookup is the public path: only executed documents answer it.
  if (!row || (!where.id && row.status !== 'completed')) return { ok: false, found: false };
  const { data: chain, error: chainErr } = await admin.rpc('contract_events_verify', { p_contract_id: row.id });
  let storedOk: boolean | null = null;
  if (row.pdf_path && row.final_sha256) {
    const { data: blob } = await admin.storage.from('contracts').download(row.pdf_path);
    if (blob) storedOk = (await sha256Hex(new Uint8Array(await blob.arrayBuffer()))) === row.final_sha256;
  }
  const uploadOk = upload ? (await sha256Hex(upload)) === row.final_sha256 : null;
  const { data: signers } = await admin.from('contract_signers').select('name, label, role, signed_at, recipient_type, status').eq('contract_id', row.id).order('sort');
  return {
    ok: true, found: true,
    contract: { name: row.name, status: row.status, ref: row.ref_number, completed_at: row.completed_at },
    chain_intact: chainErr ? null : (typeof chain === 'boolean' ? chain : (chain as Any)?.ok ?? chain),
    stored_pdf_intact: storedOk,
    upload_matches: uploadOk,
    signers: (signers ?? []).filter((s: Any) => s.status !== 'delegated').map((s: Any) => ({ name: s.name, role: s.label || s.role, signed_at: s.signed_at })),
  };
}
