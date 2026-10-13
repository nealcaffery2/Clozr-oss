/**
 * After a signer hands their signature to someone else (esign `delegate`), or
 * the sender reassigns a recipient (docs-plus `reassign`).
 *
 * The new recipient row already holds the old one's role, sort and recipient
 * type, and the old row is closed as `delegated`. Everything keyed on the
 * recipient id moves here:
 *   - contract_fields the old recipient had NOT filled move to the new one
 *     (values already filled stay with the person who filled them, which is
 *     what the audit trail says happened);
 *   - contract_attachments not yet tied to a filled field move too.
 *
 * Replaces the no-op that shipped in _shared/delegate.ts.
 */
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export async function onDelegated(admin: SupabaseClient, oldId: number, newId: number): Promise<void> {
  const { error: fErr } = await admin.from('contract_fields')
    .update({ signer_id: newId, updated_at: new Date().toISOString() })
    .eq('signer_id', oldId)
    .is('filled_at', null);
  if (fErr) console.error('delegate fields', fErr.message);

  const { error: aErr } = await admin.from('contract_attachments')
    .update({ signer_id: newId })
    .eq('signer_id', oldId)
    .is('field_id', null);
  if (aErr && !/does not exist/.test(aErr.message)) console.error('delegate attachments', aErr.message);
}
