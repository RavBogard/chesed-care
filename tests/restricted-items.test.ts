import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied, type Actor } from "@/server/access/policy";
import { getTodayCare, listCareBoard } from "@/server/care/boards";
import { closeCareItem, createCareItem, getCareItem, listCareItemAccess, handOverRestrictedItems, listCareItems, listCareItemStubs, listStrandedRestricted, updateCareItem, type CareItem } from "@/server/care/care-items";
import { createContactEntry, deleteContactEntry, listContactEntries, updateContactEntry } from "@/server/care/contact-log";
import { createFollowUp, deleteFollowUp, listFollowUps, setFollowUpDone, updateFollowUp, type FollowUp } from "@/server/care/follow-ups";
import { getPersonPage } from "@/server/care/person-page";
import { updateUser } from "@/server/care/users";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { auditLog, careItemAccess, careItems, contactLog, followUps } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { ACCOUNT, addActor, CONTACT, reporters, team, testDb } from "./support/db";
import { fakeSf } from "./support/sf";

// 10am Chicago, Nov 23 2026.
const NOW = new Date("2026-11-23T16:00:00Z");
const TODAY = "2026-11-23";
const SUMMARY = "Admitted after a crisis; family does not know";
const NOTE = "She asked that no one be told";
const OPEN_NOTE = "Sat with her for an hour";
const TITLE = "Call the ward";
const LOCATION = "Ward 5";
/** Everything about the restricted item that must never reach someone without full access. */
const SECRETS = [SUMMARY, NOTE, OPEN_NOTE, TITLE, LOCATION, "mental_health", "2026-11-20"];
const BOARD = { scope: "all", category: null, status: "open" } as const;

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
/** Clergy who neither hold the item nor are named on it. */
let other: Actor;

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
  other = await addActor(db, "clergy3@example.test", "clergy");
});

/** A restricted item held by `clergy` with `clergy2` named on it, a due follow-up (one held, one unassigned) and two contact entries. */
async function restrictedItem(restrictedShowsCarer: boolean) {
  const item = await createCareItem(db, t.clergy, {
    sfContactId: CONTACT,
    sfAccountId: ACCOUNT,
    displayName: "Ruth Cohen",
    category: "mental_health",
    summary: SUMMARY,
    location: LOCATION,
    restricted: true,
    restrictedShowsCarer,
    accessUserIds: [t.clergy2.id],
  });
  const followUp = await createFollowUp(db, t.clergy, { careItemId: item.id, title: TITLE, dueDate: "2026-11-20" });
  const [unassigned] = await db.insert(followUps).values({ careItemId: item.id, sfContactId: CONTACT, displayName: "Ruth Cohen", title: TITLE, dueDate: "2026-11-20", ownerUserId: null, createdBy: t.clergy.id }).returning();
  const privateEntry = await createContactEntry(db, t.clergy, { careItemId: item.id, kind: "visit", occurredAt: "2026-11-20T15:00:00Z", note: NOTE, private: true });
  const openEntry = await createContactEntry(db, t.clergy2, { careItemId: item.id, kind: "call", occurredAt: "2026-11-21T15:00:00Z", note: OPEN_NOTE });
  return { item, followUp, unassigned, privateEntry, openEntry };
}

/** Everything the read surfaces give one viewer about the person and the item. */
async function everything(a: Actor, item: CareItem) {
  const page = await getPersonPage({ db, sf: fakeSf().sf, now: NOW }, a, CONTACT).catch((e) => (e instanceof NotFound ? null : Promise.reject(e)));
  return {
    list: await listCareItems(db, a, { sfContactId: CONTACT }),
    board: await listCareBoard(db, a, BOARD, TODAY),
    stubs: await listCareItemStubs(db, a),
    today: await getTodayCare(db, a, TODAY),
    page,
    followUps: [...(await listFollowUps(db, a, { careItemId: item.id })), ...(await listFollowUps(db, a, { sfContactId: CONTACT })), ...(await listFollowUps(db, a))],
    contacts: [...(await listContactEntries(db, a, { careItemId: item.id })), ...(await listContactEntries(db, a, { sfContactId: CONTACT })), ...(await listContactEntries(db, a))],
  };
}

/** Every way of reaching the item or what hangs off it by id finds nothing, and nothing changes. */
async function unreachable(a: Actor, s: Awaited<ReturnType<typeof restrictedItem>>) {
  const before = JSON.stringify([await db.select().from(careItems), await db.select().from(followUps), await db.select().from(contactLog), await db.select().from(careItemAccess)]);
  const attempts: Promise<unknown>[] = [
    getCareItem(db, a, s.item.id),
    listCareItemAccess(db, a, s.item.id),
    updateCareItem(db, a, s.item.id, { restricted: false }),
    updateCareItem(db, a, s.item.id, { restrictedShowsCarer: true }),
    updateCareItem(db, a, s.item.id, { accessUserIds: [a.id] }),
    updateCareItem(db, a, s.item.id, { summary: "x" }),
    closeCareItem(db, a, s.item.id),
    createFollowUp(db, a, { careItemId: s.item.id, title: "Mine", dueDate: "2026-12-01" }),
    createContactEntry(db, a, { careItemId: s.item.id, kind: "call", occurredAt: NOW }),
    updateFollowUp(db, a, s.followUp.id, { title: "x" }),
    updateFollowUp(db, a, s.unassigned.id, { ownerUserId: a.id }),
    setFollowUpDone(db, a, s.followUp.id, true),
    setFollowUpDone(db, a, s.unassigned.id, true, { outcome: "spoke" }),
    deleteFollowUp(db, a, s.followUp.id),
    updateContactEntry(db, a, s.openEntry.id, { note: "x" }),
    deleteContactEntry(db, a, s.openEntry.id),
    deleteContactEntry(db, a, s.privateEntry.id),
  ];
  for (const attempt of attempts) await expect(attempt).rejects.toBeInstanceOf(NotFound);
  expect(JSON.stringify([await db.select().from(careItems), await db.select().from(followUps), await db.select().from(contactLog), await db.select().from(careItemAccess)])).toBe(before);
}

function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("a restricted care item: who sees what", () => {
  it("its owner and the clergy named on it see everything, on every surface", async () => {
    const s = await restrictedItem(true);
    for (const a of [t.clergy, t.clergy2]) {
      const seen = await everything(a, s.item);
      expect(seen.list.map((i) => i.id)).toEqual([s.item.id]);
      expect(seen.list[0]).toMatchObject({ summary: SUMMARY, location: LOCATION, category: "mental_health", restricted: true });
      expect(seen.board.map((i) => i.id)).toEqual([s.item.id]);
      expect(seen.stubs).toEqual([]);
      expect(seen.page!.careItems.map((i) => i.id)).toEqual([s.item.id]);
      expect(seen.page!.restrictedCare).toEqual([]);
      expect(new Set(seen.followUps.map((f) => f.id))).toEqual(new Set([s.followUp.id, s.unassigned.id]));
      expect(new Set(seen.contacts.map((c) => c.id))).toEqual(new Set([s.privateEntry.id, s.openEntry.id]));
      // Today: what is theirs or no one's.
      expect(seen.today.due.map((f) => f.id)).toContain(s.unassigned.id);
    }
    expect((await everything(t.clergy, s.item)).today.due.map((f) => f.id)).toContain(s.followUp.id);
    // A private note stays its author's even between the two with full access.
    const forNamed = (await listContactEntries(db, t.clergy2, { careItemId: s.item.id })).find((c) => c.id === s.privateEntry.id)!;
    expect(forNamed).toMatchObject({ note: null, noteHidden: true });
    expect(await listCareItemAccess(db, t.clergy, s.item.id)).toEqual([t.clergy2.id]);
  });

  it("other clergy and the owner role get only the stub when it shows its carer: the person, that it is restricted, and who holds it", async () => {
    const s = await restrictedItem(true);
    for (const a of [other, t.owner]) {
      const seen = await everything(a, s.item);
      const stub = { id: s.item.id, restricted: true, sfContactId: CONTACT, outsidePersonId: null, displayName: "Ruth Cohen", ownerUserId: t.clergy.id, ownerName: "clergy" };
      expect(seen.stubs).toEqual([stub]);
      expect(seen.page!.restrictedCare).toEqual([stub]);
      expect(seen.list).toEqual([]);
      expect(seen.board).toEqual([]);
      expect(seen.page!.careItems).toEqual([]);
      expect(seen.followUps).toEqual([]);
      expect(seen.contacts).toEqual([]);
      expect(seen.today).toEqual({ due: [], attention: [], doneToday: 0 });
      expectNoSecrets({ ...seen, page: { ...seen.page, person: null } });
      await unreachable(a, s);
    }
  });

  it("when it does not show its carer it does not exist for them at all", async () => {
    const s = await restrictedItem(false);
    for (const a of [other, t.owner]) {
      const seen = await everything(a, s.item);
      expect(seen.stubs).toEqual([]);
      expect(seen.page!.restrictedCare).toEqual([]);
      expect(seen.page!.careItems).toEqual([]);
      expect([seen.list, seen.board, seen.followUps, seen.contacts]).toEqual([[], [], [], []]);
      expect(seen.today).toEqual({ due: [], attention: [], doneToday: 0 });
      expectNoSecrets({ ...seen, page: { ...seen.page, person: null } });
      await unreachable(a, s);
      await expect(handOverRestrictedItems(db, a, t.clergy.id, t.clergy2.id)).rejects.toBeInstanceOf(AccessDenied);
    }
  });

  it("a caregiver and the reporting roles get nothing, whichever way it is set", async () => {
    for (const showsCarer of [true, false]) {
      const s = await restrictedItem(showsCarer);
      for (const a of [t.carer, r.staff, r.lead, r.senior]) {
        const seen = await everything(a, s.item);
        expect(seen.page).toBeNull();
        expect([seen.list, seen.board, seen.stubs, seen.followUps, seen.contacts]).toEqual([[], [], [], [], []]);
        expect(seen.today).toEqual({ due: [], attention: [], doneToday: 0 });
        await unreachable(a, s);
        await expect(handOverRestrictedItems(db, a, t.clergy.id, t.clergy2.id)).rejects.toBeInstanceOf(AccessDenied);
      }
    }
  });

  it("being named does nothing for someone who is not clergy level, and stops counting when a clergy member leaves that level", async () => {
    const s = await restrictedItem(true);
    // Rows the server functions would refuse, put there directly.
    await db.insert(careItemAccess).values([t.carer, r.staff].map((a) => ({ careItemId: s.item.id, userId: a.id })));
    for (const a of [t.carer, r.staff]) await unreachable(a, s);
    // clergy2 becomes a caregiver: the row goes, and so does the access, even after a return to clergy.
    await updateUser(db, t.owner, t.clergy2.id, { role: "caregiver" }, new Set());
    await expect(getCareItem(db, { ...t.clergy2, role: "caregiver" }, s.item.id)).rejects.toBeInstanceOf(NotFound);
    await updateUser(db, t.owner, t.clergy2.id, { role: "clergy" }, new Set());
    await expect(getCareItem(db, t.clergy2, s.item.id)).rejects.toBeInstanceOf(NotFound);
  });

  it("an unrestricted item beside it is unaffected", async () => {
    const s = await restrictedItem(false);
    const plain = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    const entry = await createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", kind: "call", occurredAt: NOW, note: "Routine" });
    const seen = await everything(other, s.item);
    expect(seen.list.map((i) => i.id)).toEqual([plain.id]);
    expect(seen.page!.careItems.map((i) => i.id)).toEqual([plain.id]);
    expect(new Set(seen.contacts.map((c) => c.id))).toEqual(new Set([entry.id]));
  });
});
describe("a restricted care item: who changes what", () => {
  it("only its owner changes restricted, restrictedShowsCarer, the access list or who holds it; a named colleague reads and works but changes none of these", async () => {
    const s = await restrictedItem(true);
    const before = JSON.stringify([await db.select().from(careItems), await db.select().from(careItemAccess)]);
    for (const patch of [{ restricted: false }, { restrictedShowsCarer: false }, { accessUserIds: [t.clergy2.id, other.id] }, { accessUserIds: [] }, { ownerUserId: t.clergy2.id }, { summary: "x", ownerUserId: other.id }]) {
      await expect(updateCareItem(db, t.clergy2, s.item.id, patch)).rejects.toBeInstanceOf(AccessDenied);
    }
    expect(JSON.stringify([await db.select().from(careItems), await db.select().from(careItemAccess)])).toBe(before);
    // The named colleague still reads it, edits its content, logs a contact and plans a follow-up.
    expect((await updateCareItem(db, t.clergy2, s.item.id, { location: "Ward 6" })).location).toBe("Ward 6");
    await createContactEntry(db, t.clergy2, { careItemId: s.item.id, kind: "call", occurredAt: NOW });
    await createFollowUp(db, t.clergy2, { careItemId: s.item.id, title: "Ring again", dueDate: "2026-12-01" });

    // The owner does all of it.
    const changed = await updateCareItem(db, t.clergy, s.item.id, { restrictedShowsCarer: false, accessUserIds: [t.clergy2.id, other.id] });
    expect(changed).toMatchObject({ restricted: true, restrictedShowsCarer: false });
    expect(new Set(await listCareItemAccess(db, t.clergy, s.item.id))).toEqual(new Set([t.clergy2.id, other.id]));
    expect((await getCareItem(db, other, s.item.id)).summary).toBe(SUMMARY);
    expect(await listCareItemStubs(db, t.owner)).toEqual([]);
    // Handing it on is the owner's to do; from then on it is the new owner's.
    expect((await updateCareItem(db, t.clergy, s.item.id, { ownerUserId: other.id })).ownerUserId).toBe(other.id);
    await expect(getCareItem(db, t.clergy, s.item.id)).rejects.toBeInstanceOf(NotFound);
    // Lifting the restriction clears the list; everyone at clergy level sees it again.
    await updateCareItem(db, other, s.item.id, { restricted: false });
    expect(await db.select().from(careItemAccess)).toEqual([]);
    expect((await getCareItem(db, t.owner, s.item.id)).id).toBe(s.item.id);
  });

  it("no one restricts a colleague's item, nor takes it and restricts it in one step: not clergy, not the owner role", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness", summary: SUMMARY });
    for (const a of [t.clergy2, t.owner]) {
      for (const patch of [{ restricted: true }, { restricted: true, ownerUserId: a.id }, { restricted: true, ownerUserId: a.id, accessUserIds: [other.id] }, { restrictedShowsCarer: false }, { accessUserIds: [] }]) {
        await expect(updateCareItem(db, a, item.id, patch)).rejects.toBeInstanceOf(AccessDenied);
      }
    }
    expect(await getCareItem(db, other, item.id)).toMatchObject({ restricted: false, ownerUserId: t.clergy.id });
    // An unrestricted item can still be handed around; its new owner may then restrict it.
    await updateCareItem(db, t.clergy2, item.id, { ownerUserId: t.clergy2.id });
    expect(await updateCareItem(db, t.clergy2, item.id, { restricted: true })).toMatchObject({ restricted: true, ownerUserId: t.clergy2.id });
  });

  it("refuses a caregiver, a reporter, an inactive user or a stranger as owner or on the access list, and refuses caregiver visibility", async () => {
    const inactive = await addActor(db, "gone@example.test", "clergy", false);
    const base = { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness", restricted: true };
    for (const id of [t.carer.id, r.staff.id, r.lead.id, r.senior.id, inactive.id, "00000000-0000-4000-8000-000000000000"]) {
      await expect(createCareItem(db, t.clergy, { ...base, accessUserIds: [id] })).rejects.toBeInstanceOf(InvalidInput);
      await expect(createCareItem(db, t.clergy, { ...base, ownerUserId: id })).rejects.toBeInstanceOf(InvalidInput);
    }
    await expect(createCareItem(db, t.clergy, { ...base, visibility: "caregivers" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createCareItem(db, t.clergy, { ...base, restricted: false, accessUserIds: [t.clergy2.id] })).rejects.toBeInstanceOf(InvalidInput);
    const shared = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness", visibility: "caregivers" });
    await expect(updateCareItem(db, t.clergy, shared.id, { restricted: true })).rejects.toBeInstanceOf(InvalidInput);
    const item = await createCareItem(db, t.clergy, base);
    await expect(updateCareItem(db, t.clergy, item.id, { visibility: "caregivers" })).rejects.toBeInstanceOf(InvalidInput);
    expect(await db.select().from(careItemAccess)).toEqual([]);
  });

  it("work on it goes only to those who can see it; restricting it frees follow-ups held by anyone else", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    const theirs = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Bring a meal", dueDate: "2026-12-01", ownerUserId: other.id });
    const mine = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call", dueDate: "2026-12-01" });
    await updateCareItem(db, t.clergy, item.id, { restricted: true, accessUserIds: [t.clergy2.id] });
    const owners = async () => new Map((await db.select().from(followUps)).map((f: FollowUp) => [f.id, f.ownerUserId]));
    expect((await owners()).get(theirs.id)).toBeNull();
    expect((await owners()).get(mine.id)).toBe(t.clergy.id);
    await expect(createFollowUp(db, t.clergy, { careItemId: item.id, title: "x", dueDate: "2026-12-01", ownerUserId: other.id })).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateFollowUp(db, t.clergy, mine.id, { ownerUserId: t.owner.id })).rejects.toBeInstanceOf(InvalidInput);
    expect((await updateFollowUp(db, t.clergy, mine.id, { ownerUserId: t.clergy2.id })).ownerUserId).toBe(t.clergy2.id);
  });
});

describe("restricted items whose holder has left: the blind hand-over", () => {
  const owners = new Set(["owner@example.test"]);
  const snapshot = async () => JSON.stringify([await db.select().from(careItems), await db.select().from(careItemAccess), await db.select().from(followUps)]);

  it("while the holder is active clergy the owner role can do nothing: no list entry, no hand-over to an accomplice", async () => {
    await restrictedItem(true);
    await restrictedItem(false);
    const before = await snapshot();
    expect(await listStrandedRestricted(db, t.owner)).toEqual([]);
    for (const to of [other.id, t.clergy2.id, t.owner.id]) await expect(handOverRestrictedItems(db, t.owner, t.clergy.id, to)).rejects.toBeInstanceOf(to === t.owner.id ? InvalidInput : AccessDenied);
    expect(await snapshot()).toBe(before);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "care_item.hand_over"))).toEqual([]);
  });

  it("no one but the owner role sees the list or hands anything over, the items' own named clergy included", async () => {
    await restrictedItem(true);
    await updateUser(db, t.owner, t.clergy.id, { active: false }, owners);
    for (const a of [t.clergy2, other, t.carer, r.staff, r.lead, r.senior]) {
      await expect(listStrandedRestricted(db, a)).rejects.toBeInstanceOf(AccessDenied);
      await expect(handOverRestrictedItems(db, a, t.clergy.id, other.id)).rejects.toBeInstanceOf(AccessDenied);
    }
  });

  it("once the holder is deactivated or no longer clergy, the owner role sees a count per holder and hands them all to one active clergy member, reading nothing", async () => {
    const shown = await restrictedItem(true);
    const hiddenOne = await restrictedItem(false);
    const plain = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    const elsewhere = await createCareItem(db, other, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness", restricted: true });
    await updateUser(db, t.owner, t.clergy.id, { active: false }, owners);

    // A count and the holder's name. Nothing of who is in care, the category, or the items' ids.
    const stranded = await listStrandedRestricted(db, t.owner);
    expect(stranded).toEqual([{ userId: t.clergy.id, name: "clergy", count: 2 }]);
    expectNoSecrets(stranded);
    for (const leak of ["Ruth", CONTACT, shown.item.id, hiddenOne.item.id]) expect(JSON.stringify(stranded)).not.toContain(leak);

    // Never to themselves, never to someone who cannot hold one, never from someone who is not there.
    await expect(handOverRestrictedItems(db, t.owner, t.clergy.id, t.owner.id)).rejects.toBeInstanceOf(InvalidInput);
    for (const to of [t.carer.id, r.staff.id, t.clergy.id, "00000000-0000-4000-8000-000000000000"]) await expect(handOverRestrictedItems(db, t.owner, t.clergy.id, to)).rejects.toBeInstanceOf(InvalidInput);
    await expect(handOverRestrictedItems(db, t.owner, "00000000-0000-4000-8000-000000000000", other.id)).rejects.toBeInstanceOf(InvalidInput);

    const flags = async () => (await db.select().from(careItems)).map((i) => [i.id, i.restricted, i.restrictedShowsCarer, i.summary, i.status]).sort();
    const before = await flags();
    expect(await handOverRestrictedItems(db, t.owner, t.clergy.id, other.id)).toEqual({ count: 2 });
    // Only the holder changed: restricted, restrictedShowsCarer and everything else are as they were.
    expect(await flags()).toEqual(before);
    const holders = new Map((await db.select().from(careItems)).map((i) => [i.id, i.ownerUserId]));
    expect([holders.get(shown.item.id), holders.get(hiddenOne.item.id), holders.get(plain.id), holders.get(elsewhere.id)]).toEqual([other.id, other.id, t.clergy.id, other.id]);
    // The names on the items stand; the follow-ups the departed holder had are freed, not lost.
    expect(await listCareItemAccess(db, other, shown.item.id)).toEqual([t.clergy2.id]);
    expect((await db.select().from(followUps).where(eq(followUps.id, shown.followUp.id)))[0].ownerUserId).toBeNull();

    // The owner role still reads none of it; the new holder reads it all.
    await unreachable(t.owner, shown);
    await unreachable(t.owner, hiddenOne);
    expect(new Set((await listCareItemStubs(db, t.owner)).map((i) => i.id))).toEqual(new Set([shown.item.id, elsewhere.id]));
    expect((await getCareItem(db, other, hiddenOne.item.id)).summary).toBe(SUMMARY);
    expect(await listStrandedRestricted(db, t.owner)).toEqual([]);

    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "care_item.hand_over"));
    expect(audit.map((a) => [a.actorUserId, a.subjectType, a.subjectId, a.detail]).sort()).toEqual(
      [shown.item.id, hiddenOne.item.id].map((id) => [t.owner.id, "care_item", id, { ownerUserId: other.id, previousOwnerUserId: t.clergy.id }]).sort(),
    );
    expectNoSecrets(audit);
  });

  it("a holder who became a caregiver or a reporter counts as departed too", async () => {
    await restrictedItem(false);
    await updateUser(db, t.owner, t.clergy.id, { role: "staff" }, owners);
    expect(await listStrandedRestricted(db, t.owner)).toEqual([{ userId: t.clergy.id, name: "clergy", count: 1 }]);
    expect(await handOverRestrictedItems(db, t.owner, t.clergy.id, t.clergy2.id)).toEqual({ count: 1 });
  });
});

describe("a restricted care item: the audit trail", () => {
  const views = async () => (await db.select().from(auditLog).where(eq(auditLog.action, "restricted.view"))).map((a) => [a.actorUserId, a.subjectId]);

  it("a full read by anyone but its owner is recorded on every path, once per reader, item and day; stubs, empty results and the owner's own reads are not", async () => {
    const s = await restrictedItem(true);
    const deps = { db, sf: fakeSf().sf, now: NOW };
    // Setting it up, the named colleague logged a contact on it: that read was recorded. Start clean.
    expect(await views()).toEqual([[t.clergy2.id, s.item.id]]);
    await db.delete(auditLog);
    // The owner on every path, and those who see a stub or nothing.
    await everything(t.clergy, s.item);
    await getCareItem(db, t.clergy, s.item.id);
    for (const a of [other, t.owner, t.carer, r.staff]) await everything(a, s.item);
    expect(await views()).toEqual([]);

    // The named colleague: each path alone is enough to record it.
    const paths: (() => Promise<unknown>)[] = [
      () => listCareItems(db, t.clergy2),
      () => listCareBoard(db, t.clergy2, BOARD, TODAY),
      () => getTodayCare(db, t.clergy2, TODAY),
      () => getCareItem(db, t.clergy2, s.item.id),
      () => getPersonPage(deps, t.clergy2, CONTACT),
      () => createContactEntry(db, t.clergy2, { careItemId: s.item.id, kind: "call", occurredAt: NOW }),
    ];
    for (const read of paths) {
      await db.delete(auditLog);
      await read();
      expect(await views()).toEqual([[t.clergy2.id, s.item.id]]);
    }
    // And all of them together, again and again, still make one row for the day.
    for (const read of [...paths, ...paths]) await read();
    expect(await views()).toEqual([[t.clergy2.id, s.item.id]]);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "restricted.view"));
    expect(row.detail).toEqual({ day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    // Yesterday's row does not cover today.
    await db.update(auditLog).set({ detail: { day: "2000-01-01" } }).where(eq(auditLog.id, row.id));
    await listCareItems(db, t.clergy2);
    expect(await views()).toHaveLength(2);
  });

  it("no audit row carries note, summary or follow-up text", async () => {
    const s = await restrictedItem(true);
    await getPersonPage({ db, sf: fakeSf().sf, now: NOW }, t.clergy2, CONTACT);
    await updateCareItem(db, t.clergy, s.item.id, { summary: SUMMARY + " still", restrictedShowsCarer: false });
    await deleteContactEntry(db, t.clergy, s.privateEntry.id);
    await deleteFollowUp(db, t.clergy, s.followUp.id);
    const rows = await db.select().from(auditLog);
    expect(new Set(rows.map((a) => a.action))).toEqual(new Set(["care_item.restrict", "restricted.view", "contact.delete", "follow_up.delete"]));
    expectNoSecrets(rows);
    expect(JSON.stringify(rows)).not.toContain("Ruth");
  });
});
