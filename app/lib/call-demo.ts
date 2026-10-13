// The sample-data demo's recorded call, so /demo shows the smart player with
// a synced transcript and chapters. The audio is generated silence of the
// call's length (the demo ships no recordings), which is enough to play,
// seek and follow the transcript.
import { segmentsFromText, normalizeSections, type CallSection, type CallSegment } from './call-media';
import { encodeWav } from './audio-wav';

const TEXT = [
  "Rep: Hi Kara, it's Taylor with Acme Homes. Got your text. Is now still good?",
  'Contact: Yes, perfect. I went over the offer with my brother last night.',
  'Rep: Great. What made you both start thinking about selling?',
  'Contact: Mom passed in the spring and neither of us lives in San Antonio anymore. We need to be out before September 30th.',
  'Rep: I am sorry to hear that. How is the house holding up?',
  'Contact: The roof leaks over the back bedroom and the AC is original. Kitchen was never updated.',
  'Rep: Understood. What number did you two land on?',
  'Contact: The number was a bit lower than we hoped. Another investor said 235 but they wanted 60 days and an inspection.',
  'Rep: If we could guarantee your close date and cover moving costs, how would that compare to a higher number with uncertainty?',
  'Contact: That matters a lot. Honestly, certainty. And not having to fix anything.',
  'Rep: Then let me send over a contract tonight at 221 with a September 20th close and no inspection.',
  'Contact: Send it over and I will look at it with my brother tomorrow.',
].join('\n');

export const DEMO_CALL_SECONDS = 96;

export const DEMO_SEGMENTS: CallSegment[] = segmentsFromText(TEXT, DEMO_CALL_SECONDS);

export const DEMO_SECTIONS: CallSection[] = normalizeSections({
  sections: [
    { kind: 'intro', title: 'Intro', start_index: 0, summary: 'Kara reviewed the offer with her brother.' },
    { kind: 'motivation', title: 'Estate, out by Sept 30', start_index: 2, summary: 'Inherited house, both heirs live out of town.' },
    { kind: 'property', title: 'Roof leak and old AC', start_index: 4, summary: 'Roof leaks over the back bedroom; AC original.' },
    { kind: 'price', title: 'Competing 235K', start_index: 6, summary: 'Another investor at 235K with 60 days and inspection.' },
    { kind: 'objections', title: 'Certainty over price', start_index: 8, summary: 'Close date and no repairs matter more than top dollar.' },
    { kind: 'next_steps', title: 'Contract tonight', start_index: 10, summary: '221K, Sept 20 close, no inspection.' },
  ],
}, DEMO_SEGMENTS) ?? [];

let url: string | null = null;
/** A silent WAV the length of the demo call, made once per page. */
export function demoCallAudio(): string | null {
  if (typeof window === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  if (!url) url = URL.createObjectURL(new Blob([encodeWav(new Float32Array(DEMO_CALL_SECONDS * 4000), 4000)], { type: 'audio/wav' }));
  return url;
}
