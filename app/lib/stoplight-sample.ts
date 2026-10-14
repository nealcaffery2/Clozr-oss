// The team stoplight on /demo: the sample team (lib/clozr-data) with a week
// that has a bit of everything, so the screen is never blank there. Never
// shown in a signed-in workspace.

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
          { id: 9102, title: 'Send seller the walkthrough times', due_at: ago(1), seller_id: 2, deal_id: 3, buyer_id: null, who: 'Drew Collins' },
          { id: 9103, title: 'Follow up on probate letter', due_at: ago(1), seller_id: null, deal_id: null, buyer_id: null, who: null },
        ],
        untouched_leads: [], no_next_step: [],
      },
    }),
    person({
      user_id: 'jamie', name: 'Jamie Ortiz', role: 'acquisitions', is_tc: false, last_call_at: ago(6),
      metrics: m({ calls: 64, talk_min: 41, conversations: 4, appointments: 1, pipeline_acq: 45000 }, keep),
      gaps: { overdue_tasks: 46, overdue_unlinked: 40, untouched_leads: 812, no_next_step: 1 },
      items: {
        overdue_tasks: [
          { id: 9201, title: 'Call back', due_at: ago(19), seller_id: 4, deal_id: null, buyer_id: null, who: 'Nina Patel' },
          { id: 9202, title: 'Call back', due_at: ago(17), seller_id: 5, deal_id: null, buyer_id: null, who: 'Omar Reyes' },
          { id: 9203, title: 'Text seller the offer range', due_at: ago(9), seller_id: 6, deal_id: null, buyer_id: null, who: 'Lena Brooks' },
        ],
        untouched_leads: [
          { id: 7, name: 'Ana Delgado', address: '418 Maple Ave', created_at: ago(3) },
          { id: 8, name: 'Dale Hughes', address: '2210 W Cedar Ave', created_at: ago(5) },
          { id: 9, name: 'Rosa Flores', address: '901 Birch Ave', created_at: ago(8) },
        ],
        no_next_step: [{ deal_id: 11, seller_id: 10, label: '7314 Poplar Rd', stage: 'Under Contract Seller' }],
      },
    }),
    person({
      user_id: 'morgan', name: 'Morgan Lane', role: 'dispositions', is_tc: false, last_call_at: ago(0.2),
      metrics: m({ buyer_calls: 255, buyer_talk_min: 470, buyers_added: 16, buyer_offers: 11, buyer_texts: 140, deals_marketed: 3, buyer_contracts: 2, closed_dispo: 1, revenue_dispo: 28000, pipeline_dispo: 80000 }, keep),
      gaps: { overdue_tasks: 0, overdue_unlinked: 0, untouched_leads: 0, no_next_step: 0 },
    }),
    person({
      user_id: 'kim', name: 'Kim Alvarez', role: 'dispositions', is_tc: false, last_call_at: ago(3),
      metrics: m({ buyer_calls: 22, buyer_talk_min: 31, buyers_added: 2, buyer_offers: 1, buyer_texts: 36, deals_marketed: 2 }, keep),
      gaps: { overdue_tasks: 4, overdue_unlinked: 4, untouched_leads: 1, no_next_step: 2 },
      items: {
        overdue_tasks: [{ id: 9301, title: 'Send buyer the assignment', due_at: ago(4), seller_id: null, deal_id: null, buyer_id: 12, who: null }],
        untouched_leads: [{ id: 13, name: 'Luis Romero', address: '115 Aspen Blvd', created_at: ago(12) }],
        no_next_step: [
          { deal_id: 14, seller_id: 15, label: '5502 Pine Path', stage: 'Ready To Market' },
          { deal_id: 16, seller_id: 17, label: '230 E Hazel St', stage: 'Buyer Under Contract' },
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
        no_next_step: [{ deal_id: 18, seller_id: 19, label: '1907 Laurel St', stage: 'In Escrow' }],
      },
    }),
    person({
      user_id: 'sam', name: 'Sam Rivera', role: 'owner', is_tc: false, last_call_at: ago(0.5),
      metrics: m({ calls: 3 }),
      gaps: { overdue_tasks: 1, overdue_unlinked: 1, untouched_leads: 0, no_next_step: 0 },
      items: { overdue_tasks: [{ id: 9501, title: 'Approve the HUD for 1907 Laurel', due_at: ago(1), seller_id: 19, deal_id: 18, buyer_id: null, who: 'Quinn Avery' }], untouched_leads: [], no_next_step: [] },
    }),
  ];

  const file = (f: Partial<TcFileRow> & Pick<TcFileRow, 'transaction_id' | 'deal_id' | 'label'>): TcFileRow => ({
    seller_id: f.deal_id + 1, stage: 'Under Contract Seller', deal_type: 'assignment', contract_date: day(4), ctc_target: day(-6), close_date: day(-17),
    emd_received_at: null, checklist: [], schedule_c: [], tc_rep_id: 'casey', last_activity_at: ago(1), ...f,
  });
  const tc_files: TcFileRow[] = [
    file({ transaction_id: 1, deal_id: 18, label: '1907 Laurel St', stage: 'In Escrow', contract_date: day(18), ctc_target: day(8), close_date: day(-3), checklist: ['a1', 'a2', 'a5', 'a7', 'a9', 'a11', 'a12', 'a13', 'a16'] }),
    file({ transaction_id: 2, deal_id: 20, label: '4410 Juniper Rd', stage: 'Ready To Market', contract_date: day(9), ctc_target: day(-1), checklist: ['a1', 'a2', 'a34', 'a5', 'a7', 'a9', 'a11', 'a12', 'a13', 'a17'], schedule_c: [{ id: 'c1', text: 'Open city lien, $2,140', status: 'red' }] }),
    file({ transaction_id: 3, deal_id: 22, label: '812 Sycamore Rd', deal_type: 'novation', contract_date: day(5), ctc_target: null, checklist: [] }),
    file({ transaction_id: 4, deal_id: 24, label: '316 Spruce Ave', contract_date: day(2), checklist: ['a1', 'a2', 'a34', 'a5', 'a7'], tc_rep_id: null, last_activity_at: ago(11) }),
    file({ transaction_id: 5, deal_id: 26, label: '6015 Willow Rd', contract_date: day(1), checklist: ['a1', 'a2', 'a34'] }),
  ];

  return {
    generated_at: now.toISOString(), from: from.toISOString(), to: to.toISOString(), stale_days: 7,
    people, tc_files,
    noise: { prospect_deals: 4521, prospect_negative_fee: 3324, open_files_on_ended_deals: 69, calendar_meetings: Math.round(120 * k), buyers_imported: 592 },
  };
}
