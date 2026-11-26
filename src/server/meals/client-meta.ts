/**
 * What the public routes pass to the meal functions as `clientMeta`, built ONLY from
 * things the client cannot choose:
 *  - clientKey: the address the hosting platform reports (Vercel sets
 *    x-vercel-forwarded-for itself and overwrites any client value; x-real-ip is the
 *    fallback). The general x-forwarded-for is never read: a client can write it. An
 *    IPv6 address collapses to its /64 (a home or phone holds a whole /64), an
 *    IPv4-mapped one to its IPv4. The result is keyed-hashed here, so the address
 *    itself goes no further than this file.
 *  - elapsedMs: how long ago THE SERVER rendered the form, read from a stamp the
 *    server signed (HMAC) when it rendered it. A missing, altered, future-dated or
 *    day-old stamp gives null, never a number the client chose.
 *  - honeypot: the hidden field as submitted.
 * Nothing is logged. The signing key is derived from the app's auth secret.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { ClientMeta } from "./input";

/** A stamp older than this is treated as missing: the form is reloaded. */
export const STAMP_MAX_AGE_MS = 4 * 3_600_000;
/** Clock slack between two servers rendering and receiving. */
const SKEW_MS = 5_000;

function secretKey(secret = process.env.BETTER_AUTH_SECRET): Buffer {
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not configured");
  return createHmac("sha256", secret).update("mitzvah-meals/form-stamp/v1").digest();
}

const sign = (key: Buffer, purpose: string, payload: string) => createHmac("sha256", key).update(`${purpose}|${payload}`).digest("base64url");

/** A keyed, URL-safe signature of `payload` for one `purpose` (the same keyed HMAC the render stamp uses). Used by signed links and keyed hashes. */
export function signFor(purpose: string, payload: string, secret?: string): string {
  return sign(secretKey(secret), purpose, payload);
}

/** A signed render time for a form. `scope` ties it to one page (any string, e.g. the link's token). */
export function signRenderStamp(scope: string, now: Date, secret?: string): string {
  const at = String(now.getTime());
  return `${at}.${sign(secretKey(secret), `stamp:${scope}`, at)}`;
}

/** Milliseconds since the server rendered the form, or null when the stamp is missing, forged, from the future or too old. */
export function elapsedSinceStamp(stamp: unknown, scope: string, now: Date, secret?: string): number | null {
  if (typeof stamp !== "string" || stamp.length > 100) return null;
  const [at, mac, ...rest] = stamp.split(".");
  if (!at || !mac || rest.length || !/^\d{10,16}$/.test(at)) return null;
  const expected = Buffer.from(sign(secretKey(secret), `stamp:${scope}`, at));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const elapsed = now.getTime() - Number(at);
  if (elapsed < -SKEW_MS || elapsed > STAMP_MAX_AGE_MS) return null;
  return Math.max(0, elapsed);
}

/** Expand any valid IPv6 text to its eight 16-bit groups, or null. */
function groupsOf(address: string): number[] | null {
  let text = address;
  const tail = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = tail[2].split(".").map(Number);
    text = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - back.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array<string>(fill).fill("0"), ...back].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

/** PURE. The client a platform-reported address stands for: an IPv4 address as itself, an IPv6 address as its /64. Null when it is not an address. */
export function networkOf(raw: string): string | null {
  const address = raw.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const kind = isIP(address);
  if (kind === 4) return `v4:${address}`;
  if (kind !== 6) return null;
  const g = groupsOf(address);
  if (!g) return null;
  // ::ffff:a.b.c.d is an IPv4 client reaching us over IPv6.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `v4:${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `v6:${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
}

/** The address the platform reports for this request: never x-forwarded-for. Null when there is none we can trust. */
export function platformAddress(headers: Pick<Headers, "get">): string | null {
  for (const name of ["x-vercel-forwarded-for", "x-real-ip"]) {
    const first = headers.get(name)?.split(",")[0];
    const found = first ? networkOf(first) : null;
    if (found) return found;
  }
  // Off the platform (local development) there is no such header; production always has one.
  return process.env.NODE_ENV === "production" ? null : "v4:127.0.0.1";
}

/** The clientMeta for a meal function, or null when the request carries no address the platform vouches for. `timed`: also read the signed stamp (a sign-up). */
export function buildClientMeta(input: { headers: Pick<Headers, "get">; stamp?: unknown; scope: string; honeypot?: unknown; now?: Date; secret?: string }): ClientMeta | null {
  const now = input.now ?? new Date();
  const network = platformAddress(input.headers);
  if (!network) return null;
  const elapsed = input.stamp === undefined ? null : elapsedSinceStamp(input.stamp, input.scope, now, input.secret);
  return {
    clientKey: createHmac("sha256", secretKey(input.secret)).update(`client|${network}`).digest("base64url"),
    honeypot: typeof input.honeypot === "string" ? input.honeypot.slice(0, 2000) : "",
    elapsedMs: elapsed,
  };
}
