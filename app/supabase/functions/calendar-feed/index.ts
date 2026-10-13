/**
 * GET /calendar-feed?token=… — the workspace calendar as an ICS feed.
 *
 * Google Calendar (and Apple, Outlook) subscribe to a URL and re-fetch it on
 * their own schedule, so CLOZR → Google sync needs no OAuth, no tokens to
 * refresh and no server of its own: appointments and dated tasks become
 * VEVENTs, and this URL is what "Other calendars → From URL" points at.
 *
 * One-way by design. Editing an event in Google does not come back; the CRM
 * is the source of truth for what the team is doing.
 *
 * The token is the only credential — Google cannot send one of ours — so it is
 * 48 hex characters per workspace, minted by ensure_calendar_token() and
 * rotatable from Settings. verify_jwt is off for that reason.
 */
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { HARDENING, clientIp, rateLimit } from '../_shared/security.ts';

const text = (body: string, status = 200, type = 'text/plain') =>
  new Response(body, { status, headers: { ...HARDENING, 'Content-Type': type, 'Cache-Control': 'no-cache' } });

/** ICS needs CRLF, escaped commas/semicolons, and lines under 75 octets. */
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const byteLen = (s: string) => new TextEncoder().encode(s).length;
const fold = (line: string) => {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (byteLen(cur + ch) > 73) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
};
const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? '';
  if (!/^[0-9a-f]{48}$/.test(token)) return text('missing or malformed token', 401);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  // Calendar apps poll every few hours; anything faster from one address is
  // a scraper or a token search, and 192 bits of token deserve a slow one.
  const rl = await rateLimit(db, `calendar-feed:${clientIp(req)}`, 60, 600);
  if (!rl.allowed) return new Response('too many requests', { status: 429, headers: { ...HARDENING, 'Retry-After': String(rl.resetSeconds) } });
  const { data: ws } = await db.from('workspaces').select('id, name').eq('calendar_token', token).maybeSingle();
  if (!ws) return text('unknown token', 401);

  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const [{ data: appts }, { data: tasks }, { data: sellers }] = await Promise.all([
    db.from('appointments').select('id, title, kind, starts_at, ends_at, location, notes, seller_id, updated_at').eq('workspace_id', ws.id).gte('starts_at', since),
    db.from('tasks').select('id, title, task_type, due_at, done, seller_id, updated_at').eq('workspace_id', ws.id).eq('done', false).not('due_at', 'is', null).gte('due_at', since),
    db.from('sellers').select('id, name, property_address').eq('workspace_id', ws.id),
  ]);
  const who = new Map((sellers ?? []).map((s) => [s.id, s]));

  const lines: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CLOZR//Calendar feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${esc(ws.name)} · CLOZR`),
  ];
  for (const a of appts ?? []) {
    const s = a.seller_id ? who.get(a.seller_id) : null;
    const end = a.ends_at ?? new Date(new Date(a.starts_at).getTime() + 60 * 60_000).toISOString();
    lines.push('BEGIN:VEVENT',
      `UID:appt-${a.id}@clozr`, `DTSTAMP:${stamp(a.updated_at)}`, `DTSTART:${stamp(a.starts_at)}`, `DTEND:${stamp(end)}`,
      fold(`SUMMARY:${esc([a.kind !== 'Appointment' ? a.kind : '', a.title].filter(Boolean).join(' · '))}`),
      fold(`DESCRIPTION:${esc([s ? `${s.name}${s.property_address ? ' — ' + s.property_address : ''}` : '', a.notes ?? ''].filter(Boolean).join('\n'))}`),
      ...(a.location || s?.property_address ? [fold(`LOCATION:${esc(a.location ?? s!.property_address!)}`)] : []),
      'END:VEVENT');
  }
  for (const t of tasks ?? []) {
    const s = t.seller_id ? who.get(t.seller_id) : null;
    const end = new Date(new Date(t.due_at!).getTime() + 30 * 60_000).toISOString();
    lines.push('BEGIN:VEVENT',
      `UID:task-${t.id}@clozr`, `DTSTAMP:${stamp(t.updated_at)}`, `DTSTART:${stamp(t.due_at!)}`, `DTEND:${stamp(end)}`,
      fold(`SUMMARY:${esc(`${t.task_type}: ${t.title}`)}`),
      fold(`DESCRIPTION:${esc(s ? `${s.name}${s.property_address ? ' — ' + s.property_address : ''}` : 'CLOZR task')}`),
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return text(lines.join('\r\n') + '\r\n', 200, 'text/calendar; charset=utf-8');
});
