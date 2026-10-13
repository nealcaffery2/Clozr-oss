// Buyr inside CLOZR: the aged Deal Machine queue, the wholesaler lists the
// opt-in bot joined, and the Facebook groups those comments come from.
//
// Aged deals sync into Genius (RealEstateAPI) with found_via buyr. Facebook
// emails file through createBuyer as Prospect, which keeps them off the vetted list.
'use client';

import { supabase } from './supabase';
import { createBuyer } from './crm-write';
import { sendCommand } from './deal-machine';
import { type BuyerProspect, prospectsFromPaste } from './buyr-comments';

export type SnipeDeal = {
  id: number;
  address: string;
  createdAt: string;
  leadSource: string | null;
};

export type SnipeOptin = {
  domain: string;
  url: string | null;
  lastAt: string;
};

export type FbGroup = {
  id: number;
  url: string;
  name: string | null;
  lastScrapedAt: string | null;
};

export type FiledProspect = {
  id: number;
  name: string;
  email: string | null;
  createdAt: string;
};

type Prop = { line1?: string | null; city?: string | null; state?: string | null; zip?: string | null };

function addressOf(prop: Prop | Prop[] | null | undefined): string {
  const p = Array.isArray(prop) ? prop[0] : prop;
  const line1 = p?.line1?.trim();
  if (!line1) return '';
  return [line1, p?.city, p?.state, p?.zip].filter(Boolean).join(', ');
}

/** Deal Machine deals older than `days`, plus wholesaler lists already opted into. */
export async function loadSnipeQueue(workspaceId: number, days = 90): Promise<{ deals: SnipeDeal[]; optins: SnipeOptin[]; error?: string }> {
  if (!supabase) return { deals: [], optins: [], error: 'Supabase is not configured.' };
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  // dm_* tables are not in database.types.ts. Same untyped read Deal Machine uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dm = (name: string) => (supabase as any).from(name);
  const [dealsR, optinsR] = await Promise.all([
    supabase.from('deals')
      .select('id, created_at, lead_source, source, properties(line1, city, state, zip)')
      .eq('workspace_id', workspaceId)
      .eq('source', 'deal_machine')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(200),
    dm('dm_optins')
      .select('domain, url, last_at')
      .eq('workspace_id', workspaceId)
      .eq('status', 'opted_in')
      .order('last_at', { ascending: false })
      .limit(200),
  ]);
  if (dealsR.error) return { deals: [], optins: [], error: dealsR.error.message };
  if (optinsR.error) return { deals: [], optins: [], error: optinsR.error.message };
  const deals = ((dealsR.data ?? []) as { id: number; created_at: string; lead_source: string | null; properties: Prop | Prop[] | null }[]).flatMap((row) => {
    const address = addressOf(row.properties);
    if (!address) return [];
    return [{ id: row.id, address, createdAt: row.created_at, leadSource: row.lead_source }];
  });
  const optins = ((optinsR.data ?? []) as { domain: string; url: string | null; last_at: string }[]).map((row) => ({ domain: row.domain, url: row.url, lastAt: row.last_at }));
  return { deals, optins };
}

export async function loadFbGroups(workspaceId: number): Promise<{ groups: FbGroup[]; error?: string }> {
  if (!supabase) return { groups: [], error: 'Supabase is not configured.' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).from('dm_groups')
    .select('id, url, name, last_scraped_at, active')
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .order('name', { ascending: true })
    .limit(200);
  if (error) return { groups: [], error: error.message };
  return {
    groups: ((data ?? []) as { id: number; url: string; name: string | null; last_scraped_at: string | null }[]).map((row) => ({
      id: row.id, url: row.url, name: row.name, lastScrapedAt: row.last_scraped_at,
    })),
  };
}

export async function loadFbProspects(workspaceId: number): Promise<FiledProspect[]> {
  if (!supabase) return [];
  const { data } = await supabase.from('buyers')
    .select('id, name, email, created_at, tags')
    .eq('workspace_id', workspaceId)
    .contains('tags', ['fb-comment'])
    .order('created_at', { ascending: false })
    .limit(40);
  return (data ?? []).map((row) => ({ id: row.id, name: row.name, email: row.email, createdAt: row.created_at }));
}

/** Queue the Deal Machine scrape. Its Facebook pass harvests comment emails. */
export function queueFacebookScrape(workspaceId: number) {
  return sendCommand(workspaceId, 'scrape', { focus: 'facebook_buyers' });
}

export async function filePastedComments(
  workspaceId: number, raw: string, userId: string | null,
): Promise<{ found: number; filed: number; skipped: number; error?: string }> {
  const prospects = prospectsFromPaste(raw);
  if (!prospects.length) return { found: 0, filed: 0, skipped: 0, error: 'No buyer emails in that paste.' };
  let filed = 0;
  let skipped = 0;
  let error: string | undefined;
  // Four at a time: a paste of 200 comments filed one after another. One
  // email per prospect (prospectsFromPaste dedupes), so no two workers race
  // the same buyer through createBuyer's duplicate check.
  const queue = prospects.slice();
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const r = await fileProspect(workspaceId, p, userId);
      if (r.ok) filed++;
      else if (r.id) skipped++;
      else error = r.message;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return { found: prospects.length, filed, skipped, error };
}

async function fileProspect(workspaceId: number, p: BuyerProspect, userId: string | null) {
  const notes = [p.comment, p.groupName && `FB group: ${p.groupName}`, p.dealAddress && `Deal: ${p.dealAddress}`].filter(Boolean).join(' · ');
  return createBuyer(workspaceId, {
    name: p.name,
    email: p.email,
    tags: ['buyer-prospect', 'fb-comment'],
    source: 'buyr',
    status: 'Prospect',
    notes: notes || null,
    buyer_type: 'cash_buyer',
  }, userId);
}
