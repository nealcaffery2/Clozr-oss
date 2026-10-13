/**
 * Desktop notifications — the visual half of an alert.
 *
 * CLOZR already tells a rep something happened by playing a tone
 * (lib/phone-audio.ts). That only works if they can hear it, and reps live in
 * another tab: the CRM is open behind Podio, a dialer, a spreadsheet. A tone
 * fired at a background tab is a tone nobody connects to anything.
 *
 * So every `playEvent` also raises one of these, when the rep has switched
 * them on. They ride the existing per-event toggles rather than growing a
 * second set: a rep who silenced "call ended" meant it, and a toast is louder
 * than the tone they turned off.
 *
 * Deliberately the *local* Notification API, not Web Push. This reaches a rep
 * whose CLOZR tab is open but not in front — the case that actually loses
 * texts today — and needs no service worker, no VAPID keys and no server,
 * which matters because CLOZR is a static export. Reaching a rep who has
 * closed CLOZR entirely is Web Push, and a separate piece of work.
 */

export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

/** Not every context has it: Safari in a private window, an insecure origin, SSR. */
export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermissionState {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission as NotificationPermissionState;
}

/**
 * Ask the browser. Must be called from a user gesture — Chrome ignores (and
 * Firefox rejects) a prompt raised on page load, and a denial is sticky, so
 * asking at the wrong moment burns the only chance to ask at all. That is why
 * the toggle in Settings is the only caller.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return (await Notification.requestPermission()) as NotificationPermissionState;
  } catch {
    // Older Safari takes a callback instead of returning a promise; treat a
    // throw as "no decision", which leaves the toggle off and honest.
    return notificationPermission();
  }
}

/** True when the rep is already looking at CLOZR, so a toast would be noise. */
function looking(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
}

export interface DesktopNotice {
  title: string;
  body?: string;
  /** Repeats of the same tag replace rather than stack — five texts, one toast. */
  tag?: string;
}

/**
 * Show one, if it is wanted and allowed. Silent about every reason it might
 * not appear: a caller fires this alongside a tone it cannot control either,
 * and a notification that fails is never worth an error in a rep's face.
 */
export function showDesktopNotification(notice: DesktopNotice): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(notice.title, {
      body: notice.body,
      tag: notice.tag,
      icon: '/favicon.svg',
      // A focused tab already plays the in-page tone. In the background that
      // tone is often blocked, so the operating system sound is the one heard.
      silent: looking(),
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* a browser that will not focus on click is still a notification shown */
      }
      n.close();
    };
  } catch {
    /* quota, an origin that lost permission mid-session, a headless context */
  }
}
