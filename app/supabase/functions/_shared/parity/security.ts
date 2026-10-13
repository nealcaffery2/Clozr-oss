// Two holes the audit found in the deployed esign function, closed here.
//
// 1. Origin injection. esign builds the NEXT signer's emailed link from
//    `b.origin || req.headers.get('origin')`. A signer could post any origin
//    and the next recipient would get a real token on a foreign domain.
//    safeOrigin() only ever returns an allow-listed Clozr origin.
//
// 2. Access codes were switched off (`const requireGate = () => null`).
//    makeGate() enforces them when the contract or the signer asks for it
//    (PandaDoc "recipient authentication": passcode / SMS), and keeps the old
//    link-only behavior otherwise.

import { CLOZR_APP_ORIGIN, sanitizeClozrOrigin } from '../app-url.ts';
import { gateOk } from '../esign-session.ts';

/** Comma separated extra hosts in DOCS_ALLOWED_ORIGINS, e.g. "https://app.clozr.com,https://clozr-preview.example.com". */
function allowed(): Set<string> {
  const list = [CLOZR_APP_ORIGIN, Deno.env.get('APP_URL'), Deno.env.get('SITE_URL'), ...(Deno.env.get('DOCS_ALLOWED_ORIGINS') ?? '').split(',')]
    .map((s) => sanitizeClozrOrigin(s)).filter(Boolean);
  return new Set(list);
}

export function safeOrigin(...candidates: unknown[]): string {
  const ok = allowed();
  for (const c of candidates) {
    const s = sanitizeClozrOrigin(c);
    if (!s) continue;
    // Local dev: list http://localhost:3000 in DOCS_ALLOWED_ORIGINS. A request
    // body naming localhost is not trusted on its own.
    if (ok.has(s)) return s;
  }
  return sanitizeClozrOrigin(Deno.env.get('APP_URL')) || CLOZR_APP_ORIGIN;
}

type GateSigner = {
  auth_mode?: string | null;
  email?: string | null;
  phone?: string | null;
  access_gate?: string | null;
  email_verified_at?: string | null;
  phone_verified_at?: string | null;
};

/** Which code this recipient must enter before anything but view/request_code/unlock. */
export function authNeeded(contract: { require_access_code?: boolean | null }, signer: GateSigner): 'none' | 'email_code' | 'sms_code' {
  const mode = String(signer.auth_mode ?? 'link');
  if (mode === 'sms_code') return 'sms_code';
  if (mode === 'email_code') return 'email_code';
  if (contract.require_access_code) return signer.email ? 'email_code' : (signer.phone ? 'sms_code' : 'none');
  return 'none';
}

/**
 * Returns a function with the same shape esign already calls
 * (`const denied = requireGate(); if (denied) return denied;`).
 */
export function makeGate(
  contract: { require_access_code?: boolean | null },
  signer: GateSigner,
  givenGate: unknown,
  deny: (body: unknown, status: number) => Response,
): () => Response | null {
  return () => {
    const need = authNeeded(contract, signer);
    if (need === 'none') return null;
    const verified = need === 'sms_code' ? !!signer.phone_verified_at : !!signer.email_verified_at;
    const sameGate = !!signer.access_gate && String(givenGate ?? '') === signer.access_gate;
    if (verified && sameGate) return null;
    if (need === 'email_code' && gateOk({ email: signer.email ?? null, access_gate: signer.access_gate ?? null, email_verified_at: signer.email_verified_at ?? null }, givenGate)) return null;
    return deny({ locked: true, auth: need, error: need === 'sms_code' ? 'Enter the code we text you to open this document.' : 'Enter the code we email you to open this document.' }, 401);
  };
}
