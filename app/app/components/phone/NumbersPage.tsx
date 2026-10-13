// Settings → Numbers, laid out the way smrtPhone does it:
//
//   People         one card per teammate: avatar, name, voicemail greeting,
//                  their numbers (caller ID marked and switchable), each with
//                  its call flow, SMS flow and health chips
//   Company lines  every number with no owner, with its routing; admins give
//                  it to someone or keep it as a company line
//   Pools          the RVM pool, caller reputation and AI agent lines, one
//                  collapsed row each
//
// The merge of rep_phone_numbers, Talkr, caller_lines and number_health is
// lib/number-book.ts. Owners and admins edit everything; a rep changes their
// own caller ID and voicemail greeting.
'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { areaCity, formatPhone, talkr, type FlowGreeting } from '@/lib/talkr';
import { buildNumberBook, needsCallerId, type BookCallerLine, type BookHealth, type BookLine, type BookLineRow, type BookPerson } from '@/lib/number-book';
import { smsSummary, type SmsFlow } from '@/lib/sms-flow';
import { suggestLineOwner } from '@/lib/comm-rep';
import { forgetLineLabels } from '@/lib/crm';
import { forgetLineNames } from '@/lib/line-names';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { type Role, type Teammate, ROLE_LABEL, isAdmin, listTeam } from '@/lib/team';
import { UserAvatar } from '@/components/UserAvatar';
import { Icon, type IconName } from '@/app/components/talkr/Icon';
import { Button, Card, EmptyState, FIELD, Modal, Notice, Segmented, StatusMarker } from '@/app/components/talkr/ui';
import { BuyNumber } from './BuyNumber';
import { routingSummary } from './flow';
import { GreetingEditor } from './Greeting';
import { ChipView, HealthChips, HealthModal } from './HealthChips';
import { CallFlowModal, SmsFlowModal, type Person } from './NumberFlows';
import { CallerReputation } from './Reputation';
import { RvmPool } from './RvmPool';
import { attachToCampaign, ensureAssignable, isPhoneAdmin, refreshPhoneAdmin, usePhoneAdmin } from './store';
import { ensureOnTalkr, syncTeamToTalkr } from './TeammatePhone';
import { errText } from './ui';

type Db = { rows: BookLineRow[]; callerLines: BookCallerLine[]; health: BookHealth[]; agentPhones: string[]; gaps: Map<string, number>; flows: Map<string, SmsFlow> };
type Open =
  | { kind: 'calls' | 'texts' | 'health' | 'manage'; line: BookLine }
  | { kind: 'voicemail'; person: BookPerson }
  | { kind: 'add' }
  | null;

/** A native select at control height: FIELD's vertical padding clips select text. */
const SELECT: React.CSSProperties = { ...FIELD, height: 32, padding: '0 10px', font: '500 12.5px/1 var(--sans)' };
const META: React.CSSProperties = { font: '500 11.5px/1.3 var(--sans)', color: 'var(--muted)' };
const sb = () => supabase;

/** Every read the page needs from CLOZR; a table that is not there yet reads as empty. */
async function loadDb(ws: number, admin: boolean): Promise<Db> {
  const db = sb()!;
  const rows = (q: PromiseLike<{ data: unknown }>) => Promise.resolve(q).then((r) => (r.data ?? []) as never[]).catch(() => [] as never[]);
  const [lines, callers, health, agents, gaps, flows] = await Promise.all([
    rows(db.from('rep_phone_numbers' as never).select('*').eq('workspace_id', ws)),
    rows(db.from('caller_lines' as never).select('phone_e164,pool,fcr_status,reputation_enrolled,branded_attached,spam_risk,market_state').eq('workspace_id', ws)),
    rows(db.from('number_health' as never).select('phone_e164,talkr_number_id,grade,paused,spam_risk,attestation_a_7d,attestation_calls_7d,ten_dlc_assigned,ten_dlc_status,campaign_approved,checked_at').eq('workspace_id', ws)),
    rows(db.from('voice_agent_numbers' as never).select('phone_number').eq('workspace_id', ws)),
    admin ? rows(db.rpc('line_rep_gaps' as never, { p_workspace: ws } as never)) : Promise.resolve([] as never[]),
    rows(db.from('line_sms_flows' as never).select('*').eq('workspace_id', ws)),
  ]);
  return {
    rows: lines as BookLineRow[],
    callerLines: callers as BookCallerLine[],
    health: health as BookHealth[],
    agentPhones: (agents as { phone_number: string | null }[]).map((a) => a.phone_number ?? '').filter(Boolean),
    gaps: new Map((gaps as { phone_e164: string | null; unowned: number }[]).filter((g) => g.phone_e164).map((g) => [g.phone_e164!, Number(g.unowned)])),
    flows: new Map((flows as SmsFlow[]).map((f) => [f.phone_e164, f])),
  };
}

export function NumbersPage({ isMobile }: { isMobile: boolean }) {
  const s = useSession();
  const ws = s.workspace?.id ?? null;
  const me = s.user?.id ?? null;
  const admin = isAdmin((s.workspace?.role as Role | undefined) ?? null);
  const phone = usePhoneAdmin(!s.demo);
  const talkrAdmin = isPhoneAdmin(phone.me);
  const [team, setTeam] = useState<Teammate[] | null>(null);
  const [db, setDb] = useState<Db | null>(null);
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState<Open>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!ws || !supabase) return;
    let live = true;
    void Promise.all([listTeam(ws).catch(() => [] as Teammate[]), loadDb(ws, admin)]).then(([t, d]) => {
      if (!live) return;
      setTeam(t);
      setDb(d);
    });
    return () => { live = false; };
  }, [ws, admin, nonce]);

  // Everyone on the CLOZR team gets a Talkr seat (what Team phones did before).
  const synced = React.useRef(false);
  useEffect(() => {
    if (synced.current || !team || !talkrAdmin) return;
    synced.current = true;
    void syncTeamToTalkr(team).catch(() => undefined);
  }, [team, talkrAdmin]);

  const book = useMemo(() => buildNumberBook({
    team: team ?? [],
    rows: db?.rows ?? [],
    talkrNumbers: phone.numbers,
    talkrMembers: phone.members,
    me: phone.me && me ? { userId: me, talkrId: phone.me.id, defaultNumberId: phone.me.default_phone_number_id } : null,
    callerLines: db?.callerLines ?? [],
    health: db?.health ?? [],
    agentPhones: db?.agentPhones ?? [],
  }), [team, db, phone.numbers, phone.members, phone.me, me]);

  const reload = useCallback(() => {
    if (ws) forgetLineLabels(ws);
    forgetLineNames();
    setNonce((n) => n + 1);
  }, [ws]);

  /** One write with a status line; reloads both sides after. */
  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key); setNote(null);
    try {
      setNote({ ok: true, text: await fn() });
    } catch (err) {
      setNote({ ok: false, text: errText(err) });
    } finally {
      setBusy(null);
      reload();
      void refreshPhoneAdmin();
    }
  }

  const nameOf = (id: string | null) => (id ? team?.find((m) => m.user_id === id)?.full_name || team?.find((m) => m.user_id === id)?.email || 'Teammate' : null);
  const personOf = (userId: string | null) => book.people.find((p) => p.member.user_id === userId) ?? null;
  const owners = (team ?? []).filter((m) => m.role !== 'notary');

  /** The CLOZR row for a line, created when only Talkr knew it. */
  async function ensureRow(l: BookLine, userId: string | null): Promise<void> {
    if (l.row || !ws) return;
    const { error } = await sb()!.from('rep_phone_numbers' as never)
      .insert({ workspace_id: ws, phone_e164: l.phone, label: l.label || areaCity(l.phone) || 'Line', user_id: userId } as never);
    if (error) throw new Error(error.message);
  }

  const setCallerId = (p: BookPerson, l: BookLine) => run('cid:' + l.phone, async () => {
    if (admin) await ensureRow(l, p.member.user_id);
    if (l.row || admin) {
      const { error } = await sb()!.rpc('set_line_caller_id' as never, { p_workspace: ws, p_phone: l.phone } as never);
      if (error) throw new Error(/set_line_caller_id/.test(error.message) ? 'Caller ID needs migration 200 (applies when this merges).' : error.message);
    }
    if (l.talkr) {
      if (p.member.user_id === me) await talkr.updateMe({ default_phone_number_id: l.talkr.id });
      else if (talkrAdmin && p.talkr) await talkr.updateTeamMember(p.talkr.id, { default_phone_number_id: l.talkr.id });
    }
    return `${p.member.full_name || 'They'} now call${p.member.user_id === me ? '' : 's'} from ${formatPhone(l.phone)}`;
  });

  const assign = (l: BookLine, userId: string | null) => run('own:' + l.phone, async () => {
    if (l.row) {
      const { error } = await sb()!.from('rep_phone_numbers' as never).update({ user_id: userId, updated_at: new Date().toISOString() } as never).eq('workspace_id', ws!).eq('phone_e164', l.phone);
      if (error) throw new Error(error.message);
    } else await ensureRow(l, userId);
    let extra = '';
    if (l.talkr && talkrAdmin) {
      const seat = userId ? personOf(userId)?.talkr ?? null : null;
      if (userId && !seat) extra = ' Not on Talkr yet, so Talkr still rings the old owner.';
      else {
        const owner = await ensureAssignable(seat?.id ?? null);
        await talkr.updateNumber(l.talkr.id, { assigned_user_id: owner });
        if (owner) extra = await attachToCampaign(ws, [l.phone]);
      }
    }
    return `${formatPhone(l.phone)} ${userId ? `now belongs to ${nameOf(userId)}` : 'is a company line'}. Its calls and texts are credited to match.${extra}`;
  });

  if (s.demo) return <Notice>The demo has no phone numbers. Sign in to a workspace to manage them.</Notice>;
  if (!ws || team === null || db === null) return <NumbersSkeleton />;

  const missing = admin ? needsCallerId(book) : [];
  const mismatches = admin ? [...book.people.flatMap((p) => p.lines), ...book.company].filter((l) => l.mismatch) : [];
  const uncredited = [...db.gaps.values()].reduce((a, b) => a + b, 0);
  const talkrPeople: Person[] = phone.members.filter((m) => m.status === 'active').map((m) => ({ talkrId: m.id, name: book.people.find((p) => p.talkr?.id === m.id)?.member.full_name || m.display_name }));
  const flowOf = (l: BookLine) => db.flows.get(l.phone) ?? null;
  const lineProps = { admin, talkrAdmin, busy, flowOf, nameOf, onOpen: setOpen };
  const companyCount = book.company.length;

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Icon name="phone" size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ font: '700 13.5px/1 var(--sans)' }}>Numbers</span>
          <span className="mr-auto" style={{ ...META, fontVariantNumeric: 'tabular-nums' }}>
            {book.people.reduce((n, p) => n + p.lines.length, 0)} on people · {companyCount} company
          </span>
          {note ? <StatusMarker color={note.ok ? 'var(--green)' : 'var(--red)'} label={note.ok ? 'Saved' : 'Not saved'} /> : null}
          {admin ? <Button tone="dark" onClick={() => setOpen({ kind: 'add' })}><Icon name="plus" size={13} /> Add number</Button> : null}
        </div>
        {note ? <span role="status" style={{ font: '500 12px/1.45 var(--sans)', color: note.ok ? 'var(--text)' : 'var(--red)', whiteSpace: 'pre-wrap' }}>{note.text}</span> : null}
        {phone.status === 'unavailable' ? <span style={{ ...META, color: 'var(--amber)' }}>Talkr is not connected: routing and caller ID on Talkr are read-only here. {phone.message}</span> : null}
        {missing.length || mismatches.length || uncredited ? (
          <div className="flex flex-wrap gap-1.5">
            {missing.length ? <ChipView chip={{ text: `${missing.length} need a caller ID`, tone: 'warn', detail: missing.map((p) => p.member.full_name).join(', ') }} /> : null}
            {mismatches.length ? <ChipView chip={{ text: `${mismatches.length} owner${mismatches.length === 1 ? '' : 's'} differ on Talkr`, tone: 'warn', detail: mismatches.map((l) => formatPhone(l.phone)).join(', ') }} /> : null}
            {uncredited ? <ChipView chip={{ text: `${uncredited.toLocaleString('en-US')} uncredited`, tone: 'warn', detail: 'Calls and texts on company lines with no rep. Give the line an owner to credit them.' }} /> : null}
          </div>
        ) : null}
      </Card>

      <Card padded={false}>
        <SectionHead icon="users" title="People" />
        {book.people.map((p) => (
          <PersonCard
            key={p.member.user_id}
            p={p}
            self={p.member.user_id === me}
            onTalkr={phone.status !== 'ready' || phone.members.length === 0 || !!p.talkr || p.member.user_id === me}
            company={book.company}
            isMobile={isMobile}
            {...lineProps}
            setCallerId={(l) => setCallerId(p, l)}
            give={(l) => assign(l, p.member.user_id)}
            addToTalkr={() => run('talkr:' + p.member.user_id, async () => {
              await ensureOnTalkr(p.member.email ?? '', p.member.full_name ?? '', p.member.role);
              return `${p.member.full_name} is on Talkr`;
            })}
          />
        ))}
      </Card>

      <Card padded={false}>
        <SectionHead icon="globe" title="Company lines" right={<span style={META}>{companyCount}</span>} />
        {companyCount === 0 ? <EmptyState compact icon="phone" title="No company lines" hint="A number with no owner shows here." /> : book.company.map((l) => {
          const hint = admin && !l.ownerId ? suggestLineOwner(l.label, owners) : null;
          const gap = db.gaps.get(l.phone) ?? 0;
          return (
            <div key={l.phone} className="px-4 py-3" style={{ borderTop: '1px solid var(--line-soft)' }}>
              <NumberLine l={l} {...lineProps}
                tags={<>
                  {l.talkr?.is_company_line ? <ChipView chip={{ text: 'Main', tone: 'good', detail: 'The company line: unowned numbers with no flow use its flow' }} /> : null}
                  {l.formerOwner ? <ChipView chip={{ text: 'Former teammate', tone: 'off', detail: 'Its owner left the workspace' }} /> : null}
                  {gap ? <ChipView chip={{ text: `${gap.toLocaleString('en-US')} uncredited`, tone: 'warn', detail: 'Calls and texts on this line with no rep' }} /> : null}
                </>}
                actions={admin ? (
                  <>
                    {hint ? <Button tone="green" disabled={!!busy} onClick={() => void assign(l, hint.user_id)}>Give to {hint.full_name?.split(' ')[0]}</Button> : null}
                    <select value="" disabled={!!busy} aria-label={`Assign ${formatPhone(l.phone)}`} onChange={(e) => e.target.value && void assign(l, e.target.value)} className="outline-none" style={{ ...SELECT, maxWidth: 170 }}>
                      <option value="">Assign to…</option>
                      {owners.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>)}
                    </select>
                  </>
                ) : null}
              />
            </div>
          );
        })}
      </Card>

      <Collapsed title="RVM pool" meta={`${book.pool.length} line${book.pool.length === 1 ? '' : 's'}`}>
        <RvmPool numbers={phone.numbers.filter((n) => n.status === 'active' || !n.status).map((n) => ({ phone_e164: n.phone_e164, label: n.label }))} admin={talkrAdmin} onBuy={admin ? () => setOpen({ kind: 'add' }) : undefined} />
      </Collapsed>
      {talkrAdmin ? <Collapsed title="Caller reputation" meta="Registrations, spam checks, 10DLC"><CallerReputation enabled /></Collapsed> : null}
      {book.agentLines ? <Collapsed title="AI agent lines" meta={`${book.agentLines} · managed under AI agents`} /> : null}

      {open?.kind === 'calls' && open.line.talkr ? <CallFlowModal line={open.line} people={talkrPeople} ownerTalkrId={personOf(open.line.ownerId)?.talkr?.id ?? null} isMobile={isMobile} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'texts' ? <SmsFlowModal line={open.line} workspaceId={ws} userId={me} people={owners.map((m) => ({ userId: m.user_id, name: m.full_name || m.email || 'Teammate' }))} saved={flowOf(open.line)} onClose={() => setOpen(null)} onSaved={() => { setNote({ ok: true, text: `SMS flow saved for ${formatPhone(open.line.phone)}` }); reload(); }} /> : null}
      {open?.kind === 'health' ? <HealthModal line={open.line} admin={talkrAdmin} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'voicemail' ? <VoicemailModal person={open.person} self={open.person.member.user_id === me} talkrAdmin={talkrAdmin} myGreeting={phone.me?.voicemail_greeting ?? null} onClose={() => setOpen(null)} onSaved={(t) => { setNote({ ok: true, text: t }); void refreshPhoneAdmin(); }} /> : null}
      {open?.kind === 'manage' ? <ManageModal line={open.line} workspaceId={ws} talkrAdmin={talkrAdmin} owners={owners} assign={(u) => { setOpen(null); void assign(open.line, u); }} run={(k, fn) => { setOpen(null); void run(k, fn); }} onClose={() => setOpen(null)} /> : null}
      {open?.kind === 'add' ? <AddNumberModal workspaceId={ws} talkrReady={phone.status === 'ready' && talkrAdmin} owners={owners} people={book.people} known={new Set([...book.people.flatMap((p) => p.lines), ...book.company, ...book.pool].map((l) => l.phone))} onClose={() => setOpen(null)} onDone={(t) => { setOpen(null); setNote({ ok: true, text: t }); reload(); void refreshPhoneAdmin(); }} /> : null}
    </div>
  );
}

/** The page's own shape while it loads: header, then people rows. */
function NumbersSkeleton() {
  const bar = (w: number | string, h = 10): React.CSSProperties => ({ width: w, height: h, borderRadius: 6, background: 'var(--panel-2)' });
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading numbers…">
      <Card className="flex items-center gap-2"><span style={bar(90, 13)} /><span style={bar(140)} /></Card>
      <Card padded={false}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2.5 px-4 py-3" style={{ borderTop: i ? '1px solid var(--line-soft)' : 0 }}>
            <div className="flex items-center gap-2.5"><span style={{ ...bar(32, 32), borderRadius: '50%' }} /><span className="flex flex-col gap-1.5"><span style={bar(130, 12)} /><span style={bar(90)} /></span></div>
            <div className="flex gap-1.5" style={{ paddingLeft: 42 }}><span style={bar(160, 28)} /><span style={bar(120, 28)} /></div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function SectionHead({ icon, title, right }: { icon: IconName; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 pb-2.5 pt-3.5">
      <Icon name={icon} size={14} style={{ color: 'var(--muted)' }} />
      <span className="mr-auto" style={{ font: '650 13.5px/1 var(--sans)' }}>{title}</span>
      {right}
    </div>
  );
}

/** A rarely opened part of the page: one row until it is wanted. */
function Collapsed({ title, meta, children }: { title: string; meta: string; children?: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <Card className="flex items-center gap-3" style={{ padding: '10px 16px' }}>
        <span style={{ font: '600 13px/1.3 var(--sans)' }}>{title}</span>
        <span className="mr-auto min-w-0 truncate" style={META}>{meta}</span>
        {children ? <Button tone="quiet" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</Button> : null}
      </Card>
      {show ? children : null}
    </>
  );
}

type LineProps = {
  admin: boolean; talkrAdmin: boolean; busy: string | null;
  flowOf: (l: BookLine) => SmsFlow | null; nameOf: (id: string | null) => string | null; onOpen: (o: Open) => void;
};

function FlowButton({ icon, label, text, onClick }: { icon: IconName; label: string; text: string; onClick?: () => void }) {
  const body = (
    <>
      <Icon name={icon} size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="min-w-0 truncate">{text}</span>
      {onClick ? <Icon name="chevron-right" size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} /> : null}
    </>
  );
  const style: React.CSSProperties = { font: '500 12px/1 var(--sans)', height: 28, padding: '0 8px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)', maxWidth: '100%', minWidth: 0 };
  return onClick
    ? <button type="button" title={`${label} ${text}`} aria-label={`Edit ${label.toLowerCase()} flow: ${text}`} onClick={onClick} className="num-press num-flow inline-flex items-center gap-1.5" style={{ ...style, cursor: 'pointer' }}>{body}</button>
    : <span title={`${label} ${text}`} className="inline-flex items-center gap-1.5" style={style}>{body}</span>;
}

/** One number: who it is, its caller-ID state, health, and its two flows. */
function NumberLine({ l, admin, talkrAdmin, flowOf, nameOf, onOpen, tags, callerId, actions }: LineProps & { l: BookLine; tags?: React.ReactNode; callerId?: React.ReactNode; actions?: React.ReactNode }) {
  const n = l.talkr;
  const calls = n ? routingSummary(n.routing_mode, n.flow_steps, n.standby) : 'Not on Talkr';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span style={{ font: '650 13px/1.2 var(--sans)', fontVariantNumeric: 'tabular-nums' }}>{formatPhone(l.phone)}</span>
        {l.label ? <span className="min-w-0 truncate" style={META}>{l.label}</span> : null}
        {callerId}
        {tags}
        {l.mismatch ? <ChipView chip={{ text: `Talkr: ${nameOf(l.talkrOwnerId) ?? n?.assigned_user_name ?? 'someone else'}`, tone: 'warn', detail: 'Talkr rings someone other than the owner here. Assign the line again to match.' }} /> : null}
        {!n ? <ChipView chip={{ text: 'Not on Talkr', tone: 'off', detail: 'Only CLOZR knows this number (credit and names). Import it to route calls.' }} /> : null}
        <HealthChips line={l} onOpen={() => onOpen({ kind: 'health', line: l })} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <FlowButton icon="phone" label="Calls" text={calls} onClick={n && talkrAdmin ? () => onOpen({ kind: 'calls', line: l }) : undefined} />
        <FlowButton icon="msg" label="Texts" text={smsSummary(flowOf(l), (id) => nameOf(id))} onClick={admin ? () => onOpen({ kind: 'texts', line: l }) : undefined} />
        <span className="ml-auto" />
        {actions}
        {admin ? <Button tone="quiet" title="Rename, reassign, remove" ariaLabel={`Manage ${formatPhone(l.phone)}`} onClick={() => onOpen({ kind: 'manage', line: l })}><Icon name="more" size={14} /></Button> : null}
      </div>
    </div>
  );
}

function PersonCard({ p, self, onTalkr, company, isMobile, setCallerId, give, addToTalkr, ...lineProps }: LineProps & {
  p: BookPerson; self: boolean; onTalkr: boolean; company: BookLine[]; isMobile: boolean;
  setCallerId: (l: BookLine) => void; give: (l: BookLine) => void; addToTalkr: () => void;
}) {
  const { admin, busy, onOpen } = lineProps;
  const name = p.member.full_name || p.member.email || 'Teammate';
  const canEdit = admin || self;
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3" style={{ borderTop: '1px solid var(--line-soft)' }}>
      <div className="flex flex-wrap items-center gap-2.5">
        <UserAvatar name={name} src={p.member.avatar_url} size={32} />
        <span className="mr-auto flex min-w-0 flex-col gap-0.5">
          <span className="truncate" style={{ font: '650 13.5px/1.2 var(--sans)' }}>{name}{self ? <span style={META}> · you</span> : null}</span>
          <span style={META}>{ROLE_LABEL[p.member.role as Role] ?? p.member.role} · {p.lines.length ? `${p.lines.length} number${p.lines.length === 1 ? '' : 's'}` : 'No number'}</span>
        </span>
        {!onTalkr && admin ? <Button tone="ghost" disabled={!!busy || !p.member.email} onClick={addToTalkr}>Add to Talkr</Button> : null}
        {canEdit && (p.talkr || self) ? <Button tone="quiet" onClick={() => onOpen({ kind: 'voicemail', person: p })}><Icon name="voicemail" size={13} /> Voicemail</Button> : null}
        {admin && company.length ? (
          <select value="" disabled={!!busy} aria-label={`Give ${name} a company line`} onChange={(e) => { const l = company.find((x) => x.phone === e.target.value); if (l) give(l); }} className="outline-none" style={{ ...SELECT, maxWidth: 190 }}>
            <option value="">Give a number…</option>
            {company.map((l) => <option key={l.phone} value={l.phone}>{formatPhone(l.phone)}{l.label ? ` · ${l.label}` : ''}</option>)}
          </select>
        ) : null}
      </div>
      {p.lines.length ? (
        <div className="flex flex-col gap-2.5" style={{ paddingLeft: isMobile ? 0 : 42 }}>
          {p.lines.map((l) => (
            <NumberLine key={l.phone} l={l} {...lineProps}
              callerId={l.callerId
                ? <ChipView chip={{ text: 'Caller ID', tone: 'good', detail: `${name} calls and texts from this number` }} />
                : canEdit && p.lines.length > 1
                  ? <Button tone="quiet" disabled={!!busy} title="Call and text from this number" onClick={() => setCallerId(l)} style={{ padding: '0 6px', minHeight: 24, font: '600 11.5px/1 var(--sans)', color: 'var(--text)', textDecoration: 'underline', textUnderlineOffset: 3 }}>Make caller ID</Button>
                  : null}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A person's voicemail greeting (record, upload or text) and, for admins, the cell a flow can forward to. */
function VoicemailModal({ person, self, talkrAdmin, myGreeting, onClose, onSaved }: {
  person: BookPerson; self: boolean; talkrAdmin: boolean; myGreeting: FlowGreeting | null; onClose: () => void; onSaved: (text: string) => void;
}) {
  const start = self && !talkrAdmin ? myGreeting : person.talkr?.voicemail_greeting ?? (self ? myGreeting : null);
  const [greeting, setGreeting] = useState<FlowGreeting | null>(start ?? null);
  const [cell, setCell] = useState(person.talkr?.personal_phone_e164 ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = person.member.full_name || 'their';

  async function save() {
    setBusy(true); setError(null);
    try {
      if (greeting && ('tts' in greeting ? !greeting.tts.trim() : !greeting.audio_url)) throw new Error('Record, upload or type the greeting first');
      if (self) {
        const r = await talkr.updateMe({ voicemail_greeting: greeting });
        if (!('voicemail_greeting' in r)) throw new Error('Talkr has not shipped self-service greetings yet. Ask an admin to set it.');
      } else if (person.talkr) await talkr.updateTeamMember(person.talkr.id, { voicemail_greeting: greeting });
      if (talkrAdmin && person.talkr && cell !== (person.talkr.personal_phone_e164 ?? '')) {
        const e = cell.trim() ? toE164Strict(cell) : null;
        if (cell.trim() && !e) throw new Error('The cell number is not a phone number');
        await talkr.updateTeamMember(person.talkr.id, { personal_phone_e164: e });
      }
      onSaved(`${self ? 'Your' : `${name}’s`} voicemail saved`);
      onClose();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Voicemail · ${person.member.full_name ?? 'Teammate'}`} onClose={onClose} width={520}>
      <div className="flex flex-col gap-3">
        <GreetingEditor value={greeting} onChange={setGreeting} allowDefault defaultLabel="The line’s greeting, else the workspace default." />
        {talkrAdmin && person.talkr ? (
          <label className="flex flex-col gap-1.5">
            <span style={META}>Cell for call-flow forwards</span>
            <input value={cell} onChange={(e) => setCell(e.target.value)} placeholder="(210) 555-0100…" inputMode="tel" autoComplete="tel" className="outline-none" style={{ ...FIELD, maxWidth: 200 }} />
          </label>
        ) : null}
        <div className="flex items-center gap-2">
          {error ? <span className="mr-auto" role="alert" style={{ font: '500 12px/1.4 var(--sans)', color: 'var(--red)' }}>{error}</span> : <span className="mr-auto" />}
          <Button tone="accent" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </div>
    </Modal>
  );
}

const toE164Strict = (raw: string) => {
  const d = raw.replace(/\D/g, '');
  return d.length === 10 ? '+1' + d : d.length === 11 && d.startsWith('1') ? '+' + d : null;
};

/** Admin actions on one number: name, owner, main company line, remove, release. */
function ManageModal({ line, workspaceId, talkrAdmin, owners, assign, run, onClose }: {
  line: BookLine; workspaceId: number; talkrAdmin: boolean; owners: Teammate[];
  assign: (userId: string | null) => void; run: (key: string, fn: () => Promise<string>) => void; onClose: () => void;
}) {
  const [label, setLabel] = useState(line.label);
  const [confirm, setConfirm] = useState<'remove' | 'release' | null>(null);
  const phone = formatPhone(line.phone);
  const n = line.talkr;
  const rename = () => run('label:' + line.phone, async () => {
    const next = label.trim();
    if (!next) throw new Error('Name the number');
    if (line.row) {
      const { error } = await sb()!.from('rep_phone_numbers' as never).update({ label: next, updated_at: new Date().toISOString() } as never).eq('workspace_id', workspaceId).eq('phone_e164', line.phone);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await sb()!.from('rep_phone_numbers' as never).insert({ workspace_id: workspaceId, phone_e164: line.phone, label: next, user_id: line.ownerId } as never);
      if (error) throw new Error(error.message);
    }
    if (n && talkrAdmin) await talkr.updateNumber(n.id, { label: next });
    return `${phone} is now “${next}”`;
  });
  return (
    <Modal title={`Manage · ${phone}`} onClose={onClose} width={480}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span style={META}>Name</span>
          <span className="flex gap-2">
            <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className="min-w-0 flex-1 outline-none" style={FIELD} onKeyDown={(e) => { if (e.key === 'Enter') rename(); }} />
            <Button tone="ghost" disabled={label.trim() === line.label} onClick={rename}>Rename</Button>
          </span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span style={META}>Owner</span>
          <select value={line.ownerId ?? ''} onChange={(e) => assign(e.target.value || null)} className="outline-none" style={SELECT}>
            <option value="">Company line (no owner)</option>
            {owners.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name || m.email}</option>)}
          </select>
          <span style={META}>The owner gets credit for its calls and texts, past ones too.</span>
        </label>
        {n && talkrAdmin ? (
          <Button tone="ghost" onClick={() => run('main:' + line.phone, async () => {
            await talkr.setCompanyLine(n.id, !n.is_company_line);
            return n.is_company_line ? `${phone} is no longer the main company line` : `${phone} is the main company line`;
          })}>{n.is_company_line ? 'Unset main company line' : 'Make main company line'}</Button>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-3" style={{ borderTop: '1px solid var(--line-soft)' }}>
          {confirm ? (
            <>
              <span className="mr-auto" style={{ font: '500 12px/1.4 var(--sans)', color: 'var(--red)' }}>
                {confirm === 'release' ? 'The carrier takes the number back. It stops ringing anywhere.' : 'CLOZR forgets the name and owner. Talkr keeps the number.'}
              </span>
              <Button tone="ghost" onClick={() => setConfirm(null)}>Keep</Button>
              <Button tone="red" onClick={() => run(confirm + ':' + line.phone, async () => {
                if (confirm === 'release' && n) { await talkr.releaseNumber(n.id); return `${phone} released`; }
                const { error } = await sb()!.from('rep_phone_numbers' as never).delete().eq('workspace_id', workspaceId).eq('phone_e164', line.phone);
                if (error) throw new Error(error.message);
                return `${phone} removed from CLOZR`;
              })}>{confirm === 'release' ? 'Release number' : 'Remove'}</Button>
            </>
          ) : (
            <>
              <span className="mr-auto" />
              {line.row ? <Button tone="quiet" onClick={() => setConfirm('remove')}>Remove from CLOZR</Button> : null}
              {n && talkrAdmin ? <Button tone="quiet" onClick={() => setConfirm('release')}><span style={{ color: 'var(--red)' }}>Release</span></Button> : null}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Buy from the carrier, import a carrier number into Talkr, or list a number CLOZR should know (smrtPhone, a cell). */
function AddNumberModal({ workspaceId, talkrReady, owners, people, known, onClose, onDone }: {
  workspaceId: number; talkrReady: boolean; owners: Teammate[]; people: BookPerson[]; known: Set<string>; onClose: () => void; onDone: (text: string) => void;
}) {
  const [tab, setTab] = useState<'buy' | 'import' | 'existing'>(talkrReady ? 'buy' : 'existing');
  const [owner, setOwner] = useState('');
  const [carrier, setCarrier] = useState<Array<{ phone_e164: string; attached: boolean }> | null>(null);
  const [phoneText, setPhoneText] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seat = owner ? people.find((p) => p.member.user_id === owner)?.talkr ?? null : null;
  const ownerName = owner ? owners.find((m) => m.user_id === owner)?.full_name ?? null : null;

  useEffect(() => {
    if (tab !== 'import' || carrier) return;
    talkr.carrierNumbers().then((r) => setCarrier(r.numbers)).catch((err) => setError(errText(err)));
  }, [tab, carrier]);

  async function step(key: string, fn: () => Promise<string>) {
    setBusy(key); setError(null);
    try { onDone(await fn()); } catch (err) { setError(errText(err)); } finally { setBusy(null); }
  }
  const addExisting = () => step('existing', async () => {
    const p = toE164Strict(phoneText);
    if (!p) throw new Error('Enter a full US number, like (210) 555-0100');
    if (known.has(p)) throw new Error(`${formatPhone(p)} is already listed`);
    await remember(p, label.trim() || null);
    return `${formatPhone(p)} added${ownerName ? ` for ${ownerName}` : ' as a company line'}`;
  });
  const remember = async (p: string, name: string | null) => {
    const { error: e } = await sb()!.from('rep_phone_numbers' as never)
      .upsert({ workspace_id: workspaceId, phone_e164: p, label: name || areaCity(p) || 'Line', user_id: owner || null } as never, { onConflict: 'workspace_id,phone_e164' });
    if (e) throw new Error(e.message);
  };

  return (
    <Modal title="Add a number" onClose={onClose} width={560}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={tab} onChange={setTab} options={[...(talkrReady ? [{ value: 'buy' as const, label: 'Buy' }, { value: 'import' as const, label: 'Import from carrier' }] : []), { value: 'existing' as const, label: 'Add existing' }]} />
          <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner" className="ml-auto outline-none" style={SELECT}>
            <option value="">Company line</option>
            {owners.map((m) => <option key={m.user_id} value={m.user_id}>For {m.full_name || m.email}</option>)}
          </select>
        </div>
        {owner && !seat && tab !== 'existing' ? <span style={{ ...META, color: 'var(--amber)' }}>{ownerName} is not on Talkr yet: it is bought as a company line.</span> : null}
        {tab === 'buy' ? <BuyNumber assignTo={seat?.id ?? null} assignName={seat ? ownerName : null} onNote={(nt) => { if (!nt) return; if (nt.ok) onDone(nt.text); else setError(nt.text); }} /> : null}
        {tab === 'import' ? (
          carrier === null ? <span style={META}>Asking the carrier…</span> : carrier.length === 0 ? <span style={META}>Every carrier number is already on Talkr.</span> : (
            <div className="flex flex-col">
              {carrier.map((c) => (
                <div key={c.phone_e164} className="flex items-center gap-2 py-1.5" style={{ borderTop: '1px solid var(--line-soft)' }}>
                  <span className="mr-auto" style={{ font: '600 12.5px/1 var(--sans)' }}>{formatPhone(c.phone_e164)} <span style={META}>{areaCity(c.phone_e164) ?? ''}</span></span>
                  <Button tone="ghost" disabled={!!busy} onClick={() => void step('imp:' + c.phone_e164, async () => {
                    const assigned = await ensureAssignable(seat?.id ?? null);
                    const r = await talkr.importNumber({ phone_e164: c.phone_e164, assigned_user_id: assigned, label: areaCity(c.phone_e164) });
                    if (owner) await remember(c.phone_e164, null);
                    const tenDlc = await attachToCampaign(workspaceId, [c.phone_e164]);
                    await refreshPhoneAdmin();
                    return `${formatPhone(c.phone_e164)} ${r.already_imported ? 'was already on Talkr' : 'imported'}.${tenDlc}`;
                  })}>{busy === 'imp:' + c.phone_e164 ? 'Importing…' : 'Import'}</Button>
                </div>
              ))}
            </div>
          )
        ) : null}
        {tab === 'existing' ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void addExisting(); }}>
            <label className="flex flex-col gap-1.5">
              <span style={META}>Number</span>
              <input value={phoneText} onChange={(e) => setPhoneText(e.target.value)} placeholder="(210) 555-0100…" inputMode="tel" autoComplete="off" className="outline-none" style={{ ...FIELD, width: 160 }} />
            </label>
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span style={META}>Name</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Alex Main…" autoComplete="off" className="min-w-0 outline-none" style={FIELD} />
            </label>
            <Button tone="dark" type="submit" disabled={busy === 'existing'}>{busy === 'existing' ? 'Adding…' : 'Add number'}</Button>
          </form>
        ) : null}
        {error ? <span role="alert" style={{ font: '500 12px/1.4 var(--sans)', color: 'var(--red)', whiteSpace: 'pre-wrap' }}>{error}</span> : null}
      </div>
    </Modal>
  );
}
