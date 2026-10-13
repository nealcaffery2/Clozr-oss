/**
 * An email to the rep when an AI agent hands them someone to call. The bell
 * only reaches a rep with CLOZR open; this reaches their inbox and phone, and
 * one tap opens the record on the conversation the agent had.
 *
 * repAlertEmail is pure (rep-alert.test.ts); emailRep does the lookups and the send.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { clozrAppOrigin } from './app-url.ts';
import { sendResend, transactionalFrom } from './resend.ts';

export type RecordKind = 'seller' | 'buyer';

/** The CLOZR link that opens a record (useClozr's hash routes). */
export function recordLink(origin: string, kind: RecordKind, id: number): string {
  return `${origin.replace(/\/+$/, '')}/app#screen=${kind === 'buyer' ? 'buyer' : 'person'}&id=${kind === 'buyer' ? 'b' : 's'}${id}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type RepAlert = { subject: string; lines: string[]; name: string; phone: string | null; link: string };

/** The email: what happened, a tap-to-call number and a button that opens the record. */
export function repAlertEmail(a: RepAlert): { subject: string; html: string; text: string } {
  const tel = a.phone ? a.phone.replace(/[^\d+]/g, '') : '';
  const button = (href: string, label: string, bg: string) =>
    `<a href="${esc(href)}" style="display:inline-block;padding:11px 18px;margin:0 8px 8px 0;border-radius:8px;background:${bg};color:#fff;font-weight:600;text-decoration:none">${esc(label)}</a>`;
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5;color:#18181b;max-width:560px">',
    ...a.lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`),
    '<p style="margin:16px 0 0">',
    tel ? button(`tel:${tel}`, `Call ${a.name}`, '#15803d') : '',
    button(a.link, `Open ${a.name} in CLOZR`, '#6d28d9'),
    '</p>',
    '<p style="margin:12px 0 0;font-size:12px;color:#71717a">The texts, calls and notes the AI agent had are on the record\'s Activity tab.</p>',
    '</div>',
  ].join('');
  const text = [...a.lines, tel ? `Call: ${tel}` : '', `Open in CLOZR: ${a.link}`].filter(Boolean).join('\n');
  return { subject: a.subject.slice(0, 200), html, text };
}

/**
 * Email the rep. Best effort: no Resend, no email on the profile, or a failed
 * send leaves the bell notification and the task, which are already written.
 */
export async function emailRep(admin: SupabaseClient, userId: string | null | undefined, a: Omit<RepAlert, 'link'> & { kind: RecordKind; id: number; key?: string }): Promise<void> {
  try {
    if (!userId) return;
    const from = transactionalFrom();
    if (!from) return;
    const { data } = await admin.from('profiles').select('email').eq('id', userId).maybeSingle();
    const to = String((data as { email?: string } | null)?.email ?? '').trim();
    if (!to) return;
    const mail = repAlertEmail({ ...a, link: recordLink(clozrAppOrigin(), a.kind, a.id) });
    await sendResend({ to, from: from.from, ...mail, ...(a.key ? { idempotencyKey: a.key } : {}), tags: { kind: 'rep_alert' } });
  } catch (e) {
    console.error('rep alert email', String(e));
  }
}
