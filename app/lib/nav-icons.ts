// The one icon map for the app's places: the side nav, the phone tabs, the
// More sheet. Lucide geometry on a 24px grid, drawn with currentColor by
// app/clozr/NavIcon.tsx. The product tools that have a mark of their own
// (COMPR, Buyr, Lane, Campaigns, Deal Machine) name it instead.
//
// Pure data, so tools/nav-model.test.ts can check every place has one.

export type IconPart =
  | ['path', string]
  | ['circle', number, number, number]
  | ['rect', number, number, number, number, number]
  | ['ellipse', number, number, number, number];

/** A drawn icon, or a product's own mark. */
export type NavIconDef = { parts: IconPart[] } | { brand: 'compr' } | { mark: string };

const p = (d: string): IconPart => ['path', d];

const PHONE = p('M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z');

export const NAV_ICONS = {
  home: { parts: [p('M3 10.5 12 3l9 7.5'), p('M5 9.5V21h14V9.5'), p('M10 21v-6h4v6')] },
  today: { parts: [['circle', 12, 12, 4], p('M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4')] },
  people: { parts: [['circle', 9, 8, 3.5], p('M2.5 20a6.5 6.5 0 0 1 13 0'), p('M16 4.5a3.5 3.5 0 0 1 0 7'), p('M18 14.5a6 6 0 0 1 3.5 5.5')] },
  inbox: { parts: [p('M22 12h-6l-2 3h-4l-2-3H2'), p('M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z')] },
  dialer: { parts: [PHONE] },
  tasks: { parts: [p('m9 11 3 3L22 4'), p('M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11')] },
  calendar: { parts: [['rect', 3, 4, 18, 18, 2], p('M16 2v4M8 2v4M3 10h18')] },
  // The pipeline's columns. Home keeps the house, so the two never share an icon.
  deals: { parts: [['rect', 3, 3, 18, 18, 2], p('M8 7v7'), p('M12 7v4'), p('M16 7v9')] },
  contracts: { parts: [p('M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z'), p('M14 3v6h6'), p('M8 17c1.5-2 2.5-2 3.5 0s2 2 4.5-1')] },
  dispo: { parts: [p('M22 2 11 13'), p('M22 2 15 22l-4-9-9-4 20-7z')] },
  buyers: { parts: [['rect', 3, 7, 18, 13, 2], p('M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'), p('M3 13h18')] },
  plans: { parts: [p('M8 6h13M8 12h13M8 18h13'), p('M3 6h.01M3 12h.01M3 18h.01')] },
  reporting: { parts: [p('M3 3v18h18'), p('M8 17v-5M13 17V8M18 17v-3')] },
  coaching: { parts: [['circle', 12, 12, 9], ['circle', 12, 12, 5], ['circle', 12, 12, 1]] },
  leaderboard: { parts: [p('M8 21h8'), p('M12 17v4'), p('M7 4h10v4a5 5 0 0 1-10 0z'), p('M7 6H4a2 2 0 0 0 0 4h3M17 6h3a2 2 0 0 1 0 4h-3')] },
  compr: { brand: 'compr' },
  lane: { mark: 'Lane' },
  campaigns: { mark: 'Campaigns' },
  dealMachine: { mark: 'Deal Machine' },
  liveLists: { parts: [['ellipse', 12, 5, 8, 3], p('M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5'), p('M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3')] },
  import: { parts: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), p('m17 8-5-5-5 5'), p('M12 3v12')] },
  automations: { parts: [p('M13 2 3 14h9l-1 8 10-12h-9z')] },
  settings: { parts: [['circle', 12, 12, 3], p('M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z')] },
  account: { parts: [['circle', 12, 8, 4], p('M4 21a8 8 0 0 1 16 0')] },
  askClozr: { parts: [['circle', 12, 12, 10], p('M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3'), p('M12 17h.01')] },
} satisfies Record<string, NavIconDef>;

export type NavIconKey = keyof typeof NAV_ICONS;
