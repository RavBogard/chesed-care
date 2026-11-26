import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied, canSeeVolunteerTask, volunteerTaskVisibleWhere, type Actor } from "@/server/access/policy";
import { createCareItem, updateCareItem } from "@/server/care/care-items";
import { isUuid } from "@/server/care/validate";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { auditLog, careItemAccess, careItems, mealRateLimits, volunteerBringing, volunteerClaims, volunteerGroups, volunteerTaskBlocks, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { TOOLS } from "@/server/mcp/tools";
import { callTool } from "@/server/mcp/transport";
import { tokenHash } from "@/server/meals/tokens";
import { activeCounts } from "@/server/volunteers/core";
import {
  cancelVolunteerSheet,
  cancelVolunteerTask,
  createVolunteerSheet,
  closeLinksForCareItem,
  createVolunteerTask,
  getBoardLink,
  getVolunteerSheet,
  getVolunteerTask,
  listAskAgain,
  listTasksForCareItems,
  listVolunteerTasks,
  markVolunteerTaskDone,
  removeBringing,
  removeClaim,
  replaceBoardLink,
  updateVolunteerTask,
} from "@/server/volunteers/organiser";
import { MAX_BRINGING, addBringing, cancelMyClaim, claimIcs, claimOnSheet, claimTask, getMyClaim, getPublicBoard, getPublicSheet, getPublicTask, markMyClaimDone, VOLUNTEER_LIMITS } from "@/server/volunteers/public";
import { monthsBefore, purgeVolunteerData } from "@/server/volunteers/purge";
import { ACCOUNT, addActor, CONTACT, reporters, team, testDb } from "./support/db";
import { meta, NOW } from "./support/meals";
import { words } from "./support/words";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;

const PLACE = "41 Elm Court, St. Louis";
const CONTACT_LINE = "Ask Dana, 314-555-0100";
const SECRET = "Chemotherapy starts Monday";
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY);
const dateAt = (offsetDays: number) => at(offsetDays).toISOString().slice(0, 10);

const taskInput = (over: Record<string, unknown> = {}) => ({ kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-05", timeWindow: "2 to 4 pm", place: PLACE, contactLine: CONTACT_LINE, ...over });
const vol = (over: Record<string, unknown> = {}) => ({ firstName: "Sam", lastName: "Katz", contact: "Sam.Katz@Example.test", note: "Happy to help", mayAskAgain: false, ...over });

async function post(actor: Actor = t.lead, over: Record<string, unknown> = {}) {
  const view = await createVolunteerTask(db, actor, taskInput(over), NOW);
  if (!view.publicToken) throw new Error("no link");
  return { ...view, token: view.publicToken };
}

async function claim(token: string, over: Record<string, unknown> = {}, now = NOW) {
  const r = await claimTask(db, token, vol(over), meta(), now);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}

async function restrictedItem(owner: Actor = t.clergy) {
  return createCareItem(db, owner, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SECRET, restricted: true });
}

beforeEach(async () => {
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});

describe("who may post, see and manage", () => {
  it("owner, clergy and leads post; staff, caregivers and senior staff cannot do anything", async () => {
    for (const actor of [t.owner, t.clergy, t.lead]) expect((await createVolunteerTask(db, actor, taskInput(), NOW)).status).toBe("open");
    const task = await post(t.clergy);
    for (const actor of [t.staff, t.carer, t.senior]) {
      await expect(createVolunteerTask(db, actor, taskInput(), NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(createVolunteerSheet(db, actor, { title: "x", evenings: [{ date: "2026-12-05" }] }, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(listVolunteerTasks(db, actor, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(getVolunteerTask(db, actor, task.id, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(getBoardLink(db, actor)).rejects.toBeInstanceOf(AccessDenied);
      await expect(listAskAgain(db, actor)).rejects.toBeInstanceOf(AccessDenied);
      expect(await listTasksForCareItems(db, actor, [task.id], NOW)).toEqual([]);
    }
  });

  it("owner, clergy and lead see and manage each other's unrestricted tasks; a past date and bad input are refused", async () => {
    const mine = await post(t.lead);
    const theirs = await post(t.clergy, { forLabel: "Dov" });
    for (const actor of [t.owner, t.clergy2, t.lead]) {
      const list = await listVolunteerTasks(db, actor, NOW);
      expect(list.tasks.map((x) => x.id).sort()).toEqual([mine.id, theirs.id].sort());
    }
    expect((await getVolunteerTask(db, t.lead, theirs.id, NOW)).forLabel).toBe("Dov");
    expect((await updateVolunteerTask(db, t.clergy, mine.id, { needed: "A short call" }, NOW)).needed).toBe("A short call");
    await expect(createVolunteerTask(db, t.lead, taskInput({ date: "2026-11-30" }), NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(createVolunteerTask(db, t.lead, taskInput({ kind: "gardening" }), NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(createVolunteerTask(db, t.lead, { ...taskInput(), extra: 1 }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(createVolunteerTask(db, t.lead, taskInput({ forLabel: "R‮uth" }), NOW)).rejects.toBeInstanceOf(InvalidInput);
  });

  it("a task for a care item shows clergy the link and tasks; a lead sees the task and never the care item, nor can link one", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SECRET });
    const linked = await createVolunteerTask(db, t.clergy, taskInput({ careItemId: item.id }), NOW);
    expect(linked.careItemId).toBe(item.id);
    const asLead = await getVolunteerTask(db, t.lead, linked.id, NOW);
    expect(asLead.careItemId).toBeNull();
    expect(JSON.stringify(asLead)).not.toContain(item.id);
    expect(JSON.stringify(asLead)).not.toContain(SECRET);
    await expect(createVolunteerTask(db, t.lead, taskInput({ careItemId: item.id }), NOW)).rejects.toBeInstanceOf(NotFound);
    expect((await listTasksForCareItems(db, t.clergy2, [item.id], NOW)).map((x) => x.id)).toEqual([linked.id]);
    // The task never carries anything of the record.
    const [row] = await db.select().from(volunteerTasks).where(eq(volunteerTasks.id, linked.id));
    expect(words(row)).not.toMatch(/illness|Chemotherapy|Cohen/);
  });

  it("a task on a RESTRICTED care item is made only by someone with full access and seen only by its creator and those with full access", async () => {
    const item = await restrictedItem(t.clergy);
    // No role overrides: the owner, another clergy, a lead cannot make one.
    for (const actor of [t.owner, t.clergy2, t.lead]) await expect(createVolunteerTask(db, actor, taskInput({ careItemId: item.id }), NOW)).rejects.toBeInstanceOf(NotFound);
    const task = await createVolunteerTask(db, t.clergy, taskInput({ careItemId: item.id }), NOW);
    const sheet = await createVolunteerSheet(db, t.clergy, { title: "the Cohen family", evenings: [{ date: "2026-12-05" }], careItemId: item.id }, NOW);
    for (const actor of [t.owner, t.clergy2, t.lead]) {
      await expect(getVolunteerTask(db, actor, task.id, NOW)).rejects.toBeInstanceOf(NotFound);
      await expect(getVolunteerSheet(db, actor, sheet.id, NOW)).rejects.toBeInstanceOf(NotFound);
      await expect(cancelVolunteerTask(db, actor, task.id, NOW)).rejects.toBeInstanceOf(NotFound);
      const list = await listVolunteerTasks(db, actor, NOW);
      expect(list.tasks).toEqual([]);
      expect(list.sheets).toEqual([]);
      expect(await listTasksForCareItems(db, actor, [item.id], NOW)).toEqual([]);
    }
    // Named on the item, a colleague has full access and so sees it.
    await db.insert(careItemAccess).values({ careItemId: item.id, userId: t.clergy2.id });
    expect((await getVolunteerTask(db, t.clergy2, task.id, NOW)).careItemId).toBe(item.id);
    expect((await listVolunteerTasks(db, t.clergy2, NOW)).tasks.map((x) => x.id)).toEqual([task.id]);
    const another = await createVolunteerTask(db, t.clergy2, taskInput({ careItemId: item.id }), NOW);
    expect(another.id).not.toBe(task.id);
    // The creator keeps sight of their own.
    expect((await getVolunteerTask(db, t.clergy, task.id, NOW)).id).toBe(task.id);
  });

  it("the predicate and the SQL condition agree over the same rows", async () => {
    const open = await restrictedItem(t.clergy);
    await createVolunteerTask(db, t.clergy, taskInput({ careItemId: open.id }), NOW);
    await post(t.lead);
    await post(t.clergy2);
    const rows = await db.select({ task: volunteerTasks, item: careItems }).from(volunteerTasks).leftJoin(careItems, eq(careItems.id, volunteerTasks.careItemId));
    for (const actor of [t.owner, t.clergy, t.clergy2, t.lead, t.staff, t.carer, t.senior]) {
      const sqlIds = (await db.select({ id: volunteerTasks.id }).from(volunteerTasks).where(volunteerTaskVisibleWhere(actor))).map((r) => r.id).sort();
      const predicateIds = rows
        .filter((r) => canSeeVolunteerTask(actor, { createdBy: r.task.createdBy, careItem: r.item ? { ownerUserId: r.item.ownerUserId, restricted: r.item.restricted, named: false } : null }))
        .map((r) => r.task.id)
        .sort();
      expect(sqlIds, actor.email).toEqual(predicateIds);
    }
  });
});

describe("the public task link", () => {
  it("shows an allow-list: never the place, the contact line, the poster, a care item, a link token or a volunteer", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SECRET });
    const task = await createVolunteerTask(db, t.clergy, taskInput({ careItemId: item.id }), NOW);
    await claim(task.publicToken!);
    const pub = await getPublicTask(db, task.publicToken, NOW);
    expect(Object.keys(pub!).sort()).toEqual(["congregation", "date", "everyTimeDates", "forLabel", "kind", "needed", "past", "peopleNeeded", "placesLeft", "taken", "timeWindow"]);
    expect(pub).toMatchObject({ congregation: "Central Reform Congregation", kind: "visit", forLabel: "Ruth", date: "2026-12-05", timeWindow: "2 to 4 pm", peopleNeeded: 1, taken: 1, placesLeft: 0, past: false });
    const text = JSON.stringify(pub);
    for (const leak of [PLACE, "Elm", CONTACT_LINE, "314", "Sam", "Katz", "example.test", "Happy to help", item.id, task.id, task.publicToken!, t.clergy.id, SECRET, "illness", "Cohen"]) expect(text, leak).not.toContain(leak);
  });

  it("unknown, cancelled, done and expired links all answer the same: nothing", async () => {
    const a = await post();
    const b = await post();
    const c = await post();
    await cancelVolunteerTask(db, t.lead, a.id, NOW);
    await markVolunteerTaskDone(db, t.lead, b.id, NOW);
    expect(await getPublicTask(db, "no-such-token", NOW)).toBeNull();
    expect(await getPublicTask(db, undefined, NOW)).toBeNull();
    expect(await getPublicTask(db, a.token, NOW)).toBeNull();
    expect(await getPublicTask(db, b.token, NOW)).toBeNull();
    // The link works through the day after the date, then stops.
    expect((await getPublicTask(db, c.token, at(4)))?.past).toBe(false);
    expect((await getPublicTask(db, c.token, at(5)))?.past).toBe(true);
    expect(await getPublicTask(db, c.token, at(6))).toBeNull();
    const refusals = [await claimTask(db, "no-such-token", vol(), meta(), NOW), await claimTask(db, a.token, vol(), meta(), NOW), await claimTask(db, c.token, vol(), meta(), at(6))];
    for (const r of refusals) expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("a shiva minyan defaults to ten; any other kind to one", async () => {
    expect((await post(t.lead, { kind: "shiva_minyan" })).peopleNeeded).toBe(10);
    expect((await post(t.lead, { kind: "call" })).peopleNeeded).toBe(1);
    expect((await post(t.lead, { kind: "ride", peopleNeeded: 3 })).peopleNeeded).toBe(3);
  });
});

describe("claiming", () => {
  it("gives the place, time, contact line and a calendar file once, and a personal link that stores only its hash", async () => {
    const task = await post();
    const r = await claim(task.token);
    expect(r.details).toMatchObject({ place: PLACE, timeWindow: "2 to 4 pm", contactLine: CONTACT_LINE, date: "2026-12-05" });
    const [row] = await db.select().from(volunteerClaims);
    expect(row).toMatchObject({ firstName: "Sam", lastName: "Katz", contact: "sam.katz@example.test", mayAskAgain: false });
    expect(row.manageTokenHash).toBe(tokenHash(r.manageToken));
    expect(JSON.stringify(row)).not.toContain(r.manageToken);
    const mine = await getMyClaim(db, r.manageToken, NOW);
    expect(mine).toMatchObject({ state: "active", details: { place: PLACE } });
    const ics = await claimIcs(db, r.manageToken, NOW);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261205");
    expect(ics).toContain("LOCATION:41 Elm Court\\, St. Louis");
    expect(words(ics)).not.toMatch(/Sam|Katz|example|314|Happy/);
    expect(await getMyClaim(db, "bogus", NOW)).toBeNull();
    expect(await claimIcs(db, "bogus", NOW)).toBeNull();
  });

  it("accepts an email or a mobile number in the one field, and refuses neither", async () => {
    const task = await post(t.lead, { peopleNeeded: 5 });
    await claim(task.token, { contact: "(314) 555-0199" });
    await claim(task.token, { contact: "sam@example.test", firstName: "Sue" });
    for (const contact of ["", "not a contact", "12", "a@b", "314-555-01ab"]) {
      expect(await claimTask(db, task.token, vol({ contact }), meta(), NOW)).toEqual({ ok: false, reason: "invalid", fields: ["contact"] });
    }
    expect(await claimTask(db, task.token, vol({ firstName: "" }), meta(), NOW)).toMatchObject({ ok: false, reason: "invalid", fields: ["firstName"] });
    expect(await claimTask(db, task.token, { ...vol(), surprise: 1 }, meta(), NOW)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("is refused kindly when full, already taken by the same person, past, or the contact is blocked; and by a bot", async () => {
    const task = await post(t.lead, { peopleNeeded: 2 });
    await claim(task.token, { contact: "a@example.test", firstName: "A" });
    expect(await claimTask(db, task.token, vol({ contact: "A@example.test" }), meta(), NOW)).toEqual({ ok: false, reason: "refused" });
    await claim(task.token, { contact: "b@example.test", firstName: "B" });
    expect(await claimTask(db, task.token, vol({ contact: "c@example.test" }), meta(), NOW)).toEqual({ ok: false, reason: "full" });
    // A cancellation opens the place again.
    const [b] = await db.select().from(volunteerClaims).where(eq(volunteerClaims.contact, "b@example.test"));
    await removeClaim(db, t.lead, b.id, true, NOW);
    expect(await claimTask(db, task.token, vol({ contact: "B@example.test" }), meta(), NOW)).toEqual({ ok: false, reason: "refused" });
    expect(await claimTask(db, task.token, vol({ contact: "(314) 555 0100" }), meta("203.0.113.9"), NOW)).toMatchObject({ ok: true });
    // The date has passed, the link still opens for a day.
    const late = await post();
    expect(await claimTask(db, late.token, vol(), meta(), at(5))).toEqual({ ok: false, reason: "past" });
    // Honeypot, and a form filled too fast.
    const fresh = await post();
    expect(await claimTask(db, fresh.token, vol(), { clientKey: "198.51.100.200", honeypot: "http://spam", elapsedMs: 9000 }, NOW)).toEqual({ ok: false, reason: "refused" });
    expect(await claimTask(db, fresh.token, vol(), { clientKey: "198.51.100.201", honeypot: "", elapsedMs: 300 }, NOW)).toEqual({ ok: false, reason: "refused" });
    expect(await claimTask(db, fresh.token, vol(), { clientKey: "198.51.100.202", honeypot: "" }, NOW)).toEqual({ ok: false, reason: "refused" });
    expect(await claimTask(db, fresh.token, vol(), null, NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await getPublicTask(db, fresh.token, NOW)).toMatchObject({ taken: 0 });
  });

  it("two people cannot take the last place", async () => {
    const task = await post();
    const results = await Promise.all([claimTask(db, task.token, vol({ contact: "x@example.test" }), meta(), NOW), claimTask(db, task.token, vol({ contact: "y@example.test" }), meta(), NOW)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([{ reason: "full" }]);
    expect((await activeCounts(db, [task.id])).get(task.id)).toBe(1);
  });

  it("limits one client per hour, and a per-task cap that only successful claims count toward", async () => {
    const task = await post(t.lead, { peopleNeeded: 50 });
    const same = meta("198.51.100.77");
    for (let i = 0; i < VOLUNTEER_LIMITS.claimPerClient; i++) expect(await claimTask(db, task.token, vol({ firstName: "" }), same, NOW)).toMatchObject({ reason: "invalid" });
    expect(await claimTask(db, task.token, vol(), same, NOW)).toEqual({ ok: false, reason: "rate_limited" });
    // The same client may try again next hour.
    expect(await claimTask(db, task.token, vol(), same, new Date(NOW.getTime() + 3_700_000))).toMatchObject({ ok: true });
    // Junk from many clients never counts against the task.
    const [{ before }] = await db.select({ before: sql<number>`coalesce(sum(count), 0)::int` }).from(mealRateLimits).where(sql`key like ${"vol:claim:task:%"}`);
    for (let i = 0; i < 60; i++) await claimTask(db, task.token, vol({ lastName: "" }), meta(), NOW);
    const [{ after }] = await db.select({ after: sql<number>`coalesce(sum(count), 0)::int` }).from(mealRateLimits).where(sql`key like ${"vol:claim:task:%"}`);
    expect(after).toBe(before);
    // Successful claims do: after the cap, even a valid claim is held.
    let ok = 0;
    for (let i = 0; i < VOLUNTEER_LIMITS.claimPerTask + 2; i++) {
      const r = await claimTask(db, task.token, vol({ contact: `v${i}@example.test`, firstName: `V${i}` }), meta(), at(0));
      if (r.ok) ok++;
      else expect(r.reason).toBe("rate_limited");
    }
    expect(ok).toBe(VOLUNTEER_LIMITS.claimPerTask);
  });

  it("every claim and cancellation is an audit row of ids only, written in the same transaction", async () => {
    const task = await post();
    const r = await claim(task.token, { note: "Secret note", contact: "audit@example.test" });
    await cancelMyClaim(db, r.manageToken, meta(), NOW);
    const rows = (await db.select().from(auditLog)).filter((x) => x.action.startsWith("volunteer_claim"));
    expect(rows.map((x) => x.action).sort()).toEqual(["volunteer_claim.cancel", "volunteer_claim.create"]);
    for (const row of rows) {
      expect(row.actorUserId).toBeNull();
      expect(row.subjectId).toBe(r.claimId);
      expect(row.detail).toMatchObject({ by: "volunteer", volunteerTaskId: task.id });
      for (const [key, value] of Object.entries(row.detail as Record<string, unknown>)) expect(["by", "volunteerTaskId", "volunteerGroupId"].includes(key) && (key === "by" || isUuid(value)), key).toBe(true);
    }
    const text = JSON.stringify(rows);
    for (const leak of ["Sam", "Katz", "example", "Secret", PLACE, r.manageToken, task.token]) expect(text, leak).not.toContain(leak);

    // A failing audit write undoes the change it records.
    await db.execute(sql`alter table audit_log add constraint no_claim check (action <> 'volunteer_claim.create') not valid`);
    const other = await post();
    await expect(claimTask(db, other.token, vol(), meta(), NOW)).rejects.toBeTruthy();
    expect((await activeCounts(db, [other.id])).get(other.id) ?? 0).toBe(0);
    await db.execute(sql`alter table audit_log drop constraint no_claim`);
    const again = await claim(other.token);
    await db.execute(sql`alter table audit_log add constraint no_cancel check (action <> 'volunteer_claim.cancel') not valid`);
    await expect(cancelMyClaim(db, again.manageToken, meta(), NOW)).rejects.toBeTruthy();
    expect(await getMyClaim(db, again.manageToken, NOW)).toMatchObject({ state: "active" });
  });
});

describe("the personal link", () => {
  it("cancels once, refuses once the date has passed, and the task opens again", async () => {
    const task = await post();
    const r = await claim(task.token);
    expect(await cancelMyClaim(db, r.manageToken, meta(), NOW)).toEqual({ ok: true });
    expect(await cancelMyClaim(db, r.manageToken, meta(), NOW)).toEqual({ ok: true });
    expect(await getMyClaim(db, r.manageToken, NOW)).toEqual({ state: "cancelled", kind: "visit", forLabel: "Ruth", date: "2026-12-05" });
    expect(await getPublicTask(db, task.token, NOW)).toMatchObject({ placesLeft: 1 });
    expect(await markMyClaimDone(db, r.manageToken, "x", meta(), NOW)).toEqual({ ok: false, reason: "closed" });
    expect(await claimIcs(db, r.manageToken, NOW)).toBeNull();
    const late = await claim((await post()).token);
    expect(await cancelMyClaim(db, late.manageToken, meta(), at(5))).toEqual({ ok: false, reason: "closed" });
    expect(await cancelMyClaim(db, "bogus", meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
  });

  it("marks done once with an optional note the poster reads; never after cancel; a cancelled task shows no place", async () => {
    const task = await post();
    const r = await claim(task.token);
    expect(await markMyClaimDone(db, r.manageToken, "Ruth was glad of the company", meta(), at(5))).toEqual({ ok: true });
    expect(await markMyClaimDone(db, r.manageToken, "again", meta(), at(5))).toEqual({ ok: false, reason: "closed" });
    expect(await cancelMyClaim(db, r.manageToken, meta(), NOW)).toEqual({ ok: false, reason: "closed" });
    expect((await getVolunteerTask(db, t.lead, task.id, at(5))).claims[0]).toMatchObject({ doneNote: "Ruth was glad of the company", firstName: "Sam", contact: "sam.katz@example.test" });
    expect(await markMyClaimDone(db, r.manageToken, "x".repeat(300), meta(), at(5))).toMatchObject({ ok: false });

    const second = await post();
    const s = await claim(second.token);
    await cancelVolunteerTask(db, t.lead, second.id, NOW);
    const view = await getMyClaim(db, s.manageToken, NOW);
    expect(view).toEqual({ state: "task_cancelled", kind: "visit", forLabel: "Ruth", date: "2026-12-05" });
    expect(JSON.stringify(view)).not.toContain(PLACE);
    expect(await claimIcs(db, s.manageToken, NOW)).toBeNull();
  });

  it("is dead after the purge, whatever the volunteer chose", async () => {
    const task = await post();
    const keep = await claim(task.token, { mayAskAgain: true });
    const lose = await claim((await post()).token, { contact: "z@example.test" });
    await purgeVolunteerData(db, at(40));
    for (const r of [keep, lose]) {
      expect(await getMyClaim(db, r.manageToken, at(40))).toBeNull();
      expect(await cancelMyClaim(db, r.manageToken, meta(), at(40))).toEqual({ ok: false, reason: "not_found" });
      expect(await markMyClaimDone(db, r.manageToken, null, meta(), at(40))).toEqual({ ok: false, reason: "not_found" });
      expect(await claimIcs(db, r.manageToken, at(40))).toBeNull();
    }
  });
});

describe("the poster's view of claims", () => {
  it("shows who claimed, removes a claim (optionally blocking the contact), and lists past helpers who said ask me again", async () => {
    const task = await post(t.lead, { peopleNeeded: 3 });
    await claim(task.token, { firstName: "Ann", contact: "ann@example.test", mayAskAgain: true });
    await claim(task.token, { firstName: "Ben", contact: "ben@example.test", mayAskAgain: true });
    await claim(task.token, { firstName: "Cy", contact: "cy@example.test", mayAskAgain: false });
    const view = await getVolunteerTask(db, t.clergy, task.id, NOW);
    expect(view.claims.map((c) => c.firstName).sort()).toEqual(["Ann", "Ben", "Cy"]);
    expect(view).toMatchObject({ taken: 3, placesLeft: 0 });
    const ben = view.claims.find((c) => c.firstName === "Ben")!;
    const removed = await removeClaim(db, t.clergy, ben.id, true, NOW);
    expect(removed).toMatchObject({ taken: 2, placesLeft: 1 });
    expect(removed.claims.find((c) => c.id === ben.id)).toMatchObject({ cancelledBy: "poster" });
    expect(await db.select().from(volunteerTaskBlocks)).toMatchObject([{ taskId: task.id, contactKey: "ben@example.test" }]);
    await expect(removeClaim(db, t.clergy, ben.id, false, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(removeClaim(db, t.staff, ben.id, false, NOW)).rejects.toBeInstanceOf(AccessDenied);
    // Ask-again: Ann only (Ben was removed, Cy did not tick).
    for (const actor of [t.owner, t.clergy, t.lead]) expect((await listAskAgain(db, actor)).map((h) => h.firstName)).toEqual(["Ann"]);
    expect((await listAskAgain(db, t.lead))[0]).toEqual({ firstName: "Ann", lastName: "Katz", contact: "ann@example.test", lastDate: "2026-12-05" });
    // Cannot lower the count below those holding places.
    await expect(updateVolunteerTask(db, t.lead, task.id, { peopleNeeded: 1 }, NOW)).rejects.toBeInstanceOf(InvalidInput);
  });

  it("an ask-again list never includes tasks the actor cannot see (a restricted item's)", async () => {
    const item = await restrictedItem(t.clergy);
    const secret = await createVolunteerTask(db, t.clergy, taskInput({ careItemId: item.id }), NOW);
    await claim(secret.publicToken!, { mayAskAgain: true, contact: "hidden@example.test" });
    expect(await listAskAgain(db, t.lead)).toEqual([]);
    expect(await listAskAgain(db, t.clergy2)).toEqual([]);
    expect((await listAskAgain(db, t.clergy)).map((h) => h.contact)).toEqual(["hidden@example.test"]);
  });

  it("lists tasks that need people first (untaken first), then filled, then finished", async () => {
    await post(t.lead, { forLabel: "E" });
    const part = await post(t.lead, { forLabel: "P", peopleNeeded: 2 });
    const full = await post(t.lead, { forLabel: "F" });
    const done = await post(t.lead, { forLabel: "D" });
    const gone = await post(t.lead, { forLabel: "G" });
    await claim(part.token);
    await claim(full.token);
    await markVolunteerTaskDone(db, t.lead, done.id, NOW);
    await cancelVolunteerTask(db, t.lead, gone.id, NOW);
    const list = await listVolunteerTasks(db, t.lead, NOW);
    expect(list.tasks.map((x) => [x.forLabel, x.section])).toEqual([["E", "needs_people"], ["P", "needs_people"], ["F", "filled"], ["D", "finished"], ["G", "finished"]]);
  });
});

describe("the board link", () => {
  it("lists only that lead's open, non-restricted tasks that still have a place: first names, kind, date and places left", async () => {
    const mine = await post(t.lead, { forLabel: "Ruth", peopleNeeded: 2 });
    await post(t.lead, { forLabel: "Moe", kind: "ride", date: "2026-12-03" });
    const full = await post(t.lead, { forLabel: "Full" });
    const cancelled = await post(t.lead, { forLabel: "Cancelled" });
    await post(t.lead, { forLabel: "Today", date: "2026-12-01" });
    await post(t.clergy, { forLabel: "NotMine" });
    await claim(mine.token);
    await claim(full.token);
    await cancelVolunteerTask(db, t.lead, cancelled.id, NOW);
    // A task on a restricted item, even by this lead's own hand (as it could only be by clergy), never appears on a board.
    const item = await restrictedItem(t.clergy);
    await createVolunteerTask(db, t.clergy, taskInput({ forLabel: "Hidden", careItemId: item.id }), NOW);
    const clergyBoard = await getBoardLink(db, t.clergy);
    const leadBoard = await getBoardLink(db, t.lead);
    expect(await getBoardLink(db, t.lead)).toEqual(leadBoard);
    const board = await getPublicBoard(db, leadBoard.token, NOW);
    expect(board!.items.map((i) => [i.forLabel, i.kind, i.date, i.placesLeft])).toEqual([
      ["Today", "visit", "2026-12-01", 1],
      ["Moe", "ride", "2026-12-03", 1],
      ["Ruth", "visit", "2026-12-05", 1],
    ]);
    expect(Object.keys(board!.items[0]).sort()).toEqual(["date", "forLabel", "href", "kind", "placesLeft", "timeWindow"]);
    const text = JSON.stringify(board);
    for (const leak of [PLACE, CONTACT_LINE, "Sam", "NotMine", "Hidden", "Full", "Cancelled", t.lead.id, t.lead.email]) expect(text, leak).not.toContain(leak);
    expect(board!.items.find((i) => i.forLabel === "Ruth")!.href).toBe(`/v/${mine.token}`);
    // Clergy's board holds clergy's tasks, and not the restricted one either.
    expect((await getPublicBoard(db, clergyBoard.token, NOW))!.items.map((i) => i.forLabel)).toEqual(["NotMine"]);
    expect(await getPublicBoard(db, "nope", NOW)).toBeNull();
  });
});

describe("the shiva sheet", () => {
  const sheetInput = (over: Record<string, unknown> = {}) => ({ title: "the Cohen family", place: PLACE, contactLine: CONTACT_LINE, evenings: [{ date: "2026-12-03", timeWindow: "7 pm" }, { date: "2026-12-04" }], ...over });

  it("makes one minyan slot per evening counting toward ten; a claim reveals the place; one link for the whole sheet", async () => {
    const sheet = await createVolunteerSheet(db, t.lead, sheetInput(), NOW);
    expect(sheet.evenings.map((e) => [e.date, e.kind, e.peopleNeeded, e.publicToken])).toEqual([["2026-12-03", "shiva_minyan", 10, null], ["2026-12-04", "shiva_minyan", 10, null]]);
    const pub = await getPublicSheet(db, sheet.publicToken, NOW);
    expect(pub).toMatchObject({ title: "the Cohen family", evenings: [{ date: "2026-12-03", taken: 0, peopleNeeded: 10, placesLeft: 10 }, { date: "2026-12-04" }], bringing: [] });
    expect(words(pub)).not.toMatch(/Elm|314|Sam|example/);
    for (let i = 0; i < 3; i++) {
      const r = await claimOnSheet(db, sheet.publicToken, pub!.evenings[0].taskId, vol({ contact: `p${i}@example.test`, firstName: `P${i}` }), meta(), NOW);
      expect(r).toMatchObject({ ok: true, details: { place: PLACE, kind: "shiva_minyan" } });
    }
    expect((await getPublicSheet(db, sheet.publicToken, NOW))!.evenings.map((e) => [e.taken, e.placesLeft])).toEqual([[3, 7], [0, 10]]);
    expect(words(await getPublicSheet(db, sheet.publicToken, NOW))).not.toMatch(/P0|p0@/);
    // An evening of someone else's sheet is not claimable through this one.
    const other = await createVolunteerSheet(db, t.lead, sheetInput({ title: "the Baum family" }), NOW);
    const otherPub = await getPublicSheet(db, other.publicToken, NOW);
    expect(await claimOnSheet(db, sheet.publicToken, otherPub!.evenings[0].taskId, vol(), meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
    expect(await claimOnSheet(db, "nope", pub!.evenings[0].taskId, vol(), meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
    expect(await claimOnSheet(db, sheet.publicToken, "not-a-uuid", vol(), meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
    // Full at ten.
    for (let i = 3; i < 10; i++) await claimOnSheet(db, sheet.publicToken, pub!.evenings[0].taskId, vol({ contact: `p${i}@example.test` }), meta(), NOW);
    expect(await claimOnSheet(db, sheet.publicToken, pub!.evenings[0].taskId, vol({ contact: "late@example.test" }), meta(), NOW)).toEqual({ ok: false, reason: "full" });
  });

  it("lets volunteers add 'bringing' lines with a first name and the poster remove any; cancelling stops the link", async () => {
    const sheet = await createVolunteerSheet(db, t.clergy, sheetInput(), NOW);
    expect(await addBringing(db, sheet.publicToken, { firstName: "Ann", line: "Kugel for Thursday" }, meta(), NOW)).toEqual({ ok: true });
    expect(await addBringing(db, sheet.publicToken, { firstName: "Ben", line: "Paper plates", lastName: "x" }, meta(), NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await addBringing(db, sheet.publicToken, { firstName: "Ben", line: "Paper plates" }, { clientKey: "198.51.100.5", honeypot: "x", elapsedMs: 9000 }, NOW)).toEqual({ ok: false, reason: "refused" });
    expect(await addBringing(db, "nope", { firstName: "Ben", line: "Plates" }, meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
    expect((await getPublicSheet(db, sheet.publicToken, NOW))!.bringing).toEqual([{ firstName: "Ann", line: "Kugel for Thursday" }]);
    const [line] = (await getVolunteerSheet(db, t.lead, sheet.id, NOW)).bringing;
    await expect(removeBringing(db, t.staff, sheet.id, line.id, NOW)).rejects.toBeInstanceOf(AccessDenied);
    expect((await removeBringing(db, t.lead, sheet.id, line.id, NOW)).bringing).toEqual([]);
    expect(await db.select().from(volunteerBringing)).toEqual([]);
    const rows = (await db.select().from(auditLog)).filter((r) => r.action.startsWith("volunteer_bringing"));
    expect(rows.map((r) => r.action).sort()).toEqual(["volunteer_bringing.add", "volunteer_bringing.remove"]);
    expect(words(rows)).not.toMatch(/Ann|Kugel/);
    await cancelVolunteerSheet(db, t.lead, sheet.id, NOW);
    expect(await getPublicSheet(db, sheet.publicToken, NOW)).toBeNull();
    expect(await addBringing(db, sheet.publicToken, { firstName: "Ann", line: "Kugel" }, meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
  });

  it("an evening on the board links to the sheet; per-client limit holds on bringing lines", async () => {
    const sheet = await createVolunteerSheet(db, t.lead, sheetInput(), NOW);
    const board = await getPublicBoard(db, (await getBoardLink(db, t.lead)).token, NOW);
    expect(board!.items.map((i) => i.href)).toEqual([`/v/s/${sheet.publicToken}`, `/v/s/${sheet.publicToken}`]);
    const same = meta("198.51.100.99");
    for (let i = 0; i < VOLUNTEER_LIMITS.bringOkPerClientPerSheet; i++) expect(await addBringing(db, sheet.publicToken, { firstName: "A", line: `L${i}` }, same, NOW)).toEqual({ ok: true });
    expect(await addBringing(db, sheet.publicToken, { firstName: "A", line: "more" }, same, NOW)).toEqual({ ok: false, reason: "rate_limited" });
    // Another client may add; the sheet holds 40 lines in all.
    for (let i = 0; i < MAX_BRINGING - 3; i++) expect(await addBringing(db, sheet.publicToken, { firstName: "B", line: `M${i}` }, meta(), NOW)).toEqual({ ok: true });
    expect(await addBringing(db, sheet.publicToken, { firstName: "C", line: "one too many" }, meta(), NOW)).toEqual({ ok: false, reason: "full" });
    expect(await db.select().from(volunteerBringing)).toHaveLength(MAX_BRINGING);
  });
});

describe("the daily purge", () => {
  async function dated(offset: number, over: Record<string, unknown> = {}) {
    // Posted on the day itself, then the clock is moved forward to the day of the purge.
    const view = await createVolunteerTask(db, t.lead, taskInput({ date: dateAt(offset), ...over }), at(offset));
    return { ...view, token: view.publicToken! };
  }

  it("deletes contact details 30 days after the task date, keeps those who said ask me again, and not a day sooner", async () => {
    const young = await dated(-29, { peopleNeeded: 3 });
    const old = await dated(-31, { peopleNeeded: 3 });
    const edge = await dated(-30, { peopleNeeded: 3 });
    // Claimed on the task's own day, as a volunteer would.
    const claimsFor = async (task: { token: string; date: string }) => {
      const when = new Date(`${task.date}T18:00:00Z`);
      await claim(task.token, { contact: "gone@example.test", firstName: "Gone" }, when);
      await claim(task.token, { contact: "kept@example.test", firstName: "Kept", mayAskAgain: true }, when);
    };
    for (const task of [young, old, edge]) await claimsFor(task);
    const counts = await purgeVolunteerData(db, NOW);
    const state = async (task: { id: string }) => (await db.select().from(volunteerClaims).where(eq(volunteerClaims.taskId, task.id))).map((c) => ({ first: c.firstName, contact: c.contact, note: c.note, hash: c.manageTokenHash !== null, purged: c.purgedAt !== null })).sort((a, b) => String(a.first).localeCompare(String(b.first)));
    expect(await state(young)).toEqual([
      { first: "Gone", contact: "gone@example.test", note: "Happy to help", hash: true, purged: false },
      { first: "Kept", contact: "kept@example.test", note: "Happy to help", hash: true, purged: false },
    ]);
    for (const task of [old, edge]) {
      expect(await state(task)).toEqual([
        { first: null, contact: null, note: null, hash: false, purged: true },
        { first: "Kept", contact: "kept@example.test", note: null, hash: false, purged: true },
      ].sort((a, b) => String(a.first).localeCompare(String(b.first))));
    }
    expect(counts.claims).toBe(4);
    // The younger task still has its place and link; the older ones lost both.
    const [y] = await db.select().from(volunteerTasks).where(eq(volunteerTasks.id, young.id));
    expect(y).toMatchObject({ place: PLACE, contactLine: CONTACT_LINE });
    expect(y.publicTokenHash).not.toBeNull();
    for (const task of [old, edge]) {
      const [row] = await db.select().from(volunteerTasks).where(eq(volunteerTasks.id, task.id));
      expect(row).toMatchObject({ place: null, contactLine: null, publicToken: null, publicTokenHash: null });
    }
    // A day later the younger one goes too; a second run changes nothing more.
    expect((await purgeVolunteerData(db, at(2))).claims).toBe(2);
    expect((await purgeVolunteerData(db, at(2)))).toEqual({ claims: 0, tasks: 0, bringing: 0, askAgainExpired: 0 });
    // Those who asked to be asked again are still on the poster's list, the others are not.
    expect((await listAskAgain(db, t.lead)).map((h) => h.contact)).toEqual(["kept@example.test"]);
  });

  it("never keeps a removed or blocked volunteer even if they ticked ask me again; clears where on an old cancelled task", async () => {
    const task = await createVolunteerTask(db, t.lead, taskInput({ date: "2026-12-05", peopleNeeded: 3 }), NOW);
    await claim(task.publicToken!, { contact: "out@example.test", firstName: "Out", mayAskAgain: true });
    await claim(task.publicToken!, { contact: "blocked@example.test", firstName: "Blocked", mayAskAgain: true });
    const [out, blocked] = await db.select().from(volunteerClaims).orderBy(volunteerClaims.createdAt);
    await removeClaim(db, t.lead, out.id, false, NOW);
    // A block recorded without the claim being removed first still forgets that contact.
    await db.insert(volunteerTaskBlocks).values({ taskId: task.id, contactKey: blocked.contactKey!, blockedBy: t.lead.id });
    const future = await createVolunteerTask(db, t.lead, taskInput({ date: "2027-03-01" }), NOW);
    await cancelVolunteerTask(db, t.lead, future.id, NOW);
    await purgeVolunteerData(db, at(29));
    expect((await db.select().from(volunteerTasks).where(eq(volunteerTasks.id, future.id)))[0].place).toBe(PLACE);
    await purgeVolunteerData(db, at(36));
    expect((await db.select().from(volunteerTasks).where(eq(volunteerTasks.id, future.id)))[0]).toMatchObject({ place: null, contactLine: null });
    const claims = await db.select().from(volunteerClaims);
    expect(claims.every((c) => c.contact === null && c.firstName === null)).toBe(true);
    expect(await db.select().from(volunteerTaskBlocks)).toEqual([]);
  });

  it("a cancelled claim's contact goes on the 30-day rule even with ask me again; kept contacts go after 24 months", async () => {
    const task = await createVolunteerTask(db, t.lead, taskInput({ date: "2026-12-05", peopleNeeded: 3 }), NOW);
    const gave = await claim(task.publicToken!, { contact: "gave@example.test", firstName: "Gave", mayAskAgain: true });
    await claim(task.publicToken!, { contact: "kept@example.test", firstName: "Kept", mayAskAgain: true });
    await cancelMyClaim(db, gave.manageToken, meta(), NOW);
    await purgeVolunteerData(db, at(36));
    const rows = await db.select().from(volunteerClaims);
    expect(rows.map((c) => c.contact).sort()).toEqual(["kept@example.test", null]);
    expect((await listAskAgain(db, t.lead)).map((h) => h.contact)).toEqual(["kept@example.test"]);
    // Twenty-three months after the date nothing more goes; after 24 months the kept contact does too.
    expect((await purgeVolunteerData(db, new Date("2028-11-05T18:00:00Z"))).askAgainExpired).toBe(0);
    expect(await db.select().from(volunteerClaims).where(eq(volunteerClaims.firstName, "Kept"))).toHaveLength(1);
    expect((await purgeVolunteerData(db, new Date("2028-12-07T18:00:00Z"))).askAgainExpired).toBe(1);
    expect((await db.select().from(volunteerClaims)).every((c) => c.contact === null)).toBe(true);
    expect(await listAskAgain(db, t.lead)).toEqual([]);
    expect(monthsBefore("2028-02-29", 12)).toBe("2027-02-28");
    expect(monthsBefore("2026-12-01", 24)).toBe("2024-12-01");
  });

  it("deletes a shiva sheet's bringing lines and link only once every evening is old", async () => {
    const sheet = await createVolunteerSheet(db, t.lead, { title: "the Cohen family", place: PLACE, evenings: [{ date: "2026-12-03" }, { date: "2026-12-20" }] }, NOW);
    await addBringing(db, sheet.publicToken, { firstName: "Ann", line: "Kugel" }, meta(), NOW);
    await purgeVolunteerData(db, new Date(NOW.getTime() + 40 * DAY));
    expect(await db.select().from(volunteerBringing)).toHaveLength(1);
    expect((await db.select().from(volunteerGroups))[0].publicTokenHash).not.toBeNull();
    const counts = await purgeVolunteerData(db, new Date(NOW.getTime() + 51 * DAY));
    expect(counts.bringing).toBe(1);
    expect(await db.select().from(volunteerBringing)).toEqual([]);
    expect((await db.select().from(volunteerGroups))[0]).toMatchObject({ publicToken: null, publicTokenHash: null });
    expect(await getPublicSheet(db, sheet.publicToken, new Date(NOW.getTime() + 51 * DAY))).toBeNull();
  });
});

describe("abuse limits on success", () => {
  it("one client cannot fill a minyan (4 an hour per task) nor claim more than 8 an hour across tasks; failures lock nothing", async () => {
    const task = await post(t.lead, { kind: "shiva_minyan" });
    const same = meta("198.51.100.150");
    for (let i = 0; i < 4; i++) expect(await claimTask(db, task.token, vol({ contact: `h${i}@example.test`, firstName: `H${i}` }), same, NOW)).toMatchObject({ ok: true });
    expect(await claimTask(db, task.token, vol({ contact: "h4@example.test" }), same, NOW)).toEqual({ ok: false, reason: "rate_limited" });
    // Others are not held up by that client, and failed attempts never counted against the task.
    expect(await claimTask(db, task.token, vol({ contact: "other@example.test" }), meta(), NOW)).toMatchObject({ ok: true });
    for (let i = 0; i < 10; i++) await claimTask(db, task.token, vol({ firstName: "" }), meta(), NOW);
    expect(await claimTask(db, task.token, vol({ contact: "more@example.test" }), meta(), NOW)).toMatchObject({ ok: true });
    // Across tasks: 4 are already counted, so 4 more on other tasks, then no more anywhere.
    const tasks = [await post(), await post(), await post(), await post(), await post()];
    for (const x of tasks.slice(0, 4)) expect(await claimTask(db, x.token, vol({ contact: "t@example.test" }), same, NOW)).toMatchObject({ ok: true });
    expect(await claimTask(db, tasks[4].token, vol({ contact: "t@example.test" }), same, NOW)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await claimTask(db, tasks[4].token, vol({ contact: "t@example.test" }), same, new Date(NOW.getTime() + 3_700_000))).toMatchObject({ ok: true });
  });

  it("failed attempts from one client do not use up its successful-claim allowance", async () => {
    const task = await post(t.lead, { peopleNeeded: 6 });
    const same = meta("198.51.100.151");
    for (let i = 0; i < 5; i++) await claimTask(db, task.token, vol({ contact: "bad" }), same, NOW);
    for (let i = 0; i < 4; i++) expect(await claimTask(db, task.token, vol({ contact: `ok${i}@example.test` }), same, NOW)).toMatchObject({ ok: true });
  });
});

describe("what a stranger cannot learn, and what ends", () => {
  it("the personal page and calendar show place and contact line only while the task is live; afterwards it says it has passed", async () => {
    const task = await post();
    const r = await claim(task.token);
    expect(await getMyClaim(db, r.manageToken, at(5))).toMatchObject({ state: "active", details: { place: PLACE, contactLine: CONTACT_LINE } });
    expect(await claimIcs(db, r.manageToken, at(5))).toContain("LOCATION");
    const later = await getMyClaim(db, r.manageToken, at(6));
    expect(later).toEqual({ state: "passed", kind: "visit", forLabel: "Ruth", date: "2026-12-05" });
    expect(words(later)).not.toMatch(/Elm|314/);
    expect(await claimIcs(db, r.manageToken, at(6))).toBeNull();
  });

  it("a signed-up contact and a blocked contact get the same refusal as any other", async () => {
    const task = await post(t.lead, { peopleNeeded: 3 });
    await claim(task.token, { contact: "a@example.test" });
    await db.insert(volunteerTaskBlocks).values({ taskId: task.id, contactKey: "blocked@example.test", blockedBy: t.lead.id });
    const signed = await claimTask(db, task.token, vol({ contact: "a@example.test" }), meta(), NOW);
    const blocked = await claimTask(db, task.token, vol({ contact: "blocked@example.test" }), meta(), NOW);
    expect(signed).toEqual({ ok: false, reason: "refused" });
    expect(blocked).toEqual(signed);
  });

  it("the database refuses a second active claim by the same contact on a task", async () => {
    const task = await post(t.lead, { peopleNeeded: 3 });
    await claim(task.token, { contact: "dup@example.test" });
    await expect(db.insert(volunteerClaims).values({ taskId: task.id, firstName: "X", lastName: "Y", contact: "dup@example.test", contactKey: "dup@example.test", manageTokenHash: "h" })).rejects.toBeTruthy();
  });

  it("a poster replaces the board link: the new one works, the old one is dead at once", async () => {
    await post(t.lead, { forLabel: "Moe" });
    const first = await getBoardLink(db, t.lead);
    const second = await replaceBoardLink(db, t.lead);
    expect(second.token).not.toBe(first.token);
    expect(await getPublicBoard(db, first.token, NOW)).toBeNull();
    expect((await getPublicBoard(db, second.token, NOW))!.items.map((i) => i.forLabel)).toEqual(["Moe"]);
    expect(await getBoardLink(db, t.lead)).toEqual(second);
    await expect(replaceBoardLink(db, t.staff)).rejects.toBeInstanceOf(AccessDenied);
    const rows = (await db.select().from(auditLog)).filter((r) => r.action === "volunteer_board.replace");
    expect(JSON.stringify(rows)).not.toContain(second.token);
    expect(rows).toHaveLength(1);
  });

  it("when a care item becomes restricted its tasks drop off boards at once, stay open, and its full-access viewers can close the links", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SECRET });
    const task = await createVolunteerTask(db, t.clergy, taskInput({ careItemId: item.id }), NOW);
    const sheet = await createVolunteerSheet(db, t.clergy, { title: "the Cohen family", evenings: [{ date: "2026-12-05" }], careItemId: item.id }, NOW);
    const board = await getBoardLink(db, t.clergy);
    expect((await getPublicBoard(db, board.token, NOW))!.items).toHaveLength(2);
    await updateCareItem(db, t.clergy, item.id, { restricted: true });
    expect((await getPublicBoard(db, board.token, NOW))!.items).toEqual([]);
    // Still open for those who hold the link; the clergy with access are told.
    expect(await getPublicTask(db, task.publicToken, NOW)).not.toBeNull();
    const [row] = await listTasksForCareItems(db, t.clergy, [item.id], NOW);
    expect(row.linkOpen).toBe(true);
    // Someone without full access cannot close them; the item's owner can.
    await expect(closeLinksForCareItem(db, t.clergy2, item.id, NOW)).rejects.toBeInstanceOf(NotFound);
    await expect(closeLinksForCareItem(db, t.lead, item.id, NOW)).rejects.toBeInstanceOf(NotFound);
    expect(await closeLinksForCareItem(db, t.clergy, item.id, NOW)).toBe(2);
    expect(await getPublicTask(db, task.publicToken, NOW)).toBeNull();
    expect(await getPublicSheet(db, sheet.publicToken, NOW)).toBeNull();
    expect((await listTasksForCareItems(db, t.clergy, [item.id], NOW)).every((x) => !x.linkOpen)).toBe(true);
    expect(await closeLinksForCareItem(db, t.clergy, item.id, NOW)).toBe(0);
  });
});

describe("connector", () => {
  const tool = (name: string) => TOOLS.find((x) => x.name === name)!;
  const sf = () => ({ query: async () => [] });
  const call = (name: string, actor: Actor, args: unknown) => callTool(tool(name), args, { db, sf, now: NOW, actor });

  it("clergy and leads post and read; everyone else is refused; no contact details, links or care references come back", async () => {
    const posted = await call("volunteers_post_task", t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date: "2026-12-05", place: PLACE, contactLine: CONTACT_LINE });
    expect(posted.isError).toBe(false);
    const out = posted.structuredContent as { taskId: string; shareInApp: string };
    expect(out).toMatchObject({ posted: true, kind: "visit", peopleNeeded: 1 });
    const [stored] = await db.select().from(volunteerTasks);
    expect(JSON.stringify(out)).not.toContain(stored.publicToken!);
    // No argument links a care item or sets a status.
    for (const extra of [{ careItemId: "x" }, { status: "done" }]) expect((await call("volunteers_post_task", t.lead, { kind: "visit", forLabel: "R", needed: "x", date: "2026-12-05", ...extra })).isError).toBe(true);
    await claim(stored.publicToken!, { mayAskAgain: true });
    for (const actor of [t.clergy, t.owner, t.lead]) {
      const open = await call("volunteers_open_tasks", actor, {});
      expect(open.structuredContent).toEqual({ today: "2026-12-01", tasks: [{ taskId: stored.id, kind: "visit", forLabel: "Ruth", date: "2026-12-05", peopleNeeded: 1, taken: 1, placesLeft: 0 }], shivaSheets: [] });
      const text = JSON.stringify(open.structuredContent);
      for (const leak of ["Sam", "Katz", "example", PLACE, CONTACT_LINE, stored.publicToken!]) expect(text, leak).not.toContain(leak);
    }
    for (const actor of [t.staff, t.carer, t.senior]) {
      expect(await call("volunteers_open_tasks", actor, {})).toMatchObject({ isError: true, content: [{ text: "You do not have access to do that." }] });
      expect((await call("volunteers_post_task", actor, { kind: "visit", forLabel: "R", needed: "x", date: "2026-12-05" })).isError).toBe(true);
    }
    // A clergy member sees no task a restricted item hides.
    const item = await restrictedItem(t.clergy);
    await createVolunteerTask(db, t.clergy, taskInput({ forLabel: "Hidden", careItemId: item.id }), NOW);
    const leadOpen = await call("volunteers_open_tasks", t.lead, {});
    expect(JSON.stringify(leadOpen.structuredContent)).not.toContain("Hidden");
    const ownerOpen = await call("volunteers_open_tasks", t.owner, {});
    expect(JSON.stringify(ownerOpen.structuredContent)).not.toContain("Hidden");
  });
});

describe("helpers", () => {
  it("an inactive board owner's board is gone", async () => {
    const extra = await addActor(db, "lead2@example.test", "lead", true);
    await createVolunteerTask(db, extra, taskInput(), NOW);
    const { token } = await getBoardLink(db, extra);
    expect(await getPublicBoard(db, token, NOW)).not.toBeNull();
    await db.execute(sql`update users set active = false where id = ${extra.id}`);
    expect(await getPublicBoard(db, token, NOW)).toBeNull();
  });
});
