# CLOZR design standard

A dense operator tool for an acquisitions and dispositions team. It is read at a desk all day, fast, with
the numbers doing the talking. The target is crisp, quiet and exact: Linear or Vercel's dashboard,
not a landing page. Every rule below has a number attached so a review can check it rather than
argue taste.

Sources: Anthropic's frontend-design, Emil Kowalski's emil-design-eng and apple-design, mengto's
beautiful-shadows, Addy Osmani's accessibility, Superfuture's design-review, Jakub Krehel's
better-interface family, pbakaus' adapt, wshobson's interaction-design and shadcn, plus the open
Halaska UI kit and Refero's Vercel / Raycast / Brex specs. Genius Mode (`components/GeniusMode.tsx`,
`components/genius/*`) is the reference implementation; its shared pieces live in
`components/genius/parts.tsx`.

## 1. What reads as AI slop, and is banned

| Tell | Do instead |
| --- | --- |
| Tracked-out ALL-CAPS eyebrows over every group (`9.5px, letter-spacing .1em, uppercase`) | Sentence-case label, 11.5px / 500 / muted. Hierarchy comes from weight and size, not capitals |
| Unicode glyphs as icons (☎ ✉ ✓ ✕ ▾ ⌖ ✦) and emoji | One SVG icon family (Lucide geometry), `currentColor`, 2px stroke beside semibold text |
| "→" appended to button and link text ("View all →") | The label alone. Use a chevron icon only where the control actually opens or advances |
| Gradient washes as decoration (`linear-gradient(#faf7ff, #fff)` headers) | Flat surfaces. Colour is for state and the one primary action |
| Two accent colours for actions | One accent, CLOZR green. Amber and red are status colours only |
| One radius and one soft grey shadow on every box | Radius by role (§4), elevation by role (§5) |
| Fade-and-slide entrances on everything, hover animation on every card | Motion only where it explains something (§6) |
| Vague copy ("Submit", "Something went wrong") | The verb that happens ("Add to buyers"); errors say what failed and what to do |

Middle dots are allowed in data lines (`3bd/2ba · 1,200 sf · Jun 2026`) because they separate facts.
They are not allowed as decoration in headings.

## 2. Colour

| Token | Hex | Role |
| --- | --- | --- |
| ink | `#18181b` | Primary text, selected chips, the confirming row action |
| ink-2 | `#3f3f46` | Secondary text in rows, unselected chip text |
| muted | `#71717a` | Labels, meta, helper text. 4.8:1 on white; the lightest tone allowed for text that must be read |
| faint | `#a1a1aa` | Placeholders and disabled only. 2.6:1, so never for information |
| line | `#e4e4e7` | Card borders, dividers |
| hair | `#f0f0f1` | Row dividers inside a card |
| accent (CLOZR green) | `#0A8560` (hover `#08694C`) | The single primary action in a view, focus rings, links, selected state, Genius identity |
| accent tint | `#E7F5EF` (palest `#F0FAF5`, border `#A7DCC5`) | Selected/SmartMatch badges, selected rows |
| green | `#0A8560` | Also success, "in your buyers", good number (status marks carry a word or icon so they read apart from the accent) |
| amber | `#b45309` | Warning |
| heat | Hot `#dc2626` · Warm `#ea580c` · Mild `#d97706` · Cool `#0284c7` · Cold `#2563eb` (text shades `#b91c1c` `#c2410c` `#b45309` `#0369a1` `#1d4ed8`) | Every 0–100 likelihood score: lead score, buyer score, Genius likelihood. Bands 85 / 70 / 50 / 30, from `lib/heat.ts`, always with the word. Quality grades (call coaching, deliverability) stay green / amber / red |
| response | Responsive `#16a34a` (60%+) · Fair `#ca8a04` (40–59) · Slow `#ea580c` (26–39) · Low `#dc2626` (25% or less) | Response rate, green to yellow to red, from `responseTone` in `lib/heat.ts`. The red band is where the tire kicker rule starts, and a tire kicker (low response after 4 sends, or 2+ offers and no close) reads red with its chip whatever the number. Nothing sent reads as a grey dash, never 0% |
| red | `#b91c1c` | Error, destructive, DNC |
| flipper / landlord / builder | `#ea580c` / `#2563eb` / `#0d9488` | Buyer type, on the map and in type badges, always with a text label too |

- Body text ≥ 4.5:1 and icons or control edges ≥ 3:1 against the background they actually sit on.
- Colour never carries meaning alone: every coloured badge has words, every pin has a legend and a label.
- Fix contrast by changing lightness, not hue.
- SMS bubbles are the one sanctioned exception to the single-accent rule, by iMessage convention: ours `#0B6FE6` with white text, theirs `#E9E9EB` with ink `#18181b`, on a white `#ffffff` thread, and the SMS send arrow in the same blue. iOS's own `#007AFF` holds only 4.0:1 under white text, so ours is the deeper `#0B6FE6` (4.7:1); theirs is 14.6:1. Tokens: `--sms-out`, `--sms-in`, `--sms-thread` in `tokens.css`. Every SMS thread uses them (the dialer card, the inbox thread, the All list, template and campaign previews); email and everything else stay on the one accent.

## 3. Type

Inter on every platform (`app/layout.tsx` loads it; `globals.css` and `tokens.css --font-sans` put it first), antialiased on the root, the system sans only as a fallback. Dense-tool sizes:

| Role | Size / weight / line-height |
| --- | --- |
| Screen title | 15px / 700 / 1.2, tracking −0.015em |
| Card title, row name | 13.5px / 650 |
| Body, controls, buttons | 12.5–13px / 500 (buttons 600 when filled) |
| Label, meta | 11.5px / 500, muted |
| Badge | 11px / 600 |
| Smallest allowed | 10.5px, only for ring captions and map attribution |

- `font-variant-numeric: tabular-nums` on every figure that changes or aligns: prices, counts, scores, page numbers.
- Sentence case everywhere. Ranges use an en dash (`$90K – $237K`); the ellipsis is one character (`…`).
- Truncation always has a recovery: a `title`, a tooltip or an expanded state.
- Inputs are 16px on phones so iOS does not zoom.

## 4. Space and shape

- 4px grid. Within a group 4–8px; between groups at least twice that (12–16px); section padding 12–16px.
- Radius by role: badges 6, chips and buttons 8, inputs 8, map controls 10, cards 12–14, sheets 16 at the top only.
- Nested radius = outer radius − padding.
- The layout is dense on purpose. Do not add air to look "premium"; the team scans hundreds of rows.

## 5. Elevation (beautiful-shadows)

One recipe per surface, never mixed, never tinted except the accent button's own edge.

| Name | Use | Value |
| --- | --- | --- |
| ring | Neutral buttons, chips, inputs, small floating pills | `0 0 0 1px rgba(0,0,0,.08), 0 1px 2px -1px rgba(0,0,0,.08), 0 2px 4px 0 rgba(0,0,0,.04)` |
| md | Popovers, map cards, floating panels | `0 0 0 1px rgba(0,0,0,.06), 0 1px 1px -.5px rgba(0,0,0,.06), 0 3px 3px -1.5px rgba(0,0,0,.06), 0 6px 6px -3px rgba(0,0,0,.06), 0 12px 12px -6px rgba(0,0,0,.06)` |
| lg | Modals only | `0 2.8px 2.2px rgba(0,0,0,.034), 0 6.7px 5.3px rgba(0,0,0,.048), 0 12.5px 10px rgba(0,0,0,.06), 0 22.3px 17.9px rgba(0,0,0,.072), 0 41.8px 33.4px rgba(0,0,0,.086), 0 100px 80px rgba(0,0,0,.12)` |

Cards in the page body keep a real 1px `line` border. Dense lists never get `lg`.

## 6. Motion (emil-design-eng)

Ask first: how often is this seen? Hundreds of times a day means no animation. Tens means barely any.

| What | Duration | Easing |
| --- | --- | --- |
| Press feedback | 140ms | `cubic-bezier(.23, 1, .32, 1)`, `scale(.97)` |
| Hover | 120–140ms | `ease`; a brightness shift, gated by `@media (hover: hover) and (pointer: fine)` |
| Tooltips, small popovers | 125–180ms | strong ease-out, from `scale(.96)` + opacity, origin at the trigger |
| Map zoom | 220ms | `cubic-bezier(.23, 1, .32, 1)` toward the cursor |
| Modals, drawers | 200–300ms | ease-out; modals stay centred |

- Only `transform`, `opacity`, `filter` and `box-shadow` animate. Never `transition: all`, never width, height, top or left.
- Never from `scale(0)`; never `ease-in` on UI; nothing keyboard-triggered animates.
- `prefers-reduced-motion: reduce` removes movement and keeps meaning (state never depends on motion).

## 7. Components

**Buttons** (`btn()` in parts):
- `purple` (a historical kind name; it renders CLOZR green `#0A8560`) is the one primary action of a view: Find buyers, Investor comps.
- `solid` (ink) is a confirming row action: Add to buyers.
- `ghost` (white, ring shadow) is everything else.
- Heights 32 / 28. Every button has hover, press, focus-visible and disabled states (via `GX_CSS` under `[data-gx]`). Disabled buttons are 50% opacity with no hover.
- Loading keeps the label and says what is happening ("Searching…").

**Chips** (`Pill`): 28px, radius 8; selected is an ink fill, unselected a white ring chip. Use them for option sets of 2–7 items.

**Labels** (`Control`): sentence-case 11.5px muted label above the group, and `role="group"` with an `aria-label`.

**Badges** (`Badge`): 11px/600, radius 6, tinted background with matching dark text, and a text label always.

**Icons**:
- One family.
- Icon-only buttons have an `aria-label`, and their SVG is `aria-hidden`.
- Hit targets are at least 24×24; aim for 32 on desktop and 44 on touch.

**States**: design loading, empty and error before the happy path.
- Empty says what to do next, with one action.
- Errors name the cause and the fix, e.g. "RealEstateAPI rejected the key — check REAL_ESTATE_API_API_KEY". Never "no results" when the call failed.
- Progress uses real counts ("Pulling sales: 250 of 812").

**Destructive or costly actions**: show the cost before spending (Estimate size, credits per run). Prefer undo to confirm.

## 8. Accessibility floor

- Visible focus on everything: `outline: 2px solid accent; outline-offset: 2px`. Never bare `outline: none`.
- Native `<button>` and `<a href>`; every pointer action has a keyboard path. Esc closes overlays; arrow keys move within widgets.
- Result counts and toasts use `role="status"`. Urgent errors use `role="alert"`.
- Works at 200% zoom and at 320px wide with no horizontal scroll.
- Drag always has a click alternative (the map has zoom buttons and keyboard pan).

## 9. The map

- Quiet monochrome basemap (Mapbox light with `NEXT_PUBLIC_MAPBOX_TOKEN`, otherwise OSM through a grayscale filter) so the data carries the colour.
- Pins are 12px dots with a white ring and soft shadow, coloured by type; SmartMatch gets a gold ring.
- Clusters are donuts whose ring shows the type mix. They merge only pins that would actually overlap.
- Controls: a grouped zoom pill, recenter and full screen, top right. Legend bottom left. Attribution bottom right.
- Ctrl/⌘ + scroll zooms; a plain scroll shows a hint instead of hijacking the page.

## 10. Review checklist

Before a UI change ships:

1. Nothing from §1 is present.
2. Every number is tabular and every figure has a unit.
3. There is one primary action per view.
4. Contrast has been measured, not guessed.
5. Tab through the screen: every control is reachable, visibly focused and named.
6. Every animation passes the frequency test and animates only transform, opacity, filter or box-shadow.
7. Empty, loading and error states exist, and the error copy names the fix.
8. Check at 390px and 1440px: no horizontal scroll, and actions stay reachable.
