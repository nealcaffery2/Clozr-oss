// Product marks.
//
// CLOZR, COMPR and Talkr are separate products that share this shell, so each
// keeps its own colour. Only CLOZR's indigo (tokens.css --c-accent) is the app accent — a COMPR or Talkr
// element takes its own product's colour, not the accent, so the three stay
// tellable apart in the nav and anywhere they appear side by side.
//
// Values are lifted from each product's own stylesheet:
//   COMPR  the underwriting service's stylesheet  --accent (royal blue)
//   Talkr  the Talkr web app's globals.css        --accent (Talkr Red)
//
// These are deliberately not design-system tokens: --mint et al describe the
// app's palette, and these describe who owns a piece of UI.
//
// Scope: a product's colour applies to its mark in the nav and to its own
// screen. CLOZR's own surfaces — the activity timeline, automation steps, the
// dialer button in the shell — stay on the CLOZR palette even when they refer
// to a call or an underwrite, because there the app's state colours have to
// keep meaning what they mean.

/** COMPR — underwriting. Royal blue. */
export const COMPR = '#2d5bff';
/** COMPR's tint, for chips and avatars. */
export const COMPR_TINT = '#eef2ff';

/**
 * Talkr — native comms. Talkr Red.
 *
 * Reserved for marks and fills that carry no small text: white on #ff233b is
 * 3.8:1, under the 4.5:1 needed for body sizes.
 */
export const TALKR = '#ff233b';
/** Talkr's darker red (their --accent-hover), 4.7:1 on white. Use for text and
 *  for fills that carry a white label. */
export const TALKR_INK = '#e6142e';
/** Talkr's tint, for chips and avatars. */
export const TALKR_TINT = 'var(--c-talkr-soft, #ffe9ec)';

/**
 * Deal Machine — the Chrome extension that scrapes deals and cash buyers and
 * posts them through /ingest. Orange.
 *
 * The one mark here not lifted from its own product's stylesheet: the
 * extension's `--accent` is #2d5bff, which is COMPR's royal blue exactly, and
 * two products sharing a dot in the same nav row defeats the point of this
 * file. Orange keeps it tellable apart from COMPR's blue, Lane's pink,
 * Genius's violet and Talkr's red at a 6px dot.
 */
export const DEAL_MACHINE = '#ea580c';
/** Deal Machine's tint, for chips and empty states. */
export const DEAL_MACHINE_TINT = 'var(--tint-orange, #fff7ed)';

/**
 * Buyr — wholesale sniping, Homefull, and Facebook buyer comments.
 * Teal, so the Tools row can tell it apart from Genius violet and Deal Machine orange.
 */
export const BUYR = '#0f766e';
/** Buyr's tint, for the selected deal and the Homefull note. */
export const BUYR_TINT = '#f0fdfa';

/**
 * Lane — the TC assistant. Pink, so it no longer reads as CLOZR's own mint.
 * #db2777 is 4.9:1 on white, fine for a label or a fill carrying white text.
 * The same values are CSS tokens (--c-lane*) in tokens.css for the inline styles.
 */
export const LANE = '#db2777';
/** Lane's tint, for chips and the drawer's reference tags. */
export const LANE_TINT = 'var(--c-lane-soft, #fdf2f8)';
