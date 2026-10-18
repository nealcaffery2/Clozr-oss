/**
 * POST /contracts — CLOZR's own contract engine (no vendor key needed).
 *
 * Body: { workspace_id, action, origin, ... }   origin = the app's URL, for signing links
 *   render  { template_id, seller_id?, deal_id?, buyer_id?, tokens? }   → { html, tokens, missing, signers }
 *   create  { template_id, seller_id?, deal_id?, buyer_id?, signers: [{ role, name, email, phone }], tokens?, name?, message?, expires_days?, send? }
 *           → { contract, signers: [{ role, name, email, url }], missing, emailed }
 *   send    { contract_id, message? }                → { contract, signers, emailed }
 *   links   { contract_id }                          → { signers: [{ ..., url }] }
 *   remind  { contract_id }                          → { emailed }
 *   pdf     { contract_id }                          → { url }  (signed URL to the current PDF)
 *   void    { contract_id }
 *   fields  { seller_id?, deal_id?, buyer_id? }      → { tokens, packet }  (copy-paste for PandaDoc)
 *   packet  { kind, seller_id?, deal_id?, buyer_id?, recipients?, name?, message? }
 *           → { contract, tokens, packet }  (no PandaDoc API; webhook attaches the sent doc)
 *
 * Template library (migration 115; writes need owner or admin, except contract folders):
 *   library            {}                                     → { templates, folders, contract_folders, blocks, can_edit }
 *   template_versions  { template_id }                        → { versions }  (the family, newest first, each with `used`)
 *   template_save      { template_id?, name, kind, body_md, signers, folder_id?, default_expiry_days?, reminder_policy?, default_signing_order? }
 *                      → { template, versioned }   (a used template becomes version + 1 instead of changing)
 *   restore_version    { template_id }                        → { template }  (that old version's text as the new latest)
 *   template_duplicate { template_id }                        → { template }
 *   template_archive   { template_id, archived }              → { template }
 *   template_move      { template_id, folder_id|null }        → { template }
 *   folders            { op: list|create|rename|move|delete, scope: templates|contracts, id?, name?, parent_id? } → { folders }
 *   blocks             { op: save|delete|starter, block?: { id?, name, body, tags, locked }, id? } → { blocks }
 *   contract_folder    { contract_id, folder_id|null }        → { contract }
 * People flows (migration 114, _shared/docs-flow.ts). Each signer in create may carry
 * { delivery: email|sms|both, seller_id, buyer_id, vendor_id, user_id }; extras may be approvers.
 *   recipients      { contract_id }  → { recipients: [{ ..., delivery, seller_id, buyer_id, url }] }
 *   approve         { contract_id, decision: approve|reject, reason?, signer_id? }  → { approved, sent, status }
 *   add_recipient   { contract_id, recipient: { name, email, phone, recipient_type, delivery, position, seller_id?, buyer_id?, vendor_id?, user_id? } }
 *                   → { recipient, emailed, texted, failed }
 *   update_recipient { contract_id, signer_id, name?, email?, phone?, delivery?, resend? }
 *                   → { recipient, changed, emailed, texted, failed, crm: { seller_id, buyer_id, vendor_id } }
 * Uploaded PDFs with fields placed on them (_shared/pdf-contracts.ts):
 *   create_pdf       { template_id? | source_path?, kind?, name?, seller_id?, deal_id?, buyer_id?,
 *                      signers: [{ role, label?, name, email, phone, recipient_type? }], message?, expires_days?,
 *                      send?, order_mode?, reminders?, notary? }
 *                    → { contract, signers, emailed, pages, fields, skipped, missing }
 *                    template_id: a PDF template (its roles and fields); source_path: a doc-sources upload (one-off).
 *   pdf_fields       { contract_id }                    → { fields, signers, source_url }   (editor)
 *   pdf_fields_save  { contract_id, fields: [...] }     → { fields, missing }               (drafts only)
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { ALLOW_HEADERS } from '../_shared/security.ts';
import { type Any, buildTokens, createContract, emailSigners, ensureTcCc, fill, loadCompany, loadParties, logEvent, parse, partySigner, queueNotary, signUrl, signingSender, toHtml, tokensIn, varsFor, varsIn } from '../_shared/docs.ts';
import { needsApproval, pendingApprovals, sendTo, turn } from '../_shared/signing-order.ts';
import { signingResendEnv } from '../_shared/workspace-email.ts';
import { publishContract } from '../_shared/contract-webhooks.ts';
import { withBlocks } from '../_shared/docs.ts';
import { defaultFormat } from '../_shared/doc-vars.ts';
import { STARTER_BLOCKS, blocksIn } from '../_shared/doc-blocks.ts';
import { baseKey, familyOf, folderAndBelow, keyFor, latestByKey, nextVersion, saveMode, supersededKey } from '../_shared/doc-library.ts';
import { addRecipient, deliverLinks, dispatchSend, loadRecipients, publicRecipient, recordApproval, updateRecipient } from '../_shared/docs-flow.ts';
import { approvalDecision, contactChanges, normalizeDelivery } from '../_shared/docs-people.ts';
import { createPdfContract, draftFields, saveDraftFields } from '../_shared/pdf-contracts.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': ALLOW_HEADERS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('authorization') ?? '' } }, auth: { persistSession: false } });
  const { data: who } = await asCaller.auth.getUser();
  if (!who?.user) return json({ error: 'sign in first' }, 401);
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  let b: Any;
  try { b = await req.json(); } catch { return json({ error: 'body is not valid JSON' }, 400); }
  const ws = Number(b.workspace_id);
  if (!Number.isFinite(ws)) return json({ error: 'workspace_id is required' }, 422);
  const { data: member } = await asCaller.from('workspace_members').select('role').eq('workspace_id', ws).eq('user_id', who.user.id).maybeSingle();
  if (!member) return json({ error: 'not a member of that workspace' }, 403);
  // Every member may look (folders, the library, a contract's PDF and
  // recipients); sending and editing stay with the roles that run deals.
  const READ_ACTIONS = new Set(['folders', 'library', 'blocks', 'template_versions', 'pdf', 'recipients', 'fields', 'pdf_fields', 'template', 'templates']);
  if (!READ_ACTIONS.has(String(b.action ?? '')) && !['owner', 'admin', 'acquisitions', 'dispositions', 'tc'].includes(member.role)) return json({ error: 'your role cannot send contracts' }, 403);
  const origin = String(b.origin || req.headers.get('origin') || Deno.env.get('APP_URL') || 'https://your-clozr-site.example.com');

  const loadContract = async (id: number) => (await asCaller.from('contracts').select('*').eq('id', id).eq('workspace_id', ws).maybeSingle()).data as Record<string, Any> | null;
  const loadTemplate = async (id: number) => (await asCaller.from('doc_templates').select('*').eq('id', id).maybeSingle()).data as Record<string, Any> | null;
  const signerLinks = async (contractId: number) => {
    const { data } = await admin.from('contract_signers').select('id, role, label, name, email, phone, status, viewed_at, signed_at, view_seconds, token, sort, recipient_type, reminder_count, last_reminded_at').eq('contract_id', contractId).neq('status', 'delegated').order('sort');
    return (data ?? []).map((s) => ({ id: s.id, role: s.role, label: s.label, name: s.name, email: s.email, phone: s.phone, status: s.status, viewed_at: s.viewed_at, signed_at: s.signed_at, view_seconds: s.view_seconds, sort: s.sort, recipient_type: s.recipient_type, reminder_count: s.reminder_count, last_reminded_at: s.last_reminded_at, url: signUrl(origin, s.token) }));
  };

  // ---------------------------------------------------------------- template library (115)
  const canEditLibrary = ['owner', 'admin'].includes(member.role);
  const KINDS = new Set(['psa', 'assignment', 'amendment', 'termination', 'option', 'novation', 'jv', 'disclosure', 'addendum', 'offer', 'other']);
  const clampInt = (v: Any, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
  /** Built-ins plus this workspace's rows; other workspaces never leak in through the service client. */
  const visibleTemplates = async () => ((await admin.from('doc_templates').select('*').or(`workspace_id.is.null,workspace_id.eq.${ws}`).limit(5000)).data ?? []) as Record<string, Any>[];
  const templateRow = async (id: number) => {
    const { data } = await admin.from('doc_templates').select('*').eq('id', id).maybeSingle();
    return data && (data.workspace_id == null || Number(data.workspace_id) === ws) ? data as Record<string, Any> : null;
  };
  /** Contracts made from each template row, in this workspace. */
  const usage = async () => {
    const { data } = await admin.from('contracts').select('template_id').eq('workspace_id', ws).eq('provider', 'clozr').not('template_id', 'is', null).limit(20000);
    const m = new Map<number, number>();
    for (const r of data ?? []) { const id = Number(r.template_id); if (Number.isFinite(id)) m.set(id, (m.get(id) ?? 0) + 1); }
    return m;
  };
  const familyRows = async (root: number) => ((await admin.from('doc_templates').select('*').or(`id.eq.${root},parent_id.eq.${root}`)).data ?? [])
    .filter((r) => r.workspace_id == null || Number(r.workspace_id) === ws) as Record<string, Any>[];
  const folderOk = async (id: Any, scope: 'templates' | 'contracts') => {
    if (id == null || id === '') return true;
    const { data } = await admin.from('doc_folders').select('id').eq('id', Number(id)).eq('workspace_id', ws).eq('scope', scope).maybeSingle();
    return !!data;
  };
  /** The editable fields a caller sent, cleaned. Only keys present are returned. */
  const templateFields = (x: Any): Record<string, Any> => {
    const out: Record<string, Any> = {};
    if (x.name != null) out.name = String(x.name).trim().slice(0, 200) || 'Untitled template';
    if (x.kind != null) out.kind = KINDS.has(String(x.kind)) ? String(x.kind) : 'other';
    if (x.body_md != null) out.body_md = String(x.body_md);
    if (x.signers != null) {
      if (!Array.isArray(x.signers)) throw new Error('signers must be a list of { role, label, party }');
      out.signers = x.signers.filter((r: Any) => r && r.role).map((r: Any) => ({ role: String(r.role), label: String(r.label ?? r.role), party: String(r.party ?? 'company'), ...(r.optional ? { optional: true } : {}) }));
    }
    if ('folder_id' in x) out.folder_id = x.folder_id ? Number(x.folder_id) : null;
    if ('default_expiry_days' in x) out.default_expiry_days = x.default_expiry_days ? clampInt(x.default_expiry_days, 1, 365) : null;
    if ('reminder_policy' in x) out.reminder_policy = x.reminder_policy && typeof x.reminder_policy === 'object'
      ? { first_after_days: clampInt(x.reminder_policy.first_after_days ?? 1, 0, 30), repeat_every_days: clampInt(x.reminder_policy.repeat_every_days ?? 2, 0, 30) }
      : null;
    if ('default_signing_order' in x) out.default_signing_order = ['parallel', 'sequential'].includes(x.default_signing_order) ? x.default_signing_order : null;
    return out;
  };
  const CARRY = ['name', 'kind', 'body_md', 'signers', 'sort', 'folder_id', 'default_expiry_days', 'reminder_policy', 'default_signing_order'];
  /**
   * Save an edit to `cur`: in place when nothing was made from it, otherwise
   * as the family's next version (see _shared/doc-library.ts). `force` always
   * makes a new version (restore, or hiding / filing a built-in).
   */
  const saveTemplate = async (cur: Record<string, Any>, fields: Record<string, Any>, force = false, extra: Record<string, Any> = {}) => {
    const used = (await usage()).get(Number(cur.id)) ?? 0;
    const mode = force ? 'new_version' : saveMode(cur as Any, ws, used);
    if (mode === 'update') {
      const { data, error } = await admin.from('doc_templates').update({ ...fields, ...extra }).eq('id', cur.id).select('*').single();
      if (error || !data) throw new Error(error?.message ?? 'could not save the template');
      return { template: data, versioned: false };
    }
    const root = familyOf(cur as Any);
    const fam = await familyRows(root);
    const current = fam.find((r) => Number(r.workspace_id) === ws && !r.superseded_at) ?? null;
    const from = current ?? cur;
    const key = baseKey(String(from.key));
    const row: Record<string, Any> = { workspace_id: ws, key, active: true, archived_at: null, version: nextVersion(fam), parent_id: root, created_by: who.user.id, superseded_at: null };
    for (const k of CARRY) row[k] = from[k] ?? null;
    if (row.sort == null) row.sort = 100;
    Object.assign(row, fields, extra);
    const now = new Date().toISOString();
    // Park the current version first: the (workspace, key) index allows one.
    if (current) {
      const { error } = await admin.from('doc_templates').update({ key: supersededKey(key, Number(current.version ?? 1)), superseded_at: now, active: false }).eq('id', current.id);
      if (error) throw new Error(error.message);
    }
    const { data, error } = await admin.from('doc_templates').insert(row).select('*').single();
    if (error || !data) {
      if (current) await admin.from('doc_templates').update({ key: current.key, superseded_at: null, active: current.active }).eq('id', current.id);
      throw new Error(error?.message ?? 'could not save the new version');
    }
    return { template: data, versioned: true };
  };
  const listFolders = async (scope?: string) => {
    let q = admin.from('doc_folders').select('id, scope, name, parent_id, sort').eq('workspace_id', ws);
    if (scope) q = q.eq('scope', scope);
    return (await q.order('sort').order('name')).data ?? [];
  };
  const listBlocks = async () => (await admin.from('doc_content_blocks').select('id, name, body, tags, locked, created_by, updated_at').eq('workspace_id', ws).order('name')).data ?? [];
  const needAdmin = () => (canEditLibrary ? null : json({ error: 'Only an owner or admin can change templates and sections.' }, 403));
  const actor = { actor_type: 'user' as const, actor_id: who.user.id };
  /** CRM ids a recipient links to, kept only when they are in this workspace. */
  const crmIds = async (xs: Any[]) => {
    const pick = (k: string) => [...new Set(xs.map((x) => Number(x?.[k])).filter((n) => Number.isFinite(n) && n > 0))];
    const ok = { seller: new Set<number>(), buyer: new Set<number>(), vendor: new Set<number>(), user: new Set<string>() };
    const s = pick('seller_id'), bu = pick('buyer_id'), v = pick('vendor_id');
    if (s.length) for (const r of (await asCaller.from('sellers').select('id').eq('workspace_id', ws).in('id', s)).data ?? []) ok.seller.add(r.id);
    if (bu.length) for (const r of (await asCaller.from('buyers').select('id').eq('workspace_id', ws).in('id', bu)).data ?? []) ok.buyer.add(r.id);
    if (v.length) for (const r of (await asCaller.from('vendors').select('id').eq('workspace_id', ws).in('id', v)).data ?? []) ok.vendor.add(r.id);
    const u = [...new Set(xs.map((x) => x?.user_id).filter((x): x is string => typeof x === 'string' && !!x))];
    if (u.length) for (const r of (await admin.from('workspace_members').select('user_id').eq('workspace_id', ws).in('user_id', u)).data ?? []) ok.user.add(r.user_id);
    return (x: Any) => ({
      seller_id: ok.seller.has(Number(x?.seller_id)) ? Number(x.seller_id) : null,
      buyer_id: ok.buyer.has(Number(x?.buyer_id)) ? Number(x.buyer_id) : null,
      vendor_id: ok.vendor.has(Number(x?.vendor_id)) ? Number(x.vendor_id) : null,
      user_id: ok.user.has(String(x?.user_id)) ? String(x.user_id) : null,
    });
  };

  try {
    switch (b.action) {
      case 'render': {
        const tpl = await loadTemplate(Number(b.template_id));
        if (!tpl) return json({ error: 'template not found' }, 404);
        const { company } = await loadCompany(asCaller, ws);
        const parties = await loadParties(asCaller, ws, { sellerId: b.seller_id, dealId: b.deal_id, buyerId: b.buyer_id, offerId: b.offer_id });
        const { data: profile } = await asCaller.from('profiles').select('full_name, email, phone').eq('id', who.user.id).maybeSingle();
        const auto = buildTokens(parties, company, { name: profile?.full_name, email: profile?.email, phone: profile?.phone });
        const overrides = new Map<string, string>((Array.isArray(b.tokens) ? b.tokens : []).filter((t: Any) => t?.name).map((t: Any) => [String(t.name), String(t.value ?? '')]));
        const toks = [...auto.filter((t) => !overrides.has(t.name)), ...Array.from(overrides, ([name, value]) => ({ name, value }))].filter((t) => t.value !== '');
        // Reusable sections go in first, so their variables are asked for too.
        const sections = await withBlocks(asCaller, ws, String(tpl.body_md));
        const { text, missing } = fill(sections.text, toks, varsFor(parties, company));
        // `party` (migration 114): which record a role is filled from, so the app can link it and skip the company's own signer.
        const signers = ((tpl.signers as Any[]) ?? []).map((r) => ({ ...partySigner(r, { ...parties, company }), party: r.party ?? null }));
        if (tpl.mode === 'pdf') {
          // A PDF template has no text to scan: its quick-fill list is the record variables its
          // fields are bound to, in page order, each with what the record says now. A typed value
          // goes back as a token under the same name and wins over the record (create_pdf).
          const { data: tf } = await asCaller.from('doc_template_fields').select('variable_key').eq('template_id', tpl.id).not('variable_key', 'is', null).order('page').order('sort');
          const keys = [...new Set(((tf ?? []) as Any[]).map((f) => String(f.variable_key)))];
          const vars = varsFor(parties, company);
          const found = keys.flatMap((k) => {
            const v = overrides.get(k) ?? (vars[k] ? defaultFormat(vars[k]) : '');
            return v ? [{ name: k, value: v }] : [];
          });
          return json({
            html: '', tokens: found, used: keys, missing: keys.filter((k) => !found.some((t) => t.name === k)), signers,
            sections: [], missing_sections: [],
            deal_id: parties.deal?.id ?? null, seller_id: parties.seller?.id ?? null, buyer_id: parties.buyer?.id ?? null,
          });
        }
        return json({
          html: toHtml(parse(text), signers.map((s) => ({ ...s, status: 'pending' }))),
          tokens: toks, used: [...tokensIn(sections.text), ...varsIn(sections.text)], missing, signers,
          sections: sections.used, missing_sections: sections.missing,
          deal_id: parties.deal?.id ?? null, seller_id: parties.seller?.id ?? null, buyer_id: parties.buyer?.id ?? null,
        });
      }
      case 'create': {
        const tpl = await loadTemplate(Number(b.template_id));
        if (!tpl) return json({ error: 'template not found' }, 404);
        const { company } = await loadCompany(asCaller, ws);
        const parties = await loadParties(asCaller, ws, { sellerId: b.seller_id, dealId: b.deal_id, buyerId: b.buyer_id, offerId: b.offer_id });
        if (!parties.seller && !parties.deal && !parties.buyer) return json({ error: 'seller, buyer, or deal not found' }, 404);
        const { data: profile } = await asCaller.from('profiles').select('full_name, email, phone').eq('id', who.user.id).maybeSingle();
        const roles = (tpl.signers as Any[]) ?? [];
        const given: Any[] = Array.isArray(b.signers) ? b.signers : [];
        const signers = roles.map((r) => {
          const g = given.find((x) => x?.role === r.role);
          const base = partySigner(r, { ...parties, company });
          // A role the template marks CC (the TC) stays CC unless the form says otherwise.
          return g ? { ...base, name: g.name ?? base.name, email: g.email ?? base.email, phone: g.phone ?? base.phone, recipient_type: g.recipient_type ?? r.recipient_type ?? null } : base;
        });
        // Extra recipients the sender added (a CC for the TC, a viewer for the lender), after the template's roles.
        for (const [k, x] of given.filter((x) => x?.extra && (x.email || x.name)).entries()) {
          // A signer needs a signature block in the template, so extras are copied (cc) or read-only (viewer).
          // An approver signs off in the app or on their link, so needs no signature block either (migration 114).
          const kind = x.recipient_type === 'viewer' ? 'viewer' : x.recipient_type === 'approver' ? 'approver' : 'cc';
          signers.push({ role: `extra${k + 1}`, label: String(x.label || (kind === 'cc' ? 'CC' : kind === 'approver' ? 'Approver' : 'Viewer')), optional: false, name: x.name ?? null, email: x.email ?? null, phone: x.phone ?? null, recipient_type: kind } as Any);
        }
        // Migration 114: how each is reached and which CRM record each is, by role.
        const meta = new Map<string, Any>();
        for (const r of roles) { const g = given.find((x) => x?.role === r.role); if (g) meta.set(r.role, g); }
        for (const [k, x] of given.filter((x) => x?.extra && (x.email || x.name)).entries()) meta.set(`extra${k + 1}`, x);
        const linkOf = await crmIds([...meta.values()]);
        // Approvers go first and texts go by Talkr, so those sends run through docs-flow after the rows exist.
        const viaFlow = !!b.send && (signers.some((x: Any) => x.recipient_type === 'approver') || [...meta.values()].some((g) => normalizeDelivery(g.delivery) !== 'email'));
        if (!signers.some((s: Any) => !s.optional && !['cc', 'viewer', 'approver'].includes(String(s.recipient_type ?? 'signer')) && (s.email || s.name))) return json({ error: 'at least one signer needs a name or email' }, 422);
        const out = await createContract(admin, {
          ws, userId: who.user.id, origin, template: tpl as Any, ids: { sellerId: parties.seller?.id, dealId: parties.deal?.id, buyerId: parties.buyer?.id, offerId: b.offer_id ?? null },
          signers, tokens: Array.isArray(b.tokens) ? b.tokens : [], name: b.name ?? null, message: b.message ?? null, expiresDays: b.expires_days ?? tpl.default_expiry_days ?? 14, send: !!b.send && !viaFlow,
          notary: b.notary ?? null,
          // The form sends what the person chose; the template's defaults cover a caller that did not.
          orderMode: (b.order_mode ?? tpl.default_signing_order) === 'sequential' ? 'sequential' : 'parallel',
          reminders: !b.reminders && tpl.reminder_policy && typeof tpl.reminder_policy === 'object' ? tpl.reminder_policy : b.reminders && typeof b.reminders === 'object' ? {
            first_after_days: Math.max(0, Math.min(30, Number(b.reminders.first_after_days ?? 1))),
            repeat_every_days: Math.max(0, Math.min(30, Number(b.reminders.repeat_every_days ?? 2))),
          } : null,
          parties, company, profile,
        });
        for (const s of out.signers) {
          const g = meta.get(s.role);
          if (!g) continue;
          const link = linkOf(g);
          const patch = { delivery: normalizeDelivery(g.delivery), ...Object.fromEntries(Object.entries(link).filter(([, v]) => v !== null)) };
          if (patch.delivery !== 'email' || Object.keys(patch).length > 1) await admin.from('contract_signers').update(patch).eq('id', s.id);
        }
        if (viaFlow) {
          const d = await dispatchSend(admin, out.contract, { company, origin, who: actor, senderId: who.user.id }, b.message ?? null);
          const { data: fresh } = await admin.from('contracts').select('*').eq('id', out.contract.id).single();
          if (d.status === 'sent' && b.notary?.needs && fresh) {
            try { await queueNotary(admin, fresh, origin); } catch (e) { console.error('notary', (e as Error).message); }
          }
          Object.assign(out, { contract: fresh ?? out.contract, emailed: d.emailed, texted: d.texted, failed: d.failed, awaiting_approval: d.status === 'awaiting_approval' });
        }
        const actTitle = `${out.contract.name} ${b.send ? 'sent for signature' : 'drafted'}`;
        const actBody = out.signers.map((s) => `${s.label}: ${s.name ?? s.email ?? '—'}`).join('\n');
        const activity = [
          parties.seller?.id ? { entity_type: 'seller', entity_id: parties.seller.id } : null,
          parties.buyer?.id ? { entity_type: 'buyer', entity_id: parties.buyer.id } : null,
          parties.deal?.id ? { entity_type: 'deal', entity_id: parties.deal.id } : null,
        ].filter((r): r is { entity_type: string; entity_id: number } => !!r)
          .map((r) => ({ workspace_id: ws, ...r, kind: 'contract', title: actTitle, body: actBody, actor_id: who.user.id }));
        if (activity.length) await admin.from('activity').insert(activity);
        return json(out);
      }
      case 'send': {
        const row = await loadContract(Number(b.contract_id));
        if (!row || row.provider !== 'clozr') return json({ error: 'contract not found' }, 404);
        if (['completed', 'voided'].includes(row.status)) return json({ error: `this contract is already ${row.status}` }, 409);
        // Migration 114: approvers sign off first, and some recipients get their link by text.
        const people = await loadRecipients(admin, row.id);
        if (needsApproval(people) || people.some((s) => normalizeDelivery(s.delivery) !== 'email')) {
          const { company } = await loadCompany(asCaller, ws);
          const d = await dispatchSend(admin, row, { company, origin, who: actor, senderId: who.user.id }, b.message ?? null);
          const { data: fresh } = await admin.from('contracts').select('*').eq('id', row.id).single();
          return json({ contract: fresh ?? row, signers: await signerLinks(row.id), emailed: d.emailed, texted: d.texted, failed: d.failed, awaiting_approval: d.status === 'awaiting_approval' });
        }
        const now = new Date().toISOString();
        await admin.from('contracts').update({ status: 'sent', sent_at: row.sent_at ?? now, message: b.message ?? row.message, last_event: { status: 'sent', source: 'send', at: now } }).eq('id', row.id);
        await logEvent(admin, row, 'sent', { source: 'send' }, { actor_type: 'user', actor_id: who.user.id });
        publishContract(admin, row, 'contract.sent');
        const { applySent } = await import('../_shared/docs.ts');
        await applySent(admin, row);
        const cc = await ensureTcCc(admin, row);
        const signers = await signerLinks(row.id);
        const { company } = await loadCompany(asCaller, ws);
        const mailEnv = await signingResendEnv(admin, ws);
        const sender = await signingSender(admin, who.user.id);
        const emailed = await emailSigners(company, row.name, b.message ?? row.message ?? null, sendTo(signers, row.signing_order_mode), { expiresAt: row.expires_at, cc, contractId: row.id, env: mailEnv, sender });
        return json({ contract: { ...row, status: 'sent', sent_at: row.sent_at ?? now }, signers, emailed });
      }
      case 'links': {
        const row = await loadContract(Number(b.contract_id));
        if (!row || row.provider !== 'clozr') return json({ error: 'contract not found' }, 404);
        return json({ signers: await signerLinks(row.id) });
      }
      case 'remind': {
        const row = await loadContract(Number(b.contract_id));
        if (!row || row.provider !== 'clozr') return json({ error: 'contract not found' }, 404);
        // Migration 114: waiting on approvers, or recipients reached by text.
        const people = await loadRecipients(admin, row.id);
        if (row.status === 'awaiting_approval' || people.some((s) => normalizeDelivery(s.delivery) !== 'email')) {
          const up = row.status === 'awaiting_approval' ? pendingApprovals(people) : turn(people, row.signing_order_mode);
          const { company } = await loadCompany(asCaller, ws);
          const d = await deliverLinks(admin, row, up, { company, origin, who: actor, senderId: who.user.id }, { reminder: true, approve: row.status === 'awaiting_approval' });
          const now = new Date().toISOString();
          for (const s of up) await admin.from('contract_signers').update({ last_reminded_at: now, reminder_count: Number(s.reminder_count ?? 0) + 1 }).eq('id', s.id);
          await logEvent(admin, row, 'reminded', { to: up.map((s) => s.label || s.role), manual: true, emailed: d.emailed, texted: d.texted, failed: d.failed }, actor);
          return json({ emailed: d.emailed, texted: d.texted, failed: d.failed, pending: up.length });
        }
        // Only whoever is holding it up: every unsigned signer, or in order, the one whose turn it is.
        const links = await signerLinks(row.id);
        const signers = turn(links, row.signing_order_mode);
        const { company } = await loadCompany(asCaller, ws);
        const cc = await ensureTcCc(admin, row);
        const mailEnv = await signingResendEnv(admin, ws);
        const sender = await signingSender(admin, who.user.id);
        const emailed = await emailSigners(company, row.name, row.message ?? null, signers, { reminder: true, expiresAt: row.expires_at, cc, contractId: row.id, env: mailEnv, sender });
        const now = new Date().toISOString();
        if (signers.length) {
          const { data: counts } = await admin.from('contract_signers').select('id, reminder_count').in('id', signers.map((s) => s.id));
          for (const c of counts ?? []) await admin.from('contract_signers').update({ last_reminded_at: now, reminder_count: Number(c.reminder_count ?? 0) + 1 }).eq('id', c.id);
        }
        await logEvent(admin, row, 'reminded', { to: signers.map((s) => s.label || s.role), manual: true, emailed }, { actor_type: 'user', actor_id: who.user.id });
        return json({ emailed, pending: signers.length });
      }
      case 'pdf': {
        const row = await loadContract(Number(b.contract_id));
        if (!row?.pdf_path) return json({ error: 'no PDF yet' }, 404);
        const { data, error } = await admin.storage.from('contracts').createSignedUrl(row.pdf_path, 3600);
        if (error || !data) return json({ error: error?.message ?? 'could not sign the URL' }, 500);
        await logEvent(admin, row, 'downloaded', {}, { actor_type: 'user', actor_id: who.user.id });
        return json({ url: data.signedUrl });
      }
      case 'void': {
        const row = await loadContract(Number(b.contract_id));
        if (!row || row.provider !== 'clozr') return json({ error: 'contract not found' }, 404);
        const now = new Date().toISOString();
        if (row.status === 'completed') return json({ error: 'A completed contract cannot be voided; send a termination instead.' }, 409);
        const reason = String(b.reason ?? '').slice(0, 500) || null;
        await admin.from('contracts').update({ status: 'voided', voided_at: now, void_reason: reason, last_event: { status: 'voided', source: 'void', at: now } }).eq('id', row.id);
        await logEvent(admin, row, 'voided', { by: who.user.id, reason }, { actor_type: 'user', actor_id: who.user.id });
        publishContract(admin, row, 'contract.voided', { reason });
        return json({ contract: { ...row, status: 'voided' } });
      }
      case 'fields': {
        const { company } = await loadCompany(asCaller, ws);
        const parties = await loadParties(asCaller, ws, { sellerId: b.seller_id, dealId: b.deal_id, buyerId: b.buyer_id, offerId: b.offer_id });
        const { data: profile } = await asCaller.from('profiles').select('full_name, email, phone').eq('id', who.user.id).maybeSingle();
        const tokens = buildTokens(parties, company, { name: profile?.full_name, email: profile?.email, phone: profile?.phone });
        return json({ tokens, packet: tokens.map((t) => `${t.name}: ${t.value}`).join('\n') });
      }
      case 'packet': {
        const { company, settings } = await loadCompany(asCaller, ws);
        const parties = await loadParties(asCaller, ws, { sellerId: b.seller_id, dealId: b.deal_id, buyerId: b.buyer_id, offerId: b.offer_id });
        if (!parties.seller && !parties.deal && !parties.buyer) return json({ error: 'seller, deal or buyer not found' }, 404);
        const { data: profile } = await asCaller.from('profiles').select('full_name, email, phone').eq('id', who.user.id).maybeSingle();
        const tokens = buildTokens(parties, company, { name: profile?.full_name, email: profile?.email, phone: profile?.phone });
        const kind = String(b.kind || 'other');
        const allowed = new Set(['psa', 'assignment', 'amendment', 'termination', 'option', 'novation', 'jv', 'disclosure', 'addendum', 'offer', 'other']);
        if (!allowed.has(kind)) return json({ error: 'unknown contract type' }, 422);
        const addr = String(parties.prop?.line1 || parties.seller?.property_address || parties.buyer?.name || '');
        const name = String(b.name || `${kind === 'offer' ? 'Cash Offer' : kind.toUpperCase()}${addr ? ` · ${addr}` : ''}`);
        const recipients = (Array.isArray(b.recipients) ? b.recipients : []).filter((r: Any) => r?.email && String(r.email).includes('@'))
          .map((r: Any) => ({ email: String(r.email).trim().toLowerCase(), first_name: r.first_name || undefined, last_name: r.last_name || undefined, role: r.role || undefined }));
        const os = (settings.offers ?? {}) as { pandadoc_template_name?: string };
        const { data: row, error } = await admin.from('contracts').insert({
          workspace_id: ws, deal_id: parties.deal?.id ?? (b.deal_id ? Number(b.deal_id) : null),
          seller_id: parties.seller?.id ?? (b.seller_id ? Number(b.seller_id) : null),
          buyer_id: parties.buyer?.id ?? (b.buyer_id ? Number(b.buyer_id) : null),
          kind, provider: 'pandadoc', template_name: os.pandadoc_template_name ?? b.template_name ?? 'Acme Homes PandaDoc template',
          name, status: 'draft', recipients, tokens, message: b.message ?? null, created_by: who.user.id,
          last_event: { via: 'packet', clozr_workspace_id: String(ws), at: new Date().toISOString() },
        }).select('*').single();
        if (error || !row) return json({ error: error?.message ?? 'could not save the packet' }, 500);
        await admin.from('contract_events').insert({ workspace_id: ws, contract_id: row.id, event: 'created', payload: { provider: 'pandadoc', via: 'packet' } });
        const whoEntity = parties.seller?.id ? { entity_type: 'seller', entity_id: parties.seller.id } : parties.buyer?.id ? { entity_type: 'buyer', entity_id: parties.buyer.id } : parties.deal?.id ? { entity_type: 'deal', entity_id: parties.deal.id } : null;
        if (whoEntity) await admin.from('activity').insert({ workspace_id: ws, ...whoEntity, kind: 'contract', title: `${name} ready for PandaDoc`, body: 'Copy the fields into the Acme Homes template and send. The webhook will attach it.', actor_id: who.user.id });
        return json({ contract: row, tokens, packet: tokens.map((t) => `${t.name}: ${t.value}`).join('\n') });
      }
      case 'create_pdf': {
        const tpl = b.template_id ? await loadTemplate(Number(b.template_id)) : null;
        if (b.template_id && (!tpl || tpl.mode !== 'pdf')) return json({ error: 'PDF template not found' }, 404);
        if (!tpl && !b.source_path) return json({ error: 'Upload a PDF or pick a PDF template.' }, 422);
        const { company } = await loadCompany(asCaller, ws);
        const parties = await loadParties(asCaller, ws, { sellerId: b.seller_id, dealId: b.deal_id, buyerId: b.buyer_id, offerId: b.offer_id });
        if (!parties.seller && !parties.deal && !parties.buyer) return json({ error: 'seller, buyer, or deal not found' }, 404);
        const given: Any[] = Array.isArray(b.signers) ? b.signers : [];
        // A template's roles fill from the record like any other template; a one-off upload takes the people as given.
        const signers = tpl
          ? ((tpl.signers as Any[]) ?? []).map((r) => {
            const g = given.find((x) => x?.role === r.role);
            const base = partySigner(r, { ...parties, company });
            return { ...base, name: g?.name ?? base.name, email: g?.email ?? base.email, phone: g?.phone ?? base.phone, recipient_type: g?.recipient_type ?? r.recipient_type ?? null };
          })
          : given.filter((x) => x?.role).map((x) => ({ role: String(x.role), label: String(x.label || x.role), optional: false, name: x.name ?? null, email: x.email ?? null, phone: x.phone ?? null, recipient_type: x.recipient_type ?? null }));
        for (const [k, x] of given.filter((x) => x?.extra && (x.email || x.name)).entries()) {
          const kind = x.recipient_type === 'viewer' ? 'viewer' : x.recipient_type === 'approver' ? 'approver' : 'cc';
          signers.push({ role: `extra${k + 1}`, label: String(x.label || (kind === 'cc' ? 'CC' : kind === 'approver' ? 'Approver' : 'Viewer')), optional: false, name: x.name ?? null, email: x.email ?? null, phone: x.phone ?? null, recipient_type: kind });
        }
        if (!signers.some((s) => !s.optional && (s.email || s.name) && !['cc', 'viewer', 'approver'].includes(String(s.recipient_type ?? 'signer')))) return json({ error: 'at least one signer needs a name or email' }, 422);
        // Migration 114 on PDFs too: delivery and CRM links by role; approvers and texts send through docs-flow.
        const pdfMeta = new Map<string, Any>();
        for (const x of given) if (x?.role && !x.extra) pdfMeta.set(String(x.role), x);
        for (const [k, x] of given.filter((x) => x?.extra && (x.email || x.name)).entries()) pdfMeta.set(`extra${k + 1}`, x);
        const pdfLinkOf = await crmIds([...pdfMeta.values()]);
        const pdfViaFlow = !!b.send && (signers.some((x: Any) => x.recipient_type === 'approver') || [...pdfMeta.values()].some((g) => normalizeDelivery(g.delivery) !== 'email'));
        const kinds = new Set(['psa', 'assignment', 'amendment', 'termination', 'option', 'novation', 'jv', 'disclosure', 'addendum', 'offer', 'other']);
        const out = await createPdfContract(admin, {
          ws, userId: who.user.id, origin, template: tpl, sourcePath: b.source_path ? String(b.source_path) : null,
          kind: tpl ? String(tpl.kind) : kinds.has(String(b.kind)) ? String(b.kind) : 'other',
          name: b.name ?? null, ids: { sellerId: parties.seller?.id, dealId: parties.deal?.id, buyerId: parties.buyer?.id, offerId: b.offer_id ?? null },
          signers, fields: Array.isArray(b.fields) ? b.fields : null, tokens: Array.isArray(b.tokens) ? b.tokens : [],
          message: b.message ?? null, expiresDays: b.expires_days ?? tpl?.default_expiry_days ?? 14, send: !!b.send && !pdfViaFlow, notary: b.notary ?? null,
          orderMode: b.order_mode === 'sequential' ? 'sequential' : 'parallel',
          reminders: b.reminders && typeof b.reminders === 'object' ? {
            first_after_days: Math.max(0, Math.min(30, Number(b.reminders.first_after_days ?? 1))),
            repeat_every_days: Math.max(0, Math.min(30, Number(b.reminders.repeat_every_days ?? 2))),
          } : null,
          parties, company,
        });
        for (const sg of out.signers as Any[]) {
          const g = pdfMeta.get(sg.role);
          if (!g) continue;
          const patch = { delivery: normalizeDelivery(g.delivery), ...Object.fromEntries(Object.entries(pdfLinkOf(g)).filter(([, v]) => v !== null)) };
          if (patch.delivery !== 'email' || Object.keys(patch).length > 1) await admin.from('contract_signers').update(patch).eq('id', sg.id);
        }
        if (pdfViaFlow) {
          const d = await dispatchSend(admin, out.contract, { company, origin, who: actor, senderId: who.user.id }, b.message ?? null);
          const { data: fresh } = await admin.from('contracts').select('*').eq('id', out.contract.id).single();
          if (d.status === 'sent' && b.notary?.needs && fresh) {
            try { await queueNotary(admin, fresh, origin); } catch (e) { console.error('notary', (e as Error).message); }
          }
          Object.assign(out, { contract: fresh ?? out.contract, emailed: d.emailed, texted: d.texted, failed: d.failed, awaiting_approval: d.status === 'awaiting_approval' });
        }
        const actTitle = `${out.contract.name} ${b.send ? 'sent for signature' : 'drafted'}`;
        const actBody = out.signers.map((s) => `${s.label}: ${s.name ?? s.email ?? '—'}`).join('\n');
        const activity = [
          parties.seller?.id ? { entity_type: 'seller', entity_id: parties.seller.id } : null,
          parties.buyer?.id ? { entity_type: 'buyer', entity_id: parties.buyer.id } : null,
          parties.deal?.id ? { entity_type: 'deal', entity_id: parties.deal.id } : null,
        ].filter((r): r is { entity_type: string; entity_id: number } => !!r)
          .map((r) => ({ workspace_id: ws, ...r, kind: 'contract', title: actTitle, body: actBody, actor_id: who.user.id }));
        if (activity.length) await admin.from('activity').insert(activity);
        return json(out);
      }
      case 'pdf_fields': {
        const row = await loadContract(Number(b.contract_id));
        if (!row || row.provider !== 'clozr' || row.mode !== 'pdf') return json({ error: 'PDF contract not found' }, 404);
        return json(await draftFields(admin, row));
      }
      case 'pdf_fields_save': {
        const row = await loadContract(Number(b.contract_id));
        if (!row || row.provider !== 'clozr' || row.mode !== 'pdf') return json({ error: 'PDF contract not found' }, 404);
        if (!Array.isArray(b.fields)) return json({ error: 'fields must be a list' }, 422);
        const { company } = await loadCompany(asCaller, ws);
        try {
          return json(await saveDraftFields(admin, row, b.fields, company, { actor_id: who.user.id }));
        } catch (e) { return json({ error: (e as Error).message }, 422); }
      }
      case 'notary': {
        const row = await loadContract(Number(b.contract_id));
        if (!row) return json({ error: 'contract not found' }, 404);
        const mode = ['digital', 'wet', 'vendor'].includes(b.mode) ? b.mode : 'digital';
        const out = await queueNotary(admin, { ...row, notary_mode: mode, notary_vendor: b.vendor ?? row.notary_vendor ?? null, needs_notary: b.needs !== false }, origin);
        const { data: contract } = await admin.from('contracts').select('*').eq('id', row.id).single();
        return json({ contract, ...out });
      }
      // ---------------------------------------------------------------- template library (115)
      case 'library': {
        const [rows, used, folders, blocks] = await Promise.all([visibleTemplates(), usage(), listFolders(), listBlocks()]);
        // Old rows switched off before versions existed stay out; archived ones come back flagged.
        const listed = latestByKey(rows.filter((r) => r.active || r.archived_at) as Any[], ws) as Record<string, Any>[];
        const familyUse = new Map<number, number>();
        for (const r of rows) { const f = familyOf(r as Any); familyUse.set(f, (familyUse.get(f) ?? 0) + (used.get(Number(r.id)) ?? 0)); }
        const templates = listed.map((t) => ({ ...t, family_id: familyOf(t as Any), used: familyUse.get(familyOf(t as Any)) ?? 0, used_this: used.get(Number(t.id)) ?? 0, built_in: t.workspace_id == null }));
        return json({
          templates, blocks, can_edit: canEditLibrary,
          folders: folders.filter((f) => f.scope === 'templates'), contract_folders: folders.filter((f) => f.scope === 'contracts'),
        });
      }
      case 'template_versions': {
        const t = await templateRow(Number(b.template_id));
        if (!t) return json({ error: 'template not found' }, 404);
        const [fam, used] = await Promise.all([familyRows(familyOf(t as Any)), usage()]);
        const versions = fam.map((r): Record<string, Any> => ({ ...r, used: used.get(Number(r.id)) ?? 0, built_in: r.workspace_id == null, current: !r.superseded_at }))
          .sort((a, c) => Number(c.version ?? 1) - Number(a.version ?? 1) || Number(c.id) - Number(a.id));
        return json({ versions });
      }
      case 'template_save': {
        const denied = needAdmin(); if (denied) return denied;
        const fields = templateFields(b);
        if (!(await folderOk(fields.folder_id, 'templates'))) return json({ error: 'folder not found' }, 404);
        if (!b.template_id) {
          if (!fields.body_md?.trim()) return json({ error: 'the template needs some text' }, 422);
          const rows = await visibleTemplates();
          const row = { workspace_id: ws, key: keyFor(String(fields.name ?? 'template'), rows.map((r) => String(r.key))), name: 'Untitled template', kind: 'other', signers: [], sort: 100, active: true, version: 1, created_by: who.user.id, ...fields };
          const { data, error } = await admin.from('doc_templates').insert(row).select('*').single();
          if (error || !data) return json({ error: error?.message ?? 'could not save the template' }, 500);
          return json({ template: data, versioned: false });
        }
        const cur = await templateRow(Number(b.template_id));
        if (!cur) return json({ error: 'template not found' }, 404);
        return json(await saveTemplate(cur, fields));
      }
      case 'restore_version': {
        const denied = needAdmin(); if (denied) return denied;
        const old = await templateRow(Number(b.template_id));
        if (!old) return json({ error: 'version not found' }, 404);
        const fam = await familyRows(familyOf(old as Any));
        const latest = fam.find((r) => Number(r.workspace_id) === ws && !r.superseded_at) ?? fam.find((r) => r.workspace_id == null && !r.superseded_at) ?? old;
        // The words and defaults come back; where it is filed stays where it is now.
        const content: Record<string, Any> = {};
        for (const k of ['name', 'kind', 'body_md', 'signers', 'default_expiry_days', 'reminder_policy', 'default_signing_order']) content[k] = old[k] ?? null;
        const out = await saveTemplate(latest, content, true);
        return json({ template: out.template, restored_from: Number(old.version ?? 1) });
      }
      case 'template_duplicate': {
        const denied = needAdmin(); if (denied) return denied;
        const src = await templateRow(Number(b.template_id));
        if (!src) return json({ error: 'template not found' }, 404);
        const rows = await visibleTemplates();
        const name = `${String(src.name)} (copy)`.slice(0, 200);
        const row: Record<string, Any> = { workspace_id: ws, key: keyFor(name, rows.map((r) => String(r.key))), name, active: true, version: 1, created_by: who.user.id };
        for (const k of ['kind', 'body_md', 'signers', 'sort', 'default_expiry_days', 'reminder_policy', 'default_signing_order']) row[k] = src[k] ?? null;
        row.folder_id = src.workspace_id == null ? null : src.folder_id ?? null;
        row.sort = row.sort ?? 100;
        const { data, error } = await admin.from('doc_templates').insert(row).select('*').single();
        if (error || !data) return json({ error: error?.message ?? 'could not duplicate the template' }, 500);
        return json({ template: data });
      }
      case 'template_archive': {
        const denied = needAdmin(); if (denied) return denied;
        const cur = await templateRow(Number(b.template_id));
        if (!cur) return json({ error: 'template not found' }, 404);
        const archived = b.archived !== false;
        const flags = archived ? { archived_at: new Date().toISOString(), active: false } : { archived_at: null, active: true };
        // A built-in is hidden by this workspace's own (archived) copy of it.
        if (cur.workspace_id == null) return json({ template: (await saveTemplate(cur, {}, true, flags)).template });
        const { data, error } = await admin.from('doc_templates').update(flags).eq('id', cur.id).select('*').single();
        if (error || !data) return json({ error: error?.message ?? 'could not update the template' }, 500);
        return json({ template: data });
      }
      case 'template_move': {
        const denied = needAdmin(); if (denied) return denied;
        const cur = await templateRow(Number(b.template_id));
        if (!cur) return json({ error: 'template not found' }, 404);
        const folderId = b.folder_id ? Number(b.folder_id) : null;
        if (!(await folderOk(folderId, 'templates'))) return json({ error: 'folder not found' }, 404);
        if (cur.workspace_id == null) return json({ template: (await saveTemplate(cur, { folder_id: folderId }, true)).template });
        // Every version of this workspace's template moves together.
        const ids = (await familyRows(familyOf(cur as Any))).filter((r) => Number(r.workspace_id) === ws).map((r) => r.id);
        const { error } = await admin.from('doc_templates').update({ folder_id: folderId }).in('id', ids.length ? ids : [cur.id]);
        if (error) return json({ error: error.message }, 500);
        return json({ template: { ...cur, folder_id: folderId } });
      }
      case 'folders': {
        const scope = b.scope === 'contracts' ? 'contracts' : 'templates';
        if (b.op === 'list') return json({ folders: await listFolders(scope) });
        if (scope === 'templates') { const denied = needAdmin(); if (denied) return denied; }
        const all = await listFolders(scope);
        const id = Number(b.id);
        const mine = all.find((f) => Number(f.id) === id);
        const name = String(b.name ?? '').trim().slice(0, 120);
        const parent = b.parent_id ? Number(b.parent_id) : null;
        if (parent != null && !all.some((f) => Number(f.id) === parent)) return json({ error: 'parent folder not found' }, 404);
        switch (b.op) {
          case 'create': {
            if (!name) return json({ error: 'name the folder' }, 422);
            const { error } = await admin.from('doc_folders').insert({ workspace_id: ws, scope, name, parent_id: parent, sort: all.length, created_by: who.user.id });
            if (error) return json({ error: error.message }, 500);
            break;
          }
          case 'rename': {
            if (!mine) return json({ error: 'folder not found' }, 404);
            if (!name) return json({ error: 'name the folder' }, 422);
            await admin.from('doc_folders').update({ name }).eq('id', id);
            break;
          }
          case 'move': {
            if (!mine) return json({ error: 'folder not found' }, 404);
            if (parent != null && folderAndBelow(all.map((f) => ({ id: Number(f.id), name: f.name, parent_id: f.parent_id == null ? null : Number(f.parent_id) })), id).has(parent)) return json({ error: 'a folder cannot go inside itself' }, 422);
            await admin.from('doc_folders').update({ parent_id: parent }).eq('id', id);
            break;
          }
          case 'delete': {
            if (!mine) return json({ error: 'folder not found' }, 404);
            // What was in it moves up a level rather than disappearing.
            const up = mine.parent_id ?? null;
            await admin.from('doc_folders').update({ parent_id: up }).eq('workspace_id', ws).eq('parent_id', id);
            if (scope === 'templates') await admin.from('doc_templates').update({ folder_id: up }).eq('workspace_id', ws).eq('folder_id', id);
            else await admin.from('contracts').update({ folder_id: up }).eq('workspace_id', ws).eq('folder_id', id);
            const { error } = await admin.from('doc_folders').delete().eq('id', id);
            if (error) return json({ error: error.message }, 500);
            break;
          }
          default: return json({ error: 'unknown folder op' }, 400);
        }
        return json({ folders: await listFolders(scope) });
      }
      case 'blocks': {
        const denied = needAdmin(); if (denied) return denied;
        switch (b.op) {
          case 'save': {
            const x = b.block ?? {};
            const row = {
              name: String(x.name ?? '').trim().slice(0, 160), body: String(x.body ?? ''), locked: !!x.locked,
              tags: (Array.isArray(x.tags) ? x.tags : String(x.tags ?? '').split(',')).map((t: Any) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 20),
            };
            if (!row.name) return json({ error: 'name the section' }, 422);
            if (x.id) {
              const { error } = await admin.from('doc_content_blocks').update(row).eq('id', Number(x.id)).eq('workspace_id', ws);
              if (error) return json({ error: error.message }, 500);
            } else {
              const { error } = await admin.from('doc_content_blocks').insert({ ...row, workspace_id: ws, created_by: who.user.id });
              if (error) return json({ error: error.message }, 500);
            }
            break;
          }
          case 'delete': {
            const id = Number(b.id);
            // A current template (or another section) that places it would break at send time.
            const users = latestByKey((await visibleTemplates()).filter((r) => r.active || r.archived_at) as Any[], ws)
              .filter((t) => blocksIn(String((t as Any).body_md ?? '')).includes(id)).map((t) => t.name);
            const inBlocks = (await listBlocks()).filter((x) => Number(x.id) !== id && blocksIn(String(x.body ?? '')).includes(id)).map((x) => x.name);
            if (users.length || inBlocks.length) return json({ error: `Still used by ${[...users, ...inBlocks].slice(0, 5).join(', ')}. Take it out of those first.` }, 409);
            const { error } = await admin.from('doc_content_blocks').delete().eq('id', id).eq('workspace_id', ws);
            if (error) return json({ error: error.message }, 500);
            break;
          }
          case 'starter': {
            // Only the ones this workspace does not already have by name.
            const have = new Set((await listBlocks()).map((x) => String(x.name).toLowerCase()));
            const add = STARTER_BLOCKS.filter((x) => !have.has(x.name.toLowerCase())).map((x) => ({ ...x, workspace_id: ws, created_by: who.user.id }));
            if (add.length) {
              const { error } = await admin.from('doc_content_blocks').insert(add);
              if (error) return json({ error: error.message }, 500);
            }
            return json({ blocks: await listBlocks(), added: add.length });
          }
          default: return json({ error: 'unknown section op' }, 400);
        }
        return json({ blocks: await listBlocks() });
      }
      case 'contract_folder': {
        const row = await loadContract(Number(b.contract_id));
        if (!row) return json({ error: 'contract not found' }, 404);
        const folderId = b.folder_id ? Number(b.folder_id) : null;
        if (!(await folderOk(folderId, 'contracts'))) return json({ error: 'folder not found' }, 404);
        const { error } = await admin.from('contracts').update({ folder_id: folderId }).eq('id', row.id);
        if (error) return json({ error: error.message }, 500);
        await logEvent(admin, row, 'filed', { folder_id: folderId, from: row.folder_id ?? null }, { actor_type: 'user', actor_id: who.user.id });
        return json({ contract: { ...row, folder_id: folderId } });
      }
      case 'recipients': {
        const row = await loadContract(Number(b.contract_id));
        if (!row || row.provider !== 'clozr') return json({ error: 'contract not found' }, 404);
        return json({ recipients: (await loadRecipients(admin, row.id)).map((s) => publicRecipient(s, origin)) });
      }
      case 'approve': {
        const row = await loadContract(Number(b.contract_id));
        if (!row || row.provider !== 'clozr') return json({ error: 'contract not found' }, 404);
        const d = approvalDecision(b.decision, b.reason);
        if (!d.ok) return json({ error: d.message }, 422);
        const people = await loadRecipients(admin, row.id);
        const email = String(who.user.email ?? '').toLowerCase();
        const mine = (s: Any) => s.user_id === who.user.id || (!!email && String(s.email ?? '').toLowerCase() === email);
        const open = pendingApprovals(people);
        const approver = b.signer_id ? open.find((s) => s.id === Number(b.signer_id)) : open.find(mine);
        if (!approver) return json({ error: 'There is no approval waiting on you for this document.' }, 404);
        // An owner or admin may answer for an approver who is away; the audit line says so.
        if (!mine(approver) && !['owner', 'admin'].includes(member.role)) return json({ error: 'Only that approver (or an owner or admin) can answer.' }, 403);
        const { company } = await loadCompany(asCaller, ws);
        const out = await recordApproval(admin, row, approver, d, { company, origin, who: { ...actor, signer_id: approver.id }, senderId: row.created_by ?? who.user.id });
        if (!mine(approver)) await logEvent(admin, row, 'approval_on_behalf', { approver: approver.name || approver.email, by: who.user.id }, actor);
        return json({ approved: out.approved, sent: out.sent, status: out.status, emailed: out.delivered?.emailed ?? 0, texted: out.delivered?.texted ?? 0 });
      }
      case 'add_recipient': {
        const row = await loadContract(Number(b.contract_id));
        if (!row || row.provider !== 'clozr') return json({ error: 'contract not found' }, 404);
        const r = (b.recipient ?? {}) as Any;
        const link = (await crmIds([r]))(r);
        const { company } = await loadCompany(asCaller, ws);
        const out = await addRecipient(admin, row, { ...r, ...link }, { company, origin, who: actor, senderId: who.user.id });
        return json({ recipient: publicRecipient(out.signer, origin), ...out.delivered });
      }
      case 'update_recipient': {
        const row = await loadContract(Number(b.contract_id));
        if (!row || row.provider !== 'clozr') return json({ error: 'contract not found' }, 404);
        const s = (await loadRecipients(admin, row.id)).find((x) => x.id === Number(b.signer_id));
        if (!s) return json({ error: 'recipient not found' }, 404);
        const patch = { name: b.name, email: b.email, phone: b.phone, delivery: b.delivery, resend: !!b.resend };
        const changed = contactChanges(s, patch);
        if (changed.includes('email') && b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim())) return json({ error: 'That email does not look right.' }, 422);
        const { company } = await loadCompany(asCaller, ws);
        const out = await updateRecipient(admin, row, s, patch, changed, { company, origin, who: actor, senderId: who.user.id });
        return json({ recipient: publicRecipient(out.signer, origin), changed, ...out.delivered, crm: { seller_id: s.seller_id ?? null, buyer_id: s.buyer_id ?? null, vendor_id: s.vendor_id ?? null } });
      }
      default: return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
