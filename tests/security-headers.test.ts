import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { proxy } from "@/proxy";
import { buildCsp } from "@/server/security/csp";

function directives(csp: string): Map<string, string[]> {
  return new Map(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
}

describe("security headers", () => {
  it("the production CSP is strict: nonce scripts, no eval, no inline, no framing, forms to self only", () => {
    const d = directives(buildCsp("abc123", false));
    expect(d.get("script-src")).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(d.get("style-src")).toEqual(["'self'", "'nonce-abc123'"]);
    expect(d.get("form-action")).toEqual(["'self'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    expect(buildCsp("abc123", false)).not.toMatch(/unsafe-eval|unsafe-inline/);
    // `next dev` only: React's overlay needs eval.
    expect(buildCsp("abc123", true)).toContain("'unsafe-eval'");
  });

  it("only the connector's consent page may send a form on to Claude's callback or a loopback client", () => {
    const formAction = (path: string) => directives(proxy(new NextRequest(`http://localhost:3000${path}`)).headers.get("Content-Security-Policy")!).get("form-action");
    expect(formAction("/oauth/consent?client_id=x")).toEqual(["'self'", "https://claude.ai", "https://claude.com", "http://localhost:*", "http://127.0.0.1:*"]);
    for (const path of ["/", "/sign-in", "/oauth", "/oauth/consent/other", "/people/003000000000001AAA", "/api/mcp", "/settings"]) expect(formAction(path), path).toEqual(["'self'"]);
  });

  it("the proxy sends a fresh nonce per request, in the response CSP and to the renderer", () => {
    const a = proxy(new NextRequest("http://localhost:3000/"));
    const b = proxy(new NextRequest("http://localhost:3000/"));
    const csp = a.headers.get("Content-Security-Policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(b.headers.get("Content-Security-Policy")).not.toBe(csp);
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
  });

  it("next.config sends a Permissions-Policy that disables camera, microphone, geolocation and payment", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!.headers;
    const pp = all.find((h) => h.key === "Permissions-Policy")?.value ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) expect(pp).toContain(`${feature}=()`);
    expect(all.find((h) => h.key === "X-Frame-Options")?.value).toBe("DENY");
  });
});
