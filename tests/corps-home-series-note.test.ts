import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied, type Actor } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { closeCareItem, createCareItem, setCorpsNote, updateCareItem } from "@/server/care/care-items";
import { listLeadSteps } from "@/server/care/follow-ups";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { runDailyJob } from "@/server/daily/run";
import { auditLog, careItems, mealRateLimits, mealSignups, volunteerClaims, volunteerTaskBlocks, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { startJourney } from "@/server/journeys/journeys";
import { addDays } from "@/server/lifecycle/window";
import { getCoordinatorHome } from "@/server/volunteers/home";
import { createVolunteerTask, getVolunteerTask, listVolunteerTasks, removeClaim, removeFromAllDates } from "@/server/volunteers/organiser";
import { cancelMySeries, claimEveryTime, claimTask, getMyClaim, getMyCommitments, getMySeries, VOLUNTEER_LIMITS } from "@/server/volunteers/public";
import { purgeVolunteerData } from "@/server/volunteers/purge";
import { cancelVolunteerSeries, createVolunteerSeries, listSeriesOccurrences, MAX_OCCURRENCES, occurrenceDates, updateVolunteerSeries } from "@/server/volunteers/series";
import { addActor, ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { livePage, meta, NOW } from "./support/meals";
import { signUp } from "./support/corps";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const SECRET = "Lost her husband last week";
const NOTE = "Meals on Tuesday and Thursday. Front door code is on the family page.";

beforeEach(async () => {
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});

const item = (over: Record<string, unknown> = {}, who: Actor = t.clergy) => createCareItem(db, who, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "bereavement", summary: SECRET, ...over });
const taskInput = (over: Record<string, unknown> = {}) => ({ kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-02", timeWindow: "2 to 4 pm", place: "41 Elm Court, St. Louis", ...over });
const vol = (over: Record<string, unknown> = {}) => ({ firstName: "Sam", lastName: "Katz", contact: "sam@example.test", mayAskAgain: false, ...over });
// 2 December 2026 is a Wednesday.
const series = (over: Record<string, unknown> = {}) => createVolunteerSeries(db, t.lead, { ...taskInput({ date: "2026-12-02" }), every: 1, weekdays: [3], count: 4, ...over }, NOW);

describe("the clergy note for Mitzvah Corps", () => {
  it("owner and clergy who fully see the item set it; nobody else can, and a lead cannot even see the item", async () => {
    const i = await item();
    for (const a of [t.clergy, t.owner]) expect((await setCorpsNote(db, a, i.id, NOTE)).corpsNote).toBe(NOTE);
    for (const a of [t.lead, t.staff, t.senior, t.carer]) await expect(setCorpsNote(db, a, i.id, "x")).rejects.toBeInstanceOf(NotFound);
    await expect(setCorpsNote(db, t.clergy, i.id, "x".repeat(301))).rejects.toBeInstanceOf(InvalidInput);
    expect((await setCorpsNote(db, t.clergy, i.id, "x".repeat(300))).corpsNote).toHaveLength(300);
    expect((await setCorpsNote(db, t.clergy, i.id, "")).corpsNote).toBeNull();
  });

  it("is refused on a restricted item, including to its holder, and restricting an item clears the line", async () => {
    const restricted = await item({ restricted: true });
    await expect(setCorpsNote(db, t.clergy, restricted.id, NOTE)).rejects.toBeInstanceOf(AccessDenied);
    await expect(setCorpsNote(db, t.owner, restricted.id, NOTE)).rejects.toBeInstanceOf(NotFound);
    const plain = await item();
    await setCorpsNote(db, t.clergy, plain.id, NOTE);
    await updateCareItem(db, t.clergy, plain.id, { restricted: true });
    expect((await db.select().from(careItems).where(eq(careItems.id, plain.id)))[0].corpsNote).toBeNull();
  });

  it("a lead reads it only on their own step for that person; it is the only item text they ever get", async () => {
    const i = await item();
    await setCorpsNote(db, t.clergy, i.id, NOTE);
    await startJourney(db, t.clergy, i.id, { templateKey: "bereavement_year", anchorDate: "2026-11-24" }, NOW);
    const steps = await listLeadSteps(db, t.lead, NOW);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.corpsNote === NOTE)).toBe(true);
    const flat = JSON.stringify(steps);
    expect(flat).not.toContain(SECRET);
    expect(flat).not.toContain(i.id);
    const other = await addActor(db, "lead2@example.test", "lead");
    expect(await listLeadSteps(db, other, NOW)).toEqual([]);
    for (const a of [t.clergy, t.staff, t.senior]) expect(await listLeadSteps(db, a, NOW)).toEqual([]);
  });

  it("the daily job keeps it however long ago the item closed, and the audit holds ids only", async () => {
    const i = await item();
    await setCorpsNote(db, t.clergy, i.id, NOTE);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "care_item.corps_note"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("Meals on Tuesday");
    expect(audit[0].detail).toEqual({ careItemId: i.id });
    await closeCareItem(db, t.clergy, i.id, new Date("2023-01-01T00:00:00Z"));
    const before = (await db.select().from(careItems).where(eq(careItems.id, i.id)))[0];
    await runDailyJob({ db, now: NOW, owners: new Set(["owner@example.test"]), origin: null });
    expect((await db.select().from(careItems).where(eq(careItems.id, i.id)))[0]).toMatchObject({ corpsNote: NOTE, summary: before.summary, notesPurgedAt: null });
  });
});

describe("the coordinator home", () => {
  async function scene() {
    const mine = await createVolunteerTask(db, t.lead, taskInput({ forLabel: "Ruth" }), NOW);
    const soon = await createVolunteerTask(db, t.clergy, taskInput({ forLabel: "Dan", date: "2026-12-03", kind: "ride" }), NOW);
    const filled = await createVolunteerTask(db, t.lead, taskInput({ forLabel: "Lea", date: "2026-12-04" }), NOW);
    await claimTask(db, filled.publicToken!, vol({ firstName: "Pat" }), meta(), NOW);
    const hidden = await item({ restricted: true });
    const secretTask = await createVolunteerTask(db, t.clergy, taskInput({ forLabel: "Hidden Hannah", careItemId: hidden.id }), NOW);
    const plain = await item({}, t.clergy);
    await setCorpsNote(db, t.clergy, plain.id, NOTE);
    await startJourney(db, t.clergy, plain.id, { templateKey: "bereavement_year", anchorDate: "2026-11-24" }, NOW);
    return { mine, soon, filled, secretTask };
  }

  it("shows what needs someone soonest first with days left, the steps with the line, meals, the last two days and the week", async () => {
    const { mine, soon, filled } = await scene();
    await claimTask(db, mine.publicToken!, vol({ firstName: "Quinn", contact: "q@example.test" }), meta(), at(0));
    await removeClaim(db, t.lead, (await getVolunteerTask(db, t.lead, mine.id, NOW)).claims[0].id, false, at(0));
    const page = await livePage(db, t.lead);
    await signUp(db, page, "meal@example.test", "2026-12-03");
    // Rows are stamped by the database clock; the tests' clock is NOW.
    await db.update(volunteerClaims).set({ createdAt: NOW });
    await db.update(mealSignups).set({ createdAt: NOW });
    const home = await getCoordinatorHome(db, t.lead, NOW);
    expect(home.today).toBe("2026-12-01");
    expect(home.needsSomeone.map((n) => [n.label, n.daysLeft])).toEqual([
      ["Ruth", 1],
      ["Dan", 2],
    ]);
    expect(home.needsSomeone[0].askHref).toBe(`/volunteers/${mine.id}#ask-roster`);
    expect(home.needsSomeone.map((n) => n.id)).not.toContain(filled.id);
    expect(home.mySteps.length).toBeGreaterThan(0);
    expect(home.mySteps.every((s) => s.corpsNote === NOTE)).toBe(true);
    expect(home.meals?.[0].openNights.map((n) => n.date)).toEqual(["2026-12-01", "2026-12-05"]);
    expect(home.changes.map((c) => c.kind).sort()).toEqual(["meal_signed_up", "removed", "signed_up", "signed_up"]);
    expect(home.thisWeek).toEqual([{ date: "2026-12-04", items: [{ id: filled.id, kind: "visit", label: "Lea", timeWindow: "2 to 4 pm", href: `/volunteers/${filled.id}` }] }]);
    expect(soon.id).toBeTruthy();
    // Nothing older than 48 hours.
    expect((await getCoordinatorHome(db, t.lead, at(3))).changes).toEqual([]);
  });

  it("is the same page for clergy and the owner, and for nobody else", async () => {
    await scene();
    for (const a of [t.clergy, t.owner]) await expect(getCoordinatorHome(db, a, NOW)).resolves.toMatchObject({ today: "2026-12-01" });
    for (const a of [t.staff, t.carer, t.senior]) await expect(getCoordinatorHome(db, a, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("no care-item data and no restricted item's task ever reaches a lead; its creator and no one else sees the task", async () => {
    const { secretTask } = await scene();
    const lead = await getCoordinatorHome(db, t.lead, NOW);
    const flat = JSON.stringify(lead);
    for (const secret of [SECRET, "bereavement", "Hidden Hannah", secretTask.id, "careItem", "restricted"]) expect(flat).not.toContain(secret);
    const list = await listVolunteerTasks(db, t.lead, NOW);
    expect(list.tasks.map((x) => x.id)).not.toContain(secretTask.id);
    expect(JSON.stringify(await getCoordinatorHome(db, t.clergy, NOW))).toContain("Hidden Hannah");
    // The owner has no override on a restricted item's task either.
    expect(JSON.stringify(await getCoordinatorHome(db, t.owner, NOW))).not.toContain("Hidden Hannah");
  });
});

describe("where a person lands after signing in", () => {
  const ok = (actor: Actor) => ({ kind: "ok" as const, actor }) as unknown as Parameters<typeof actorOrRedirect>[0];
  const target = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return String((e as { digest?: string }).digest ?? e);
    }
    return null;
  };

  it("a lead goes to Volunteers; staff and senior staff to Report; care team stay on Today; the Report page itself stays open to a lead", () => {
    expect(target(() => actorOrRedirect(ok(t.lead)))).toContain("/volunteers");
    expect(target(() => actorOrRedirect(ok(t.staff)))).toContain("/report");
    expect(target(() => actorOrRedirect(ok(t.senior)))).toContain("/report");
    expect(target(() => actorOrRedirect(ok(t.clergy)))).toBeNull();
    expect(target(() => actorOrRedirect(ok(t.lead), { reporter: true }))).toBeNull();
  });
});

describe("repeating tasks: the dates", () => {
  it("every week on chosen weekdays, every second week, until a date or for N times", () => {
    expect(occurrenceDates({ start: "2026-12-02", every: 1, weekdays: [0, 3], count: 5 })).toEqual(["2026-12-02", "2026-12-06", "2026-12-09", "2026-12-13", "2026-12-16"]);
    expect(occurrenceDates({ start: "2026-12-02", every: 2, weekdays: [3], count: 3 })).toEqual(["2026-12-02", "2026-12-16", "2026-12-30"]);
    expect(occurrenceDates({ start: "2026-12-02", every: 1, weekdays: [3], until: "2026-12-23" })).toEqual(["2026-12-02", "2026-12-09", "2026-12-16", "2026-12-23"]);
    expect(occurrenceDates({ start: "2026-12-02", every: 1, weekdays: [3], until: "2026-12-22" })).toHaveLength(3);
  });

  it("never more than 26 occurrences, and none when the rule matches nothing", () => {
    expect(occurrenceDates({ start: "2026-12-02", every: 1, weekdays: [3], count: MAX_OCCURRENCES })).toHaveLength(26);
    expect(() => occurrenceDates({ start: "2026-12-02", every: 1, weekdays: [3], until: "2027-12-01" })).toThrow(InvalidInput);
    expect(() => occurrenceDates({ start: "2026-12-02", every: 1, weekdays: [1, 2, 3, 4, 5, 6, 0], until: "2027-02-01" })).toThrow(InvalidInput);
    expect(() => occurrenceDates({ start: "2026-12-02", every: 1, weekdays: [3], until: "2030-01-01" })).toThrow(InvalidInput);
    expect(() => occurrenceDates({ start: "2026-12-02", every: 1, weekdays: [3], until: "2026-12-01" })).toThrow(InvalidInput);
  });

  it("creating one makes ordinary tasks that share a series; bad counts, past starts, both end rules and outsiders are refused", async () => {
    const s = await series();
    expect(s.taskIds).toHaveLength(4);
    const rows = await db.select().from(volunteerTasks).where(eq(volunteerTasks.seriesId, s.seriesId));
    expect(rows.map((r) => r.taskDate).sort()).toEqual(["2026-12-02", "2026-12-09", "2026-12-16", "2026-12-23"]);
    expect(new Set(rows.map((r) => r.publicTokenHash)).size).toBe(4);
    expect(s.first.date).toBe("2026-12-02");
    const bad = (over: Record<string, unknown>) => createVolunteerSeries(db, t.lead, { ...taskInput(), every: 1, weekdays: [3], count: 2, ...over }, NOW);
    await expect(bad({ count: 27 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(bad({ count: 0 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(bad({ date: "2026-11-24" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(bad({ until: "2026-12-30" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(bad({ count: undefined })).rejects.toBeInstanceOf(InvalidInput);
    await expect(bad({ every: 3 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(bad({ weekdays: [] })).rejects.toBeInstanceOf(InvalidInput);
    await expect(bad({ weekdays: [7] })).rejects.toBeInstanceOf(InvalidInput);
    for (const a of [t.staff, t.carer, t.senior]) await expect(createVolunteerSeries(db, a, { ...taskInput(), every: 1, weekdays: [3], count: 2 }, NOW)).rejects.toBeInstanceOf(AccessDenied);
    const hidden = await item({ restricted: true });
    await expect(bad({ careItemId: hidden.id })).rejects.toBeInstanceOf(NotFound);
  });
});

describe("I can do this every time", () => {
  async function tokens(count = 4, over: Record<string, unknown> = {}) {
    const s = await series({ count, ...over });
    const rows = await db.select().from(volunteerTasks).where(eq(volunteerTasks.seriesId, s.seriesId));
    return { s, rows: rows.sort((a, b) => a.taskDate.localeCompare(b.taskDate)) };
  }

  it("claims every open occurrence in one go on one personal page, and a single claim still works on its own", async () => {
    const { rows } = await tokens();
    const r = await claimEveryTime(db, rows[1].publicToken, vol(), meta(), NOW);
    expect(r).toMatchObject({ ok: true, count: 4 });
    if (!r.ok) return;
    const claims = await db.select().from(volunteerClaims);
    expect(claims).toHaveLength(4);
    expect(new Set(claims.map((c) => c.claimSetId)).size).toBe(1);
    expect(claims.filter((c) => c.manageTokenHash !== null)).toHaveLength(1);
    const mine = await getMySeries(db, r.manageToken, NOW);
    expect(mine?.dates.map((d) => d.date)).toEqual(["2026-12-02", "2026-12-09", "2026-12-16", "2026-12-23"]);
    expect(mine?.dates.every((d) => d.state === "active" && d.place === "41 Elm Court, St. Louis")).toBe(true);
    // An ordinary one-date claim on another series is not a series page.
    const solo = await createVolunteerTask(db, t.lead, taskInput({ date: "2026-12-10" }), NOW);
    const one = await claimTask(db, solo.publicToken!, vol({ contact: "other@example.test" }), meta(), NOW);
    if (one.ok) expect(await getMySeries(db, one.manageToken, NOW)).toBeNull();
    const nonSeries = await claimEveryTime(db, solo.publicToken, vol({ contact: "n@example.test" }), meta(), NOW);
    expect(nonSeries).toMatchObject({ ok: false });
  });

  it("is all or nothing: full dates, blocks and dates already held are skipped together inside one transaction, and two people never share a place", async () => {
    const { rows } = await tokens(3);
    const [first, second] = [rows[0], rows[1]];
    await claimTask(db, first.publicToken, vol({ contact: "early@example.test", firstName: "Early" }), meta(), NOW);
    const [a, b] = await Promise.all([claimEveryTime(db, rows[2].publicToken, vol({ contact: "a@example.test" }), meta(), NOW), claimEveryTime(db, rows[2].publicToken, vol({ contact: "b@example.test" }), meta(), NOW)]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ reason: "full" });
    const claims = await db.select().from(volunteerClaims);
    // First date had Early; the winner took the other two; nobody holds a date twice and nothing is over its count.
    const byTask = new Map<string, number>();
    for (const c of claims) byTask.set(c.taskId, (byTask.get(c.taskId) ?? 0) + 1);
    expect([...byTask.values()].every((n) => n === 1)).toBe(true);
    expect(claims).toHaveLength(3);
    expect(second.id).toBeTruthy();
    // The same person asking again changes nothing.
    const again = await claimEveryTime(db, rows[2].publicToken, vol({ contact: a.ok ? "a@example.test" : "b@example.test" }), meta(), NOW);
    expect(again).toMatchObject({ ok: false });
    expect(await db.select().from(volunteerClaims)).toHaveLength(3);
  });

  it("counts once per series against the success caps, and the caps hold", async () => {
    const { s, rows } = await tokens(5, { peopleNeeded: 50 });
    const same = meta("203.0.113.50");
    expect((await claimEveryTime(db, rows[0].publicToken, vol({ contact: "c0@example.test" }), same, NOW)).ok).toBe(true);
    const okRows = (await db.select().from(mealRateLimits)).filter((r) => r.key.startsWith(`vol:claim:ok:${s.seriesId}:`));
    expect(okRows).toHaveLength(1);
    expect(okRows[0].count).toBe(1);
    expect((await db.select().from(mealRateLimits)).find((r) => r.key.startsWith("vol:claim:okall:"))?.count).toBe(1);
    for (let i = 1; i < VOLUNTEER_LIMITS.claimOkPerClientPerTask; i++) expect((await claimEveryTime(db, rows[0].publicToken, vol({ contact: `c${i}@example.test` }), same, NOW)).ok).toBe(true);
    expect(await claimEveryTime(db, rows[0].publicToken, vol({ contact: "c9@example.test" }), same, NOW)).toMatchObject({ ok: false, reason: "rate_limited" });
    // Another client is not held back by it.
    expect((await claimEveryTime(db, rows[0].publicToken, vol({ contact: "other@example.test" }), meta(), NOW)).ok).toBe(true);
  });

  it("bot controls hold as for a single claim, and a dead link looks like any other", async () => {
    const { rows } = await tokens(2);
    expect(await claimEveryTime(db, rows[0].publicToken, vol(), { ...meta(), honeypot: "x" }, NOW)).toMatchObject({ ok: false, reason: "refused" });
    expect(await claimEveryTime(db, rows[0].publicToken, vol(), { ...meta(), elapsedMs: 100 }, NOW)).toMatchObject({ ok: false, reason: "refused" });
    expect(await claimEveryTime(db, "nonsense", vol(), meta(), NOW)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await claimEveryTime(db, rows[0].publicToken, vol({ contact: "bad" }), meta(), NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await db.select().from(volunteerClaims)).toHaveLength(0);
  });

  it("cancel one date or all of them, only within the person's own set", async () => {
    const { rows } = await tokens(3, { peopleNeeded: 2 });
    const mine = await claimEveryTime(db, rows[0].publicToken, vol(), meta(), NOW);
    const theirs = await claimEveryTime(db, rows[0].publicToken, vol({ contact: "other@example.test" }), meta(), NOW);
    if (!mine.ok || !theirs.ok) throw new Error("setup");
    const page = await getMySeries(db, mine.manageToken, NOW);
    const second = page!.dates[1].claimId;
    expect(await cancelMySeries(db, mine.manageToken, second, meta(), NOW)).toEqual({ ok: true, cancelled: 1 });
    expect((await getMySeries(db, mine.manageToken, NOW))!.dates.map((d) => d.state)).toEqual(["active", "cancelled", "active"]);
    // Someone else's claim id, through my link, changes nothing.
    const others = await db.select().from(volunteerClaims).where(eq(volunteerClaims.contactKey, "other@example.test"));
    expect(await cancelMySeries(db, mine.manageToken, others[0].id, meta(), NOW)).toEqual({ ok: true, cancelled: 0 });
    expect(await cancelMySeries(db, mine.manageToken, "not-a-uuid", meta(), NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await cancelMySeries(db, mine.manageToken, null, meta(), NOW)).toEqual({ ok: true, cancelled: 2 });
    expect((await db.select().from(volunteerClaims).where(eq(volunteerClaims.contactKey, "other@example.test"))).every((c) => c.cancelledAt === null)).toBe(true);
    // The page survives the first date being given back, so the rest of the set is still reachable.
    expect(await getMySeries(db, mine.manageToken, NOW)).not.toBeNull();
    // Cancelled places are open again.
    const open = await claimEveryTime(db, rows[1].publicToken, vol({ contact: "new@example.test" }), meta(), NOW);
    expect(open).toMatchObject({ ok: true, count: 3 });
  });

  const REF = "11111111-1111-4111-8111-111111111111";
  const OTHER_REF = "22222222-2222-4222-8222-222222222222";

  it("lists, from a personal link, only the claims that carry the same opaque cookie id: kind, label and time, never a place", async () => {
    const { rows } = await tokens(2);
    const lone = await createVolunteerTask(db, t.lead, taskInput({ date: "2026-12-12", forLabel: "Another family", place: "9 Oak Road" }), NOW);
    const a = await claimTask(db, lone.publicToken!, vol(), meta(), NOW, { personRef: REF });
    const b = await claimEveryTime(db, rows[0].publicToken, vol(), meta(), NOW, { personRef: REF });
    if (!a.ok || !b.ok) throw new Error("setup");
    const fromOne = await getMyCommitments(db, a.manageToken, NOW);
    expect(fromOne.map((c) => c.date)).toEqual(["2026-12-02", "2026-12-09"]);
    expect(JSON.stringify(fromOne)).not.toMatch(/Elm Court|Oak Road|sam@/);
    expect((await getMyCommitments(db, b.manageToken, NOW)).map((c) => c.forLabel)).toEqual(["Another family"]);
    expect(await getMyCommitments(db, "nonsense", NOW)).toEqual([]);
  });

  it("typing someone else's contact into a claim shows none of their dates, and a claim with no cookie lists nothing", async () => {
    const victim = await createVolunteerTask(db, t.lead, taskInput({ date: "2026-12-12", forLabel: "Victim's family" }), NOW);
    const hidden = await item({ restricted: true });
    const secret = await createVolunteerTask(db, t.clergy, taskInput({ date: "2026-12-14", forLabel: "Hidden Hannah", careItemId: hidden.id }), NOW);
    await claimTask(db, victim.publicToken!, vol({ contact: "victim@example.test", firstName: "Vic" }), meta(), NOW, { personRef: OTHER_REF });
    await claimTask(db, secret.publicToken!, vol({ contact: "victim@example.test", firstName: "Vic" }), meta(), NOW, { personRef: OTHER_REF });
    const own = await createVolunteerTask(db, t.lead, taskInput({ date: "2026-12-16", forLabel: "Mine" }), NOW);
    const attacker = await claimTask(db, own.publicToken!, vol({ contact: "VICTIM@example.test", firstName: "Eve" }), meta(), NOW, { personRef: REF });
    const noCookie = await claimTask(db, (await createVolunteerTask(db, t.lead, taskInput({ date: "2026-12-18" }), NOW)).publicToken!, vol({ contact: "victim@example.test" }), meta(), NOW);
    if (!attacker.ok || !noCookie.ok) throw new Error("setup");
    expect(await getMyCommitments(db, attacker.manageToken, NOW)).toEqual([]);
    expect(await getMyCommitments(db, noCookie.manageToken, NOW)).toEqual([]);
    // The victim, through their own cookie, sees their own dates, including their own claim on a restricted-linked task.
    const again = await claimTask(db, (await createVolunteerTask(db, t.lead, taskInput({ date: "2026-12-20", forLabel: "Later" }), NOW)).publicToken!, vol({ contact: "other-address@example.test" }), meta(), NOW, { personRef: OTHER_REF });
    if (!again.ok) throw new Error("setup");
    expect((await getMyCommitments(db, again.manageToken, NOW)).map((c) => c.forLabel).sort()).toEqual(["Hidden Hannah", "Victim's family"]);
    // A garbage cookie value is ignored.
    const junk = await claimTask(db, (await createVolunteerTask(db, t.lead, taskInput({ date: "2026-12-22" }), NOW)).publicToken!, vol({ contact: "j@example.test" }), meta(), NOW, { personRef: "not-a-uuid" });
    if (!junk.ok) throw new Error("setup");
    expect((await db.select().from(volunteerClaims).where(eq(volunteerClaims.id, junk.claimId)))[0].personRef).toBeNull();
    expect(secret.id).toBeTruthy();
  });

  it("each claim keeps its name and contact after thirty days, given-back ones too; the set's personal link lives to the last date", async () => {
    const { rows } = await tokens(3);
    const r = await claimEveryTime(db, rows[0].publicToken, vol(), meta(), NOW);
    if (!r.ok) throw new Error("setup");
    const [second] = (await db.select().from(volunteerClaims)).filter((c) => c.taskId === rows[1].id);
    await cancelMySeries(db, r.manageToken, second.id, meta(), NOW);
    const bare = async () => (await db.select().from(volunteerClaims)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const byDate = async () => {
      const all = await db.select().from(volunteerClaims);
      return rows.map((row) => all.find((c) => c.taskId === row.id)!);
    };
    // 10 December: nothing is thirty days old.
    await purgeVolunteerData(db, new Date("2026-12-10T18:00:00Z"));
    expect((await byDate()).every((c) => c.contact !== null)).toBe(true);
    // 5 January: 2 and 9 December are thirty days old (the second one was given back), 16 December is not.
    const jan = new Date("2027-01-12T18:00:00Z");
    await purgeVolunteerData(db, jan);
    expect((await byDate()).map((c) => c.contact)).toEqual(["sam@example.test", "sam@example.test", "sam@example.test"]);
    // The set's last date, 16 December, has passed, so the personal link has gone with the first claim's purge.
    expect(await getMySeries(db, r.manageToken, jan)).toBeNull();
    await purgeVolunteerData(db, new Date("2027-01-20T18:00:00Z"));
    expect((await bare()).every((c) => c.contact === "sam@example.test" && c.manageTokenHash === null)).toBe(true);
  });

  it("N5: the cookie id is removed from every claim that is purged", async () => {
    const solo = await createVolunteerTask(db, t.lead, taskInput({ date: "2026-12-02" }), NOW);
    const a = await claimTask(db, solo.publicToken!, vol(), meta(), NOW, { personRef: "33333333-3333-4333-8333-333333333333" });
    const { rows } = await tokens(2);
    const b = await claimEveryTime(db, rows[0].publicToken, vol({ contact: "b@example.test" }), meta(), NOW, { personRef: "44444444-4444-4444-8444-444444444444" });
    if (!a.ok || !b.ok) throw new Error("setup");
    expect((await db.select().from(volunteerClaims)).every((c) => c.personRef !== null)).toBe(true);
    await purgeVolunteerData(db, new Date("2027-02-20T18:00:00Z"));
    expect((await db.select().from(volunteerClaims)).every((c) => c.personRef === null)).toBe(true);
  });

  it("while a date is still to come, the personal link lives on; early claims keep their names", async () => {
    const s2 = await series({ count: 6, forLabel: "Long" });
    const long = (await db.select().from(volunteerTasks).where(eq(volunteerTasks.seriesId, s2.seriesId))).sort((a, b) => a.taskDate.localeCompare(b.taskDate));
    const r = await claimEveryTime(db, long[0].publicToken, vol(), meta(), NOW);
    if (!r.ok) throw new Error("setup");
    // 12 January: the first two dates are over 30 days old, the last (6 January) has passed too, so use an earlier day: 5 January.
    const day = new Date("2027-01-04T18:00:00Z");
    await purgeVolunteerData(db, day);
    const claims = await db.select().from(volunteerClaims);
    const first = claims.find((c) => c.taskId === long[0].id)!;
    expect(first.contact).toBe("sam@example.test");
    expect(first.note).toBeNull();
    // The series runs to 6 January, so the personal link still works on 4 January.
    expect(await getMySeries(db, r.manageToken, day)).not.toBeNull();
    expect(first.manageTokenHash).not.toBeNull();
  });
});

describe("editing and cancelling a series", () => {
  async function claimedSeries() {
    const s = await series();
    const rows = (await db.select().from(volunteerTasks).where(eq(volunteerTasks.seriesId, s.seriesId))).sort((a, b) => a.taskDate.localeCompare(b.taskDate));
    await claimTask(db, rows[1].publicToken, vol(), meta(), NOW);
    return { s, rows };
  }
  const words = async (id: string) => (await db.select().from(volunteerTasks).where(eq(volunteerTasks.id, id)))[0];

  it("changes the unclaimed occurrences from now on, leaves claimed ones and says how many, and asks for the rest", async () => {
    const { s, rows } = await claimedSeries();
    const out = await updateVolunteerSeries(db, t.lead, s.first.id, { needed: "Bring a book to read aloud", timeWindow: "3 to 5 pm" }, false, NOW);
    expect(out).toEqual({ changed: 3, claimedLeft: 1 });
    expect((await words(rows[0].id)).needed).toBe("Bring a book to read aloud");
    expect((await words(rows[1].id)).needed).toBe("Sit with Ruth for an hour");
    const all = await updateVolunteerSeries(db, t.lead, s.first.id, { needed: "Bring a book to read aloud" }, true, NOW);
    expect(all).toEqual({ changed: 4, claimedLeft: 0 });
    expect((await words(rows[1].id)).needed).toBe("Bring a book to read aloud");
    // Past occurrences are left alone.
    const later = await updateVolunteerSeries(db, t.lead, s.first.id, { forLabel: "Ruth C." }, true, new Date("2026-12-10T18:00:00Z"));
    expect(later.changed).toBe(2);
    expect((await words(rows[0].id)).forLabel).toBe("Ruth");
  });

  it("refuses dates and counts in an edit, outsiders, and a task with no series", async () => {
    const { s } = await claimedSeries();
    await expect(updateVolunteerSeries(db, t.lead, s.first.id, { date: "2026-12-30" }, false, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateVolunteerSeries(db, t.lead, s.first.id, { peopleNeeded: 9 }, false, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateVolunteerSeries(db, t.lead, s.first.id, {}, false, NOW)).rejects.toBeInstanceOf(InvalidInput);
    for (const a of [t.staff, t.carer, t.senior]) await expect(updateVolunteerSeries(db, a, s.first.id, { needed: "x" }, false, NOW)).rejects.toBeInstanceOf(AccessDenied);
    const lone = await createVolunteerTask(db, t.lead, taskInput(), NOW);
    await expect(updateVolunteerSeries(db, t.lead, lone.id, { needed: "x" }, false, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(cancelVolunteerSeries(db, t.lead, lone.id, false, NOW)).rejects.toBeInstanceOf(InvalidInput);
  });

  it("cancelling takes the unclaimed future occurrences and asks about the claimed ones", async () => {
    const { s, rows } = await claimedSeries();
    expect(await cancelVolunteerSeries(db, t.lead, s.first.id, false, NOW)).toEqual({ changed: 3, claimedLeft: 1 });
    const left = await listSeriesOccurrences(db, t.lead, s.first.id);
    expect(left.map((o) => o.status)).toEqual(["cancelled", "open", "cancelled", "cancelled"]);
    expect(await cancelVolunteerSeries(db, t.lead, s.first.id, true, NOW)).toEqual({ changed: 1, claimedLeft: 0 });
    const mine = await getMyClaim(db, "nothing", NOW);
    expect(mine).toBeNull();
    expect((await words(rows[1].id)).status).toBe("cancelled");
    expect(addDays("2026-12-01", 1)).toBe("2026-12-02");
  });
});

describe("taking an every-time volunteer off, and the hourly cap on dates", () => {
  it("removes them from every date at once, optionally blocking them from the whole series, and 'every time' then answers like any refusal", async () => {
    const s = await series({ count: 3, peopleNeeded: 2 });
    const rows = (await db.select().from(volunteerTasks).where(eq(volunteerTasks.seriesId, s.seriesId))).sort((a, b) => a.taskDate.localeCompare(b.taskDate));
    const r = await claimEveryTime(db, rows[0].publicToken, vol(), meta(), NOW);
    const other = await claimEveryTime(db, rows[0].publicToken, vol({ contact: "keep@example.test" }), meta(), NOW);
    if (!r.ok || !other.ok) throw new Error("setup");
    const [one] = (await db.select().from(volunteerClaims)).filter((c) => c.contactKey === "sam@example.test");
    const view = await getVolunteerTask(db, t.lead, rows[0].id, NOW);
    expect(view.claims.find((c) => c.id === one.id)?.everyTime).toBe(true);
    for (const a of [t.staff, t.carer, t.senior]) await expect(removeFromAllDates(db, a, one.id, true, NOW)).rejects.toBeInstanceOf(AccessDenied);
    await removeFromAllDates(db, t.lead, one.id, true, NOW);
    const after = await db.select().from(volunteerClaims);
    expect(after.filter((c) => c.contactKey === "sam@example.test").every((c) => c.cancelledBy === "poster")).toBe(true);
    expect(after.filter((c) => c.contactKey === "keep@example.test").every((c) => c.cancelledAt === null)).toBe(true);
    expect(await db.select().from(volunteerTaskBlocks)).toHaveLength(3);
    expect(await claimEveryTime(db, rows[1].publicToken, vol(), meta(), NOW)).toMatchObject({ ok: false, reason: "refused" });
    expect(await claimTask(db, rows[2].publicToken, vol(), meta(), NOW)).toMatchObject({ ok: false, reason: "refused" });
  });

  it("an every-time claim counts as the dates it takes against one hourly cap of 26 for the client, single claims as one", async () => {
    const big = await series({ count: 20, peopleNeeded: 50 });
    const rows = (await db.select().from(volunteerTasks).where(eq(volunteerTasks.seriesId, big.seriesId))).sort((a, b) => a.taskDate.localeCompare(b.taskDate));
    const same = meta("203.0.113.88");
    expect((await claimEveryTime(db, rows[0].publicToken, vol({ contact: "a@example.test" }), same, NOW)).ok).toBe(true);
    const counted = (await db.select().from(mealRateLimits)).find((r) => r.key.startsWith("vol:claim:dates:"));
    expect(counted?.count).toBe(20);
    // 20 more would be 40, past 26: refused, and nothing is taken.
    expect(await claimEveryTime(db, rows[0].publicToken, vol({ contact: "b@example.test" }), same, NOW)).toMatchObject({ ok: false, reason: "rate_limited" });
    expect((await db.select().from(volunteerClaims)).filter((c) => c.contactKey === "b@example.test")).toHaveLength(0);
    // Singles still fit under the cap (20 + 6 = 26), then it stops.
    for (let i = 0; i < 6; i++) expect((await claimTask(db, rows[i].publicToken, vol({ contact: `s${i}@example.test` }), same, NOW)).ok).toBe(true);
    expect(await claimTask(db, rows[7].publicToken, vol({ contact: "s9@example.test" }), same, NOW)).toMatchObject({ ok: false, reason: "rate_limited" });
    // Another client is not held back.
    expect((await claimEveryTime(db, rows[0].publicToken, vol({ contact: "c@example.test" }), meta(), NOW)).ok).toBe(true);
  });
});
