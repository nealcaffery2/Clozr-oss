'use client';

// "New contacts" in the Email tab: agents, escrow officers and title reps on
// the team's mail who are not in CLOZR yet (lib/contact-suggestions.ts).
// Add makes them a contact (and puts them on the deal the mail was on, so
// their mail files there from now on); Dismiss means never suggest them
// again. People at a title company we already use are added by the sync
// itself and never show here.

import React, { useEffect, useState } from 'react';
import {
  type ContactSuggestion, type SuggestionKind, KIND_LABEL, loadSuggestions, resolveSuggestion,
} from '@/lib/contact-suggestions';
import type { Teammate } from '@/lib/team';
import type { DealRef } from '../data';
import { GmailIcon } from './GmailIcon';

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** How many open suggestions there are, for the rail. Re-read when `tick` moves. */
export function useSuggestionCount(workspaceId: number | null, mine: string | null, tick: number) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void loadSuggestions(workspaceId, mine).then((r) => { if (alive) setN(r.rows.length); });
    return () => { alive = false; };
  }, [workspaceId, mine, tick]);
  return n;
}

export function NewContacts({ workspaceId, mine, team, deals, toast, onChanged }: {
  workspaceId: number;
  /** Only suggestions from this teammate's mailbox; null shows the whole team's. */
  mine: string | null;
  team: Teammate[];
  deals: DealRef[];
  toast: (msg: string) => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ContactSuggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadSuggestions(workspaceId, mine).then((r) => {
      if (!alive) return;
      setRows(r.rows);
      setError(r.error);
    });
    return () => { alive = false; };
  }, [workspaceId, mine]);

  const done = (id: number) => { setRows((rs) => (rs ?? []).filter((r) => r.id !== id)); onChanged(); };
  return <NewContactsList rows={rows} error={error} team={team} deals={deals} toast={toast} onDone={done} />;
}

/** The list itself, from rows already loaded: null is still loading. */
export function NewContactsList({ rows, error, team, deals, toast, onDone }: {
  rows: ContactSuggestion[] | null; error: string | null; team: Teammate[]; deals: DealRef[];
  toast: (msg: string) => void; onDone: (id: number) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-auto em-nc">
      <div className="em-nc-head">
        <h2 className="em-nc-title">New contacts</h2>
        <p className="em-muted">
          Agents, escrow officers and title reps on the team’s email who are not in CLOZR yet. Add them and their email files on the deal from now on.
          People at a title company you already use are added for you.
        </p>
      </div>
      {error ? <div className="em-empty">{error}</div>
        : rows == null ? <div className="em-empty">Loading new contacts…</div>
        : rows.length === 0 ? <div className="em-empty">No one new to add. New agents and title reps show up here as their email comes in.</div>
        : rows.map((s) => (
          <SuggestionRow key={s.id} s={s} team={team} deals={deals} toast={toast} onDone={() => onDone(s.id)} />
        ))}
    </div>
  );
}

function SuggestionRow({ s, team, deals, toast, onDone }: {
  s: ContactSuggestion; team: Teammate[]; deals: DealRef[]; toast: (msg: string) => void; onDone: () => void;
}) {
  const [kind, setKind] = useState<SuggestionKind>(s.kind);
  const [name, setName] = useState(s.name ?? '');
  const [company, setCompany] = useState(s.company ?? '');
  const [busy, setBusy] = useState<'add' | 'dismiss' | null>(null);
  const deal = s.deal_id != null ? deals.find((d) => d.id === s.deal_id) ?? null : null;
  const who = team.find((t) => t.user_id === s.user_id);
  const base = `nc-${s.id}`;

  async function act(action: 'add' | 'dismiss') {
    setBusy(action);
    const err = await resolveSuggestion(s.id, action, action === 'add' ? { kind, name, company } : undefined);
    setBusy(null);
    if (err) return toast(err);
    toast(action === 'add' ? `${name || s.email} added${deal ? ` to ${deal.label}` : ''}` : `${s.email} won’t be suggested again`);
    onDone();
  }

  return (
    <section className="em-nc-row" aria-labelledby={`${base}-email`}>
      <div className="em-nc-who">
        <GmailIcon name="person_add" size={18} />
        <div className="em-nc-id">
          <span id={`${base}-email`} className="em-nc-email">{s.email}</span>
          <span className="em-muted">
            {s.seen_count > 1 ? `${s.seen_count} emails` : '1 email'} · last {ago(s.last_seen_at)}
            {who ? ` · in ${who.full_name || who.email || 'a teammate'}’s mail` : ''}
            {s.subject ? ` · “${s.subject}”` : ''}
          </span>
          {deal ? <span className="em-tag em-nc-deal">On {deal.label}</span> : null}
        </div>
      </div>
      <div className="em-nc-fields">
        <label className="em-nc-field">
          <span className="em-nc-label">Type</span>
          <select className="em-select" value={kind} onChange={(e) => setKind(e.target.value as SuggestionKind)}>
            {(Object.keys(KIND_LABEL) as SuggestionKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="em-nc-field">
          <span className="em-nc-label">Name</span>
          <input className="em-nc-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        <label className="em-nc-field">
          <span className="em-nc-label">Company</span>
          <input className="em-nc-input" value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="off" />
        </label>
        <div className="em-nc-actions">
          <button type="button" className="em-record" disabled={!!busy} onClick={() => void act('add')}>
            {busy === 'add' ? 'Adding…' : 'Add contact'}
          </button>
          <button type="button" className="em-record em-record--ghost" disabled={!!busy} onClick={() => void act('dismiss')}>
            {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
          </button>
        </div>
      </div>
    </section>
  );
}
