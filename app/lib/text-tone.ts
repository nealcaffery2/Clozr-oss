// Status fills as text (DESIGN.md §2, audit RC10). The screens colour dots,
// bars and badges with fill shades (`#16a34a`, `#d97706`, `#ea580c`…) and
// then reuse the same value for the word beside them, where it falls under
// 4.5:1 on white. `textTone` maps a fill to its readable `--tx-*` shade:
// same hue, darker, and lighter again in dark mode through the token.
// Anything it does not know (ink, muted, a token) passes through unchanged.

const TONES: Record<string, string> = {
  // greens
  '#16a34a': 'var(--tx-green, #15803d)',
  '#22c55e': 'var(--tx-green, #15803d)',
  '#5aa63c': 'var(--tx-green, #15803d)',
  'var(--positive)': 'var(--tx-green, #15803d)',
  // ambers and yellows
  '#d97706': 'var(--tx-amber, #b45309)',
  '#f59e0b': 'var(--tx-amber, #b45309)',
  '#ca8a04': 'var(--tx-amber, #b45309)',
  '#c79111': 'var(--tx-amber, #b45309)',
  'var(--caution)': 'var(--tx-amber, #b45309)',
  // oranges (Deal Machine, the warm heat band, the old --orange)
  '#ea580c': 'var(--tx-orange, #c2410c)',
  '#f97316': 'var(--tx-orange, #c2410c)',
  '#ff7a45': 'var(--tx-orange, #c2410c)',
  '#ff5a2a': 'var(--tx-orange, #c2410c)',
  '#db6b33': 'var(--tx-orange, #c2410c)',
  'var(--orange)': 'var(--tx-orange, #c2410c)',
  // reds (Talkr red is a mark colour, never text)
  '#dc2626': 'var(--tx-red, #b91c1c)',
  '#ef4444': 'var(--tx-red, #b91c1c)',
  '#ff3b30': 'var(--tx-red, #b91c1c)',
  '#ff233b': 'var(--tx-red, #b91c1c)',
  '#e6142e': 'var(--tx-red, #b91c1c)',
  'var(--negative)': 'var(--tx-red, #b91c1c)',
  'var(--c-talkr)': 'var(--tx-red, #b91c1c)',
  // blues and cyans
  '#2563eb': 'var(--tx-blue, #1d4ed8)',
  '#3b82f6': 'var(--tx-blue, #1d4ed8)',
  '#2d5bff': 'var(--tx-blue, #1d4ed8)',
  '#0284c7': 'var(--tx-sky, #0369a1)',
  '#0ea5e9': 'var(--tx-sky, #0369a1)',
  '#0891b2': 'var(--tx-sky, #0369a1)',
  '#06b6d4': 'var(--tx-sky, #0369a1)',
  '#0d9488': 'var(--tx-teal, #0f766e)',
  '#14b8a6': 'var(--tx-teal, #0f766e)',
  // greys: faint is for placeholders, never for information
  '#a1a1aa': 'var(--meta, #71717a)',
  '#9ca3af': 'var(--meta, #71717a)',
  'var(--subtle)': 'var(--meta, #71717a)',
  'var(--subtle, #a1a1aa)': 'var(--meta, #71717a)',
};

/** The readable text shade for a status fill colour; unknown values pass through. */
export function textTone(color: string | null | undefined): string | undefined {
  if (!color) return color ?? undefined;
  const key = color.trim().toLowerCase().replace(/\s+/g, ' ');
  return TONES[key] ?? color;
}
