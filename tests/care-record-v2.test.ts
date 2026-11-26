import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { getTodayCare, listCareBoard, parseCareBoardFilter } from "@/server/care/boards";
import { closeCareItem, createCareItem, getCareItem, listCareItems, pauseCareItem, reopenCareItem, resumeCareItem, updateCareItem } from "@/server/care/care-items";
import { createContactEntry, deleteContactEntry, listContactEntries, updateContactEntry } from "@/server/care/contact-log";
import { createFollowUp, deleteFollowUp, listFollowUps, setFollowUpDone } from "@/server/care/follow-ups";
import { createOutsidePerson, getOutsidePerson, searchOutsidePeople } from "@/server/care/outside-people";
import { getOutsidePersonPage } from "@/server/care/person-page";
import { acceptProposal, createProposal } from "@/server/care/proposals";
import { isActiveCareItem, isPausedCareItem } from "@/server/care/status";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { auditLog, careItems, contactLog, followUps } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { ACCOUNT, addActor, CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";
import { words } from "./support/words";

const NOW = new Date("2026-11-23T16:00:00Z");
const TODAY = "2026-11-23";
const BOARD = { scope: "all", category: null, status: "open" } as const;
const ruth = { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen" };

let db: Db;
let t: Awaited<ReturnType<typeof team>>;

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
});

const statusOf = async (id: string) => (await db.select().from(careItems).where(eq(careItems.id, id)))[0].status;

describe("status: new, open, paused, closed", () => {
  it("a new item is new, and the first contact logged against it makes it open", async () => {
    const item = await createCareItem(db, t.clergy, { ...ruth, category: "illness", summary: "Hip surgery on Tuesday", location: "Barnes, room 4", learnedFrom: "Her daughter called" });
    expect(item).toMatchObject({ status: "new", summary: "Hip surgery on Tuesday", location: "Barnes, room 4", learnedFrom: "Her daughter called", source: "clergy" });
    // A follow-up is a plan, not a contact.
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call", dueDate: "2026-12-01" });
    expect(await statusOf(item.id)).toBe("new");
    await createContactEntry(db, t.clergy2, { careItemId: item.id, kind: "call", occurredAt: NOW });
    expect(await statusOf(item.id)).toBe("open");
  });

  it("a contact with the person makes their new items open, and leaves other people's and other statuses alone", async () => {
    const fresh = await createCareItem(db, t.clergy, { ...ruth, category: "illness" });
    const second = await createCareItem(db, t.clergy2, { ...ruth, category: "bereavement" });
    const closed = await createCareItem(db, t.clergy, { ...ruth, category: "other" });
    await closeCareItem(db, t.clergy, closed.id);
    const sam = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam Cohen", category: "illness" });
    await createContactEntry(db, t.clergy, { ...ruth, kind: "visit", occurredAt: NOW });
    expect([await statusOf(fresh.id), await statusOf(second.id), await statusOf(closed.id), await statusOf(sam.id)]).toEqual(["open", "open", "closed", "new"]);
  });

  it("a contact with the person never opens a new restricted item its author cannot see", async () => {
    const hidden = await createCareItem(db, t.clergy, { ...ruth, category: "mental_health", restricted: true, restrictedShowsCarer: false });
    const stubbed = await createCareItem(db, t.clergy, { ...ruth, category: "mental_health", restricted: true, accessUserIds: [t.clergy2.id] });
    const plain = await createCareItem(db, t.clergy, { ...ruth, category: "illness" });
    // The owner role, by a logged contact and by finishing a person-level follow-up with an outcome.
    await createContactEntry(db, t.owner, { ...ruth, kind: "call", occurredAt: NOW });
    const followUp = await createFollowUp(db, t.owner, { ...ruth, title: "Call", dueDate: TODAY });
    await setFollowUpDone(db, t.owner, followUp.id, true, { outcome: "spoke", now: NOW });
    expect([await statusOf(hidden.id), await statusOf(stubbed.id), await statusOf(plain.id)]).toEqual(["new", "new", "open"]);
    // The named colleague opens the one they can see; only the holder opens the other.
    await createContactEntry(db, t.clergy2, { ...ruth, kind: "call", occurredAt: NOW });
    expect([await statusOf(hidden.id), await statusOf(stubbed.id)]).toEqual(["new", "open"]);
    await createContactEntry(db, t.clergy, { ...ruth, kind: "call", occurredAt: NOW });
    expect(await statusOf(hidden.id)).toBe("open");
  });

  it("completing a follow-up with an outcome is a first contact too", async () => {
    const item = await createCareItem(db, t.clergy, { ...ruth, category: "illness" });
    const followUp = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call", dueDate: "2026-11-23" });
    await setFollowUpDone(db, t.clergy, followUp.id, true);
    expect(await statusOf(item.id)).toBe("new");
    await setFollowUpDone(db, t.clergy, followUp.id, false);
    await setFollowUpDone(db, t.clergy, followUp.id, true, { outcome: "left_message", now: NOW });
    expect(await statusOf(item.id)).toBe("open");
  });

  it("existing rows (the column default) stay open", async () => {
    const [row] = await db.insert(careItems).values({ ...ruth, category: "illness", ownerUserId: t.clergy.id, createdBy: t.clergy.id }).returning();
    expect(row).toMatchObject({ status: "open", source: "clergy", restricted: false, restrictedShowsCarer: true, summary: null, pausedUntil: null });
  });

  it("a paused item leaves Today and the care list, and is back on its date with no one touching it", async () => {
    const item = await createCareItem(db, t.clergy, { ...ruth, category: "ongoing" });
    const paused = await pauseCareItem(db, t.clergy, item.id, "2026-12-01", TODAY);
    expect(paused).toMatchObject({ status: "paused", pausedUntil: "2026-12-01" });

    for (const day of [TODAY, "2026-11-30"]) {
      expect((await getTodayCare(db, t.clergy, day)).attention).toEqual([]);
      expect(await listCareBoard(db, t.clergy, BOARD, day)).toEqual([]);
      expect(await listCareItems(db, t.clergy, { status: "active", today: day })).toEqual([]);
      expect((await listCareBoard(db, t.clergy, { ...BOARD, status: "paused" }, day)).map((i) => i.id)).toEqual([item.id]);
    }
    for (const day of ["2026-12-01", "2026-12-15"]) {
      expect((await getTodayCare(db, t.clergy, day)).attention.map((i) => i.id)).toEqual([item.id]);
      expect((await listCareBoard(db, t.clergy, BOARD, day)).map((i) => i.id)).toEqual([item.id]);
      expect(await listCareBoard(db, t.clergy, { ...BOARD, status: "paused" }, day)).toEqual([]);
    }
    // Nothing was written to bring it back: the row is as the pause left it.
    expect(await statusOf(item.id)).toBe("paused");
    // It never drops out of the person's own records.
    expect((await listCareItems(db, t.clergy, { sfContactId: CONTACT })).map((i) => i.id)).toEqual([item.id]);
  });

  it("the read-time rule and its pure twin agree", () => {
    const row = (status: "new" | "open" | "paused" | "closed", pausedUntil: string | null) => ({ status, pausedUntil });
    expect([row("new", null), row("open", null), row("paused", TODAY), row("paused", "2026-11-01")].map((i) => isActiveCareItem(i, TODAY))).toEqual([true, true, true, true]);
    expect([row("paused", "2026-11-24"), row("paused", null), row("closed", null)].map((i) => isActiveCareItem(i, TODAY))).toEqual([false, false, false]);
    expect([row("paused", "2026-11-24"), row("paused", TODAY), row("closed", null)].map((i) => isPausedCareItem(i, TODAY))).toEqual([true, false, false]);
    expect(parseCareBoardFilter({ status: "paused" }).status).toBe("paused");
  });

  it("pause needs a later day; resume, close and reopen move it on", async () => {
    const item = await createCareItem(db, t.clergy, { ...ruth, category: "illness" });
    for (const until of [TODAY, "2026-11-01", "soon", undefined]) await expect(pauseCareItem(db, t.clergy, item.id, until, TODAY)).rejects.toBeInstanceOf(InvalidInput);
    await expect(resumeCareItem(db, t.clergy, item.id)).rejects.toBeInstanceOf(InvalidInput);
    await pauseCareItem(db, t.clergy, item.id, "2026-12-01", TODAY);
    expect(await resumeCareItem(db, t.clergy2, item.id)).toMatchObject({ status: "open", pausedUntil: null });
    await pauseCareItem(db, t.clergy, item.id, "2026-12-01", TODAY);
    expect(await closeCareItem(db, t.clergy, item.id)).toMatchObject({ status: "closed", pausedUntil: null });
    await expect(pauseCareItem(db, t.clergy, item.id, "2026-12-01", TODAY)).rejects.toBeInstanceOf(InvalidInput);
    expect(await reopenCareItem(db, t.clergy, item.id)).toMatchObject({ status: "open", closedAt: null });
  });

  it("a caregiver cannot pause or resume, even their own item", async () => {
    const shared = await createCareItem(db, t.clergy, { ...ruth, category: "illness", ownerUserId: t.carer.id, visibility: "caregivers" });
    await expect(pauseCareItem(db, t.carer, shared.id, "2026-12-01", TODAY)).rejects.toBeInstanceOf(AccessDenied);
    await pauseCareItem(db, t.clergy, shared.id, "2026-12-01", TODAY);
    await expect(resumeCareItem(db, t.carer, shared.id)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("the new fields are validated and can be cleared", async () => {
    const item = await createCareItem(db, t.clergy, { ...ruth, category: "simcha", summary: "A new grandchild" });
    await expect(updateCareItem(db, t.clergy, item.id, { summary: "x".repeat(501) })).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateCareItem(db, t.clergy, item.id, { location: "x".repeat(201) })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createCareItem(db, t.clergy, { ...ruth, category: "illness", source: "rumour" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createCareItem(db, t.clergy, { ...ruth, category: "illness", restricted: "yes" })).rejects.toBeInstanceOf(InvalidInput);
    expect(await updateCareItem(db, t.clergy, item.id, { summary: "", category: "life_change" })).toMatchObject({ summary: null, category: "life_change" });
  });
});

describe("outside people", () => {
  it("a care item for someone not in Salesforce, end to end", async () => {
    const person = await createOutsidePerson(db, t.clergy, { name: "Miriam Levy", phone: "312-555-0100", note: "mother of Dana Levy, lives in Chicago", linkedSfAccountId: ACCOUNT });
    expect(person).toMatchObject({ name: "Miriam Levy", linkedSfAccountId: ACCOUNT, createdBy: t.clergy.id });
    expect((await searchOutsidePeople(db, t.clergy2, "miri")).map((p) => p.id)).toEqual([person.id]);
    expect(await searchOutsidePeople(db, t.clergy2, "100%")).toEqual([]);

    const item = await createCareItem(db, t.clergy, { outsidePersonId: person.id, category: "illness", summary: "Recovering at home" });
    expect(item).toMatchObject({ outsidePersonId: person.id, sfContactId: null, displayName: "Miriam Levy", status: "new" });
    const onItem = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call Miriam", dueDate: "2026-11-23" });
    const bare = await createFollowUp(db, t.clergy2, { outsidePersonId: person.id, title: "Send a card", dueDate: "2026-11-25" });
    expect([onItem, bare].map((f) => [f.outsidePersonId, f.sfContactId, f.displayName])).toEqual([
      [person.id, null, "Miriam Levy"],
      [person.id, null, "Miriam Levy"],
    ]);
    const entry = await createContactEntry(db, t.clergy, { outsidePersonId: person.id, kind: "call", outcome: "spoke", occurredAt: "2026-11-22T16:00:00Z", note: "Doing well" });
    expect(entry).toMatchObject({ outsidePersonId: person.id, sfContactId: null, displayName: "Miriam Levy", outcome: "spoke" });
    // A contact with the person makes their new item open, exactly as for a member.
    expect(await statusOf(item.id)).toBe("open");
    await setFollowUpDone(db, t.clergy, onItem.id, true, { outcome: "visited", now: NOW });

    const page = await getOutsidePersonPage({ db, now: NOW }, t.clergy2, person.id);
    expect(page).toMatchObject({ outsidePersonId: person.id, name: "Miriam Levy", today: TODAY, restrictedCare: [] });
    expect(page.person.note).toBe("mother of Dana Levy, lives in Chicago");
    expect(page.careItems.map((i) => i.id)).toEqual([item.id]);
    expect(new Set(page.followUps.map((f) => f.id))).toEqual(new Set([onItem.id, bare.id]));
    expect(page.contacts.map((c) => [c.kind, c.outcome, c.careItemId])).toEqual([
      ["visit", "visited", item.id],
      ["call", "spoke", null],
    ]);
    // On the boards beside everyone else.
    expect((await listCareBoard(db, t.clergy, BOARD, TODAY)).map((i) => i.displayName)).toEqual(["Miriam Levy"]);
    expect((await listFollowUps(db, t.clergy, { outsidePersonId: person.id, open: true })).map((f) => f.id)).toEqual([bare.id]);
    expect((await listCareItems(db, t.clergy, { outsidePersonId: person.id })).map((i) => i.id)).toEqual([item.id]);
  });

  it("an outside person whose only care items are restricted away from someone is not theirs to find, open or use, unless they added the row", async () => {
    const other = await addActor(db, "clergy3@example.test", "clergy");
    const person = await createOutsidePerson(db, t.clergy, { name: "Miriam Levy", note: "mother of Dana Levy" });
    const findable = async (a: typeof other) => (await searchOutsidePeople(db, a, "Miriam")).map((p) => p.id);
    // Before any care item, and with an unrestricted one, all clergy find them.
    expect(await findable(other)).toEqual([person.id]);
    const item = await createCareItem(db, t.clergy, { outsidePersonId: person.id, category: "mental_health", restricted: true, restrictedShowsCarer: false, accessUserIds: [t.clergy2.id] });

    for (const a of [other, t.owner]) {
      expect(await findable(a)).toEqual([]);
      await expect(getOutsidePerson(db, a, person.id)).rejects.toBeInstanceOf(NotFound);
      await expect(getOutsidePersonPage({ db, now: NOW }, a, person.id)).rejects.toBeInstanceOf(NotFound);
      // Nor can the id be used to find out that they exist.
      await expect(createCareItem(db, a, { outsidePersonId: person.id, category: "illness" })).rejects.toBeInstanceOf(InvalidInput);
      await expect(createContactEntry(db, a, { outsidePersonId: person.id, kind: "call", occurredAt: NOW })).rejects.toBeInstanceOf(InvalidInput);
      await expect(createFollowUp(db, a, { outsidePersonId: person.id, title: "x", dueDate: TODAY })).rejects.toBeInstanceOf(InvalidInput);
      const proposal = await createProposal(db, a, { rawText: "About Miriam", channel: "capture" });
      await expect(acceptProposal({ db, sf: () => ({ query: async () => [] }), now: NOW }, a, proposal.id, { target: { kind: "new" }, person: { outsidePersonId: person.id }, category: "illness" })).rejects.toBeInstanceOf(InvalidInput);
    }
    // Those with full access, and whoever added the row, still have them.
    for (const a of [t.clergy, t.clergy2]) {
      expect(await findable(a)).toEqual([person.id]);
      expect((await getOutsidePersonPage({ db, now: NOW }, a, person.id)).careItems.map((i) => i.id)).toEqual([item.id]);
    }
    const added = await createOutsidePerson(db, other, { name: "Miriam Stein" });
    await createCareItem(db, t.clergy, { outsidePersonId: added.id, category: "illness", restricted: true, restrictedShowsCarer: false });
    expect(await findable(other)).toEqual([added.id]);
    expect((await getOutsidePersonPage({ db, now: NOW }, other, added.id)).careItems).toEqual([]);
    // An unrestricted item beside the restricted one makes the person ordinary again.
    await createCareItem(db, t.clergy, { outsidePersonId: person.id, category: "illness" });
    expect(new Set(await findable(other))).toEqual(new Set([added.id, person.id]));
  });

  it("a record is about exactly one person, in the functions and in the database", async () => {
    const person = await createOutsidePerson(db, t.clergy, { name: "Miriam Levy" });
    await expect(createCareItem(db, t.clergy, { ...ruth, outsidePersonId: person.id, category: "illness" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createCareItem(db, t.clergy, { outsidePersonId: "00000000-0000-4000-8000-000000000000", category: "illness" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createCareItem(db, t.clergy, { category: "illness" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createContactEntry(db, t.clergy, { kind: "call", occurredAt: NOW })).rejects.toBeInstanceOf(InvalidInput);
    const base = { displayName: "X", category: "illness" as const, ownerUserId: t.clergy.id, createdBy: t.clergy.id };
    await expect(db.insert(careItems).values(base)).rejects.toThrow();
    await expect(db.insert(careItems).values({ ...base, sfContactId: CONTACT, outsidePersonId: person.id })).rejects.toThrow();
    await expect(db.insert(contactLog).values({ displayName: "X", kind: "call", occurredAt: NOW, authorUserId: t.clergy.id })).rejects.toThrow();
    await expect(db.insert(followUps).values({ title: "x", dueDate: TODAY, createdBy: t.clergy.id })).rejects.toThrow();
    await expect(db.insert(followUps).values({ title: "x", dueDate: TODAY, createdBy: t.clergy.id, sfContactId: CONTACT, outsidePersonId: person.id })).rejects.toThrow();
    // A restricted item can never be visible to caregivers, whatever the code above it does.
    await expect(db.insert(careItems).values({ ...base, sfContactId: CONTACT, restricted: true, visibility: "caregivers" })).rejects.toThrow();
  });

  it("only clergy level create, search or open them; a caregiver meets one only through an item shared with them", async () => {
    const r = await reporters(db);
    const person = await createOutsidePerson(db, t.owner, { name: "Miriam Levy", note: "a neighbour" });
    for (const a of [t.carer, r.staff, r.lead, r.senior]) {
      await expect(createOutsidePerson(db, a, { name: "X" })).rejects.toBeInstanceOf(AccessDenied);
      await expect(searchOutsidePeople(db, a, "Miriam")).rejects.toBeInstanceOf(AccessDenied);
      await expect(getOutsidePerson(db, a, person.id)).rejects.toBeInstanceOf(AccessDenied);
      await expect(getOutsidePersonPage({ db, now: NOW }, a, person.id)).rejects.toBeInstanceOf(AccessDenied);
      await expect(createContactEntry(db, a, { outsidePersonId: person.id, kind: "call", occurredAt: NOW })).rejects.toBeInstanceOf(AccessDenied);
    }
    const shared = await createCareItem(db, t.clergy, { outsidePersonId: person.id, category: "illness", ownerUserId: t.carer.id, visibility: "caregivers" });
    const entry = await createContactEntry(db, t.carer, { careItemId: shared.id, kind: "visit", occurredAt: NOW });
    expect(entry).toMatchObject({ outsidePersonId: person.id, displayName: "Miriam Levy" });
    expect((await getCareItem(db, t.carer, shared.id)).displayName).toBe("Miriam Levy");
    await expect(getOutsidePersonPage({ db, now: NOW }, t.clergy, "not-a-uuid")).rejects.toBeInstanceOf(NotFound);
    await expect(searchOutsidePeople(db, t.clergy, "M")).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe("contact log: outcome and delete", () => {
  it("an outcome is optional, validated, and can be changed by the author", async () => {
    const plain = await createContactEntry(db, t.clergy, { ...ruth, kind: "call", occurredAt: NOW });
    expect(plain.outcome).toBeNull();
    await expect(createContactEntry(db, t.clergy, { ...ruth, kind: "call", outcome: "hung_up", occurredAt: NOW })).rejects.toBeInstanceOf(InvalidInput);
    expect((await updateContactEntry(db, t.clergy, plain.id, { outcome: "no_answer" })).outcome).toBe("no_answer");
    expect((await updateContactEntry(db, t.clergy, plain.id, { outcome: "" })).outcome).toBeNull();
  });

  it("only the author deletes an entry, and the deletion is audited without its text", async () => {
    const entry = await createContactEntry(db, t.clergy, { ...ruth, kind: "visit", occurredAt: NOW, note: "Spoke about her diagnosis" });
    await expect(deleteContactEntry(db, t.owner, entry.id)).rejects.toBeInstanceOf(AccessDenied);
    await expect(deleteContactEntry(db, t.clergy2, entry.id)).rejects.toBeInstanceOf(AccessDenied);
    await expect(deleteContactEntry(db, t.carer, entry.id)).rejects.toBeInstanceOf(NotFound);
    expect(await listContactEntries(db, t.clergy)).toHaveLength(1);
    await deleteContactEntry(db, t.clergy, entry.id);
    expect(await db.select().from(contactLog)).toEqual([]);
    await expect(deleteContactEntry(db, t.clergy, entry.id)).rejects.toBeInstanceOf(NotFound);
    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: t.clergy.id, action: "contact.delete", subjectType: "contact_log", subjectId: entry.id, detail: { careItemId: null } });
    expect(words(audit)).not.toMatch(/diagnosis|Ruth/);
  });
});

describe("follow-ups: outcome and delete", () => {
  it("marking done with an outcome writes the contact entry with it; without one, or on reopening, it writes none", async () => {
    const item = await createCareItem(db, t.clergy, { ...ruth, category: "illness" });
    const first = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call", dueDate: TODAY });
    const second = await createFollowUp(db, t.clergy, { ...ruth, title: "Text", dueDate: TODAY });
    await setFollowUpDone(db, t.clergy, first.id, true);
    await setFollowUpDone(db, t.clergy, first.id, false, { outcome: "spoke" });
    expect(await db.select().from(contactLog)).toEqual([]);

    expect((await setFollowUpDone(db, t.clergy, first.id, true, { outcome: "no_answer", now: NOW })).doneAt).toEqual(NOW);
    await setFollowUpDone(db, t.clergy2, second.id, true, { outcome: "texted", now: NOW });
    const entries = await db.select().from(contactLog);
    expect(entries.map((e) => [e.kind, e.outcome, e.careItemId, e.sfContactId, e.displayName, e.authorUserId, e.note]).sort()).toEqual(
      [
        ["call", "no_answer", item.id, CONTACT, "Ruth Cohen", t.clergy.id, null],
        ["text", "texted", null, CONTACT, "Ruth Cohen", t.clergy2.id, null],
      ].sort(),
    );
    expect(entries.every((e) => e.occurredAt.getTime() === NOW.getTime())).toBe(true);
  });

  it("a bad outcome changes nothing: the follow-up stays open and no entry is written", async () => {
    const followUp = await createFollowUp(db, t.clergy, { ...ruth, title: "Call", dueDate: TODAY });
    await expect(setFollowUpDone(db, t.clergy, followUp.id, true, { outcome: "maybe" })).rejects.toBeInstanceOf(InvalidInput);
    expect((await listFollowUps(db, t.clergy, { open: true })).map((f) => f.id)).toEqual([followUp.id]);
    expect(await db.select().from(contactLog)).toEqual([]);
  });

  it("a caregiver records an outcome on their own follow-up, on an item shared with them", async () => {
    const shared = await createCareItem(db, t.clergy, { ...ruth, category: "illness", ownerUserId: t.carer.id, visibility: "caregivers" });
    const followUp = await createFollowUp(db, t.carer, { careItemId: shared.id, title: "Bring soup", dueDate: TODAY });
    await setFollowUpDone(db, t.carer, followUp.id, true, { outcome: "visited", now: NOW });
    expect((await listContactEntries(db, t.carer)).map((e) => [e.kind, e.outcome, e.careItemId])).toEqual([["visit", "visited", shared.id]]);
  });

  it("its creator, its owner or clergy delete it; no one else does; the deletion is audited without its title", async () => {
    const shared = await createCareItem(db, t.clergy, { ...ruth, category: "illness", ownerUserId: t.carer.id, visibility: "caregivers" });
    const own = await createFollowUp(db, t.carer, { careItemId: shared.id, title: "Bring soup after chemo", dueDate: TODAY });
    const given = await createFollowUp(db, t.clergy, { careItemId: shared.id, title: "Drive to the clinic", dueDate: TODAY, ownerUserId: t.carer.id });
    const clergyOnly = await createFollowUp(db, t.clergy, { ...ruth, title: "Call", dueDate: TODAY });
    // Another caregiver sees none of them; the caregiver does not see clergy work.
    for (const id of [own.id, given.id, clergyOnly.id]) await expect(deleteFollowUp(db, t.carer2, id)).rejects.toBeInstanceOf(NotFound);
    await expect(deleteFollowUp(db, t.carer, clergyOnly.id)).rejects.toBeInstanceOf(NotFound);
    await deleteFollowUp(db, t.carer, own.id);
    await deleteFollowUp(db, t.carer, given.id);
    await deleteFollowUp(db, t.clergy2, clergyOnly.id);
    expect(await db.select().from(followUps)).toEqual([]);
    const audit = await db.select().from(auditLog);
    expect(audit.map((a) => [a.action, a.subjectType, a.actorUserId, a.subjectId]).sort()).toEqual(
      [
        ["follow_up.delete", "follow_up", t.carer.id, own.id],
        ["follow_up.delete", "follow_up", t.carer.id, given.id],
        ["follow_up.delete", "follow_up", t.clergy2.id, clergyOnly.id],
      ].sort(),
    );
    expect(words(audit)).not.toMatch(/soup|chemo|clinic|Ruth/);
  });
});
