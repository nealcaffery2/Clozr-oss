// Run COMPR on a property, on demand.
//
// Goes through the compr-underwrite edge function: the COMPR key is a project
// secret the browser never sees, and the result is written to the deal by the
// function so the numbers on screen are what COMPR returned, not what a
// client thought it returned.

import { supabase } from './supabase';
import { comprLeadIdOfDeal } from './compr-embed';
import { sendEmail } from './google';
import { type Recipient, type SendContext, fieldsFor, renderMerge, textOne } from './sms';

export type ReportAudience = 'seller' | 'buyer';

const DEFAULT_REPORT_BODY: Record<ReportAudience, string> = {
  seller: 'Hi {{first_name}}, here is the Compr report on {{address}} with the numbers behind our offer: {{report_link}}',
  buyer: 'Hi {{first_name}}, here is the Compr buyer report on {{address}}: {{report_link}}',
};

/**
 * The public Compr Seller or Compr Buyer report for a record. The function
 * shares the deal's saved Compr report, or underwrites the property first
 * when there is none (that run is billed like any other).
 */
export async function comprReportLink(workspaceId: number, sellerId: number, audience: ReportAudience): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('compr-underwrite', { body: { workspace_id: workspaceId, seller_id: sellerId, action: 'share', audience } });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as { url?: string | null; share_error?: string | null; error?: string };
  return r?.url ? { ok: true, url: r.url } : { ok: false, message: r?.share_error ?? r?.error ?? 'COMPR returned no report link.' };
}

/**
 * Send a Compr report link: the seller report to the seller, or the buyer
 * report to the deal's buyer, by text (Talkr, as the rep) or email (the rep's
 * Gmail), and note it on the timeline. A plan's compr_report task brings its
 * own audience, channel and message (`taskId`).
 */
export async function sendComprReport(workspaceId: number, sellerId: number, opts: {
  audience?: ReportAudience; via?: 'sms' | 'email'; body?: string | null; subject?: string | null; taskId?: number | null; ctx?: SendContext;
} = {}): Promise<{ ok: boolean; message: string; url?: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  let { audience = 'seller', via = 'sms', body, subject } = opts;
  if (opts.taskId) {
    const { data: task } = await supabase.from('tasks').select('notes, plan_step_id').eq('id', opts.taskId).maybeSingle();
    const { data: step } = task?.plan_step_id
      ? await supabase.from('action_plan_steps').select('config, subject').eq('id', task.plan_step_id).maybeSingle()
      : { data: null };
    const cfg = (step?.config ?? {}) as { audience?: string; via?: string };
    audience = cfg.audience === 'buyer' ? 'buyer' : 'seller';
    via = cfg.via === 'email' ? 'email' : 'sms';
    body = body ?? task?.notes;
    subject = subject ?? step?.subject;
  }

  const [link, { data: seller }] = await Promise.all([
    comprReportLink(workspaceId, sellerId, audience),
    supabase.from('sellers').select('name, phone, email, property_address, properties(line1, city, state, zip)').eq('id', sellerId).maybeSingle(),
  ]);
  if (!link.ok) return link;
  const url = link.url;
  const prop = (seller as unknown as { properties: { line1: string; city: string | null; state: string | null; zip: string | null } | null } | null)?.properties;
  const place = { address: prop?.line1 ?? seller?.property_address ?? '', city: prop?.city ?? '', state: prop?.state ?? '', zip: prop?.zip ?? '' };

  let to: { name: string; phone: string | null; email: string | null; buyerId: number | null } | null =
    seller ? { name: seller.name ?? '', phone: seller.phone, email: seller.email, buyerId: null } : null;
  if (audience === 'buyer') {
    const { data: deal } = await supabase.from('deals').select('buyer_id').eq('workspace_id', workspaceId).eq('seller_id', sellerId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const { data: buyer } = deal?.buyer_id ? await supabase.from('buyers').select('id, name, phone, email').eq('id', deal.buyer_id).maybeSingle() : { data: null };
    to = buyer ? { name: buyer.name ?? '', phone: buyer.phone, email: buyer.email, buyerId: buyer.id } : null;
  }
  if (!to) return { ok: false, message: `No buyer on the deal yet. The buyer report link: ${url}`, url };

  const template = (body || DEFAULT_REPORT_BODY[audience]);
  const withLink = /\{\{?\s*report_link\s*\}?\}/i.test(template) ? template.replace(/\{\{?\s*report_link\s*\}?\}/gi, url) : `${template} ${url}`;
  const recipient: Recipient = { sellerId: to.buyerId ? null : sellerId, name: to.name, phone: to.phone, email: to.email ?? undefined, ...place };

  let sent: { ok: boolean; message: string };
  if (via === 'email') {
    if (!to.email) return { ok: false, message: `${to.name || 'They'} have no email on file. The report link: ${url}`, url };
    const text = renderMerge(withLink, fieldsFor(recipient, opts.ctx ?? {}, to.phone ?? ''));
    const r = await sendEmail(workspaceId, {
      to: to.email, subject: subject || `Compr ${audience} report · ${place.address}`, body_text: text,
      seller_id: to.buyerId ? null : sellerId, buyer_id: to.buyerId,
    });
    sent = !r.ok ? { ok: false, message: r.message } : !r.data.connected ? { ok: false, message: 'Connect Gmail in Settings to email reports.' }
      : r.data.ok === false ? { ok: false, message: r.data.message ?? 'Gmail did not send it.' } : { ok: true, message: `emailed to ${to.email}` };
  } else {
    const r = await textOne(workspaceId, recipient, withLink, opts.ctx);
    sent = r.error ? { ok: false, message: r.error } : { ok: true, message: `texted to ${r.to}` };
  }
  if (!sent.ok) return { ok: false, message: `${sent.message} The report link: ${url}`, url };

  const title = `Compr ${audience} report ${sent.message}`;
  await supabase.from('activity').insert([
    { workspace_id: workspaceId, entity_type: 'seller', entity_id: sellerId, kind: 'compr', title, body: url },
    ...(to.buyerId ? [{ workspace_id: workspaceId, entity_type: 'buyer', entity_id: to.buyerId, kind: 'compr', title, body: url }] : []),
  ]);
  return { ok: true, message: title, url };
}

/**
 * Put COMPR's public buyer-facing assets on the deal: the buyer report
 * (View Full Deal), tokenized photo set + hero (money shot), and a buyer CMA
 * PDF (Comps & underwriting). No run and nothing billed.
 */
export async function syncComprMarketing(workspaceId: number, sellerId: number, dealId?: number): Promise<{
  ok: boolean; buyerReportUrl: string | null; photoUrl: string | null; cmaUrl: string | null;
}> {
  if (!supabase) return { ok: false, buyerReportUrl: null, photoUrl: null, cmaUrl: null };
  const { data, error } = await supabase.functions.invoke('compr-underwrite', {
    body: { workspace_id: workspaceId, seller_id: sellerId, deal_id: dealId, action: 'assets' },
  });
  if (error) return { ok: false, buyerReportUrl: null, photoUrl: null, cmaUrl: null };
  const r = data as { ok?: boolean; buyer_report_url?: string | null; photo_url?: string | null; hero_url?: string | null; cma_url?: string | null } | null;
  return {
    ok: !!r?.ok,
    buyerReportUrl: r?.buyer_report_url ?? null,
    photoUrl: r?.photo_url ?? r?.hero_url ?? null,
    cmaUrl: r?.cma_url ?? null,
  };
}

export type ComprResult =
  | {
      ok: true;
      arv: number | null; rehab: number | null; mao: number | null;
      wholesale: number | null; institutional: number | null;
      /** "complete" or "not_qualified". */
      status: string;
      /** 0–100, when COMPR gave one. */
      confidence: number | null;
      reportUrl: string | null;
      redFlags: { category?: string; severity?: string; description?: string }[];
      /** Set when the workspace auto-generates offers and this run produced one. */
      autoOffer: { amount: number; contractId: number | null } | null;
    }
  | { ok: false; message: string };

/**
 * Underwrite many leads, a few at a time. Each run is a real (billed) COMPR
 * call of up to a minute, so three run side by side and the rest queue.
 * Resolves with how many finished and the first error, if any.
 */
export async function runComprMany(
  workspaceId: number, sellerIds: (number | { sellerId: number; dealId: number })[], onProgress?: (done: number, total: number) => void, concurrency = 3,
): Promise<{ ok: number; failed: number; firstError: string | null }> {
  let next = 0; let ok = 0; let failed = 0; let firstError: string | null = null; let capped = false;
  const worker = async () => {
    while (next < sellerIds.length && !capped) {
      const t = sellerIds[next++];
      // A partner's submission names its deal: the run is that house's.
      const r = typeof t === 'number' ? await runCompr(workspaceId, t) : await runCompr(workspaceId, t.sellerId, t.dealId);
      if (r.ok) ok++;
      // The hourly per-rep ceiling (compr-underwrite) answers every later lead
      // the same way: stop there instead of failing the rest of the import one by one.
      else if (/too many requests/i.test(r.message)) capped = true;
      else { failed++; firstError ??= r.message; }
      onProgress?.(ok + failed, sellerIds.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sellerIds.length) }, worker));
  if (capped) {
    const left = sellerIds.length - ok - failed;
    failed += left;
    firstError = `hourly COMPR limit reached, ${left} not run yet (open the record and press Open in COMPR, or run them from People later)`;
  }
  return { ok, failed, firstError };
}

export async function runCompr(
  workspaceId: number, sellerId: number, dealId?: number | null, opts?: { refreshLead?: string | null },
): Promise<ComprResult> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('compr-underwrite', {
    // deal_id: a partner's submission, so the run is that house and the numbers land on its deal.
    // refresh_lead: re-run that report in place (same link) with every photo on the record.
    body: {
      workspace_id: workspaceId, seller_id: sellerId, ...(dealId != null ? { deal_id: dealId } : {}),
      ...(opts?.refreshLead ? { refresh_lead: opts.refreshLead } : {}),
    },
  });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) message = ((await ctx.json()) as { error?: string }).error ?? message;
    } catch { /* keep the transport message */ }
    return { ok: false, message };
  }
  const r = data as {
    ok?: boolean; arv?: number | null; rehab?: number | null; mao?: number | null;
    wholesale?: number | null; institutional?: number | null; status?: string;
    confidence?: number | null; report_url?: string | null;
    red_flags?: { category?: string; severity?: string; description?: string }[]; error?: string;
    auto_offer?: { amount: number; contract_id: number | null } | null;
  };
  if (!r?.ok) return { ok: false, message: r?.error ?? 'COMPR returned nothing.' };
  return {
    ok: true,
    arv: r.arv ?? null, rehab: r.rehab ?? null, mao: r.mao ?? null,
    wholesale: r.wholesale ?? null, institutional: r.institutional ?? null,
    status: r.status ?? 'complete', confidence: r.confidence ?? null,
    reportUrl: r.report_url ?? null, redFlags: r.red_flags ?? [],
    autoOffer: r.auto_offer ? { amount: r.auto_offer.amount, contractId: r.auto_offer.contract_id ?? null } : null,
  };
}

/** The COMPR lead a deal links to right now, read fresh: a run that landed after this page loaded. */
export async function comprLeadOfDealNow(dealId: number): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('deals').select('underwriting_url, compr_report_url').eq('id', dealId).maybeSingle();
  const row = data as { underwriting_url: string | null; compr_report_url: string | null } | null;
  return row ? comprLeadIdOfDeal({ underwritingUrl: row.underwriting_url, comprReportUrl: row.compr_report_url }) : null;
}

export type ComprPull =
  | {
      ok: true;
      /** The deal's numbers moved to match COMPR. */
      changed: boolean;
      /** The deal points at a COMPR report at all. */
      linked: boolean;
      leadId: string | null;
      arv: number | null; rehab: number | null; mao: number | null;
      low: number | null; high: number | null; lowSet: boolean; highSet: boolean;
      /** Photos on the record COMPR would be sent, and the report's own album. */
      ownPhotos: number; reportPhotos: number | null;
      /** The report was graded without most of the record's photos: re-run it with them. */
      photosMissing: boolean;
    }
  | { ok: false; message: string };

/**
 * What the deal's COMPR report shows now, onto the deal: the ARV, rehab and
 * offer after any edit saved in COMPR, with the low and high that follow
 * (unless a person set them). No run, nothing billed. `check` writes nothing
 * and only says whether the report is missing the record's photos.
 */
export async function pullCompr(workspaceId: number, dealId: number, check = false): Promise<ComprPull> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('compr-underwrite', {
    body: { workspace_id: workspaceId, deal_id: dealId, action: 'pull', ...(check ? { check: true } : {}) },
  });
  if (error) return { ok: false, message: error.message };
  const r = data as {
    ok?: boolean; changed?: boolean; linked?: boolean; lead_id?: string | null; error?: string;
    arv?: number | null; rehab?: number | null; mao?: number | null; low?: number | null; high?: number | null;
    low_set?: boolean; high_set?: boolean;
    own_photos?: number; report_photos?: number | null; photos_missing?: boolean;
  } | null;
  if (!r?.ok) return { ok: false, message: r?.error ?? 'COMPR returned nothing.' };
  return {
    ok: true, changed: !!r.changed, linked: !!r.linked, leadId: r.lead_id ?? null,
    arv: r.arv ?? null, rehab: r.rehab ?? null, mao: r.mao ?? null,
    low: r.low ?? null, high: r.high ?? null, lowSet: !!r.low_set, highSet: !!r.high_set,
    ownPhotos: Number(r.own_photos ?? 0) || 0, reportPhotos: r.report_photos ?? null, photosMissing: !!r.photos_missing,
  };
}
