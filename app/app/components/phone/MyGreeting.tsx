// Settings → Audio & sounds: the voicemail greeting a caller hears when you
// miss them. Self-service through Talkr's /v1/me, so every rep can set their
// own; admins can still set anyone's from Team.
'use client';

import React, { useEffect, useState } from 'react';
import { talkr, type FlowGreeting } from '@/lib/talkr';
import { GreetingEditor } from './Greeting';
import { Btn, MUTED, NoteBox, errText, type Note } from './ui';

const same = (a: FlowGreeting | null | undefined, b: FlowGreeting | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const blank = (g: FlowGreeting | null) => Boolean(g && ('tts' in g ? !g.tts.trim() : !g.audio_url));

export function MyVoicemailGreeting() {
  const [saved, setSaved] = useState<FlowGreeting | null | undefined>(undefined);
  const [draft, setDraft] = useState<FlowGreeting | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    talkr.me()
      .then((me) => { if (!live) return; setSaved(me.voicemail_greeting ?? null); setDraft(me.voicemail_greeting ?? null); })
      .catch((err) => { if (live) setNote({ ok: false, text: errText(err) }); });
    return () => { live = false; };
  }, []);

  if (saved === undefined) return note ? <NoteBox note={note} /> : <div style={{ fontSize: '12px', color: MUTED }}>Loading…</div>;

  const dirty = !same(draft, saved);
  return (
    <div style={{ display: 'grid', gap: '8px' }}>
      <GreetingEditor value={draft} onChange={(g) => { setDraft(g); setNote(null); }} allowDefault defaultLabel="Your line’s or the workspace’s default greeting." />
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
        <Btn primary disabled={!dirty || busy || blank(draft)} onClick={() => {
          setBusy(true); setNote(null);
          talkr.updateMe({ voicemail_greeting: draft })
            .then((r) => {
              // A Talkr from before self-service greetings drops the field without saying so.
              if (!('voicemail_greeting' in r)) throw new Error('Talkr has not been updated to save your own greeting yet — ask an admin to set it from Team for now.');
              setSaved(draft); setNote({ ok: true, text: draft ? 'Voicemail greeting saved.' : 'Back to the default greeting.' }); })
            .catch((err) => setNote({ ok: false, text: errText(err) }))
            .finally(() => setBusy(false));
        }}>Save greeting</Btn>
        {dirty ? <Btn onClick={() => { setDraft(saved); setNote(null); }}>Undo</Btn> : null}
      </div>
      <NoteBox note={note} />
    </div>
  );
}
