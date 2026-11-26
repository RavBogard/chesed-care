import { describe, expect, it } from "vitest";
import {
  canCreateContactEntry,
  canCreateFollowUp,
  canEditContactEntry,
  canEditFollowUp,
  canManageCareItems,
  canManageUsers,
  canMarkOccasion,
  canReadNote,
  canReassignFollowUp,
  canSeeCareItem,
  canSeeContactEntry,
  canSeeFollowUp,
  canSeeLifecycle,
  careItemVisibleWhere,
  contactEntryVisibleWhere,
  decideAccess,
  followUpVisibleWhere,
  isValidAssignment,
  parseOwnerEmails,
  redactEntry,
  ASSIGNABLE_ROLES,
  canCreateProposal,
  canDeleteFollowUp,
  canHoldRestricted,
  canManageOutsidePeople,
  canChangeRestriction,
  canHandOverRestricted,
  canSeeOutsidePerson,
  canSeeStrandedRestricted,
  outsidePersonVisibleWhere,
  canReleaseProposal,
  canReviewProposal,
  canSeeCareItemStub,
  careItemStubWhere,
  isCareTeam,
  isRestrictedFrom,
  namedOn,
  reviewScopeFor,
  type Actor,
} from "@/server/access/policy";
import { careItemAccess, careItems, contactLog, followUps, outsidePeople } from "@/server/db/schema";
import { ACCOUNT, addActor, CONTACT, team, testDb } from "./support/db";

const owner: Actor = { id: "u-owner", email: "o@x.test", name: "O", role: "owner" };
const clergy: Actor = { id: "u-clergy", email: "c@x.test", name: "C", role: "clergy" };
const carer: Actor = { id: "u-carer", email: "g@x.test", name: "G", role: "caregiver" };
const carer2: Actor = { id: "u-carer2", email: "h@x.test", name: "H", role: "caregiver" };
const staff: Actor = { id: "u-staff", email: "s@x.test", name: "S", role: "staff" };
const lead: Actor = { id: "u-lead", email: "l@x.test", name: "L", role: "lead" };
const senior: Actor = { id: "u-senior", email: "t@x.test", name: "T", role: "senior_staff" };
const reporters = [staff, lead, senior];
/** Not restricted. */
const plain = { restricted: false, restrictedShowsCarer: true, named: false } as const;

describe("allowlist", () => {
  const owners = parseOwnerEmails(" Rabbi@CRC.test , ,not-an-email, second@crc.test");

  it("parses OWNER_EMAILS case-insensitively, dropping blanks and junk", () => {
    expect([...owners].sort()).toEqual(["rabbi@crc.test", "second@crc.test"]);
    expect(parseOwnerEmails(undefined).size).toBe(0);
    expect(parseOwnerEmails("").size).toBe(0);
  });

  it("recognises an owner email regardless of case, with or without a row", () => {
    expect(decideAccess("RABBI@crc.test", owners, null)).toEqual({ kind: "owner" });
    expect(decideAccess("rabbi@crc.test", owners, { id: "x", role: "caregiver", active: false })).toEqual({ kind: "owner" });
  });

  it("lets in an active listed user with their role", () => {
    expect(decideAccess("a@crc.test", owners, { id: "x", role: "clergy", active: true })).toEqual({ kind: "member", userId: "x", role: "clergy" });
    expect(decideAccess("a@crc.test", owners, { id: "x", role: "caregiver", active: true })).toEqual({ kind: "member", userId: "x", role: "caregiver" });
  });

  it("denies unknown, inactive and empty emails", () => {
    expect(decideAccess("stranger@gmail.test", owners, null).kind).toBe("denied");
    expect(decideAccess("a@crc.test", owners, { id: "x", role: "clergy", active: false }).kind).toBe("denied");
    expect(decideAccess("  ", owners, null).kind).toBe("denied");
  });

  it("never grants owner from the database alone: an owner row not in OWNER_EMAILS acts as clergy", () => {
    expect(decideAccess("former@crc.test", owners, { id: "x", role: "owner", active: true })).toEqual({ kind: "member", userId: "x", role: "clergy" });
  });

  it("does not treat a lookalike address as an owner", () => {
    expect(decideAccess("rabbi@crc.test.evil.test", owners, null).kind).toBe("denied");
    expect(decideAccess("xrabbi@crc.test", owners, null).kind).toBe("denied");
  });
});

describe("role capabilities", () => {
  it("only owners manage users", () => {
    expect(canManageUsers(owner)).toBe(true);
    expect(canManageUsers(clergy)).toBe(false);
    expect(canManageUsers(carer)).toBe(false);
  });

  it("lifecycle dates and marks are for clergy level only", () => {
    for (const a of [owner, clergy]) expect([canSeeLifecycle(a), canMarkOccasion(a)]).toEqual([true, true]);
    expect([canSeeLifecycle(carer), canMarkOccasion(carer)]).toEqual([false, false]);
  });

  it("only clergy level manage care items or reassign follow-ups", () => {
    expect([owner, clergy, carer].map(canManageCareItems)).toEqual([true, true, false]);
    expect([owner, clergy, carer].map(canReassignFollowUp)).toEqual([true, true, false]);
  });
});

describe("care items", () => {
  const assignedShared = { ownerUserId: carer.id, visibility: "caregivers" as const, ...plain };
  const assignedClergyOnly = { ownerUserId: carer.id, visibility: "clergy" as const, ...plain };
  const otherCarers = { ownerUserId: carer2.id, visibility: "caregivers" as const, ...plain };
  const clergyItem = { ownerUserId: clergy.id, visibility: "clergy" as const, ...plain };

  it("clergy level see every item", () => {
    for (const a of [owner, clergy]) for (const i of [assignedShared, assignedClergyOnly, otherCarers, clergyItem]) expect(canSeeCareItem(a, i)).toBe(true);
  });

  it("a caregiver sees only items assigned to them and visible to caregivers", () => {
    expect(canSeeCareItem(carer, assignedShared)).toBe(true);
    expect(canSeeCareItem(carer, assignedClergyOnly)).toBe(false);
    expect(canSeeCareItem(carer, otherCarers)).toBe(false);
    expect(canSeeCareItem(carer, clergyItem)).toBe(false);
  });

  it("an item can go to a caregiver only when visible to caregivers, and never to an inactive user", () => {
    expect(isValidAssignment({ role: "caregiver", active: true }, "caregivers")).toBe(true);
    expect(isValidAssignment({ role: "caregiver", active: true }, "clergy")).toBe(false);
    expect(isValidAssignment({ role: "clergy", active: true }, "clergy")).toBe(true);
    expect(isValidAssignment({ role: "clergy", active: false }, "clergy")).toBe(false);
  });
});

describe("follow-ups", () => {
  const sharedItem = { ownerUserId: carer.id, visibility: "caregivers" as const, ...plain };
  const hiddenItem = { ownerUserId: clergy.id, visibility: "clergy" as const, ...plain };

  it("clergy level see and edit all; a caregiver only their own", () => {
    expect(canSeeFollowUp(clergy, { ownerUserId: carer.id, careItem: null })).toBe(true);
    expect(canSeeFollowUp(carer, { ownerUserId: carer.id, careItem: null })).toBe(true);
    expect(canSeeFollowUp(carer, { ownerUserId: clergy.id, careItem: null })).toBe(false);
    expect(canEditFollowUp(carer, { ownerUserId: carer2.id, careItem: null })).toBe(false);
  });

  it("a caregiver creates follow-ups only for themselves, on an item they can see", () => {
    expect(canCreateFollowUp(carer, { ownerUserId: carer.id, careItem: sharedItem })).toBe(true);
    expect(canCreateFollowUp(carer, { ownerUserId: carer2.id, careItem: sharedItem })).toBe(false);
    expect(canCreateFollowUp(carer, { ownerUserId: carer.id, careItem: hiddenItem })).toBe(false);
    expect(canCreateFollowUp(carer, { ownerUserId: carer.id, careItem: null })).toBe(false);
    expect(canCreateFollowUp(clergy, { ownerUserId: carer.id, careItem: null })).toBe(true);
  });
});

describe("contact log notes", () => {
  const clergyPublic = { authorUserId: clergy.id, private: false };
  const clergyPrivate = { authorUserId: clergy.id, private: true };
  const carerPublic = { authorUserId: carer.id, private: false };
  const carerPrivate = { authorUserId: carer.id, private: true };

  it("a private note is readable by its author only — not even the owner", () => {
    expect(canReadNote(clergy, clergyPrivate)).toBe(true);
    expect(canReadNote(owner, clergyPrivate)).toBe(false);
    expect(canReadNote({ ...clergy, id: "u-other-clergy" }, clergyPrivate)).toBe(false);
    expect(canReadNote(carer, clergyPrivate)).toBe(false);
    expect(canReadNote(clergy, carerPrivate)).toBe(false);
  });

  it("a non-private note is readable by all clergy level", () => {
    expect(canReadNote(owner, clergyPublic)).toBe(true);
    expect(canReadNote({ ...clergy, id: "u-other-clergy" }, clergyPublic)).toBe(true);
    expect(canReadNote(clergy, carerPublic)).toBe(true);
  });

  it("caregivers never read clergy notes or another caregiver's notes", () => {
    expect(canReadNote(carer, clergyPublic)).toBe(false);
    expect(canReadNote(carer2, carerPublic)).toBe(false);
    expect(canReadNote(carer, carerPublic)).toBe(true);
  });

  it("caregivers list only their own entries on care items visible to caregivers; clergy level list all", () => {
    const shared = { careItemVisibility: "caregivers" as const, careItem: null };
    expect(canSeeContactEntry(carer, { ...clergyPublic, ...shared })).toBe(false);
    expect(canSeeContactEntry(carer, { ...carerPrivate, ...shared })).toBe(true);
    expect(canSeeContactEntry(clergy, { ...carerPrivate, ...shared })).toBe(true);
    // Their own notes about clergy-only people (a clergy-only item, or a person directly) stay hidden.
    expect(canSeeContactEntry(carer, { ...carerPublic, careItemVisibility: "clergy", careItem: null })).toBe(false);
    expect(canSeeContactEntry(carer, { ...carerPublic, careItemVisibility: null, careItem: null })).toBe(false);
    expect(canSeeContactEntry(clergy, { ...carerPublic, careItemVisibility: null, careItem: null })).toBe(true);
  });

  it("redaction removes the text but keeps that a contact happened", () => {
    const entry = { ...clergyPrivate, note: "pastoral detail", kind: "visit", occurredAt: new Date("2026-11-20T15:00:00Z") };
    const seen = redactEntry(owner, entry);
    expect(seen.note).toBeNull();
    expect(seen.noteHidden).toBe(true);
    expect(seen.kind).toBe("visit");
    expect(seen.occurredAt).toEqual(entry.occurredAt);
    expect(redactEntry(clergy, entry)).toMatchObject({ note: "pastoral detail", noteHidden: false });
    expect(entry.note).toBe("pastoral detail");
  });

  it("only the author edits an entry; caregivers log only against items they can see", () => {
    expect(canEditContactEntry(clergy, clergyPublic)).toBe(true);
    expect(canEditContactEntry(owner, clergyPublic)).toBe(false);
    expect(canCreateContactEntry(clergy, null)).toBe(true);
    expect(canCreateContactEntry(carer, null)).toBe(false);
    expect(canCreateContactEntry(carer, { ownerUserId: carer.id, visibility: "caregivers", ...plain })).toBe(true);
    expect(canCreateContactEntry(carer, { ownerUserId: carer.id, visibility: "clergy", ...plain })).toBe(false);
  });
});

describe("restricted care items", () => {
  const base = { ownerUserId: clergy.id, visibility: "clergy" as const, restricted: true };
  const shown = { ...base, restrictedShowsCarer: true, named: false };
  const hidden = { ...base, restrictedShowsCarer: false, named: false };
  const other: Actor = { id: "u-other-clergy", email: "d@x.test", name: "D", role: "clergy" };

  it("the owner and the clergy named on it see it in full; no one else does, the owner role included", () => {
    for (const item of [shown, hidden]) {
      expect(canSeeCareItem(clergy, item)).toBe(true);
      expect(canSeeCareItem(other, { ...item, named: true })).toBe(true);
      for (const a of [owner, other, carer, ...reporters]) expect(canSeeCareItem(a, item)).toBe(false);
    }
  });

  it("a caregiver or reporter never sees one, even if named on it or holding it", () => {
    for (const a of [carer, ...reporters]) {
      expect(canSeeCareItem(a, { ...shown, named: true })).toBe(false);
      expect(canSeeCareItem(a, { ...shown, ownerUserId: a.id })).toBe(false);
      expect(canSeeCareItemStub(a, shown)).toBe(false);
      expect(isRestrictedFrom(a, { ...shown, named: true })).toBe(true);
    }
  });

  it("other clergy level get the stub only when the item shows its carer", () => {
    for (const a of [owner, other]) {
      expect(canSeeCareItemStub(a, shown)).toBe(true);
      expect(canSeeCareItemStub(a, hidden)).toBe(false);
    }
    // Those with full access have the item itself, not a stub.
    expect(canSeeCareItemStub(clergy, shown)).toBe(false);
    expect(canSeeCareItemStub(other, { ...shown, named: true })).toBe(false);
  });

  it("only its owner changes the restriction: not a named colleague, not the owner role", () => {
    expect(canChangeRestriction(clergy, shown)).toBe(true);
    for (const a of [owner, other, carer, ...reporters]) expect(canChangeRestriction(a, shown)).toBe(false);
    // A caregiver or reporter holding one (a row the functions refuse) still decides nothing.
    for (const a of [carer, ...reporters]) expect(canChangeRestriction(a, { ownerUserId: a.id })).toBe(false);
  });

  it("the owner role hands restricted items on only from a holder who can no longer hold one; no one else ever does", () => {
    const departed = [{ role: "clergy", active: false }, { role: "caregiver", active: true }, { role: "staff", active: true }, { role: "owner", active: false }] as const;
    const present = [{ role: "clergy", active: true }, { role: "owner", active: true }] as const;
    for (const holder of departed) expect(canHandOverRestricted(owner, holder)).toBe(true);
    for (const holder of present) expect(canHandOverRestricted(owner, holder)).toBe(false);
    for (const a of [clergy, other, carer, ...reporters]) {
      expect(canSeeStrandedRestricted(a)).toBe(false);
      for (const holder of [...departed, ...present]) expect(canHandOverRestricted(a, holder)).toBe(false);
    }
    expect(canSeeStrandedRestricted(owner)).toBe(true);
  });

  it("an outside person is hidden when every care item about them is restricted away from the viewer, unless the viewer added them", () => {
    const person = { createdBy: clergy.id };
    const closedToOthers = { ownerUserId: clergy.id, restricted: true, named: false };
    const openItem = { ownerUserId: clergy.id, restricted: false, named: false };
    for (const a of [owner, other]) {
      expect(canSeeOutsidePerson(a, person, [])).toBe(true);
      expect(canSeeOutsidePerson(a, person, [closedToOthers])).toBe(false);
      expect(canSeeOutsidePerson(a, person, [closedToOthers, closedToOthers])).toBe(false);
      expect(canSeeOutsidePerson(a, person, [closedToOthers, openItem])).toBe(true);
      expect(canSeeOutsidePerson(a, person, [{ ...closedToOthers, named: true }])).toBe(true);
      expect(canSeeOutsidePerson(a, { createdBy: a.id }, [closedToOthers])).toBe(true);
    }
    expect(canSeeOutsidePerson(clergy, person, [closedToOthers])).toBe(true);
    for (const a of [carer, ...reporters]) expect(canSeeOutsidePerson(a, { createdBy: a.id }, [])).toBe(false);
  });

  it("follow-ups and contact entries on it exist only for those with full access", () => {
    const item = { ownerUserId: clergy.id, restricted: true, named: false };
    for (const a of [owner, other, carer, ...reporters]) {
      expect(canSeeFollowUp(a, { ownerUserId: a.id, careItem: item })).toBe(false);
      expect(canDeleteFollowUp(a, { ownerUserId: a.id, createdBy: a.id, careItem: item })).toBe(false);
      expect(canSeeContactEntry(a, { authorUserId: a.id, private: false, careItemVisibility: "clergy", careItem: item })).toBe(false);
    }
    expect(canSeeFollowUp(clergy, { ownerUserId: null, careItem: item })).toBe(true);
    expect(canSeeFollowUp(other, { ownerUserId: null, careItem: { ...item, named: true } })).toBe(true);
    expect(canSeeContactEntry(clergy, { authorUserId: other.id, private: true, careItemVisibility: "clergy", careItem: item })).toBe(true);
    expect(canCreateFollowUp(other, { ownerUserId: other.id, careItem: shown })).toBe(false);
    expect(canCreateContactEntry(owner, shown)).toBe(false);
  });

  it("only active clergy level can own one or be named on one", () => {
    expect(canHoldRestricted({ role: "clergy", active: true })).toBe(true);
    expect(canHoldRestricted({ role: "owner", active: true })).toBe(true);
    expect(canHoldRestricted({ role: "clergy", active: false })).toBe(false);
    for (const role of ["caregiver", "staff", "lead", "senior_staff"] as const) expect(canHoldRestricted({ role, active: true })).toBe(false);
  });
});

describe("staff, lead and senior_staff", () => {
  const sharedItem = { ownerUserId: staff.id, visibility: "caregivers" as const, ...plain };

  it("have none of the care capabilities, even over records with their own id on them", () => {
    for (const a of reporters) {
      expect([canManageUsers(a), canSeeLifecycle(a), canMarkOccasion(a), canManageCareItems(a), canReassignFollowUp(a), canManageOutsidePeople(a), isCareTeam(a)]).toEqual([false, false, false, false, false, false, false]);
      const mine = { ...sharedItem, ownerUserId: a.id };
      expect(canSeeCareItem(a, mine)).toBe(false);
      expect(canSeeFollowUp(a, { ownerUserId: a.id, careItem: null })).toBe(false);
      expect(canCreateFollowUp(a, { ownerUserId: a.id, careItem: mine })).toBe(false);
      expect(canDeleteFollowUp(a, { ownerUserId: a.id, createdBy: a.id, careItem: null })).toBe(false);
      expect(canSeeContactEntry(a, { authorUserId: a.id, private: false, careItemVisibility: "caregivers", careItem: null })).toBe(false);
      expect(canReadNote(a, { authorUserId: a.id, private: false })).toBe(false);
      expect(canCreateContactEntry(a, mine)).toBe(false);
      expect(canEditContactEntry(a, { authorUserId: a.id, private: false })).toBe(false);
    }
  });

  it("are never given a care item or a follow-up", () => {
    for (const role of ["staff", "lead", "senior_staff"] as const) for (const v of ["clergy", "caregivers"] as const) expect(isValidAssignment({ role, active: true }, v)).toBe(false);
  });

  it("are let in from the allowlist with their role, and can be assigned by the owner", () => {
    const owners = parseOwnerEmails("rabbi@crc.test");
    for (const role of ["staff", "lead", "senior_staff"] as const) {
      expect(decideAccess("a@crc.test", owners, { id: "x", role, active: true })).toEqual({ kind: "member", userId: "x", role });
      expect(ASSIGNABLE_ROLES).toContain(role);
    }
    expect(ASSIGNABLE_ROLES).not.toContain("owner");
  });
});

describe("proposals", () => {
  it("anyone may report; only a clergy level capture stays with its submitter", () => {
    for (const a of [owner, clergy, carer, ...reporters]) expect(canCreateProposal(a)).toBe(true);
    for (const a of [owner, clergy]) expect([reviewScopeFor(a, undefined), reviewScopeFor(a, "clergy")]).toEqual(["submitter", "clergy"]);
    for (const a of [carer, ...reporters]) expect([reviewScopeFor(a, undefined), reviewScopeFor(a, "submitter")]).toEqual(["clergy", "clergy"]);
  });

  it("clergy level review the shared Inbox and their own captures; no one else reviews anything, their own included", () => {
    const sharedOne = { submittedBy: staff.id, reviewScope: "clergy" as const };
    const mine = { submittedBy: clergy.id, reviewScope: "submitter" as const };
    expect(canReviewProposal(owner, sharedOne)).toBe(true);
    expect(canReviewProposal(clergy, mine)).toBe(true);
    expect(canReviewProposal(owner, mine)).toBe(false);
    for (const a of [carer, ...reporters]) expect(canReviewProposal(a, { submittedBy: a.id, reviewScope: "clergy" })).toBe(false);
    expect(canReleaseProposal(clergy, mine)).toBe(true);
    expect(canReleaseProposal(owner, mine)).toBe(false);
    expect(canReleaseProposal(clergy, { ...mine, reviewScope: "clergy" })).toBe(false);
  });
});

describe("SQL conditions agree with the predicates", () => {
  it("over every combination of role, owner, visibility, restriction, naming and author", async () => {
    const db = await testDb();
    const t = await team(db);
    const r = { staff: await addActor(db, "staff@example.test", "staff"), lead: await addActor(db, "lead@example.test", "lead"), senior: await addActor(db, "senior@example.test", "senior_staff") };
    const actors = [...Object.values(t), ...Object.values(r)];
    const person = { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "P" };
    // Rows are inserted directly, so combinations the server functions refuse (a caregiver holding a restricted item) are covered too.
    for (const o of actors) {
      await db.insert(careItems).values({ ...person, category: "illness", ownerUserId: o.id, visibility: "caregivers", createdBy: t.clergy.id });
      for (const restriction of [null, { restrictedShowsCarer: true }, { restrictedShowsCarer: false }]) {
        for (const named of restriction ? [[], [t.clergy2.id, t.owner.id, t.carer.id, r.staff.id]] : [[]]) {
          const [item] = await db
            .insert(careItems)
            .values({ ...person, category: "illness", ownerUserId: o.id, visibility: "clergy", createdBy: t.clergy.id, restricted: restriction !== null, ...restriction })
            .returning();
          if (named.length) await db.insert(careItemAccess).values(named.map((userId) => ({ careItemId: item.id, userId })));
        }
      }
    }
    // Outside people: one with no care item, and for two different creators one with only an open item, only restricted ones, and both.
    const outsideItem = { displayName: "O", category: "illness" as const, visibility: "clergy" as const, createdBy: t.clergy.id };
    await db.insert(outsidePeople).values({ name: "No items", createdBy: t.clergy.id });
    for (const creator of [t.clergy, t.clergy2]) {
      for (const shape of [[false], [true], [true, true], [true, false]]) {
        const [person] = await db.insert(outsidePeople).values({ name: "O", createdBy: creator.id }).returning();
        for (const restricted of shape) {
          const [item] = await db.insert(careItems).values({ ...outsideItem, outsidePersonId: person.id, ownerUserId: t.clergy.id, restricted }).returning();
          if (restricted && shape.length === 2) await db.insert(careItemAccess).values({ careItemId: item.id, userId: t.owner.id });
        }
      }
    }
    const allItems = await db.select().from(careItems);
    const allOutside = await db.select().from(outsidePeople);
    for (const careItemId of [null, ...allItems.filter((i) => i.sfContactId).map((i) => i.id)]) {
      for (const o of [t.clergy, t.clergy2, t.carer, r.staff, null]) {
        await db.insert(followUps).values({ careItemId, sfContactId: CONTACT, title: "Call", dueDate: "2026-11-30", ownerUserId: o?.id ?? null, createdBy: t.clergy.id });
      }
      // Mitzvah Corps steps, held by the lead, by staff and by clergy (as a restricted item's are), and a plain follow-up held by the lead.
      for (const o of [r.lead, r.staff, t.clergy]) {
        await db.insert(followUps).values({ careItemId, sfContactId: CONTACT, title: "Arrange meals", dueDate: "2026-11-30", ownerUserId: o.id, forLead: true, createdBy: t.clergy.id });
      }
      await db.insert(followUps).values({ careItemId, sfContactId: CONTACT, title: "Call", dueDate: "2026-11-30", ownerUserId: r.lead.id, createdBy: t.clergy.id });
      for (const author of [t.owner, t.clergy, t.carer, r.lead]) {
        await db.insert(contactLog).values({ ...person, careItemId, kind: "call", occurredAt: new Date(), note: "n", private: author === t.clergy, authorUserId: author.id });
      }
    }
    const access = new Set((await db.select().from(careItemAccess)).map((a) => `${a.careItemId}|${a.userId}`));
    const itemsById = new Map(allItems.map((i) => [i.id, i]));
    const allFollowUps = await db.select().from(followUps);
    const allEntries = await db.select().from(contactLog);
    const ids = (rows: { id: string }[]) => new Set(rows.map((row) => row.id));

    for (const a of actors) {
      const itemRow = (i: (typeof allItems)[number]) => ({ ...i, named: access.has(`${i.id}|${a.id}`) });
      const restriction = (careItemId: string | null) => (careItemId ? itemRow(itemsById.get(careItemId)!) : null);
      expect(ids(await db.select({ id: careItems.id }).from(careItems).where(careItemVisibleWhere(a)))).toEqual(ids(allItems.filter((i) => canSeeCareItem(a, itemRow(i)))));
      expect(ids(await db.select({ id: careItems.id }).from(careItems).where(careItemStubWhere(a)))).toEqual(ids(allItems.filter((i) => canSeeCareItemStub(a, itemRow(i)))));
      expect(ids(await db.select({ id: followUps.id }).from(followUps).where(followUpVisibleWhere(a)))).toEqual(
        ids(allFollowUps.filter((f) => canSeeFollowUp(a, { ownerUserId: f.ownerUserId, careItem: restriction(f.careItemId), forLead: f.forLead }))),
      );
      expect(ids(await db.select({ id: contactLog.id }).from(contactLog).where(contactEntryVisibleWhere(a)))).toEqual(
        ids(allEntries.filter((e) => canSeeContactEntry(a, { ...e, careItemVisibility: restriction(e.careItemId)?.visibility ?? null, careItem: restriction(e.careItemId) }))),
      );
      expect(ids(await db.select({ id: outsidePeople.id }).from(outsidePeople).where(outsidePersonVisibleWhere(a)))).toEqual(
        ids(allOutside.filter((p) => canSeeOutsidePerson(a, p, allItems.filter((i) => i.outsidePersonId === p.id).map(itemRow)))),
      );
      // The named flag the queries compute is the one the predicates were given.
      const named = await db.select({ id: careItems.id, named: namedOn(a) }).from(careItems);
      for (const n of named) expect(n.named).toBe(access.has(`${n.id}|${a.id}`));
    }

    const count = async (a: Actor) => ({
      items: (await db.select().from(careItems).where(careItemVisibleWhere(a))).length,
      stubs: (await db.select().from(careItems).where(careItemStubWhere(a))).length,
      followUps: (await db.select().from(followUps).where(followUpVisibleWhere(a))).length,
      entries: (await db.select().from(contactLog).where(contactEntryVisibleWhere(a))).length,
    });
    // Per owner: 2 unrestricted items, 2 restricted that show their carer (one naming people), 2 that do not.
    // Clergy: the 16 unrestricted, their own 4 restricted, and nothing of the 28 held by others.
    expect(await count(t.clergy)).toMatchObject({ items: 20 + 12, stubs: 14 });
    // A lead: their own Mitzvah Corps step on each of the 16 unrestricted items, and nothing else at all.
    expect(await count(r.lead)).toEqual({ items: 0, stubs: 0, followUps: 16, entries: 0 });
    expect(await count(r.staff)).toEqual({ items: 0, stubs: 0, followUps: 0, entries: 0 });
    // The owner role is no exception: their own 4, the 14 they are named on, and only stubs for 7 of the other 14.
    expect(await count(t.owner)).toMatchObject({ items: 34 + 4 + 6, stubs: 7 + 2 });
    // Outside people: clergy, who holds every item about them, sees all nine. clergy2 does not see the two that
    // someone else added and that have only restricted items; the owner role, named on some, misses one.
    const outsideCount = async (a: Actor) => (await db.select().from(outsidePeople).where(outsidePersonVisibleWhere(a))).length;
    expect([await outsideCount(t.clergy), await outsideCount(t.clergy2), await outsideCount(t.owner), await outsideCount(t.carer), await outsideCount(r.staff)]).toEqual([9, 7, 7, 0, 0]);
    // A caregiver: the one unrestricted item shared with them. Named on restricted items, holding restricted items: still nothing.
    expect(await count(t.carer)).toMatchObject({ items: 1, stubs: 0 });
    for (const a of [r.staff, r.senior]) expect(await count(a)).toEqual({ items: 0, stubs: 0, followUps: 0, entries: 0 });
  });
});
