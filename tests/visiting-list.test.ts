import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied, canAssignVisitor, canLogVolunteerVisit, canManageVisitingList, canSeeVisitingList } from "@/server/access/policy";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { auditLog, corpsMembers, outsidePeople, visitingList, visitingVisits } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { createCareItem } from "@/server/care/care-items";
import { fakeSf } from "./support/sf";
import { addMember, markMemberLeft, pauseMember, rosterUpkeep } from "@/server/volunteers/roster";
import { addToVisitingList, endVisitingEntry, listVisiting, listVisitorChoices, logVisit, purgeVisiting, setVisitor, updateVisitingEntry, visitingEntryFor } from "@/server/volunteers/visiting";
import { CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";
import { NOW } from "./support/meals";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const member = (over: Record<string, unknown> = {}) => ({ firstName: "Avi", lastName: "Mor", email: "avi@example.test", mobile: null, canDo: ["visits"], ...over });
const sf = fakeSf();
const add = (actor: Parameters<typeof addToVisitingList>[1], input: Parameters<typeof addToVisitingList>[2]) => addToVisitingList(db, actor, input, { sf: sf.sf, now: NOW });
const outside = async (name: string) => (await db.insert(outsidePeople).values({ name, createdBy: t.clergy.id }).returning())[0];
const entry = (over: Record<string, unknown> = {}) => ({ sfContactId: CONTACT, place: "Maple Care Home, room 4", contactLine: "Her daughter, 314 555 0100", visitorNote: "Likes a chat about music", ...over });

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-visiting-list";
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});

describe("who may use the visiting list", () => {
  it("the policy: clergy level manage; the lead also sees, assigns and logs; nobody else gets anything", () => {
    for (const a of [t.owner, t.clergy]) expect([canManageVisitingList(a), canSeeVisitingList(a), canAssignVisitor(a), canLogVolunteerVisit(a)]).toEqual([true, true, true, true]);
    expect([canManageVisitingList(t.lead), canSeeVisitingList(t.lead), canAssignVisitor(t.lead), canLogVolunteerVisit(t.lead)]).toEqual([false, true, true, true]);
    for (const a of [t.carer, t.staff, t.senior]) expect([canManageVisitingList(a), canSeeVisitingList(a), canAssignVisitor(a), canLogVolunteerVisit(a)]).toEqual([false, false, false, false]);
  });

  it("the lead sees, assigns and logs but cannot add, edit or end; others are refused everything", async () => {
    const { id } = await add(t.clergy, entry());
    const m = await addMember(db, t.lead, member(), NOW);
    expect(await listVisiting(db, t.lead)).toHaveLength(1);
    await setVisitor(db, t.lead, id, m.id, NOW);
    await logVisit(db, t.lead, id, "2026-11-30", NOW);
    await expect(add(t.lead, entry({ sfContactId: CONTACT2 }))).rejects.toBeInstanceOf(AccessDenied);
    await expect(updateVisitingEntry(db, t.lead, id, { place: "x" })).rejects.toBeInstanceOf(AccessDenied);
    await expect(endVisitingEntry(db, t.lead, id, NOW)).rejects.toBeInstanceOf(AccessDenied);
    for (const a of [t.carer, t.staff, t.senior]) {
      await expect(listVisiting(db, a)).rejects.toBeInstanceOf(AccessDenied);
      await expect(listVisitorChoices(db, a, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(add(a, entry({ sfContactId: CONTACT2 }))).rejects.toBeInstanceOf(AccessDenied);
      await expect(setVisitor(db, a, id, m.id, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(logVisit(db, a, id, "2026-11-30", NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(endVisitingEntry(db, a, id, NOW)).rejects.toBeInstanceOf(AccessDenied);
      expect(await visitingEntryFor(db, a, { sfContactId: CONTACT })).toBeNull();
    }
    // Clergy and the owner see on a person's page whether they are on it; the lead does not need to.
    expect(await visitingEntryFor(db, t.owner, { sfContactId: CONTACT })).toBe(id);
    expect(await visitingEntryFor(db, t.lead, { sfContactId: CONTACT })).toBeNull();
  });

  it("clergy add, edit and end; the list shows place, contact, note, visitor, last visit and count", async () => {
    const { id } = await add(t.clergy, entry());
    const m = await addMember(db, t.lead, member(), NOW);
    await setVisitor(db, t.clergy, id, m.id, NOW);
    await logVisit(db, t.clergy, id, "2026-11-20", NOW);
    await logVisit(db, t.lead, id, "2026-11-28", NOW);
    await updateVisitingEntry(db, t.clergy, id, { place: "Oak Court", contactLine: null, visitorNote: null });
    const [e] = await listVisiting(db, t.lead);
    expect(e).toMatchObject({ id, name: "Ruth Cohen", place: "Oak Court", contactLine: null, visitorNote: null, visitorName: "Avi Mor", lastVisit: "2026-11-28", visitCount: 2 });
    await endVisitingEntry(db, t.clergy, id, NOW);
    expect(await listVisiting(db, t.lead)).toEqual([]);
    await expect(logVisit(db, t.lead, id, "2026-11-30", NOW)).rejects.toBeInstanceOf(NotFound);
  });

  it("audit rows hold ids only: no name, place, contact line or note", async () => {
    const { id } = await add(t.clergy, entry());
    await setVisitor(db, t.clergy, id, null, NOW);
    await logVisit(db, t.clergy, id, "2026-11-30", NOW);
    const rows = (await db.select().from(auditLog)).filter((r) => r.subjectType === "visiting_entry");
    expect(rows.map((r) => r.action).sort()).toEqual(["visiting.add", "visiting.visit", "visiting.visitor"]);
    const text = JSON.stringify(rows);
    for (const secret of ["Ruth", "Maple", "daughter", "music", "555 0100", "314 555"]) expect(text).not.toContain(secret);
  });
});

describe("one active entry per person", () => {
  it("a second add for the same person is refused, until the first is ended; an outside person works the same", async () => {
    const { id } = await add(t.clergy, entry());
    await expect(add(t.clergy, entry())).rejects.toBeInstanceOf(InvalidInput);
    await endVisitingEntry(db, t.clergy, id, NOW);
    await expect(add(t.clergy, entry())).resolves.toMatchObject({ id: expect.any(String) });
    const [o] = await db.insert(outsidePeople).values({ name: "Sam Outside", createdBy: t.clergy.id }).returning();
    await add(t.clergy, { outsidePersonId: o.id, place: "Home" });
    await expect(add(t.owner, { outsidePersonId: o.id, place: "Elsewhere" })).rejects.toBeInstanceOf(InvalidInput);
    expect((await listVisiting(db, t.clergy)).map((e) => e.name).sort()).toEqual(["Ruth Cohen", "Sam Outside"]);
  });

  it("needs exactly one kind of person and keeps the texts within their limits", async () => {
    await expect(add(t.clergy, { place: "x", displayName: "A" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(add(t.clergy, { outsidePersonId: "5f1f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f5f", place: "x" })).rejects.toBeInstanceOf(NotFound);
    await expect(add(t.clergy, entry({ outsidePersonId: (await outside("Both")).id }))).rejects.toBeInstanceOf(InvalidInput);
    // A Salesforce contact the server cannot find is refused, whatever name the form claims.
    await expect(add(t.clergy, entry({ sfContactId: CONTACT2, displayName: "Made Up" }))).rejects.toBeInstanceOf(NotFound);
    await expect(add(t.clergy, entry({ place: "p".repeat(301) }))).rejects.toBeInstanceOf(InvalidInput);
    await expect(add(t.clergy, entry({ contactLine: "c".repeat(201) }))).rejects.toBeInstanceOf(InvalidInput);
    await expect(add(t.clergy, entry({ visitorNote: "n".repeat(301) }))).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe("the regular visitor", () => {
  it("must be an active roster member, and is cleared when they leave or are purged", async () => {
    const { id } = await add(t.clergy, entry());
    const m = await addMember(db, t.lead, member(), NOW);
    const paused = await addMember(db, t.lead, member({ firstName: "Pia", email: "pia@example.test" }), NOW);
    await pauseMember(db, t.lead, paused.id, "2026-12-20", NOW);
    await expect(setVisitor(db, t.lead, id, paused.id, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(setVisitor(db, t.lead, id, "5f1f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f5f", NOW)).rejects.toBeInstanceOf(InvalidInput);
    await setVisitor(db, t.lead, id, m.id, NOW);
    expect((await listVisiting(db, t.lead))[0].visitorMemberId).toBe(m.id);
    await markMemberLeft(db, t.lead, m.id, NOW);
    expect((await listVisiting(db, t.lead))[0]).toMatchObject({ visitorMemberId: null, visitorName: null });
    await expect(setVisitor(db, t.lead, id, m.id, NOW)).rejects.toBeInstanceOf(InvalidInput);
    // Clearing by hand.
    const m2 = await addMember(db, t.lead, member({ firstName: "Bo", email: "bo@example.test" }), NOW);
    await setVisitor(db, t.lead, id, m2.id, NOW);
    await setVisitor(db, t.lead, id, null, NOW);
    expect((await listVisiting(db, t.lead))[0].visitorMemberId).toBeNull();
  });

  it("the purge of a member who left long ago also clears them", async () => {
    const { id } = await add(t.clergy, entry());
    const m = await addMember(db, t.lead, member(), NOW);
    await setVisitor(db, t.lead, id, m.id, NOW);
    // Left without going through the status function (the stop link does the same): the daily purge still clears them.
    await db.update(visitingList).set({ visitorMemberId: m.id }).where(eq(visitingList.id, id));
    await markMemberLeft(db, t.lead, m.id, NOW);
    await db.update(visitingList).set({ visitorMemberId: m.id }).where(eq(visitingList.id, id));
    await rosterUpkeep(db, at(31));
    expect((await listVisiting(db, t.lead))[0].visitorMemberId).toBeNull();
  });

  it("the choices list active members, those who said visits first", async () => {
    await addMember(db, t.lead, member({ firstName: "Zed", email: "z@example.test", canDo: ["visits"] }), NOW);
    await addMember(db, t.lead, member({ firstName: "Abe", email: "a@example.test", canDo: ["rides"] }), NOW);
    const left = await addMember(db, t.lead, member({ firstName: "Gone", email: "g@example.test" }), NOW);
    await markMemberLeft(db, t.lead, left.id, NOW);
    expect((await listVisitorChoices(db, t.lead, NOW)).map((c) => [c.name, c.canVisit])).toEqual([["Zed Mor", true], ["Abe Mor", false]]);
  });
});

describe("logging a visit", () => {
  it("accepts today and up to 60 days back; refuses the future, older, and a bad date", async () => {
    const { id } = await add(t.clergy, entry());
    await logVisit(db, t.lead, id, "2026-12-01", NOW);
    await logVisit(db, t.lead, id, "2026-10-02", NOW);
    for (const bad of ["2026-12-02", "2026-10-01", "2026-13-40", "yesterday", null, undefined]) await expect(logVisit(db, t.lead, id, bad, NOW)).rejects.toBeInstanceOf(InvalidInput);
    expect(await db.select().from(visitingVisits)).toHaveLength(2);
  });
});

describe("the daily purge", () => {
  it("deletes an ended entry and its visits 30 days after it ended, and nothing else", async () => {
    const { id } = await add(t.clergy, entry());
    const keep = await add(t.clergy, { outsidePersonId: (await outside("Other")).id, place: "Home" });
    await logVisit(db, t.lead, id, "2026-11-30", NOW);
    await endVisitingEntry(db, t.clergy, id, NOW);
    expect(await purgeVisiting(db, at(29))).toEqual({ deleted: 0 });
    expect(await db.select().from(visitingVisits)).toHaveLength(1);
    expect(await purgeVisiting(db, at(30))).toEqual({ deleted: 1 });
    expect(await db.select().from(visitingVisits)).toHaveLength(0);
    expect((await db.select().from(visitingList)).map((r) => r.id)).toEqual([keep.id]);
  });
});

describe("restricted care and the visiting list", () => {
  it("an outside person whose every care item is restricted away from a viewer is not in their list, nor can they add them or reach the entry", async () => {
    const x = await outside("Hidden Hal");
    await createCareItem(db, t.clergy, { outsidePersonId: x.id, displayName: "Hidden Hal", category: "mental_health", restricted: true, accessUserIds: [] });
    const { id } = await add(t.clergy, { outsidePersonId: x.id, place: "Oak Court" });
    expect((await listVisiting(db, t.clergy)).map((e) => e.name)).toEqual(["Hidden Hal"]);
    for (const shut of [t.clergy2, t.owner]) {
      expect(await listVisiting(db, shut)).toEqual([]);
      expect(await visitingEntryFor(db, shut, { outsidePersonId: x.id })).toBeNull();
      await expect(add(shut, { outsidePersonId: x.id, place: "Oak Court" })).rejects.toBeInstanceOf(NotFound);
      await expect(updateVisitingEntry(db, shut, id, { place: "x" })).rejects.toBeInstanceOf(NotFound);
      await expect(endVisitingEntry(db, shut, id, NOW)).rejects.toBeInstanceOf(NotFound);
      await expect(logVisit(db, shut, id, "2026-11-30", NOW)).rejects.toBeInstanceOf(NotFound);
    }
    // The lead has no care access and keeps seeing the entry (no person link is made for them).
    expect((await listVisiting(db, t.lead)).map((e) => e.name)).toEqual(["Hidden Hal"]);
    expect(await visitingEntryFor(db, t.clergy, { outsidePersonId: x.id })).toBe(id);
  });
});

describe("a paused visitor and a repeated day", () => {
  it("pausing clears the regular visitor", async () => {
    const { id } = await add(t.clergy, entry());
    const m = await addMember(db, t.lead, member(), NOW);
    await setVisitor(db, t.lead, id, m.id, NOW);
    await pauseMember(db, t.lead, m.id, "2026-12-20", NOW);
    expect((await listVisiting(db, t.lead, NOW))[0]).toMatchObject({ visitorMemberId: null, visitorName: null });
    expect((await db.select().from(visitingList))[0].visitorMemberId).toBeNull();
  });

  it("a visitor who is paused behind the scenes is not named", async () => {
    const { id } = await add(t.clergy, entry());
    const m = await addMember(db, t.lead, member(), NOW);
    await setVisitor(db, t.lead, id, m.id, NOW);
    await db.update(corpsMembers).set({ status: "paused", pausedUntil: "2026-12-20" }).where(eq(corpsMembers.id, m.id));
    expect((await listVisiting(db, t.lead, NOW))[0]).toMatchObject({ visitorName: null });
  });

  it("logging the same day twice is a quiet no-op", async () => {
    const { id } = await add(t.clergy, entry());
    await logVisit(db, t.lead, id, "2026-11-30", NOW);
    await expect(logVisit(db, t.clergy, id, "2026-11-30", NOW)).resolves.toBeUndefined();
    expect(await db.select().from(visitingVisits)).toHaveLength(1);
    expect((await listVisiting(db, t.lead))[0].visitCount).toBe(1);
  });
});
