// Settings → Phone: the Talkr side of the workspace.
//
// Three things a rep or admin does here, in the order they hit them:
//
//   1. See whether Talkr knows them. CLOZR signs the rep in with their own
//      Supabase session; Talkr links that to a Talkr user by email. Until an
//      admin has added the email on Talkr's side, the dialer can only say so.
//   2. Pick the caller ID: one of their lines, or local presence.
//   3. Numbers (admins) live in the Phone numbers card below it
//      (app/components/phone): owners, routing, import, buy, release.
//
// Everything is a Talkr call. Nothing here touches CLOZR's own tables.
'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { liveCallerBlock, type LinePools } from '@/lib/caller-spin';
import { loadLinePools } from '@/lib/line-pools';
import { pushCallerIdPick } from '@/lib/caller-id-link';
import { useSession } from '@/lib/session';
import {
  TalkrError,
  areaCity,
  formatPhone,
  talkr,
  type MeDto,
  type PhoneNumberDto,
} from '@/lib/talkr';
import { TalkrMark } from '@/app/components/brand/TalkrMark';

const card: React.CSSProperties = { background: 'var(--surface, #fff)', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '12px', padding: '16px 18px', marginBottom: '12px' };
const label: React.CSSProperties = { display: 'block', fontSize: '11.5px', color: 'var(--meta, #71717a)', fontWeight: 600, marginBottom: '5px' };
const field: React.CSSProperties = { height: '34px', padding: '0 10px', border: '1px solid var(--divider, #e4e4e7)', borderRadius: '9px', fontSize: '13px', outline: 0, background: 'var(--canvas, #fafafa)', color: 'var(--ink, #18181b)' };
const btn = (primary = false, disabled = false): React.CSSProperties => ({
  height: '32px', padding: '0 12px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer',
  border: `1px solid ${primary ? '#0A8560' : 'var(--divider, #e4e4e7)'}`, background: primary ? (disabled ? '#7fcbb2' : '#0A8560') : '#fff', color: primary ? '#fff' : disabled ? '#a1a1aa' : '#18181b',
});

type Note = { ok: boolean; text: string } | null;

function errText(err: unknown): string {
  if (err instanceof TalkrError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export function TalkrPhone({ demo, isMobile, talkrUrl }: { demo: boolean; isMobile: boolean; talkrUrl: string | null }) {
  const [me, setMe] = useState<MeDto | null>(null);
  const [status, setStatus] = useState<'loading' | 'ok' | 'unlinked' | 'unreachable' | 'error'>('loading');
  const [statusText, setStatusText] = useState<string>('');
  const [numbers, setNumbers] = useState<PhoneNumberDto[]>([]);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const session = useSession();
  const workspaceId = session.workspace?.id ?? null;
  const userId = session.user?.id ?? null;
  const [pools, setPools] = useState<LinePools>({});
  useEffect(() => {
    let live = true;
    void loadLinePools(workspaceId).then((next) => { if (live) setPools(next); });
    return () => { live = false; };
  }, [workspaceId]);

  const canManage = me?.role === 'owner' || me?.role === 'admin';

  useEffect(() => {
    if (demo) return;
    let live = true;
    void (async () => {
      try {
        const m = await talkr.me();
        if (!live) return;
        setMe(m);
        setStatus('ok');
        setStatusText(`Linked as ${m.display_name ?? m.email ?? 'you'}${m.org ? ` · ${m.org.name}` : ''} · ${m.role ?? 'rep'}`);
        const n = await talkr.numbers().catch(() => ({ numbers: [] as PhoneNumberDto[] }));
        if (!live) return;
        setNumbers(n.numbers);
      } catch (err) {
        if (!live) return;
        if (err instanceof TalkrError && (err.status === 401 || err.code === 'unlinked')) {
          setStatus('unlinked');
          setStatusText('Talkr does not recognise this sign-in yet. A Talkr owner or admin adds your email under Team on Talkr; the link completes the next time you open this page.');
        } else if (err instanceof TalkrError && err.status === 0) {
          setStatus('unreachable');
          setStatusText(err.message);
        } else {
          setStatus('error');
          setStatusText(errText(err));
        }
      }
    })();
    return () => { live = false; };
  }, [demo, nonce, talkrUrl]);

  const reload = useCallback(() => {
    setStatus('loading');
    setNonce((n) => n + 1);
  }, []);

  const run = useCallback(async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setNote(null);
    try {
      const text = await fn();
      setNote({ ok: true, text });
      reload();
    } catch (err) {
      setNote({ ok: false, text: errText(err) });
    } finally {
      setBusy(null);
    }
  }, [reload]);

  const mine = numbers.filter((n) => n.status === 'active' && n.assigned_user_id === me?.id);
  const active = numbers.filter((n) => n.status === 'active');
  const blockOf = (n: PhoneNumberDto) => liveCallerBlock(n, pools);
  const liveCount = active.filter((n) => !blockOf(n)).length;
  const selectedId = me?.caller_id_mode === 'local_presence' ? 'local_presence' : me?.default_phone_number_id ?? mine[0]?.id ?? active[0]?.id ?? '';
  const selectedBlock = active.find((n) => n.id === selectedId);
  const dot = status === 'ok' ? '#16a34a' : status === 'loading' ? 'var(--subtle, #a1a1aa)' : '#d97706';

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <TalkrMark size={16} />
        <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>Phone</h2>
        <span style={{ fontSize: '11px', color: 'var(--subtle, #a1a1aa)' }}>Talkr</span>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: '12.5px', color: 'var(--meta, #71717a)', lineHeight: 1.5 }}>
        Calls, texts, recordings and the live coach run on Talkr. Your CLOZR sign-in is your Talkr sign-in — there is no second password.
      </p>

      {demo ? (
        <div style={{ padding: '10px 12px', borderRadius: '9px', background: 'var(--surface-2, #f4f4f5)', fontSize: '12.5px', color: 'var(--muted, #52525b)' }}>
          The demo has no phone. Sign in to a workspace to connect Talkr.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px', borderRadius: '9px', background: status === 'ok' ? 'var(--positive-soft, #dcfce7)' : 'var(--canvas, #fafafa)', border: `1px solid ${status === 'ok' ? 'var(--tint-green-3, #bbf7d0)' : 'var(--divider, #e4e4e7)'}` }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '999px', background: dot, marginTop: '5px', flex: 'none' }} />
            <div style={{ fontSize: '12.5px', color: status === 'ok' ? '#15803d' : 'var(--muted, #52525b)', lineHeight: 1.5, flex: 1 }}>
              {status === 'loading' ? 'Checking Talkr…' : statusText}
            </div>
            <button onClick={reload} style={btn()}>Re-check</button>
          </div>

          {status === 'ok' && me ? (
            <>
              {/* Caller ID */}
              <div style={{ marginTop: '14px' }}>
                <span style={label}>Your caller ID</span>
                {active.length === 0 ? (
                  <div style={{ fontSize: '12.5px', color: 'var(--meta, #71717a)' }}>No numbers on the org yet{canManage ? ' — buy one below.' : '. Ask an admin to buy one.'}</div>
                ) : (
                  <>
                  <select
                    value={selectedId}
                    onChange={(e) => {
                      const v = e.target.value;
                      const chosen = active.find((n) => n.id === v);
                      if (chosen && blockOf(chosen)) return;
                      void run('callerid', async () => {
                        const next = v === 'local_presence'
                          ? await talkr.updateMe({ caller_id_mode: 'local_presence' })
                          : await talkr.updateMe({ caller_id_mode: 'dedicated', default_phone_number_id: v });
                        setMe(next);
                        if (v !== 'local_presence') void pushCallerIdPick({ workspaceId, userId, talkrOrgId: next.org?.id, phone: next.org_numbers.find((n) => n.id === v)?.phone_e164 });
                        return v === 'local_presence' ? 'Caller ID follows the seller’s area code.' : `Calls and texts go out from ${formatPhone(next.org_numbers.find((n) => n.id === v)?.phone_e164)}.`;
                      });
                    }}
                    disabled={busy === 'callerid'}
                    style={{ ...field, width: isMobile ? '100%' : '360px' }}
                  >
                    {active.map((n) => {
                      const blocked = blockOf(n);
                      return (
                        <option key={n.id} value={n.id} disabled={!!blocked}>
                          {formatPhone(n.phone_e164)}{areaCity(n.phone_e164) ? ` · ${areaCity(n.phone_e164)}` : ''}{n.label ? ` · ${n.label}` : ''}{n.id === me.default_phone_number_id ? ' · default' : n.assigned_user_id === me.id ? ' · mine' : n.assigned_user_name ? ` · ${n.assigned_user_name}` : ''}{blocked ? ` · ${blocked}` : ''}
                        </option>
                      );
                    })}
                    {(liveCount > 1 || me.caller_id_mode === 'local_presence') ? <option value="local_presence">Local presence · match the seller’s area code</option> : null}
                  </select>
                  {selectedBlock && blockOf(selectedBlock) && (
                    <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--tx-red, #b91c1c)' }}>
                      This line is off live calls: {blockOf(selectedBlock)}. Pick a different caller ID.
                    </div>
                  )}
                  </>
                )}
              </div>

              <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--meta, #71717a)' }}>
                {canManage ? 'Lines, owners, routing, importing and buying live in Phone numbers below.' : `Your lines: ${mine.length ? mine.map((n) => formatPhone(n.phone_e164)).join(', ') : 'none yet — ask an admin'}.`}
              </div>
            </>
          ) : null}

          {note ? (
            <div role="status" style={{ marginTop: '10px', padding: '9px 11px', borderRadius: '9px', fontSize: '12.5px', lineHeight: 1.5, background: note.ok ? 'var(--positive-soft, #dcfce7)' : 'var(--negative-soft, #fee2e2)', border: `1px solid ${note.ok ? 'var(--tint-green-3, #bbf7d0)' : 'var(--tint-red-2, #fecaca)'}`, color: note.ok ? 'var(--tx-green, #15803d)' : '#b91c1c' }}>
              {note.text}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
