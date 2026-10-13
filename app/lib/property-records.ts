// A property's public record from COMPR (migration 57, table property_records).
//
// The row is keyed on the property COMPR underwrote: the deal's property when
// a deal is named (a partner's submission), else the seller's — the same rule
// compr-underwrite uses to pick the address.

import { supabase } from './supabase';
import type { PropertyRecordRow } from './database.types';

export async function loadPropertyRecords({ dealId, sellerId }: { dealId?: number | null; sellerId?: number | null }): Promise<PropertyRecordRow | null> {
  if (!supabase) return null;
  const owner = dealId
    ? await supabase.from('deals').select('property_id').eq('id', dealId).maybeSingle()
    : sellerId ? await supabase.from('sellers').select('property_id').eq('id', sellerId).maybeSingle() : null;
  const propertyId = owner?.data?.property_id;
  if (!propertyId) return null;
  const { data } = await supabase.from('property_records').select('*').eq('property_id', propertyId).maybeSingle();
  return data ?? null;
}
