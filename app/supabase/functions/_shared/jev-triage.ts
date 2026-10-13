// Jev questions duplicated for the Deno edge isolate.
// Keep in step with app/lib/jev-triage.ts TRIAGE_QUESTIONS — tools/jev-triage.test.ts
// compares the two.

export const JEV_MODEL = 'jev-latest';
export const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

export const TRIAGE_QUESTIONS = {
  disposition: {
    type: 'choice',
    instructions:
      'Should an acquisitions manager pursue this seller lead now, nurture it for later, or skip it? Judge from stage, motivation, contactability, timeline and numbers — not from the lead\'s name.',
    criteria: {
      pursue:
        'Worth a live conversation or an offer path now: motivated or time-sensitive seller, reachable (phone or email), a plausible wholesale path, and not already dead, listed-retail, or junk.',
      nurture:
        'Not ready to work this week but could be later: long timeline, exploring options, missing contact info, thin facts, or already sitting in a nurture stage.',
      skip:
        'Do not work: not selling, duplicate, asking retail, listed with an agent, bad location, negative equity, ghosted, refund, or otherwise dead.',
    },
  },
  urgent: {
    type: 'noul',
    instructions:
      'Does this lead need acquisitions action inside the next 24 hours?',
    criteria: {
      true:
        'Time-sensitive: foreclosure or behind on payments, relocating soon, inbound and unanswered, a new uncontacted lead with a phone, or a stated ASAP / days-not-months timeline.',
      false:
        'Can wait: long-term nurture, no timeline, already in a working follow-up, no way to contact, or a skip.',
    },
  },
  next_action: {
    type: 'choice',
    instructions: 'What should the acquisitions manager do next with this lead?',
    criteria: {
      call_now: 'Dial now — new, uncontacted, reachable, or time-sensitive.',
      follow_up: 'Scheduled follow-up — already contacted or waiting on them.',
      underwrite: 'Run COMPR / gather numbers before the next live conversation.',
      nurture_sequence: 'Enroll in a nurture plan; no live work this week.',
      close_out: 'Move to a dead/skip stage and stop working it.',
    },
  },
} as const;
