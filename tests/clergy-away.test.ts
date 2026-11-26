import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { NOTICE_TEMPLATES, noticePayload, prefOf, renderNotice } from "@/lib/notice";
import { AccessDenied, type Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { createFollowUp } from "@/server/care/follow-ups";
import { InvalidInput } from "@/server/care/validate";
import { followUps, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { awayLine, clearAway, coverMap, getCovering, listAwayToday, setAway, startingTomorrow, suggestInstead } from "@/server/team/away";
import { CONTACT, CONTACT2, addActor, reporters, team, testDb } from "./support/db";

// Wednesday 10am Chicago.
const NOW = new Date("2026-11-25T16:00:00Z");
const TODAY = "2026-11-25";
let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
let third: Actor;

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
  third = await addActor(db, "clergy3@example.test", "clergy");
});

const away = (who: Actor, cover: Actor | null, from = "2026-11-24", until = "2026-11-28") => setAway(db, who, who.id, { from, until, coverUserId: cover?.id }, NOW);

describe("away: setting it", () => {
  it("is set by oneself, or by the owner for someone; not for a colleague by another clergy member, not by other roles", async () => {
    await away(t.clergy, t.clergy2);
    await setAway(db, t.owner, t.clergy2.id, { from: TODAY, until: "2026-12-01" }, NOW);
    await expect(setAway(db, t.clergy, t.clergy2.id, { from: TODAY, until: "2026-12-01" }, NOW)).rejects.toBeInstanceOf(AccessDenied);
    for (const actor of [t.carer, r.staff, r.lead, r.senior]) await expect(setAway(db, actor, actor.id, { from: TODAY, until: "2026-12-01" }, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("needs a sensible window and a coverer who is another active clergy level user", async () => {
    await expect(setAway(db, t.clergy, t.clergy.id, { from: "2026-12-05", until: "2026-12-01" }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(setAway(db, t.clergy, t.clergy.id, { from: "2026-11-01", until: "2026-11-10" }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(setAway(db, t.clergy, t.clergy.id, { from: TODAY, until: "2026-12-01", coverUserId: t.carer.id }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(setAway(db, t.clergy, t.clergy.id, { from: TODAY, until: "2026-12-01", coverUserId: t.clergy.id }, NOW)).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe("away: the window is read at read time, and nothing is reassigned", () => {
  it("shows a plain line while away, and nothing once the window has ended, with no job in between", async () => {
    await away(t.clergy, t.clergy2);
    const [a] = await listAwayToday(db, TODAY);
    expect(awayLine(a, TODAY)).toBe("clergy is away until Saturday. clergy2 is covering.");
    expect(await listAwayToday(db, "2026-11-29")).toEqual([]);
    expect(await listAwayToday(db, "2026-11-23")).toEqual([]);
    await clearAway(db, t.clergy, t.clergy.id);
    expect(await listAwayToday(db, TODAY)).toEqual([]);
  });

  it("the coverer sees the away person's follow-ups due in the window that they can already see, and ownership does not change", async () => {
    const plain = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Open Olivia", category: "illness" });
    const secret = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Hidden Hannah", category: "mental_health", restricted: true });
    const named = await createCareItem(db, t.clergy, { sfContactId: "003000000000003AAA", displayName: "Named Nora", category: "illness", restricted: true, accessUserIds: [t.clergy2.id] });
    const inside = await createFollowUp(db, t.clergy, { careItemId: plain.id, title: "Call Olivia", dueDate: "2026-11-26" });
    await createFollowUp(db, t.clergy, { careItemId: plain.id, title: "Later", dueDate: "2026-12-20" });
    await createFollowUp(db, t.clergy, { careItemId: secret.id, title: "Secret call", dueDate: "2026-11-26" });
    const shared = await createFollowUp(db, t.clergy, { careItemId: named.id, title: "Call Nora", dueDate: "2026-11-27" });
    await away(t.clergy, t.clergy2);
    const [section] = await getCovering(db, t.clergy2, TODAY);
    expect(section.away.name).toBe("clergy");
    expect(section.followUps.map((f) => f.id).sort()).toEqual([inside.id, shared.id].sort());
    // Not the coverer, not away-for-them: other clergy get nothing, and nothing was reassigned.
    expect(await getCovering(db, third, TODAY)).toEqual([]);
    expect(await getCovering(db, t.clergy, TODAY)).toEqual([]);
    const owners = await db.select({ id: followUps.id, owner: followUps.ownerUserId }).from(followUps);
    expect(owners.every((o) => o.owner === t.clergy.id)).toBe(true);
    // After the window it reverts by itself.
    expect(await getCovering(db, t.clergy2, "2026-11-30")).toEqual([]);
  });

  it("suggests the coverer in place of the away person, and the person themselves otherwise", async () => {
    await away(t.clergy, t.clergy2);
    const cover = coverMap(await listAwayToday(db, TODAY));
    expect(suggestInstead(t.clergy.id, cover)).toBe(t.clergy2.id);
    expect(suggestInstead(third.id, cover)).toBe(third.id);
    expect(suggestInstead(t.clergy.id, coverMap(await listAwayToday(db, "2026-12-02")))).toBe(t.clergy.id);
  });

  it("a coverer who was deactivated or stopped being clergy covers no one", async () => {
    await away(t.clergy, t.clergy2);
    await db.update(users).set({ active: false }).where(eq(users.id, t.clergy2.id));
    const [a] = await listAwayToday(db, TODAY);
    expect(a.coverUserId).toBeNull();
    expect(awayLine(a, TODAY)).toBe("clergy is away until Saturday.");
  });

  it("finds the windows that start tomorrow and name a coverer, for the day-before notice", async () => {
    await setAway(db, t.clergy, t.clergy.id, { from: "2026-11-26", until: "2026-11-30", coverUserId: t.clergy2.id }, NOW);
    expect(await startingTomorrow(db, NOW)).toEqual([{ userId: t.clergy.id, coverUserId: t.clergy2.id, from: "2026-11-26" }]);
    expect(await startingTomorrow(db, new Date("2026-11-27T16:00:00Z"))).toEqual([]);
  });
});

describe("away: the notification kind", () => {
  it("has fixed text with no name, follows the assigned switch, and is in the template table", () => {
    expect(NOTICE_TEMPLATES.covering_tomorrow.body(0)).toBe("You are covering for a colleague from tomorrow.");
    expect(prefOf("covering_tomorrow")).toBe("assigned");
    expect(noticePayload({ kind: "covering_tomorrow" })).toEqual({ kind: "covering_tomorrow", path: "/" });
    expect(renderNotice({ kind: "covering_tomorrow" }).body).not.toMatch(/\d/);
  });
});
