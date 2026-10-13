// What /demo shows on the deal sheet: one deal held in memory, so the screen
// can be looked at without a workspace. DealSheet reads this only on the /demo
// route and never saves it anywhere (screens/DealSheet.tsx).

import type { DealSheet } from './deal-sheet';

export const DEMO_DEAL: DealSheet = {
  id: 9001, workspace_id: 0, seller_id: 10, buyer_id: null, transaction_type: 'Assignment',
  stage: 'Under Contract Seller', contract_status: 'Under Contract Seller', tracker_no: 12,
  contract_date: '2026-09-02', close_date: '2026-10-09', offer_amount: 168000, arv: 285000, rehab: 46000, earnest_money: 2500,
  marketed_price: 199000, marketed_fee: 31000, assignment_fee: 28000, target_assignment: 30000, lead_source: 'Cold call', acq_agent: 'Taylor Gray',
  lead_manager: 'Sam', marketing_headline: 'Cash deal, 3/2 in 78209, needs cosmetic rehab', condition_notes: 'Roof 2021. Kitchen and baths dated, no foundation issues seen.',
  occupancy_notes: 'Vacant, lockbox on the side gate.', cogs_photos: 120, cogs_lockbox: 45, cogs_notary: 150, cogs_lead: 400, cogs_flat_fee: 500,
  wholesale_fee: 28000, total_cogs: 1215, deal_net_profit: 26785, final_profit: 26785, listing_agent_commission: 0, buyers_agent_commission: 0,
  updated_at: '2026-09-20T12:00:00Z',
} as unknown as DealSheet;
