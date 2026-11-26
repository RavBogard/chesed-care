import { describe, expect, it } from "vitest";
import { MAX_COUNT, NOTICE_KINDS, NOTICE_TEMPLATES, noticePayload, prefOf, renderNotice, safeTarget, type Notice } from "@/lib/notice";
import { isIosDevice, keyToBytes, pushMode, type PushEnv } from "@/lib/push-client";
import { noticeDefaultOn, noticeKindsFor, ROLES, wantsNotice, type Role } from "@/server/access/policy";
import { publicVapidKey, pushStatus, vapidDetails } from "@/server/notify/config";
import { hourIsQuiet } from "@/server/notify/prefs";
import { deviceLabel, isPushEndpoint } from "@/server/notify/subscriptions";

describe("the notice type: a kind and a count, never words", () => {
  it("cannot be given free text at the type level", () => {
    // These lines are compile-time checks: `tsc --noEmit` fails if any @ts-expect-error stops being an error.
    // @ts-expect-error a kind with no count has no field for words
    const a: Notice = { kind: "assigned", body: "Ruth Cohen was passed to you" };
    // @ts-expect-error the title is not a field either
    const b: Notice = { kind: "urgent_inbox", title: "Ruth Cohen" };
    // @ts-expect-error a counting kind takes a number, not text
    const c: Notice = { kind: "new_inbox", count: "Ruth Cohen" };
    // @ts-expect-error only the kinds in the closed set exist
    const d: Notice = { kind: "pastoral_note" };
    // @ts-expect-error a count belongs only to the counting kinds
    const e: Notice = { kind: "assigned", count: 3 };
    expect([a, b, c, d, e]).toHaveLength(5);
  });

  it("builds a payload that holds exactly kind, count and path, whatever else the caller's object carries", () => {
    const smuggled = { kind: "new_inbox", count: 4, name: "Ruth Cohen", note: "She is frightened", body: "free words", title: "x", path: "https://evil.example" } as unknown as Notice;
    expect(noticePayload(smuggled)).toEqual({ kind: "new_inbox", count: 4, path: "/inbox" });
    const plain = { kind: "assigned", count: 9, name: "Ruth" } as unknown as Notice;
    expect(Object.keys(noticePayload(plain)).sort()).toEqual(["kind", "path"]);
    for (const kind of NOTICE_KINDS) expect(Object.keys(noticePayload({ kind, count: 2 } as Notice)).every((k) => ["kind", "count", "path"].includes(k))).toBe(true);
    expect(() => noticePayload({ kind: "something_else" } as unknown as Notice)).toThrow(TypeError);
  });

  it("bounds the count: a whole number, 0 to 999; anything else is 0", () => {
    expect(noticePayload({ kind: "new_inbox", count: 5000 }).count).toBe(MAX_COUNT);
    expect(noticePayload({ kind: "new_inbox", count: -3 }).count).toBe(0);
    expect(noticePayload({ kind: "new_inbox", count: 2.5 }).count).toBe(0);
    expect(noticePayload({ kind: "new_inbox", count: Number.NaN }).count).toBe(0);
    expect(noticePayload({ kind: "new_inbox", count: "7" as unknown as number }).count).toBe(0);
  });

  it("has one fixed sentence per kind, with the right urgency, a time to live and a tag", () => {
    expect(renderNotice({ kind: "urgent_inbox" }).body).toBe("Something needs you today.");
    expect(renderNotice({ kind: "new_inbox", count: 3 }).body).toBe("3 new in your Inbox.");
    expect(renderNotice({ kind: "morning_summary", count: 1 }).body).toBe("1 thing for you this morning.");
    expect(renderNotice({ kind: "morning_summary", count: 4 }).body).toBe("4 things for you this morning.");
    expect(renderNotice({ kind: "assigned" }).body).toBe("Something was passed to you.");
    expect(renderNotice({ kind: "volunteer_opened" }).body).toBe("A volunteer place opened up.");
    expect(renderNotice({ kind: "volunteer_asks", count: 1 }).body).toBe("1 ask still needs someone.");
    expect(renderNotice({ kind: "volunteer_asks", count: 3 }).body).toBe("3 asks still need someone.");
    expect(renderNotice({ kind: "urgent_digest", count: 1 }).body).toBe("1 thing needs you today.");
    expect(renderNotice({ kind: "urgent_digest", count: 5 }).body).toBe("5 things need you today.");
    expect(renderNotice({ kind: "urgent_overnight" }).body).toBe("Something needed you overnight.");
    expect(renderNotice({ kind: "assigned_many", count: 2 }).body).toBe("2 things were passed to you.");
    expect(prefOf("urgent_digest")).toBe("urgent_inbox");
    expect(prefOf("urgent_overnight")).toBe("urgent_inbox");
    expect(prefOf("assigned_many")).toBe("assigned");
    expect(noticePayload({ kind: "urgent_digest", count: 3 })).toEqual({ kind: "urgent_digest", count: 3, path: "/inbox" });
    expect(NOTICE_KINDS.filter((k) => NOTICE_TEMPLATES[k].urgency === "high")).toEqual(["urgent_inbox"]);
    for (const kind of NOTICE_KINDS) {
      const t = NOTICE_TEMPLATES[kind];
      expect(t.ttl).toBeGreaterThan(0);
      expect(t.tag).toMatch(/^[a-z_]{1,32}$/);
      expect(safeTarget(t.path, "https://care.example")).toBe(t.path);
    }
  });

  it("opens a same-origin path only", () => {
    const o = "https://care.example";
    expect(safeTarget("/inbox", o)).toBe("/inbox");
    expect(safeTarget("/volunteers?x=1", o)).toBe("/volunteers?x=1");
    for (const bad of ["https://evil.example/inbox", "//evil.example", "/\\evil.example", "javascript:alert(1)", "inbox", "", null, undefined, 5, "/%5Cevil"]) {
      const out = safeTarget(bad, o);
      expect(out === "/" || out.startsWith("/")).toBe(true);
      expect(out.startsWith("//")).toBe(false);
    }
    expect(safeTarget("https://evil.example/inbox", o)).toBe("/");
    expect(safeTarget("//evil.example", o)).toBe("/");
    expect(safeTarget("/\\evil.example", o)).toBe("/");
    for (const sneaky of ["/.//evil.com", "/x/..//evil.com", "/%2e//evil.com", "//evil.com", "/\\evil.com"]) expect(safeTarget(sneaky, o), sneaky).toBe("/");
  });

  it("puts the two volunteer kinds on one switch, and the summary and the test on none", () => {
    expect(prefOf("volunteer_opened")).toBe("coordinator");
    expect(prefOf("volunteer_asks")).toBe("coordinator");
    expect(prefOf("morning_summary")).toBeNull();
    expect(prefOf("test")).toBeNull();
    expect(prefOf("urgent_inbox")).toBe("urgent_inbox");
  });
});

describe("who is offered which switch, and the defaults", () => {
  const kinds = (role: Role) => [...noticeKindsFor({ role })];
  it("clergy and owner: both Inbox kinds, passed to me, volunteer places", () => {
    for (const role of ["owner", "clergy"] as const) expect(kinds(role)).toEqual(["urgent_inbox", "new_inbox", "assigned", "coordinator"]);
  });
  it("a lead is offered no Inbox kinds: volunteer places, and the Mitzvah Corps steps passed to them", () => {
    expect(kinds("lead")).toEqual(["assigned", "coordinator"]);
  });
  it("caregiver: passed to me only; staff: meal places only; senior staff: nothing", () => {
    expect(kinds("caregiver")).toEqual(["assigned"]);
    expect(kinds("staff")).toEqual(["coordinator"]);
    expect(kinds("senior_staff")).toEqual([]);
  });
  it("defaults: urgent for clergy and owner, passed to me for all, volunteer places for leads, new Inbox for nobody", () => {
    for (const role of ROLES) {
      expect(noticeDefaultOn(role, "new_inbox")).toBe(false);
      expect(noticeDefaultOn(role, "assigned")).toBe(true);
      expect(noticeDefaultOn(role, "urgent_inbox")).toBe(role === "owner" || role === "clergy");
      expect(noticeDefaultOn(role, "coordinator")).toBe(role === "lead");
    }
  });
  it("a switch the role is not offered never turns on, whatever is stored", () => {
    expect(wantsNotice({ role: "caregiver" }, "urgent_inbox", { urgent_inbox: true })).toBe(false);
    expect(wantsNotice({ role: "lead" }, "new_inbox", { new_inbox: true })).toBe(false);
    expect(wantsNotice({ role: "clergy" }, "new_inbox", {})).toBe(false);
    expect(wantsNotice({ role: "clergy" }, "new_inbox", { new_inbox: true })).toBe(true);
    expect(wantsNotice({ role: "clergy" }, "urgent_inbox", { urgent_inbox: false })).toBe(false);
  });
});

describe("configuration: three variables, names only", () => {
  const ALL = { VAPID_PUBLIC_KEY: "pub-key-value", VAPID_PRIVATE_KEY: "private-key-value", VAPID_SUBJECT: "mailto:care@example.test" };
  it("is configured with all three, and reports missing names without any value", () => {
    expect(pushStatus(ALL)).toEqual({ configured: true, missing: [] });
    expect(vapidDetails(ALL)).toEqual({ subject: ALL.VAPID_SUBJECT, publicKey: ALL.VAPID_PUBLIC_KEY, privateKey: ALL.VAPID_PRIVATE_KEY });
    expect(publicVapidKey(ALL)).toBe("pub-key-value");
    const partial = { VAPID_PUBLIC_KEY: "pub-key-value", VAPID_SUBJECT: "mailto:care@example.test" };
    const status = pushStatus(partial);
    expect(status).toEqual({ configured: false, missing: ["VAPID_PRIVATE_KEY"] });
    expect(JSON.stringify(status)).not.toContain("pub-key-value");
    expect(vapidDetails(partial)).toBeNull();
    expect(publicVapidKey(partial)).toBeNull();
    expect(pushStatus({}).missing).toEqual(["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]);
  });
  it("a subject that is not a mailto: address counts as missing", () => {
    expect(pushStatus({ ...ALL, VAPID_SUBJECT: "care@example.test" })).toEqual({ configured: false, missing: ["VAPID_SUBJECT"] });
  });
});

describe("devices and the browser", () => {
  it("labels a device in broad terms only", () => {
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605 Version/18 Mobile Safari")).toBe("iPhone");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130 Mobile Safari")).toBe("Android phone");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Safari")).toBe("Mac");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130")).toBe("Windows PC");
    expect(deviceLabel("curl/8")).toBe("Other");
    expect(deviceLabel(null)).toBe("Other");
  });
  it("accepts only the browsers' own push services", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/abc", "https://web.push.apple.com/abc", "https://wns2-par02p.notify.windows.com/w/?token=x"]) expect(isPushEndpoint(ok), ok).toBe(true);
    for (const bad of ["http://fcm.googleapis.com/x", "https://evil.example/x", "https://fcm.googleapis.com.evil.example/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://169.254.169.254/latest", "not a url", "", null, 5]) expect(isPushEndpoint(bad), String(bad)).toBe(false);
  });
  it("shows the three iPhone steps instead of a button that cannot work", () => {
    const base: PushEnv = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5, standalone: false, permission: "default" };
    expect(pushMode(base)).toBe("ios_install");
    // Even if Safari reported no push support, an iPhone outside the Home Screen gets the steps, not "unsupported".
    expect(pushMode({ ...base, hasPushManager: false, hasNotification: false })).toBe("ios_install");
    expect(pushMode({ ...base, standalone: true })).toBe("ready");
    expect(pushMode({ ...base, standalone: true, permission: "denied" })).toBe("denied");
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 })).toBe(true);
    const desktop: PushEnv = { ...base, userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130", maxTouchPoints: 0 };
    expect(pushMode(desktop)).toBe("ready");
    expect(pushMode({ ...desktop, hasPushManager: false })).toBe("unsupported");
    expect(pushMode({ ...desktop, permission: "denied" })).toBe("denied");
  });
  it("turns the public key into bytes", () => {
    expect([...keyToBytes("AQID")]).toEqual([1, 2, 3]);
    expect([...keyToBytes("-_8")]).toEqual([251, 255]);
  });
});

describe("quiet hours", () => {
  it("wrap midnight: 9 pm to 7 am", () => {
    expect([20, 21, 23, 0, 6].map((h) => hourIsQuiet(h, 21, 7))).toEqual([false, true, true, true, true]);
    expect([7, 12, 20].map((h) => hourIsQuiet(h, 21, 7))).toEqual([false, false, false]);
  });
  it("a window inside one day, and an empty one", () => {
    expect([12, 13, 14].map((h) => hourIsQuiet(h, 13, 14))).toEqual([false, true, false]);
    expect(hourIsQuiet(5, 8, 8)).toBe(false);
  });
});
