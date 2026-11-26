import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCareItem, getCareItem, listCareItems } from "@/server/care/care-items";
import { listContactEntries } from "@/server/care/contact-log";
import { listFollowUps } from "@/server/care/follow-ups";
import { getOutsidePerson } from "@/server/care/outside-people";
import { acceptProposal, createProposal, dismissProposal, listInbox, listMyReports, releaseToInbox } from "@/server/care/proposals";
import { readProposal } from "@/server/care/reading";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { auditLog, careItemAccess, careItems, contactLog, followUps, outsidePeople, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { fakeSf } from "./support/sf";
import { words } from "./support/words";

const NOW = new Date("2026-11-23T16:00:00Z");
const RAW = "Ruth Cohen's daughter rang: Ruth fell and is in Barnes, quite shaken";
const SUMMARY = "Fell at home; in hospital and shaken";
const reading = { person: { name: "Ruth Cohen", candidates: [{ contactId: CONTACT, name: "Ruth Cohen", household: "Ruth and Sam Cohen" }] }, category: "illness", urgency: "today", summary: SUMMARY, location: "Barnes", restrictedSuggested: false, followUp: { title: "Visit Ruth", dueDate: "2026-11-24" } };

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
let deps: { db: Db; sf: ReturnType<typeof fakeSf>["sf"]; now: Date };

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
  deps = { db, sf: fakeSf().sf, now: NOW };
});

const row = async (id: string) => (await db.select().from(proposals).where(eq(proposals.id, id)))[0];
const inbox = async (a: Actor) => (await listInbox(db, a)).map((p) => p.id);
const fromStaff = () => createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
const newItem = { target: { kind: "new" }, person: { contactId: CONTACT }, category: "illness", summary: SUMMARY };

describe("creating a proposal", () => {
  it("any role may report a need, and it goes to clergy whatever scope they ask for", async () => {
    for (const a of [r.staff, r.lead, r.senior, t.carer]) {
      const p = await createProposal(db, a, { rawText: RAW, channel: "staff", reviewScope: "submitter" });
      expect(p).toMatchObject({ status: "pending", reviewScope: "clergy", channel: "staff", submittedBy: a.id, rawText: RAW, reading: null });
    }
    expect(await inbox(t.clergy)).toHaveLength(4);
    expect(await db.select().from(careItems)).toEqual([]);
  });

  it("a clergy capture is theirs to confirm and stays out of the shared Inbox unless they choose it", async () => {
    const own = await createProposal(db, t.clergy, { rawText: RAW, channel: "capture" });
    const ownerOwn = await createProposal(db, t.owner, { rawText: RAW, channel: "voice" });
    const shared = await createProposal(db, t.clergy, { rawText: RAW, channel: "capture", reviewScope: "clergy" });
    expect([own.reviewScope, ownerOwn.reviewScope, shared.reviewScope]).toEqual(["submitter", "submitter", "clergy"]);
    expect(new Set(await inbox(t.clergy))).toEqual(new Set([own.id, shared.id]));
    expect(await inbox(t.clergy2)).toEqual([shared.id]);
    expect(new Set(await inbox(t.owner))).toEqual(new Set([ownerOwn.id, shared.id]));
  });

  it("stores a connector reading as given and reads nothing by itself: the server-side seam returns null", async () => {
    const p = await createProposal(db, t.clergy, { rawText: RAW, channel: "connector", reading });
    expect(p.reading).toEqual(reading);
    expect((await listInbox(db, t.clergy))[0].reading).toEqual(reading);
    expect(await readProposal(RAW)).toBeNull();
    expect((await createProposal(db, t.clergy, { rawText: RAW, channel: "capture" })).reading).toBeNull();
    // A reading alone is enough; nothing at all is not.
    expect((await createProposal(db, t.clergy, { channel: "connector", reading: { summary: SUMMARY } })).rawText).toBeNull();
    await expect(createProposal(db, t.clergy, { channel: "capture" })).rejects.toBeInstanceOf(InvalidInput);
  });

  it("refuses a malformed reading, an unknown channel or text that is too long, without echoing the text", async () => {
    const bad = [{ urgency: "whenever" }, { person: { contactId: "001000000000001AAA" } }, { summary: "x".repeat(501) }, { surprise: true }, { dates: [{ label: "Surgery", date: "next week" }] }, "a string"];
    for (const b of bad) await expect(createProposal(db, t.clergy, { rawText: RAW, channel: "connector", reading: b })).rejects.toBeInstanceOf(InvalidInput);
    await expect(createProposal(db, t.clergy, { rawText: RAW, channel: "fax" })).rejects.toBeInstanceOf(InvalidInput);
    const tooLong = await createProposal(db, t.clergy, { rawText: RAW + "x".repeat(5000), channel: "capture" }).catch((e: Error) => e);
    expect(tooLong).toBeInstanceOf(InvalidInput);
    expect((tooLong as Error).message).not.toContain("Ruth");
    expect(await db.select().from(proposals)).toEqual([]);
  });
});

describe("the Inbox", () => {
  it("is for clergy level; other roles see nothing in it, their own reports included", async () => {
    const p = await fromStaff();
    await createProposal(db, t.carer, { rawText: RAW, channel: "staff" });
    for (const a of [r.staff, r.lead, r.senior, t.carer, t.carer2]) {
      expect(await listInbox(db, a)).toEqual([]);
      await expect(acceptProposal(deps, a, p.id, newItem)).rejects.toBeInstanceOf(NotFound);
      await expect(dismissProposal(db, a, p.id)).rejects.toBeInstanceOf(NotFound);
      await expect(releaseToInbox(db, a, p.id)).rejects.toBeInstanceOf(NotFound);
    }
    expect((await listInbox(db, t.clergy)).find((x) => x.id === p.id)).toMatchObject({ submitterName: "staff", rawText: RAW, channel: "staff" });
    expect((await row(p.id)).status).toBe("pending");
  });

  it("a submitter-scope proposal is decided only by its submitter, until they release it", async () => {
    const own = await createProposal(db, t.clergy, { rawText: RAW, channel: "capture" });
    for (const a of [t.clergy2, t.owner]) {
      await expect(acceptProposal(deps, a, own.id, newItem)).rejects.toBeInstanceOf(NotFound);
      await expect(dismissProposal(db, a, own.id)).rejects.toBeInstanceOf(NotFound);
      await expect(releaseToInbox(db, a, own.id)).rejects.toBeInstanceOf(NotFound);
    }
    expect(await releaseToInbox(db, t.clergy, own.id)).toMatchObject({ reviewScope: "clergy", status: "pending", rawText: RAW });
    await expect(releaseToInbox(db, t.clergy, own.id)).rejects.toBeInstanceOf(InvalidInput);
    expect(await inbox(t.clergy2)).toEqual([own.id]);
    expect((await acceptProposal(deps, t.clergy2, own.id, newItem)).proposal.status).toBe("accepted");
    // A proposal already in the shared Inbox is not anyone's to release.
    const shared = await fromStaff();
    await expect(releaseToInbox(db, t.clergy, shared.id)).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe("accepting", () => {
  it("opens a new care item with the final values and a first follow-up, in the name Salesforce gives, and clears the raw text", async () => {
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff", reading });
    const accepted = await acceptProposal(deps, t.clergy, p.id, { ...newItem, location: "Barnes, room 4", learnedFrom: "Her daughter rang the office", ownerUserId: t.clergy2.id, followUp: { title: "Visit Ruth", dueDate: "2026-11-24" } });
    const item = await getCareItem(db, t.owner, accepted.careItemId);
    expect(item).toMatchObject({ sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", status: "new", summary: SUMMARY, location: "Barnes, room 4", learnedFrom: "Her daughter rang the office", source: "staff", restricted: false, ownerUserId: t.clergy2.id, createdBy: t.clergy.id });
    expect(await listFollowUps(db, t.clergy, { careItemId: item.id })).toMatchObject([{ id: accepted.followUpId, title: "Visit Ruth", dueDate: "2026-11-24", ownerUserId: t.clergy2.id, sfContactId: CONTACT, displayName: "Ruth Cohen", createdBy: t.clergy.id }]);
    expect(await row(p.id)).toMatchObject({ status: "accepted", decidedBy: t.clergy.id, decidedAt: NOW, resultCareItemId: item.id, rawText: null, reading: null });
    expect(accepted.proposal).toMatchObject({ status: "accepted", rawText: null, reading: null, resultCareItemId: item.id });
    expect(await inbox(t.clergy)).toEqual([]);
    // Decided once: neither a second accept nor a dismissal reaches it.
    await expect(acceptProposal(deps, t.clergy2, p.id, newItem)).rejects.toBeInstanceOf(InvalidInput);
    await expect(dismissProposal(db, t.clergy2, p.id)).rejects.toBeInstanceOf(InvalidInput);
    expect(await db.select().from(careItems)).toHaveLength(1);
  });

  it("carries the proposal's channel as the item's source", async () => {
    for (const channel of ["connector", "capture", "voice"] as const) {
      const p = await createProposal(db, t.clergy, { rawText: RAW, channel });
      const { careItemId } = await acceptProposal(deps, t.clergy, p.id, newItem);
      expect((await getCareItem(db, t.clergy, careItemId)).source).toBe(channel);
    }
  });

  it("adds to an existing care item as a note of kind other by the acceptor, rather than opening a second item", async () => {
    const existing = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness" });
    const p = await fromStaff();
    const accepted = await acceptProposal(deps, t.clergy, p.id, { target: { kind: "existing", careItemId: existing.id }, summary: SUMMARY, followUp: { title: "Ring her daughter", dueDate: "2026-11-25" } });
    expect(accepted.careItemId).toBe(existing.id);
    expect(await db.select().from(careItems)).toHaveLength(1);
    expect(await listContactEntries(db, t.owner, { careItemId: existing.id })).toMatchObject([{ kind: "other", note: SUMMARY, private: false, authorUserId: t.clergy.id, sfContactId: CONTACT, displayName: "Ruth Cohen", outcome: null }]);
    // A report is not contact with the person: the item is still new, and still what it was.
    expect(await getCareItem(db, t.clergy, existing.id)).toMatchObject({ status: "new", source: "clergy", summary: null, ownerUserId: t.clergy2.id });
    expect(await listFollowUps(db, t.clergy, { careItemId: existing.id })).toMatchObject([{ title: "Ring her daughter", ownerUserId: t.clergy2.id }]);
    expect(await row(p.id)).toMatchObject({ status: "accepted", resultCareItemId: existing.id, rawText: null, reading: null });
  });

  it("creates an outside person, or uses one, when the person is not in Salesforce", async () => {
    const p = await fromStaff();
    const first = await acceptProposal(deps, t.clergy, p.id, { target: { kind: "new" }, person: { newOutsidePerson: { name: "Miriam Levy", phone: "312-555-0100", note: "mother of Dana Levy" } }, category: "caregiver" });
    const item = await getCareItem(db, t.clergy, first.careItemId);
    expect(item).toMatchObject({ sfContactId: null, displayName: "Miriam Levy", category: "caregiver" });
    expect(await getOutsidePerson(db, t.clergy, item.outsidePersonId)).toMatchObject({ name: "Miriam Levy", note: "mother of Dana Levy", createdBy: t.clergy.id });
    const again = await acceptProposal(deps, t.clergy, (await fromStaff()).id, { target: { kind: "new" }, person: { outsidePersonId: item.outsidePersonId }, category: "ongoing" });
    expect((await getCareItem(db, t.clergy, again.careItemId)).outsidePersonId).toBe(item.outsidePersonId);
    expect(await db.select().from(outsidePeople)).toHaveLength(1);
  });

  it("opens a restricted item for a colleague: the acceptor does not see it afterwards, and the follow-up goes to someone who can", async () => {
    const p = await fromStaff();
    const accepted = await acceptProposal(deps, t.owner, p.id, { ...newItem, category: "mental_health", restricted: true, restrictedShowsCarer: false, accessUserIds: [t.clergy2.id], ownerUserId: t.clergy.id, followUp: { title: "Call tonight", dueDate: "2026-11-23" } });
    await expect(getCareItem(db, t.owner, accepted.careItemId)).rejects.toBeInstanceOf(NotFound);
    expect(await listCareItems(db, t.owner)).toEqual([]);
    expect(await listFollowUps(db, t.owner)).toEqual([]);
    expect(await getCareItem(db, t.clergy2, accepted.careItemId)).toMatchObject({ restricted: true, restrictedShowsCarer: false, ownerUserId: t.clergy.id, source: "staff" });
    expect(await db.select().from(careItemAccess)).toEqual([{ careItemId: accepted.careItemId, userId: t.clergy2.id }]);
    expect(await listFollowUps(db, t.clergy, { careItemId: accepted.careItemId })).toMatchObject([{ ownerUserId: t.clergy.id }]);
  });

  it("is all or nothing: a decision that fails part-way leaves the proposal pending with its text, and no records", async () => {
    const p = await fromStaff();
    const hidden = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness", restricted: true, restrictedShowsCarer: false });
    const closed = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    await db.update(careItems).set({ status: "closed" }).where(eq(careItems.id, closed.id));
    const open = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "other" });
    const baseline = JSON.stringify([await db.select().from(careItems), await db.select().from(outsidePeople)]);
    const failing: [unknown, unknown][] = [
      [{ ...newItem, followUp: { title: "Visit", dueDate: "2026-02-30" } }, InvalidInput],
      [{ ...newItem, followUp: { title: "Visit", dueDate: "2026-11-24", ownerUserId: r.staff.id } }, InvalidInput],
      [{ ...newItem, ownerUserId: t.carer.id }, InvalidInput],
      [{ ...newItem, restricted: true, accessUserIds: [t.carer.id] }, InvalidInput],
      [{ ...newItem, person: { contactId: "003000000000099AAA" } }, NotFound],
      [{ target: { kind: "new" }, person: { newOutsidePerson: { name: "Miriam Levy" } }, category: "illness", followUp: { title: "Visit", dueDate: "nope" } }, InvalidInput],
      [{ target: { kind: "new" }, person: { contactId: CONTACT } }, InvalidInput],
      [{ target: { kind: "new" }, category: "illness" }, InvalidInput],
      [{ target: { kind: "existing", careItemId: hidden.id }, summary: SUMMARY }, NotFound],
      [{ target: { kind: "existing", careItemId: closed.id }, summary: SUMMARY }, InvalidInput],
      [{ target: { kind: "existing", careItemId: closed.id } }, InvalidInput],
      // Asking for a restricted record must not put the words on an unrestricted one.
      [{ target: { kind: "existing", careItemId: open.id }, summary: SUMMARY, restricted: true }, InvalidInput],
      [{ ...newItem, surprise: true }, InvalidInput],
      [null, InvalidInput],
    ];
    for (const [decision, error] of failing) await expect(acceptProposal(deps, t.clergy, p.id, decision)).rejects.toBeInstanceOf(error as typeof Error);
    expect(JSON.stringify([await db.select().from(careItems), await db.select().from(outsidePeople)])).toBe(baseline);
    expect([await db.select().from(followUps), await db.select().from(contactLog), await db.select().from(auditLog).where(eq(auditLog.action, "proposal.accept"))]).toEqual([[], [], []]);
    expect(await row(p.id)).toMatchObject({ status: "pending", rawText: RAW, decidedBy: null, resultCareItemId: null });
    // The words of every decided proposal are gone, both ways of holding them.
    const kept = await createProposal(db, t.clergy, { rawText: RAW, channel: "connector", reading, reviewScope: "clergy" });
    await acceptProposal(deps, t.clergy2, kept.id, { target: { kind: "existing", careItemId: open.id }, summary: SUMMARY });
    expect(words((await db.select().from(proposals)).filter((x) => x.status !== "pending"))).not.toMatch(/Barnes|shaken|Fell/);
  });
});

describe("dismissing", () => {
  it("clears the raw text and takes it out of the Inbox, with no care record", async () => {
    const p = await createProposal(db, r.staff, { rawText: RAW, channel: "staff", reading });
    expect((await row(p.id)).reading).toEqual(reading);
    expect(await dismissProposal(db, t.clergy2, p.id, NOW)).toMatchObject({ status: "dismissed", rawText: null, reading: null });
    expect(await row(p.id)).toMatchObject({ status: "dismissed", decidedBy: t.clergy2.id, decidedAt: NOW, rawText: null, reading: null, resultCareItemId: null });
    expect(await inbox(t.clergy)).toEqual([]);
    expect(await db.select().from(careItems)).toEqual([]);
    await expect(acceptProposal(deps, t.clergy, p.id, newItem)).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe("my reports", () => {
  it("shows a reporter only the date, the state, and who picked it up, never the reading, the text or the care item", async () => {
    const pending = await createProposal(db, r.staff, { rawText: RAW, channel: "staff" });
    const dismissed = await fromStaff();
    const picked = await fromStaff();
    const pickedRestricted = await fromStaff();
    const added = await fromStaff();
    await createProposal(db, r.lead, { rawText: RAW, channel: "staff" });
    await dismissProposal(db, t.clergy, dismissed.id);
    const item = await acceptProposal(deps, t.clergy, picked.id, { ...newItem, ownerUserId: t.clergy2.id, location: "Barnes" });
    await acceptProposal(deps, t.clergy, pickedRestricted.id, { ...newItem, category: "mental_health", restricted: true });
    await acceptProposal(deps, t.owner, added.id, { target: { kind: "existing", careItemId: item.careItemId }, summary: "More from the family" });

    const mine = await listMyReports(db, r.staff);
    const byId = new Map(mine.map((m) => [m.id, m]));
    expect(mine).toHaveLength(5);
    expect(byId.get(pending.id)).toEqual({ id: pending.id, createdOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), status: "pending", pickedUpBy: null });
    expect(byId.get(dismissed.id)).toMatchObject({ status: "dismissed", pickedUpBy: null });
    expect(byId.get(picked.id)).toMatchObject({ status: "accepted", pickedUpBy: "clergy2" });
    expect(byId.get(pickedRestricted.id)).toMatchObject({ status: "accepted", pickedUpBy: null });
    expect(byId.get(added.id)).toMatchObject({ status: "accepted", pickedUpBy: "clergy2" });
    for (const m of mine) {
      expect(Object.keys(m).sort()).toEqual(["createdOn", "id", "pickedUpBy", "status"]);
      expect(m.createdOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const text = JSON.stringify(mine);
    for (const leak of ["Ruth", "Barnes", SUMMARY, "illness", "mental_health", CONTACT, item.careItemId, "More from the family"]) expect(text).not.toContain(leak);
    // Each reporter has their own list; a caregiver's works the same way.
    expect(await listMyReports(db, r.lead)).toHaveLength(1);
    expect(await listMyReports(db, r.senior)).toEqual([]);
    await createProposal(db, t.carer, { rawText: RAW, channel: "staff" });
    expect(await listMyReports(db, t.carer)).toMatchObject([{ status: "pending", pickedUpBy: null }]);
  });
});

describe("the audit trail", () => {
  it("records every accept, dismiss and release, with ids and flags and none of the words", async () => {
    const own = await createProposal(db, t.clergy, { rawText: RAW, channel: "capture", reading });
    await releaseToInbox(db, t.clergy, own.id);
    const accepted = await acceptProposal(deps, t.clergy2, own.id, { ...newItem, restricted: true, followUp: { title: "Visit Ruth", dueDate: "2026-11-24" } });
    const dismissed = await fromStaff();
    await dismissProposal(db, t.owner, dismissed.id);
    const rows = (await db.select().from(auditLog)).filter((a) => a.subjectType === "proposal").sort((a, b) => a.at.getTime() - b.at.getTime());
    expect(rows.map((a) => [a.action, a.actorUserId, a.subjectId, a.detail])).toEqual([
      ["proposal.release", t.clergy.id, own.id, { channel: "capture" }],
      ["proposal.accept", t.clergy2.id, own.id, { careItemId: accepted.careItemId, channel: "capture", target: "new", restricted: true }],
      ["proposal.dismiss", t.owner.id, dismissed.id, { channel: "staff" }],
    ]);
    const all = JSON.stringify(await db.select().from(auditLog));
    for (const word of ["Ruth", "Barnes", "shaken", "Fell", "Visit"]) expect(all).not.toContain(word);
  });

  it("a refused attempt is not a decision: nothing is recorded", async () => {
    const p = await fromStaff();
    await expect(dismissProposal(db, r.staff, p.id)).rejects.toBeInstanceOf(NotFound);
    await expect(acceptProposal(deps, t.carer, p.id, newItem)).rejects.toBeInstanceOf(NotFound);
    expect(await db.select().from(auditLog)).toEqual([]);
  });
});
