/**
 * The two emails the contract engine sends: "please sign this" and "everyone
 * signed it".
 *
 * They are written the way email has to be written rather than the way a page
 * is — nested tables, inline styles, no flexbox, no external CSS — because
 * Outlook renders with Word and Gmail strips <style> blocks it does not like.
 * The one media query is the only progressive part, and the layout is correct
 * without it.
 *
 * Branding comes from the workspace's own company settings, so a second
 * workspace does not send mail wearing the first one's name. `logo` is a URL
 * when the workspace has one; otherwise the header is a typographic lockup,
 * which is better than a broken image.
 */

export type MailCompany = {
  name?: string; legal?: string; address?: string; signer?: string; title?: string;
  email?: string; phone?: string; logo?: string;
};

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** A URL is only safe to put in href/src if it is plainly http(s). */
const safeUrl = (u: unknown): string => {
  const s = String(u ?? '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) || /^http:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
};

// Acme Homes brand kit (acme-homes-site/brand-kit/BRAND-KIT.md): navy structure,
// warm off-white page, slate text, and orange for the one thing to press.
const NAVY = '#0B1F3A';
const NAVY_SOFT = '#EEF2F7';
const GO = '#0A8560';
/** The one action. White on it holds 3.6:1, AA for the 20px bold label (large text). */
const ACT = '#E8590C';
const INK = '#1E293B';
const MUTE = '#64748B';
const LINE = '#E2E8F0';
const PAGE = '#F8F8F6';
const FONT = "'DM Sans',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const firstName = (n: unknown) => String(n ?? '').trim().split(/\s+/)[0] || '';
const longDate = (v: unknown) =>
  v ? new Date(String(v)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }) : '';
const stamp = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago' }) + ' CT' : '';

/** A button Outlook also renders, via the VML fallback it does understand. */
function button(url: string, label: string, color = GO): string {
  const u = esc(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td align="center" bgcolor="${color}" style="border-radius:10px;">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${u}" style="height:52px;v-text-anchor:middle;width:300px;" arcsize="19%" stroke="f" fillcolor="${color}"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:17px;font-weight:bold;"><![endif]-->
<a href="${u}" target="_blank" style="display:inline-block;padding:16px 38px;font-family:${FONT};font-size:17px;font-weight:700;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:10px;">${esc(label)}</a>
<!--[if mso]></center></v:roundrect><![endif]-->
</td></tr></table>`;
}

function header(company: MailCompany): string {
  const logo = safeUrl(company.logo);
  const inner = logo
    ? `<img src="${esc(logo)}" width="168" alt="${esc(company.name || 'Acme Homes')}" style="display:block;width:200px;max-width:60%;height:auto;border:0;margin:0 auto;">`
    : `<p style="margin:0;font-family:${FONT};font-size:20px;line-height:24px;font-weight:700;color:${NAVY};letter-spacing:-0.01em;">${esc(company.name || 'Acme Homes')}</p>`;
  return `<tr><td class="px" align="center" style="padding:24px 34px 22px;">${inner}</td></tr>`;
}

function footer(company: MailCompany, why: string): string {
  const bits = [company.address, company.phone, company.email].filter(Boolean).map((b) => esc(b)).join('<br>');
  return `<tr><td class="px" style="padding:24px 36px 28px;background:${NAVY};">
  <p style="margin:0;font-family:${FONT};font-size:13.5px;line-height:20px;color:#FFFFFF;font-weight:700;">${esc(company.legal || company.name || '')}</p>
  ${bits ? `<p style="margin:4px 0 0;font-family:${FONT};font-size:12.5px;line-height:19px;color:#AEBBCD;">${bits}</p>` : ''}
  <p style="margin:16px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:#AEBBCD;">${esc(why)} Signatures collected here are legally binding under the U.S. ESIGN Act and UETA; every view and signature is time-stamped on a certificate attached to the completed document.</p>
</td></tr>`;
}

function shell(preheader: string, company: MailCompany, body: string, why: string): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<!--[if !mso]><!--><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet"><!--<![endif]-->
<style>
  body,table,td,p,a,h1,h2{font-family:${FONT};}
  a{color:${NAVY};}
  @media only screen and (max-width:600px){
    .wrap{width:100% !important;border-radius:0 !important;}
    .px{padding-left:22px !important;padding-right:22px !important;}
    .h1{font-size:24px !important;line-height:30px !important;}
    .stack{display:block !important;width:100% !important;padding:0 0 10px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${PAGE};opacity:0;">${esc(preheader)}</div>
<div style="display:none;max-height:0;overflow:hidden;">&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};">
<tr><td align="center" style="padding:28px 0;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;border:1px solid ${LINE};border-radius:16px;overflow:hidden;">
${header(company)}
${body}
${footer(company, why)}
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ------------------------------------------------------------- please sign

export type SigningMail = {
  company: MailCompany;
  contractName: string;
  /** What the sender typed for the signers, if anything. */
  message?: string | null;
  /** The rep who sent it, so the request reads as coming from a person. */
  senderName?: string | null;
  signerName?: string | null;
  /** How this signer is described on the document — "Seller", "Buyer". */
  role?: string | null;
  url: string;
  expiresAt?: string | null;
  /** The other parties, so a signer can see who else is on it. */
  others?: { name?: string | null; label?: string | null; status?: string }[];
  /** True when this is a nudge rather than the first ask. */
  reminder?: boolean;
};

/** The one call to action on a signing request: wide, tall and orange, so nobody hunts for it. */
function signButton(url: string, label: string): string {
  const u = esc(url);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${ACT}" style="border-radius:12px;background:${ACT};">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${u}" style="height:64px;v-text-anchor:middle;width:532px;" arcsize="19%" stroke="f" fillcolor="${ACT}"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:20px;font-weight:bold;"><![endif]-->
<a href="${u}" target="_blank" style="display:block;padding:21px 24px;font-family:${FONT};font-size:20px;font-weight:700;line-height:22px;color:#FFFFFF;text-decoration:none;border-radius:12px;letter-spacing:0.2px;">${esc(label)} &rarr;</a>
<!--[if mso]></center></v:roundrect><![endif]-->
</td></tr></table>`;
}

/** A page drawn in table cells: reads as "a document" in every client, no image to block. */
function docGlyph(): string {
  const bar = (w: number) => `<div style="height:4px;width:${w}px;background:#D5DBE3;border-radius:2px;margin:0 0 5px;font-size:1px;line-height:1px;">&nbsp;</div>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="46"><tr><td width="46" height="58" valign="top" style="width:46px;height:58px;background:#FFFFFF;border:1px solid #D5DBE3;border-top:4px solid ${ACT};border-radius:4px;padding:10px 8px 0;">
  ${bar(28)}${bar(22)}${bar(28)}${bar(16)}</td></tr></table>`;
}

/** Plain text a person typed, kept to their own line breaks. */
const paras = (s: string) => esc(s.trim()).replace(/\r?\n/g, '<br>');

export function signingEmail(m: SigningMail): { subject: string; html: string; text: string } {
  const who = firstName(m.signerName);
  const brand = m.company.name || 'Acme Homes';
  const sender = String(m.senderName ?? '').trim();
  const from = sender ? `${sender} at ${brand}` : brand;
  const by = m.expiresAt ? longDate(m.expiresAt) : '';
  const url = safeUrl(m.url) || m.url;
  const message = String(m.message ?? '').trim();
  const subject = m.reminder
    ? `Reminder: please sign ${m.contractName}`
    : `Signature requested: ${m.contractName}`;
  const preheader = message
    ? `${sender || brand}: ${message.replace(/\s+/g, ' ').slice(0, 110)}`
    : m.reminder
      ? `Still waiting on your signature${by ? `, due ${by}` : ''}. It takes about two minutes.`
      : `${from} is requesting your signature. It takes about two minutes, no account needed.`;

  const others = (m.others ?? []).map((o) => `${o.name || o.label || ''}${o.status === 'signed' ? ' (signed)' : ''}`).filter((s) => s.trim()).join(', ');
  const meta = [m.role ? `Signing as <strong style="color:${INK};">${esc(m.role)}</strong>` : '', by ? `Sign by <strong style="color:${INK};">${esc(by)}</strong>` : '']
    .filter(Boolean).join(' &nbsp;&middot;&nbsp; ');
  const step = (n: number, label: string) => `<td class="stack" width="33%" valign="top" style="padding:0 4px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="26" height="26" align="center" valign="middle" style="width:26px;height:26px;border-radius:13px;background:${NAVY_SOFT};font-family:${FONT};font-size:13px;font-weight:700;color:${NAVY};">${n}</td>
      <td style="padding-left:8px;font-family:${FONT};font-size:13.5px;line-height:18px;color:${INK};font-weight:600;">${label}</td>
    </tr></table></td>`;

  const body = `<tr><td class="px" style="padding:30px 34px 28px;background:${NAVY};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#C2410C;border-radius:20px;padding:6px 13px;font-family:${FONT};font-size:11.5px;line-height:14px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#FFFFFF;">${m.reminder ? 'Reminder &middot; Signature needed' : 'Signature requested'}</td></tr></table>
  <h1 class="h1" style="margin:16px 0 0;font-family:${FONT};font-size:28px;line-height:35px;font-weight:700;letter-spacing:-0.01em;color:#FFFFFF;">
    ${m.reminder ? `${who ? `${esc(who)}, this` : 'This'} is still waiting for your signature` : `${who ? `${esc(who)}, please` : 'Please'} review and sign`}
  </h1>
  <p style="margin:10px 0 22px;font-family:${FONT};font-size:16px;line-height:24px;color:#C9D6E6;">
    <strong style="color:#FFFFFF;">${esc(from)}</strong> ${m.reminder ? 'sent you this document and it still needs your signature.' : 'is requesting your signature on this document.'}
  </p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border-radius:12px;">
    <tr><td style="padding:18px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="46" valign="top">${docGlyph()}</td>
        <td valign="middle" style="padding-left:16px;">
          <p style="margin:0;font-family:${FONT};font-size:18px;line-height:24px;font-weight:700;color:${NAVY};">${esc(m.contractName)}</p>
          ${meta ? `<p style="margin:5px 0 0;font-family:${FONT};font-size:13.5px;line-height:20px;color:${MUTE};">${meta}</p>` : ''}
          ${others ? `<p style="margin:3px 0 0;font-family:${FONT};font-size:13.5px;line-height:20px;color:${MUTE};">Also signing: ${esc(others)}</p>` : ''}
        </td>
      </tr></table>
    </td></tr>
  </table>
</td></tr>

${message ? `<tr><td class="px" style="padding:28px 34px 0;">
  <p style="margin:0 0 10px;font-family:${FONT};font-size:12px;line-height:14px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${MUTE};">Message from ${esc(sender || brand)}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="4" style="width:4px;background:${ACT};border-radius:2px;font-size:1px;line-height:1px;">&nbsp;</td>
    <td style="padding:2px 0 2px 16px;font-family:${FONT};font-size:17px;line-height:27px;color:${INK};">${paras(message)}</td>
  </tr></table>
</td></tr>` : ''}

<tr><td class="px" align="center" style="padding:30px 34px 0;">
  ${signButton(url, m.reminder ? 'Sign now' : 'Review & sign')}
  <p style="margin:12px 0 0;font-family:${FONT};font-size:13.5px;line-height:20px;color:${MUTE};">About two minutes. No account or download needed, works on your phone.</p>
</td></tr>

<tr><td class="px" style="padding:26px 30px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${LINE};"><tr><td style="padding-top:20px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      ${step(1, 'Open the document')}${step(2, 'Review each page')}${step(3, 'Tap to sign')}
    </tr></table>
  </td></tr></table>
</td></tr>

<tr><td class="px" style="padding:24px 34px 30px;">
  <p style="margin:0;font-family:${FONT};font-size:12.5px;line-height:20px;color:${MUTE};word-break:break-all;">
    Button not working? Paste this into your browser:<br><a href="${esc(url)}" style="color:${NAVY};">${esc(url)}</a>
  </p>
  <p style="margin:12px 0 0;font-family:${FONT};font-size:12.5px;line-height:20px;color:${MUTE};">
    This link is yours alone, please do not forward it.${by ? ` It stops working after ${esc(by)}.` : ''}
    Questions? Reply to this email${m.company.phone ? ` or call ${esc(m.company.phone)}` : ''}.
  </p>
</td></tr>`;

  const contact = [m.company.address, m.company.phone, m.company.email].filter(Boolean).join(' · ');
  const text = ([
    m.reminder ? 'REMINDER: SIGNATURE NEEDED' : 'SIGNATURE REQUESTED',
    '',
    who ? `${who},` : 'Hello,',
    '',
    `${from} ${m.reminder ? 'is still waiting on your signature for' : 'is requesting your signature on'} "${m.contractName}"${m.role ? ` (signing as ${m.role})` : ''}.`,
    message ? '' : null,
    message ? `Message from ${sender || brand}:` : null,
    message || null,
    by ? '' : null,
    by ? `Please sign by ${by}.` : null,
    '',
    'Review and sign here:',
    url,
    '',
    'This link is yours alone, please do not forward it.',
    '',
    m.company.legal || brand,
    contact || null,
  ] as (string | null)[]).filter((l): l is string => l !== null).join('\n');

  return { subject, html: shell(preheader, m.company, body, `You are receiving this because ${brand} sent you a document to sign.`), text };
}

// -------------------------------------------------------------- all signed

export type CompletedMail = {
  company: MailCompany;
  contractName: string;
  recipientName?: string | null;
  /** A time-boxed link to the signed PDF, when one could be minted. */
  pdfUrl?: string | null;
  /** The permanent signing link, which always serves the latest copy. */
  url?: string | null;
  signers: { name?: string | null; label?: string | null; signedAt?: string | null }[];
  sha256?: string | null;
};

export function completedEmail(m: CompletedMail): { subject: string; html: string; text: string } {
  const brand = m.company.name || 'Acme Homes';
  const who = firstName(m.recipientName);
  const link = safeUrl(m.pdfUrl ?? '') || safeUrl(m.url ?? '') || '';
  const subject = `All parties have signed: ${m.contractName}`;
  const preheader = `Thank you. ${m.contractName} is fully executed; the signed contract and the audit trail are attached.`;

  const rows = m.signers.map((s) => `<tr>
    <td style="padding:9px 0;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:14px;line-height:20px;color:${INK};font-weight:600;" valign="top">
      ${esc(s.name || s.label || '')}${s.label && s.name ? `<span style="display:block;font-weight:400;font-size:12.5px;color:${MUTE};">${esc(s.label)}</span>` : ''}
    </td>
    <td align="right" style="padding:9px 0;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:12.5px;line-height:20px;color:${MUTE};" valign="top">${esc(stamp(s.signedAt) || 'Signed')}</td>
  </tr>`).join('');

  const body = `<tr><td class="px" align="center" style="padding:34px 34px 0;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 16px;"><tr>
    <td align="center" valign="middle" width="58" height="58" bgcolor="#E7F8F1" style="width:58px;height:58px;border-radius:29px;font-family:${FONT};font-size:28px;line-height:58px;color:${GO};">&#10003;</td>
  </tr></table>
  <h1 class="h1" style="margin:0;font-family:${FONT};font-size:26px;line-height:33px;font-weight:700;color:${INK};">All parties have signed</h1>
  <p style="margin:10px 0 0;font-family:${FONT};font-size:16px;line-height:25px;color:${INK};">
    Thank you${who ? `, ${esc(who)}` : ''}. Every party has signed <strong>${esc(m.contractName)}</strong>.
    The fully executed contract and a separate audit trail (who signed, when, and from where) are attached to this email.
  </p>
</td></tr>

${link ? `<tr><td class="px" align="center" style="padding:26px 34px 0;">
  ${button(link, 'Download the signed copy', NAVY)}
  ${m.pdfUrl ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:12.5px;line-height:20px;color:${MUTE};">This download link expires shortly for your security.${m.url ? ` Your signing link always has the latest copy.` : ''}</p>` : ''}
</td></tr>` : ''}

<tr><td class="px" style="padding:26px 34px 0;">
  <p style="margin:0 0 6px;font-family:${FONT};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${MUTE};">Signed by</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
  ${m.sha256 ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:11.5px;line-height:18px;color:${MUTE};word-break:break-all;">Document fingerprint (SHA-256): ${esc(m.sha256)}</p>` : ''}
</td></tr>

<tr><td class="px" style="padding:26px 34px 30px;"><div style="height:1px;background:${LINE};line-height:1px;font-size:1px;">&nbsp;</div></td></tr>`;

  const text = ([
    who ? `${who},` : 'Hello,',
    '',
    `Every party has now signed "${m.contractName}".`,
    '',
    ...(link ? ['Download your completed copy:', link, ''] : []),
    'Signed by:',
    ...m.signers.map((s) => `  ${s.name || s.label || ''}: ${stamp(s.signedAt) || 'signed'}`),
    m.sha256 ? '' : null,
    m.sha256 ? `Document fingerprint (SHA-256): ${m.sha256}` : null,
    '',
    m.company.legal || brand,
  ] as (string | null)[]).filter((l): l is string => l !== null).join('\n');

  return { subject, html: shell(preheader, m.company, body, `You are receiving this because you signed a document sent by ${brand}.`), text };
}

export { inviteEmail, type InviteMail } from './invite-email.ts';
