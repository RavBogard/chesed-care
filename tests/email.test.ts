/**
 * Outbound email: the sender (config, validation, caps, duplicates, failures), every wording, the signed stop link, asking the
 * roster by email, the day-before reminders, the morning summary, and the three sign-ups that send a thank-you. Nothing here
 * reaches the network: the sender is given a fake fetch, and the actions get a stubbed global one.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { InvalidInput } from "@/server/care/validate";
import { createCareItem } from "@/server/care/care-items";
import { createFollowUp } from "@/server/care/follow-ups";
import { askMail, joinMail, mealSignupMail, morningSummaryMail, reminderMail, volunteerSignupMail } from "@/lib/email-wording";
import { runMorningSummaries, setSummaryPref, summaryMessage } from "@/server/daily/summary";
import { corpsAsks, corpsMembers, emailLog, mealRateLimits, mealSignups, volunteerClaims } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { emailStatus } from "@/server/email/config";
import { runHelperReminders } from "@/server/email/reminders";
import { EMAIL_LIMITS, addressHash, purgeEmailLog, sendEmail, strictAddress } from "@/server/email/send";
import { emailSummaryChannel } from "@/server/email/summary-channel";
import { signRenderStamp } from "@/server/meals/client-meta";
import { cancelMySignup } from "@/server/meals/public";
import { JOIN_STAMP_SCOPE } from "@/app/join/scope";
import { stopAsking, stopLinkWorks } from "@/server/volunteers/join";
import { notifyMembers } from "@/server/volunteers/notify";
import { createVolunteerTask } from "@/server/volunteers/organiser";
import { cancelMyClaim } from "@/server/volunteers/public";
import { addMember, emailAsk } from "@/server/volunteers/roster";
import { memberOfSignedStop, signedStopPath } from "@/server/volunteers/stop-link";
import { CONTACT, reporters, team, testDb } from "./support/db";
import { helper, livePage, meta, NOW } from "./support/meals";
import { words } from "./support/words";

const hoisted = vi.hoisted(() => ({ later: [] as (() => Promise<void> | void)[] }));
vi.mock("next/server", async (importActual) => ({ ...(await importActual<typeof import("next/server")>()), after: (fn: () => Promise<void> | void) => void hoisted.later.push(fn) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("not found");
  },
}));
const dbHolder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/server/db/client", () => ({ getDb: () => dbHolder.db }));

import { joinAction } from "@/app/join/actions";
import { signUpAction } from "@/app/m/actions";
import { claimAction, claimEveryTimeAction } from "@/app/v/actions";

const ORIGIN = "https://care.example.test";
const ON = { RESEND_API_KEY: "re_test_key", CARE_EMAIL: "on" };
type Sent = { url: string; init: RequestInit & { headers: Record<string, string> }; body: { from: string; to: string[]; subject: string; text: string; reply_to: string } };

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
let sent: Sent[];
const fakeFetch = (status = 200) =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init as Sent["init"], body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
const deps = (over: Record<string, unknown> = {}) => ({ fetch: fakeFetch(), now: NOW, env: ON, ...over });
const msg = (over: Record<string, unknown> = {}) => ({ to: "dana@example.test", subject: "Hello", text: "Body\n\nCentral Reform Congregation", kind: "test", ref: "r1", ...over });

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-for-email");
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("CARE_EMAIL", "");
  vi.stubEnv("RESEND_API_KEY", "");
  sent = [];
  hoisted.later.length = 0;
  db = await testDb();
  dbHolder.db = db;
  t = { ...(await team(db)), ...(await reporters(db)) };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("whether email is on", () => {
  it("is off outside production unless CARE_EMAIL=on, and never on with CARE_EMAIL=off or without the key", () => {
    const key = { RESEND_API_KEY: "re_x" };
    expect(emailStatus({ ...key }).configured).toBe(false);
    expect(emailStatus({ ...key, VERCEL_ENV: "preview" }).configured).toBe(false);
    expect(emailStatus({ ...key, VERCEL_ENV: "production" }).configured).toBe(true);
    expect(emailStatus({ ...key, CARE_EMAIL: "on" }).configured).toBe(true);
    expect(emailStatus({ ...key, VERCEL_ENV: "production", CARE_EMAIL: "off" }).configured).toBe(false);
    expect(emailStatus({ VERCEL_ENV: "production" })).toEqual({ configured: false, missing: ["RESEND_API_KEY"] });
    expect(emailStatus({ CARE_EMAIL: "on" }).missing).toEqual(["RESEND_API_KEY"]);
  });
});

describe("the sender", () => {
  it("sends nothing and says so when it is not configured", async () => {
    const d = deps({ env: { RESEND_API_KEY: "re_x" } });
    expect(await sendEmail(db, msg(), d)).toBe("not_configured");
    expect(d.fetch).not.toHaveBeenCalled();
    expect(await db.select().from(emailLog)).toEqual([]);
  });

  it("posts one plain-text message to Resend with the key, the sender and a reply address", async () => {
    const d = deps();
    expect(await sendEmail(db, msg(), d)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.resend.com/emails");
    expect(sent[0].init.method).toBe("POST");
    expect(sent[0].init.headers.Authorization).toBe("Bearer re_test_key");
    expect(sent[0].body).toEqual({ from: "Central Reform Congregation <care@centralreform.org>", to: ["dana@example.test"], subject: "Hello", text: "Body\n\nCentral Reform Congregation", reply_to: "care@centralreform.org" });
    expect(await sendEmail(db, msg({ ref: "r2" }), deps({ env: { ...ON, CARE_REPLY_TO: "office@centralreform.org" } }))).toBe("sent");
    expect(sent[1].body.reply_to).toBe("office@centralreform.org");
    expect(Object.keys(sent[0].body)).not.toContain("html");
  });

  it("refuses anything but one plain address, and strips line breaks from the subject", async () => {
    const bad = ["a@b.test, c@d.test", "a@b.test\nBcc: x@y.test", "Dana <dana@example.test>", " dana@example.test", "dana@example.test ", "dana@@example.test", "dana", "", "a@b.test;c@d.test", "dana@example.test\r\n", `${"x".repeat(250)}@example.test`];
    const d = deps();
    for (const to of bad) expect(await sendEmail(db, msg({ to }), d)).toBe("failed");
    expect(d.fetch).not.toHaveBeenCalled();
    expect(strictAddress("dana@example.test")).toBe("dana@example.test");
    expect(await sendEmail(db, msg({ subject: "Hi\r\nBcc: evil@example.test" }), d)).toBe("sent");
    expect(sent[0].body.subject).not.toMatch(/[\r\n]/);
    // Capital letters are the same address: it is sent to (and logged as) the lower-case one, once.
    expect(await sendEmail(db, msg({ to: "Dana@Example.test" }), d)).toBe("duplicate");
  });

  it("allows 6 a day to one person, 300 an hour and 1500 a day in all", async () => {
    const d = deps();
    for (let i = 1; i <= EMAIL_LIMITS.perRecipientPerDay; i++) expect(await sendEmail(db, msg({ ref: `r${i}` }), d)).toBe("sent");
    expect(await sendEmail(db, msg({ ref: "r7" }), d)).toBe("limited");
    expect(await sendEmail(db, msg({ to: "other@example.test", ref: "r7" }), d)).toBe("sent");
    // A limited send leaves no log row, so a later run may try again.
    expect(await db.select().from(emailLog).where(eq(emailLog.ref, "r7"))).toHaveLength(1);

    const hour = new Date(Math.floor(NOW.getTime() / 3_600_000) * 3_600_000);
    await db.insert(mealRateLimits).values({ key: "email:all", windowStart: hour, count: EMAIL_LIMITS.perHour }).onConflictDoUpdate({ target: [mealRateLimits.key, mealRateLimits.windowStart], set: { count: EMAIL_LIMITS.perHour } });
    expect(await sendEmail(db, msg({ to: "c@example.test" }), d)).toBe("limited");
    await db.update(mealRateLimits).set({ count: 1 }).where(eq(mealRateLimits.key, "email:all"));
    const day = new Date(Math.floor(NOW.getTime() / 86_400_000) * 86_400_000);
    await db.insert(mealRateLimits).values({ key: "day:email:all", windowStart: day, count: EMAIL_LIMITS.perDay }).onConflictDoUpdate({ target: [mealRateLimits.key, mealRateLimits.windowStart], set: { count: EMAIL_LIMITS.perDay } });
    expect(await sendEmail(db, msg({ to: "d@example.test" }), d)).toBe("limited");
  });

  it("sends the same (kind, ref, recipient) once, and the log holds a hash, never the address", async () => {
    const d = deps();
    expect(await sendEmail(db, msg(), d)).toBe("sent");
    expect(await sendEmail(db, msg({ subject: "Different words" }), d)).toBe("duplicate");
    expect(await sendEmail(db, msg({ to: "eli@example.test" }), d)).toBe("sent");
    expect(await sendEmail(db, msg({ kind: "other" }), d)).toBe("sent");
    expect(sent).toHaveLength(3);
    const rows = await db.select().from(emailLog);
    expect(JSON.stringify(rows)).not.toMatch(/dana|example\.test/i);
    expect(rows.find((r) => r.toHash === addressHash("DANA@example.test"))?.ok).toBe(true);
  });

  it("never throws: a failure answers 'failed', logs only the kind and the status, and can be tried again", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await sendEmail(db, msg(), deps({ fetch: fakeFetch(500) }))).toBe("failed");
    expect(await sendEmail(db, msg(), deps({ fetch: vi.fn(async () => Promise.reject(new TypeError("fetch failed dana@example.test"))) as unknown as typeof fetch }))).toBe("failed");
    expect(log.mock.calls).toEqual([
      ["email.failed", "test", 500],
      ["email.failed", "test", "TypeError"],
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/dana|Hello|Body/);
    expect(await db.select().from(emailLog)).toEqual([]);
    expect(await sendEmail(db, msg(), deps())).toBe("sent");
  });

  it("deletes log rows older than 60 days", async () => {
    await sendEmail(db, msg(), deps());
    await db.update(emailLog).set({ createdAt: new Date(NOW.getTime() - 61 * 86_400_000) });
    await sendEmail(db, msg({ ref: "new" }), deps());
    expect(await purgeEmailLog(db, NOW)).toBe(1);
    expect((await db.select().from(emailLog)).map((r) => r.ref)).toEqual(["new"]);
  });
});

describe("the words", () => {
  const FORBIDDEN = /Cohen|Maple Lane|Peanut|lasagne|cancer|Ruth|chemo|Sit with/i;
  it("every email ends with the congregation's name, is plain text, and carries only what it was given", () => {
    const mails = [
      morningSummaryMail(summaryMessage({ overdue: 2, dueToday: 0, inbox: 1, newSteps: 0 }, ORIGIN).body),
      mealSignupMail({ date: "2026-12-03", pageUrl: `${ORIGIN}/m/s/tok` }),
      volunteerSignupMail({ date: "2026-12-05", pageUrl: `${ORIGIN}/v/c/tok`, repeating: false }),
      volunteerSignupMail({ date: "2026-12-05", pageUrl: `${ORIGIN}/v/c/tok`, repeating: true }),
      joinMail({ stopUrl: `${ORIGIN}/join/stop/tok` }),
      askMail({ askText: "Can you help? Central Reform Congregation has a small request.", stopUrl: `${ORIGIN}/join/stop/s/x.y` }),
      reminderMail({ what: "meal", date: "2026-12-03" }),
      reminderMail({ what: "help", date: "2026-12-03" }),
    ];
    for (const m of mails) {
      expect(m.text.endsWith("\n\nCentral Reform Congregation")).toBe(true);
      expect(m.text).not.toMatch(/<[a-z]|&nbsp;/i);
      expect(m.subject).not.toMatch(/[\r\n]/);
    }
    expect(mails.map((m) => m.subject)).toEqual(["CRC Care this morning", "Thank you for bringing a meal", "Thank you for helping", "Thank you for helping", "Welcome to Mitzvah Corps", "Can you help?", "Tomorrow: your meal", "Tomorrow: you're helping"]);
    expect(mails[1].text).toBe(`Thank you for signing up to bring a meal on Thursday, December 3.\n\nThe address, the family's notes and a way to change or cancel are on your own page:\n${ORIGIN}/m/s/tok\n\nPlease keep this email: that link is the only way back to your page.\n\nCentral Reform Congregation`);
    expect(mails[2].text).toContain("to help on Saturday, December 5.");
    expect(mails[3].text).toContain("to help starting Saturday, December 5.");
    expect(mails[6].text).toContain("to bring a meal tomorrow, Thursday, December 3.");
    expect(mails[7].text).toContain("to help tomorrow, Thursday, December 3.");
    expect(mails[6].text).toContain("The link is in the email we sent when you signed up.");
    expect(words(mails)).not.toMatch(FORBIDDEN);
  });
});

describe("the signed stop link", () => {
  it("verifies, rejects a changed id or signature, and opening it (a GET) stops nobody", async () => {
    const m = await addMember(db, t.lead, { firstName: "Avi", lastName: "Mor", email: "avi@example.test", mobile: null, canDo: ["visits"] });
    const path = signedStopPath(m.id);
    expect(path).toMatch(new RegExp(`^/join/stop/s/${m.id}\\.[A-Za-z0-9_-]+$`));
    const value = path.slice("/join/stop/s/".length);
    expect(memberOfSignedStop(value)).toBe(m.id);
    const [id, sig] = value.split(".");
    const otherId = "00000000-0000-4000-8000-000000000000";
    for (const bad of [`${otherId}.${sig}`, `${id}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, `${id}.`, `${id}`, `${id}.${sig}.x`, "", `${id.toUpperCase()}.${sig}`, `${id}.${sig}${sig}`]) {
      expect(memberOfSignedStop(bad)).toBeNull();
      expect(await stopLinkWorks(db, bad)).toBe(false);
    }
    // Opening the page checks the link and changes nothing.
    expect(await stopLinkWorks(db, value)).toBe(true);
    expect((await db.select().from(corpsMembers).where(eq(corpsMembers.id, m.id)))[0].status).toBe("active");
    // The member's own stop token is untouched by the link's existence.
    const before = (await db.select().from(corpsMembers).where(eq(corpsMembers.id, m.id)))[0].stopTokenHash;
    // Only the POST stops them.
    expect(await stopAsking(db, value, meta(), NOW)).toEqual({ ok: true });
    const after = (await db.select().from(corpsMembers).where(eq(corpsMembers.id, m.id)))[0];
    expect(after).toMatchObject({ status: "left", stoppedBy: "self" });
    expect(after.stopTokenHash).toBe(before);
    expect(await stopAsking(db, `${otherId}.${sig}`, meta(), NOW)).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("asking the roster by email", () => {
  async function ask() {
    const task = await createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-05", place: "12 Maple Lane" }, NOW);
    const a = await addMember(db, t.lead, { firstName: "Avi", lastName: "Mor", email: "avi@example.test", mobile: null, canDo: ["visits"] });
    const b = await addMember(db, t.lead, { firstName: "Bea", lastName: "Gold", email: "bea@example.test", mobile: null, canDo: ["visits"] });
    const c = await addMember(db, t.lead, { firstName: "Cy", lastName: "Katz", email: null, mobile: "314 555 0100", canDo: ["visits"] });
    return { task, a, b, c };
  }

  it("emails each member who has an address on their own, with their own stop link, and counts those without", async () => {
    const { task, a, b, c } = await ask();
    const d = deps();
    const out = await emailAsk(db, t.lead, { taskId: task.id }, [a.id, b.id, c.id], ORIGIN, NOW, d);
    expect(out).toEqual({ configured: true, sent: 2, noEmail: 1, notSent: 0 });
    expect(sent.map((s) => s.body.to).sort()).toEqual([["avi@example.test"], ["bea@example.test"]]);
    for (const s of sent) {
      expect(s.body.to).toHaveLength(1);
      expect(s.body).not.toHaveProperty("bcc");
      expect(s.body.subject).toBe("Can you help?");
      expect(s.body.text).toContain(`${ORIGIN}/v/${task.publicToken}`);
      expect(s.body.text).toContain("To stop these emails: ");
      expect(s.body.text.endsWith("Central Reform Congregation")).toBe(true);
    }
    const avi = sent.find((s) => s.body.to[0] === "avi@example.test")!;
    expect(avi.body.text).toContain(`${ORIGIN}${signedStopPath(a.id)}`);
    expect(avi.body.text).not.toContain(signedStopPath(b.id));
    // Only the two who were actually emailed are noted as asked; the member with no address is not.
    expect((await db.select().from(corpsAsks)).map((r) => r.memberId).sort()).toEqual([a.id, b.id].sort());
    // Each ask email carries a List-Unsubscribe header with that member's own signed link, and nothing else extra.
    for (const s of sent) expect(Object.keys((s.body as unknown as { headers: object }).headers)).toEqual(["List-Unsubscribe"]);
    expect((avi.body as unknown as { headers: Record<string, string> }).headers["List-Unsubscribe"]).toBe(`<${ORIGIN}${signedStopPath(a.id)}>`);
    // The same press twice in a day does not email twice.
    expect(await emailAsk(db, t.lead, { taskId: task.id }, [a.id], ORIGIN, NOW, d)).toMatchObject({ sent: 0, notSent: 1 });
  });

  it("sends and records nothing when email is not set up; only people who may manage the roster can send; at most 60", async () => {
    const { task, a } = await ask();
    expect(await emailAsk(db, t.lead, { taskId: task.id }, [a.id], ORIGIN, NOW, deps({ env: {} }))).toEqual({ configured: false, sent: 0, noEmail: 0, notSent: 0 });
    expect(await db.select().from(corpsAsks)).toEqual([]);
    for (const who of [t.staff, t.carer, t.senior]) await expect(emailAsk(db, who, { taskId: task.id }, [a.id], ORIGIN, NOW, deps())).rejects.toBeInstanceOf(AccessDenied);
    const many = Array.from({ length: 61 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await expect(emailAsk(db, t.lead, { taskId: task.id }, many, ORIGIN, NOW, deps())).rejects.toBeInstanceOf(InvalidInput);
    expect(sent).toEqual([]);
  });

  it("notifyMembers still says 'not configured' for texts and without a context", async () => {
    expect(await notifyMembers([{ id: "x" }], { subject: "s", body: "b" }, "sms", { db, origin: ORIGIN, ref: "r", deps: deps() })).toMatchObject({ status: "not_configured", sent: 0 });
  });
});

describe("the sender: public kinds and headers", () => {
  it("anonymous-triggered kinds have their own lower cap, and staff kinds do not count against it", async () => {
    const d = deps();
    const hour = new Date(Math.floor(NOW.getTime() / 3_600_000) * 3_600_000);
    await db.insert(mealRateLimits).values({ key: "email:public", windowStart: hour, count: EMAIL_LIMITS.publicPerHour });
    expect(await sendEmail(db, msg({ kind: "meal_signup" }), d)).toBe("limited");
    expect(await sendEmail(db, msg({ kind: "join_welcome", to: "b@example.test" }), d)).toBe("limited");
    expect(await sendEmail(db, msg({ kind: "reminder_meal", to: "c@example.test" }), d)).toBe("sent");
    await db.update(mealRateLimits).set({ count: 1 }).where(eq(mealRateLimits.key, "email:public"));
    const day = new Date(Math.floor(NOW.getTime() / 86_400_000) * 86_400_000);
    await db.insert(mealRateLimits).values({ key: "day:email:public", windowStart: day, count: EMAIL_LIMITS.publicPerDay });
    expect(await sendEmail(db, msg({ kind: "volunteer_signup", to: "d@example.test" }), d)).toBe("limited");
    expect(await sendEmail(db, msg({ kind: "morning_summary", to: "e@example.test" }), d)).toBe("sent");
    expect(sent.map((s) => s.body.to[0])).toEqual(["c@example.test", "e@example.test"]);
  });

  it("allows only a List-Unsubscribe URL header, with no line breaks", async () => {
    const d = deps();
    const ok = { "List-Unsubscribe": "<https://care.example.test/join/stop/s/x.y>" };
    expect(await sendEmail(db, msg({ headers: ok }), d)).toBe("sent");
    expect((sent[0].body as unknown as { headers: object }).headers).toEqual(ok);
    const bad = [{ "List-Unsubscribe": "<https://a.test/x>\r\nBcc: x@y.test" }, { "List-Unsubscribe": "<mailto:a@b.test>" }, { "List-Unsubscribe": "https://a.test/x" }, { "X-Other": "1" }, { "List-Unsubscribe": "<https://a.test/x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }];
    for (const [i, headers] of bad.entries()) expect(await sendEmail(db, msg({ ref: `h${i}`, headers }), d)).toBe("failed");
    expect(sent).toHaveLength(1);
  });
});

describe("day-before reminders", () => {
  it("are not sent for a paused page or a cancelled sheet, and stop starting sends after their time budget", async () => {
    const page = await livePage(db, t.clergy);
    const { mealSlots, mealPages, volunteerGroups } = await import("@/server/db/schema");
    const { signUpForMeal } = await import("@/server/meals/public");
    const [slot] = await db.select().from(mealSlots).where(eq(mealSlots.date, "2026-12-03"));
    expect((await signUpForMeal(db, page.publicToken, slot.id, helper({ email: "dana@example.test" }), meta(), NOW)).ok).toBe(true);
    const at = new Date("2026-12-02T15:00:00Z");
    await db.update(mealPages).set({ status: "paused" });
    expect(await runHelperReminders(db, at, deps({ now: at }))).toMatchObject({ sent: 0 });
    await db.update(mealPages).set({ status: "live" });
    // With no time left, nothing new is started and the remainder is counted.
    expect(await runHelperReminders(db, at, deps({ now: at }), 0)).toMatchObject({ sent: 0, skipped: 1 });
    expect(await runHelperReminders(db, at, deps({ now: at }))).toMatchObject({ sent: 1, skipped: 0 });
    void volunteerGroups;
  });

  it("go once, to email sign-ups dated tomorrow that still stand, with no name, place or personal link", async () => {
    const page = await livePage(db, t.clergy);
    const slots = (await import("@/server/db/schema")).mealSlots;
    const slotOn = async (date: string) => (await db.select().from(slots).where(eq(slots.date, date)))[0].id;
    const { signUpForMeal } = await import("@/server/meals/public");
    const tomorrowMeal = await signUpForMeal(db, page.publicToken, await slotOn("2026-12-03"), helper({ email: "dana@example.test" }), meta(), NOW);
    const todayMeal = await signUpForMeal(db, page.publicToken, await slotOn("2026-12-01"), helper({ email: "today@example.test" }), meta(), NOW);
    expect(tomorrowMeal.ok && todayMeal.ok).toBe(true);
    const at = new Date("2026-12-02T15:00:00Z");
    // Tasks: one tomorrow with an email claim, one with a mobile claim, one the volunteer gave back.
    const mk = (forLabel: string) => createVolunteerTask(db, t.lead, { kind: "visit", forLabel, needed: "Sit with Ruth for an hour", date: "2026-12-03", place: "12 Maple Lane" }, NOW);
    const [t1, t2, t3] = [await mk("Ruth"), await mk("Ruth"), await mk("Ruth")];
    const { claimTask } = await import("@/server/volunteers/public");
    const claim = (task: { publicToken: string | null }, contact: string) => claimTask(db, task.publicToken, { firstName: "Eli", lastName: "Katz", contact, note: null, mayAskAgain: false }, meta(), NOW);
    await claim(t1, "eli@example.test");
    await claim(t2, "314 555 0100");
    const third = await claim(t3, "gone@example.test");
    if (!third.ok) throw new Error("claim refused");
    await cancelMyClaim(db, third.manageToken, meta(), NOW);

    const d = deps({ now: at });
    expect(await runHelperReminders(db, at, d)).toMatchObject({ sent: 2, failed: 0, limited: 0 });
    expect(sent.map((s) => s.body.to[0]).sort()).toEqual(["dana@example.test", "eli@example.test"]);
    const meal = sent.find((s) => s.body.to[0] === "dana@example.test")!.body;
    const help = sent.find((s) => s.body.to[0] === "eli@example.test")!.body;
    expect(meal.subject).toBe("Tomorrow: your meal");
    expect(help.subject).toBe("Tomorrow: you're helping");
    expect(meal.text).toContain("tomorrow, Thursday, December 3.");
    for (const b of [meal, help]) {
      expect(words([b.subject, b.text])).not.toMatch(/Cohen|Dana|Levy|Eli|Katz|Ruth|Maple|Lasagne|Peanut|Pi Pizzeria/i);
      expect(b.text).not.toMatch(/https?:/);
    }
    // A re-run sends nothing new.
    expect(await runHelperReminders(db, at, d)).toMatchObject({ sent: 0, duplicate: 2 });
    expect(sent).toHaveLength(2);
    // A meal cancelled by the helper is not reminded.
    const [row] = await db.select().from(mealSignups).where(eq(mealSignups.email, "dana@example.test"));
    if (!tomorrowMeal.ok) throw new Error("sign-up refused");
    await db.delete(emailLog);
    await cancelMySignup(db, tomorrowMeal.manageToken, meta(), NOW);
    expect(row.id).toBe(tomorrowMeal.signupId);
    expect(await runHelperReminders(db, at, deps({ now: at }))).toMatchObject({ sent: 1 });
    // Other days remind nobody.
    expect(await runHelperReminders(db, new Date("2026-12-04T15:00:00Z"), deps())).toMatchObject({ sent: 0 });
    expect(await runHelperReminders(db, at, deps({ env: {} }))).toMatchObject({ sent: 0, notConfigured: 1 });
  });

  it("do not go to a claim that was marked done or whose task was cancelled", async () => {
    const task = await createVolunteerTask(db, t.lead, { kind: "call", forLabel: "Ruth", needed: "Phone Ruth", date: "2026-12-03" }, NOW);
    const { claimTask } = await import("@/server/volunteers/public");
    await claimTask(db, task.publicToken, { firstName: "Eli", lastName: "Katz", contact: "eli@example.test", note: null, mayAskAgain: false }, meta(), NOW);
    await db.update((await import("@/server/db/schema")).volunteerTasks).set({ status: "cancelled" });
    expect(await runHelperReminders(db, new Date("2026-12-02T15:00:00Z"), deps())).toMatchObject({ sent: 0 });
  });
});

describe("the morning summary by email", () => {
  it("goes only to people whose preference includes email, and holds counts and a link", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "bereavement", summary: "Ruth is frightened after the diagnosis" });
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call Ruth Cohen", dueDate: "2026-11-20" });
    await createFollowUp(db, t.clergy2, { careItemId: item.id, title: "Visit Ruth Cohen", dueDate: "2026-11-20" });
    await createFollowUp(db, t.owner, { careItemId: item.id, title: "Owner step", dueDate: "2026-11-20" });
    await setSummaryPref(db, t.clergy, "email");
    await setSummaryPref(db, t.clergy2, "push");
    await setSummaryPref(db, t.owner, "both");
    const d = deps({ now: new Date("2026-11-25T12:00:00Z") });
    const push = vi.fn(async () => "not_configured" as const);
    const tally = await runMorningSummaries(db, new Date("2026-11-25T12:00:00Z"), new Set(["owner@example.test"]), ORIGIN, { email: emailSummaryChannel(db, new Date("2026-11-25T12:00:00Z"), d), push });
    expect(tally.sent).toBe(2);
    expect(sent.map((s) => s.body.to[0]).sort()).toEqual(["clergy@example.test", "owner@example.test"]);
    for (const s of sent) {
      expect(s.body.subject).toBe("CRC Care this morning");
      expect(s.body.text).toContain(`Open CRC Care: ${ORIGIN}/`);
      expect(words([s.body.subject, s.body.text])).not.toMatch(/Ruth|Cohen|frightened|diagnosis/i);
    }
    // Run again the same day: nobody is emailed twice.
    await runMorningSummaries(db, new Date("2026-11-25T12:00:00Z"), new Set(["owner@example.test"]), ORIGIN, { email: emailSummaryChannel(db, new Date("2026-11-25T12:00:00Z"), d), push });
    expect(sent).toHaveLength(2);
  });
});

describe("the sign-ups that send a thank-you", () => {
  const form = (v: Record<string, string>) => {
    const f = new FormData();
    for (const [k, x] of Object.entries(v)) f.set(k, x);
    return f;
  };
  const IDLE = { status: "idle" } as const;
  const afterTheResponse = async () => {
    for (const task of hoisted.later.splice(0)) await task();
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("CARE_EMAIL", "on");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(url), init: init as Sent["init"], body: JSON.parse(String(init?.body)) });
        return new Response("{}", { status: 200 });
      }),
    );
  });
  const stamp = (scope: string) => signRenderStamp(scope, new Date(NOW.getTime() - 9_000));
  const redirected = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return String((e as Error).message).replace("redirect ", "");
    }
    throw new Error("expected a redirect");
  };

  it("a meal sign-up emails the date and the helper's own link only, after the response", async () => {
    const page = await livePage(db, t.clergy);
    const slots = (await import("@/server/db/schema")).mealSlots;
    const [slot] = await db.select().from(slots).where(eq(slots.date, "2026-12-03"));
    const to = await redirected(
      signUpAction(IDLE, form({ token: page.publicToken, stamp: stamp(page.publicToken), slotId: slot.id, firstName: "Dana", lastName: "Levy", email: "Dana.Levy@Example.test", kind: "cook", bringing: "Lasagne", foodType: "dairy", note: "Peanut free please", website: "" })),
    );
    // Not sent until the response is on its way.
    expect(sent).toEqual([]);
    await afterTheResponse();
    expect(sent).toHaveLength(1);
    const body = sent[0].body;
    expect(body.to).toEqual(["dana.levy@example.test"]);
    expect(body.subject).toBe("Thank you for bringing a meal");
    expect(body.text).toContain(`${ORIGIN}${to.split("?")[0]}`);
    expect(to).toMatch(/^\/m\/s\//);
    expect(words([body.subject, body.text])).not.toMatch(/Cohen|Maple Lane|Lasagne|Peanut|Dana|Levy|cooler|porch|Pi Pizzeria/i);
  });

  it("a volunteer sign-up emails only for an email contact, one date or 'starting' for every time", async () => {
    const task = await createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-05", place: "12 Maple Lane" }, NOW);
    const fields = (contact: string) => ({ token: task.publicToken!, stamp: stamp(task.publicToken!), firstName: "Eli", lastName: "Katz", contact, note: "I am a nurse", website: "" });
    const to = await redirected(claimAction(IDLE, form(fields("Eli@Example.test"))));
    await afterTheResponse();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.to).toEqual(["eli@example.test"]);
    expect(sent[0].body.text).toContain("to help on Saturday, December 5.");
    expect(sent[0].body.text).toContain(`${ORIGIN}${to.split("?")[0]}`);
    expect(words([sent[0].body.subject, sent[0].body.text])).not.toMatch(/Ruth|Maple|Eli|Katz|nurse|Sit with/i);
    // A mobile number gets nothing.
    const task2 = await createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-06" }, NOW);
    await redirected(claimAction(IDLE, form({ ...fields("314 555 0100"), token: task2.publicToken!, stamp: stamp(task2.publicToken!) })));
    await afterTheResponse();
    expect(sent).toHaveLength(1);
  });

  it("an every-time claim says 'starting' with the first date", async () => {
    const { createVolunteerSeries } = await import("@/server/volunteers/series");
    const made = await createVolunteerSeries(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date: "2026-12-05", every: 1, weekdays: [6], count: 3 }, NOW);
    const token = made.first.publicToken!;
    await redirected(claimEveryTimeAction(IDLE, form({ token, stamp: stamp(token), firstName: "Eli", lastName: "Katz", contact: "eli@example.test", note: "", website: "" })));
    await afterTheResponse();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toContain("to help starting Saturday, December 5.");
    expect((await db.select().from(volunteerClaims)).length).toBeGreaterThan(1);
  });

  it("the Mitzvah Corps form emails a new member their own stop link, and nobody else", async () => {
    const send = (contact: string) => joinAction({ status: "idle" }, form({ stamp: stamp(JOIN_STAMP_SCOPE), firstName: "Rina", lastName: "Stein", contact, canDo: "visits", availability: "Mornings", consent: "on", website: "" }));
    expect(await send("Rina@Example.test")).toEqual({ status: "sent" });
    await afterTheResponse();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.to).toEqual(["rina@example.test"]);
    expect(sent[0].body.subject).toBe("Welcome to Mitzvah Corps");
    const link = sent[0].body.text.match(/https:\/\/\S+\/join\/stop\/(\S+)/);
    expect(link).not.toBeNull();
    // The emailed token is the member's real one: it opens the stop page; only its hash is stored.
    expect(await stopLinkWorks(db, link![1])).toBe(true);
    const [row] = await db.select().from(corpsMembers);
    expect(JSON.stringify(row)).not.toContain(link![1]);
    expect(words([sent[0].body.subject, sent[0].body.text])).not.toMatch(/Rina|Stein/i);
    // The same person again, and a mobile number: no email.
    await send("Rina@Example.test");
    await send("314 555 0123");
    await afterTheResponse();
    expect(sent).toHaveLength(1);
  });

  it("does nothing when email is not set up", async () => {
    vi.stubEnv("CARE_EMAIL", "off");
    const page = await livePage(db, t.clergy);
    const slots = (await import("@/server/db/schema")).mealSlots;
    const [slot] = await db.select().from(slots).where(eq(slots.date, "2026-12-03"));
    await redirected(signUpAction(IDLE, form({ token: page.publicToken, stamp: stamp(page.publicToken), slotId: slot.id, firstName: "Dana", lastName: "Levy", email: "dana@example.test", kind: "cook", bringing: "Soup", foodType: "dairy", website: "" })));
    await afterTheResponse();
    expect(sent).toEqual([]);
  });
});
