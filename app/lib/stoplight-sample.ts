// The team stoplight on /demo: the sample team (lib/clozr-data) with a week
// that has a bit of everything, so the screen is never blank there. Never
// shown in a signed-in workspace. Seller N is the demo graph's person pN
// (recordHref with `sample`), so every Open lead link lands on that record.

import type { StoplightMetrics, StoplightPayload, StoplightPerson, TcFileRow } from './stoplight';

const DAY = 86_400_000;
const zero: StoplightMetrics = {
  calls: 0, talk_min: 0, conversations: 0, appointments: 0, calendar_meetings: 0, offers: 0, contracts: 0,
  buyer_calls: 0, buyer_talk_min: 0, buyer_texts: 0, buyers_added: 0, buyer_offers: 0, deals_marketed: 0, buyer_contracts: 0,
  closed_acq: 0, revenue_acq: 0, closed_dispo: 0, revenue_dispo: 0, pipeline_acq: 0, pipeline_dispo: 0,
};
const noItems = { overdue_tasks: [], untouched_leads: [], no_next_step: [] };

/** Scales the sample week to the range so This month reads like a month. */
export function sampleStoplight(from: Date, to: Date, workdays: number, now = new Date()): StoplightPayload {
  const k = Math.max(workdays, 1) / 5;
  const m = (x: Partial<StoplightMetrics>, keep: (keyof StoplightMetrics)[] = []): StoplightMetrics => {
    const out = { ...zero, ...x };
    for (const key of Object.keys(x) as (keyof StoplightMetrics)[]) if (!keep.includes(key)) out[key] = Math.round(out[key] * k);
    return out;
  };
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  const day = (days: number) => ago(days).slice(0, 10);
  const keep: (keyof StoplightMetrics)[] = ['pipeline_acq', 'pipeline_dispo'];
  const person = (p: Omit<StoplightPerson, 'avatar_url' | 'items'> & { items?: StoplightPerson['items'] }): StoplightPerson => ({ avatar_url: null, items: noItems, ...p });

  const people: StoplightPerson[] = [
    person({
      user_id: 'taylor', name: 'Taylor Reed', role: 'acquisitions', is_tc: false, last_call_at: ago(0.1),
      metrics: m({ calls: 290, talk_min: 520, conversations: 41, appointments: 6, offers: 9, contracts: 2, closed_acq: 1, revenue_acq: 32000, pipeline_acq: 214000 }, keep),
      gaps: { overdue_tasks: 3, overdue_unlinked: 1, untouched_leads: 0, no_next_step: 0 },
      items: {
        overdue_tasks: [
          { id: 9101, title: 'Call back: wants offer in writing', due_at: ago(2), seller_id: 1, deal_id: null, buyer_id: null, who: 'Kara Mitchell' },
          { id: 9102, title: 'Send seller the walkthrough times', due_at: ago(1), seller_id: 2, deal_id: 3, buyer_id: null, who: 'Ronald Moore' },
          { id: 9103, title: 'Follow up on probate letter', due_at: ago(1), seller_id: null, deal_id: null, buyer_id: null, who: null },
        ],
        untouched_leads: [], no_next_step: [],
      },
    }),
    person({
      user_id: 'diego', name: 'Diego Ortiz', role: 'acquisitions', is_tc: false, last_call_at: ago(6),
      metrics: m({ calls: 64, talk_min: 41, conversations: 4, appointments: 1, pipeline_acq: 45000 }, keep),
      gaps: { overdue_tasks: 46, overdue_unlinked: 40, untouched_leads: 812, no_next_step: 1 },
      items: {
        overdue_tasks: [
          { id: 9201, title: 'Call back', due_at: ago(19), seller_id: 4, deal_id: null, buyer_id: null, who: 'Derek Ross' },
          { id: 9202, title: 'Call back', due_at: ago(17), seller_id: 7, deal_id: null, buyer_id: null, who: 'Gary Whitfield' },
          { id: 9203, title: 'Text seller the offer range', due_at: ago(9), seller_id: 13, deal_id: null, buyer_id: null, who: 'Denise Carter' },
        ],
        untouched_leads: [
          { id: 3, name: 'John Smith', address: '4410 Bluebonnet Trail', created_at: ago(3) },
          { id: 15, name: 'Olivia Reyes', address: '2115 Alamo Heights Blvd', created_at: ago(5) },
          { id: 12, name: 'Harold Kim', address: '9021 Brookhollow Dr', created_at: ago(8) },
        ],
        no_next_step: [{ deal_id: 11, seller_id: 11, label: '7302 Sagebrush Ct', stage: 'Under Contract Seller' }],
      },
    }),
    person({
      user_id: 'morgan', name: 'Morgan Lane', role: 'dispositions', is_tc: false, last_call_at: ago(0.2),
      metrics: m({ buyer_calls: 255, buyer_talk_min: 470, buyers_added: 16, buyer_offers: 11, buyer_texts: 140, deals_marketed: 3, buyer_contracts: 2, closed_dispo: 1, revenue_dispo: 28000, pipeline_dispo: 80000 }, keep),
      gaps: { overdue_tasks: 0, overdue_unlinked: 0, untouched_leads: 0, no_next_step: 0 },
    }),
    person({
      user_id: 'avery', name: 'Avery Nguyen', role: 'dispositions', is_tc: false, last_call_at: ago(3),
      metrics: m({ buyer_calls: 22, buyer_talk_min: 31, buyers_added: 2, buyer_offers: 1, buyer_texts: 36, deals_marketed: 2 }, keep),
      gaps: { overdue_tasks: 4, overdue_unlinked: 4, untouched_leads: 1, no_next_step: 2 },
      items: {
        overdue_tasks: [{ id: 9301, title: 'Send buyer the assignment', due_at: ago(4), seller_id: null, deal_id: null, buyer_id: 3, who: null }],
        untouched_leads: [{ id: 14, name: 'Bruce Tanner', address: '5518 Ridgecrest Rd', created_at: ago(12) }],
        no_next_step: [
          { deal_id: 14, seller_id: 6, label: '2207 Willow Street', stage: 'Ready To Market' },
          { deal_id: 16, seller_id: 9, label: '1520 Easton Avenue', stage: 'Buyer Under Contract' },
        ],
      },
    }),
    person({
      user_id: 'casey', name: 'Casey Park', role: 'admin', is_tc: true, last_call_at: ago(1),
      metrics: m({ calls: 9, talk_min: 22 }),
      gaps: { overdue_tasks: 4, overdue_unlinked: 4, untouched_leads: 0, no_next_step: 1 },
      items: {
        overdue_tasks: [{ id: 9401, title: 'Chase title for payoff', due_at: ago(3), seller_id: null, deal_id: null, buyer_id: null, who: null }],
        untouched_leads: [],
        no_next_step: [{ deal_id: 18, seller_id: 8, label: '388 Pine Terrace', stage: 'In Escrow' }],
      },
    }),
    person({
      user_id: 'sam', name: 'Sam Carter', role: 'owner', is_tc: false, last_call_at: ago(0.5),
      metrics: m({ calls: 3 }),
      gaps: { overdue_tasks: 1, overdue_unlinked: 1, untouched_leads: 0, no_next_step: 0 },
      items: { overdue_tasks: [{ id: 9501, title: 'Approve the HUD for 388 Pine Terrace', due_at: ago(1), seller_id: 8, deal_id: 18, buyer_id: null, who: 'Linda Barnes' }], untouched_leads: [], no_next_step: [] },
    }),
  ];

  const file = (f: Partial<TcFileRow> & Pick<TcFileRow, 'transaction_id' | 'deal_id' | 'seller_id' | 'label'>): TcFileRow => ({
    stage: 'Under Contract Seller', deal_type: 'assignment', contract_date: day(4), ctc_target: day(-6), close_date: day(-17),
    emd_received_at: null, checklist: [], schedule_c: [], tc_rep_id: 'casey', last_activity_at: ago(1), ...f,
  });
  const tc_files: TcFileRow[] = [
    file({ transaction_id: 1, deal_id: 18, seller_id: 8, label: '388 Pine Terrace', stage: 'In Escrow', contract_date: day(18), ctc_target: day(8), close_date: day(-3), checklist: ['a1', 'a2', 'a5', 'a7', 'a9', 'a11', 'a12', 'a13', 'a16'] }),
    file({ transaction_id: 2, deal_id: 14, seller_id: 6, label: '2207 Willow Street', stage: 'Ready To Market', contract_date: day(9), ctc_target: day(-1), checklist: ['a1', 'a2', 'a34', 'a5', 'a7', 'a9', 'a11', 'a12', 'a13', 'a17'], schedule_c: [{ id: 'c1', text: 'Open city lien, $2,140', status: 'red' }] }),
    file({ transaction_id: 3, deal_id: 22, seller_id: 5, label: '44 Benton Court', deal_type: 'novation', contract_date: day(5), ctc_target: null, checklist: [] }),
    file({ transaction_id: 4, deal_id: 24, seller_id: 10, label: '910 Cedar Way', contract_date: day(2), checklist: ['a1', 'a2', 'a34', 'a5', 'a7'], tc_rep_id: null, last_activity_at: ago(11) }),
    file({ transaction_id: 5, deal_id: 16, seller_id: 9, label: '1520 Easton Avenue', contract_date: day(1), checklist: ['a1', 'a2', 'a34'] }),
  ];

  return {
    generated_at: now.toISOString(), from: from.toISOString(), to: to.toISOString(), stale_days: 7,
    people, tc_files,
    noise: { prospect_deals: 4521, prospect_negative_fee: 3324, open_files_on_ended_deals: 69, calendar_meetings: Math.round(120 * k), buyers_imported: 592 },
  };
}
