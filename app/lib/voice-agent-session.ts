// The live test call: ElevenLabs' client SDK, loaded only when a rep presses
// Start (it carries the WebRTC and audio-worklet code, so it must not ride in
// the main bundle), plus a scripted stand-in for /demo. Both return the same
// handle and drive the same callbacks, so the screen has one code path.

import { DEMO_SCRIPT } from './voice-agent-demo';
import { MIC_MESSAGES, micProblem, type TestSession } from './voice-agent';

export type CallStatus = 'connecting' | 'connected' | 'ended';

export type CallEvents = {
  onStatus: (s: CallStatus) => void;
  onSpeaking: (agentSpeaking: boolean) => void;
  onLine: (role: 'agent' | 'user', text: string) => void;
  onTool: (name: string, phase: 'start' | 'done' | 'error') => void;
  onError: (message: string) => void;
};

export type CallHandle = {
  end: () => Promise<void>;
  setMuted: (muted: boolean) => void;
  /** 0..1, polled for the meter. */
  micLevel: () => number;
  agentLevel: () => number;
  /** The ElevenLabs conversation id, which score_call needs; null when the SDK has not reported one (and in /demo). */
  conversationId: () => string | null;
};

/** The mic and audio opened inside the tap that starts a call; `ready` settles once the mic is open. */
export type AudioPrime = { ready: Promise<void>; release: () => void };

/**
 * Open the microphone and unlock audio while the tap is still the current user gesture.
 * Safari (every iPhone browser) lets a page start audio or capture only inside the gesture;
 * by the time test_session has answered, the tap no longer counts and the SDK's audio fails
 * with "The request is not allowed by the user agent or the platform". Call it synchronously
 * from the click, before any await; the open mic keeps the page capturing until the SDK's own
 * audio is running, which WebKit also accepts. `release` stops this mic and audio context.
 */
export function primeAudio(): AudioPrime {
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      ctx = new AC();
      // One silent sample, played inside the gesture, is what unlocks audio output on iOS.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
      void ctx.resume().catch(() => undefined);
    }
  } catch { /* no Web Audio here; the SDK reports that itself */ }
  const ready = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open a microphone here. Use https and a current browser.');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      throw new Error(MIC_MESSAGES[micProblem(err)]);
    }
  })();
  // A refusal is read where ready is awaited; this only keeps it from reading as unhandled.
  ready.catch(() => undefined);
  return {
    ready,
    release: () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      void ctx?.close().catch(() => undefined);
      ctx = null;
    },
  };
}

/** An error as the person needs it: the message, with the browser's error name when it says more. */
export function describeError(e: unknown, fallback: string): string {
  if (typeof e === 'string') return e || fallback;
  const err = e as { name?: string; message?: string } | null;
  const msg = (err?.message ?? '').trim();
  if (!msg) return err?.name ? `${fallback} (${err.name})` : fallback;
  return err?.name && err.name !== 'Error' && !msg.includes(err.name) ? `${msg} (${err.name})` : msg;
}

/** The SDK's overrides for a session: the composed opener, plus a draft test's values that are present. */
export function sessionOverrides(session: TestSession) {
  const o = session.overrides;
  const tts = o ? Object.fromEntries(([['voiceId', o.voice_id], ['stability', o.stability], ['similarityBoost', o.similarity_boost], ['speed', o.speed]] as const).filter(([, v]) => v !== undefined)) : {};
  return {
    agent: {
      ...(session.first_message ? { firstMessage: session.first_message } : {}),
      ...(o ? { prompt: { prompt: o.prompt, ...(o.llm ? { llm: o.llm as never } : {}) } } : {}),
    },
    ...(Object.keys(tts).length ? { tts } : {}),
  };
}

/** `prime` is the mic and audio opened in the tap (primeAudio); without one, the mic is opened here. */
export async function startLiveCall(session: TestSession, ev: CallEvents, prime?: AudioPrime): Promise<CallHandle> {
  const own = prime ?? primeAudio();
  try {
    await own.ready;
  } catch (e) {
    own.release();
    throw e;
  }
  ev.onStatus('connecting');
  try {
    return await connect(session, ev);
  } finally {
    // The SDK has its own mic and audio running (or failed): this tap's copies are done.
    own.release();
  }
}

async function connect(session: TestSession, ev: CallEvents): Promise<CallHandle> {
  // The SDK otherwise loads its audio worklets from blob:/data: URLs and the
  // resampler from jsDelivr, which the CSP's script-src blocks ("Failed to load
  // the rawAudioProcessor worklet module"). Vite emits these files on our own
  // origin, which script-src 'self' allows. @elevenlabs/client 1.25.0 forgot to pass
  // libsampleratePath to the agent's audio output, so whenever the phone's audio rate
  // differs from the agent's (every iPhone, for most voices) it fetched the resampler from
  // jsDelivr and Safari refused the call with "Not allowed by CSP (SecurityError)";
  // patches/@elevenlabs__client@1.25.0.patch passes it on.
  const [{ Conversation }, rawAudioProcessor, audioConcatProcessor, libsamplerate] = await Promise.all([
    import('@elevenlabs/client'),
    import('@elevenlabs/client/worklets/rawAudioProcessor.js?url'),
    import('@elevenlabs/client/worklets/audioConcatProcessor.js?url'),
    import('@alexanderolsen/libsamplerate-js/dist/libsamplerate.worklet.js?url'),
  ]);
  let ended = false;
  const finish = () => { if (!ended) { ended = true; ev.onStatus('ended'); } };
  const convo = await Conversation.startSession({
    signedUrl: session.signed_url,
    workletPaths: { rawAudioProcessor: rawAudioProcessor.default, audioConcatProcessor: audioConcatProcessor.default },
    libsampleratePath: libsamplerate.default,
    dynamicVariables: session.dynamic_variables,
    // The browser has no initiation webhook, so the opener the function composed rides as an override,
    // and a draft test sends the draft's prompt, model and voice the same way (test_session allowed them).
    // Only fields test_session returned are sent: ElevenLabs drops a call that overrides one the agent does not allow.
    overrides: sessionOverrides(session),
    onConnect: () => ev.onStatus('connected'),
    // ElevenLabs refusing the session (an override the agent does not allow, a bad link) arrives as a
    // close with a reason; say it, instead of a call that just ends.
    onDisconnect: (d) => {
      if (d.reason === 'error') ev.onError(`ElevenLabs ended the call: ${d.closeReason || d.message || 'no reason given'}.`);
      else if (d.reason === 'agent' && d.closeReason && d.closeCode !== 1000) ev.onError(`ElevenLabs ended the call: ${d.closeReason}.`);
      finish();
    },
    onError: (message) => ev.onError(typeof message === 'string' && message ? message : 'The call hit an error.'),
    onModeChange: ({ mode }) => ev.onSpeaking(mode === 'speaking'),
    onMessage: ({ role, message }) => ev.onLine(role === 'user' ? 'user' : 'agent', message),
    onAgentToolRequest: (t) => ev.onTool(t.tool_name, 'start'),
    onAgentToolResponse: (t) => ev.onTool(t.tool_name, t.is_error ? 'error' : 'done'),
  });
  return {
    end: async () => { try { await convo.endSession(); } finally { finish(); } },
    setMuted: (m) => convo.setMicMuted(m),
    micLevel: () => { try { return convo.getInputVolume(); } catch { return 0; } },
    agentLevel: () => { try { return convo.getOutputVolume(); } catch { return 0; } },
    conversationId: () => { try { return convo.getId() || null; } catch { return null; } },
  };
}

/** /demo: the same events on a timer. No microphone, no network, no model. */
export function startDemoCall(session: TestSession, ev: CallEvents): CallHandle {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const t0 = Date.now();
  let muted = false;
  let alive = true;
  ev.onStatus('connecting');
  timers.push(setTimeout(() => ev.onStatus('connected'), 700));
  for (const step of DEMO_SCRIPT) {
    timers.push(setTimeout(() => {
      if (!alive) return;
      if (step.role === 'tool') {
        ev.onTool(step.text, 'start');
        timers.push(setTimeout(() => ev.onTool(step.text, 'done'), 900));
        return;
      }
      const text = step.role === 'agent' && !step.text ? session.first_message : step.text;
      if (step.role === 'agent') {
        ev.onSpeaking(true);
        timers.push(setTimeout(() => ev.onSpeaking(false), Math.min(4500, 900 + text.length * 32)));
      }
      ev.onLine(step.role, text);
    }, step.at));
  }
  const last = DEMO_SCRIPT[DEMO_SCRIPT.length - 1]!.at;
  timers.push(setTimeout(() => { if (alive) { alive = false; ev.onStatus('ended'); } }, last + 3500));
  const speakingAt = (t: number) => DEMO_SCRIPT.some((s) => s.role === 'agent' && t >= s.at && t < s.at + 3200);
  return {
    end: async () => { alive = false; timers.forEach(clearTimeout); ev.onStatus('ended'); },
    setMuted: (m) => { muted = m; },
    micLevel: () => {
      if (muted) return 0;
      const t = Date.now() - t0;
      const talking = DEMO_SCRIPT.some((s) => s.role === 'user' && t >= s.at && t < s.at + 2600);
      return talking ? 0.05 + 0.25 * Math.abs(Math.sin(t / 130)) : 0.004 * Math.abs(Math.sin(t / 400));
    },
    agentLevel: () => (speakingAt(Date.now() - t0) ? 0.05 + 0.2 * Math.abs(Math.sin(Date.now() / 110)) : 0),
    conversationId: () => 'conv_demo_test01',
  };
}
