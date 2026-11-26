import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { createContactEntry } from "@/server/care/contact-log";
import { createFollowUp } from "@/server/care/follow-ups";
import { careItemAccess, careItems, followUps, proposals, users, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { getTeamOverview, type TeamOverview } from "@/server/team/overview";
import { CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";
import { livePage, NOW } from "./support/meals";
import { words } from "./support/words";

const TODAY = "2026-12-01";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
});

/** What a viewer can read off the page, keyed by email so two databases compare. */
const shape = (o: TeamOverview, emails: Map<string, string>) => ({
  people: o.people.map((p) => ({ email: emails.get(p.userId), self: p.self, openItems: p.openItems, overdue: p.overdue, week: p.dueThisWeek, steps: p.journeyStepsComing, last: p.lastContact, note: p.restrictedNote })),
  lists: [o.noOwner, o.unassignedFollowUps, o.inboxWaiting, o.volunteerTasks, o.mealNights].map((l) => l.length),
});
const emailsOf = async (d: Db) => new Map((await d.select().from(users)).map((u) => [u.id, u.email]));

/** One shared plain item of clergy2's, and optionally a restricted item with everything hanging off it. */
async function seed(d: Db, a: Awaited<ReturnType<typeof team>>, withRestricted: boolean) {
  await createCareItem(d, a.clergy2, { sfContactId: CONTACT2, displayName: "Plain Person", category: "illness" });
  if (!withRestricted) return;
  const r = await createCareItem(d, a.clergy2, { sfContactId: CONTACT, displayName: "Hidden Person", category: "mental_health", restricted: true, restrictedShowsCarer: false });
  await createFollowUp(d, a.clergy2, { careItemId: r.id, title: "Secret call", dueDate: "2026-11-20" });
  await createFollowUp(d, a.clergy2, { careItemId: r.id, title: "Secret visit", dueDate: "2026-12-03" });
  await d.insert(followUps).values({ careItemId: r.id, sfContactId: CONTACT, displayName: "Hidden Person", title: "Unassigned secret", dueDate: "2026-11-01", ownerUserId: null, createdBy: a.clergy2.id });
  await createContactEntry(d, a.clergy2, { careItemId: r.id, kind: "visit", occurredAt: "2026-11-30T15:00:00Z", note: "secret" });
}

describe("team view: access", () => {
  it("is for owner and clergy only", async () => {
    const r = await reporters(db);
    for (const a of [t.owner, t.clergy]) await expect(getTeamOverview(db, a, NOW)).resolves.toMatchObject({ today: TODAY });
    for (const a of [t.carer, r.staff, r.lead, r.senior]) await expect(getTeamOverview(db, a, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe("team view: the restricted rule", () => {
  it.each(["clergy", "owner"] as const)("%s cannot tell from any number or row whether another clergy holds a restricted item", async (who) => {
    const withDb = db;
    const withTeam = t;
    await seed(withDb, withTeam, true);
    const withOut = await testDb();
    const outTeam = await team(withOut);
    await seed(withOut, outTeam, false);
    const a = shape(await getTeamOverview(withDb, withTeam[who], NOW), await emailsOf(withDb));
    const b = shape(await getTeamOverview(withOut, outTeam[who], NOW), await emailsOf(withOut));
    expect(a).toEqual(b);
    const other = a.people.find((p) => p.email === "clergy2@example.test")!;
    // Only the plain item is counted, and the neutral line is there whatever they hold.
    expect(other).toMatchObject({ openItems: 1, overdue: 0, last: null, note: true });
    // The line is on every clergy row but the viewer's own, with or without a restricted item.
    expect(a.people.filter((p) => p.note).map((p) => p.email).sort()).toEqual(["clergy2@example.test", ...(who === "clergy" ? ["owner@example.test"] : ["clergy@example.test"])].sort());
  });

  it("the holder is counted with what they fully see, and a named colleague gets no more than anyone", async () => {
    await seed(db, t, true);
    const own = await getTeamOverview(db, t.clergy2, NOW);
    expect(own.people.find((p) => p.self)).toMatchObject({ openItems: 2, overdue: 1, dueThisWeek: 1, lastContact: "2026-11-30" });
    const rows = JSON.stringify(own);
    expect(rows).toContain("Unassigned secret"); // their own restricted work, shown only to them
    const [rItem] = await db.select().from(careItems).where(eq(careItems.restricted, true));
    await db.insert(careItemAccess).values({ careItemId: rItem.id, userId: t.clergy.id });
    const named = await getTeamOverview(db, t.clergy, NOW);
    expect(named.people.find((p) => p.name === "clergy2")).toMatchObject({ openItems: 1, overdue: 0 });
    expect(JSON.stringify(named)).not.toContain("Hidden Person");
  });

  it("restricted work never appears in the lists that need someone", async () => {
    await seed(db, t, true);
    const o = await getTeamOverview(db, t.clergy, NOW);
    expect(words(o)).not.toMatch(/Hidden|secret|Unassigned secret/i);
    expect(o.unassignedFollowUps).toHaveLength(0);
  });
});

describe("team view: own restricted work", () => {
  it("lists an unassigned follow-up on the viewer's own restricted item for them, and for no one else", async () => {
    await seed(db, t, true);
    expect((await getTeamOverview(db, t.clergy2, NOW)).unassignedFollowUps.map((r) => r.detail.split(" · ")[0])).toEqual(["Unassigned secret"]);
    expect((await getTeamOverview(db, t.clergy, NOW)).unassignedFollowUps).toHaveLength(0);
    expect((await getTeamOverview(db, t.owner, NOW)).unassignedFollowUps).toHaveLength(0);
  });
});

describe("team view: what needs someone", () => {
  it("lists items held by someone who left, unassigned and Mitzvah Corps steps, a waiting Inbox, untaken tasks and open meal nights, each linking to the thing", async () => {
    const [gone] = await db.insert(users).values({ email: "gone@example.test", name: "Gone", role: "clergy", active: false }).returning();
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    await db.update(careItems).set({ ownerUserId: gone.id }).where(eq(careItems.id, item.id));
    await db.insert(followUps).values([
      { careItemId: item.id, sfContactId: CONTACT, displayName: "Ruth Cohen", title: "Standing check-in", dueDate: "2026-11-28", ownerUserId: null, createdBy: t.clergy.id },
      { careItemId: item.id, sfContactId: CONTACT, displayName: "Ruth Cohen", title: "Bring a meal", dueDate: "2026-12-02", ownerUserId: t.clergy.id, forLead: true, createdBy: t.clergy.id },
    ]);
    await db.insert(proposals).values([
      { channel: "staff", reviewScope: "clergy", rawText: "x", createdAt: new Date("2026-11-27T12:00:00Z") },
      { channel: "staff", reviewScope: "clergy", rawText: "y", createdAt: new Date("2026-11-30T20:00:00Z") },
    ]);
    await db.insert(volunteerTasks).values([
      { kind: "ride", forLabel: "Ruth", needed: "A ride", taskDate: "2026-12-03", createdBy: t.clergy.id },
      { kind: "visit", forLabel: "Later", needed: "A visit", taskDate: "2026-12-20", createdBy: t.clergy.id },
    ]);
    await livePage(db, t.clergy);

    const o = await getTeamOverview(db, t.clergy, NOW);
    expect(o.noOwner.map((r) => r.href)).toEqual([`/people/${CONTACT}`]);
    expect(o.unassignedFollowUps).toHaveLength(2);
    expect(o.unassignedFollowUps.find((r) => r.forLead)?.detail).toContain("Mitzvah Corps");
    expect(o.inboxWaiting).toHaveLength(1);
    expect(o.inboxWaiting[0].href).toBe("/inbox");
    expect(o.volunteerTasks).toHaveLength(1);
    expect(o.volunteerTasks[0].href).toMatch(/^\/volunteers\//);
    expect(o.mealNights).toHaveLength(1);
    expect(o.mealNights[0]).toMatchObject({ detail: expect.stringContaining("2 nights") });
    expect(o.mealNights[0].href).toMatch(/^\/meals\//);
  });

});
