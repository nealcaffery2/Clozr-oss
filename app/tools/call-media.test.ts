// Call player rules, Deepgram credential scheme, AI call config messages.
// Run: npx tsx tools/call-media.test.ts
import {
  activeIndex, fmtClock, keywordSections, normalizeMatches, normalizeSections, parseSegments, queryTerms, sectionsFresh,
  segmentsFromText, textSearch,
} from '../lib/call-media';
import { deepgramScheme, closeReason, Downsampler, interleave16 } from '../lib/live-transcript';
import { liveSegments, liveTranscriptText, notesFromSummary } from '../lib/call-file';
import { encodeWav } from '../lib/audio-wav';

let failed = 0;
const eq = (label: string, got: unknown, exp: unknown) => {
  const pass = JSON.stringify(got) === JSON.stringify(exp);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`}`);
  if (!pass) failed++;
};

// segments
const talkr = parseSegments([
  { start: 4.2, end: 6, speaker: 'contact', text: 'Hello?' },
  { start: 0, end: 3.9, speaker: 'rep', text: "Hi, it's Taylor with Acme Homes." },
  { start: 7, speaker: 'x', text: '  ' },
  { start: 'bad', text: 'dropped' },
])!;
eq('parse keeps valid rows, time ordered', talkr.map((s) => s.speaker), ['rep', 'contact']);
eq('parse fills a missing end', parseSegments([{ start: 2, text: 'hi' }])![0]!.end, 2);
eq('parse rejects non-arrays', parseSegments({}), null);

const flat = segmentsFromText('Rep: Hi Kara\nContact: Yes, perfect.\nSeller: The roof leaks.', 30);
eq('flat text speakers', flat.map((s) => s.speaker), ['rep', 'contact', 'contact']);
eq('flat text spans the call', flat[flat.length - 1]!.end, 30);
eq('flat text strips the label', flat[2]!.text, 'The roof leaks.');
eq('rep by first name', segmentsFromText('Taylor: hi\nKara: hello', 10, 'Taylor').map((s) => s.speaker), ['rep', 'unknown']);

eq('active index before start', activeIndex(talkr, -1), -1);
eq('active index inside second', activeIndex(talkr, 5), 1);
eq('active index past end', activeIndex(talkr, 99), 1);
eq('clock', [fmtClock(0), fmtClock(75.9), fmtClock(3725)], ['0:00', '1:15', '1:02:05']);

// search
const call = segmentsFromText([
  'Rep: What made you think about selling?',
  'Contact: We are moving for my job in October.',
  'Rep: How is the roof?',
  'Contact: The shingles are old and the roof leaks in the back bedroom.',
  'Rep: What number would work for you?',
  'Contact: We were hoping for 235k.',
  'Rep: I can send over a contract tomorrow.',
].join('\n'), 70);
eq('query terms drop filler', queryTerms('Where did they mention the roofs?'), ['roof']);
eq('text search finds the roof', textSearch(call, 'where did they mention the roof?'), [2, 3]);
eq('text search nothing', textSearch(call, 'pool'), []);

// sections
const kw = keywordSections(call);
eq('keyword sections start on intro', kw[0]!.kind, 'intro');
eq('keyword sections are time ordered', kw.every((s, i) => i === 0 || s.start >= kw[i - 1]!.start), true);
eq('keyword sections find price', kw.some((s) => s.kind === 'price'), true);
eq('last section ends at the call end', kw[kw.length - 1]!.end, call[call.length - 1]!.end);

const ai = normalizeSections({ sections: [
  { kind: 'price', title: 'Asking 235k', start_index: 4, summary: 'They want 235k.' },
  { kind: 'motivation', title: 'Job move', start_index: 0 },
  { kind: 'nonsense', title: '', start_index: 2 },
  { kind: 'price', title: 'dup', start_index: 4 },
  { kind: 'next_steps', title: 'Contract', start_index: 99 },
] }, call)!;
eq('ai sections validated', ai.map((s) => [s.kind, s.index]), [['motivation', 0], ['other', 2], ['price', 4]]);
eq('unknown kind gets its label', ai[1]!.title, 'Other');
eq('ai sections end where the next starts', ai[0]!.end, call[2]!.start);
eq('no sections is null', normalizeSections({ sections: [] }, call), null);
eq('intro added when missing', normalizeSections({ sections: [{ kind: 'price', title: 'P', start_index: 3 }] }, call)!.map((s) => s.kind), ['intro', 'price']);

eq('matches validated', normalizeMatches({ matches: [{ index: 3, why: 'roof' }, { index: 3 }, { index: 50 }, { index: 2 }] }, call.length), [{ index: 3, why: 'roof' }, { index: 2, why: null }]);
eq('fresh sections need the same transcript', [
  sectionsFresh({ sections: ai, source: 'ai', model: 'm', at: '', segments: call.length }, call.length),
  sectionsFresh({ sections: ai, source: 'ai', model: 'm', at: '', segments: 3 }, call.length),
  sectionsFresh({ sections: ai, source: 'keywords', model: null, at: '', segments: call.length }, call.length),
], [true, false, false]);

// Deepgram
eq('grant JWT goes as bearer', deepgramScheme('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-_x'), 'bearer');
eq('temporary API key goes as token', deepgramScheme('3f2a9c0e7b1d4a5f8e6c2b1a0d9e8f7c6b5a4d3e'), 'token');
eq('refused key is named', /DEEPGRAM_API_KEY/.test(closeReason(1008, '')), true);
eq('silent close still says something', closeReason(1006, '').length > 10, true);
const d = new Downsampler(48_000, 16_000);
eq('48k to 16k is a third', d.push(new Float32Array(4096)).length + d.push(new Float32Array(4096)).length, Math.floor(8192 / 3));
const d44 = new Downsampler(44_100, 16_000);
let n44 = 0;
for (let i = 0; i < 100; i++) n44 += d44.push(new Float32Array(441)).length;
eq('44.1k to 16k does not drift', Math.abs(n44 - 16_000) <= 1, true);
eq('interleave is stereo PCM16', new Int16Array(interleave16(new Float32Array([1, -1]), new Float32Array([0, 0.5]), 2)).join(','), [32767, 0, -32768, 16383].join(','));

// filing
const lines = [{ speaker: 'rep' as const, text: 'Hi', start: 0.5, end: 1 }, { speaker: 'seller' as const, text: 'Hello', start: 1.2, end: 2 }];
eq('live text', liveTranscriptText(lines), 'Rep: Hi\nContact: Hello');
eq('live segments offset to the recording', liveSegments(lines, 2).map((s) => [s.start, s.speaker]), [[2.5, 'rep'], [3.2, 'contact']]);
eq('summary to notes', notesFromSummary({ mode: 'summary', talk_ratio: { rep: 40, seller: 60 }, summary: 'S', sentiment: 'neutral', motivation: 'job', timeline: null, price_expectation: '235k', objection: 'low', condition: null, follow_up: 'send contract', suggested_task: null }).rep_talk_ratio, 0.4);

// wav
const wav = new DataView(encodeWav(new Float32Array([0, 1, -1]), 16_000));
eq('wav header', [String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3)), wav.getUint32(24, true), wav.getUint16(22, true), wav.getUint32(40, true)], ['RIFF', 16000, 1, 6]);

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
