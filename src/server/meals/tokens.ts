/**
 * The secret links of Mitzvah Meals. A token is 192 bits from the system's random
 * source, URL-safe. Every look-up is by the SHA-256 of what was presented, so the
 * database never compares a secret byte by byte with an attacker's guess and a
 * wrong token costs the same single indexed read as a right one. Public and family
 * tokens are also stored as given (organisers re-share them); a helper's manage
 * token is stored only as its hash.
 */
import { createHash, randomBytes } from "node:crypto";

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The look-up key for whatever was presented. Never throws: anything that is not a plausible token hashes to a key no row has. */
export function tokenHash(presented: unknown): string {
  const value = typeof presented === "string" && presented.length <= 128 ? presented : "";
  return createHash("sha256").update(value).digest("base64url");
}
