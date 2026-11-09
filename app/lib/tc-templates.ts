// The transaction coordinator's texts and emails (Casey's, owner-approved
// 2026-10-21), as CLOZR templates. Migration 401 loads them into the Acme Homes
// workspace as shared templates (tools/tc-templates-sql.ts writes it from
// here), and the demo's template picker shows them too.
//
// Her source merge tags became CLOZR fields: the contact's first name, name,
// phone, email and address are {{first_name}}, {{name}}, {{phone}},
// {{email}}, {{address}}; the sender (the TC) is {{rep_first_name}} /
// {{rep_name}} / {{rep_phone}}; the purchase price is {{offer}}. Per-deal
// blanks with no CLOZR field ([legal], [EMD], [date], [Acquisitions agent],
// [doc], ...) stay as bracketed text for the TC to fill in. The wording is
// hers; only obvious typos were fixed.
//
// Title-company emails are audience 'general' (named "(title company)"): the
// record's email composer offers only the record's audience and general, and
// these go out from the seller's record.

import { type Audience, type Block, type Channel, blocksToEmail, fieldsUsed } from './message-templates';

export type TcTemplate = {
  name: string;
  channel: Channel;
  audience: Audience;
  subject: string | null;
  /** SMS: the text. Email: built from `blocks`. */
  body?: string;
  blocks?: Block[];
};

export const TC_CATEGORY = 'TC';
const REVIEW_URL = 'https://www.yourcompany.com/congratulations';

let n = 0;
const p = (text: string): Block => ({ id: `tc${++n}`, type: 'paragraph', text });
const btn = (label: string, url: string): Block => ({ id: `tc${++n}`, type: 'button', label, url });
const FULL_ADDRESS = '{{address}}, {{city}}, {{state}} {{zip}}';

export const TC_TEMPLATES: TcTemplate[] = [
  {
    name: 'TC: Seller intro', channel: 'sms', audience: 'seller', subject: null,
    body: 'Hi {{first_name}}, This is {{rep_first_name}} at Acme Homes. I am working alongside [Acquisitions agent] on this transaction to make sure it is a smooth transaction for you. Please take a look at the email I just sent you with next steps. If we are ordering photos then I will schedule. If no photos are needed then disregard. We will have the title company reach out to you to fill out a seller information sheet to get title process started. Any questions or concerns. Please feel free to reach out. Thanks!🙂',
  },
  {
    name: 'TC: Closed and funded, review ask', channel: 'sms', audience: 'seller', subject: null,
    body: `Thank you so much for allowing us to earn your business {{first_name}}! 🎉 From the Acme Homes family to yours I really appreciate your patience and the only last thing pretty please can you go here and click the button and leave us a google review and BBB review so we can help more families. It takes 2 seconds I promise. 👉${REVIEW_URL}`,
  },
  {
    name: 'TC: Seller intro with resources link', channel: 'sms', audience: 'seller', subject: null,
    body: 'Hi {{first_name}} this is {{rep_first_name}} at Acme Homes. I am working alongside [Acquisitions agent] on this transaction to make sure it is a smooth transaction for you. If we are ordering photos then I will send out a text for you to schedule. If no photos are needed then disregard. We will have the title company reach out to you. I will also be sending out a seller information sheet to get the title process started. Lastly, here is the link to our website for our resources page.\nhttps://www.yourcompany.com/resources\nAny questions or concerns. Please feel free to reach out\nThanks!🙂',
  },
  {
    name: 'TC: Seller thank-you after closing', channel: 'email', audience: 'seller', subject: 'Thank you from Acme Homes',
    blocks: [
      p('Hi {{first_name}},'),
      p("I just wanted to personally thank you for the opportunity to work with you on the sale of your property. It was a pleasure helping you through the process, and I'm glad we could get it done smoothly and efficiently."),
      p('If you feel like we did a great job, it would mean a lot if you could leave us a quick review on Google. Your feedback helps us improve and lets other sellers know what to expect when working with us.'),
      btn('👉 Leave us a Google and BBB Review Here 👈', REVIEW_URL),
      p("Thanks again for trusting us. and if you ever need help again in the future (or know someone who does, we are paying $1000 referral fees, we're always just a call away."),
      p('Warm regards,\nThe Acme Homes Team'),
    ],
  },
  {
    name: 'TC: Buyer thank-you after closing', channel: 'email', audience: 'buyer', subject: 'Thank you from Acme Homes',
    blocks: [
      p('Hi {{first_name}}, thank you again for doing business with Acme Homes! We truly appreciate the opportunity to work with you and hope the transaction was a great experience.'),
      p("We'd love to continue doing business with you on future deals, so please keep us in mind whenever you're looking for your next investment opportunity."),
      p("If you have a minute, we'd really appreciate it if you could leave us a quick review on the Better Business Bureau. Your feedback helps us build trust with new clients and continue growing our business."),
      btn('Leave a review here', REVIEW_URL),
      p('Thanks again, and we look forward to working with you again soon!'),
      p('– The Acme Homes Team'),
    ],
  },
  {
    name: 'TC: Open title, no end buyer (title company)', channel: 'email', audience: 'general', subject: '{{address}}',
    blocks: [
      p('This property is a wholesale transaction. We do not have an end buyer secured yet. This seller is the [relationship to owner of record]. See attached docs. Please let me know if you need amendments to change any names etc'),
      p(`Full property address: ${FULL_ADDRESS}\nLegal description (if available): [legal]`),
      p("Seller Contract Details:\n{{name}}\n{{phone}}\n{{email}}\n{{address}}\nSeller Purchase price: {{offer}}\nEarnest money deposit amount and who is holding it: $[EMD]\nClosing date: On or before [date]\nAny special terms (leasebacks, seller concessions, etc.) : [No]\nSeller's agent & brokerage contact info: [None]"),
      p('Additional Items: Any existing title work (if available) Any known liens, encumbrances, or special conditions:'),
    ],
  },
  {
    name: 'TC: Speed-to-lead intro', channel: 'sms', audience: 'seller', subject: null,
    body: 'Hey {{first_name}}, its {{rep_first_name}}. real quick, I just got your request for an offer on {{address}} and wanted to personally reach out. got a couple minutes to hop on a call so I can get you a quick offer?',
  },
  {
    name: 'TC: Welcome voicemail (call script)', channel: 'sms', audience: 'seller', subject: null,
    body: 'Hi, my name is {{rep_name}}. I am the Transaction Coordinator here at Acme Homes. I just wanted to give you a call to introduce myself and gain access for our visual inspection for the property on {{address}}. Please give me a call back when you can at {{rep_phone}}. Thank you!',
  },
  {
    name: 'TC: Quiet seller, day 3', channel: 'sms', audience: 'seller', subject: null,
    body: "Hey {{first_name}}, just checking in — title's ready for next steps and we're waiting on access. Want to make sure everything's okay on your end.",
  },
  {
    name: 'TC: Quiet seller, day 7', channel: 'sms', audience: 'seller', subject: null,
    body: "Hey {{first_name}}, just a reminder we're still on track to close — title's waiting on your confirmation for access. Should I keep it active or hold off for now?",
  },
  {
    name: 'TC: Schedule C cure confirmation (title company)', channel: 'email', audience: 'general', subject: '{{address}} – Schedule C requirements',
    blocks: [
      p("Hi, I reviewed the commitment for {{address}}. I'm tracking the Schedule C items and want to confirm the exact cure requirements so we don't chase the wrong documents."),
      p('For item C-[#], title is requiring [requirement].'),
      p('Can you confirm:\n1. Exactly what document/title needs?\n2. Who must sign?\n3. Whether underwriter approval is required?\n4. Whether this can close with escrow holdback, or must be cleared before closing?\n5. Whether you need attorney/probate/court documents?'),
      p("Once confirmed, I'll coordinate with the seller and upload everything to the file."),
    ],
  },
  {
    name: 'TC: Title docs needed from seller', channel: 'sms', audience: 'seller', subject: null,
    body: "Hey {{first_name}}, title reviewed the property and gave us a list of items they need cleared before closing. This is normal, but we need to move fast.\nRight now title needs:\n1. [doc]\n2. [doc]\n3. [doc]\nThis does not mean the deal is dead. It just means title needs proof before they can insure the sale. Can you send me what you have today, even if it is incomplete? I'll organize it and get title to confirm the next step.",
  },
  {
    name: 'TC: Heir outreach (heir)', channel: 'sms', audience: 'general', subject: null,
    body: "Hi {{first_name}}, I'm helping coordinate the title paperwork for {{address}}. Title shows [decedent] had an ownership interest, so they need family/heirship information before the property can close.\nI am not an attorney and I'm not making legal decisions. I'm just collecting the information title requested. Can you confirm your relationship to [decedent], your current contact info, and whether you have any probate, will, death certificate, or prior deed documents?",
  },
  {
    name: 'TC: Title check-in (title company)', channel: 'email', audience: 'general', subject: '{{address}}',
    blocks: [
      p('Hi [Title Rep], just checking in on the [document, e.g. HOA Cert] for {{address}}. We need this to stay on track for closing. Any update?'),
    ],
  },
  {
    name: 'TC: Seller document request', channel: 'sms', audience: 'seller', subject: null,
    body: "Hi {{first_name}}, thank you again for working with us! We'll need [document] to keep the process moving. Let me know if you need help getting it.",
  },
  {
    name: 'TC: New deal, open title (title company)', channel: 'email', audience: 'general', subject: '{{address}}',
    blocks: [
      p('Good afternoon, [Escrow officer names],'),
      p('We have a new deal with the above address. We do not have an end buyer secured yet. See attached executed contract as well as the TC fee to be charged from the seller, as well as our wiring instructions.'),
      p(`Full property address: ${FULL_ADDRESS}\nLegal description: [legal]`),
      p('Seller Contract Details:\n{{name}}\n{{phone}}\n{{email}}'),
      p('Please reach out if anything else is needed from us.'),
      p('Thank you,'),
    ],
  },
  {
    name: 'TC: Introduction to title and seller (title company)', channel: 'email', audience: 'general', subject: '{{address}}',
    blocks: [
      p('Good afternoon [Title rep],'),
      p('My name is {{rep_name}}, and I will be the Transaction Coordinator assisting with this transaction and helping get everything to the closing table.'),
      p("I've included the title company, seller, and our Acme Homes team on this email so everyone is kept in the loop throughout the process."),
      p('We have a new deal for the property listed below. Please see the attached fully executed Purchase Agreement between the Seller and Acme Homes.'),
      p(`Property Address: ${FULL_ADDRESS}\nLegal Description: [legal]`),
      p("[Optional: With this one, [finder] is to be paid a $[amount] Finder's Fee from the {{offer}} Purchase Price. Please see page [x] for this information on the contract.]"),
      p('Seller Details:\n{{name}}\n{{email}}'),
      p('Please feel free to reach out if you need anything else from our team or if there are any questions regarding the transaction.'),
      p('Thank you,'),
    ],
  },
  {
    name: 'TC: Status to Clear to Close (title company)', channel: 'email', audience: 'general', subject: '{{address}} – status to Clear to Close',
    blocks: [
      p('Hi Title Team,'),
      p("For {{address}}, we're working through the current title commitment and want to confirm the remaining requirements needed to reach Clear to Close."),
      p('Could you please provide an updated status on the following Schedule C items:'),
      p('[Item 1]. Please confirm whether title has completed its review and whether anything further is required.'),
      p('[Item 2, named party] – Please confirm their current status and whether any documentation, joinder, release, or other curative action is required.'),
      p('Any Other Outstanding Requirements – Please let us know if there are any additional title, payoff, lien, tax, possession, or recording items currently preventing Clear to Close.'),
      p('Please also confirm whether there are any Schedule B exceptions or Schedule C requirements that you anticipate could affect closing or require additional curative work.'),
      p('Our goal is to get ahead of any remaining items and avoid any closing delays, so a complete list of outstanding requirements and the expected path to CTC would be greatly appreciated.'),
      p('Thank you,'),
    ],
  },
  {
    name: 'TC: Prelim follow-up (title company)', channel: 'email', audience: 'general', subject: '{{address}}',
    blocks: [
      p('Good Morning,'),
      p('How soon are we able to get the pre-lim back for review?'),
      p('Thank you,'),
    ],
  },
  {
    name: 'TC: Title commitment follow-up (title company)', channel: 'email', audience: 'general', subject: '{{address}}',
    blocks: [
      p('Good morning, [name],'),
      p('When can we expect to get the title commitment back for {{address}}?'),
      p('Thank you,'),
    ],
  },
  {
    name: 'TC: Seller information sheet reminder', channel: 'sms', audience: 'seller', subject: null,
    body: 'Good Morning {{first_name}}, I have sent the Seller information sheet for you to sign by the end of the day today. If you have any questions please feel free to reach out to me, we need it back ASAP. Thank you',
  },
];

/** Each template as a message_templates row: an email's HTML and text part from its blocks, the fields it uses. */
export function tcTemplateRows() {
  return TC_TEMPLATES.map((t) => {
    const email = t.channel === 'email' ? blocksToEmail(t.blocks ?? []) : null;
    const body_text = email ? email.text : t.body ?? '';
    return {
      name: t.name, channel: t.channel, audience: t.audience, category: TC_CATEGORY, subject: t.subject,
      body_text, body_html: email ? email.html : null, blocks: email ? t.blocks ?? [] : null,
      merge_fields: fieldsUsed(t.subject, body_text),
    };
  });
}
