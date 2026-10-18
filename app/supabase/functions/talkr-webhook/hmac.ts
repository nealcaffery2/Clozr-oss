// Talkr's webhook signature: HMAC-SHA256 hex, compared in constant time.
// Pure, so tools/talkr-hmac.test.ts runs it under tsx.

const enc = new TextEncoder();

/**
 * Imported keys by secret, for the life of the isolate. Keyed by the secret
 * itself, so a rotated secret gets its own key and the old one is never used
 * for it. A failed import is dropped, so the next delivery tries again.
 */
const keys = new Map<string, Promise<CryptoKey>>();

export function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    key.catch(() => keys.delete(secret));
    keys.set(secret, key);
  }
  return key;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent compare, so a wrong signature leaks no timing signal. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
