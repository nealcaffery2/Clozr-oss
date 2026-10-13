// An AI Assistant outbound call (Talkr → Telnyx AI Assistant, ElevenLabs
// voice), from the button to the record.
//
// The button used to fire POST /v1/ai-calls and print "AI call started
// (queued)". Nothing said whether AI calling was even switched on, the call's
// progress was never shown, and the call only reached a record if the
// two-minute mirror matched its number to one. Now:
//
//   1. the org's AI config is checked first, and a switched-off feature, a
//      missing assistant or a missing Telnyx key is named rather than surfacing
//      as Talkr's generic refusal;
//   2. the call is filed on the record the number belongs to straight away
//      (call_origin 'ai_agent'), so call-sync fills in its recording,
//      transcript, notes and score on that record like any other call;
//   3. its status is polled until it ends, and the ending says how it went.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type AiCallConfigDto } from './talkr-web/api';
import { fileCallOnRecord } from './call-file';

export type AiCallPhase = 'idle' | 'starting' | 'live' | 'ended' | 'error';
export type AiCallTarget = { name?: string | null; sellerId?: number | null; buyerId?: number | null; dealId?: number | null };

const POLL_MS = 4000;
const POLL_MAX_MS = 20 * 60_000;
const ENDED = /^(completed|failed|busy|no[-_]?answer|canceled|cancelled|voicemail|rejected|ended|missed)$/i;

/** Why AI calling cannot start, from the org's config; null when it can. */
export function aiConfigProblem(c: AiCallConfigDto): string | null {
  if (!c.enabled) return 'AI calling is off for this team. An admin turns it on in Settings, Calling.';
  if (!c.assistant_id) return 'No Telnyx AI Assistant is set. An admin adds its id in Settings, Calling.';
  if (!c.telnyx_configured) return 'Talkr has no Telnyx key (TELNYX_API_KEY), so it cannot place AI calls.';
  return null;
}

/** A Talkr refusal, in words. */
export function aiCallError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return err.message;
    if (err.status === 403) return 'Your Talkr role cannot place AI calls. Ask an admin.';
    if (err.status === 404) return 'This Talkr server has no AI calling endpoint. Update Talkr or check the API URL in Settings.';
    if (err.status === 429) return 'Talkr is rate limiting AI calls. Try again in a minute.';
    return err.message || `Talkr refused the AI call (HTTP ${err.status}).`;
  }
  return err instanceof Error ? err.message : 'The AI call did not start.';
}

const STATUS_WORDS: Record<string, string> = {
  queued: 'Queued', initiated: 'Dialing', ringing: 'Ringing', in_progress: 'Talking', 'in-progress': 'Talking',
  answered: 'Talking', bridged: 'Talking',
};

function mmss(s: number | null | undefined): string {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

export function useAiCall(workspaceId: number | null) {
  const [phase, setPhase] = useState<AiCallPhase>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const alive = useRef(true);
  const pollSeq = useRef(0);
  useEffect(() => () => { alive.current = false; pollSeq.current++; }, []);

  const start = useCallback(async (toE164: string, target: AiCallTarget | null) => {
    if (phase === 'starting') return;
    setPhase('starting');
    setNote('Checking AI calling…');
    try {
      const cfg = await api.getAiCallConfig();
      const problem = aiConfigProblem(cfg);
      if (problem) { setPhase('error'); setNote(problem); return; }
    } catch (err) {
      // An older Talkr without the config endpoint can still take the call.
      if (!(err instanceof ApiError && err.status === 404)) { setPhase('error'); setNote(aiCallError(err)); return; }
    }
    setNote('Starting the AI call…');
    let r;
    try {
      const name = (target?.name ?? '').trim();
      r = await api.createAiCall({ to_number: toE164, variables: { contact_name: name, first_name: name.split(/\s+/)[0] ?? '' } });
    } catch (err) {
      if (alive.current) { setPhase('error'); setNote(aiCallError(err)); }
      return;
    }
    if (!alive.current) return;
    const id = r.call.id;
    setCallId(id);
    setPhase('live');
    const takeover = r.takeover_e164 ? ` A person can take over at ${r.takeover_e164}.` : '';
    setNote(`AI call ${STATUS_WORDS[r.call.status] ?? r.call.status}.${takeover}`);

    const file = (extra: { status?: string | null; durationS?: number | null; occurredAt?: string }) => {
      if (workspaceId === null || !target || (target.sellerId == null && target.buyerId == null)) return;
      void fileCallOnRecord({
        workspaceId, talkrCallId: id, sellerId: target.sellerId ?? null, buyerId: target.buyerId ?? null, dealId: target.dealId ?? null,
        direction: 'outbound', fromPhone: r.call.from_number, toPhone: r.call.to_number,
        occurredAt: extra.occurredAt ?? new Date().toISOString(), status: extra.status ?? r.call.status, durationS: extra.durationS ?? null,
        origin: 'ai_agent',
      }).then((res) => { if (!res.ok) console.error('could not file the AI call on the record', res.message); });
    };
    file({});

    const seq = ++pollSeq.current;
    const began = Date.now();
    while (alive.current && seq === pollSeq.current && Date.now() - began < POLL_MAX_MS) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      if (!alive.current || seq !== pollSeq.current) return;
      let call;
      try {
        call = (await api.getCall(id)).call;
      } catch {
        continue; // a missed poll is not the call failing
      }
      const ended = !!call.ended_at || ENDED.test(call.status);
      if (!ended) {
        setNote(`AI call ${STATUS_WORDS[call.status] ?? call.status}${call.answered_at ? ` · ${mmss((Date.now() - Date.parse(call.answered_at)) / 1000)}` : ''}.${takeover}`);
        continue;
      }
      setPhase('ended');
      const talked = (call.duration_seconds ?? 0) > 0 && !/fail|busy|no[-_]?answer|cancel|reject/i.test(call.status);
      setNote(talked
        ? `AI call ended after ${mmss(call.duration_seconds)}. The transcript and notes land on the record once the recording is transcribed.`
        : `AI call ended: ${call.status.replace(/[-_]/g, ' ')}${call.failure_class && call.failure_class !== 'none' ? ` (${call.failure_class.replace(/[-_]/g, ' ')})` : ''}.`);
      file({ status: call.status, durationS: call.duration_seconds, occurredAt: call.answered_at ?? call.created_at });
      return;
    }
  }, [phase, workspaceId]);

  const reset = useCallback(() => { pollSeq.current++; setPhase('idle'); setNote(null); setCallId(null); }, []);
  return { phase, note, callId, busy: phase === 'starting', start, reset };
}

const idOf = (v: string | null | undefined): number | null => {
  const n = v ? Number(String(v).replace(/^[a-z]+/, '')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** The dialer's record for a number (`V.dialerRecordFor`) as an AI call target. */
export function aiTargetFrom(rec: { name?: string | null; target?: { personId?: string | null; buyerId?: string | null } } | null): AiCallTarget | null {
  if (!rec) return null;
  const sellerId = idOf(rec.target?.personId);
  return { name: rec.name ?? null, sellerId, buyerId: sellerId === null ? idOf(rec.target?.buyerId) : null };
}
