import { readFileSync } from "node:fs";
import vm from "node:vm";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";
import { config as proxyConfig, proxy } from "@/proxy";
import { NOTICE_KINDS, NOTICE_TITLE, renderNotice, safeTarget } from "@/lib/notice";
import { buildCsp } from "@/server/security/csp";

type Shown = { title: string; body: string; tag: string };
type Worker = { noticeFor: (p: unknown) => Shown; safeTarget: (p: unknown, origin: string) => string; TEMPLATES: Record<string, unknown> };
type Handler = (event: Record<string, unknown>) => void;
const ORIGIN = "https://care.example";

/** public/sw.js run in a sandbox with a fake worker scope, so its handlers can be driven without a browser. */
function loadWorker(windows: { url: string; focused?: string[]; navigated?: string[] }[] = []) {
  const handlers: Record<string, Handler> = {};
  const shown: { title: string; options: { body: string; tag: string; data: { path: string } } }[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Handler) => (handlers[type] = fn),
    skipWaiting: () => undefined,
    registration: { showNotification: (title: string, options: { body: string; tag: string; data: { path: string } }) => { shown.push({ title, options }); return Promise.resolve(); } },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () =>
        Promise.resolve(
          windows.map((w) => ({
            url: w.url,
            focus: () => {
              w.focused?.push(w.url);
              return Promise.resolve({ navigate: (to: string) => { w.navigated?.push(to); return Promise.resolve(); } });
            },
          })),
        ),
      openWindow: (to: string) => { opened.push(to); return Promise.resolve(); },
    },
  };
  const sandboxModule = { exports: {} as Worker };
  vm.runInNewContext(readFileSync("public/sw.js", "utf8"), { self, module: sandboxModule, URL, Object, Math, isFinite, Number, console: undefined });
  return { sw: sandboxModule.exports, handlers, shown, opened };
}

const { sw } = loadWorker();
const wait = async (events: Promise<unknown>[]) => Promise.all(events);
const run = (handler: Handler, extra: Record<string, unknown>) => {
  const pending: Promise<unknown>[] = [];
  handler({ ...extra, waitUntil: (p: Promise<unknown>) => pending.push(p) });
  return wait(pending);
};

describe("the service worker's own copy of the sentences", () => {
  it("matches the server's table for every kind and a range of counts", () => {
    expect(Object.keys(sw.TEMPLATES).sort()).toEqual([...NOTICE_KINDS].sort());
    for (const kind of NOTICE_KINDS) {
      for (const count of [0, 1, 2, 7, 120, 999]) {
        expect(sw.noticeFor({ kind, count }), `${kind} ${count}`).toEqual(renderNotice({ kind, count }));
      }
      expect(sw.noticeFor({ kind }), kind).toEqual(renderNotice({ kind }));
    }
  });

  it("never shows words from a payload: unknown kinds and extra fields get the fixed sentence", () => {
    const odd = sw.noticeFor({ kind: "assigned", title: "Ruth Cohen", body: "She is frightened", name: "Ruth" });
    expect(odd).toEqual(renderNotice({ kind: "assigned" }));
    for (const payload of [null, undefined, {}, { kind: "__proto__" }, { kind: "constructor" }, { kind: "toString" }, { kind: 7 }, { kind: "pastoral", body: "Ruth Cohen" }]) {
      const shown = sw.noticeFor(payload);
      expect(shown.title).toBe(NOTICE_TITLE);
      expect(shown.body).toBe("There is something new in CRC Care.");
    }
    // A count that is not a whole number shows as 0, never as the text it was.
    expect(sw.noticeFor({ kind: "new_inbox", count: "Ruth Cohen" }).body).toBe("0 new in your Inbox.");
    expect(sw.noticeFor({ kind: "new_inbox", count: 1e9 }).body).toBe("999 new in your Inbox.");
  });

  it("opens a same-origin path only, exactly as the server's pure function does", () => {
    const cases: unknown[] = ["/inbox", "/volunteers?x=1", "/", "https://evil.example/inbox", "//evil.example", "/\\evil.example", "javascript:alert(1)", "inbox", "", null, undefined, 5, {}, "/a/b?c=d#e"];
    for (const path of cases) expect(sw.safeTarget(path, ORIGIN), String(path)).toBe(safeTarget(path, ORIGIN));
    // Dot segments and escapes the browser normalises into a protocol-relative address, in BOTH copies.
    for (const sneaky of ["/.//evil.com", "/x/..//evil.com", "/%2e//evil.com", "//evil.com", "/\\evil.com", "/%2E/%2e//evil.com", "/./\\evil.com"]) {
      expect(sw.safeTarget(sneaky, ORIGIN), sneaky).toBe("/");
      expect(safeTarget(sneaky, ORIGIN), sneaky).toBe("/");
    }
    expect(sw.safeTarget("/a/./b", ORIGIN)).toBe("/a/b");
    expect(sw.safeTarget("https://evil.example/inbox", ORIGIN)).toBe("/");
    expect(sw.safeTarget("//evil.example/x", ORIGIN)).toBe("/");
  });

  it("shows the notification from kind and count, and carries a safe path to the tap", async () => {
    const w = loadWorker();
    await run(w.handlers.push, { data: { json: () => ({ kind: "volunteer_asks", count: 3, path: "/volunteers", title: "Ruth Cohen", body: "free words" }) } });
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe("CRC Care");
    expect(w.shown[0].options).toMatchObject({ body: "3 asks still need someone.", tag: "volunteer", data: { path: "/volunteers" } });
    // A payload that cannot be read still shows the plain fallback (a phone that gets a silent push can revoke the subscription).
    await run(w.handlers.push, { data: { json: () => { throw new SyntaxError("bad"); } } });
    expect(w.shown[1].options.body).toBe("There is something new in CRC Care.");
    expect(w.shown[1].options.data.path).toBe("/");
    // A foreign path in the payload is dropped before it is ever stored on the notification.
    await run(w.handlers.push, { data: { json: () => ({ kind: "assigned", path: "https://evil.example/x" }) } });
    expect(w.shown[2].options.data.path).toBe("/");
  });

  it("on a tap, focuses an open app window and goes to the path; opens a window when none is open; refuses another origin", async () => {
    const tap = (path: unknown) => ({ notification: { close: () => undefined, data: { path } } });
    const open = { url: `${ORIGIN}/care`, focused: [] as string[], navigated: [] as string[] };
    const w = loadWorker([open]);
    await run(w.handlers.notificationclick, tap("/inbox"));
    expect(open.focused).toHaveLength(1);
    expect(open.navigated).toEqual(["/inbox"]);
    expect(w.opened).toEqual([]);
    // An open window of ANOTHER site is never used.
    const foreign = { url: "https://evil.example/", focused: [] as string[], navigated: [] as string[] };
    const w2 = loadWorker([foreign]);
    await run(w2.handlers.notificationclick, tap("/inbox"));
    expect(foreign.focused).toEqual([]);
    expect(w2.opened).toEqual(["/inbox"]);
    // A path that is not the app's own becomes the home page, in both cases.
    for (const bad of ["https://evil.example/phish", "//evil.example", "javascript:alert(1)", undefined]) {
      const w3 = loadWorker([]);
      await run(w3.handlers.notificationclick, tap(bad));
      expect(w3.opened, String(bad)).toEqual(["/"]);
    }
  });

  it("is a plain static file: no caching, no fetch handling, no secret, no viewer", () => {
    const src = readFileSync("public/sw.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(src).not.toMatch(/\bcaches\b|CacheStorage|importScripts|\bfetch\(|XMLHttpRequest|indexedDB|localStorage/);
    expect(src).not.toMatch(/getViewer|cookies|process\.env|VAPID|PRIVATE|secret|token|https?:\/\//i);
    for (const event of ["push", "notificationclick"]) expect(src).toContain(`addEventListener("${event}"`);
  });
});

describe("served under the strict policy", () => {
  const directive = (csp: string, name: string) => csp.split(";").map((d) => d.trim().split(/\s+/)).find(([n]) => n === name)?.slice(1);

  it("the page policy names the worker explicitly, so strict-dynamic cannot block /sw.js", () => {
    const csp = buildCsp("abc", false);
    expect(directive(csp, "worker-src")).toEqual(["'self'"]);
    expect(directive(csp, "script-src")).toEqual(["'self'", "'nonce-abc'", "'strict-dynamic'"]);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(directive(csp, "connect-src")).toEqual(["'self'"]);
  });

  it("/sw.js has its own headers and the proxy leaves it alone; every page still gets the nonce policy", async () => {
    const rules = await nextConfig.headers!();
    const headers = rules.find((r) => r.source === "/sw.js")!.headers;
    const get = (k: string) => headers.find((h) => h.key === k)?.value;
    expect(get("Content-Type")).toMatch(/^application\/javascript/);
    expect(get("Cache-Control")).toContain("no-cache");
    expect(get("Content-Security-Policy")).toBe("default-src 'self'; script-src 'self'");
    // The proxy's matcher is a lookahead that skips build assets and sw.js.
    const source = proxyConfig.matcher[0].source;
    const matches = (path: string) => new RegExp(`^${source}$`).test(path);
    expect(matches("/sw.js")).toBe(false);
    expect(matches("/settings")).toBe(true);
    expect(matches("/inbox")).toBe(true);
    expect(matches("/_next/static/x.js")).toBe(false);
    // Exactly /sw.js: its look-alikes still get the page policy and the proxy's checks.
    expect(source).toContain("sw\\.js$");
    for (const near of ["/sw.js.map", "/sw.json", "/sw.js/x", "/swxjs", "/sw.jsx", "/x/sw.js"]) expect(matches(near), near).toBe(true);
    expect(proxy(new NextRequest("http://localhost:3000/settings")).headers.get("Content-Security-Policy")).toContain("worker-src 'self'");
  });

  it("the worker can be registered from the app's own address only", () => {
    expect(readFileSync("src/components/notifications/device-control.tsx", "utf8")).toMatch(/register\("\/sw\.js", \{ scope: "\/" \}\)/);
  });
});
