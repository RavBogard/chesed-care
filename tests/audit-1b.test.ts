import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getTodayCare, listCareBoard } from "@/server/care/boards";
import { createCareItem, updateCareItem } from "@/server/care/care-items";
import { createContactEntry, listContactEntries } from "@/server/care/contact-log";
import { createFollowUp, listFollowUps } from "@/server/care/follow-ups";
import { updateUser } from "@/server/care/users";
import { auditLog, followUps } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { CONTACT, team, testDb } from "./support/db";

const TODAY = "2026-11-23";
let db: Db;
let t: Awaited<ReturnType<typeof team>>;
const owners = new Set(["owner@example.test"]);
const rows = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
});

async function restricted() {
  const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness", restricted: true, accessUserIds: [t.clergy2.id] });
  await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call", dueDate: "2026-11-20", ownerUserId: t.clergy2.id });
  await createContactEntry(db, t.clergy, { careItemId: item.id, kind: "call", occurredAt: new Date(), note: "x" });
  await db.delete(auditLog);
  return item;
}

describe("restricted reads are audited on follow-ups and contact entries", () => {
  it("listFollowUps and listContactEntries record a named reader once per day, and not the owner", async () => {
    const item = await restricted();
    await listFollowUps(db, t.clergy, { careItemId: item.id });
    await listContactEntries(db, t.clergy, { careItemId: item.id });
    expect(await rows("restricted.view")).toEqual([]);
    await listFollowUps(db, t.clergy2, { careItemId: item.id });
    expect((await rows("restricted.view")).map((r) => [r.actorUserId, r.subjectId])).toEqual([[t.clergy2.id, item.id]]);
    await db.delete(auditLog);
    await listContactEntries(db, t.clergy2, { careItemId: item.id });
    expect(await rows("restricted.view")).toHaveLength(1);
  });

  it("the boards audit what is left after the mine and category filters, not before", async () => {
    const item = await restricted();
    // The named colleague's "mine" list does not include the item: nothing was read in full.
    await listCareBoard(db, t.clergy2, { scope: "mine", category: null, status: "open" }, TODAY);
    expect(await rows("restricted.view")).toEqual([]);
    await listCareBoard(db, t.clergy2, { scope: "all", category: "bereavement", status: "open" }, TODAY);
    expect(await rows("restricted.view")).toEqual([]);
    await listCareBoard(db, t.clergy2, { scope: "all", category: null, status: "open" }, TODAY);
    expect((await rows("restricted.view")).map((r) => r.subjectId)).toEqual([item.id]);
  });

  it("Today audits the follow-ups it shows, and only those", async () => {
    const item = await restricted();
    await db.delete(auditLog);
    // A restricted item's follow-up held by someone else is not on this reader's Today.
    await getTodayCare(db, t.clergy2, "2020-01-01");
    expect(await rows("restricted.view")).toEqual([]);
    await getTodayCare(db, t.clergy2, TODAY);
    expect((await rows("restricted.view")).map((r) => r.subjectId)).toEqual([item.id]);
  });
});

describe("team and owner changes are audited", () => {
  it("every role or active change writes one row, with no free text; a no-op writes none", async () => {
    await updateUser(db, t.owner, t.carer.id, { role: "staff" }, owners);
    await updateUser(db, t.owner, t.carer.id, { active: false }, owners);
    await updateUser(db, t.owner, t.carer.id, { active: false }, owners);
    const changes = await rows("user.change");
    expect(changes).toHaveLength(2);
    expect(changes[0].detail).toEqual({ role: "staff", previousRole: "caregiver", active: true, previousActive: true });
    expect(changes[1].subjectType).toBe("user");
    expect(changes[1].detail).toMatchObject({ active: false, previousActive: true });
  });

  it("deactivating someone unassigns their open follow-ups, and leaves done ones", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness", ownerUserId: t.clergy2.id });
    const open = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Open", dueDate: TODAY, ownerUserId: t.clergy2.id });
    const done = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Done", dueDate: TODAY, ownerUserId: t.clergy2.id });
    await db.update(followUps).set({ doneAt: new Date() }).where(eq(followUps.id, done.id));
    await updateUser(db, t.owner, t.clergy2.id, { active: false }, owners);
    const after = await db.select().from(followUps);
    expect(after.find((f) => f.id === open.id)!.ownerUserId).toBeNull();
    expect(after.find((f) => f.id === done.id)!.ownerUserId).toBe(t.clergy2.id);
  });

  it("every change of a care item's owner is audited, restricted or not", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    await updateCareItem(db, t.clergy, item.id, { ownerUserId: t.clergy2.id });
    const [row] = await rows("care_item.reassign");
    expect(row.detail).toEqual({ ownerUserId: t.clergy2.id, previousOwnerUserId: t.clergy.id });
    await updateCareItem(db, t.clergy, item.id, { summary: "no owner change" });
    expect(await rows("care_item.reassign")).toHaveLength(1);
  });
});
