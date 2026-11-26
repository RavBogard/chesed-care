import { describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { closeCareItem, createCareItem, getCareItem, listCareItems, reopenCareItem, updateCareItem } from "@/server/care/care-items";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { ACCOUNT, CONTACT, CONTACT2, team, testDb } from "./support/db";

async function setup() {
  const db = await testDb();
  const t = await team(db);
  return { db, t };
}

describe("care items", () => {
  it("clergy create, list, update, close and reopen", async () => {
    const { db, t } = await setup();
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness" });
    expect(item).toMatchObject({ status: "new", source: "clergy", restricted: false, ownerUserId: t.clergy.id, visibility: "clergy", createdBy: t.clergy.id });
    expect((await listCareItems(db, t.owner, { status: "active" })).map((i) => i.id)).toEqual([item.id]);

    const moved = await updateCareItem(db, t.clergy, item.id, { ownerUserId: t.clergy2.id, category: "other" });
    expect(moved).toMatchObject({ ownerUserId: t.clergy2.id, category: "other" });

    const closed = await closeCareItem(db, t.clergy2, item.id);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(await listCareItems(db, t.clergy, { status: "active" })).toEqual([]);
    expect((await reopenCareItem(db, t.owner, item.id)).status).toBe("open");
  });

  it("validates Salesforce ids and enums", async () => {
    const { db, t } = await setup();
    const base = { sfContactId: CONTACT, displayName: "X", category: "illness" };
    await expect(createCareItem(db, t.clergy, { ...base, sfContactId: "003' OR Id != '" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createCareItem(db, t.clergy, { ...base, sfContactId: ACCOUNT })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createCareItem(db, t.clergy, { ...base, sfAccountId: CONTACT })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createCareItem(db, t.clergy, { ...base, category: "finance" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createCareItem(db, t.clergy, { ...base, displayName: "" })).rejects.toBeInstanceOf(InvalidInput);
  });

  it("caregivers cannot create or manage care items", async () => {
    const { db, t } = await setup();
    await expect(createCareItem(db, t.carer, { sfContactId: CONTACT, displayName: "X", category: "illness" })).rejects.toBeInstanceOf(AccessDenied);
    const shared = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "X", category: "illness", ownerUserId: t.carer.id, visibility: "caregivers" });
    await expect(closeCareItem(db, t.carer, shared.id)).rejects.toBeInstanceOf(AccessDenied);
    await expect(updateCareItem(db, t.carer, shared.id, { visibility: "clergy" })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("a caregiver sees only items assigned to them and shared with caregivers", async () => {
    const { db, t } = await setup();
    const mine = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Mine", category: "birth", ownerUserId: t.carer.id, visibility: "caregivers" });
    const theirs = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Theirs", category: "birth", ownerUserId: t.carer2.id, visibility: "caregivers" });
    const clergyOnly = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Clergy", category: "bereavement" });
    expect((await listCareItems(db, t.carer)).map((i) => i.id)).toEqual([mine.id]);
    expect((await getCareItem(db, t.carer, mine.id)).id).toBe(mine.id);
    await expect(getCareItem(db, t.carer, theirs.id)).rejects.toBeInstanceOf(NotFound);
    await expect(getCareItem(db, t.carer, clergyOnly.id)).rejects.toBeInstanceOf(NotFound);
    expect(await listCareItems(db, t.carer, { sfContactId: CONTACT2 })).toEqual([]);
  });

  it("refuses to assign a clergy-only item to a caregiver, or anything to an inactive user", async () => {
    const { db, t } = await setup();
    await expect(createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "X", category: "illness", ownerUserId: t.carer.id })).rejects.toBeInstanceOf(InvalidInput);
    const shared = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "X", category: "illness", ownerUserId: t.carer.id, visibility: "caregivers" });
    // Making it clergy-only while a caregiver holds it is refused (it would vanish from their list unnoticed).
    await expect(updateCareItem(db, t.clergy, shared.id, { visibility: "clergy" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateCareItem(db, t.clergy, shared.id, { ownerUserId: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(InvalidInput);
  });

  it("unknown or malformed ids are NotFound", async () => {
    const { db, t } = await setup();
    await expect(getCareItem(db, t.clergy, "not-a-uuid")).rejects.toBeInstanceOf(NotFound);
    await expect(getCareItem(db, t.clergy, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(NotFound);
  });
});
