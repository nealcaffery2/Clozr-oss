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

/** Ask for the mic first so a refusal reads as "allow the microphone" and not as a dropped connection. */
async function openMic(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open a microphone here. Use https and a current browser.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    throw new Error(MIC_MESSAGES[micProblem(err)]);
  }
}

export async function startLiveCall(session: TestSession, ev: CallEvents): Promise<CallHandle> {
  await openMic();
  ev.onStatus('connecting');
  // The SDK otherwise loads its audio worklets from blob:/data: URLs and the
  // resampler from jsDelivr, which the CSP's script-src blocks ("Failed to load
  // the rawAudioProcessor worklet module"). Vite emits these files on our own
  // origin, which script-src 'self' allows.
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
    // The browser has no initiation webhook, so the opener the function composed rides as an override.
    ...(session.first_message ? { overrides: { agent: { firstMessage: session.first_message } } } : {}),
    onConnect: () => ev.onStatus('connected'),
    onDisconnect: finish,
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
