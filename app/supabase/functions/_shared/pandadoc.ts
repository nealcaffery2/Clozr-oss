/** PandaDoc's REST API with the project key (PANDADOC_API_KEY). Shared by the pandadoc and offers functions. */
export const BASE = 'https://api.pandadoc.com/public/v1';
export class PdError extends Error { constructor(msg: string, public status: number) { super(msg); } }

export async function pd<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const key = (Deno.env.get('PANDADOC_API_KEY') ?? '').trim();
  if (!key) throw new PdError('PandaDoc is not connected: set the PANDADOC_API_KEY secret on the Supabase project.', 503);
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { Authorization: `API-Key ${key}`, Accept: raw ? '*/*' : 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 200);
    try { const j = JSON.parse(text); detail = j.detail ?? j.message ?? detail; } catch { /* text */ }
    if (res.status === 401 || res.status === 403) throw new PdError('PandaDoc rejected the key — check PANDADOC_API_KEY on the Supabase project.', 502);
    throw new PdError(`PandaDoc ${res.status}: ${detail}`, res.status >= 500 ? 502 : 400);
  }
  if (raw) return (await res.arrayBuffer()) as unknown as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const status = (s: string | undefined) => (s ?? '').replace(/^document\./, '') || 'draft';

/** Prefer an offer/LOI template, then a PSA, then the first one PandaDoc lists. */
export function pickPandaDocTemplate<T extends { id: string; name: string }>(
  templates: T[],
  preferredId?: string | null,
): T | null {
  if (preferredId) {
    const hit = templates.find((t) => t.id === preferredId);
    if (hit) return hit;
  }
  if (!templates.length) return null;
  const score = (n: string) => {
    const s = n.toLowerCase();
    if (/cash offer|offer letter|letter of intent|\bloi\b/.test(s)) return 5;
    if (/\boffer\b/.test(s)) return 4;
    if (/psa|purchase agreement|purchase and sale/.test(s)) return 3;
    if (/assignment|wholesale/.test(s)) return 2;
    return 1;
  };
  return [...templates].sort((a, b) => score(b.name) - score(a.name) || a.name.localeCompare(b.name))[0];
}
