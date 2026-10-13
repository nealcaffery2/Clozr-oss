// Example action plans. Three for sellers, three for buyers, the TC sequence
// for a typical contract-to-close workflow, and the new-source
// weekly email. National sources are listed on the source plan as skip tags
// so that plan never emails them.
//
// Opening Action plans inserts any of these that the workspace does not
// already have, matched by name, so a rename or an edit is left alone.

export type CatalogAudience = 'seller' | 'buyer' | 'tc' | 'source';

export type CatalogStep = {
  type: 'sms' | 'email' | 'call' | 'task';
  delay: number;
  unit: 'minutes' | 'hours' | 'days' | 'weeks';
  title: string;
  body: string;
  subject?: string;
  priority?: 'low' | 'normal' | 'high';
};

export type CatalogPlan = {
  audience: CatalogAudience;
  name: string;
  description: string;
  trigger_type: 'manual' | 'stage' | 'tag';
  trigger_value: string;
  active: boolean;
  skip_tags: string[];
  stop_on_reply: boolean;
  stop_on_stage: boolean;
  tone: string;
  steps: CatalogStep[];
};

const seller: CatalogPlan[] = [
  {
    audience: 'seller',
    name: 'New submission needs an offer',
    description: 'A new source deal that still needs a number. The lead is assigned to whoever created it, or to the person who imported the batch when several came in together. Then it is underwritten and offered.',
    trigger_type: 'stage',
    trigger_value: 'New Submission',
    active: true,
    skip_tags: [],
    stop_on_reply: false,
    stop_on_stage: true,
    tone: 'Internal. Short tasks, no seller email until the offer is ready.',
    steps: [
      { type: 'task', delay: 0, unit: 'minutes', priority: 'high', title: 'Assign to the creator', body: 'This submission is assigned to whoever created the lead. If it came in on an import, that is the person who imported the batch. Confirm the owner before anyone else starts underwriting.' },
      { type: 'task', delay: 15, unit: 'minutes', priority: 'high', title: 'Underwrite the submission', body: 'Pull the address, ask, photos, and access. Run COMPR. Do not sit on a new source deal that is waiting on a number.' },
      { type: 'call', delay: 0, unit: 'minutes', priority: 'high', title: 'Confirm the deal with the source', body: 'Call the person who sent it. Confirm price, access, occupancy, and whether anyone else has it. If this is a homeowner lead, this call is the first seller conversation instead.' },
      { type: 'task', delay: 1, unit: 'days', priority: 'high', title: 'Send the offer', body: 'Move the stage to Offer Made once the number is out. If it cannot be offered, move it to Underwrite Declined and say why in the note.' },
    ],
  },
  {
    audience: 'seller',
    name: 'Seller first week',
    description: 'The first week after a seller lead is contacted and still needs a follow-up. Stops when they reply or the stage moves.',
    trigger_type: 'stage',
    trigger_value: 'Contacted - Follow Up Needed',
    active: true,
    skip_tags: [],
    stop_on_reply: true,
    stop_on_stage: true,
    tone: 'Direct and calm. One ask per touch.',
    steps: [
      { type: 'sms', delay: 0, unit: 'minutes', title: 'Same-day text', body: 'Hi {{first_name}}, this is {{rep_name}} with Acme Homes. Still happy to take a look at {{address}}. What is the best time today for a short call?' },
      { type: 'call', delay: 1, unit: 'days', title: 'Next-day call', body: 'Call {{first_name}}. Confirm motivation, timeline, condition, and who else is on the title. If they answer, book the next step before you hang up.' },
      { type: 'email', delay: 1, unit: 'days', title: 'How the process works', subject: '{{address}} — how a Acme Homes sale actually goes', body: 'Hi {{first_name}},\n\nWanted to put the process in writing so it is easy to share. We buy as-is, we cover the usual closing costs, and a title company handles the paperwork. If {{address}} is something you want to move on, reply with a time and I will call.\n\n{{rep_name}}\nAcme Homes' },
      { type: 'call', delay: 3, unit: 'days', title: 'End-of-week call', body: 'Last call of the first week. If there is no answer and no reply, move them to a nurture stage instead of leaving them here.' },
    ],
  },
  {
    audience: 'seller',
    name: 'Offer on the table',
    description: 'Keeps an offer alive after Offer Made without stacking messages the same day. Stops on a reply or when the stage leaves Offer Made.',
    trigger_type: 'stage',
    trigger_value: 'Offer Made',
    active: true,
    skip_tags: [],
    stop_on_reply: true,
    stop_on_stage: true,
    tone: 'Plain. The number is the point. Do not apologize for it.',
    steps: [
      { type: 'sms', delay: 2, unit: 'hours', title: 'Confirm they saw it', body: '{{first_name}}, checking that the offer for {{address}} came through. What questions do you have on it?' },
      { type: 'call', delay: 1, unit: 'days', title: 'Walk the number', body: 'Call and walk the offer. Ask what would make it a yes. Write the answer on the record before you hang up.' },
      { type: 'email', delay: 2, unit: 'days', title: 'What the number is based on', subject: 'Offer for {{address}}', body: 'Hi {{first_name}},\n\nThe offer is based on what similar homes closed for and what the repairs look like. Happy to walk through it line by line. If a different number would get this done, tell me what that is and I will take it to the team.\n\n{{rep_name}}\nAcme Homes' },
      { type: 'sms', delay: 2, unit: 'days', title: 'Last nudge', body: '{{first_name}}, still holding the offer on {{address}}. Want me to leave it open, or should I close it out?' },
    ],
  },
];

const buyer: CatalogPlan[] = [
  {
    audience: 'buyer',
    name: 'New buyer introduction',
    description: 'First sequence for a buyer who was just added. Started by hand from the buyer record or a bulk enroll. Stops when they reply.',
    trigger_type: 'manual',
    trigger_value: '',
    active: true,
    skip_tags: [],
    stop_on_reply: true,
    stop_on_stage: false,
    tone: 'Business casual. Short. Assume they buy deals, not that they need the company explained.',
    steps: [
      { type: 'email', delay: 0, unit: 'minutes', title: 'Intro', subject: 'Acme Homes deals in your buy box', body: 'Hi {{first_name}},\n\n{{rep_name}} at Acme Homes. We move assignment, double close, JV, and novation deals and I want to send you the ones that fit how you buy.\n\nReply with the markets, price band, and condition you actually want. I will only send those.\n\n{{rep_name}}\nAcme Homes' },
      { type: 'call', delay: 1, unit: 'days', title: 'Buy box call', body: 'Call and lock the buy box: price, markets, rehab tolerance, and whether they take assignment, double close, or both. Write it on the buyer record.' },
      { type: 'sms', delay: 2, unit: 'days', title: 'One-line check', body: 'Hey {{first_name}}, {{rep_name}} at Acme Homes. Easiest way to get you deals — text or email?' },
    ],
  },
  {
    audience: 'buyer',
    name: 'Buyer matched to a deal',
    description: 'Use when a buyer fits a live deal. Four touches, then it stops. Enroll from the deal\'s buyer matches.',
    trigger_type: 'manual',
    trigger_value: '',
    active: true,
    skip_tags: [],
    stop_on_reply: true,
    stop_on_stage: false,
    tone: 'Specific. Name the house. Do not send a newsletter.',
    steps: [
      { type: 'sms', delay: 0, unit: 'minutes', title: 'The house', body: '{{first_name}}, got one that fits you: {{address}} in {{city}}. Want the numbers?' },
      { type: 'email', delay: 3, unit: 'hours', title: 'Numbers', subject: '{{address}} — {{city}}', body: 'Hi {{first_name}},\n\nSending {{address}} because it sits in what you buy. I can send photos, the assignment or double-close path, and a time to walk it.\n\nIf you want it, reply with your number and proof of funds and I will hold the conversation for you.\n\n{{rep_name}}\nAcme Homes' },
      { type: 'call', delay: 1, unit: 'days', title: 'Follow the text', body: 'Call about {{address}}. Ask if they reviewed it and what their number is. Log the offer or the pass.' },
      { type: 'task', delay: 3, unit: 'days', priority: 'normal', title: 'Pass or pause', body: 'If they have not answered, mark the match passed and take the next buyer. Do not keep this one on a drip after four touches.' },
    ],
  },
  {
    audience: 'buyer',
    name: 'Buyer went quiet',
    description: 'A buyer who used to respond and stopped. Three touches over three weeks, then it ends. Stops the moment they reply.',
    trigger_type: 'manual',
    trigger_value: '',
    active: true,
    skip_tags: [],
    stop_on_reply: true,
    stop_on_stage: false,
    tone: 'Light. One question. No guilt.',
    steps: [
      { type: 'sms', delay: 0, unit: 'minutes', title: 'Still buying?', body: '{{first_name}}, {{rep_name}} at Acme Homes. Still buying in {{city}}, or should I take you off new deals for now?' },
      { type: 'email', delay: 1, unit: 'weeks', title: 'What changed', subject: 'Should I keep sending deals?', body: 'Hi {{first_name}},\n\nI have not heard back, so I do not want to keep sending houses you are not looking at. If the buy box changed — price, market, or condition — reply with the new one and I will match that.\n\n{{rep_name}}\nAcme Homes' },
      { type: 'call', delay: 2, unit: 'weeks', title: 'Close the loop', body: 'One call. If no answer, leave them off active blasts and note the date.' },
    ],
  },
];

// Contract-to-close workflow: contract in 10 minutes, fact-check, welcome,
// title and EMD, access and inspection photos, weekly seller touch, title every
// day, CTC, prelim HUD with the ops lead copied, no Friday close, funded email.
const tc: CatalogPlan[] = [
  {
    audience: 'tc',
    name: 'TC · Contract out and handoff',
    description: 'Starts when the seller hits Under Contract - Seller. The contract goes out within 10 minutes, the file is fact-checked, the seller gets a welcome call and email, and title gets the file with EMD instructions.',
    trigger_type: 'stage',
    trigger_value: 'Under Contract - Seller',
    active: true,
    skip_tags: [],
    stop_on_reply: false,
    stop_on_stage: false,
    tone: 'TC voice from the handbook: friendly, short, certain. Future-frame. Do not say you do not know.',
    steps: [
      { type: 'task', delay: 0, unit: 'minutes', priority: 'high', title: 'Send the contract within 10 minutes', body: 'Deal is under contract with the seller. Send the contract immediately. The workflow cap is 10 minutes. None get missed.' },
      { type: 'task', delay: 30, unit: 'minutes', priority: 'high', title: 'Fact-check the executed file', body: 'Once it is fully executed: confirm it is not null and void and every signature is real. Check the execution deadline. If they signed after the deadline, resend with a new deadline and have the seller resign. Check owner of record and whether anyone else must sign (probate, divorce, deceased). Tell acquisitions the file is in handoff.' },
      { type: 'call', delay: 0, unit: 'minutes', priority: 'high', title: 'Seller welcome call', body: 'Hi, this is the transaction coordinator at Acme Homes. Introduce yourself, confirm {{address}}, and ask for access for the visual inspection. If they miss you, the voicemail is the TC intro: your name, Acme Homes, the street, and a callback number.' },
      { type: 'email', delay: 1, unit: 'hours', title: 'Seller welcome email', subject: 'Acme Homes is on {{address}} from here', body: 'Hi {{first_name}},\n\nI am the transaction coordinator at Acme Homes and I will take {{address}} from here through closing. Next we need access for a visual inspection, then title opens and we keep you posted.\n\nWe typically close on or before 30 days. The faster we can get in, the faster that clock starts.\n\nReply with a time that works for access, or call me back on this thread.\n\nAcme Homes Transaction Coordination' },
      { type: 'task', delay: 2, unit: 'hours', priority: 'high', title: 'Title file and EMD', body: 'Send the file to the title company with EMD instructions. Use the title company your team routes this state to. Fill the TC notes and make sure the seller info sheet is on the file.' },
    ],
  },
  {
    audience: 'tc',
    name: 'TC · Access, photos, ready for market',
    description: 'Starts with the contract plan when the seller hits Under Contract - Seller. After execution: get access, photos, lockbox, inspection photos uploaded within 24 hours with the signer order, Drive complete, then move the deal to Ready for Market. Seller check-ins follow once and then weekly.',
    trigger_type: 'stage',
    trigger_value: 'Under Contract - Seller',
    active: true,
    skip_tags: [],
    stop_on_reply: false,
    stop_on_stage: false,
    tone: 'Organized. Tie access to closing speed, not to company policy.',
    steps: [
      { type: 'task', delay: 0, unit: 'minutes', priority: 'high', title: 'Get access', body: 'Get access to {{address}}. Order photos. Set the lockbox or send the authorization form.' },
      { type: 'task', delay: 1, unit: 'days', priority: 'high', title: 'Inspection photos within 24 hours', body: 'Upload the inspection photos to your inspection platform within 24 hours of access. Signers, in order: you, then the acquisition manager if they cannot reach you, then the manager if acquisitions cannot be reached. Put every file on the Google Drive for this deal.' },
      { type: 'task', delay: 0, unit: 'minutes', priority: 'high', title: 'Move to Ready for Market', body: 'When photos, access, and the Drive file are done, move the deal from Seller Under Contract to Ready for Market.' },
      { type: 'call', delay: 3, unit: 'days', title: 'Seller check-in', body: 'Check in with the seller. Tell them what is already done (title submitted, inspection scheduled) even if it feels quiet on their side. Text the same update after the call.' },
      { type: 'email', delay: 4, unit: 'days', title: 'Weekly seller update', subject: '{{address}} — where we are this week', body: 'Hi {{first_name}},\n\nQuick update on {{address}}. Title is in process and we are keeping the closing on track. I will check in again next week, sooner if title needs something from you.\n\nAcme Homes Transaction Coordination' },
      { type: 'email', delay: 1, unit: 'weeks', title: 'Weekly seller update 2', subject: '{{address}} — still on track', body: 'Hi {{first_name}},\n\nChecking in on {{address}}. We are still on track. If anything on your side changed — move-out, a question on the paperwork, or a title document — reply here and I will handle it.\n\nAcme Homes Transaction Coordination' },
    ],
  },
  {
    audience: 'tc',
    name: 'TC · Title to funded',
    description: 'Starts when the seller hits Under Contract - Buyer (the deal at Buyer Under Contract). From title through funding: title every day, commitment and its Schedule C items, clear to close, preliminary settlement statement about three days out with the ops lead approving, no Friday closing unless wires and signatures are in on Thursday, then the We\'re Funded email and the final Drive file.',
    trigger_type: 'stage',
    trigger_value: 'Under Contract - Buyer',
    active: true,
    skip_tags: [],
    stop_on_reply: false,
    stop_on_stage: false,
    tone: 'Certain. Escalate title delays. Do not guess at a HUD number.',
    steps: [
      { type: 'task', delay: 0, unit: 'minutes', priority: 'high', title: 'Ask title for the commitment', body: 'Check title today. Ask for the commitment. Read it the day it arrives and mark each Schedule C item green, yellow or red on the TC file. Help the seller get documents to title and tell every party what is outstanding.' },
      { type: 'task', delay: 1, unit: 'days', priority: 'high', title: 'Title check', body: 'Check title again. If they are slow, escalate. Do not wait a week to find out the file stalled.' },
      { type: 'call', delay: 0, unit: 'minutes', priority: 'high', title: 'Buyer earnest money', body: 'Call the buyer and collect EMD as soon as they are under contract. Keep a weekly touch with the buyer until close.' },
      { type: 'task', delay: 2, unit: 'days', priority: 'high', title: 'Clear to close', body: 'After the commitment items are clear, ask title for CTC. If CTC comes in earlier than the close date, ask buyer and seller to move the date up and send the amendment. If CTC is refused, get the reason in writing and call the manager at Acme Homes.' },
      { type: 'task', delay: 1, unit: 'days', priority: 'high', title: 'Preliminary HUD, ops lead approves', body: 'Get the preliminary settlement statement, aiming for three days before close or sooner. Review it and get a thumbs up. Copy the ops lead on every final HUD. Hedge fund and institutional buyers need every file in Google Drive before close. Schedule the final walkthrough.' },
      { type: 'task', delay: 1, unit: 'days', priority: 'high', title: 'No Friday closing', body: 'Closings are Monday through Thursday. If someone booked a Friday, tell the team and move the parties. If Friday cannot move, buyer and seller pre-sign Thursday or sooner, the buyer wires Thursday, and title confirms the wire is in.' },
      { type: 'email', delay: 0, unit: 'minutes', title: "We're Funded", subject: "We're Funded: {{address}}", body: 'Hi everyone,\n\n{{address}} is funded. Final closing documents are going into the Google Drive for this file today.\n\nAcme Homes Transaction Coordination' },
      { type: 'task', delay: 0, unit: 'minutes', priority: 'normal', title: 'Final documents in Drive', body: 'Confirm the funded package and the final closing documents are in Google Drive. Then the file is done.' },
    ],
  },
];

const source: CatalogPlan[] = [
  {
    audience: 'source',
    name: 'New source weekly',
    description: 'For a new wholesaler source. A business-casual email once a week, each one asking in a different way whether they have another deal we can look at. National sources and national partners are skipped — they do not get this email. Tag the source "New source" to start it. Tag "National" or "National partner" and it will not enroll.',
    trigger_type: 'tag',
    trigger_value: 'New source',
    active: true,
    skip_tags: ['National', 'National partner'],
    stop_on_reply: true,
    stop_on_stage: false,
    tone: 'Business casual. Like a note to someone you already do deals with. Never the same ask two weeks in a row.',
    steps: [
      { type: 'email', delay: 0, unit: 'minutes', title: 'Week 1', subject: 'Got another one we should look at?', body: 'Hey {{first_name}},\n\nAppreciate you sending {{address}} over. If you have another one sitting there — even if the numbers are rough — send it and we will tell you the same day whether we can offer.\n\n{{rep_name}}\nAcme Homes' },
      { type: 'email', delay: 1, unit: 'weeks', title: 'Week 2', subject: 'What else are you working?', body: 'Hey {{first_name}},\n\nChecking in. What else are you working this week? We are looking at assignment, JV, double close, and novation, so the structure does not have to be decided before you send it.\n\n{{rep_name}}\nAcme Homes' },
      { type: 'email', delay: 1, unit: 'weeks', title: 'Week 3', subject: 'Anything new on your desk?', body: 'Hey {{first_name}},\n\nAnything new on your desk we should underwrite? A one-line address and your ask is enough to start.\n\n{{rep_name}}\nAcme Homes' },
      { type: 'email', delay: 1, unit: 'weeks', title: 'Week 4', subject: 'Want me to look before you shop it?', body: 'Hey {{first_name}},\n\nIf you would rather have a number from us before you shop a deal around, send it here first. We will look the day it comes in.\n\n{{rep_name}}\nAcme Homes' },
      { type: 'email', delay: 1, unit: 'weeks', title: 'Week 5', subject: 'Still taking deals from you', body: 'Hey {{first_name}},\n\nStill want deals from you. If the last few were outside what we buy, tell me the market you are finding inventory in and I will tell you straight whether to keep sending those.\n\n{{rep_name}}\nAcme Homes' },
      { type: 'email', delay: 1, unit: 'weeks', title: 'Week 6', subject: 'Open to whatever you are contracted on', body: 'Hey {{first_name}},\n\nIf you are already under contract on something and need an end buyer or a JV, that counts too. Send the address and the contract price when you have a minute.\n\n{{rep_name}}\nAcme Homes' },
    ],
  },
];

export const ACTION_PLAN_CATALOG: CatalogPlan[] = [...seller, ...buyer, ...tc, ...source];

export const catalogByAudience = (audience: CatalogAudience) =>
  ACTION_PLAN_CATALOG.filter((p) => p.audience === audience);

/** Which record screens a plan may be started from. */
export type PlanRecordKind = 'seller' | 'buyer' | 'vendor';

/**
 * Seller plans → seller records. Buyer plans → buyer records. TC plans → every
 * record. Source plans → vendors (wholesaler follow-up). A blank audience is
 * treated as seller — that is what every plan was before audiences existed.
 */
export function planFitsRecord(audience: string | null | undefined, kind: PlanRecordKind): boolean {
  const a = (audience ?? '').trim().toLowerCase();
  if (a === 'tc') return true;
  if (!a) return kind === 'seller';
  if (kind === 'seller') return a === 'seller';
  if (kind === 'buyer') return a === 'buyer';
  if (kind === 'vendor') return a === 'source';
  return false;
}

/**
 * The plans a record's "Start an action plan" dropdown lists: every plan for
 * that kind of record. `active` only decides whether a plan enrolls people by
 * itself from its trigger; a plan that is off can still be started by hand,
 * which is how these example templates (seeded off) are meant to be used.
 */
export function plansForRecord<T extends { active: boolean; audience?: string | null }>(
  plans: T[],
  kind: PlanRecordKind,
): T[] {
  return plans.filter((pl) => planFitsRecord(pl.audience, kind));
}
