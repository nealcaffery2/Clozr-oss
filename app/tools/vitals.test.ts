// lib/vitals.ts: rows from browser entries, the worst-N per view, the payload,
// and that a target never carries what a person wrote or a record holds.
// npx tsx tools/vitals.test.ts
import {
  chunkName, closeView, describeTarget, drain, frameRow, hold, interactionRow, keepWorst,
  newViews, one, payload, releaseOf, screenOf, shortAgent, type VitalRow,
} from '../lib/vitals';

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error('FAIL', name, '\n got ', got, '\n want', want);
    process.exitCode = 1;
  } else console.log('ok', name);
}

// ---- a fake DOM: enough for closest() with tag and [attr] selectors ----------
type Fake = { tagName: string; attrs: Record<string, string>; parent: Fake | null; text: string;
  getAttribute(n: string): string | null; closest(s: string): Fake | null };
function el(tag: string, attrs: Record<string, string> = {}, parent: Fake | null = null, text = ''): Fake {
  const self: Fake = {
    tagName: tag.toUpperCase(), attrs, parent, text,
    getAttribute: (n) => (n in attrs ? attrs[n]! : null),
    closest(sel) {
      const parts = sel.split(',').map((p) => p.trim());
      for (let n: Fake | null = self; n; n = n.parent) {
        if (parts.some((p) => (p.startsWith('[') ? p.slice(1, -1) in n!.attrs : p.toUpperCase() === n!.tagName))) return n;
      }
      return null;
    },
  };
  return self;
}

// ---- screen ----
eq('screen from hash', screenOf('#screen=person&id=s42&from=people'), 'person');
eq('bare hash is home', screenOf(''), 'home');
eq('junk screen', screenOf('#screen=' + encodeURIComponent('<b>x')), 'other');

// ---- interaction rows ----
// A tap: pointerdown, pointerup and click, one interaction; the click handler did the work.
const tap = [
  { name: 'pointerdown', startTime: 1000, duration: 248, processingStart: 1030, processingEnd: 1032, interactionId: 7 },
  { name: 'pointerup', startTime: 1040, duration: 208, processingStart: 1041, processingEnd: 1042, interactionId: 7 },
  { name: 'click', startTime: 1040, duration: 208, processingStart: 1042, processingEnd: 1200, interactionId: 7 },
];
eq('inp split across the entries', interactionRow(tap, 'tasks', 'button.cz-btn record-archive'), {
  kind: 'inp', screen: 'tasks', value_ms: 248, input_delay_ms: 30, processing_ms: 170, presentation_ms: 48,
  target: 'click button.cz-btn record-archive', iid: 7,
});
const key = { name: 'keydown', startTime: 500, duration: 64, processingStart: 510, processingEnd: 540, interactionId: 9 };
eq('one key', interactionRow([key], 'people', null), {
  kind: 'inp', screen: 'people', value_ms: 64, input_delay_ms: 10, processing_ms: 30, presentation_ms: 24, target: 'keydown', iid: 9,
});
eq('odd event name left out', interactionRow([{ ...key, name: 'Key Down 5' }], 'x', 'input.search').target, 'input.search');
eq('negative and NaN clamp to 0', [interactionRow([{ ...key, processingEnd: 2000 }], 'x', null).presentation_ms, one('lcp', 'x', NaN, null).value_ms], [0, 0]);
eq('huge clamps to an hour', one('first_screen', 'x', 9e9, null).value_ms, 3_600_000);

// ---- worst N ----
const row = (v: number, iid = 0, kind: VitalRow['kind'] = 'inp'): VitalRow => ({ ...one(kind, 'tasks', v, null), iid });
let kept: VitalRow[] = [];
for (let i = 1; i <= 20; i++) kept = keepWorst(kept, row(i * 10, i), 15);
eq('keeps the 15 worst, worst first', kept.map((r) => r.value_ms), [200, 190, 180, 170, 160, 150, 140, 130, 120, 110, 100, 90, 80, 70, 60]);
kept = keepWorst(kept, row(55, 99), 15);
eq('a smaller one does not get in', kept.length === 15 && !kept.some((r) => r.iid === 99), true);
kept = keepWorst(kept, row(500, 3), 15);
eq('same interaction, longer entry, counted once', [kept[0]!.value_ms, kept.filter((r) => r.iid === 3).length], [500, 1]);
kept = keepWorst(kept, row(40, 3), 15);
eq('same interaction, shorter entry, ignored', kept.filter((r) => r.iid === 3).map((r) => r.value_ms), [500]);

// ---- views ----
const T = '#screen=tasks';
const P = '#screen=person&id=s42';
const v = newViews();
for (let i = 1; i <= 30; i++) hold(v, T, 1000, row(40 + i, i));
for (let i = 1; i <= 9; i++) hold(v, T, 1000, row(200 + i, 0, 'long_frame'));
eq('open view holds 15 + 5, sends nothing yet', [v.inp.length, v.frames.length, drain(v, T, 2000, false).length], [15, 5, 0]);
hold(v, P, 3000, row(90, 31));
eq('new address closes the view: its 20 rows go', drain(v, P, 3000, false).length, 20);
eq('the new view is open', [v.inp.length, v.key], [1, P]);
eq('hiding sends the open view', drain(v, P, 4000, true).map((r) => r.value_ms), [90]);
hold(v, P, 5000, row(70, 32));
eq('a view open 10 minutes is sent', [drain(v, P, 5000 + 599_999, false).length, drain(v, P, 5000 + 600_000, false).length], [0, 1]);
hold(v, P, 700_000, row(60, 33));
eq('a view the address left is sent at the next flush', [drain(v, P, 700_001, false).length, drain(v, T, 700_002, false).length, v.key], [0, 1, T]);
for (let i = 0; i < 70; i++) v.out.push(row(50));
eq('at most 60 rows per request, the rest wait', [drain(v, T, 0, false).length, drain(v, T, 0, false).length], [60, 10]);
closeView(v, '#screen=home');
eq('close of an empty view sends nothing', v.out.length, 0);

// ---- payload ----
const body = payload([interactionRow(tap, 'tasks', 'button.cz-btn')], { workspaceId: 11, release: 'LaZZR5ab', userAgent: 'Chrome 141 Windows 8c' });
eq('payload is the columns only', body, [{
  workspace_id: 11, kind: 'inp', screen: 'tasks', value_ms: 248, input_delay_ms: 30, processing_ms: 170, presentation_ms: 48,
  target: 'click button.cz-btn', release: 'LaZZR5ab', user_agent: 'Chrome 141 Windows 8c',
}]);
eq('no iid or user_id sent', Object.keys(body[0]!).some((k) => k === 'iid' || k === 'user_id'), false);

// ---- targets: never text, labels, ids, names, phones or emails ----
const row42 = el('tr', { 'data-testid': 'today-row-s42', id: 's42' }, null, 'John Smith 210-555-0199 john@smith.com');
const box = el('button', {
  class: 'lift-row dial-row h-7 md:flex', role: 'checkbox', 'aria-label': 'Mark done: Call John Smith back',
  title: 'John Smith', id: 'task-9183', 'data-id': '9183',
}, row42, 'Call John Smith back');
const icon = el('path', {}, el('svg', {}, box));
const desc = describeTarget(icon);
eq('target names the control', desc, 'button.lift-row[checkbox] today-row');
eq('no text, label, name, phone, email or id', /john|smith|210|555|@|s42|9183|call|mark/i.test(desc ?? ''), false);
eq('uuid parts with digits dropped', describeTarget(el('div', { 'data-testid': 'today-band-task-3f2a91c0-77b1-4e2d-9a0e-1c5d2e8f4b6a' })), 'div today-band-task');
eq('tailwind-only classes left out', describeTarget(el('div', { class: 'h-7 w-[380px] md:flex' })), 'div');
eq('odd role left out', describeTarget(el('div', { role: 'John Smith' })), 'div');
eq('not an element', [describeTarget(null), describeTarget({}), describeTarget('button')], [null, null, null]);
eq('long target clipped', (describeTarget(el('div', { class: 'a'.repeat(300) + 'b' })) ?? '').length, 120);

// ---- long frames ----
eq('frame names the longest script', frameRow({ duration: 412, scripts: [
  { duration: 30, invokerType: 'event-listener', sourceURL: 'https://x.app/_next/static/chunks/index-LaZZR5ab.js' },
  { duration: 300, invokerType: 'user-callback', sourceURL: 'https://x.app/_next/static/chunks/useClozr-Dk2l_b-1.js?v=2' },
] }, 'people'), { ...one('long_frame', 'people', 412, 'user-callback useClozr'), iid: 0 });
eq('long task has no script', frameRow({ duration: 250 }, 'home').target, null);
eq('chunk names', [chunkName('/_next/static/chunks/navigation-errors-CZsdmFId.js'), chunkName('https://cdn.jsdelivr.net/x'), chunkName(undefined)], ['navigation-errors', null, null]);

// ---- release and agent ----
eq('release from the entry chunk', [releaseOf('/_next/static/chunks/index-LaZZR5ab.js'), releaseOf('/x.js'), releaseOf(null)], ['LaZZR5ab', null, null]);
eq('agents', [
  shortAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 8),
  shortAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'),
  shortAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', 6),
  shortAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'),
  shortAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'),
  shortAgent('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0'),
  shortAgent('curl/8'),
], ['Chrome 141 Windows 8c', 'Edge 141 Windows', 'Safari 17 iPhone 6c', 'Safari 17 Mac', 'Chrome 141 Android', 'Firefox 133 Linux', 'other other']);
