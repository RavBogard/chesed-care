/**
 * Whether outbound email is on. It needs RESEND_API_KEY, and it is on only in the production deployment
 * (VERCEL_ENV=production) or where CARE_EMAIL=on says so; CARE_EMAIL=off always wins. Previews, local work and tests are
 * off. Reports variable NAMES only, never a value.
 */
type Env = Record<string, string | undefined>;

export type EmailStatus = { configured: boolean; missing: string[] };

export function emailStatus(env: Env = process.env): EmailStatus {
  const missing: string[] = [];
  if (!env.RESEND_API_KEY?.trim()) missing.push("RESEND_API_KEY");
  const flag = env.CARE_EMAIL?.trim().toLowerCase();
  const allowed = flag !== "off" && (flag === "on" || env.VERCEL_ENV === "production");
  if (!allowed) missing.push("CARE_EMAIL");
  // The demo build never sends mail, whatever else is set.
  if (env.NEXT_PUBLIC_CARE_DEMO === "on") missing.push("NEXT_PUBLIC_CARE_DEMO");
  return { configured: missing.length === 0, missing };
}
