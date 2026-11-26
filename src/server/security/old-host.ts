/**
 * The app's old address, crc-care.vercel.app, sends people to the congregation's own address.
 * Pure, so the rule can be tested on its own; src/proxy.ts applies it.
 *
 * Not redirected, because they are registered against the old address and must keep working
 * there: the sign-in callbacks, the connector (MCP and its OAuth pages and discovery files)
 * and the daily schedule. Preview deployments have other hosts and are never redirected.
 */
export const OLD_HOST = "crc-care.vercel.app";
export const NEW_ORIGIN = "https://care.centralreform.org";

const KEPT_ON_OLD_HOST = [/^\/api\/auth(\/|$)/, /^\/api\/mcp/, /^\/oauth(\/|$)/, /^\/\.well-known(\/|$)/, /^\/api\/cron(\/|$)/];

/** Where this request should be sent (a 308), or null to serve it where it is. */
export function oldHostRedirect(host: string | null | undefined, pathname: string, search = ""): string | null {
  if (!host) return null;
  if (host.trim().toLowerCase().replace(/:\d+$/, "") !== OLD_HOST) return null;
  const path = pathname.toLowerCase();
  if (KEPT_ON_OLD_HOST.some((re) => re.test(path))) return null;
  return `${NEW_ORIGIN}${pathname}${search}`;
}
