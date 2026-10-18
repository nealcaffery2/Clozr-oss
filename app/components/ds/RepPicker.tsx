// Pick a workspace member: owner, TC, dispo rep, underwriter. One control for
// every "assign to" on a record, so the list, its order and its role filter
// are the same everywhere (Home's team menu and the plan step's assignee
// used to build their own).
//
//   <RepPicker label="TC" team={V.team} roles={['tc']} value={deal.tcId} onChange={(id) => save(id)} />
'use client';

import React, { useId } from 'react';
import type { Rep } from '@/lib/clozr-types';
import { MUTED, SHADOW, INK } from '@/components/genius/parts';

/** The jobs a picker can ask for. Owners and admins can do every job, so they are always offered. */
export type RepRole = 'acq' | 'tc' | 'dispo' | 'underwriter';

const ROLE_MATCH: Record<RepRole, string[]> = {
  acq: ['acquisitions'],
  tc: ['tc'],
  dispo: ['dispositions'],
  underwriter: ['acquisitions', 'dispositions'],
};

/** Members who can take this job, owners and admins included, sorted by name. No roles: everyone. */
export function repsFor(team: Record<string, Rep>, roles?: RepRole[]): Rep[] {
  const want = roles?.length ? new Set(roles.flatMap((r) => ROLE_MATCH[r])) : null;
  return Object.values(team)
    .filter((r) => {
      if (!want) return true;
      const role = (r.memberRole ?? '').toLowerCase();
      return role === 'owner' || role === 'admin' || want.has(role) || (roles!.includes('tc') && r.dept === 'TC');
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function RepPicker({
  label, team, value, onChange, roles, allowNone = true, noneLabel = 'Unassigned', disabled, readOnlyReason, showLabel = true,
}: {
  label: string;
  team: Record<string, Rep>;
  /** The member's user id, or null for nobody. */
  value: string | null | undefined;
  onChange: (userId: string | null) => void;
  roles?: RepRole[];
  allowNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
  /** Read-only users see the name, with this as the tooltip. */
  readOnlyReason?: string | null;
  showLabel?: boolean;
}) {
  const id = useId();
  const reps = repsFor(team, roles);
  const current = value ? team[value] : undefined;
  // Someone already assigned keeps showing even when they no longer fit the filter.
  const list = current && !reps.some((r) => r.id === current.id) ? [current, ...reps] : reps;
  const labelEl = showLabel ? <label htmlFor={id} style={{ fontSize: '11.5px', fontWeight: 500, color: MUTED }}>{label}</label> : null;
  if (readOnlyReason) {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '4px' }} title={readOnlyReason}>
        {showLabel ? <span style={{ fontSize: '11.5px', fontWeight: 500, color: MUTED }}>{label}</span> : null}
        <span style={{ fontSize: '13px', color: INK }}>{current?.name ?? noneLabel}</span>
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
      {labelEl}
      <select id={id} aria-label={showLabel ? undefined : label} value={value ?? ''} disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        style={{ font: 'inherit', height: '32px', padding: '0 8px', borderRadius: '8px', border: 0, boxShadow: SHADOW.ring, fontSize: 'var(--ds-input-size, 13px)', color: INK, background: 'var(--surface, #fff)', minWidth: 0 }}>
        {allowNone || !value ? <option value="">{noneLabel}</option> : null}
        {list.map((r) => <option key={r.id} value={r.id}>{r.name}{r.role ? ` · ${r.role}` : ''}</option>)}
      </select>
    </span>
  );
}
