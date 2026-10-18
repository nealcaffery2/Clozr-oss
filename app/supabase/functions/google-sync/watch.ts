/**
 * Opens, renews and closes Google Calendar push channels for one account's
 * feeds (the plan is _shared/calendar-watch.ts). Runs inside the calendar
 * pass, so the cron that already visits every account is what renews them.
 * Google posts each change to google-calendar-push, which syncs the account
 * at once.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { Account } from '../_shared/google.ts';
import { RETRY_AFTER_MS, WATCH_TTL_SECONDS, type WatchFeed, watchPlan } from '../_shared/calendar-watch.ts';

const CAL = 'https://www.googleapis.com/calendar/v3';

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(24))).map((b) => b.toString(16).padStart(2, '0')).join('');

async function stopChannel(accessToken: string, id: string, resourceId: string | null): Promise<void> {
  if (!resourceId) return;
  await fetch(`${CAL}/channels/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, resourceId }),
  }).then((r) => r.body?.cancel()).catch(() => null);
}

export type WatchResult = { opened: number; stopped: number; failed: number };

export async function ensureWatches(admin: SupabaseClient, account: Pick<Account, 'id'>, accessToken: string): Promise<WatchResult> {
  const out: WatchResult = { opened: 0, stopped: 0, failed: 0 };
  const base = String(Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  if (!base) return out;
  const { data, error } = await admin.from('google_calendar_feeds')
    .select('calendar_id, enabled, watch_channel_id, watch_resource_id, watch_expires_at')
    .eq('account_id', account.id);
  // Migration 270 not applied yet: polling carries on exactly as before.
  if (error) return out;

  for (const f of (data ?? []) as WatchFeed[]) {
    const plan = watchPlan(f);
    if (plan === 'keep' || plan === 'wait' || plan === 'none') continue;
    const where = admin.from('google_calendar_feeds');
    if (plan === 'stop') {
      await stopChannel(accessToken, f.watch_channel_id!, f.watch_resource_id);
      await where.update({ watch_channel_id: null, watch_resource_id: null, watch_token: null, watch_expires_at: null })
        .eq('account_id', account.id).eq('calendar_id', f.calendar_id);
      out.stopped++;
      continue;
    }
    const id = crypto.randomUUID();
    const token = randomToken();
    const res = await fetch(`${CAL}/calendars/${encodeURIComponent(f.calendar_id)}/events/watch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, type: 'web_hook', address: `${base}/functions/v1/google-calendar-push`, token, params: { ttl: String(WATCH_TTL_SECONDS) } }),
    }).catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok || !body?.resourceId) {
      out.failed++;
      console.error('calendar watch refused', { account: account.id, calendar: f.calendar_id, status: res?.status ?? 0, err: body?.error?.message ?? null });
      // The backoff marker: no channel, an expiry in the future (watchPlan → 'wait').
      await where.update({ watch_channel_id: null, watch_resource_id: null, watch_token: null, watch_expires_at: new Date(Date.now() + RETRY_AFTER_MS).toISOString() })
        .eq('account_id', account.id).eq('calendar_id', f.calendar_id);
      continue;
    }
    const expires = Number(body.expiration);
    await where.update({
      watch_channel_id: id, watch_resource_id: String(body.resourceId), watch_token: token,
      watch_expires_at: new Date(Number.isFinite(expires) ? expires : Date.now() + WATCH_TTL_SECONDS * 1000).toISOString(),
    }).eq('account_id', account.id).eq('calendar_id', f.calendar_id);
    // The old channel goes after the new one is stored, so no change falls between them.
    if (f.watch_channel_id) await stopChannel(accessToken, f.watch_channel_id, f.watch_resource_id);
    out.opened++;
  }
  return out;
}
