/**
 * The volunteer device cookie: one opaque random id. PURE, so the options chosen for each environment are tested
 * directly. In production it is a `__Host-` cookie: browsers accept that prefix only with Secure, path "/" and NO Domain,
 * and only from the host itself, so a sibling subdomain cannot plant a value. Elsewhere (local http) it keeps a plain
 * name. Only the current environment's name is ever read; the other is ignored.
 */
export const REF_COOKIE_DAYS = 180;

export function refCookie(env: string | undefined): { name: string; options: { httpOnly: true; sameSite: "lax"; secure: boolean; path: string; maxAge: number } } {
  const production = env === "production";
  return {
    name: production ? "__Host-crc_vol_ref" : "crc_vol_ref",
    options: { httpOnly: true, sameSite: "lax", secure: production, path: production ? "/" : "/v", maxAge: REF_COOKIE_DAYS * 86_400 },
  };
}
