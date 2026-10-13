/**
 * CLOZR-branded teammate invite email. Separate from the Acme Homes contract
 * mail in emails.ts so product invites stay on CLOZR mint, not company navy.
 */

import { CLOZR_APP_ORIGIN, sanitizeClozrOrigin } from './app-url.ts';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** A URL is only safe to put in href/src if it is plainly http(s) and not Talkr. */
const safeLoginUrl = (u: unknown): string => {
  const s = String(u ?? '').trim();
  if (!/^https:\/\/[^\s"'<>]+$/i.test(s) && !/^http:\/\/[^\s"'<>]+$/i.test(s)) {
    return `${CLOZR_APP_ORIGIN}/login`;
  }
  // Strip path/query for host check, then rebuild login URL on a Clozr origin.
  try {
    const origin = sanitizeClozrOrigin(new URL(s).origin);
    return origin ? `${origin}/login` : `${CLOZR_APP_ORIGIN}/login`;
  } catch {
    return `${CLOZR_APP_ORIGIN}/login`;
  }
};

const firstName = (n: unknown) => String(n ?? '').trim().split(/\s+/)[0] || '';

const CZ_MINT = '#0BA97A';
const CZ_MINT_SOFT = '#E7F8F1';
const CZ_INK = '#18181b';
const CZ_MUTE = '#71717a';
const CZ_LINE = '#e4e4e7';
const CZ_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export type InviteMail = {
  /** Person being invited. */
  toName?: string | null;
  email: string;
  /** Workspace they join. */
  workspaceName: string;
  /** Human role label, e.g. "Acquisitions". */
  roleLabel: string;
  /** Who invited them. */
  invitedByName?: string | null;
  /** One-time password; omit when they already have an account and should use it. */
  tempPassword?: string | null;
  /** Absolute URL to /login. */
  loginUrl: string;
  /** True when this is a re-send rather than the first invite. */
  resend?: boolean;
};

/**
 * CLOZR-branded teammate invite. Carries the one-time password when we created
 * (or reset) their account; the admin also sees that password once in Settings.
 */
export function inviteEmail(m: InviteMail): { subject: string; html: string; text: string } {
  const who = firstName(m.toName) || firstName(m.email.split('@')[0]);
  const by = (m.invitedByName ?? '').trim() || 'Your team';
  const login = safeLoginUrl(m.loginUrl);
  const hasPass = !!(m.tempPassword && m.tempPassword.trim());
  const subject = m.resend
    ? `Your CLOZR sign-in for ${m.workspaceName}`
    : `You're invited to ${m.workspaceName} on CLOZR`;
  const preheader = hasPass
    ? `${by} added you to ${m.workspaceName}. Your temporary password is inside.`
    : `${by} added you to ${m.workspaceName} on CLOZR. Sign in to get started.`;

  const passBlock = hasPass ? `<tr><td class="px" style="padding:22px 34px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CZ_MINT_SOFT};border:1px solid #bbf7d0;border-radius:12px;">
    <tr><td style="padding:18px 20px;">
      <p style="margin:0 0 6px;font-family:${CZ_FONT};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${CZ_MINT};">Temporary password</p>
      <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:20px;line-height:28px;font-weight:700;letter-spacing:0.06em;color:${CZ_INK};">${esc(m.tempPassword)}</p>
      <p style="margin:10px 0 0;font-family:${CZ_FONT};font-size:13px;line-height:20px;color:${CZ_MUTE};">Sign in with this once, then change it under Account → Password.</p>
    </td></tr>
  </table>
</td></tr>` : '';

  const body = `<tr><td class="px" style="padding:34px 34px 0;">
  <h1 style="margin:0;font-family:${CZ_FONT};font-size:26px;line-height:33px;font-weight:700;color:${CZ_INK};">
    ${m.resend ? (who ? `${esc(who)}, here is your CLOZR sign-in` : 'Here is your CLOZR sign-in') : (who ? `${esc(who)}, you are on CLOZR` : 'You are on CLOZR')}
  </h1>
  <p style="margin:10px 0 0;font-family:${CZ_FONT};font-size:16px;line-height:25px;color:${CZ_INK};">
    ${esc(by)} added you to <strong>${esc(m.workspaceName)}</strong> as <strong>${esc(m.roleLabel)}</strong>.
    ${hasPass ? 'Use the temporary password below to sign in.' : 'Sign in with the CLOZR account you already have.'}
  </p>
</td></tr>

<tr><td class="px" style="padding:20px 34px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FAFBFC;border:1px solid ${CZ_LINE};border-radius:10px;">
    <tr><td style="padding:16px 18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding:3px 0;font-family:${CZ_FONT};font-size:13.5px;color:${CZ_MUTE};width:120px;">Workspace</td><td style="padding:3px 0;font-family:${CZ_FONT};font-size:13.5px;font-weight:600;color:${CZ_INK};">${esc(m.workspaceName)}</td></tr>
        <tr><td style="padding:3px 0;font-family:${CZ_FONT};font-size:13.5px;color:${CZ_MUTE};">Role</td><td style="padding:3px 0;font-family:${CZ_FONT};font-size:13.5px;font-weight:600;color:${CZ_INK};">${esc(m.roleLabel)}</td></tr>
        <tr><td style="padding:3px 0;font-family:${CZ_FONT};font-size:13.5px;color:${CZ_MUTE};">Email</td><td style="padding:3px 0;font-family:${CZ_FONT};font-size:13.5px;font-weight:600;color:${CZ_INK};">${esc(m.email)}</td></tr>
      </table>
    </td></tr>
  </table>
</td></tr>

${passBlock}

<tr><td class="px" align="center" style="padding:26px 34px 0;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td align="center" bgcolor="${CZ_MINT}" style="border-radius:10px;">
  <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(login)}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="20%" stroke="f" fillcolor="${CZ_MINT}"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;"><![endif]-->
  <a href="${esc(login)}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${CZ_FONT};font-size:16px;font-weight:600;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:10px;">Sign in to CLOZR</a>
  <!--[if mso]></center></v:roundrect><![endif]-->
  </td></tr></table>
  <p style="margin:14px 0 0;font-family:${CZ_FONT};font-size:12.5px;line-height:20px;color:${CZ_MUTE};word-break:break-all;">
    Or open <a href="${esc(login)}" style="color:${CZ_MINT};">${esc(login)}</a>
  </p>
</td></tr>

<tr><td class="px" style="padding:26px 34px 30px;">
  <div style="height:1px;background:${CZ_LINE};line-height:1px;font-size:1px;">&nbsp;</div>
  <p style="margin:18px 0 0;font-family:${CZ_FONT};font-size:12.5px;line-height:20px;color:${CZ_MUTE};">
    Questions? Reply to this email or ask ${esc(by)}.
  </p>
</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  body,table,td,p,a,h1{font-family:${CZ_FONT};}
  a{color:${CZ_MINT};}
  @media only screen and (max-width:600px){
    .wrap{width:100% !important;}
    .px{padding-left:22px !important;padding-right:22px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F4F4F5;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#F4F4F5;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F4F4F5;">
<tr><td align="center" style="padding:28px 0;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#FFFFFF;border-radius:14px;overflow:hidden;">
<tr><td align="center" style="padding:28px 30px 18px;border-bottom:3px solid ${CZ_MINT};">
  <p style="margin:0;font-family:${CZ_FONT};font-size:22px;line-height:28px;font-weight:800;letter-spacing:0.14em;color:${CZ_INK};">CLOZR</p>
  <p style="margin:6px 0 0;font-family:${CZ_FONT};font-size:11px;line-height:14px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${CZ_MINT};">The CRM that closes</p>
</td></tr>
${body}
<tr><td style="padding:18px 30px 24px;background:#18181b;">
  <p style="margin:0;font-family:${CZ_FONT};font-size:12px;line-height:18px;color:#a1a1aa;">You are receiving this because ${esc(by)} invited you to ${esc(m.workspaceName)} on CLOZR.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = ([
    who ? `${who},` : 'Hello,',
    '',
    `${by} added you to ${m.workspaceName} on CLOZR as ${m.roleLabel}.`,
    '',
    hasPass ? `Temporary password: ${m.tempPassword}` : 'Sign in with the CLOZR account you already have.',
    hasPass ? 'Sign in once, then change it under Account → Password.' : null,
    '',
    `Sign in: ${login}`,
    '',
    '— CLOZR',
  ] as (string | null)[]).filter((l): l is string => l !== null).join('\n');

  return { subject, html, text };
}
