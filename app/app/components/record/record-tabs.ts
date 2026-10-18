// The seller record's tab row: the activity feeds (Activity, Calls, Texts,
// Email, Notes), then Automations and History, then Details and Submission.
// The selected tab is the view's `personTab`, so another screen can hand one
// over ("Texts", "Notes") and a name from an older layout still lands on a
// tab that holds what it used to show.
//
// Pure: tools/record-tabs.test.ts runs it with tsx.

export type RecordTabKey =
  | 'Activity' | 'Calls' | 'Texts' | 'Emails' | 'Notes'
  | 'Automations' | 'History' | 'Details' | 'Submission';

export type RecordTab = {
  key: RecordTabKey;
  label: string;
  /** Draws the activity stream (and takes the User filter). */
  stream: boolean;
  /** Draws the composer under the stream. */
  composer: boolean;
  /** Which group of the row it sits in, for the thin rule between groups. */
  group: 'feed' | 'log' | 'record';
};

const TABS: readonly RecordTab[] = [
  { key: 'Activity', label: 'Activity', stream: true, composer: true, group: 'feed' },
  { key: 'Calls', label: 'Calls', stream: true, composer: true, group: 'feed' },
  { key: 'Texts', label: 'Texts', stream: true, composer: true, group: 'feed' },
  { key: 'Emails', label: 'Email', stream: true, composer: true, group: 'feed' },
  { key: 'Notes', label: 'Notes', stream: true, composer: true, group: 'feed' },
  { key: 'Automations', label: 'Automations', stream: true, composer: false, group: 'log' },
  { key: 'History', label: 'History', stream: true, composer: false, group: 'log' },
  { key: 'Details', label: 'Details', stream: false, composer: false, group: 'record' },
  { key: 'Submission', label: 'Submission', stream: false, composer: false, group: 'record' },
];

/** The row for this record: Submission only when the record came in as one. */
export function recordTabs(hasSubmission: boolean): RecordTab[] {
  return TABS.filter((t) => t.key !== 'Submission' || hasSubmission);
}

/** Names other screens and older layouts used, and the tab that holds that now. */
const ALIASES: Record<string, RecordTabKey> = {
  All: 'Activity',
  Communications: 'Activity',
  Email: 'Emails',
  // The old AI tab listed calls (with their AI summaries) and COMPR runs.
  AI: 'Calls',
  Automation: 'Automations',
  'Action plans': 'Automations',
  Plans: 'Automations',
  Sequences: 'Automations',
  'Stage history': 'History',
  Audit: 'History',
  Info: 'Details',
  Property: 'Details',
  'Property details': 'Details',
  'Deal info': 'Details',
  'What we know': 'Details',
  Submissions: 'Submission',
};

/** Old tab names that open a section of the Record details sheet instead of a tab. */
export const TAB_TO_SECTION: Readonly<Record<string, 'closing' | 'files'>> = { TC: 'closing', 'Files & Links': 'files' };

/**
 * The tab a `personTab` value lands on. Unknown names land on Activity;
 * Submission on a record that has none lands on Details, where the record's
 * own facts are.
 */
export function resolveRecordTab(name: string | null | undefined, hasSubmission: boolean): RecordTabKey {
  const n = (name ?? '').trim();
  const hit = TABS.find((t) => t.key === n)?.key ?? ALIASES[n] ?? 'Activity';
  return hit === 'Submission' && !hasSubmission ? 'Details' : hit;
}

export function tabOf(key: RecordTabKey): RecordTab {
  return TABS.find((t) => t.key === key) ?? TABS[0];
}

/**
 * Arrow keys in the tab row (WAI-ARIA tabs): left and right move one tab and
 * wrap, Home and End jump to the ends. Anything else is not the row's key.
 */
export function stepTab(keys: readonly RecordTabKey[], current: RecordTabKey, key: string): RecordTabKey | null {
  if (!keys.length) return null;
  const i = Math.max(0, keys.indexOf(current));
  if (key === 'ArrowRight') return keys[(i + 1) % keys.length];
  if (key === 'ArrowLeft') return keys[(i - 1 + keys.length) % keys.length];
  if (key === 'Home') return keys[0];
  if (key === 'End') return keys[keys.length - 1];
  return null;
}

/** Timeline row types that are a change to the record rather than a conversation. */
export const HISTORY_TYPES: ReadonlySet<string> = new Set(['stage', 'offer', 'lead', 'compr', 'contract']);

/** A timeline row an automation wrote: a plan's task step, or an AI agent's run or message. */
export function isAutomationRow(t: { type: string; agent?: unknown }): boolean {
  return t.type === 'task' || t.type === 'ai_agent' || !!t.agent;
}
