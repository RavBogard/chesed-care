import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every route handler, page and server action under src/app must resolve the
 * viewer (getViewer, or a helper below that calls it) unless it is on the short
 * public allowlist. The Claude connector's entry points are accounted for one by
 * one: /api/mcp resolves the viewer from its bearer token (getConnectorViewer),
 * the two discovery documents are public and static, the consent page and its
 * action call getViewer, and the OAuth endpoints themselves are better-auth's,
 * under api/auth/[...all] (a closed list: tests/mcp-oauth.test.ts).
 */
const APP = "src/app";
const DISCOVERY = [
  ".well-known/oauth-authorization-server/[[...rest]]/route.ts",
  ".well-known/oauth-protected-resource/[[...rest]]/route.ts",
  "api/auth/.well-known/oauth-authorization-server/route.ts",
];
const PUBLIC = new Set(["api/health/route.ts", "api/auth/[...all]/route.ts", "not-authorised/page.tsx", "sign-in/page.tsx", ...DISCOVERY]);
/**
 * Mitzvah Meals' public side: no account, each entry point keyed by a secret link (src/server/meals).
 * Exactly one prefix is exempt from the viewer check, and the guard below holds everything under it
 * to the opposite rule: it never resolves a viewer and never renders the signed-in shell.
 */
const PUBLIC_PREFIX = "m/";
/** The public "Let the clergy know" form: no account either, and held to the same opposite rule. */
const TELL_PREFIX = "tell/";
/** Volunteer tasks' public side: no account, each entry point keyed by a secret link (src/server/volunteers). Held to the same opposite rule. */
const VOLUNTEER_PREFIX = "v/";
/** The Mitzvah Corps sign-up and its "stop asking me" link: no account either, held to the same opposite rule. */
const JOIN_PREFIX = "join/";
const PUBLIC_PREFIXES = [PUBLIC_PREFIX, TELL_PREFIX, VOLUNTEER_PREFIX, JOIN_PREFIX];
const inPublicPrefix = (r: string) => PUBLIC_PREFIXES.some((p) => r.startsWith(p));
/** The iPhone Shortcut endpoint: a personal capture token in the Authorization header, never a cookie, checked in src/server/care/shortcut.ts. */
const CAPTURE_ROUTE = "api/capture/route.ts";
/** The daily job: called only by Vercel's scheduler with the CRON_SECRET bearer, checked in src/server/daily/request.ts. */
const CRON_ROUTE = "api/cron/daily/route.ts";
/**
 * The demo build's front door, where a visitor chooses who to be (docs/DEMO.md): the demo's sign-in page, so it resolves no
 * viewer. The guard below holds both files to their own rule: each entry point refuses outside a demo build.
 */
const DEMO_ENTRY = ["demo/page.tsx", "demo/actions.ts", "demo/own/page.tsx"];
const isPublic = (r: string) => PUBLIC.has(r) || inPublicPrefix(r) || r === CAPTURE_ROUTE || r === CRON_ROUTE || DEMO_ENTRY.includes(r);
// Helpers that resolve the viewer themselves (getConnectorViewer: from a connector token, through the
// same allowlist resolution); add one here only when it really does.
const VIEWER_CALLS = /\b(getViewer|getConnectorViewer)\s*\(/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
}

const rel = (f: string) => relative(APP, f).split(sep).join("/");
const isPage = (r: string) => /(^|\/)page\.tsx?$/.test(r);
const isRoute = (r: string) => /(^|\/)route\.tsx?$/.test(r);
const isServerActions = (src: string) => /^\s*["']use server["']/.test(src);

/** The body of each exported function in a "use server" file. */
function exportedFunctions(src: string): { name: string; body: string }[] {
  const starts = [...src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)];
  return starts.map((m, i) => ({ name: m[1], body: src.slice(m.index, starts[i + 1]?.index ?? src.length) }));
}

describe("guard: every app entry point checks the viewer", () => {
  it("finds the entry points", () => {
    const all = files(APP).map(rel);
    expect(all).toContain("page.tsx");
    expect(all).toContain("actions.ts");
  });

  it("pages and route handlers call getViewer unless publicly allowlisted", () => {
    const missing = files(APP)
      .map((f) => ({ r: rel(f), src: readFileSync(f, "utf8") }))
      .filter(({ r }) => (isPage(r) || isRoute(r)) && !isPublic(r))
      .filter(({ src }) => !VIEWER_CALLS.test(src))
      .map(({ r }) => r);
    expect(missing).toEqual([]);
  });

  it("every exported server action calls getViewer", () => {
    const missing: string[] = [];
    for (const f of files(APP)) {
      const src = readFileSync(f, "utf8");
      if (inPublicPrefix(rel(f)) || DEMO_ENTRY.includes(rel(f))) continue;
      if (isServerActions(src)) {
        for (const fn of exportedFunctions(src)) if (!VIEWER_CALLS.test(fn.body)) missing.push(`${rel(f)}#${fn.name}`);
      } else if (/["']use server["']/.test(src) && !PUBLIC.has(rel(f)) && !VIEWER_CALLS.test(src)) {
        missing.push(`${rel(f)} (inline server action)`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the demo's front door does not exist outside a demo build", () => {
    const refuses = /if \(!isDemo\(\)\) notFound\(\);/;
    expect(refuses.test(readFileSync(join(APP, "demo/page.tsx"), "utf8"))).toBe(true);
    // "Make it your own" reads nothing and writes nothing; it too exists only in a demo build.
    const own = readFileSync(join(APP, "demo/own/page.tsx"), "utf8");
    expect(refuses.test(own)).toBe(true);
    expect(own).not.toMatch(/getDb|use server|cookies\(/);
    // What a visitor pastes names the guide, and the guide is in the repository at that path.
    const paste = readFileSync("src/lib/make-it-yours.ts", "utf8");
    expect(paste).toMatch(/\/main\/docs\/MAKE-IT-YOURS\.md/);
    expect(readFileSync("docs/MAKE-IT-YOURS.md", "utf8")).toMatch(/docs\/DEMO\.md/);
    const actions = exportedFunctions(readFileSync(join(APP, "demo/actions.ts"), "utf8"));
    expect(actions.map((a) => a.name)).toEqual(["unlockDemo", "enterDemo", "startDemoOver"]);
    for (const fn of actions) expect(refuses.test(fn.body), fn.name).toBe(true);
  });

  it("the public allowlist stays short and every entry exists", () => {
    const all = new Set(files(APP).map(rel));
    expect(PUBLIC.size).toBeLessThanOrEqual(7);
    for (const p of PUBLIC) expect(all.has(p), p).toBe(true);
  });

  it("the connector's entry points are exactly these, each with its own check", () => {
    const connector = files(APP)
      .map(rel)
      .filter((r) => r.startsWith("api/mcp/") || r.includes(".well-known/") || r.startsWith("oauth/"))
      .sort();
    expect(connector).toEqual([...DISCOVERY, "api/mcp/route.ts", "oauth/consent/actions.ts", "oauth/consent/page.tsx"].sort());
    const src = (r: string) => readFileSync(join(APP, r), "utf8");
    // The MCP endpoint authenticates with the connector token on every request, never a cookie.
    expect(src("api/mcp/route.ts")).toMatch(/await getConnectorViewer\(request\)/);
    expect(src("api/mcp/route.ts")).not.toMatch(/getViewer\(|cookies\(|headers\(\)/);
    // Discovery is static: no viewer, no database, no auth instance.
    for (const r of DISCOVERY) expect(src(r), r).not.toMatch(/getDb|getAuth|getViewer|cookies|authEnv/);
    // Consent is decided only by the signed-in, allowlisted person.
    expect(src("oauth/consent/page.tsx")).toMatch(/actorOrRedirect\(await getViewer\(\)\)/);
    expect(src("oauth/consent/actions.ts")).toMatch(/await getViewer\(\)/);
  });

  it("only the public prefixes are exempt, and nothing under them resolves a viewer or draws the signed-in shell", () => {
    const publicFiles = files(APP).map(rel).filter(inPublicPrefix);
    // The routes a helper or a family reaches, the one calendar route, and the one public form.
    expect(publicFiles.filter((r) => isPage(r) || isRoute(r)).sort()).toEqual(["m/[token]/page.tsx", "m/f/[token]/page.tsx", "m/s/[manageToken]/calendar.ics/route.ts", "m/s/[manageToken]/page.tsx", "join/page.tsx", "join/stop/[token]/page.tsx", "join/stop/s/[signed]/page.tsx", "tell/page.tsx", "v/[token]/page.tsx", "v/b/[token]/page.tsx", "v/c/[token]/calendar.ics/route.ts", "v/c/[token]/page.tsx", "v/s/[token]/page.tsx"].sort());
    for (const r of publicFiles) {
      const src = readFileSync(join(APP, r), "utf8");
      expect(src, r).not.toMatch(/getViewer|getConnectorViewer|actorOrRedirect|AppShell/);
    }
    // The page under settings with "tell" in its name is the signed-in sign, not the public form.
    expect(inPublicPrefix("settings/tell-sign/page.tsx")).toBe(false);
    expect(readFileSync(join(APP, "settings/tell-sign/page.tsx"), "utf8")).toMatch(/await getViewer\(\)/);
    // Every other entry point is still held to the viewer check: nothing outside the prefixes or the short list slips through.
    const exempt = files(APP).map(rel).filter((r) => (isPage(r) || isRoute(r)) && isPublic(r) && !inPublicPrefix(r) && r !== CAPTURE_ROUTE && r !== CRON_ROUTE);
    expect(exempt.sort()).toEqual([...PUBLIC, ...DEMO_ENTRY].filter((p) => isPage(p) || isRoute(p)).sort());
  });

  it("the public form's action file exports exactly one action, so a new export there fails here", () => {
    const src = readFileSync(join(APP, "tell/actions.ts"), "utf8");
    const exported = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g)].map((m) => m[1]);
    expect(exported).toEqual(["tellAction"]);
    expect(src).not.toMatch(/export\s*\{|export\s+default/);
  });

  it("the join form's action file exports exactly the sign-up and the stop action, and the signed-in roster pages are not public", () => {
    const src = readFileSync(join(APP, "join/actions.ts"), "utf8");
    const exported = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g)].map((m) => m[1]);
    expect(exported).toEqual(["joinAction", "stopAction"]);
    expect(src).not.toMatch(/export\s*\{|export\s+default|getViewer/);
    // The roster and its printable sign live under volunteers/, not join/: they resolve the viewer.
    for (const r of ["volunteers/roster/page.tsx", "volunteers/roster/sign/page.tsx", "roster-actions.ts"]) {
      expect(inPublicPrefix(r)).toBe(false);
      expect(readFileSync(join(APP, r), "utf8")).toMatch(/await getViewer\(\)/);
    }
    // The stop page changes nothing on a GET: it only reads, and its one button is a POST through stopAction.
    const stop = readFileSync(join(APP, "join/stop/[token]/page.tsx"), "utf8");
    expect(stop).toMatch(/stopLinkWorks/);
    expect(stop).not.toMatch(/stopAsking|stopAction/);
  });

  it("the Shortcut endpoint is bearer-token only: no cookie, no browser session, and it hands the request to the capture handler", () => {
    const src = readFileSync(join(APP, CAPTURE_ROUTE), "utf8");
    expect(src).toMatch(/await handleCapture\(/);
    expect(src).not.toMatch(/getViewer|cookies\(|getSession|getAuth/);
    // It is the only route under api/capture.
    expect(files(APP).map(rel).filter((r) => r.startsWith("api/capture/"))).toEqual([CAPTURE_ROUTE]);
  });

  it("the notification worker /sw.js is a static public file: not a route, no viewer, nothing secret, and it never calls the server", () => {
    // It is served from public/, outside src/app, so no page or route handler exists for it to be checked against.
    expect(files(APP).map(rel).filter((r) => /(^|\/)sw(\.|\/)/.test(r))).toEqual([]);
    const src = readFileSync("public/sw.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/getViewer|getConnectorViewer|cookies|getSession|getAuth|process\.env|authorization/i);
    expect(src).not.toMatch(/VAPID|PRIVATE|secret|token|apikey|https?:\/\//i);
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|importScripts/);
  });

  it("the daily job is scheduler-only: the CRON_SECRET check, no cookie or viewer, and the only route under api/cron", () => {
    const src = readFileSync(join(APP, CRON_ROUTE), "utf8");
    expect(src).toMatch(/await handleDailyRequest\(\{ authorization: request\.headers\.get\("authorization"\), secret: process\.env\.CRON_SECRET/);
    expect(src).not.toMatch(/getViewer|cookies\(|getSession|getAuth/);
    expect(files(APP).map(rel).filter((r) => r.startsWith("api/cron/"))).toEqual([CRON_ROUTE]);
    // The schedule calls it once a day, early morning in St. Louis.
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as { schedules?: Record<string, { path?: string; schedule?: string; timezone?: string }>; crons?: unknown };
    expect(Object.values(vercel.schedules ?? {})).toEqual([{ schedule: "0 6 * * *", timezone: "America/Chicago", path: "/api/cron/daily", requestMethod: "POST" }]);
    expect(vercel.crons).toBeUndefined();
  });
});
