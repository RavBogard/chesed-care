import { NextResponse, type NextRequest } from "next/server";
import { isDemo } from "@/lib/demo";
import { CONSENT_FORM_ACTION, CONSENT_PATH } from "@/server/mcp/oauth-policy";
import { buildCsp, newNonce } from "@/server/security/csp";
import { oldHostRedirect } from "@/server/security/old-host";

const DEMO_ABSENT = /^\/(?:api\/(?:auth|mcp|capture)|oauth|\.well-known)(?:\/|$)/;

/** A per-request nonce and the strict CSP that carries it (see src/server/security/csp.ts). */
export function proxy(request: NextRequest) {
  // The old address goes to the congregation's own (sign-in, connector and schedule paths stay put).
  const moved = oldHostRedirect(request.headers.get("host"), request.nextUrl.pathname, request.nextUrl.search);
  if (moved) return NextResponse.redirect(moved, 308);
  // The demo build has no sign-in and no connector: those addresses do not exist there.
  if (isDemo() && DEMO_ABSENT.test(request.nextUrl.pathname)) return new NextResponse(null, { status: 404 });
  const nonce = newNonce();
  // Only the connector's consent page may submit a form that redirects to Claude (see csp.ts).
  const formActionExtra = request.nextUrl.pathname === CONSENT_PATH ? CONSENT_FORM_ACTION : [];
  const csp = buildCsp(nonce, process.env.NODE_ENV === "development", formActionExtra);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Every page and route except build assets (they carry no HTML) and the notification worker, a static file that next.config.ts gives its own headers.
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|sw\\.js$).*)" }],
};
