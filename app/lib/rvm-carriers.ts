/**
 * Ringless voicemail, the way Drop Cowboy and Slybroadcast actually take it.
 *
 * Both networks deposit the audio in the mailbox. The handset does not ring.
 * Drop Cowboy wants a team, a registered brand, and either a Mimic voice plus
 * the script or an mp3/wav URL. Slybroadcast wants the account email and
 * password and an mp3, wav, or m4a URL. A browser webm recording fits neither,
 * so the caller falls through to a Telnyx machine-detect call.
 */

export type CarrierAudio = 'mp3' | 'wav' | 'm4a';

export function audioKind(path: string | null | undefined): CarrierAudio | null {
  const ext = (path ?? '').split('?')[0]?.split('.').pop()?.toLowerCase();
  if (ext === 'mp3' || ext === 'wav' || ext === 'm4a') return ext;
  return null;
}

function digits(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 10) return `1${d}`;
  return d;
}

export function dropCowboyPayload(input: {
  teamId: string;
  secret: string;
  brandId: string;
  phone: string;
  dropId: number;
  callbackUrl: string;
  forwardingNumber?: string | null;
  postalCode?: string | null;
  script?: string | null;
  voiceId?: string | null;
  audioUrl?: string | null;
  audioType?: CarrierAudio | null;
}): Record<string, string> | null {
  const phone = digits(input.phone);
  if (phone.length < 11) return null;
  const body: Record<string, string> = {
    team_id: input.teamId,
    secret: input.secret,
    foreign_id: String(input.dropId),
    brand_id: input.brandId,
    phone_number: phone,
    callback_url: input.callbackUrl,
  };
  const forward = digits(input.forwardingNumber);
  if (forward.length >= 11) body.forwarding_number = forward;
  const zip = (input.postalCode ?? '').replace(/\s/g, '');
  if (zip) body.postal_code = zip;
  if (input.voiceId && input.script?.trim()) {
    body.voice_id = input.voiceId;
    body.tts_body = input.script.trim().slice(0, 4500);
    return body;
  }
  if (input.audioUrl && (input.audioType === 'mp3' || input.audioType === 'wav')) {
    body.audio_url = input.audioUrl;
    body.audio_type = input.audioType;
    return body;
  }
  return null;
}

/** Ten-digit US form Slybroadcast's examples use. */
function tenDigits(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return null;
}

export function slybroadcastFields(input: {
  uid: string;
  password: string;
  phone: string;
  callerId: string;
  audioUrl: string;
  audioType: CarrierAudio;
  /** Where Slybroadcast posts the per-call disposition. They require the reply `OK`. */
  callbackUrl?: string | null;
}): Record<string, string> | null {
  const phone = tenDigits(input.phone);
  const caller = tenDigits(input.callerId);
  if (!phone || !caller || !input.uid || !input.password) return null;
  const fields: Record<string, string> = {
    c_uid: input.uid,
    c_password: input.password,
    c_method: 'new_campaign',
    c_phone: phone,
    c_callerID: caller,
    c_url: input.audioUrl,
    c_audio: input.audioType,
  };
  if (input.callbackUrl) fields.c_dispo_url = input.callbackUrl;
  return fields;
}

/** A delivery receipt. The send itself only means the network accepted the job. */
export function receiptOutcome(body: Record<string, unknown>): 'dropped' | 'failed' | 'pending' {
  const status = String(
    body.status ?? body.delivery_status ?? body.result ?? body.event ?? body.state ?? body.new_campaign ?? '',
  ).toLowerCase();
  const error = String(body.error ?? body.ERROR ?? body.reason ?? '').toLowerCase();
  if (error && error !== 'null' && error !== 'undefined') return 'failed';
  if (/fail|undeliver|invalid|reject|error|not[_\s-]?sent/.test(status)) return 'failed';
  if (/(^|[^a-z])(delivered|deliver|success|completed|complete|sent|ok)([^a-z]|$)/.test(status)) return 'dropped';
  return 'pending';
}
