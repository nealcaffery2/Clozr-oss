/**
 * Smoke test for the CLOZR teammate invite template. Run with:
 *   deno test app/supabase/functions/_shared/invite-email.test.ts
 */
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { inviteEmail } from './invite-email.ts';

Deno.test('inviteEmail includes temp password and CLOZR branding', () => {
  const mail = inviteEmail({
    toName: 'Drew Collins',
    email: 'chris@yourcompany.com',
    workspaceName: "Sam's workspace",
    roleLabel: 'Acquisitions',
    invitedByName: 'Sam',
    tempPassword: 'AbCdEfGh234567',
    loginUrl: 'https://your-clozr-site.example.com/login',
  });
  assertEquals(mail.subject, "You're invited to Sam's workspace on CLOZR");
  assertStringIncludes(mail.html, 'CLOZR');
  assertStringIncludes(mail.html, 'AbCdEfGh234567');
  assertStringIncludes(mail.html, 'Sign in to CLOZR');
  assertStringIncludes(mail.html, 'https://your-clozr-site.example.com/login');
  assertStringIncludes(mail.text, 'Temporary password: AbCdEfGh234567');
  assertStringIncludes(mail.html, '#0BA97A');
});

Deno.test('inviteEmail resend subject when flagged', () => {
  const mail = inviteEmail({
    email: 'morgan@yourcompany.com',
    workspaceName: "Sam's workspace",
    roleLabel: 'Dispositions',
    invitedByName: 'Sam',
    tempPassword: 'XyZ987654321ab',
    loginUrl: 'https://your-clozr-site.example.com/login',
    resend: true,
  });
  assertEquals(mail.subject, "Your CLOZR sign-in for Sam's workspace");
  assertStringIncludes(mail.html, 'here is your CLOZR sign-in');
});

Deno.test('inviteEmail rewrites Talkr loginUrl to Clozr production', () => {
  const mail = inviteEmail({
    email: 'chris@yourcompany.com',
    workspaceName: "Sam's workspace",
    roleLabel: 'Acquisitions',
    invitedByName: 'Sam',
    tempPassword: 'AbCdEfGh234567',
    loginUrl: 'https://talkrdialer.com/login',
  });
  assertStringIncludes(mail.html, 'https://your-clozr-site.example.com/login');
  assertEquals(mail.html.includes('talkrdialer.com'), false);
  assertEquals(mail.text.includes('talkrdialer.com'), false);
});
