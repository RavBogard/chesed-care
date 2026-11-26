/**
 * The demo's optional access code. With DEMO_ACCESS_CODE set, a visitor types the code once before
 * choosing who to be; it keeps strangers and bots who only have the address out of the shared
 * sandbox. It is a courtesy lock, not a secret worth protecting: everything behind it is invented.
 * The cookie holds a digest of the code and the server's secret, never the code.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const DEMO_GATE_COOKIE = "demo_gate";

type Env = Record<string, string | undefined>;
const normal = (v: string) => v.trim().toLowerCase();
const digest = (v: string) => createHash("sha256").update(v).digest();

/** The code visitors must type, or null when the demo is open to anyone with the address. */
export function demoAccessCode(env: Env = process.env): string | null {
  const code = normal(env.DEMO_ACCESS_CODE ?? "");
  return code || null;
}

/** What the cookie holds once the right code has been typed. Changing the code or the secret locks everyone out again. */
export function demoGateToken(env: Env = process.env): string | null {
  const code = demoAccessCode(env);
  return code ? digest(`${code}:${env.BETTER_AUTH_SECRET ?? ""}`).toString("hex") : null;
}

/** Whether what a visitor typed is the code. Spaces around it and capitals do not matter. */
export function demoCodeMatches(typed: unknown, env: Env = process.env): boolean {
  const code = demoAccessCode(env);
  if (!code) return true;
  return typeof typed === "string" && typed.length <= 200 && timingSafeEqual(digest(normal(typed)), digest(code));
}

/** Whether a visitor with this cookie value may come in: always, when no code is set. */
export function demoGateOpen(cookie: string | undefined, env: Env = process.env): boolean {
  const token = demoGateToken(env);
  if (!token) return true;
  return typeof cookie === "string" && cookie.length === token.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(token));
}
