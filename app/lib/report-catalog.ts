// The prebuilt widgets, templates and themes of the custom report builder.
// A widget here is a saved engine spec (lib/report-engine.ts) with a label;
// adding one is adding a line. Categories with no CLOZR data behind them
// (ads, web analytics, social, payments) are left out rather than shown empty.

import type { Agg, Chart, Cond, Source, Spec, Token, MetricFormat } from './report-engine';

export type WidgetDef = {
  key: string;
  category: string;
  label: string;
  description: string;
  chart: Chart;
} & ({ spec: Spec; formula?: undefined; format?: undefined } | { formula: Token[]; format: MetricFormat; spec?: undefined });

export const CATEGORIES: { name: string; source: Source | null; blurb: string }[] = [
  { name: 'Sellers', source: 'sellers', blurb: 'Leads and their records' },
  { name: 'Appointments', source: 'appointments', blurb: 'Booked, kept and cancelled' },
  { name: 'Deals', source: 'deals', blurb: 'The pipeline, fees and closings' },
  { name: 'Calls', source: 'calls', blurb: 'Talkr calls on the records' },
  { name: 'Texts', source: 'sms', blurb: 'SMS on the records' },
  { name: 'Emails', source: 'emails', blurb: 'Email on the records' },
  { name: 'Tasks', source: 'tasks', blurb: 'Work queued and done' },
  { name: 'Offers', source: 'offers', blurb: 'Sent to sellers, received from buyers' },
  { name: 'Contracts', source: 'contracts', blurb: 'PandaDoc and CLOZR documents' },
  { name: 'Buyers', source: 'buyers', blurb: 'The buyer list' },
  { name: 'Dispo blasts', source: 'blasts', blurb: 'Deal blasts to buyers' },
  { name: 'General', source: null, blurb: 'Pipeline health in one place' },
];

const DEFAULT_DATE: Record<Source, string> = {
  sellers: 'created_at', deals: 'created_at', calls: 'occurred_at', sms: 'occurred_at', emails: 'occurred_at',
  appointments: 'starts_at', tasks: 'created_at', offers: 'sent_at', contracts: 'created_at', buyers: 'created_at', blasts: 'sent_at',
};
const S = (source: Source, agg: Agg, o: Partial<Spec> = {}): Spec => ({ source, agg, field: null, groupBy: null, dateField: DEFAULT_DATE[source], filters: [], ...o });
const is = (field: string, value: string): Cond[][] => [[{ field, op: 'is', value }]];
const and = (...cs: [string, string][]): Cond[][] => [cs.map(([field, value]) => ({ field, op: 'is', value }))];
const outbound = is('direction', 'outbound');
const inbound = is('direction', 'inbound');
const W = (key: string, category: string, label: string, description: string, chart: Chart, spec: Spec): WidgetDef => ({ key, category, label, description, chart, spec });

/** The seller funnel: a step counts everyone at or past it. */
const FUNNEL_ORDER = ['lead', 'working', 'appointment', 'offer', 'contract', 'closed'];
const FUNNEL_LABEL: Record<string, string> = { lead: 'New leads', working: 'Working', appointment: 'Appointment', offer: 'Offer made', contract: 'Under contract', closed: 'Closed' };
const funnelSteps = FUNNEL_ORDER.map((g, i) => ({ label: FUNNEL_LABEL[g], filters: FUNNEL_ORDER.slice(i).map((x) => [{ field: 'stage_group', op: 'is' as const, value: x }]) }));

export const WIDGETS: WidgetDef[] = [
  // Sellers
  W('sellers.count', 'Sellers', 'Sellers count', 'Sellers added in the range', 'number', S('sellers', 'count')),
  W('sellers.by_source', 'Sellers', 'Sellers by source', 'Where the leads came from', 'donut', S('sellers', 'count', { groupBy: 'source' })),
  W('sellers.top_sources', 'Sellers', 'Top sources for sellers created', 'The five sources that brought the most leads', 'bar', S('sellers', 'count', { groupBy: 'source', limit: 5 })),
  W('sellers.by_tags', 'Sellers', 'Sellers by tag', 'Sellers distribution by tag', 'donut', S('sellers', 'count', { groupBy: 'tags' })),
  W('sellers.by_stage', 'Sellers', 'Sellers by stage', 'Every stage and how many leads sit in it', 'bar', S('sellers', 'count', { groupBy: 'stage', limit: 14 })),
  W('sellers.by_stage_group', 'Sellers', 'Sellers by stage group', 'Lead, working, offer, contract, closed, dead', 'donut', S('sellers', 'count', { groupBy: 'stage_group' })),
  W('sellers.by_assigned', 'Sellers', 'Sellers by assigned rep', 'Leads mapped to the rep who works them', 'bar', S('sellers', 'count', { groupBy: 'assigned' })),
  W('sellers.over_time', 'Sellers', 'Sellers over time', 'Leads added over the range', 'line', S('sellers', 'count')),
  W('sellers.mine', 'Sellers', 'My sellers', 'Leads assigned to you, added in the range', 'number', S('sellers', 'count', { filters: is('assigned', '@me') })),
  W('sellers.with_email', 'Sellers', 'Sellers with email', 'Leads with an email on the record', 'number', S('sellers', 'count', { filters: is('has_email', 'true') })),
  W('sellers.without_email', 'Sellers', 'Sellers without email', 'Leads missing an email', 'number', S('sellers', 'count', { filters: is('has_email', 'false') })),
  W('sellers.with_phone', 'Sellers', 'Sellers with phone', 'Leads with a phone on the record', 'number', S('sellers', 'count', { filters: is('has_phone', 'true') })),
  W('sellers.without_phone', 'Sellers', 'Sellers without phone', 'Leads missing a phone', 'number', S('sellers', 'count', { filters: is('has_phone', 'false') })),
  W('sellers.total', 'Sellers', 'Total sellers (till date)', 'Every seller on the books, whatever the range', 'number', S('sellers', 'count', { dateField: null })),
  W('sellers.this_month', 'Sellers', 'Sellers this month', 'Leads added this calendar month', 'number', S('sellers', 'count', { datePreset: 'This month' })),
  W('sellers.newest', 'Sellers', 'Newest sellers', 'The latest leads with stage, source and rep', 'table', S('sellers', 'count', { columns: ['name', 'stage', 'source', 'assigned', 'created_at'], limit: 25 })),
  // Appointments
  W('appointments.count', 'Appointments', 'Appointment count', 'Appointments taking place in the range', 'number', S('appointments', 'count')),
  W('appointments.booked', 'Appointments', 'Appointments booked', 'Appointments created in the range, whenever they happen', 'number', S('appointments', 'count', { dateField: 'created_at' })),
  W('appointments.by_kind', 'Appointments', 'Appointments by kind', 'Walkthroughs, calls, signings', 'donut', S('appointments', 'count', { groupBy: 'kind' })),
  W('appointments.by_source', 'Appointments', 'Appointments by source', 'Booked in CLOZR, synced from Google, from a form', 'donut', S('appointments', 'count', { groupBy: 'source' })),
  W('appointments.by_assigned', 'Appointments', 'Appointments by rep', 'Who is holding the appointments', 'bar', S('appointments', 'count', { groupBy: 'assigned' })),
  W('appointments.cancelled', 'Appointments', 'Cancelled appointments', 'Appointments removed after booking', 'number', S('appointments', 'count', { filters: is('cancelled', 'true') })),
  W('appointments.over_time', 'Appointments', 'Appointments over time', 'Appointments per day, week or month', 'line', S('appointments', 'count')),
  W('appointments.cancelled_over_time', 'Appointments', 'Cancellations over time', 'Trend of cancelled appointments', 'line', S('appointments', 'count', { filters: is('cancelled', 'true') })),
  W('appointments.upcoming_week', 'Appointments', 'Upcoming appointments (next 7 days)', 'What is on the calendar this coming week', 'table', S('appointments', 'count', { datePreset: 'Next 7 days', filters: is('cancelled', 'false'), columns: ['starts_at', 'title', 'kind', 'seller', 'assigned'], limit: 40 })),
  W('appointments.upcoming_week_mine', 'Appointments', 'My upcoming appointments (next 7 days)', 'Your own appointments this coming week', 'table', S('appointments', 'count', { datePreset: 'Next 7 days', filters: and(['cancelled', 'false'], ['assigned', '@me']), columns: ['starts_at', 'title', 'kind', 'seller'], limit: 40 })),
  W('appointments.last_month', 'Appointments', 'Last month’s appointments', 'Every appointment held last calendar month', 'table', S('appointments', 'count', { datePreset: 'Last month', columns: ['starts_at', 'title', 'kind', 'seller', 'assigned'], limit: 60 })),
  // Deals
  W('deals.count', 'Deals', 'Deal count', 'Deals created in the range', 'number', S('deals', 'count')),
  W('deals.open', 'Deals', 'Open deals', 'Deals still being worked', 'number', S('deals', 'count', { filters: is('status', 'open') })),
  W('deals.won', 'Deals', 'Won deals', 'Deals closed in the range', 'number', S('deals', 'count', { dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.lost', 'Deals', 'Lost deals', 'Deals that fell through', 'number', S('deals', 'count', { dateField: 'stage_entered_at', filters: is('status', 'lost') })),
  W('deals.abandoned', 'Deals', 'Abandoned deals', 'Deals refunded or archived', 'number', S('deals', 'count', { dateField: 'stage_entered_at', filters: is('status', 'abandoned') })),
  W('deals.by_status', 'Deals', 'Deals by status', 'Open, won, lost, abandoned', 'donut', S('deals', 'count', { groupBy: 'status' })),
  W('deals.by_stage', 'Deals', 'Deals by stage', 'Where the pipeline sits', 'bar', S('deals', 'count', { groupBy: 'stage', limit: 14 })),
  W('deals.over_time', 'Deals', 'Deals over time', 'Deals created per day, week or month', 'line', S('deals', 'count')),
  W('deals.fee_over_time', 'Deals', 'Fee revenue over time', 'Assignment / dispo fees by close date', 'line', S('deals', 'sum', { field: 'fee', dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.open_value', 'Deals', 'Open deal value', 'Contract price of the open deals', 'number', S('deals', 'sum', { field: 'offer_amount', filters: is('status', 'open') })),
  W('deals.won_value', 'Deals', 'Won fee revenue', 'Fees on deals closed in the range', 'number', S('deals', 'sum', { field: 'fee', dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.lost_value', 'Deals', 'Lost deal value', 'Contract price of the deals that fell through', 'number', S('deals', 'sum', { field: 'offer_amount', dateField: 'stage_entered_at', filters: is('status', 'lost') })),
  W('deals.total_value', 'Deals', 'Total contract value', 'Contract price across every deal in the range', 'number', S('deals', 'sum', { field: 'offer_amount' })),
  W('deals.avg_fee', 'Deals', 'Average fee', 'Average fee on closed deals', 'number', S('deals', 'avg', { field: 'fee', dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.won_this_month', 'Deals', 'Won deals this month', 'Deals closed this calendar month', 'number', S('deals', 'count', { dateField: 'closed_on', datePreset: 'This month', filters: is('status', 'won') })),
  W('deals.won_value_this_month', 'Deals', 'Fee revenue this month', 'Fees on deals closed this month, whole team', 'number', S('deals', 'sum', { field: 'fee', dateField: 'closed_on', datePreset: 'This month', filters: is('status', 'won') })),
  W('deals.won_mine_this_month', 'Deals', 'My won deals this month', 'Deals you own, closed this month', 'number', S('deals', 'count', { dateField: 'closed_on', datePreset: 'This month', filters: and(['status', 'won'], ['owner', '@me']) })),
  W('deals.won_value_mine_this_month', 'Deals', 'My fee revenue this month', 'Fees on the deals you own, closed this month', 'number', S('deals', 'sum', { field: 'fee', dateField: 'closed_on', datePreset: 'This month', filters: and(['status', 'won'], ['owner', '@me']) })),
  W('deals.by_lead_source', 'Deals', 'Deals by lead source', 'Which sources turn into deals', 'donut', S('deals', 'count', { groupBy: 'lead_source' })),
  W('deals.by_market', 'Deals', 'Deals by market', 'Deals per market', 'bar', S('deals', 'count', { groupBy: 'market' })),
  W('deals.days_to_assign', 'Deals', 'Days to assign', 'Average days from marketing start (else contract) to close', 'number', S('deals', 'avg', { field: 'days_to_assign', dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.days_to_close', 'Deals', 'Days to close', 'Average days from contract to close', 'number', S('deals', 'avg', { field: 'days_to_close', dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.fee_by_dispo_rep', 'Deals', 'Fee revenue by dispo rep', 'Closed fees per dispositions rep', 'bar', S('deals', 'sum', { field: 'fee', groupBy: 'dispo_rep', dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.won_by_dispo_rep', 'Deals', 'Deals assigned per dispo rep', 'Closed deals per dispositions rep', 'bar', S('deals', 'count', { groupBy: 'dispo_rep', dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.won_by_acq_rep', 'Deals', 'Won deals by acquisitions rep', 'Closed deals per acquisitions rep', 'bar', S('deals', 'count', { groupBy: 'owner', dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.under_contract', 'Deals', 'Deals put under contract', 'Contracts signed with sellers in the range (by contract date)', 'number', S('deals', 'count', { dateField: 'contract_date' })),
  W('deals.marketed', 'Deals', 'Deals put to market', 'Deals whose marketing started in the range', 'number', S('deals', 'count', { dateField: 'marketing_started_on' })),
  W('deals.avg_spread', 'Deals', 'Average spread', 'Sold price minus contract price on closed deals', 'number', S('deals', 'avg', { field: 'spread', dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.total_spread', 'Deals', 'Total spread', 'Sold price minus contract price, summed over closed deals', 'number', S('deals', 'sum', { field: 'spread', dateField: 'closed_on', filters: is('status', 'won') })),
  W('deals.avg_contract_price', 'Deals', 'Average contract price', 'What we are locking deals up at', 'number', S('deals', 'avg', { field: 'offer_amount', dateField: 'contract_date' })),
  W('deals.pipeline', 'Deals', 'Open pipeline', 'Every open deal with price, ARV, fee and dispo rep', 'table', S('deals', 'count', { dateField: null, filters: is('status', 'open'), columns: ['seller', 'stage', 'offer_amount', 'arv', 'fee', 'dispo_rep'], limit: 60 })),
  // Calls
  W('calls.count', 'Calls', 'Calls', 'Calls in the range, both directions', 'number', S('calls', 'count')),
  W('calls.incoming_by_status', 'Calls', 'Incoming calls by status', 'Inbound calls grouped by status', 'donut', S('calls', 'count', { groupBy: 'status', filters: inbound })),
  W('calls.outgoing_by_status', 'Calls', 'Outgoing calls by status', 'Outbound calls grouped by status', 'donut', S('calls', 'count', { groupBy: 'status', filters: outbound })),
  W('calls.answered', 'Calls', 'Answered outgoing calls', 'Outbound calls that connected', 'number', S('calls', 'count', { filters: and(['direction', 'outbound'], ['answered', 'true']) })),
  W('calls.incoming_total_duration', 'Calls', 'Incoming calls total duration', 'Total talk time on inbound calls', 'number', S('calls', 'sum', { field: 'duration', filters: inbound })),
  W('calls.outgoing_total_duration', 'Calls', 'Outgoing calls total duration', 'Total talk time on outbound calls', 'number', S('calls', 'sum', { field: 'duration', filters: outbound })),
  W('calls.incoming_avg_duration', 'Calls', 'Incoming calls average duration', 'Average inbound call length', 'number', S('calls', 'avg', { field: 'duration', filters: inbound })),
  W('calls.outgoing_avg_duration', 'Calls', 'Outgoing calls average duration', 'Average outbound call length', 'number', S('calls', 'avg', { field: 'duration', filters: outbound })),
  W('calls.placed_by_rep', 'Calls', 'Calls placed by rep', 'Outbound calls per rep (the rep assigned on the record)', 'bar', S('calls', 'count', { groupBy: 'rep', filters: outbound })),
  W('calls.incoming_avg_duration_by_rep', 'Calls', 'Incoming average duration by rep', 'Inbound call length per rep', 'bar', S('calls', 'avg', { field: 'duration', groupBy: 'rep', filters: inbound })),
  W('calls.outgoing_avg_duration_by_rep', 'Calls', 'Outgoing average duration by rep', 'Outbound call length per rep', 'bar', S('calls', 'avg', { field: 'duration', groupBy: 'rep', filters: outbound })),
  W('calls.first_time_by_status', 'Calls', 'First-time calls by status', 'The first call with each seller, by status', 'donut', S('calls', 'count', { groupBy: 'status', filters: is('first_time', 'true') })),
  W('calls.first_time_avg_duration', 'Calls', 'First-time call average duration', 'How long the first conversation lasts', 'number', S('calls', 'avg', { field: 'duration', filters: is('first_time', 'true') })),
  W('calls.first_time_total_duration', 'Calls', 'First-time call total duration', 'Total talk time on first conversations', 'number', S('calls', 'sum', { field: 'duration', filters: is('first_time', 'true') })),
  W('calls.first_time_avg_duration_by_rep', 'Calls', 'First-time average duration by rep', 'First-conversation length per rep', 'bar', S('calls', 'avg', { field: 'duration', groupBy: 'rep', filters: is('first_time', 'true') })),
  W('calls.over_time', 'Calls', 'Calls over time', 'Calls per day, week or month', 'line', S('calls', 'count')),
  W('calls.by_record', 'Calls', 'Calls by record type', 'Seller, buyer or unfiled', 'donut', S('calls', 'count', { groupBy: 'record' })),
  // Texts
  W('sms.sent', 'Texts', 'Texts sent', 'Outbound texts', 'number', S('sms', 'count', { filters: outbound })),
  W('sms.incoming', 'Texts', 'Incoming texts', 'Inbound texts received', 'number', S('sms', 'count', { filters: inbound })),
  W('sms.by_status', 'Texts', 'Texts by status', 'Sent, delivered, failed, queued', 'donut', S('sms', 'count', { groupBy: 'status', filters: outbound })),
  W('sms.by_rep', 'Texts', 'Texts by rep', 'Outbound texts per rep', 'bar', S('sms', 'count', { groupBy: 'rep', filters: outbound })),
  W('sms.over_time', 'Texts', 'Texts over time', 'Texts per day, week or month', 'line', S('sms', 'count')),
  W('sms.failed', 'Texts', 'Failed texts', 'Outbound texts that did not deliver', 'number', S('sms', 'count', { filters: [[{ field: 'direction', op: 'is', value: 'outbound' }, { field: 'status', op: 'contains', value: 'fail' }], [{ field: 'direction', op: 'is', value: 'outbound' }, { field: 'status', op: 'contains', value: 'undeliver' }]] })),
  // Emails
  W('emails.sent', 'Emails', 'Emails sent', 'Outbound email', 'number', S('emails', 'count', { filters: outbound })),
  W('emails.received', 'Emails', 'Emails received', 'Inbound email', 'number', S('emails', 'count', { filters: inbound })),
  W('emails.by_status', 'Emails', 'Emails by status', 'Sent, delivered, bounced, failed', 'donut', S('emails', 'count', { groupBy: 'status', filters: outbound })),
  W('emails.failed', 'Emails', 'Bounced or failed emails', 'Outbound email that did not land', 'number', S('emails', 'count', { filters: [[{ field: 'direction', op: 'is', value: 'outbound' }, { field: 'status', op: 'contains', value: 'bounce' }], [{ field: 'direction', op: 'is', value: 'outbound' }, { field: 'status', op: 'contains', value: 'fail' }]] })),
  W('emails.by_rep', 'Emails', 'Emails by rep', 'Outbound email per rep', 'bar', S('emails', 'count', { groupBy: 'rep', filters: outbound })),
  W('emails.over_time', 'Emails', 'Emails over time', 'Email per day, week or month', 'line', S('emails', 'count')),
  // Tasks
  W('tasks.open', 'Tasks', 'Open tasks', 'Tasks not yet done, whatever the range', 'number', S('tasks', 'count', { dateField: null, filters: is('done', 'false') })),
  W('tasks.overdue', 'Tasks', 'Overdue tasks', 'Open tasks past their due date', 'number', S('tasks', 'count', { dateField: null, filters: is('overdue', 'true') })),
  W('tasks.completed', 'Tasks', 'Tasks completed', 'Tasks finished in the range', 'number', S('tasks', 'count', { dateField: 'completed_at', filters: is('done', 'true') })),
  W('tasks.created', 'Tasks', 'Tasks created', 'Tasks added in the range', 'number', S('tasks', 'count')),
  W('tasks.by_type', 'Tasks', 'Tasks by type', 'Calls, texts, emails, follow-ups', 'donut', S('tasks', 'count', { groupBy: 'type' })),
  W('tasks.open_by_assigned', 'Tasks', 'Open tasks by rep', 'Who has work waiting', 'bar', S('tasks', 'count', { dateField: null, groupBy: 'assigned', filters: is('done', 'false') })),
  W('tasks.created_over_time', 'Tasks', 'Tasks created over time', 'Tasks added per day, week or month', 'line', S('tasks', 'count')),
  W('tasks.list', 'Tasks', 'Task list', 'Open tasks with due date, priority and rep', 'table', S('tasks', 'count', { dateField: 'due_at', filters: is('done', 'false'), columns: ['title', 'type', 'priority', 'due_at', 'assigned', 'seller'], limit: 50 })),
  // Offers
  W('offers.sent', 'Offers', 'Offers sent', 'Offers made to sellers', 'number', S('offers', 'count', { filters: outbound })),
  W('offers.received', 'Offers', 'Offers received', 'Offers from buyers on marketed deals', 'number', S('offers', 'count', { filters: inbound })),
  W('offers.accepted', 'Offers', 'Offers accepted', 'Offers to sellers that were accepted', 'number', S('offers', 'count', { filters: and(['direction', 'outbound'], ['outcome', 'accepted']) })),
  W('offers.by_outcome', 'Offers', 'Offers by outcome', 'Accepted, declined, pending', 'donut', S('offers', 'count', { groupBy: 'outcome', filters: outbound })),
  W('offers.sent_value', 'Offers', 'Value of offers sent', 'Total of offers made to sellers', 'number', S('offers', 'sum', { field: 'amount', filters: outbound })),
  W('offers.avg_received', 'Offers', 'Average buyer offer', 'Average offer received from buyers', 'number', S('offers', 'avg', { field: 'amount', filters: inbound })),
  W('offers.avg_vs_asking', 'Offers', 'Buyer offers vs contract price', 'Average buyer offer as a share of the deal’s contract price', 'number', S('offers', 'avg', { field: 'vs_asking', filters: inbound })),
  W('offers.received_per_deal', 'Offers', 'Offers received per deal', 'Buyer offers per marketed deal', 'bar', S('offers', 'count', { groupBy: 'deal', filters: inbound })),
  W('offers.by_rep', 'Offers', 'Offers sent by rep', 'Offers to sellers per rep', 'bar', S('offers', 'count', { groupBy: 'rep', filters: outbound })),
  W('offers.over_time', 'Offers', 'Offers over time', 'Offers per day, week or month', 'line', S('offers', 'count')),
  // Contracts
  W('contracts.sent', 'Contracts', 'Contracts sent', 'Documents sent for signature', 'number', S('contracts', 'count', { dateField: 'sent_at' })),
  W('contracts.signed', 'Contracts', 'Contracts signed', 'Documents completed in the range', 'number', S('contracts', 'count', { dateField: 'completed_at' })),
  W('contracts.by_status', 'Contracts', 'Contracts by status', 'Draft, sent, viewed, completed', 'donut', S('contracts', 'count', { groupBy: 'status' })),
  W('contracts.by_kind', 'Contracts', 'Contracts by kind', 'Purchase agreements, assignments, amendments', 'donut', S('contracts', 'count', { groupBy: 'kind' })),
  W('contracts.by_provider', 'Contracts', 'Contracts by provider', 'PandaDoc or CLOZR', 'donut', S('contracts', 'count', { groupBy: 'provider' })),
  W('contracts.hours_to_sign', 'Contracts', 'Hours to sign', 'Average hours from sent to signed', 'number', S('contracts', 'avg', { field: 'hours_to_sign', dateField: 'completed_at' })),
  // Buyers
  W('buyers.added', 'Buyers', 'Buyers added', 'Buyers added in the range', 'number', S('buyers', 'count')),
  W('buyers.total', 'Buyers', 'Total buyers', 'Every buyer on the list', 'number', S('buyers', 'count', { dateField: null })),
  W('buyers.vip', 'Buyers', 'VIP buyers', 'Buyers marked VIP', 'number', S('buyers', 'count', { dateField: null, filters: is('vip', 'true') })),
  W('buyers.active', 'Buyers', 'Active buyers', 'Buyers with activity in the last 90 days', 'number', S('buyers', 'count', { dateField: null, filters: is('active', 'true') })),
  W('buyers.dormant', 'Buyers', 'Dormant buyers', 'No activity in 90 days and not blacklisted', 'number', S('buyers', 'count', { dateField: null, filters: and(['active', 'false'], ['blacklisted', 'false']) })),
  W('buyers.blacklisted', 'Buyers', 'Blacklisted buyers', 'Buyers who no longer receive deals', 'number', S('buyers', 'count', { dateField: null, filters: is('blacklisted', 'true') })),
  W('buyers.added_over_time', 'Buyers', 'Buyers added over time', 'New buyers per day, week or month', 'line', S('buyers', 'count')),
  W('buyers.recent_activity', 'Buyers', 'Recently active buyers', 'Buyers by last activity', 'table', S('buyers', 'count', { dateField: 'last_activity_at', columns: ['name', 'vip', 'last_activity_at', 'created_at'], limit: 30 })),
  // Dispo blasts
  W('blasts.sent', 'Dispo blasts', 'Blasts sent', 'Deal sends to buyers', 'number', S('blasts', 'count')),
  W('blasts.viewed', 'Dispo blasts', 'Blasts viewed', 'Sends the buyer opened', 'number', S('blasts', 'count', { filters: is('viewed', 'true') })),
  W('blasts.replied', 'Dispo blasts', 'Blast replies', 'Sends the buyer answered', 'number', S('blasts', 'count', { filters: is('replied', 'true') })),
  W('blasts.by_deal', 'Dispo blasts', 'Blasts per deal', 'How widely each deal went out', 'bar', S('blasts', 'count', { groupBy: 'deal' })),
  W('blasts.replies_by_deal', 'Dispo blasts', 'Replies per deal', 'Which deals drew buyer replies', 'bar', S('blasts', 'count', { groupBy: 'deal', filters: is('replied', 'true') })),
  W('blasts.top_buyers', 'Dispo blasts', 'Most responsive buyers', 'Buyers who reply the most', 'bar', S('blasts', 'count', { groupBy: 'buyer', filters: is('replied', 'true') })),
  W('blasts.by_status', 'Dispo blasts', 'Blasts by status', 'Sent, viewed, replied, passed', 'donut', S('blasts', 'count', { groupBy: 'status' })),
  W('blasts.over_time', 'Dispo blasts', 'Blasts over time', 'Sends per day, week or month', 'line', S('blasts', 'count')),
  // General
  W('general.deal_status', 'General', 'Deal status', 'Deals grouped by status', 'donut', S('deals', 'count', { groupBy: 'status' })),
  W('general.deal_value', 'General', 'Deal value', 'Contract value by status', 'donut', S('deals', 'sum', { field: 'offer_amount', groupBy: 'status' })),
  {
    key: 'general.conversion_rate', category: 'General', label: 'Conversion rate', description: 'Won deals as a share of all deals in the range', chart: 'number', format: 'pct',
    formula: [
      { kind: 'metric', label: 'Won deals', spec: S('deals', 'count', { dateField: 'closed_on', filters: is('status', 'won') }) }, { kind: 'op', v: '/' },
      { kind: 'metric', label: 'Deals', spec: S('deals', 'count') }, { kind: 'op', v: '*' }, { kind: 'num', v: 100 },
    ],
  },
  {
    key: 'general.answer_rate', category: 'General', label: 'Call answer rate', description: 'Outbound calls that connected, as a share of outbound calls', chart: 'number', format: 'pct',
    formula: [
      { kind: 'metric', label: 'Answered', spec: S('calls', 'count', { filters: and(['direction', 'outbound'], ['answered', 'true']) }) }, { kind: 'op', v: '/' },
      { kind: 'metric', label: 'Outbound calls', spec: S('calls', 'count', { filters: outbound }) }, { kind: 'op', v: '*' }, { kind: 'num', v: 100 },
    ],
  },
  {
    key: 'general.blast_reply_rate', category: 'General', label: 'Blast reply rate', description: 'Buyer replies as a share of blasts sent', chart: 'number', format: 'pct',
    formula: [
      { kind: 'metric', label: 'Replies', spec: S('blasts', 'count', { filters: is('replied', 'true') }) }, { kind: 'op', v: '/' },
      { kind: 'metric', label: 'Blasts', spec: S('blasts', 'count') }, { kind: 'op', v: '*' }, { kind: 'num', v: 100 },
    ],
  },
  {
    key: 'general.close_rate', category: 'General', label: 'Contract close rate', description: 'Deals closed as a share of deals that closed or fell through', chart: 'number', format: 'pct',
    formula: [
      { kind: 'metric', label: 'Won', spec: S('deals', 'count', { dateField: 'stage_entered_at', filters: is('status', 'won') }) }, { kind: 'op', v: '/' }, { kind: 'op', v: '(' },
      { kind: 'metric', label: 'Won', spec: S('deals', 'count', { dateField: 'stage_entered_at', filters: is('status', 'won') }) }, { kind: 'op', v: '+' },
      { kind: 'metric', label: 'Lost', spec: S('deals', 'count', { dateField: 'stage_entered_at', filters: is('status', 'lost') }) }, { kind: 'op', v: ')' }, { kind: 'op', v: '*' }, { kind: 'num', v: 100 },
    ],
  },
  {
    key: 'general.offer_acceptance', category: 'General', label: 'Offer acceptance rate', description: 'Seller offers accepted as a share of offers sent', chart: 'number', format: 'pct',
    formula: [
      { kind: 'metric', label: 'Accepted', spec: S('offers', 'count', { filters: and(['direction', 'outbound'], ['outcome', 'accepted']) }) }, { kind: 'op', v: '/' },
      { kind: 'metric', label: 'Sent', spec: S('offers', 'count', { filters: outbound }) }, { kind: 'op', v: '*' }, { kind: 'num', v: 100 },
    ],
  },
  {
    key: 'general.lead_to_contract', category: 'General', label: 'Lead-to-contract rate', description: 'Contracts signed as a share of leads added in the range', chart: 'number', format: 'pct',
    formula: [
      { kind: 'metric', label: 'Contracts', spec: S('deals', 'count', { dateField: 'contract_date' }) }, { kind: 'op', v: '/' },
      { kind: 'metric', label: 'Leads', spec: S('sellers', 'count') }, { kind: 'op', v: '*' }, { kind: 'num', v: 100 },
    ],
  },
  W('general.funnel', 'General', 'Funnel', 'Sellers at or past each stage, with the drop between steps', 'funnel', S('sellers', 'count', { funnel: funnelSteps })),
  W('general.stages_distribution', 'General', 'Stages distribution', 'Sellers per stage', 'bar', S('sellers', 'count', { groupBy: 'stage', limit: 14 })),
  W('general.tasks', 'General', 'Tasks', 'Open tasks with due date, priority and rep', 'table', S('tasks', 'count', { dateField: 'due_at', filters: is('done', 'false'), columns: ['title', 'type', 'priority', 'due_at', 'assigned'], limit: 50 })),
  W('general.lead_source_report', 'General', 'Lead source report', 'Total leads by source', 'donut', S('sellers', 'count', { groupBy: 'source' })),
  W('general.fee_leaderboard', 'General', 'Rep leaderboard (fees)', 'Closed fee revenue per dispo rep', 'bar', S('deals', 'sum', { field: 'fee', groupBy: 'dispo_rep', dateField: 'closed_on', filters: is('status', 'won') })),
];

export const WIDGET_BY_KEY: Record<string, WidgetDef> = Object.fromEntries(WIDGETS.map((w) => [w.key, w]));

/** The quick-start set an empty page offers. */
export const SUGGESTED = ['sellers.count', 'appointments.count', 'deals.under_contract', 'deals.won', 'deals.won_value', 'deals.avg_fee', 'general.funnel', 'general.fee_leaderboard'];

export const CHART_LABEL: Record<Chart, string> = { number: 'Number', donut: 'Donut', line: 'Line', column: 'Column', bar: 'Horizontal bar', table: 'Table', funnel: 'Funnel' };

// ---- themes ------------------------------------------------------------------------

export type Theme = { id: string; name: string; title: string; bg: string; metric: string; chart: string; link: string };
/** Nine presets; "custom" keeps whatever colors the report saved. The chart color is the single-series mark. */
export const THEMES: Theme[] = [
  { id: 'gray', name: 'Gray', title: '#18181b', bg: '#ffffff', metric: '#18181b', chart: '#18181b', link: '#0A8560' },
  { id: 'blue', name: 'Blue', title: '#1e3a8a', bg: '#ffffff', metric: '#1e40af', chart: '#2a78d6', link: '#2a78d6' },
  { id: 'green', name: 'Green', title: '#064e3b', bg: '#ffffff', metric: '#0A8560', chart: '#0A8560', link: '#0A8560' },
  { id: 'purple', name: 'Purple', title: '#312e81', bg: '#ffffff', metric: '#4a3aa7', chart: '#4a3aa7', link: '#4a3aa7' },
  { id: 'red', name: 'Red', title: '#7f1d1d', bg: '#ffffff', metric: '#b91c1c', chart: '#e34948', link: '#b91c1c' },
  { id: 'orange', name: 'Orange', title: '#7c2d12', bg: '#ffffff', metric: '#c2410c', chart: '#eb6834', link: '#c2410c' },
  { id: 'yellow', name: 'Yellow', title: '#713f12', bg: '#ffffff', metric: '#a16207', chart: '#eda100', link: '#a16207' },
  { id: 'cyan', name: 'Cyan', title: '#134e4a', bg: '#ffffff', metric: '#c20f26', chart: '#1baf7a', link: '#c20f26' },
  { id: 'custom', name: 'Custom', title: '#18181b', bg: '#ffffff', metric: '#18181b', chart: '#0A8560', link: '#0A8560' },
];
/** Categorical slots in fixed order (validated for CVD separation in light and dark). A 9th group folds into "Other". */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

// ---- stock templates ---------------------------------------------------------------

export type TemplateDef = {
  id: string; name: string; description: string; categories: string[]; color: string; icon: string;
  pages: { title: string; blocks: { key: string; w?: 1 | 2; chart?: Chart }[] }[];
};

export const TEMPLATES: TemplateDef[] = [
  {
    id: 'scoreboard', name: 'Weekly Wholesale Scoreboard', color: '#18181b', icon: 'W',
    description: 'The Monday-morning numbers: leads in, calls made, appointments set, offers out, contracts signed, deals assigned, fee revenue, average fee, days to assign, blast replies.',
    categories: ['Sales Performance', 'Revenue Insights', 'Team Efficiency'],
    pages: [
      { title: 'Scoreboard', blocks: [{ key: 'sellers.count' }, { key: 'calls.count' }, { key: 'appointments.count' }, { key: 'offers.sent' }, { key: 'deals.under_contract' }, { key: 'deals.won' }, { key: 'deals.won_value' }, { key: 'deals.avg_fee' }, { key: 'deals.days_to_assign' }, { key: 'general.blast_reply_rate' }, { key: 'general.lead_to_contract' }, { key: 'general.close_rate' }] },
      { title: 'Trend', blocks: [{ key: 'sellers.over_time', w: 2 }, { key: 'deals.fee_over_time', w: 2 }, { key: 'general.funnel', w: 2 }] },
    ],
  },
  {
    id: 'leaderboard', name: 'Rep Leaderboard', color: '#eda100', icon: 'R',
    description: 'Acquisitions and dispositions side by side: leads, calls, offers and contracts per acquisitions rep; deals assigned, fees and blast replies per dispo rep.',
    categories: ['Team Efficiency', 'Sales Productivity', 'Sales Performance'],
    pages: [
      { title: 'Acquisitions', blocks: [{ key: 'sellers.by_assigned' }, { key: 'calls.placed_by_rep' }, { key: 'offers.by_rep' }, { key: 'deals.won_by_acq_rep' }] },
      { title: 'Dispositions', blocks: [{ key: 'deals.won_by_dispo_rep' }, { key: 'deals.fee_by_dispo_rep' }, { key: 'blasts.top_buyers', w: 2 }] },
    ],
  },
  {
    id: 'lead-attribution', name: 'Acquisitions: Leads and Sources', color: '#2a78d6', icon: 'A',
    description: 'The seller list end to end: leads by source, stage and rep, and how many have a phone and an email to work.',
    categories: ['Lead Attribution', 'Contact Overview', 'Lead Generation'],
    pages: [
      { title: 'Overview', blocks: [{ key: 'sellers.count' }, { key: 'sellers.this_month' }, { key: 'sellers.by_source', w: 2 }, { key: 'sellers.by_stage_group' }, { key: 'sellers.by_assigned' }, { key: 'sellers.over_time', w: 2 }] },
      { title: 'Data quality', blocks: [{ key: 'sellers.with_phone' }, { key: 'sellers.without_phone' }, { key: 'sellers.with_email' }, { key: 'sellers.without_email' }, { key: 'sellers.newest', w: 2 }] },
    ],
  },
  {
    id: 'deal-statistics', name: 'Deals and Fee Revenue', color: '#0A8560', icon: '$',
    description: 'The pipeline by status and stage, contract value locked up, fees and spread on what closed, and how both move over time.',
    categories: ['Revenue Insights', 'Sales Performance', 'CRM Analytics'],
    pages: [
      { title: 'Overview', blocks: [{ key: 'deals.under_contract' }, { key: 'deals.won' }, { key: 'deals.by_status', w: 2 }, { key: 'deals.open_value' }, { key: 'deals.won_value' }, { key: 'deals.avg_fee' }, { key: 'deals.avg_spread' }, { key: 'deals.over_time', w: 2 }, { key: 'deals.fee_over_time', w: 2 }] },
      { title: 'Attribution', blocks: [{ key: 'deals.by_lead_source' }, { key: 'deals.by_market' }, { key: 'deals.won_by_acq_rep', w: 2 }] },
    ],
  },
  {
    id: 'call-statistics', name: 'Call Activity', color: '#eb6834', icon: 'C',
    description: 'The team’s call performance: incoming and outgoing by status, talk time, answer rate, first conversations, and calls per rep.',
    categories: ['Call Performance', 'Team Efficiency', 'Communication Performance'],
    pages: [
      { title: 'Calls', blocks: [{ key: 'calls.count' }, { key: 'general.answer_rate' }, { key: 'calls.incoming_by_status' }, { key: 'calls.outgoing_by_status' }, { key: 'calls.outgoing_total_duration' }, { key: 'calls.outgoing_avg_duration' }, { key: 'calls.over_time', w: 2 }] },
      { title: 'Reps and first calls', blocks: [{ key: 'calls.placed_by_rep', w: 2 }, { key: 'calls.outgoing_avg_duration_by_rep', w: 2 }, { key: 'calls.first_time_by_status' }, { key: 'calls.first_time_avg_duration' }] },
    ],
  },
  {
    id: 'appointments', name: 'Appointments', color: '#4a3aa7', icon: 'K',
    description: 'Appointment trends and engagement: booked, held and cancelled, by kind, source and rep, with what is coming up this week.',
    categories: ['Appointment Tracking', 'Calendar Performance', 'Lead Engagement'],
    pages: [
      { title: 'Appointments', blocks: [{ key: 'appointments.count' }, { key: 'appointments.cancelled' }, { key: 'appointments.by_kind' }, { key: 'appointments.by_source' }, { key: 'appointments.by_assigned', w: 2 }, { key: 'appointments.over_time', w: 2 }] },
      { title: 'This week', blocks: [{ key: 'appointments.upcoming_week', w: 2 }] },
    ],
  },
  {
    id: 'dispo', name: 'Dispo Performance Report', color: '#e34948', icon: 'B',
    description: 'How deals move to buyers: blasts sent, viewed and replied, offers received against contract price, fees and days to assign per dispo rep.',
    categories: ['Sales Productivity', 'Revenue Insights', 'Engagement Metrics'],
    pages: [
      { title: 'Blasts', blocks: [{ key: 'blasts.sent' }, { key: 'blasts.viewed' }, { key: 'blasts.replied' }, { key: 'general.blast_reply_rate' }, { key: 'blasts.by_deal', w: 2 }, { key: 'blasts.top_buyers', w: 2 }] },
      { title: 'Offers and fees', blocks: [{ key: 'offers.received' }, { key: 'offers.avg_vs_asking' }, { key: 'offers.received_per_deal', w: 2 }, { key: 'deals.won_by_dispo_rep' }, { key: 'deals.fee_by_dispo_rep' }, { key: 'deals.days_to_assign' }, { key: 'deals.won_value' }] },
    ],
  },
];

/** The template-library filter list, with counts. */
export const TEMPLATE_CATEGORIES = [...new Set(TEMPLATES.flatMap((t) => t.categories))].sort();
