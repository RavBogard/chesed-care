/**
 * The Content-Security-Policy for every page, built per request with a fresh
 * nonce (src/proxy.ts). Next.js reads the nonce from this header while rendering
 * and puts it on its own scripts and inline styles, so neither scripts nor styles
 * need 'unsafe-inline', and production never allows 'unsafe-eval' (React needs it
 * only in `next dev`, for its error overlay).
 *
 * form-action 'self' is enough for Google sign-in: the button calls the auth API
 * with fetch and then navigates to accounts.google.com (a navigation, which
 * form-action does not govern), and Google returns with a GET to our callback.
 *
 * One page needs more: the connector's consent form answers with a redirect to
 * the client's redirect URI, and browsers hold a form's redirects to form-action.
 * Phone notifications register /sw.js, so worker-src names 'self' explicitly. The file itself is served by next.config.ts with its own
 * strict policy, and the proxy skips it (it is a static file: no HTML, no nonce).
 *
 * The proxy passes those few sources (`formActionExtra`) for that page only.
 */
export function buildCsp(nonce: string, isDev: boolean, formActionExtra: readonly string[] = []): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    // The notification worker (public/sw.js, root scope). Without this the worker falls back to script-src, where 'strict-dynamic' ignores 'self'.
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    ["form-action 'self'", ...formActionExtra].join(" "),
    "frame-ancestors 'none'",
  ].join("; ");
}

export function newNonce(): string {
  return btoa(crypto.randomUUID());
}
