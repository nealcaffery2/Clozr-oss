'use client';
/**
 * Which number a rep dials out from. One control, used on the dialer and in
 * Settings: "Local presence" (an org number whose area code matches the
 * seller's, when one exists) or a specific dedicated line. The choice is the
 * rep's own profile setting, so it follows them across devices. A dedicated
 * pick is also written to CLOZR's caller ID (lib/caller-id-link), so the
 * last line dialed from is the default on both sides; the star marks it.
 */
import { liveCallerBlock, type LinePools } from '@/lib/caller-spin';
import { pushCallerIdPick } from '@/lib/caller-id-link';
import { loadLinePools } from '@/lib/line-pools';
import { lineText, useLineNames } from '@/lib/line-names';
import { useSession } from '@/lib/session';
import { useEffect, useState } from 'react';
import { api, type MeDto } from '@/lib/talkr-web/api';
import { formatPhone } from '@/lib/talkr-web/time';
import { Icon } from './Icon';

const LOCAL = 'local_presence';

/**
 * The rep's default line: a filled star in CLOZR's accent, with its word for
 * screen readers. --c-accent, not --accent: the dialer re-keys --accent to
 * Talkr red, which beside a number reads as an error.
 */
export function DefaultStar({ size = 12 }: { size?: number }) {
  return (
    <span role="img" aria-label="Default number" title="Your default number" className="inline-flex flex-none" style={{ color: 'var(--c-accent, #0A8560)', verticalAlign: '-0.1em' }}>
      <Icon name="star" size={size} />
    </span>
  );
}

/** Whether the caller ID shown for this rep is their default line (dedicated mode). */
export function showsDefault(me: MeDto | null): boolean {
  return !!me && me.caller_id_mode !== LOCAL && !!me.default_phone_number_id && me.org_numbers.some((n) => n.id === me.default_phone_number_id);
}

export function callerIdLabel(me: MeDto | null): string {
  if (!me) return '';
  if (me.caller_id_mode === LOCAL) {
    const fallback = me.org_numbers.find((n) => n.id === me.default_phone_number_id) ?? me.org_numbers[0];
    return fallback ? `Local presence · falls back to ${formatPhone(fallback.phone_e164)}` : 'Local presence';
  }
  const n = me.org_numbers.find((x) => x.id === me.default_phone_number_id) ?? me.numbers[0] ?? me.org_numbers[0];
  return n ? `Calling from ${formatPhone(n.phone_e164)}` : 'No number assigned to you yet';
}

export function CallerIdPicker({
  me,
  onChange,
  compact = false,
}: {
  me: MeDto;
  onChange: (next: MeDto) => void;
  compact?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useSession();
  const workspaceId = session.workspace?.id ?? null;
  const userId = session.user?.id ?? null;
  const [pools, setPools] = useState<LinePools>({});
  useEffect(() => {
    let live = true;
    void loadLinePools(workspaceId).then((next) => { if (live) setPools(next); });
    return () => { live = false; };
  }, [workspaceId]);

  const value = me.caller_id_mode === LOCAL ? LOCAL : (me.default_phone_number_id ?? me.numbers[0]?.id ?? me.org_numbers[0]?.id ?? '');
  const blockOf = (n: MeDto['org_numbers'][number]) => liveCallerBlock(n, pools);
  const eligible = me.org_numbers.filter((n) => !blockOf(n));
  const current = me.org_numbers.find((n) => n.id === value);
  const currentBlock = current ? blockOf(current) : null;

  async function select(next: string) {
    const chosen = me.org_numbers.find((n) => n.id === next);
    if (chosen && blockOf(chosen)) return;
    setError(null);
    setSaving(true);
    try {
      const patch: Parameters<typeof api.updateMe>[0] =
        next === LOCAL
          ? { caller_id_mode: 'local_presence' }
          : { caller_id_mode: 'dedicated', default_phone_number_id: next };
      const saved = await api.updateMe(patch);
      onChange({
        ...me,
        caller_id_mode: saved.caller_id_mode ?? me.caller_id_mode,
        default_phone_number_id: saved.default_phone_number_id ?? me.default_phone_number_id,
      });
      if (chosen) void pushCallerIdPick({ workspaceId, userId, talkrOrgId: me.org?.id, phone: chosen.phone_e164 });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Whose each line is, by name (lib/line-names): re-renders when the names load.
  useLineNames();
  const option = (n: MeDto['org_numbers'][number]) => lineText(n, me.id) + (n.id === me.default_phone_number_id ? ' · default' : '');
  const starred = value !== LOCAL && value === me.default_phone_number_id;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative flex items-center">
        {starred && (
          <span className="pointer-events-none absolute" style={{ left: compact ? 9 : 11, zIndex: 1, display: 'inline-flex' }}>
            <DefaultStar size={compact ? 11 : 12} />
          </span>
        )}
        <select
          value={value}
          disabled={saving || me.org_numbers.length === 0}
          onChange={(e) => void select(e.target.value)}
          aria-label="Caller ID"
          className="outline-none"
          style={{
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-btn)',
            padding: compact ? '7px 9px' : '9px 11px',
            paddingLeft: starred ? (compact ? 25 : 29) : undefined,
            font: compact ? '500 11.5px/1 var(--sans)' : '500 12.5px/1 var(--sans)',
            background: 'var(--panel)',
            width: '100%',
          }}
        >
          {me.org_numbers.length === 0 && <option value="">No active numbers</option>}
          {(eligible.length > 1 || me.caller_id_mode === LOCAL) && <option value={LOCAL}>Local presence · match the seller&apos;s area code</option>}
          {me.org_numbers.map((n) => {
            const blocked = blockOf(n);
            return (
              <option key={n.id} value={n.id} disabled={!!blocked}>
                {option(n)}{blocked ? ` · ${blocked}` : ''}
              </option>
            );
          })}
        </select>
      </div>
      {currentBlock && (
        <span style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--red)' }}>
          This line is off live calls: {currentBlock}. Pick a different caller ID.
        </span>
      )}
      {!compact && (
        <span style={{ font: '400 10.5px/1.4 var(--sans)', color: 'var(--muted-2)' }}>
          {me.org_numbers.length > 1
            ? 'Local presence dials from the org number closest to the seller and falls back to your dedicated line. Applies to calls and texts.'
            : 'Add more numbers to the org to turn on local presence (area-code matching).'}
        </span>
      )}
      {error && <span style={{ font: '400 11px/1.4 var(--sans)', color: 'var(--red)' }}>{error}</span>}
    </div>
  );
}
