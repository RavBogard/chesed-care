import { describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { createContactEntry, listContactEntries } from "@/server/care/contact-log";
import { createFollowUp, listFollowUps, setFollowUpDone, updateFollowUp } from "@/server/care/follow-ups";
import { updateUser } from "@/server/care/users";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { ACCOUNT, CONTACT, CONTACT2, team, testDb } from "./support/db";

async function setup() {
  const db = await testDb();
  const t = await team(db);
  const shared = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth", category: "illness", ownerUserId: t.carer.id, visibility: "caregivers" });
  const clergyOnly = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam", category: "bereavement" });
  return { db, t, shared, clergyOnly };
}

describe("follow-ups", () => {
  it("clergy create on a care item or a person, list by due date, move, complete and reopen", async () => {
    const { db, t, clergyOnly } = await setup();
    const a = await createFollowUp(db, t.clergy, { careItemId: clergyOnly.id, title: "Visit", dueDate: "2026-11-30" });
    expect(a).toMatchObject({ sfContactId: CONTACT2, displayName: "Sam", ownerUserId: t.clergy.id, doneAt: null });
    const b = await createFollowUp(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth", title: "Call", dueDate: "2026-11-25", ownerUserId: t.clergy2.id });
    expect((await listFollowUps(db, t.owner, { open: true })).map((f) => f.id)).toEqual([b.id, a.id]);
    expect((await listFollowUps(db, t.owner, { dueOnOrBefore: "2026-11-26" })).map((f) => f.id)).toEqual([b.id]);

    const moved = await updateFollowUp(db, t.clergy, a.id, { ownerUserId: t.clergy2.id, dueDate: "2026-12-01" });
    expect(moved).toMatchObject({ ownerUserId: t.clergy2.id, dueDate: "2026-12-01" });
    const done = await setFollowUpDone(db, t.clergy2, a.id, true);
    expect(done.doneAt).toBeInstanceOf(Date);
    expect((await listFollowUps(db, t.clergy, { open: false })).map((f) => f.id)).toEqual([a.id]);
    expect((await setFollowUpDone(db, t.clergy, a.id, false)).doneAt).toBeNull();
  });

  it("validates dates, titles and the subject", async () => {
    const { db, t } = await setup();
    await expect(createFollowUp(db, t.clergy, { sfContactId: CONTACT, title: "x", dueDate: "2026-02-30" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createFollowUp(db, t.clergy, { sfContactId: CONTACT, title: "", dueDate: "2026-02-03" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createFollowUp(db, t.clergy, { title: "x", dueDate: "2026-02-03" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createFollowUp(db, t.clergy, { sfContactId: "003x", title: "x", dueDate: "2026-02-03" })).rejects.toBeInstanceOf(InvalidInput);
  });

  it("a caregiver works only on their own follow-ups, on items they can see", async () => {
    const { db, t, shared, clergyOnly } = await setup();
    const mine = await createFollowUp(db, t.carer, { careItemId: shared.id, title: "Bring soup", dueDate: "2026-11-24" });
    await createFollowUp(db, t.clergy, { careItemId: shared.id, title: "Clergy call", dueDate: "2026-11-24" });
    expect((await listFollowUps(db, t.carer)).map((f) => f.id)).toEqual([mine.id]);

    await expect(createFollowUp(db, t.carer, { careItemId: shared.id, title: "x", dueDate: "2026-11-24", ownerUserId: t.carer2.id })).rejects.toBeInstanceOf(AccessDenied);
    await expect(createFollowUp(db, t.carer, { careItemId: clergyOnly.id, title: "x", dueDate: "2026-11-24" })).rejects.toBeInstanceOf(NotFound);
    await expect(createFollowUp(db, t.carer, { sfContactId: CONTACT, title: "x", dueDate: "2026-11-24" })).rejects.toBeInstanceOf(AccessDenied);
    await expect(updateFollowUp(db, t.carer, mine.id, { ownerUserId: t.carer2.id })).rejects.toBeInstanceOf(AccessDenied);
    expect((await updateFollowUp(db, t.carer, mine.id, { dueDate: "2026-11-26" })).dueDate).toBe("2026-11-26");
    expect((await setFollowUpDone(db, t.carer, mine.id, true)).doneAt).not.toBeNull();
  });

  it("another person's follow-up is NotFound for a caregiver", async () => {
    const { db, t, shared } = await setup();
    const clergyFu = await createFollowUp(db, t.clergy, { careItemId: shared.id, title: "Clergy call", dueDate: "2026-11-24" });
    await expect(setFollowUpDone(db, t.carer, clergyFu.id, true)).rejects.toBeInstanceOf(NotFound);
    await expect(updateFollowUp(db, t.carer2, clergyFu.id, { title: "x" })).rejects.toBeInstanceOf(NotFound);
  });

  it("follow-ups go only to active users", async () => {
    const { db, t } = await setup();
    await expect(createFollowUp(db, t.clergy, { sfContactId: CONTACT, title: "x", dueDate: "2026-11-24", ownerUserId: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(InvalidInput);
  });

  it("a caregiver is never given a follow-up on a clergy-only care item or a bare person", async () => {
    const { db, t, shared, clergyOnly } = await setup();
    // At creation.
    await expect(createFollowUp(db, t.clergy, { careItemId: clergyOnly.id, title: "x", dueDate: "2026-11-24", ownerUserId: t.carer.id })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createFollowUp(db, t.clergy, { sfContactId: CONTACT, title: "x", dueDate: "2026-11-24", ownerUserId: t.carer.id })).rejects.toBeInstanceOf(InvalidInput);
    expect(await createFollowUp(db, t.clergy, { careItemId: shared.id, title: "Soup", dueDate: "2026-11-24", ownerUserId: t.carer.id })).toMatchObject({ ownerUserId: t.carer.id });
    // By reassignment.
    const onItem = await createFollowUp(db, t.clergy, { careItemId: clergyOnly.id, title: "Visit", dueDate: "2026-11-24" });
    const onPerson = await createFollowUp(db, t.clergy, { sfContactId: CONTACT, title: "Call", dueDate: "2026-11-24" });
    await expect(updateFollowUp(db, t.clergy, onItem.id, { ownerUserId: t.carer.id })).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateFollowUp(db, t.clergy, onPerson.id, { ownerUserId: t.carer.id })).rejects.toBeInstanceOf(InvalidInput);
    expect(await updateFollowUp(db, t.clergy, onItem.id, { ownerUserId: t.clergy2.id })).toMatchObject({ ownerUserId: t.clergy2.id });
    expect((await listFollowUps(db, t.carer)).map((f) => f.title)).toEqual(["Soup"]);
  });

  it("when clergy become a caregiver, their clergy-only follow-ups are unassigned and their notes on clergy-only people hidden", async () => {
    const { db, t, shared, clergyOnly } = await setup();
    const kept = await createFollowUp(db, t.clergy2, { careItemId: shared.id, title: "Shared", dueDate: "2026-11-24" });
    const onItem = await createFollowUp(db, t.clergy2, { careItemId: clergyOnly.id, title: "Clergy item", dueDate: "2026-11-25" });
    const onPerson = await createFollowUp(db, t.clergy2, { sfContactId: CONTACT, title: "Person", dueDate: "2026-11-26" });
    const done = await createFollowUp(db, t.clergy2, { careItemId: clergyOnly.id, title: "Done", dueDate: "2026-11-20" });
    await setFollowUpDone(db, t.clergy2, done.id, true);
    const sharedNote = await createContactEntry(db, t.clergy2, { careItemId: shared.id, kind: "visit", occurredAt: "2026-11-20T15:00:00Z", note: "On the shared item" });
    await createContactEntry(db, t.clergy2, { careItemId: clergyOnly.id, kind: "call", occurredAt: "2026-11-20T15:00:00Z", note: "Clergy-only item" });
    await createContactEntry(db, t.clergy2, { sfContactId: CONTACT2, displayName: "Sam", kind: "call", occurredAt: "2026-11-20T15:00:00Z", note: "About a person" });

    await updateUser(db, t.owner, t.clergy2.id, { role: "caregiver" }, new Set([t.owner.email]));
    const demoted = { ...t.clergy2, role: "caregiver" as const };

    const all = await listFollowUps(db, t.owner);
    const owners = Object.fromEntries(all.map((f) => [f.id, f.ownerUserId]));
    expect(owners).toEqual({ [kept.id]: t.clergy2.id, [onItem.id]: null, [onPerson.id]: null, [done.id]: null });
    expect((await listFollowUps(db, demoted)).map((f) => f.id)).toEqual([kept.id]);
    expect((await listContactEntries(db, demoted)).map((e) => e.id)).toEqual([sharedNote.id]);
    // Clergy still see everything, unassigned work included.
    expect(await listContactEntries(db, t.clergy)).toHaveLength(3);
    // A clergy member can pick the unassigned work up again.
    expect(await updateFollowUp(db, t.clergy, onItem.id, { ownerUserId: t.clergy.id })).toMatchObject({ ownerUserId: t.clergy.id });
  });
});
