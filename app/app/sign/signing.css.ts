// The signing page's stylesheet, as a string.
//
// It lives here rather than in a .css file because the document itself arrives
// as an HTML fragment from the contract engine (`toHtml`), so the page has to
// style markup it does not author — `.doc .sig`, `.doc hr.page` and the rest.
// Keeping the sheet beside the page makes that contract easy to see.
//
// The script faces are imported here so both the preview in the adopt sheet
// and the canvas that renders the adopted signature use the same files.

export const SIGNING_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@600&family=Dancing+Script:wght@600&family=Great+Vibes&family=Homemade+Apple&display=swap');

:root {
  --cz-ink: #17171c;
  --cz-ink-2: #45454f;
  --cz-mute: #6b6b74;
  --cz-line: #e5e5ea;
  --cz-bg: #f2f3f5;
  --cz-go: #0A8560;
  --cz-go-dark: #08694C;
  --cz-go-soft: #E7F8F1;
  --cz-flag: #ffd84d;
  --cz-flag-ink: #4a3b00;
  --cz-bad: #b91c1c;
  --cz-bad-soft: #fee2e2;
  --cz-shadow: 0 1px 2px rgba(16,16,20,.05), 0 8px 24px rgba(16,16,20,.06);
}

* { box-sizing: border-box; }

.cz-page {
  min-height: 100dvh;
  background: var(--cz-bg);
  color: var(--cz-ink);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  padding-bottom: 96px;
}

/* ---------------------------------------------------------------- chrome */
.cz-bar {
  position: sticky; top: 0; z-index: 40;
  background: rgba(255,255,255,.88);
  backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--cz-line);
}
.cz-bar-in {
  max-width: 940px; margin: 0 auto; padding: 10px 18px;
  display: flex; align-items: center; gap: 12px;
}
.cz-bar-title { flex: 1; min-width: 0; }
.cz-bar-name {
  margin: 0; font-size: 14px; font-weight: 650; letter-spacing: -0.01em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cz-bar-sub { margin: 0; font-size: 12px; color: var(--cz-mute); }

.cz-pill {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  padding: 4px 9px; border-radius: 999px; white-space: nowrap;
}
.cz-pill-wait { color: #8a6100; background: #fff4d1; }
.cz-pill-done { color: var(--cz-go-dark); background: var(--cz-go-soft); }
.cz-pill-dead { color: #5c5c66; background: #ececed; }
.cz-pill-bad  { color: var(--cz-bad); background: var(--cz-bad-soft); }

.cz-shell { max-width: 940px; margin: 0 auto; padding: 18px; }

/* ------------------------------------------------------------------ card */
.cz-card {
  background: #fff; border: 1px solid var(--cz-line); border-radius: 14px;
  padding: 18px 20px; box-shadow: var(--cz-shadow);
}
.cz-card + .cz-card { margin-top: 14px; }
.cz-h1 { margin: 0; font-size: 21px; line-height: 1.25; letter-spacing: -0.02em; font-weight: 680; }
.cz-lede { margin: 6px 0 0; font-size: 16px; line-height: 1.55; color: var(--cz-ink-2); max-width: 68ch; }
.cz-note {
  margin: 14px 0 0; padding: 12px 14px; border-radius: 10px;
  background: #fafafa; border: 1px solid var(--cz-line);
  font-size: 14px; color: #2c2c33; white-space: pre-wrap;
}
.cz-note-from { display: block; font-size: 11px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--cz-mute); margin-bottom: 4px; }

/* parties */
.cz-parties { margin: 16px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.cz-party { display: flex; align-items: center; gap: 10px; font-size: 13.5px; }
.cz-dot {
  width: 20px; height: 20px; border-radius: 999px; flex: 0 0 20px;
  display: grid; place-items: center; font-size: 11px; font-weight: 800;
  background: #ececed; color: #71717a;
}
.cz-dot.is-done { background: var(--cz-go); color: #fff; }
.cz-dot.is-me { background: #fff; color: var(--cz-go-dark); box-shadow: inset 0 0 0 2px var(--cz-go); }
.cz-party-who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cz-party-role { color: var(--cz-mute); font-size: 12.5px; }

/* ------------------------------------------------------------- document */
.cz-paper {
  margin-top: 14px; background: #fff; border: 1px solid var(--cz-line);
  border-radius: 14px; box-shadow: var(--cz-shadow); overflow: hidden;
}
.cz-paper-top {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 18px; border-bottom: 1px solid var(--cz-line);
  font-size: 12px; color: var(--cz-mute); background: #fcfcfd;
}
.doc {
  font: 15px/1.7 Georgia, 'Times New Roman', serif;
  color: #1a1a1f; background: #fff; padding: 44px 52px;
}
.doc h1 {
  font: 680 19px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  text-transform: uppercase; letter-spacing: .03em; text-align: center; margin: 26px 0 16px;
}
.doc h2 { font: 680 16px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 22px 0 8px; }
.doc h3 {
  font: 700 11.5px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  text-transform: uppercase; letter-spacing: .08em; color: #55555e; margin: 20px 0 6px;
}
.doc .small { font: 11.5px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--cz-mute); }
.doc p { margin: 0 0 11px; }
.doc ul { margin: 0 0 11px 22px; padding: 0; }
.doc li { margin: 3px 0; }
.doc hr.page {
  border: 0; height: 1px; background: var(--cz-line);
  margin: 34px -52px; position: relative;
}

/* signature blocks inside the document */
.doc .sig {
  border: 1px solid var(--cz-line); border-radius: 12px;
  padding: 14px 16px; margin: 18px 0; background: #fcfcfd;
  scroll-margin-top: 88px;
}
.doc .sig.mine { border-color: var(--cz-go); background: var(--cz-go-soft); }
.doc .sig.mine.is-armed { box-shadow: 0 0 0 4px rgba(10, 133, 96,.14); }
.doc .sig-label {
  font: 800 10.5px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  letter-spacing: .11em; text-transform: uppercase; color: var(--cz-mute);
}
.doc .sig.mine .sig-label { color: var(--cz-go-dark); }
.doc .sig-line {
  min-height: 62px; display: flex; align-items: flex-end;
  border-bottom: 1px solid #1a1a1f; margin: 8px 0 6px;
}
.doc .sig-line img { max-height: 56px; max-width: 250px; }
.doc .sig-line .typed {
  font: italic 24px/1 'Dancing Script', 'Brush Script MT', cursive; color: #1d2a6b;
}
.doc .sig-line .blank {
  color: #a3a3ab; font: 12px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding-bottom: 5px;
}
.doc .sig-meta { font: 12px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--cz-ink-2); }

/* the flag that turns a signature line into something you can press */
.cz-flag {
  appearance: none; border: 0; cursor: pointer;
  display: inline-flex; align-items: center; gap: 7px;
  height: 38px; padding: 0 16px 0 13px; margin-bottom: 5px;
  background: var(--cz-flag); color: var(--cz-flag-ink);
  font: 700 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  border-radius: 8px; box-shadow: 0 1px 3px rgba(16,16,20,.16);
}
.cz-flag:hover { filter: brightness(1.04); }
.cz-flag::before { content: '✍'; font-size: 15px; }
/* The pulse is on the ring, never on position: a target that moves is a
   target you have to chase, and it also makes the button untestable. */
.cz-flag.is-armed { animation: cz-glow 2s ease-in-out infinite; }
@keyframes cz-glow {
  0%, 100% { box-shadow: 0 1px 3px rgba(16,16,20,.16), 0 0 0 0 rgba(255,216,77,.9); }
  50% { box-shadow: 0 1px 3px rgba(16,16,20,.16), 0 0 0 7px rgba(255,216,77,0); }
}

/* ------------------------------------------------------------ action bar */
.cz-dock {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 50;
  background: rgba(255,255,255,.94);
  backdrop-filter: saturate(180%) blur(12px);
  border-top: 1px solid var(--cz-line);
  padding: 10px 18px calc(10px + env(safe-area-inset-bottom));
}
.cz-dock-in {
  max-width: 940px; margin: 0 auto;
  display: flex; align-items: center; gap: 12px;
}
.cz-dock-stat { flex: 1; min-width: 0; font-size: 13px; color: var(--cz-ink-2); }
.cz-dock-stat b { color: var(--cz-ink); font-weight: 650; }

.cz-btn {
  appearance: none; cursor: pointer; border-radius: 10px;
  height: 46px; padding: 0 22px; font-size: 15px; font-weight: 650;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  border: 1px solid transparent; white-space: nowrap;
  transition: transform .06s ease, filter .12s ease;
}
.cz-btn:active { transform: translateY(1px); }
.cz-btn:disabled { cursor: not-allowed; opacity: .55; }
.cz-btn-primary { background: var(--cz-go); color: #fff; border-color: var(--cz-go); }
.cz-btn-primary:hover:not(:disabled) { background: var(--cz-go-dark); }
.cz-btn-ghost { background: #fff; color: var(--cz-ink); border-color: var(--cz-line); }
.cz-btn-ghost:hover { background: #fafafa; }
.cz-btn-sm { height: 38px; padding: 0 14px; font-size: 13.5px; border-radius: 9px; }
.cz-linkbtn {
  appearance: none; background: none; border: 0; cursor: pointer; padding: 0;
  font-size: 13.5px; color: var(--cz-mute); text-decoration: underline; text-underline-offset: 3px;
}
.cz-linkbtn:hover { color: var(--cz-ink); }

/* ----------------------------------------------------------- adopt sheet */
.cz-sheet {
  width: 100%; max-width: 560px; background: #fff;
  border-radius: 18px 18px 0 0; padding: 10px 0 0;
  max-height: 92dvh; overflow-y: auto;
  box-shadow: 0 -8px 40px rgba(16,16,20,.28);
  animation: cz-rise .22s cubic-bezier(.2,.8,.3,1);
}
@keyframes cz-rise { from { transform: translateY(24px); opacity: .6; } to { transform: none; opacity: 1; } }
.cz-sheet-grab { width: 38px; height: 4px; border-radius: 99px; background: #d8d8de; margin: 0 auto 12px; }
.cz-sheet-foot {
  position: sticky; bottom: 0; margin-top: 18px;
  display: flex; gap: 10px; padding: 14px 22px calc(18px + env(safe-area-inset-bottom));
  background: linear-gradient(to bottom, rgba(255,255,255,0), #fff 22%);
}

.cz-label {
  display: block; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--cz-mute); font-weight: 700; margin-bottom: 6px;
}
.cz-input {
  width: 100%; height: 46px; padding: 0 14px; font-size: 16px; color: var(--cz-ink);
  border: 1px solid #d6d6dc; border-radius: 10px; background: #fff; outline: 0;
}
.cz-input:focus { border-color: var(--cz-go); box-shadow: 0 0 0 3px rgba(10, 133, 96,.14); }

.cz-seg { display: flex; gap: 6px; background: #f1f1f4; padding: 4px; border-radius: 11px; margin: 16px 0 0; }
.cz-seg-btn {
  flex: 1; appearance: none; border: 0; cursor: pointer; height: 34px; border-radius: 8px;
  font-size: 13.5px; font-weight: 650; color: var(--cz-mute); background: transparent;
}
.cz-seg-btn.is-on { background: #fff; color: var(--cz-ink); box-shadow: 0 1px 2px rgba(16,16,20,.12); }

.cz-hands { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
.cz-hand {
  position: relative; appearance: none; cursor: pointer; text-align: center;
  border: 1px solid #d6d6dc; border-radius: 12px; background: #fff;
  padding: 14px 10px; min-height: 78px; display: grid; place-items: center; overflow: hidden;
}
.cz-hand.is-on { border-color: var(--cz-go); box-shadow: 0 0 0 3px rgba(10, 133, 96,.13); background: #fbfffd; }
.cz-hand-ink {
  color: #1d2a6b; line-height: 1.35; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.cz-hand-tick {
  position: absolute; top: 6px; right: 8px; font-size: 11px; font-weight: 900; color: var(--cz-go);
}

.cz-err {
  margin: 12px 0 0; padding: 10px 12px; border-radius: 10px;
  background: var(--cz-bad-soft); border: 1px solid #fecaca; color: var(--cz-bad); font-size: 13.5px;
}

/* --------------------------------------------------------------- outcome */
.cz-done { text-align: center; padding: 34px 22px; }
.cz-check {
  width: 62px; height: 62px; border-radius: 999px; margin: 0 auto 16px;
  background: var(--cz-go-soft); color: var(--cz-go); display: grid; place-items: center;
  font-size: 30px; animation: cz-pop .34s cubic-bezier(.2,1.2,.4,1);
}
@keyframes cz-pop { from { transform: scale(.7); opacity: 0; } to { transform: none; opacity: 1; } }

.cz-foot { margin: 22px 0 0; text-align: center; font-size: 12px; color: #8b8b93; line-height: 1.6; }

/* ------------------------------------------------------------------ small */
/* A bottom sheet is right on a phone and wrong on a desktop, where a
   centred dialog is what the rest of the web has taught people to expect. */
@media (min-width: 721px) {
  .cz-sheet { border-radius: 16px; margin: auto 0; max-height: 86dvh; }
  .cz-sheet-grab { display: none; }
  .cz-sheet-foot { border-radius: 0 0 16px 16px; }
}

@media (max-width: 720px) {
  .cz-shell { padding: 14px 12px; }
  .doc { padding: 26px 20px; font-size: 15.5px; }
  .doc hr.page { margin: 28px -20px; }
  .cz-h1 { font-size: 19px; }
  .cz-hands { grid-template-columns: 1fr; }
  .cz-bar-sub { display: none; }
  .cz-dock-stat { display: none; }
  .cz-dock .cz-btn-primary { flex: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .cz-flag.is-armed, .cz-check, .cz-sheet { animation: none; }
  .doc .sig { scroll-behavior: auto; }
  .cz-btn { transition: none; }
}
`;
