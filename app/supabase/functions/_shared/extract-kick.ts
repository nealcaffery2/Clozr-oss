// Ask docs-extract to read a contract's terms, without waiting for it.
// Completion calls this: the signer's "done" screen must not sit behind a
// Claude call, and a failed read only reaches the log (and the contract's
// extract_status, which docs-extract sets itself).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

export function kickExtraction(contractId: number | string | null | undefined): void {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!contractId || !url || !key) return;
  const p = fetch(`${url.replace(/\/$/, '')}/functions/v1/docs-extract`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'extract', contract_id: Number(contractId) }),
  }).then(async (r) => {
    if (!r.ok) console.error('docs-extract', contractId, r.status, (await r.text()).slice(0, 200));
    else await r.body?.cancel();
  }).catch((e) => console.error('docs-extract', contractId, e instanceof Error ? e.message : String(e)));
  try { if (typeof EdgeRuntime !== 'undefined') EdgeRuntime?.waitUntil(p); } catch { /* it still runs */ }
}
