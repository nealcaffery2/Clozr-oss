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

const NAVY = '#07345C';
const NAVY_SOFT = '#E8EEF4';
const GO = '#0A8560';
const INK = '#2C2C2C';
const MUTE = '#6B7280';
const LINE = '#E3E6EA';
const FONT = "'Source Sans Pro','Helvetica Neue',Helvetica,Arial,sans-serif";

const firstName = (n: unknown) => String(n ?? '').trim().split(/\s+/)[0] || '';
const longDate = (v: unknown) =>
  v ? new Date(String(v)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' }) : '';
const stamp = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Chicago' }) + ' CT' : '';

/** A button Outlook also renders, via the VML fallback it does understand. */
function button(url: string, label: string, color = GO): string {
  const u = esc(url);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td align="center" bgcolor="${color}" style="border-radius:8px;">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${u}" style="height:52px;v-text-anchor:middle;width:300px;" arcsize="16%" stroke="f" fillcolor="${color}"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:17px;font-weight:bold;"><![endif]-->
<a href="${u}" target="_blank" style="display:inline-block;padding:16px 38px;font-family:${FONT};font-size:17px;font-weight:600;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:8px;">${esc(label)}</a>
<!--[if mso]></center></v:roundrect><![endif]-->
</td></tr></table>`;
}

function header(company: MailCompany): string {
  const logo = safeUrl(company.logo);
  const inner = logo
    ? `<img src="${esc(logo)}" width="210" alt="${esc(company.name || 'Home')}" style="display:block;width:210px;max-width:70%;height:auto;border:0;margin:0 auto;">`
    : `<p style="margin:0;font-family:${FONT};font-size:23px;line-height:28px;font-weight:700;color:${NAVY};letter-spacing:1.5px;text-transform:uppercase;">${esc(company.name || 'Acme Homes')}</p>`;
  return `<tr><td align="center" style="padding:26px 30px;border-bottom:4px solid ${NAVY};">${inner}</td></tr>`;
}

function footer(company: MailCompany, why: string): string {
  const bits = [company.address, company.phone, company.email].filter(Boolean).map((b) => esc(b)).join(' &nbsp;·&nbsp; ');
  return `<tr><td class="px" style="padding:26px 30px 30px;background:${NAVY};">
  <p style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;color:#FFFFFF;font-weight:600;">${esc(company.legal || company.name || '')}</p>
  ${bits ? `<p style="margin:5px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:#B9CCE0;">${bits}</p>` : ''}
  <p style="margin:18px 0 0;font-family:${FONT};font-size:11.5px;line-height:18px;color:#B9CCE0;">${esc(why)}</p>
  <p style="margin:10px 0 0;font-family:${FONT};font-size:11.5px;line-height:18px;color:#B9CCE0;">Signatures collected here are legally binding under the U.S. ESIGN Act and UETA. Every view and signature is time-stamped and recorded on a signature certificate attached to the completed document.</p>
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
<!--[if !mso]><!--><link href="https://fonts.googleapis.com/css?family=Source+Sans+Pro:400,600,700" rel="stylesheet"><!--<![endif]-->
<style>
  body,table,td,p,a,h1,h2{font-family:${FONT};}
  a{color:${NAVY};}
  @media only screen and (max-width:600px){
    .wrap{width:100% !important;}
    .px{padding-left:22px !important;padding-right:22px !important;}
    .h1{font-size:23px !important;line-height:30px !important;}
    .stack{display:block !important;width:100% !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F1F1F1;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#F1F1F1;opacity:0;">${esc(preheader)}</div>
<div style="display:none;max-height:0;overflow:hidden;">&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F1F1;">
<tr><td align="center" style="padding:24px 0;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:12px;overflow:hidden;">
${header(company)}
${body}
${footer(company, why)}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** The document, shown the way a receipt shows a line item. */
function docCard(contractName: string, rows: [string, string][]): string {
  const cells = rows.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:3px 0;font-family:${FONT};font-size:13.5px;line-height:20px;color:${MUTE};width:132px;" valign="top">${esc(k)}</td>
      <td style="padding:3px 0;font-family:${FONT};font-size:13.5px;line-height:20px;color:${INK};font-weight:600;" valign="top">${esc(v)}</td></tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAFBFC;border:1px solid ${LINE};border-radius:10px;">
  <tr><td style="padding:18px 20px;">
    <p style="margin:0 0 ${cells ? '12px' : '0'};font-family:${FONT};font-size:17px;line-height:24px;font-weight:700;color:${NAVY};">${esc(contractName)}</p>
    ${cells ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cells}</table>` : ''}
  </td></tr></table>`;
}

// ------------------------------------------------------------- please sign

export type SigningMail = {
  company: MailCompany;
  contractName: string;
  /** What the sender typed for the signers, if anything. */
  message?: string | null;
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

export function signingEmail(m: SigningMail): { subject: string; html: string; text: string } {
  const who = firstName(m.signerName);
  const brand = m.company.name || 'Acme Homes';
  const by = m.expiresAt ? longDate(m.expiresAt) : '';
  const url = safeUrl(m.url) || m.url;
  const subject = m.reminder
    ? `Reminder: ${m.contractName} is waiting for your signature`
    : `${m.contractName} — please review and sign`;
  const preheader = m.reminder
    ? `Still waiting on your signature${by ? `, due ${by}` : ''}. It takes about a minute.`
    : `${brand} sent you a document to sign. It takes about a minute — no account needed.`;

  const waiting = (m.others ?? []).filter((o) => o.status !== 'signed').length;
  const alsoSigned = (m.others ?? []).filter((o) => o.status === 'signed');

  const body = `<tr><td class="px" style="padding:34px 34px 0;">
  <h1 class="h1" style="margin:0;font-family:${FONT};font-size:26px;line-height:33px;font-weight:700;color:${INK};">
    ${m.reminder ? 'A quick reminder' : who ? `${esc(who)}, you have a document to sign` : 'You have a document to sign'}
  </h1>
  <p style="margin:10px 0 0;font-family:${FONT};font-size:16px;line-height:25px;color:${INK};">
    ${esc(brand)} has sent you <strong>${esc(m.contractName)}</strong> to review and sign${m.role ? ` as <strong>${esc(m.role)}</strong>` : ''}.
    There is nothing to download and no account to create — the button below opens your copy in the browser.
  </p>
</td></tr>

${m.message ? `<tr><td class="px" style="padding:20px 34px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${NAVY_SOFT};border-radius:10px;">
    <tr><td style="padding:16px 18px;border-left:4px solid ${NAVY};border-radius:10px;">
      <p style="margin:0 0 5px;font-family:${FONT};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${NAVY};">Message from ${esc(brand)}</p>
      <p style="margin:0;font-family:${FONT};font-size:15px;line-height:23px;color:${INK};">${esc(m.message)}</p>
    </td></tr>
  </table>
</td></tr>` : ''}

<tr><td class="px" style="padding:20px 34px 0;">
  ${docCard(m.contractName, [
    ['Your role', m.role ?? ''],
    ['Sign by', by],
    ['Also signing', alsoSigned.length || waiting ? (m.others ?? []).map((o) => `${o.name || o.label || ''}${o.status === 'signed' ? ' (signed)' : ''}`).filter((s) => s.trim()).join(', ') : ''],
  ])}
</td></tr>

<tr><td class="px" align="center" style="padding:26px 34px 0;">
  ${button(url, 'Review and sign')}
  <p style="margin:14px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTE};">Takes about a minute on a phone or a computer.</p>
</td></tr>

<tr><td class="px" style="padding:24px 34px 0;">
  <p style="margin:0;font-family:${FONT};font-size:12.5px;line-height:20px;color:${MUTE};word-break:break-all;">
    Button not working? Paste this into your browser:<br><a href="${esc(url)}" style="color:${NAVY};">${esc(url)}</a>
  </p>
  <p style="margin:14px 0 0;font-family:${FONT};font-size:12.5px;line-height:20px;color:${MUTE};">
    This link is yours alone — please do not forward it. ${by ? `It stops working after ${esc(by)}.` : ''}
    Questions? Reply to this email${m.company.phone ? ` or call ${esc(m.company.phone)}` : ''}.
  </p>
</td></tr>

<tr><td class="px" style="padding:26px 34px 30px;"><div style="height:1px;background:${LINE};line-height:1px;font-size:1px;">&nbsp;</div></td></tr>`;

  const contact = [m.company.address, m.company.phone, m.company.email].filter(Boolean).join(' · ');
  const text = ([
    m.reminder ? 'A quick reminder.' : who ? `${who},` : 'Hello,',
    '',
    `${brand} has sent you "${m.contractName}" to review and sign${m.role ? ` as ${m.role}` : ''}.`,
    m.message ? '' : null,
    m.message ? `Message from ${brand}: ${m.message}` : null,
    by ? '' : null,
    by ? `Please sign by ${by}.` : null,
    '',
    'Open your document:',
    url,
    '',
    'This link is yours alone — please do not forward it.',
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
  const subject = `Signed: ${m.contractName}`;
  const preheader = `Everyone has signed ${m.contractName}. Your completed copy is ready.`;

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
  <h1 class="h1" style="margin:0;font-family:${FONT};font-size:26px;line-height:33px;font-weight:700;color:${INK};">Fully signed</h1>
  <p style="margin:10px 0 0;font-family:${FONT};font-size:16px;line-height:25px;color:${INK};">
    ${who ? `${esc(who)}, every` : 'Every'} party has now signed <strong>${esc(m.contractName)}</strong>.
    Your completed copy includes the signature certificate — who signed, when, and from where.
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
    ...m.signers.map((s) => `  ${s.name || s.label || ''} — ${stamp(s.signedAt) || 'signed'}`),
    m.sha256 ? '' : null,
    m.sha256 ? `Document fingerprint (SHA-256): ${m.sha256}` : null,
    '',
    m.company.legal || brand,
  ] as (string | null)[]).filter((l): l is string => l !== null).join('\n');

  return { subject, html: shell(preheader, m.company, body, `You are receiving this because you signed a document sent by ${brand}.`), text };
}

export { inviteEmail, type InviteMail } from './invite-email.ts';
