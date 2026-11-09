// Settings' groups and sections, each with an address:
// /app/settings/<group>/<section> (lib/routes.ts reads its slugs from here).
//
// The side list on a desk and the picker on a phone are drawn from this; the
// hint is the one line under each section's title. `pane` and `tab` name what
// draws the section (screens/Settings.tsx). Pure, so tools/routes.test.ts can
// check every section against the codec.
//
// Before sections had addresses, other screens handed Settings a
// `{ main, tab }` target (screens/settingsTab.ts) and the last one was kept
// in sessionStorage. legacySettingsSection reads those old targets, so a tab
// that remembered one still opens it.

/** The dialer's own panes (screens/TalkrSettings.tsx). */
export type DialerSettingsTab = 'account' | 'numbers' | 'health' | 'audio' | 'scripts' | 'calling';
/** The email panes (screens/OutboundOsSettings.tsx). */
export type EmailSettingsTab = 'email' | 'google' | 'keys';
/** What draws a section. */
export type SettingsPane = 'workspace' | 'dialer' | 'email' | 'templates' | 'account' | 'floor';

export type SettingsSection = { slug: string; label: string; hint: string; pane: SettingsPane; tab: string };
export type SettingsGroup = { slug: string; label: string; sections: SettingsSection[] };

const s = (slug: string, label: string, pane: SettingsPane, tab: string, hint: string): SettingsSection => ({ slug, label, hint, pane, tab });

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { slug: 'you', label: 'You', sections: [
    s('account', 'Account', 'account', 'account', 'Your profile, password, two-factor sign-in and the blacklist.'),
    s('audio', 'Audio & sounds', 'dialer', 'audio', 'Microphone, speaker, processing, ringtone, your voicemail greeting and notification sounds.'),
    s('notifications', 'Notifications', 'floor', 'floor', 'Turn off leaderboard or badge notifications for yourself. Admins also preview the sounds and set the spin-the-wheel prize.'),
  ] },
  { slug: 'workspace', label: 'Workspace', sections: [
    s('general', 'General', 'workspace', 'general', 'The workspace name, how tables display in this browser, and what this deployment is wired to.'),
    s('company', 'Company & 10DLC', 'workspace', 'company', 'Legal name, EIN, address and the texting campaign — typed once, filed by CLOZR: the 10DLC brand and campaign, the Telnyx enterprise, and Free Caller Registry.'),
    s('team', 'Team', 'workspace', 'team', 'Who is in the workspace and what each role can see. The database enforces the role, not just the menu.'),
    s('round-robin', 'Round robin', 'workspace', 'roundrobin', 'Who new leads and new deals are dealt to: an acquisitions rotation per lead source (yourcompany.com, Jotform), a dispositions rotation for novations. Take anyone out of a rotation and put them back.'),
    s('integrations', 'Integrations', 'workspace', 'integrations', 'Contracts through PandaDoc, the Podio import, Zapier webhooks, and the ingest keys other systems post with.'),
    s('ai-agent', 'AI Agent', 'workspace', 'agent', 'The phone agent that answers sellers and buyers with what the record already knows: connect it to ElevenLabs, choose its voice, and test it before it takes a call.'),
    s('server-keys', 'Server keys', 'workspace', 'keys', 'Project secrets the edge functions read, named here so nothing has to be guessed — the values are never entered or shown.'),
    s('archive', 'Archive', 'workspace', 'archive', 'Every archived seller and buyer. Search them and put anyone back on every list.'),
    s('history', 'Skip trace & import history', 'workspace', 'history', 'Every skip trace and import: who ran it, how many records, what came back, and the skip-trace credits it used.'),
  ] },
  { slug: 'dialer', label: 'Dialer', sections: [
    s('connection', 'Connection', 'dialer', 'account', 'Your connection to the phone, caller ID, working zone, and the Talkr API origin for a self-hosted Talkr.'),
    s('numbers', 'Numbers', 'dialer', 'numbers', 'Each person’s numbers and caller ID, call and SMS flows, company lines.'),
    s('caller-id-health', 'Caller ID health', 'dialer', 'health', 'How the dialer spreads calls over your lines: calls per line today and this week, the daily cap, spam flags and which lines are resting.'),
    s('scripts', 'Scripts', 'dialer', 'scripts', 'Call scripts and rebuttals. Managers edit; reps read them during a call.'),
    s('calling', 'Calling', 'dialer', 'calling', 'Call recording, hold music, AI calling, and the dialing windows in each lead’s local time.'),
  ] },
  { slug: 'email', label: 'Email', sections: [
    s('deliverability', 'Email deliverability', 'email', 'email', 'Resend on a sending subdomain for dispo blasts: domain authentication, the daily ramp, suppressions, and the checklist that refuses a blast that would burn reputation.'),
    s('google', 'Google', 'email', 'google', 'Gmail for one-to-one email and campaign replies, Calendar sync, and the Google Drive deals folder. CLOZR never adds open-tracking pixels to one-to-one email.'),
    s('email-keys', 'Email keys', 'email', 'keys', 'The Resend and Google secrets on the project, and the Resend webhook that lands bounces and complaints on the suppression list.'),
  ] },
  { slug: 'sequences', label: 'Sequences', sections: [
    s('templates', 'Templates', 'templates', 'templates', 'SMS and email templates for People, Inbox and bulk sends. Build once, insert anywhere, share with the team. Import from Talkr copies the dialer’s own SMS templates in.'),
  ] },
];

/** Where Settings opens with nothing remembered. */
export const DEFAULT_SETTINGS_SECTION = 'workspace/general';

/** Every `<group>/<section>`, in list order. */
export const SETTINGS_PATHS: readonly string[] = SETTINGS_GROUPS.flatMap((g) => g.sections.map((x) => `${g.slug}/${x.slug}`));

/** A group and its section for `<group>/<section>`, or `<group>` alone (its first section); null for anything else. */
export function settingsSectionOf(path: string | null | undefined): { group: SettingsGroup; section: SettingsSection; path: string } | null {
  if (!path) return null;
  const [g, sec, ...rest] = path.split('/');
  if (rest.length) return null;
  const group = SETTINGS_GROUPS.find((x) => x.slug === g);
  if (!group) return null;
  const section = sec === undefined ? group.sections[0] : group.sections.find((x) => x.slug === sec);
  return section ? { group, section, path: `${group.slug}/${section.slug}` } : null;
}

/** A section's full `<group>/<section>`, from `<group>` or `<group>/<section>`; the default for anything unknown. */
export const normalSettingsSection = (path: string | null | undefined): string => settingsSectionOf(path)?.path ?? DEFAULT_SETTINGS_SECTION;

/** The old hand-off and sessionStorage targets: `{ main: 'talkr', tab: 'numbers' }` and the rest. */
export type LegacySettingsTarget = { main: string; tab?: string | null };

const LEGACY: Record<string, Record<string, string>> = {
  workspace: {
    '': 'workspace/general', general: 'workspace/general', company: 'workspace/company', team: 'workspace/team',
    roundrobin: 'workspace/round-robin', integrations: 'workspace/integrations', agent: 'workspace/ai-agent',
    keys: 'workspace/server-keys', archive: 'workspace/archive', history: 'workspace/history', floor: 'you/notifications',
  },
  outbound: { '': 'email/deliverability', email: 'email/deliverability', google: 'email/google', keys: 'email/email-keys' },
  talkr: {
    '': 'dialer/connection', account: 'dialer/connection', numbers: 'dialer/numbers', health: 'dialer/caller-id-health',
    audio: 'you/audio', scripts: 'dialer/scripts', templates: 'sequences/templates', calling: 'dialer/calling',
  },
  // Sequences › Action plans was the Action plans screen a second time; it is that screen now.
  sequences: { '': 'sequences/templates', templates: 'sequences/templates' },
};

/** Where an old target lands now; null when it named nothing (or Sequences › Action plans, which is the Action plans screen). */
export function legacySettingsSection(t: LegacySettingsTarget | null | undefined): string | null {
  if (!t || typeof t.main !== 'string' || !Object.prototype.hasOwnProperty.call(LEGACY, t.main)) return null;
  const m = LEGACY[t.main];
  const tab = typeof t.tab === 'string' ? t.tab : '';
  return Object.prototype.hasOwnProperty.call(m, tab) ? m[tab] : null;
}

// ---- opening a section from anywhere ------------------------------------------

/** The window event the shell listens for (app/clozr/useClozr.ts) to open a section. */
export const OPEN_SETTINGS_EVENT = 'clozr:settings';

/**
 * Open Settings on a section from anywhere ("Manage scripts" in a call,
 * "Connect Google" on Deliverability): the shell navigates to its address,
 * so it pushes a history entry like any other place.
 */
export function openSettings(section: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: normalSettingsSection(section) }));
}

// ---- the section a tab was last on --------------------------------------------

const LAST_KEY = 'clozr.settingsSection';
/** The key the old hand-off kept `{ main, tab }` under. */
const OLD_LAST_KEY = 'clozr.settingsTab';

/** The section Settings was last on in this browser tab, so a bare /app/settings opens it; null when none (or storage is blocked). */
export function lastSettingsSection(): string | null {
  try {
    const now = sessionStorage.getItem(LAST_KEY);
    if (now && settingsSectionOf(now)) return settingsSectionOf(now)!.path;
    const old = JSON.parse(sessionStorage.getItem(OLD_LAST_KEY) ?? 'null') as LegacySettingsTarget | null;
    return legacySettingsSection(old);
  } catch {
    return null;
  }
}

/** Remember the section on screen for the next bare /app/settings in this tab. */
export function rememberSettingsSection(path: string): void {
  try {
    sessionStorage.setItem(LAST_KEY, normalSettingsSection(path));
  } catch { /* private mode or storage blocked: Settings opens on General */ }
}
