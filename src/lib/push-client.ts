/** What this browser can do about phone notifications. Pure, so it is tested without a browser. */
export type PushEnv = {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  userAgent: string;
  maxTouchPoints: number;
  /** Running from the Home Screen icon (display-mode: standalone, or the old navigator.standalone). */
  standalone: boolean;
  permission: NotificationPermission | "none";
};

export type PushMode = "unsupported" | "ios_install" | "denied" | "ready";

/** iPhone and iPad (an iPad can call itself a Mac, with a touch screen). */
export function isIosDevice(env: Pick<PushEnv, "userAgent" | "maxTouchPoints">): boolean {
  return /iPhone|iPad|iPod/i.test(env.userAgent) || (/Macintosh/i.test(env.userAgent) && env.maxTouchPoints > 1);
}

/**
 * On iPhone, notifications only work from a Home Screen app: in Safari itself the push functions are missing, so the
 * screen must show the three steps rather than a button that cannot work. Everywhere else, no push support means "unsupported".
 */
export function pushMode(env: PushEnv): PushMode {
  if (isIosDevice(env) && !env.standalone) return "ios_install";
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return "unsupported";
  if (env.permission === "denied") return "denied";
  return "ready";
}

/** The browser wants the public key as bytes. */
export function keyToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
