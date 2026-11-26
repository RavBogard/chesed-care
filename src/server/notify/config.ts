/**
 * Whether phone notifications are set up: three environment variables. With any missing, push is "not
 * configured" everywhere and nothing is sent. Reports variable NAMES only, never a value.
 */
export const VAPID_VARS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
type Env = Record<string, string | undefined>;

export type PushStatus = { configured: boolean; missing: string[] };

export function pushStatus(env: Env = process.env): PushStatus {
  const missing: string[] = VAPID_VARS.filter((name) => !env[name]?.trim());
  // The subject must be a mailto: address (or an https URL): a malformed one is as good as missing.
  const subject = env.VAPID_SUBJECT?.trim();
  if (subject && !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) missing.push("VAPID_SUBJECT");
  const unique = [...new Set(missing)];
  return { configured: unique.length === 0, missing: unique };
}

export type VapidDetails = { subject: string; publicKey: string; privateKey: string };

/** The signing details, or null when not configured. Server only: the private key never leaves this process. */
export function vapidDetails(env: Env = process.env): VapidDetails | null {
  if (!pushStatus(env).configured) return null;
  return { subject: env.VAPID_SUBJECT!.trim(), publicKey: env.VAPID_PUBLIC_KEY!.trim(), privateKey: env.VAPID_PRIVATE_KEY!.trim() };
}

/** The public half, which the browser needs to subscribe. Null when not configured. */
export function publicVapidKey(env: Env = process.env): string | null {
  return vapidDetails(env)?.publicKey ?? null;
}
