// The rule alone, with no Supabase import, so the app's tests can load it.
export type OptOutFacts = { vip?: boolean | null; vetted?: boolean | null; repliedBefore: boolean; textedBefore: boolean };

/** "Reply STOP to opt out." only on a stranger's first text: not VIP, not vetted, never replied, never texted. */
export function needsOptOutLine(f: OptOutFacts): boolean {
  return !f.vip && !f.vetted && !f.repliedBefore && !f.textedBefore;
}
