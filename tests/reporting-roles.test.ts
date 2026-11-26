import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied, type Actor } from "@/server/access/policy";
import { resolveActor } from "@/server/access/actor";
import { getTodayCare, listCareBoard } from "@/server/care/boards";
import { closeCareItem, createCareItem, getCareItem, handOverRestrictedItems, listCareItems, listCareItemStubs, listStrandedRestricted, pauseCareItem, updateCareItem } from "@/server/care/care-items";
import { createContactEntry, deleteContactEntry, listContactEntries, updateContactEntry } from "@/server/care/contact-log";
import { createFollowUp, deleteFollowUp, listFollowUps, setFollowUpDone, updateFollowUp } from "@/server/care/follow-ups";
import { listMarkKeys, markOccasion } from "@/server/care/occasion-marks";
import { getPersonPage } from "@/server/care/person-page";
import { resolvePersonRef } from "@/server/care/person-ref";
import { createProposal, listInbox, listMyReports } from "@/server/care/proposals";
import { getTextDrafts, setTextDraft } from "@/server/care/text-drafts";
import { addUser, listTeam, updateUser } from "@/server/care/users";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { auditLog, careItemAccess, careItems, contactLog, followUps, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { findPeople } from "@/server/lifecycle/find-people";
import { getOccasions, getUpcomingOccasions } from "@/server/lifecycle/occasions";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { fakeSf } from "./support/sf";
import { words } from "./support/words";

const NOW = new Date("2026-11-23T16:00:00Z");
const TODAY = "2026-11-23";
const ruth = { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen" };

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
});

describe("staff, lead and senior_staff: report a need, and nothing else", () => {
  it("they may create a proposal and see their own reports", async () => {
    for (const a of Object.values(r)) {
      await createProposal(db, a, { rawText: "Mrs Levy seemed unwell at the office today", channel: "staff" });
      expect(await listMyReports(db, a)).toMatchObject([{ status: "pending", pickedUpBy: null }]);
    }
  });

  it("every read comes back empty, not found or refused, even for records that carry their own id", async () => {
    const sf = fakeSf();
    const deps = { db, sf: sf.sf, now: NOW };
    for (const a of Object.values(r)) {
      // Rows the server functions would never write: an item they hold that is shared with caregivers, their follow-up, their note.
      const [item] = await db.insert(careItems).values({ ...ruth, category: "illness", ownerUserId: a.id, visibility: "caregivers", createdBy: a.id }).returning();
      const [followUp] = await db.insert(followUps).values({ careItemId: item.id, ...ruth, title: "Call", dueDate: "2026-11-20", ownerUserId: a.id, createdBy: a.id }).returning();
      const [entry] = await db.insert(contactLog).values({ ...ruth, careItemId: item.id, kind: "call", occurredAt: NOW, note: "Mine", authorUserId: a.id }).returning();
      await db.insert(careItemAccess).values({ careItemId: item.id, userId: a.id });

      expect(await listCareItems(db, a)).toEqual([]);
      expect(await listCareItemStubs(db, a)).toEqual([]);
      expect(await listCareBoard(db, a, { scope: "all", category: null, status: "open" }, TODAY)).toEqual([]);
      expect(await getTodayCare(db, a, TODAY)).toEqual({ due: [], attention: [], doneToday: 0 });
      expect(await listFollowUps(db, a)).toEqual([]);
      expect(await listContactEntries(db, a)).toEqual([]);
      expect(await listInbox(db, a)).toEqual([]);
      expect(await getTextDrafts(db, a)).toEqual({});
      expect((await listTeam(db, a)).map((m) => m.id)).toEqual([a.id]);

      const notFound: Promise<unknown>[] = [
        getCareItem(db, a, item.id),
        updateCareItem(db, a, item.id, { summary: "x" }),
        closeCareItem(db, a, item.id),
        pauseCareItem(db, a, item.id, "2026-12-01", TODAY),
        createFollowUp(db, a, { careItemId: item.id, title: "x", dueDate: TODAY }),
        createContactEntry(db, a, { careItemId: item.id, kind: "call", occurredAt: NOW }),
        updateFollowUp(db, a, followUp.id, { title: "x" }),
        setFollowUpDone(db, a, followUp.id, true),
        deleteFollowUp(db, a, followUp.id),
        updateContactEntry(db, a, entry.id, { note: "x" }),
        deleteContactEntry(db, a, entry.id),
        getPersonPage(deps, a, CONTACT),
      ];
      for (const attempt of notFound) await expect(attempt).rejects.toBeInstanceOf(NotFound);

      const denied: Promise<unknown>[] = [
        createCareItem(db, a, { ...ruth, category: "illness" }),
        createFollowUp(db, a, { ...ruth, title: "x", dueDate: TODAY }),
        createContactEntry(db, a, { ...ruth, kind: "call", occurredAt: NOW }),
        resolvePersonRef(deps, a, CONTACT),
        findPeople({ sf: sf.sf }, a, "Cohen"),
        getOccasions(deps, a),
        getUpcomingOccasions(deps, a, 7),
        markOccasion(db, a, { occasionType: "birthday", subjectId: CONTACT, sfAccountId: ACCOUNT, year: 2026 }),
        listMarkKeys(db, a, [2026]),
        setTextDraft(db, a, { occasionType: "birthday", body: "Hi" }),
        listStrandedRestricted(db, a),
        handOverRestrictedItems(db, a, t.carer.id, t.clergy.id),
        addUser(db, a, { email: "x@example.test", role: "clergy" }),
        updateUser(db, a, t.carer.id, { active: false }, new Set()),
      ];
      for (const attempt of denied) await expect(attempt).rejects.toBeInstanceOf(AccessDenied);
    }
    // Not one of them caused a Salesforce read.
    expect(sf.queries).toEqual([]);
    expect((await db.select().from(careItems)).map((i) => i.status)).toEqual(["open", "open", "open"]);
    expect(await db.select().from(followUps)).toHaveLength(3);
    expect(await db.select().from(contactLog)).toHaveLength(3);
  });

  it("clergy cannot hand them a care item or a follow-up", async () => {
    const item = await createCareItem(db, t.clergy, { ...ruth, category: "illness", visibility: "caregivers" });
    for (const a of Object.values(r)) {
      await expect(createCareItem(db, t.clergy, { ...ruth, category: "illness", ownerUserId: a.id, visibility: "caregivers" })).rejects.toBeInstanceOf(InvalidInput);
      await expect(updateCareItem(db, t.clergy, item.id, { ownerUserId: a.id })).rejects.toBeInstanceOf(InvalidInput);
      await expect(createFollowUp(db, t.clergy, { careItemId: item.id, title: "x", dueDate: TODAY, ownerUserId: a.id })).rejects.toBeInstanceOf(InvalidInput);
    }
  });
});

describe("the owner assigns the new roles", () => {
  const owners = new Set(["owner@example.test"]);

  it("adds and changes people to staff, lead and senior_staff, and still cannot hand out owner", async () => {
    for (const role of ["staff", "lead", "senior_staff"] as const) {
      const added = await addUser(db, t.owner, { email: `new-${role}@example.test`, role });
      expect(added).toMatchObject({ role, active: true });
      const actor = (await resolveActor(db, { email: added.email }, owners)) as Actor;
      expect(actor.role).toBe(role);
      expect((await updateUser(db, t.owner, t.carer2.id, { role }, owners)).role).toBe(role);
    }
    await expect(addUser(db, t.owner, { email: "boss@example.test", role: "owner" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateUser(db, t.owner, t.carer.id, { role: "owner" }, owners)).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateUser(db, t.owner, t.carer.id, { role: "volunteer" }, owners)).rejects.toBeInstanceOf(InvalidInput);
    await expect(addUser(db, t.clergy, { email: "x@example.test", role: "staff" })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("someone moved to a reporting role keeps no care work: their follow-ups are freed and they are taken off restricted items", async () => {
    const item = await createCareItem(db, t.clergy, { ...ruth, category: "illness", restricted: true, accessUserIds: [t.clergy2.id] });
    const onItem = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call", dueDate: TODAY, ownerUserId: t.clergy2.id });
    const bare = await createFollowUp(db, t.clergy2, { ...ruth, title: "Card", dueDate: TODAY });
    await updateUser(db, t.owner, t.clergy2.id, { role: "staff" }, owners);
    const rows = await db.select().from(followUps);
    expect(rows.find((f) => f.id === onItem.id)!.ownerUserId).toBeNull();
    expect(rows.find((f) => f.id === bare.id)!.ownerUserId).toBeNull();
    expect(await db.select().from(careItemAccess).where(eq(careItemAccess.userId, t.clergy2.id))).toEqual([]);
    const asStaff = { ...t.clergy2, role: "staff" as const };
    expect([await listFollowUps(db, asStaff), await listCareItems(db, asStaff), await listContactEntries(db, asStaff)]).toEqual([[], [], []]);
  });
});

describe("when a clergy member is demoted or deactivated", () => {
  const owners = new Set(["owner@example.test"]);
  const RAW = "Mrs Levy told me about her diagnosis in confidence";
  const reading = { summary: "A new diagnosis", person: { name: "Mrs Levy" } };

  for (const [what, patch] of [
    ["deactivated", { active: false }],
    ["made a caregiver", { role: "caregiver" }],
    ["made staff", { role: "staff" }],
  ] as const) {
    it(`${what}: their own unreviewed captures are dismissed and erased, and they come off restricted items`, async () => {
      const mine = await createProposal(db, t.clergy2, { rawText: RAW, channel: "capture", reading });
      const released = await createProposal(db, t.clergy2, { rawText: RAW, channel: "capture", reading, reviewScope: "clergy" });
      const colleagues = await createProposal(db, t.clergy, { rawText: RAW, channel: "capture", reading });
      const item = await createCareItem(db, t.clergy, { ...ruth, category: "illness", restricted: true, accessUserIds: [t.clergy2.id] });

      await updateUser(db, t.owner, t.clergy2.id, patch, owners);

      const rows = new Map((await db.select().from(proposals)).map((p) => [p.id, p]));
      expect(rows.get(mine.id)).toMatchObject({ status: "dismissed", rawText: null, reading: null, decidedBy: t.owner.id, resultCareItemId: null });
      expect(rows.get(mine.id)!.decidedAt).toBeInstanceOf(Date);
      // What was already in the shared Inbox, and other people's captures, are untouched.
      expect(rows.get(released.id)).toMatchObject({ status: "pending", rawText: RAW, reading });
      expect(rows.get(colleagues.id)).toMatchObject({ status: "pending", rawText: RAW, reading });
      expect(await db.select().from(careItemAccess)).toEqual([]);
      const audit = await db.select().from(auditLog).where(eq(auditLog.action, "proposal.dismiss"));
      expect(audit.map((a) => [a.actorUserId, a.subjectId, a.detail])).toEqual([[t.owner.id, mine.id, { channel: "capture" }]]);
      expect(words(audit)).not.toMatch(/Levy|diagnosis/);
      // Coming back does not bring the access back.
      await updateUser(db, t.owner, t.clergy2.id, { active: true, role: "clergy" }, owners);
      await expect(getCareItem(db, t.clergy2, item.id)).rejects.toBeInstanceOf(NotFound);
    });
  }

  it("a change that does not take them out of clergy leaves their captures alone", async () => {
    const mine = await createProposal(db, t.clergy2, { rawText: RAW, channel: "capture" });
    await updateUser(db, t.owner, t.clergy2.id, { active: true }, owners);
    await updateUser(db, t.owner, t.clergy2.id, { role: "clergy" }, owners);
    expect((await db.select().from(proposals))[0]).toMatchObject({ id: mine.id, status: "pending", rawText: RAW });
  });
});
