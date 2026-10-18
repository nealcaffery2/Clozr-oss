/**
 * The document engine behind CLOZR's own contracts and offers.
 *
 * A template is markdown-ish text with [Group.Name] tokens and {{sign:role}}
 * signature blocks. From one filled body we render HTML (preview and the
 * signing page) and a PDF (pdf-lib, Letter, Helvetica), stamp signatures into
 * it, append a signature certificate, and hash the result.
 *
 * Shared by the contracts, esign, offers and compr-underwrite functions.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'npm:pdf-lib@1.17.1';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { pd, pickPandaDocTemplate, status as pdStatus } from './pandadoc.ts';
import { type EnvLike, type ResendFrom, sendResend, transactionalFrom } from './resend.ts';
import { signingResendEnv } from './workspace-email.ts';
import { completedEmail, signingEmail } from './emails.ts';
import { buildTokens, fill, longDate, money, partySigner, str, tokensIn, type Party, type Token } from './esign-map.ts';
import { isPurchaseContract, nextDealStage, signedDealUpdate } from './contract-apply.ts';
import { docVars, varsIn, type DocParties } from './doc-vars.ts';
import { appendTcCc, sendTo, type OrderMode, type RecipientType, type ReminderPolicy, type TcCopy } from './signing-order.ts';
import { publishContract } from './contract-webhooks.ts';
import { kickExtraction } from './extract-kick.ts';
import { blocksIn, expandBlocks, type BlockUse, type ContentBlock } from './doc-blocks.ts';

/**
 * One audit event. contract_events is append-only and hash-chained in the
 * database (migration 112); who did it, from where, rides on its own columns.
 */
export async function logEvent(
  admin: SupabaseClient, row: Record<string, Any>, event: string, payload: Record<string, unknown> = {},
  who: { actor_type?: 'user' | 'signer' | 'system'; actor_id?: string | null; signer_id?: number | null; ip?: string | null; user_agent?: string | null } = {},
) {
  const { error } = await admin.from('contract_events').insert({
    workspace_id: row.workspace_id, contract_id: row.id, event, payload,
    actor_type: who.actor_type ?? 'system', actor_id: who.actor_id ?? null, signer_id: who.signer_id ?? null,
    ip: who.ip ?? null, user_agent: who.user_agent ?? null,
  });
  if (error) console.error('contract_events', event, error.message);
}

export { buildTokens, fill, longDate, money, partySigner, str, tokensIn, varsIn };
export type { Party, Token };

// deno-lint-ignore no-explicit-any
export type Any = any;
export type SignerRow = {
  id?: number; role: string; label?: string | null; name?: string | null; email?: string | null; phone?: string | null; sort?: number;
  status?: string; signed_at?: string | null; signature_name?: string | null; signature_png?: string | null; ip?: string | null;
  viewed_at?: string | null; consented_at?: string | null; user_agent?: string | null; token?: string; optional?: boolean;
  /** A form filler fills fields on a PDF and presses Done (filled_at); never a signatory. */
  recipient_type?: string | null; filled_at?: string | null;
};
export type Company = { name?: string; legal?: string; address?: string; signer?: string; title?: string; email?: string; phone?: string;
  /** Who holds the earnest money. Usually the buyer's own affiliate, which is why it is not the legal entity by default. */
  escrow?: string;
  /** Letterhead logo, a PNG or JPEG data URL (Settings → Contracts). */
  logo?: string;
  /** The agent block on TREC and state forms (Settings → Contracts). */
  brokerage_name?: string; brokerage_address?: string; brokerage_license?: string;
  supervisor_name?: string; supervisor_phone?: string; supervisor_license?: string };

/** Settings live on workspaces.settings; company details are what templates print. */
export async function loadCompany(client: SupabaseClient, ws: number): Promise<{ company: Company; settings: Record<string, Any> }> {
  const { data } = await client.from('workspaces').select('name, settings').eq('id', ws).maybeSingle();
  const settings = ((data?.settings ?? {}) as Record<string, Any>);
  const c = (settings.company ?? {}) as Company;
  return { company: { name: c.name || data?.name || 'Acme Homes', legal: c.legal || c.name || data?.name || '', address: c.address || '', signer: c.signer || '', title: c.title || '', email: c.email || '', phone: c.phone || '', escrow: c.escrow || c.legal || c.name || data?.name || '', logo: typeof c.logo === 'string' ? c.logo : '',
    brokerage_name: c.brokerage_name || '', brokerage_address: c.brokerage_address || '', brokerage_license: c.brokerage_license || '',
    supervisor_name: c.supervisor_name || '', supervisor_phone: c.supervisor_phone || '', supervisor_license: c.supervisor_license || '' }, settings };
}

/** The records a contract is about, read as the caller so RLS applies. */
export async function loadParties(client: SupabaseClient, ws: number, ids: { sellerId?: number | null; dealId?: number | null; buyerId?: number | null; offerId?: number | null }) {
  const [{ data: seller0 }, { data: deal0 }, { data: buyer0 }, { data: offer }] = await Promise.all([
    ids.sellerId ? client.from('sellers').select('*').eq('id', ids.sellerId).eq('workspace_id', ws).maybeSingle() : Promise.resolve({ data: null }),
    ids.dealId ? client.from('deals').select('*').eq('id', ids.dealId).eq('workspace_id', ws).maybeSingle() : Promise.resolve({ data: null }),
    ids.buyerId ? client.from('buyers').select('*').eq('id', ids.buyerId).eq('workspace_id', ws).maybeSingle() : Promise.resolve({ data: null }),
    ids.offerId ? client.from('offers').select('*').eq('id', ids.offerId).eq('workspace_id', ws).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const deal = deal0 ?? (seller0 ? (await client.from('deals').select('*').eq('seller_id', seller0.id).order('created_at', { ascending: false }).limit(1).maybeSingle()).data : null);
  const seller = seller0 ?? (deal?.seller_id ? (await client.from('sellers').select('*').eq('id', deal.seller_id).maybeSingle()).data : null);
  const buyer = buyer0 ?? (deal?.buyer_id ? (await client.from('buyers').select('*').eq('id', deal.buyer_id).maybeSingle()).data : null);
  const propId = deal?.property_id ?? seller?.property_id;
  const prop = propId ? (await client.from('properties').select('*').eq('id', propId).maybeSingle()).data : null;
  // A second seller on the same property fills Seller 2. Optional on every template.
  let seller2 = null;
  if (seller?.id && seller.property_id) {
    const { data } = await client.from('sellers').select('id, name, email, phone').eq('workspace_id', ws).eq('property_id', seller.property_id).neq('id', seller.id).order('id').limit(1);
    seller2 = data?.[0] ?? null;
  }
  // Title company vendor and the deal's team, for {{title.*}} and {{rep.*}} (doc-vars.ts).
  // PandaDoc parity: dispo and TC reps load too (rep.dispo / rep.tc used to fall back to free text), plus license numbers for TREC agent blocks.
  const rep = (id: unknown) => id ? client.from('profiles').select('full_name, email, phone, license_number').eq('id', id as string).maybeSingle() : Promise.resolve({ data: null });
  const [{ data: title }, { data: acq }, { data: dispo }, { data: tc }] = await Promise.all([
    deal?.title_vendor_id ? client.from('vendors').select('business_name, contact_name, email, phone').eq('id', deal.title_vendor_id).maybeSingle() : Promise.resolve({ data: null }),
    rep(deal?.owner_id), rep(deal?.dispo_rep_id), rep(deal?.tc_rep_id),
  ]);
  return { deal, seller, seller2, buyer, prop, offer, title, reps: { acq, dispo, tc } };
}

/** The Clozr Docs variables for these records (doc-vars.ts), with a reference number when the contract has one. */
export function varsFor(parties: Awaited<ReturnType<typeof loadParties>>, company: Company, ref?: string | null) {
  return docVars(parties as DocParties, company, { ref: ref ?? null });
}

// ------------------------------------------------------------------ blocks
export type Block =
  | { t: 'h1' | 'h2' | 'h3' | 'small' | 'p' | 'li'; text: string }
  | { t: 'page' }
  | { t: 'sign'; role: string };

export function parse(text: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ t: 'p', text: para.join(' ') }); para = []; } };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const m = line.match(/^\{\{\s*sign:([a-z0-9_]+)\s*\}\}$/i);
    if (m) { flush(); out.push({ t: 'sign', role: m[1].toLowerCase() }); continue; }
    if (/^---+$/.test(line.trim())) { flush(); out.push({ t: 'page' }); continue; }
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith('###### ')) { flush(); out.push({ t: 'small', text: line.slice(7).trim() }); continue; }
    if (line.startsWith('### ') || line.startsWith('#### ') || line.startsWith('##### ')) { flush(); out.push({ t: 'h3', text: line.replace(/^#+\s*/, '') }); continue; }
    if (line.startsWith('## ')) { flush(); out.push({ t: 'h2', text: line.slice(3).trim() }); continue; }
    if (line.startsWith('# ')) { flush(); out.push({ t: 'h1', text: line.slice(2).trim() }); continue; }
    if (/^[-*•]\s+/.test(line.trim())) { flush(); out.push({ t: 'li', text: line.trim().replace(/^[-*•]\s+/, '') }); continue; }
    para.push(line.trim());
  }
  flush();
  return out.map((b) => ('text' in b ? { ...b, text: b.text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1') } : b));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const fmtWhen = (v: string | null | undefined) => (v ? new Date(v).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago' }) + ' CT' : '');

/** The letterhead logo, if there is one and it is a PNG or JPEG data URL. A bad one is skipped, never fatal. */
async function embedLogo(pdf: PDFDocument, dataUrl: string | undefined): Promise<PDFImage | null> {
  const m = (dataUrl ?? '').match(/^data:image\/(png|jpe?g);base64,(.+)$/);
  if (!m) return null;
  try {
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    return m[1] === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
  } catch { return null; }
}

/** HTML fragment for preview and the signing page. Styled by the page. */
export function toHtml(blocks: Block[], signers: SignerRow[], opts: { highlightRole?: string | null } = {}): string {
  const parts: string[] = [];
  let list: string[] = [];
  const flushList = () => { if (list.length) { parts.push(`<ul>${list.join('')}</ul>`); list = []; } };
  for (const b of blocks) {
    if (b.t !== 'li') flushList();
    switch (b.t) {
      case 'h1': parts.push(`<h1>${esc(b.text)}</h1>`); break;
      case 'h2': parts.push(`<h2>${esc(b.text)}</h2>`); break;
      case 'h3': parts.push(`<h3>${esc(b.text)}</h3>`); break;
      case 'small': parts.push(`<div class="small">${esc(b.text)}</div>`); break;
      case 'p': parts.push(`<p>${esc(b.text)}</p>`); break;
      case 'li': list.push(`<li>${esc(b.text)}</li>`); break;
      case 'page': parts.push('<hr class="page" />'); break;
      case 'sign': {
        const s = signers.find((x) => x.role === b.role);
        if (!s) break;
        if (s.optional && !s.name && s.status !== 'signed') break;
        const mine = opts.highlightRole === b.role;
        const signed = s.status === 'signed';
        parts.push(`<div class="sig${mine ? ' mine' : ''}${signed ? ' signed' : ''}" data-role="${esc(b.role)}">
  <div class="sig-label">${esc(s.label || s.role)}</div>
  <div class="sig-line">${signed ? (s.signature_png ? `<img alt="signature" src="${esc(s.signature_png)}" />` : `<span class="typed">${esc(s.signature_name || s.name || '')}</span>`) : '<span class="blank">Signature</span>'}</div>
  <div class="sig-meta">${esc(s.name || '')}${signed ? ` · signed ${esc(fmtWhen(s.signed_at))}` : mine ? ' · your signature goes here' : ' · awaiting signature'}</div>
</div>`);
        break;
      }
    }
  }
  flushList();
  return parts.join('\n');
}

// --------------------------------------------------------------------- pdf
const WIN = /[^\t\n\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g;
const clean = (s: string) => s.replace(/\u00A0/g, ' ').replace(WIN, '?');

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = clean(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) { cur = next; continue; }
    if (cur) lines.push(cur);
    // A single word wider than the column is split hard.
    if (font.widthOfTextAtSize(w, size) > width) {
      let piece = '';
      for (const ch of w) { if (font.widthOfTextAtSize(piece + ch, size) > width) { lines.push(piece); piece = ch; } else piece += ch; }
      cur = piece;
    } else cur = w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export type PdfMeta = { title: string; company: Company; contractId: number | string; signers: SignerRow[]; certificate?: boolean; hashOf?: string;
  /** Just the certificate page, to append to an uploaded PDF (pdf-contracts.ts). */
  certificateOnly?: boolean };

export async function toPdf(blocks: Block[], meta: PdfMeta): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(meta.title); pdf.setProducer('CLOZR'); pdf.setCreator('CLOZR');
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ital = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const W = 612, H = 792, M = 54, CW = W - M * 2;
  const gray = rgb(0.45, 0.45, 0.47), ink = rgb(0.09, 0.09, 0.1), line = rgb(0.85, 0.85, 0.87);
  const pages: PDFPage[] = [];
  let page!: PDFPage; let y = 0;

  const images = new Map<string, PDFImage>();
  for (const s of meta.signers) {
    if (s.signature_png?.startsWith('data:image/png;base64,')) {
      try { images.set(s.role, await pdf.embedPng(Uint8Array.from(atob(s.signature_png.split(',')[1]), (c) => c.charCodeAt(0)))); } catch { /* typed fallback */ }
    }
  }

  // The letterhead: the company's logo (or name) on the left, its address and
  // phone on the right, a green rule under — the same on every page.
  const logo = await embedLogo(pdf, meta.company.logo);
  const contact = [meta.company.address, [meta.company.phone, meta.company.email].filter(Boolean).join(' · ')].map((s) => clean(s || '')).filter(Boolean);
  const accent = rgb(0.04, 0.52, 0.38);
  const newPage = () => {
    page = pdf.addPage([W, H]); pages.push(page);
    const base = H - 46;
    if (logo) {
      const sc = Math.min(150 / logo.width, 30 / logo.height);
      page.drawImage(logo, { x: M, y: base + 2, width: logo.width * sc, height: logo.height * sc });
    } else page.drawText(clean(meta.company.name || ''), { x: M, y: base + 6, size: 11, font: bold, color: ink });
    const right = contact.length ? contact : [clean(meta.title).slice(0, 80)];
    right.slice(0, 2).forEach((l, i) => {
      const s = l.slice(0, 90);
      page.drawText(s, { x: W - M - reg.widthOfTextAtSize(s, 7.5), y: base + 6 + (right.length > 1 ? (1 - i) * 9 : 0), size: 7.5, font: reg, color: gray });
    });
    page.drawLine({ start: { x: M, y: base - 4 }, end: { x: W - M, y: base - 4 }, thickness: 1.2, color: accent });
    y = base - 28;
  };
  const need = (h: number) => { if (y - h < M + 24) newPage(); };
  const text = (s: string, font: PDFFont, size: number, opts: { color?: ReturnType<typeof rgb>; indent?: number; center?: boolean; gapAfter?: number; leading?: number } = {}) => {
    const lead = opts.leading ?? size * 1.38;
    const width = CW - (opts.indent ?? 0);
    const lines = wrap(s, font, size, width);
    for (const l of lines) {
      need(lead);
      const x = opts.center ? M + (CW - font.widthOfTextAtSize(l, size)) / 2 : M + (opts.indent ?? 0);
      page.drawText(l, { x, y, size, font, color: opts.color ?? ink });
      y -= lead;
    }
    y -= opts.gapAfter ?? 0;
  };

  newPage();
  for (const b of blocks) {
    switch (b.t) {
      case 'page': newPage(); break;
      case 'small': text(b.text, reg, 8.5, { color: gray, gapAfter: 2 }); break;
      case 'h1': y -= 6; need(30); text(b.text.toUpperCase(), bold, 15, { center: true, gapAfter: 8 }); break;
      case 'h2': y -= 6; need(24); text(b.text, bold, 12.5, { gapAfter: 5 }); break;
      case 'h3': y -= 6; need(20); text(b.text.toUpperCase(), bold, 9.5, { color: rgb(0.2, 0.2, 0.22), gapAfter: 4 }); break;
      case 'p': text(b.text, reg, 10, { gapAfter: 6 }); break;
      case 'li': {
        need(14);
        page.drawText('•', { x: M + 8, y, size: 10, font: reg, color: ink });
        text(b.text, reg, 10, { indent: 20, gapAfter: 2 });
        break;
      }
      case 'sign': {
        const s = meta.signers.find((x) => x.role === b.role);
        if (!s || (s.optional && !s.name && s.status !== 'signed')) break;
        need(96);
        y -= 8;
        page.drawText(clean(s.label || s.role).toUpperCase(), { x: M, y, size: 8.5, font: bold, color: gray });
        y -= 8;
        const img = images.get(s.role);
        const signed = s.status === 'signed';
        if (signed && img) {
          const scale = Math.min(190 / img.width, 46 / img.height);
          page.drawImage(img, { x: M + 4, y: y - 48, width: img.width * scale, height: img.height * scale });
        } else if (signed) {
          page.drawText(clean(s.signature_name || s.name || ''), { x: M + 6, y: y - 36, size: 17, font: ital, color: rgb(0.1, 0.2, 0.55) });
        }
        y -= 52;
        page.drawLine({ start: { x: M, y }, end: { x: M + 260, y }, thickness: 0.7, color: ink });
        page.drawLine({ start: { x: M + 290, y }, end: { x: W - M, y }, thickness: 0.7, color: ink });
        y -= 11;
        page.drawText('Signature', { x: M, y, size: 7.5, font: reg, color: gray });
        page.drawText(signed ? `Date: ${clean(fmtWhen(s.signed_at))}` : 'Date', { x: M + 290, y, size: 7.5, font: signed ? bold : reg, color: signed ? ink : gray });
        y -= 12;
        page.drawText(`Name: ${clean(s.name || (signed ? s.signature_name || '' : ''))}`, { x: M, y, size: 9, font: reg, color: ink });
        if (signed) page.drawText(`Signed electronically via CLOZR${s.ip ? ` · IP ${clean(s.ip)}` : ''}`, { x: M + 290, y, size: 7.5, font: reg, color: gray });
        y -= 16;
        break;
      }
    }
  }

  if (meta.certificate) {
    if (!meta.certificateOnly) newPage();
    text('Signature Certificate', bold, 15, { gapAfter: 6 });
    text(`Document: ${meta.title}`, reg, 10, { gapAfter: 2 });
    text(`CLOZR contract #${meta.contractId} · Completed ${fmtWhen(new Date().toISOString())}`, reg, 10, { gapAfter: 2 });
    if (meta.hashOf) text(`SHA-256 of the unsigned document: ${meta.hashOf}`, reg, 8.5, { color: gray, gapAfter: 10 });
    for (const s of meta.signers) {
      if (s.optional && !s.name && s.status !== 'signed') continue;
      y -= 4;
      // A form filler typed values in and pressed Done; they are not a signatory.
      const filler = s.recipient_type === 'filler';
      text(`${filler ? `Form filler (${s.label || s.role})` : s.label || s.role}: ${s.name || '—'}${s.email ? ` <${s.email}>` : ''}`, bold, 10, { gapAfter: 2 });
      const rows = [
        s.viewed_at ? `Viewed ${fmtWhen(s.viewed_at)}` : null,
        s.consented_at ? `Agreed to ${filler ? 'fill in' : 'sign'} electronically ${fmtWhen(s.consented_at)}` : null,
        filler ? (s.filled_at ? `Filled in fields ${fmtWhen(s.filled_at)} · did not sign` : `Status: ${s.status || 'pending'}`)
        : s.signed_at ? `Signed ${fmtWhen(s.signed_at)}${s.signature_png ? ' (drawn signature)' : ` (typed "${s.signature_name || ''}")`}` : `Status: ${s.status || 'pending'}`,
        s.ip ? `IP ${s.ip}${s.user_agent ? ` · ${s.user_agent.slice(0, 90)}` : ''}` : null,
      ].filter((r): r is string => !!r);
      for (const r of rows) text(r, reg, 9, { indent: 12, gapAfter: 1, color: rgb(0.25, 0.25, 0.27) });
    }
    y -= 8;
    text('Electronic signatures on this document are intended to be legally binding under the U.S. ESIGN Act and UETA. Each signer confirmed their intent to sign and consent to do business electronically before signing.', reg, 8.5, { color: gray });
  }

  const n = pages.length;
  pages.forEach((p, i) => {
    const f = `Page ${i + 1} of ${n}`;
    p.drawText(f, { x: (W - reg.widthOfTextAtSize(f, 8)) / 2, y: 30, size: 8, font: reg, color: gray });
    p.drawText(`CLOZR · contract ${meta.contractId}`, { x: M, y: 30, size: 7.5, font: reg, color: gray });
  });
  return pdf.save();
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer))).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ storage
export async function storePdf(admin: SupabaseClient, ws: number, contractId: number, file: string, bytes: Uint8Array): Promise<string | null> {
  const path = `ws/${ws}/${contractId}/${file}`;
  const { error } = await admin.storage.from('contracts').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
  return error ? null : path;
}

// --------------------------------------------------------- stage automation
/** What a fully signed document does to the pipeline. Same rules as PandaDoc completion. */
export async function applyCompletion(admin: SupabaseClient, row: Record<string, Any>) {
  if (isPurchaseContract(String(row.kind ?? ''), row.template_key, row.template_name)) {
    if (row.seller_id) await admin.from('sellers').update({ lead_stage: 'Under Contract - Seller' }).eq('id', row.seller_id);
    // The seller trigger moves the deal when that stage actually changes.
    // When it does not, write the deal here so a fully executed purchase still lands under contract.
    if (row.deal_id) {
      const { data: deal } = await admin.from('deals').select('stage').eq('id', row.deal_id).maybeSingle();
      const stage = nextDealStage(deal?.stage ?? null, 'psa', 'seller');
      if (stage) {
        await admin.from('deals').update({ stage }).eq('id', row.deal_id);
        await admin.from('activity').insert({ workspace_id: row.workspace_id, entity_type: 'deal', entity_id: row.deal_id, kind: 'stage', title: 'Stage → Under Contract Seller', body: row.name });
      }
    }
  }
  else if (row.kind === 'assignment' && row.deal_id) await admin.from('deals').update({ stage: 'Buyer Under Contract', ...(row.buyer_id ? { buyer_id: row.buyer_id } : {}) }).eq('id', row.deal_id);
  else if (row.kind === 'termination') {
    if (row.deal_id) await admin.from('deals').update({ stage: 'Terminated' }).eq('id', row.deal_id);
    if (row.seller_id) await admin.from('sellers').update({ lead_stage: 'Terminated' }).eq('id', row.seller_id);
  }
  else if (row.kind === 'offer' && row.offer_id) {
    await admin.from('offers').update({ status: 'Accepted', responded_at: new Date().toISOString() }).eq('id', row.offer_id);
    if (row.seller_id) await admin.from('activity').insert({ workspace_id: row.workspace_id, entity_type: 'seller', entity_id: row.seller_id, kind: 'offer', title: 'Offer accepted — send the purchase agreement', body: row.name });
  }
}

const OFFER_SENT_LOCK = [
  'Offer Made', 'Pending Response', 'Offer Made - Follow Up', 'Offer Made - Retail',
  'Pending Inspections', 'Offer Accepted', 'Contract Sent to Seller',
  'Under Contract - Seller', 'Under Contract - Buyer', 'Memo Filed / Legal', 'Closed',
];
const PSA_SENT_LOCK = [
  'Contract Sent to Seller', 'Under Contract - Seller', 'Under Contract - Buyer',
  'Memo Filed / Legal', 'Closed',
];

/** The contracts TC on this workspace (role tc, plus Casey when that is her name). */
export async function workspaceTcCopies(admin: SupabaseClient, ws: number): Promise<(TcCopy & { user_id: string })[]> {
  const { data: members } = await admin.from('workspace_members').select('user_id, role').eq('workspace_id', ws);
  const rows = members ?? [];
  const ids = new Set<string>();
  for (const m of rows) if (m.role === 'tc') ids.add(m.user_id as string);
  const memberIds = rows.map((m) => m.user_id as string).filter(Boolean);
  if (!memberIds.length) return [];
  const { data: profiles } = await admin.from('profiles').select('id, full_name, email').in('id', memberIds);
  for (const p of profiles ?? []) if (/casey/i.test(String(p.full_name ?? ''))) ids.add(p.id as string);
  const out: (TcCopy & { user_id: string })[] = [];
  const seen = new Set<string>();
  for (const p of profiles ?? []) {
    if (!ids.has(p.id as string)) continue;
    const email = String(p.email ?? '').trim().toLowerCase();
    if (!email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    out.push({ user_id: p.id as string, email, name: (p.full_name as string | null) ?? null });
  }
  return out;
}

/** A draft sent later still copies the TC. Returns every TC email so the outbound mail can CC them. */
export async function ensureTcCc(admin: SupabaseClient, row: Record<string, Any>): Promise<string[]> {
  const tcs = await workspaceTcCopies(admin, row.workspace_id as number);
  if (!tcs.length) return [];
  const { data: existing } = await admin.from('contract_signers').select('email, sort').eq('contract_id', row.id);
  const have = new Set((existing ?? []).map((s) => String(s.email ?? '').trim().toLowerCase()).filter((e) => e.includes('@')));
  let sort = Math.max(0, ...(existing ?? []).map((s) => Number(s.sort ?? 0)));
  const add: Record<string, unknown>[] = [];
  for (const tc of tcs) {
    if (have.has(tc.email)) continue;
    sort += 1;
    add.push({
      workspace_id: row.workspace_id, contract_id: row.id, role: `tc_cc${sort}`, label: 'CC',
      name: tc.name, email: tc.email, sort, recipient_type: 'cc',
    });
  }
  if (add.length) await admin.from('contract_signers').insert(add);
  return tcs.map((t) => t.email);
}

async function pingTc(admin: SupabaseClient, ws: number, opts: { title: string; body?: string; sellerId?: number | null; dealId?: number | null }) {
  const tcs = await workspaceTcCopies(admin, ws);
  if (!tcs.length) return;
  await admin.from('notifications').insert(tcs.map((t) => ({
    workspace_id: ws, user_id: t.user_id, category: 'TC',
    title: opts.title, body: opts.body ?? null,
    seller_id: opts.sellerId ?? null, deal_id: opts.dealId ?? null,
  })));
}

/** Seller, buyer, and the deal all carry the same line, so each record's feed shows it. */
export async function logContractFeed(admin: SupabaseClient, row: Record<string, Any>, title: string, body: string | null) {
  const targets = [
    row.seller_id ? { entity_type: 'seller', entity_id: row.seller_id } : null,
    row.buyer_id ? { entity_type: 'buyer', entity_id: row.buyer_id } : null,
    row.deal_id ? { entity_type: 'deal', entity_id: row.deal_id } : null,
  ].filter((t): t is { entity_type: string; entity_id: number } => !!t);
  if (!targets.length) return;
  await admin.from('activity').insert(targets.map((t) => ({
    workspace_id: row.workspace_id, ...t, kind: 'contract', title, body,
  })));
}

/**
 * A signature landed. TC (Casey, when she is the coordinator) always hears.
 * A seller signature also pings acquisitions on that deal. A buyer signature
 * pings dispositions on that deal.
 */
export async function notifySigned(
  admin: SupabaseClient,
  row: Record<string, Any>,
  signer: { role?: string | null; name?: string | null; email?: string | null },
) {
  const { contractSide } = await import('./contract-apply.ts');
  const { partyLabel } = await import('./esign-session.ts');
  const side = contractSide(String(row.kind ?? ''), [String(signer.role ?? '')]);
  const title = `${partyLabel(signer.role)} signed ${row.name ?? 'contract'}`;
  const body = [signer.name, signer.email].filter(Boolean).join(' · ') || null;
  const ids = new Set<string>();
  const { data: members } = await admin.from('workspace_members').select('user_id, role').eq('workspace_id', row.workspace_id);
  const memberIds = (members ?? []).map((m) => m.user_id as string);
  for (const m of members ?? []) if (m.role === 'tc') ids.add(m.user_id);
  if (memberIds.length) {
    const { data: profiles } = await admin.from('profiles').select('id, full_name').in('id', memberIds);
    for (const p of profiles ?? []) if (/casey/i.test(String(p.full_name ?? ''))) ids.add(p.id);
  }
  if (row.deal_id) {
    const { data: deal } = await admin.from('deals').select('owner_id, dispo_rep_id, tc_rep_id').eq('id', row.deal_id).maybeSingle();
    if (deal?.tc_rep_id) ids.add(deal.tc_rep_id);
    if (side === 'seller' && deal?.owner_id) ids.add(deal.owner_id);
    if (side === 'buyer' && deal?.dispo_rep_id) ids.add(deal.dispo_rep_id);
    const partyRole = side === 'seller' ? 'acquisitions' : 'dispositions';
    const { data: parties } = await admin.from('deal_parties').select('user_id').eq('deal_id', row.deal_id).eq('role', partyRole).not('user_id', 'is', null);
    for (const p of parties ?? []) if (p.user_id) ids.add(p.user_id);
  }
  if (!ids.size) return;
  await admin.from('notifications').insert([...ids].map((user_id) => ({
    workspace_id: row.workspace_id, user_id, category: 'TC', title, body,
    seller_id: row.seller_id ?? null, deal_id: row.deal_id ?? null,
  })));
}

/** Write the signed terms onto the deal sheet: price, fee, dates, option clocks. */
export async function applySignedDeal(admin: SupabaseClient, row: Record<string, Any>) {
  if (!row.deal_id) return;
  const tokens = Array.isArray(row.tokens) ? row.tokens as Token[] : [];
  const { data: signers } = await admin.from('contract_signers').select('role').eq('contract_id', row.id);
  const roles = (signers ?? []).map((s) => String(s.role));
  const signedOn = new Date().toISOString().slice(0, 10);
  const update = signedDealUpdate({ kind: String(row.kind ?? ''), roles, tokens, signedOn });
  const { data: deal } = await admin.from('deals').select('contract_date, stage').eq('id', row.deal_id).maybeSingle();
  const patch: Record<string, unknown> = { ...update.patch };
  if (deal?.contract_date) delete patch.contract_date;
  const stageKind = isPurchaseContract(String(row.kind ?? ''), row.template_key, row.template_name) ? 'psa' : String(row.kind ?? '');
  const stage = nextDealStage(deal?.stage ?? null, stageKind, stageKind === 'psa' ? 'seller' : update.side);
  if (stage) patch.stage = stage;
  if (Object.keys(patch).length) {
    await admin.from('deals').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', row.deal_id);
  }
  const tx: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ('close_date' in patch) tx.close_date = patch.close_date;
  if ('option_ends_on' in patch) tx.option_ends_on = patch.option_ends_on;
  if (Object.keys(tx).length > 1) await admin.from('transactions').update(tx).eq('deal_id', row.deal_id);
  if (update.notes.length) {
    await logContractFeed(admin, row, 'Deal sheet updated', update.notes.join('\n'));
  }
}

const fileCategory = (kind: string) => kind === 'assignment' || kind === 'novation' || kind === 'jv' ? 'assignment'
  : kind === 'amendment' || kind === 'addendum' ? 'addendum' : 'purchase_agreement';

/** The executed PDF lands on the deal's Files card, replacing the earlier copy of this contract. */
export async function fileSignedPdf(admin: SupabaseClient, row: Record<string, Any>, bytes: Uint8Array) {
  if (!row.deal_id) return;
  const path = `ws/${row.workspace_id}/deals/${row.deal_id}/contract-${row.id}-signed.pdf`;
  const up = await admin.storage.from('deal-files').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
  if (up.error) { console.error('deal file', up.error.message); return; }
  const payload = {
    name: `${String(row.name ?? 'Contract')} (signed).pdf`.slice(0, 180),
    storage_path: path, content_type: 'application/pdf', byte_size: bytes.byteLength, source: 'esign',
    category: fileCategory(String(row.kind ?? '')),
    needs_notary: !!row.needs_notary,
    notary_mode: row.notary_mode ?? null,
    notary_status: row.notary_status && row.notary_status !== 'none' ? row.notary_status : (row.needs_notary ? 'needed' : null),
    contract_id: row.id,
  };
  const { data: existing } = await admin.from('deal_files').select('id').eq('deal_id', row.deal_id).eq('contract_id', row.id).maybeSingle();
  if (existing?.id) await admin.from('deal_files').update(payload).eq('id', existing.id);
  else await admin.from('deal_files').insert({ workspace_id: row.workspace_id, deal_id: row.deal_id, kind: 'file', ...payload });
}

/** Ask the in-house notary to seal it, or record a wet stamp / vendor instead. */
export async function queueNotary(admin: SupabaseClient, row: Record<string, Any>, origin: string): Promise<{ emailed: number; note: string | null }> {
  const mode = (row.notary_mode ?? 'digital') as string;
  if (mode === 'wet' || mode === 'vendor') {
    await admin.from('notary_requests').insert({
      workspace_id: row.workspace_id, contract_id: row.id, deal_id: row.deal_id ?? null, mode,
      status: mode, vendor_name: row.notary_vendor ?? null,
    });
    const title = mode === 'wet' ? 'Print and stamp' : `Third-party notary${row.notary_vendor ? `: ${row.notary_vendor}` : ''}`;
    await logContractFeed(admin, row, title, mode === 'wet'
      ? 'Digital seal bypassed. Print the PDF and apply a wet stamp.'
      : 'A vendor will notarize this. No in-house seal was applied.');
    await admin.from('contracts').update({ notary_status: mode, needs_notary: true, notary_mode: mode, notary_vendor: row.notary_vendor ?? null }).eq('id', row.id);
    if (row.deal_id) await admin.from('deal_files').update({ needs_notary: true, notary_mode: mode, notary_status: mode }).eq('deal_id', row.deal_id).eq('contract_id', row.id);
    return { emailed: 0, note: null };
  }
  const { data: members } = await admin.from('workspace_members').select('user_id, notary_stamp_svg').eq('workspace_id', row.workspace_id).eq('role', 'notary');
  const ids = (members ?? []).map((m) => m.user_id as string);
  const { data: profiles } = ids.length ? await admin.from('profiles').select('id, full_name, email').in('id', ids) : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  const notaries = (profiles ?? []).filter((p) => p.email);
  if (!notaries.length) {
    await admin.from('contracts').update({ needs_notary: true, notary_mode: 'digital', notary_status: 'needed' }).eq('id', row.id);
    await logContractFeed(admin, row, 'Notary needed', 'No notary is on the roster yet. Add one under Settings → Team, with state and commission expiration.');
    return { emailed: 0, note: 'No notary on the roster yet.' };
  }
  const from = transactionalFrom();
  let emailed = 0;
  for (const n of notaries) {
    const { data: req } = await admin.from('notary_requests').insert({
      workspace_id: row.workspace_id, contract_id: row.id, deal_id: row.deal_id ?? null,
      notary_user_id: n.id, mode: 'digital', status: 'requested', emailed_to: String(n.email).toLowerCase(),
    }).select('token').single();
    if (!req?.token || !from) continue;
    const url = `${origin.replace(/\/$/, '')}/notary/?t=${req.token}`;
    const ok = await sendResend({
      to: String(n.email), from: from.from,
      subject: `Notary seal needed · ${row.name}`,
      text: `${n.full_name || 'Notary'}, open ${url} from ${n.email} and apply your seal to ${row.name}. Only that email can open it.`,
      html: `<p>${n.full_name || 'Notary'}, a document is ready for your seal.</p><p><a href="${url}">Open and stamp</a></p><p>Only ${n.email} can open this link.</p>`,
      tags: { kind: 'notary' },
    });
    if (ok) emailed++;
  }
  await admin.from('contracts').update({ needs_notary: true, notary_mode: 'digital', notary_status: emailed ? 'requested' : 'needed' }).eq('id', row.id);
  await logContractFeed(admin, row, 'Notary requested', emailed ? `Emailed ${emailed} in-house notary. They stamp from the email on their commission.` : 'The notary link is saved. The email did not send — check the mail sender.');
  return { emailed, note: emailed ? null : 'Notary email did not send.' };
}

/** Sending an offer, PSA, addendum or cancellation moves the pipeline and pings the TC. */
export async function applySent(admin: SupabaseClient, row: Record<string, Any>) {
  const ws = row.workspace_id as number;
  const name = String(row.name ?? row.kind ?? 'Document');
  const kind = String(row.kind ?? '');
  if (isPurchaseContract(kind, row.template_key, row.template_name) && row.seller_id) {
    const { data: s } = await admin.from('sellers').select('lead_stage').eq('id', row.seller_id).maybeSingle();
    if (s && !PSA_SENT_LOCK.includes(s.lead_stage)) {
      await admin.from('sellers').update({ lead_stage: 'Contract Sent to Seller' }).eq('id', row.seller_id);
      await admin.from('activity').insert({ workspace_id: ws, entity_type: 'seller', entity_id: row.seller_id, kind: 'stage', title: 'Stage → Contract Sent to Seller', body: name });
    }
  } else if (kind === 'offer' && row.seller_id) {
    const { data: s } = await admin.from('sellers').select('lead_stage').eq('id', row.seller_id).maybeSingle();
    if (s && !OFFER_SENT_LOCK.includes(s.lead_stage)) {
      await admin.from('sellers').update({ lead_stage: 'Offer Made' }).eq('id', row.seller_id);
      await admin.from('activity').insert({ workspace_id: ws, entity_type: 'seller', entity_id: row.seller_id, kind: 'stage', title: 'Stage → Offer Made', body: name });
    }
    await admin.from('activity').insert({ workspace_id: ws, entity_type: 'seller', entity_id: row.seller_id, kind: 'tc', title: 'Offer sent', body: name });
    // The draft insert does not move the submission. Marking the offer Sent
    // is the offers_after_write path that sets deals.lead_stage to Offer Made
    // and names the maker so Podio writeback runs. A row already Sent is left alone.
    if (row.offer_id) {
      await admin.from('offers').update({ status: 'Sent' }).eq('id', row.offer_id).eq('direction', 'outbound').ilike('status', 'draft');
    }
  } else if (kind === 'addendum' && row.seller_id) {
    await admin.from('activity').insert({ workspace_id: ws, entity_type: 'seller', entity_id: row.seller_id, kind: 'tc', title: 'Addendum sent', body: name });
  } else if (kind === 'termination') {
    if (row.seller_id) {
      const { data: s } = await admin.from('sellers').select('lead_stage').eq('id', row.seller_id).maybeSingle();
      if (s && s.lead_stage !== 'Closed' && s.lead_stage !== 'Terminated') {
        await admin.from('sellers').update({ lead_stage: 'Terminated' }).eq('id', row.seller_id);
        await admin.from('activity').insert({ workspace_id: ws, entity_type: 'seller', entity_id: row.seller_id, kind: 'stage', title: 'Stage → Terminated', body: name });
      }
      await admin.from('activity').insert({ workspace_id: ws, entity_type: 'seller', entity_id: row.seller_id, kind: 'tc', title: 'Cancellation sent', body: name });
    }
    if (row.deal_id) await admin.from('deals').update({ stage: 'Terminated' }).eq('id', row.deal_id);
  }
  const sentTitle = isPurchaseContract(kind, row.template_key, row.template_name) ? 'Purchase contract sent'
    : kind === 'offer' ? 'Offer sent'
    : kind === 'addendum' ? 'Addendum sent'
    : kind === 'termination' ? 'Cancellation sent'
    : kind === 'assignment' ? 'Assignment sent'
    : 'Contract sent';
  await pingTc(admin, ws, { title: sentTitle, body: name, sellerId: row.seller_id ?? null, dealId: row.deal_id ?? null });
}

// ------------------------------------------------------------------- email
/** Optional: email each signer their link when RESEND_API_KEY is set. Returns how many were emailed. */
export type MailSigner = { id?: number; name?: string | null; email?: string | null; label?: string | null; role?: string; status?: string; url: string };
export type SigningSender = { name?: string | null; email?: string | null };

export async function signingSender(admin: SupabaseClient, userId: string | null | undefined): Promise<SigningSender | null> {
  if (!userId) return null;
  const { data } = await admin.from('profiles').select('full_name, email').eq('id', userId).maybeSingle();
  if (!data) return null;
  return { name: (data as Any).full_name ?? null, email: (data as Any).email ?? null };
}

/** Verified-domain From with the rep's display name; reply goes to the rep when we have one. */
export function signingFromLine(env: EnvLike, sender?: SigningSender | null): ResendFrom | null {
  const base = transactionalFrom(env);
  if (!base) return null;
  const name = (sender?.name ?? '').trim().replace(/[\r\n<>"]/g, '');
  if (!name) return base;
  return { ...base, from: `${name} <${base.email}>`, name };
}

/**
 * Mail each signer their own link.
 *
 * Every signer gets a different URL, so this is one send per person rather
 * than one send to many — and the reply-to is the company rather than the
 * no-reply sender, because a seller's first instinct when a contract arrives
 * is to hit reply.
 */
export async function emailSigners(
  company: Company, contractName: string, message: string | null, signers: MailSigner[],
  opts: { reminder?: boolean; expiresAt?: string | null; cc?: string[]; contractId?: number; env?: EnvLike; sender?: SigningSender | null } = {},
): Promise<number> {
  const env = opts.env ?? Deno.env;
  const from = signingFromLine(env, opts.sender);
  if (!from) {
    console.error('signing email skipped: Resend is not configured (RESEND_API_KEY + MAIL_FROM or workspace blast_from)');
    return 0;
  }
  const replyTo = (opts.sender?.email ?? '').trim() || company.email || null;
  let sent = 0;
  for (const s of signers) {
    if (!s.email) continue;
    const to = s.email.trim().toLowerCase();
    // Nobody is copied on a signing email: it carries this signer's own link,
    // and the link alone lets whoever opens it sign as them. The TC is a CC on
    // the contract and gets the completed copy (emailCompleted), never another
    // person's link. opts.cc is kept on the signature for older callers.
    void to;
    const cc: string[] = [];
    const mail = signingEmail({
      company, contractName, message, url: s.url,
      signerName: s.name, role: s.label ?? s.role ?? null,
      expiresAt: opts.expiresAt ?? null, reminder: opts.reminder,
      others: signers.filter((o) => o !== s).map((o) => ({ name: o.name, label: o.label ?? o.role, status: o.status })),
    });
    const ok = await sendResend({
      to: s.email, from: from.from, subject: mail.subject, html: mail.html, text: mail.text,
      cc, replyTo,
      // contract_id / signer_id let the Resend webhook show delivered / opened / bounced per recipient.
      tags: { kind: opts.reminder ? 'signing_reminder' : 'signing', ...(opts.contractId ? { contract_id: String(opts.contractId) } : {}), ...(s.id ? { signer_id: String(s.id) } : {}) },
    }, env);
    if (ok) sent++;
  }
  return sent;
}

/**
 * Everyone signed: send each party their copy.
 *
 * A signed contract that only exists inside the app is a contract the seller
 * will ring up and ask for, so the completion mail carries a link to the PDF.
 * It is a time-boxed signed URL rather than an attachment: the storage bucket
 * is private, and a link that expires beats a binding contract sitting in an
 * inbox forever.
 */
export async function emailCompleted(
  admin: SupabaseClient, row: Record<string, Any>, company: Company, pdfPath: string | null, sha256: string | null, origin: string,
): Promise<number> {
  const env = await signingResendEnv(admin, row.workspace_id as number);
  const from = transactionalFrom(env);
  if (!from) return 0;
  const { data: signers } = await admin.from('contract_signers').select('name, email, label, role, signed_at, token').eq('contract_id', row.id).order('sort');
  const all = (signers ?? []) as SignerRow[];
  if (!all.length) return 0;
  const { data: link } = pdfPath ? await admin.storage.from('contracts').createSignedUrl(pdfPath, 7 * 864e2) : { data: null };
  let sent = 0;
  for (const s of all) {
    if (!s.email) continue;
    const mail = completedEmail({
      company, contractName: String(row.name), recipientName: s.name,
      pdfUrl: link?.signedUrl ?? null,
      url: origin && s.token ? signUrl(origin, s.token) : null,
      sha256,
      signers: all.map((x) => ({ name: x.name, label: x.label ?? x.role, signedAt: x.signed_at })),
    });
    const ok = await sendResend({
      to: s.email, from: from.from, subject: mail.subject, html: mail.html, text: mail.text,
      replyTo: company.email || null, tags: { kind: 'signing_completed' },
    }, env);
    if (ok) sent++;
  }
  return sent;
}

// ---------------------------------------------------------------- creation
export type CreateInput = {
  ws: number; userId: string | null; origin: string;
  template: { id?: number | null; key?: string | null; name: string; kind: string; body_md: string; signers: Any[]; version?: number | null };
  ids: { sellerId?: number | null; dealId?: number | null; buyerId?: number | null; offerId?: number | null };
  signers: { role: string; label?: string; name?: string | null; email?: string | null; phone?: string | null; optional?: boolean; recipient_type?: RecipientType | null }[];
  tokens?: Token[]; name?: string | null; message?: string | null; expiresDays?: number | null; send?: boolean;
  /** Parallel (everyone at once) or sequential (by the order given). */
  orderMode?: OrderMode | null;
  /** When to nudge unsigned signers; null keeps the default (1 day, then every 2). */
  reminders?: ReminderPolicy | null;
  notary?: { needs?: boolean; mode?: 'digital' | 'wet' | 'vendor' | null; vendor?: string | null } | null;
  /** false: mark it sent but leave the signing links unmailed (they go by text instead). */
  email?: boolean;
  parties: Awaited<ReturnType<typeof loadParties>>; company: Company; profile?: { full_name?: string | null; email?: string | null; phone?: string | null } | null;
};

export const signUrl = (origin: string, token: string) => `${origin.replace(/\/$/, '')}/sign/?t=${token}`;

/**
 * A template body with its reusable sections (`{{block:<id>}}`) pasted in,
 * ready for variables. A section that was deleted is an error rather than a
 * silent gap in a contract.
 */
export async function withBlocks(client: SupabaseClient, ws: number, body: string): Promise<{ text: string; used: BlockUse[]; missing: number[] }> {
  const ids = blocksIn(body);
  if (!ids.length) return { text: body, used: [], missing: [] };
  // Sections can nest, so load the workspace's library rather than just these ids.
  const { data } = await client.from('doc_content_blocks').select('id, name, body, locked').eq('workspace_id', ws).limit(2000);
  return expandBlocks(body, (data ?? []) as ContentBlock[]);
}

/** Fill, render, store and (optionally) send a CLOZR-engine contract. */
export async function createContract(admin: SupabaseClient, i: CreateInput) {
  const auto = buildTokens(i.parties, i.company, { name: i.profile?.full_name, email: i.profile?.email, phone: i.profile?.phone });
  const overrides = new Map((i.tokens ?? []).filter((t) => t?.name).map((t) => [t.name, String(t.value ?? '')]));
  const toks = [...auto.filter((t) => !overrides.has(t.name)), ...Array.from(overrides, ([name, value]) => ({ name, value }))].filter((t) => t.value !== '');
  // A reference number for {{doc.ref}}: short, readable, unique enough to quote on the phone.
  const ref = overrides.get('doc.ref') || `CLZ-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const sections = await withBlocks(admin, i.ws, i.template.body_md);
  if (sections.missing.length) throw new Error(`This template uses a section that was deleted (#${sections.missing.join(', #')}). Edit the template and take it out or put it back.`);
  const { text, missing } = fill(sections.text, [...toks, { name: 'doc.ref', value: ref }], varsFor(i.parties, i.company, ref));
  const address = str(i.parties.prop?.line1 || i.parties.seller?.property_address || '');
  const name = String(i.name || `${i.template.name} - ${address || i.parties.buyer?.name || 'contract'}`).slice(0, 200);
  const signers = i.signers.filter((s) => s.role).map((s, idx) => ({ ...s, sort: idx + 1 }));
  const tcs = await workspaceTcCopies(admin, i.ws);
  const active = appendTcCc(signers.filter((s) => !s.optional || s.name || s.email), tcs)
    .map((s, idx) => ({ ...s, sort: idx + 1 }));
  const now = new Date();
  const expires = i.expiresDays ? new Date(now.getTime() + i.expiresDays * 864e5).toISOString() : null;

  const notaryMode = i.notary?.needs ? (i.notary.mode ?? 'digital') : null;
  const notaryStatus = !i.notary?.needs ? 'none' : notaryMode === 'wet' ? 'wet' : notaryMode === 'vendor' ? 'vendor' : 'needed';
  const { data: row, error } = await admin.from('contracts').insert({
    workspace_id: i.ws, deal_id: i.parties.deal?.id ?? null, seller_id: i.parties.seller?.id ?? null, buyer_id: i.parties.buyer?.id ?? null, offer_id: i.ids.offerId ?? null,
    kind: i.template.kind, provider: 'clozr', template_id: i.template.id ? String(i.template.id) : null, template_key: i.template.key ?? null, template_name: i.template.name,
    ref_number: ref, signing_order_mode: i.orderMode === 'sequential' ? 'sequential' : 'parallel',
    ...(i.template.version != null ? { template_version: i.template.version } : {}),
    ...(i.reminders ? { reminder_policy: i.reminders } : {}),
    name, status: i.send ? 'sent' : 'draft', body_md: text, recipients: active.map((s) => ({ email: s.email ?? null, name: s.name ?? null, role: s.role })), tokens: toks,
    message: i.message ?? null, expires_at: expires, sent_at: i.send ? now.toISOString() : null, created_by: i.userId,
    needs_notary: !!i.notary?.needs, notary_mode: notaryMode, notary_status: notaryStatus, notary_vendor: i.notary?.vendor ?? null,
  }).select('*').single();
  if (error || !row) throw new Error(error?.message ?? 'could not save the contract');

  const { data: signerRows, error: sErr } = await admin.from('contract_signers').insert(active.map((s) => ({
    workspace_id: i.ws, contract_id: row.id, role: s.role, label: s.label ?? s.role, name: s.name ?? null, email: s.email?.trim().toLowerCase() || null, phone: s.phone ?? null, sort: s.sort,
    recipient_type: s.recipient_type && ['signer', 'cc', 'viewer', 'approver'].includes(s.recipient_type) ? s.recipient_type : 'signer',
  }))).select('*');
  if (sErr) throw new Error(sErr.message);

  const blocks = parse(text);
  const pdf = await toPdf(blocks, { title: name, company: i.company, contractId: row.id, signers: (signerRows ?? []).map((s) => ({ ...s, optional: signers.find((x) => x.role === s.role)?.optional })) });
  const hash = await sha256Hex(pdf);
  const path = await storePdf(admin, i.ws, row.id, 'unsigned.pdf', pdf);
  await admin.from('contracts').update({ pdf_path: path, sha256: hash }).eq('id', row.id);
  await logEvent(admin, row, i.send ? 'sent' : 'created', { provider: 'clozr', missing, signers: active.length, ref, order: row.signing_order_mode, sha256: hash }, { actor_type: 'user', actor_id: i.userId });
  if (i.send) await applySent(admin, row);
  if (i.send) publishContract(admin, row, 'contract.sent');

  const links = (signerRows ?? []).map((s) => ({ id: s.id, role: s.role, label: s.label, name: s.name, email: s.email, phone: s.phone, status: s.status, recipient_type: s.recipient_type, sort: s.sort, url: signUrl(i.origin, s.token) }));
  let emailed = 0;
  // Sequential: only the first turn (and viewers) now; the next signer is mailed when the one before signs. CC waits for the signed copy.
  if (i.send && i.email !== false) {
    const mailEnv = await signingResendEnv(admin, i.ws);
    emailed = await emailSigners(i.company, name, i.message ?? null, sendTo(links, row.signing_order_mode), { expiresAt: expires, cc: tcs.map((t) => t.email), contractId: row.id, env: mailEnv });
  }
  if (i.notary?.needs && (notaryMode === 'wet' || notaryMode === 'vendor' || i.send)) {
    try { await queueNotary(admin, { ...row, notary_mode: notaryMode, notary_vendor: i.notary.vendor ?? null }, i.origin); } catch (e) { console.error('notary', (e as Error).message); }
  }
  return { contract: { ...row, pdf_path: path, sha256: hash, needs_notary: !!i.notary?.needs, notary_mode: notaryMode, notary_status: notaryStatus }, signers: links, missing, emailed };
}

/** Everyone signed: stamp signatures, add the certificate, store, hash, move the pipeline. */
export async function completeContract(admin: SupabaseClient, row: Record<string, Any>, company: Company, origin = '') {
  const { data: signers } = await admin.from('contract_signers').select('*').eq('contract_id', row.id).order('sort');
  const blocks = parse(String(row.body_md ?? ''));
  // An uploaded PDF: the original pages with the values drawn on, then the same certificate.
  const pdf = row.mode === 'pdf'
    ? await (await import('./pdf-contracts.ts')).flattenPdfContract(admin, row, company, (signers ?? []) as SignerRow[])
    : await toPdf(blocks, { title: row.name, company, contractId: row.id, signers: (signers ?? []) as SignerRow[], certificate: true, hashOf: row.sha256 ?? undefined });
  // PandaDoc parity: the full audit trail rides on the executed PDF, after the certificate.
  let finalPdf = pdf;
  try {
    const { appendAuditTrail, loadAudit } = await import('./parity/certificate.ts');
    const { PDFDocument } = await import('npm:pdf-lib@1.17.1');
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    await appendAuditTrail(doc, { contract: row, signers: (signers ?? []) as Any[], events: await loadAudit(admin, row.id), company });
    finalPdf = await doc.save();
  } catch (e) { console.error('audit trail page', (e as Error).message); }
  const hash = await sha256Hex(finalPdf);
  const path = await storePdf(admin, row.workspace_id, row.id, 'signed.pdf', finalPdf);
  const now = new Date().toISOString();
  await admin.from('contracts').update({ status: 'completed', completed_at: now, pdf_path: path ?? row.pdf_path, sha256: hash, final_sha256: hash, last_event: { status: 'completed', source: 'esign', at: now } }).eq('id', row.id);
  await logEvent(admin, row, 'completed', { provider: 'clozr', sha256: hash, unsigned_sha256: row.sha256 ?? null });
  publishContract(admin, { ...row, status: 'completed' }, 'contract.completed');
  await applyCompletion(admin, row);
  try { await applySignedDeal(admin, row); } catch (e) { console.error('deal sheet', (e as Error).message); }
  try { await fileSignedPdf(admin, row, finalPdf); } catch (e) { console.error('deal file', (e as Error).message); }
  await logContractFeed(admin, row, `${row.name} signed by all parties`, `SHA-256 ${hash}`);
  kickExtraction(row.id);
  // Everyone who signed gets their copy. A failure here must not undo the
  // completion above — the contract is signed either way — so it is logged
  // and swallowed rather than thrown.
  let emailed = 0;
  try {
    emailed = await emailCompleted(admin, row, company, path ?? row.pdf_path ?? null, hash, origin || String(Deno.env.get('APP_URL') ?? ''));
  } catch (e) { console.error('completion mail', (e as Error).message); }
  return { path, hash, emailed };
}

// ------------------------------------------------------------------- offers
export type OfferSettings = { auto?: boolean; basis?: 'mao' | 'wholesale' | 'pct_arv'; pct?: number; round_to?: number; expires_days?: number; emd?: number; close_days?: number; send?: boolean; template_key?: string;
  /**
   * Which document goes out. The default is the built-in engine: it fills the
   * template from the record, renders the PDF and mints a signing link, which
   * is the whole point of Generate offer. 'pandadoc' is opt-in and only does
   * anything useful with a PANDADOC_API_KEY and a template id on file —
   * without both, it used to fall back to a packet of fields for someone to
   * paste by hand, which sent nobody anything.
   */
  engine?: 'clozr' | 'pandadoc'; pandadoc_template_id?: string; pandadoc_template_name?: string;
  /** Delivery when an offer is sent: email (default on) and a text with the signing link (browser, through Talkr). */
  email?: boolean; sms?: boolean };

/** The offer number from the underwriting, by the workspace's rule. */
export function priceOffer(deal: Party, s: OfferSettings): { amount: number | null; basis: string } {
  const basis = s.basis ?? 'mao';
  const roundTo = s.round_to && s.round_to > 0 ? s.round_to : 500;
  let raw: number | null = null;
  if (basis === 'pct_arv' && deal?.arv) raw = Number(deal.arv) * ((s.pct ?? 70) / 100) - Number(deal.rehab ?? 0);
  else if (basis === 'wholesale') raw = deal?.mao != null ? Number(deal.mao) : null;
  else raw = deal?.mao != null ? Number(deal.mao) : null;
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return { amount: null, basis };
  return { amount: Math.max(roundTo, Math.floor(raw / roundTo) * roundTo), basis };
}

/**
 * Generate an offer for a seller: the offers row (the trigger writes the
 * offer amount; a Sent row moves the seller and submission to Offer Made, a
 * Draft does not — sending the letter marks it Sent and that move happens
 * then), then the offer letter as a contract.
 */
export async function generateOffer(admin: SupabaseClient, p: {
  ws: number; sellerId: number; dealId?: number | null; userId: string | null; origin: string; amount?: number | null; basis?: string | null; send?: boolean; expiresDays?: number | null; message?: string | null;
}) {
  const { company, settings } = await loadCompany(admin, p.ws);
  const os = (settings.offers ?? {}) as OfferSettings;
  // The submission the offer was made on, when it is this seller's; else the seller's newest deal.
  let parties = await loadParties(admin, p.ws, { sellerId: p.sellerId, dealId: p.dealId ?? null });
  if (p.dealId && parties.deal && Number(parties.deal.seller_id) !== p.sellerId) parties = await loadParties(admin, p.ws, { sellerId: p.sellerId });
  if (!parties.seller) throw new Error('seller not found');
  let deal = parties.deal;
  if (!deal) {
    const { data } = await admin.from('deals').insert({ workspace_id: p.ws, seller_id: p.sellerId, property_id: parties.seller.property_id ?? null, stage: 'Prospect', owner_id: parties.seller.assigned_to ?? p.userId, created_by: p.userId, source: 'offer' }).select('*').single();
    deal = data;
  }
  const priced = priceOffer(deal, os);
  const amount = p.amount ?? priced.amount;
  if (amount == null) throw new Error('No number to offer from: run COMPR (or set ARV, rehab and MAO on the deal) first.');
  const expiresDays = p.expiresDays ?? os.expires_days ?? 3;
  const expires = new Date(Date.now() + expiresDays * 864e5).toISOString().slice(0, 10);
  const terms = { emd: os.emd ?? 500, close_days: os.close_days ?? 21 };
  const send = p.send ?? os.send ?? false;

  const { data: offer, error } = await admin.from('offers').insert({
    workspace_id: p.ws, deal_id: deal?.id ?? null, property_id: deal?.property_id ?? parties.seller.property_id ?? null, seller_id: p.sellerId,
    direction: 'outbound', amount, status: send ? 'Sent' : 'Draft', basis: p.basis ?? priced.basis, expires_on: expires, terms,
    notes: `${p.basis ?? priced.basis} · ARV ${money(deal?.arv)} · rehab ${money(deal?.rehab)} · MAO ${money(deal?.mao)}`, created_by: p.userId,
  }).select('*').single();
  if (error || !offer) throw new Error(error?.message ?? 'could not save the offer');
  if (!send) {
    const addr = str(parties.prop?.line1 || parties.seller.property_address || '');
    await pingTc(admin, p.ws, { title: 'Offer generated', body: `${money(amount)} · ${addr} — ready for the TC to send.`, sellerId: p.sellerId, dealId: deal?.id ?? null });
    await admin.from('activity').insert({ workspace_id: p.ws, entity_type: 'seller', entity_id: p.sellerId, kind: 'tc', title: 'Offer generated', body: `${money(amount)} · ${addr}`, actor_id: p.userId });
  }

  const email = os.email !== false;
  const name = `Cash Offer ${money(amount)} - ${parties.prop?.line1 || parties.seller.property_address || ''}`;
  let contract: { contract: Any; signers: Any[]; emailed: number } | null = null;
  let smsLink: string | null = null;
  let note: string | null = null;
  // The offer letter is filled and signed here unless the workspace has asked
  // for PandaDoc *and* PandaDoc can actually do the job — an API key on the
  // project. A packet of fields for someone to paste by hand is not a sent
  // offer, so it is no longer what "generate offer" falls back to.
  const pandaKey = !!(Deno.env.get('PANDADOC_API_KEY') ?? '').trim();
  const wantPanda = os.engine === 'pandadoc';
  if (wantPanda && pandaKey) {
    const osPd = await resolveOfferTemplate(os);
    if (osPd.pandadoc_template_id) {
      if (osPd.pandadoc_template_id !== os.pandadoc_template_id) {
        await admin.from('workspaces').update({
          settings: { ...settings, offers: { ...os, engine: 'pandadoc', pandadoc_template_id: osPd.pandadoc_template_id, pandadoc_template_name: osPd.pandadoc_template_name } },
        }).eq('id', p.ws);
      }
      const r = await pandadocOffer(admin, {
        ws: p.ws, userId: p.userId, os: osPd, name, send, email, sms: !!os.sms, expiresDays,
        message: p.message ?? null, offerId: offer.id, parties: { ...parties, deal, offer }, company,
      });
      contract = { contract: r.contract, signers: [], emailed: r.emailed };
      smsLink = r.link;
      note = r.note;
    }
  }
  if (!contract) {
    const { data: tpl } = await admin.from('doc_templates').select('*').eq('key', os.template_key ?? 'offer_letter').eq('active', true)
      .or(`workspace_id.eq.${p.ws},workspace_id.is.null`).order('workspace_id', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    if (tpl) {
      const roles = (tpl.signers as Any[]) ?? [];
      const signers = roles.map((r) => partySigner(r, { ...parties, company }));
      const c = await createContract(admin, {
        ws: p.ws, userId: p.userId, origin: p.origin, template: tpl, ids: { sellerId: p.sellerId, dealId: deal?.id ?? null, offerId: offer.id },
        signers, name, message: p.message ?? null, expiresDays, send, email,
        parties: { ...parties, deal, offer }, company,
      });
      contract = c;
      const sellerRole = roles.find((r) => r.party === 'seller')?.role;
      smsLink = c.signers.find((s) => s.role === sellerRole)?.url ?? null;
      // Getting here with PandaDoc selected means PandaDoc could not be
      // reached for it: no API key on the project, or no template resolved.
      // Say which, because they are fixed in different places.
      if (wantPanda) {
        note = pandaKey
          ? 'PandaDoc is selected but no template matched, so the offer letter went out on the built-in engine with a signing link. Set the template in Settings → Contracts and offers.'
          : 'PandaDoc is selected but has no API key on the project, so the offer letter went out on the built-in engine with a signing link.';
      }
    }
  }
  // Last resort: the workspace asked for PandaDoc and there is not even an
  // offer-letter template to fall back on. Write the field packet so the work
  // is not lost, and say plainly that nothing has been sent.
  if (!contract && wantPanda) {
    const { data: profile } = p.userId ? await admin.from('profiles').select('full_name, email, phone').eq('id', p.userId).maybeSingle() : { data: null };
    const toks = buildTokens({ ...parties, deal, offer }, company, { name: profile?.full_name, email: profile?.email, phone: profile?.phone });
    const recipients = [
      parties.seller.email ? { email: String(parties.seller.email).toLowerCase(), name: parties.seller.name, role: 'seller' } : null,
      company.email ? { email: String(company.email).toLowerCase(), name: company.signer || 'Acme Homes TC', role: 'company' } : null,
    ].filter(Boolean);
    const { data: row, error: cErr } = await admin.from('contracts').insert({
      workspace_id: p.ws, deal_id: deal?.id ?? null, seller_id: p.sellerId, offer_id: offer.id, kind: 'offer', provider: 'pandadoc',
      template_name: os.pandadoc_template_name ?? 'Acme Homes PandaDoc template', name, status: 'draft',
      recipients, tokens: toks, message: p.message ?? null, created_by: p.userId,
      last_event: { via: 'packet', clozr_offer_id: String(offer.id), clozr_workspace_id: String(p.ws), at: new Date().toISOString() },
    }).select('*').single();
    if (cErr || !row) throw new Error(cErr?.message ?? 'could not save the contract packet');
    await admin.from('contract_events').insert({ workspace_id: p.ws, contract_id: row.id, event: 'created', payload: { provider: 'pandadoc', via: 'packet' } });
    contract = { contract: row, signers: [], emailed: 0 };
    note = 'Copy the fields on the Contracts card into the Acme Homes PandaDoc template and send it. The webhook will attach the document here.';
  }
  if (contract) await admin.from('offers').update({ contract_id: contract.contract.id }).eq('id', offer.id);
  return {
    offer: { ...offer, contract_id: contract?.contract.id ?? null }, contract, amount, basis: p.basis ?? priced.basis, note,
    provider: (contract?.contract.provider ?? null) as string | null, delivery: { email, sms: !!os.sms }, sms_link: send ? smsLink : null,
    seller: { name: str(parties.seller.name), phone: (parties.seller.phone ?? null) as string | null, address: str(parties.prop?.line1 || parties.seller.property_address) },
  };
}

/** Resolve the Acme Homes PandaDoc template this workspace should fill. */
async function resolveOfferTemplate(os: OfferSettings): Promise<OfferSettings> {
  if (os.pandadoc_template_id) return os;
  const list = await pd<{ results: { id: string; name: string }[] }>('GET', '/templates?count=100').catch(() => ({ results: [] as { id: string; name: string }[] }));
  const picked = pickPandaDocTemplate(list.results ?? [], null);
  if (!picked) return os;
  return { ...os, engine: 'pandadoc', pandadoc_template_id: picked.id, pandadoc_template_name: picked.name };
}

/**
 * The offer as a PandaDoc document from the workspace's Acme Homes template.
 * Tokens are the same [Group.Name] set CLOZR fills. The seller and the
 * company/TC signer are recipients so Casey can open the draft, proof it,
 * and send. The pandadoc-webhook keeps the contract row current both ways.
 */
async function pandadocOffer(admin: SupabaseClient, p: {
  ws: number; userId: string | null; os: OfferSettings; name: string; send: boolean; email: boolean; sms: boolean; expiresDays: number; message: string | null;
  offerId: number; parties: Awaited<ReturnType<typeof loadParties>>; company: Company;
}): Promise<{ contract: Any; emailed: number; link: string | null; note: string | null }> {
  const seller = p.parties.seller!;
  const { data: profile } = p.userId ? await admin.from('profiles').select('full_name, email, phone').eq('id', p.userId).maybeSingle() : { data: null };
  const toks = buildTokens(p.parties, p.company, { name: profile?.full_name, email: profile?.email, phone: profile?.phone });
  const templateId = String(p.os.pandadoc_template_id);
  const details = await pd<{ roles?: { name: string }[] }>('GET', `/templates/${encodeURIComponent(templateId)}/details`);
  const roles = (details.roles ?? []).map((r) => r.name);
  const sellerRole = roles.find((r) => /seller|owner|client/i.test(r)) ?? roles[0];
  const companyRole = roles.find((r) => r !== sellerRole && /company|buyer|purchaser|sender|investor|agent|tc|coordinator/i.test(r))
    ?? roles.find((r) => r !== sellerRole);
  const person = (fullName: unknown, mail: unknown, role?: string) => {
    const [first, ...rest] = str(fullName).trim().split(/\s+/);
    return { email: str(mail).trim().toLowerCase(), first_name: first || undefined, last_name: rest.join(' ') || undefined, role };
  };
  const sellerEmail = str(seller.email).trim().toLowerCase();
  const companyEmail = str(p.company.email || profile?.email).trim().toLowerCase();
  const recipients = [];
  if (sellerEmail) recipients.push(person(seller.name, sellerEmail, sellerRole));
  if (companyRole && companyEmail && companyEmail !== sellerEmail) recipients.push(person(p.company.signer || profile?.full_name || 'Acme Homes TC', companyEmail, companyRole));
  if (!recipients.length && companyEmail) recipients.push(person(p.company.signer || profile?.full_name || 'Acme Homes TC', companyEmail, sellerRole));
  if (!recipients.length) throw new Error('PandaDoc needs an email on the seller or the company signer (Settings → Contracts) so the TC can open the draft.');

  let note: string | null = null;
  const canMailSeller = !!sellerEmail;
  if (!canMailSeller) note = 'Seller has no email — draft is in PandaDoc for the TC to add them, proof, and send.';
  // Don't blast a seller-less draft; the TC proofs it first.
  const send = p.send && canMailSeller;

  const { data: row, error } = await admin.from('contracts').insert({
    workspace_id: p.ws, deal_id: p.parties.deal?.id ?? null, seller_id: seller.id, offer_id: p.offerId, kind: 'offer', provider: 'pandadoc',
    template_id: templateId, template_name: p.os.pandadoc_template_name ?? null, name: p.name, status: 'draft', recipients, tokens: toks,
    message: p.message, expires_at: new Date(Date.now() + p.expiresDays * 864e5).toISOString(), created_by: p.userId,
  }).select('*').single();
  if (error || !row) throw new Error(error?.message ?? 'could not save the contract');
  try {
    const doc = await pd<{ id: string; status: string }>('POST', '/documents', {
      name: p.name, template_uuid: templateId, recipients, tokens: toks,
      metadata: { clozr_contract_id: String(row.id), clozr_workspace_id: String(p.ws), clozr_offer_id: String(p.offerId) },
      tags: ['clozr', 'offer', 'acme-homes'],
    });
    let cur = doc;
    for (let i = 0; i < 10 && pdStatus(cur.status) === 'uploaded'; i++) { await new Promise((r) => setTimeout(r, 1000 + i * 500)); cur = await pd('GET', `/documents/${doc.id}`); }
    const patch: Record<string, Any> = { pandadoc_id: doc.id, status: pdStatus(cur.status) };
    let link: string | null = null;
    if (send) {
      await pd('POST', `/documents/${doc.id}/send`, { subject: p.name, message: p.message ?? undefined, silent: !p.email });
      Object.assign(patch, { status: 'sent', sent_at: new Date().toISOString() });
      await applySent(admin, { ...row, ...patch });
      if (p.sms && sellerEmail) {
        const s = await pd<{ id: string }>('POST', `/documents/${doc.id}/session`, { recipient: sellerEmail, lifetime: Math.min(p.expiresDays * 86400, 604800) }).catch(() => null);
        link = s ? `https://app.pandadoc.com/s/${s.id}` : null;
      }
    } else if (p.send && !canMailSeller) {
      note = (note ?? '') + (note ? ' ' : '') + 'Offer recorded; open the PandaDoc draft to proof and send.';
    }
    await admin.from('contracts').update(patch).eq('id', row.id);
    await admin.from('contract_events').insert({ workspace_id: p.ws, contract_id: row.id, event: send ? 'sent' : 'created', payload: { provider: 'pandadoc', pandadoc_id: doc.id, emailed: send && p.email } });
    return { contract: { ...row, ...patch }, emailed: send && p.email ? recipients.filter((r) => r.email).length : 0, link, note };
  } catch (e) {
    await admin.from('contracts').update({ status: 'error', last_event: { error: String((e as Error).message).slice(0, 300) } }).eq('id', row.id);
    throw e;
  }
}

