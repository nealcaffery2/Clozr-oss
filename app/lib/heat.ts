// The temperature scale every 0-100 likelihood score uses: lead score, buyer
// score, Genius likelihood. Hot is red, cold is blue, so a score reads at a
// glance without turning the screen green. Response rate has its own green to
// red scale (responseTone, below). Quality grades (call coaching,
// deliverability) keep good/bad colours; they are not heat.
//
// `stroke` is for rings, bars and dots (3:1 or better on white); `text` is
// for the number and the word (4.5:1 or better); `tint` is a badge fill
// that `text` reads on. The word always rides with the colour.

export type HeatLabel = 'Hot' | 'Warm' | 'Mild' | 'Cool' | 'Cold';
export type Heat = { label: HeatLabel; stroke: string; text: string; tint: string };

const SCALE: [number, Heat][] = [
  [85, { label: 'Hot', stroke: '#dc2626', text: '#b91c1c', tint: '#fee2e2' }],
  [70, { label: 'Warm', stroke: '#ea580c', text: '#c2410c', tint: '#ffedd5' }],
  [50, { label: 'Mild', stroke: '#d97706', text: '#b45309', tint: '#fef3c7' }],
  [30, { label: 'Cool', stroke: '#0284c7', text: '#0369a1', tint: '#e0f2fe' }],
  [-Infinity, { label: 'Cold', stroke: '#2563eb', text: '#1d4ed8', tint: '#dbeafe' }],
];

/** No score yet: grey, never a temperature. */
export const NO_HEAT = { stroke: '#d4d4d8', text: '#71717a', tint: '#f4f4f5' } as const;

export function heat(n: number): Heat {
  for (const [min, h] of SCALE) if (n >= min) return h;
  return SCALE[SCALE.length - 1][1];
}

/** The text colour for a score, grey when there is none. */
export const heatText = (n: number | null | undefined) => (n == null ? NO_HEAT.text : heat(n).text);

/** HOT / WARM / COLD words (Talkr's lead temperature) in the same colours. */
export const tempText = (t: string) => (t === 'HOT' ? heat(85).text : t === 'WARM' ? heat(70).text : t === 'COLD' ? heat(0).text : NO_HEAT.text);

/**
 * Response rate, green to yellow to red. The red band is where the tire
 * kicker rule starts (25% or less after enough sends, lib/tire-kicker.ts), and
 * a tire kicker reads red whatever the number, since offers that never close
 * count too. Separate from heat: a reply rate is good or bad, not hot or cold.
 */
export type ResponseTone = { label: string; stroke: string; text: string; tint: string };
export function responseTone(pct: number | null | undefined, tireKicker = false): ResponseTone {
  if (tireKicker) return { label: 'Tire kicker', stroke: '#dc2626', text: '#b91c1c', tint: '#fee2e2' };
  if (pct == null) return { label: 'Nothing sent', ...NO_HEAT };
  if (pct >= 60) return { label: 'Responsive', stroke: '#16a34a', text: '#15803d', tint: '#dcfce7' };
  if (pct >= 40) return { label: 'Fair', stroke: '#ca8a04', text: '#a16207', tint: '#fef9c3' };
  if (pct > 25) return { label: 'Slow', stroke: '#ea580c', text: '#c2410c', tint: '#ffedd5' };
  return { label: 'Low', stroke: '#dc2626', text: '#b91c1c', tint: '#fee2e2' };
}
