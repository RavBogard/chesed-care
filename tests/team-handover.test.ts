import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { createCareItem, handOverRestrictedItems } from "@/server/care/care-items";
import { createFollowUp } from "@/server/care/follow-ups";
import { InvalidInput } from "@/server/care/validate";
import { updateUser } from "@/server/care/users";
import { auditLog, careItems, followUps } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { getHeldWork, handOverWork, heldCounts } from "@/server/team/handover";
import { CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";
import { words } from "./support/words";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const owners = new Set(["owner@example.test"]);
const ho = (a: Parameters<typeof handOverWork>[1], from: unknown, plan: Parameters<typeof handOverWork>[3]) => handOverWork(db, a, from, plan, owners);

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
});

/** clergy2 is leaving: two plain items, a follow-up on each, a Mitzvah Corps step held by a lead, and one restricted item with a follow-up. */
async function leaving() {
  const a = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, displayName: "Plain One", category: "illness" });
  const b = await createCareItem(db, t.clergy2, { sfContactId: CONTACT2, displayName: "Plain Two", category: "ongoing" });
  const secret = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, displayName: "Hidden One", category: "mental_health", restricted: true });
  const fa = await createFollowUp(db, t.clergy2, { careItemId: a.id, title: "Call", dueDate: "2026-12-03" });
  const fb = await createFollowUp(db, t.clergy2, { careItemId: b.id, title: "Visit", dueDate: "2026-12-04" });
  const fs = await createFollowUp(db, t.clergy2, { careItemId: secret.id, title: "Secret", dueDate: "2026-12-04" });
  const [step] = await db.insert(followUps).values({ careItemId: a.id, sfContactId: CONTACT, displayName: "Plain One", title: "Meal", dueDate: "2026-12-05", ownerUserId: r.lead.id, forLead: true, createdBy: t.clergy2.id }).returning();
  return { a, b, secret, fa, fb, fs, step };
}

describe("handover", () => {
  it("is the owner role's alone", async () => {
    await leaving();
    await expect(ho(t.clergy, t.clergy2.id, { itemsTo: t.clergy.id, followUpsTo: t.clergy.id })).rejects.toBeInstanceOf(AccessDenied);
    await expect(getHeldWork(db, t.clergy, t.clergy2.id)).rejects.toBeInstanceOf(AccessDenied);
    await expect(heldCounts(db, t.clergy)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("neither lists nor counts restricted items", async () => {
    const x = await leaving();
    const work = await getHeldWork(db, t.owner, t.clergy2.id);
    expect(work.items.map((i) => i.id).sort()).toEqual([x.a.id, x.b.id].sort());
    expect(work.followUps.map((f) => f.id).sort()).toEqual([x.fa.id, x.fb.id].sort());
    expect(words(work)).not.toMatch(/Hidden|Secret/);
    expect((await heldCounts(db, t.owner)).get(t.clergy2.id)).toMatchObject({ items: 2, followUps: 2 });
    // Reading the sheet is not a read of the restricted item.
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "restricted.view"))).toHaveLength(0);
  });

  it("moves everything non-restricted, in bulk and one by one, leaves nothing with them, audits ids only, and leaves restricted items for the blind hand-over", async () => {
    const x = await leaving();
    const moved = await ho(t.owner, t.clergy2.id, { itemsTo: t.clergy.id, followUpsTo: t.clergy.id, itemOverrides: { [x.b.id]: t.owner.id }, followUpOverrides: { [x.fb.id]: t.owner.id } });
    expect(moved).toEqual({ items: 2, followUps: 2 });
    const owner = async (id: string) => (await db.select().from(careItems).where(eq(careItems.id, id)))[0].ownerUserId;
    expect(await owner(x.a.id)).toBe(t.clergy.id);
    expect(await owner(x.b.id)).toBe(t.owner.id);
    const fuOwner = async (id: string) => (await db.select().from(followUps).where(eq(followUps.id, id)))[0].ownerUserId;
    expect(await fuOwner(x.fa.id)).toBe(t.clergy.id);
    expect(await fuOwner(x.fb.id)).toBe(t.owner.id);
    // Nothing non-restricted is left with them.
    const left = (await heldCounts(db, t.owner)).get(t.clergy2.id);
    expect((left?.items ?? 0) + (left?.followUps ?? 0)).toBe(0);
    // The restricted item and its follow-up were not touched.
    expect(await owner(x.secret.id)).toBe(t.clergy2.id);
    expect(await fuOwner(x.fs.id)).toBe(t.clergy2.id);
    // One audit row per move, ids and enums only.
    const rows = await db.select().from(auditLog);
    expect(rows.filter((a) => a.action === "care_item.reassign")).toHaveLength(2);
    expect(rows.filter((a) => a.action === "follow_up.reassign")).toHaveLength(2);
    expect(words(rows)).not.toMatch(/Plain|Call|Visit|Hidden|Secret/);
    // Then deactivation, and the existing blind hand-over takes the restricted item.
    await updateUser(db, t.owner, t.clergy2.id, { active: false }, owners);
    expect(await handOverRestrictedItems(db, t.owner, t.clergy2.id, t.clergy.id)).toEqual({ count: 1 });
    expect(await owner(x.secret.id)).toBe(t.clergy.id);
  });

  it("sends a lead's steps to another lead or to each care item's owner", async () => {
    const x = await leaving();
    await ho(t.owner, t.clergy2.id, { itemsTo: t.clergy.id, followUpsTo: t.clergy.id });
    expect((await heldCounts(db, t.owner)).get(r.lead.id)).toMatchObject({ followUps: 1 });
    await ho(t.owner, r.lead.id, { leadStepsTo: "owners" });
    expect((await db.select().from(followUps).where(eq(followUps.id, x.step.id)))[0].ownerUserId).toBe(t.clergy.id);
  });

  it("refuses to move work from someone on the owner allowlist, who cannot be deactivated", async () => {
    await leaving();
    const keep = new Set(["clergy2@example.test"]);
    await expect(handOverWork(db, t.owner, t.clergy2.id, { itemsTo: t.clergy.id, followUpsTo: t.clergy.id }, keep)).rejects.toBeInstanceOf(InvalidInput);
    expect((await heldCounts(db, t.owner)).get(t.clergy2.id)).toMatchObject({ items: 2 });
  });

  it("is all or nothing: a missing choice or an invalid person changes nothing", async () => {
    const x = await leaving();
    await expect(ho(t.owner, t.clergy2.id, { itemsTo: t.clergy.id })).rejects.toBeInstanceOf(InvalidInput);
    await expect(ho(t.owner, t.clergy2.id, { itemsTo: t.clergy.id, followUpsTo: r.staff.id })).rejects.toBeInstanceOf(InvalidInput);
    await expect(ho(t.owner, t.clergy2.id, { itemsTo: t.clergy2.id, followUpsTo: t.clergy.id })).rejects.toBeInstanceOf(InvalidInput);
    const still = await db.select().from(careItems).where(and(eq(careItems.ownerUserId, t.clergy2.id), eq(careItems.restricted, false)));
    expect(still.map((i) => i.id).sort()).toEqual([x.a.id, x.b.id].sort());
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "follow_up.reassign"))).toHaveLength(0);
  });
});
