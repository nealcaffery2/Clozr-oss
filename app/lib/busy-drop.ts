// The voicemail this browser plays when Drop VM is tapped, and when a second
// person answers while the rep is already talking. A signed URL only lasts a
// couple of minutes, so the dialer refreshes it (useArmBusyDrop).

export type ArmedDrop = {
  clipId: number;
  name: string;
  /** Written script. Empty when the rep recorded without typing one. */
  script: string;
  url: string;
  /** Epoch ms. After this the URL is treated as expired. */
  urlUntil: number;
};

let armed: ArmedDrop | null = null;

export function armDrop(next: ArmedDrop | null): void {
  armed = next;
}

export function readyDrop(): ArmedDrop | null {
  if (!armed || armed.urlUntil <= Date.now()) return null;
  return armed;
}

export function readyDropUrl(): string | null {
  return readyDrop()?.url ?? null;
}

export function readyDropScript(): string {
  return armed?.script ?? '';
}
