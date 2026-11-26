import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied, canAddDirectly } from "@/server/access/policy";
import { createCareItem, listCareItems, listCareItemStubs, writeCareItem } from "@/server/care/care-items";
import { listInbox, listMyReports } from "@/server/care/proposals";
import { listClergyChoices, STAFF_ADD_LIMITS, staffAddCareItem, staffAddMiSheberach } from "@/server/care/staff-add";
import { InvalidInput, NotFound, TooMany } from "@/server/care/validate";
import { auditLog, careItems, miSheberachEntries, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addEntry, listEntries, updateEntry } from "@/server/misheberach/list";
import { addActor, ACCOUNT, CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";
import { fakeSf } from "./support/sf";

const NOW = new Date("2026-11-25T18:00:00Z");

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const deps = () => ({ db, sf: fakeSf().sf });
const ask = (over: Record<string, unknown> = {}) => ({ contactId: CONTACT, ownerUserId: t.clergy.id, category: "illness", words: "In hospital since Monday; the family called the office.", ...over });

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
});

describe("who may add directly", () => {
  it("staff and leads; not senior staff, caregivers or clergy (who have their own ways)", () => {
    expect([r.staff, r.lead].every(canAddDirectly)).toBe(true);
    expect([r.senior, t.carer, t.clergy, t.owner].some(canAddDirectly)).toBe(false);
  });

  it("everyone else is refused by every function", async () => {
    for (const a of [r.senior, t.carer, t.clergy, t.owner]) {
      await expect(listClergyChoices(db, a)).rejects.toBeInstanceOf(AccessDenied);
      await expect(staffAddCareItem(deps(), a, ask())).rejects.toBeInstanceOf(AccessDenied);
      await expect(staffAddMiSheberach(db, a, { name: "Ruth Cohen" }, NOW)).rejects.toBeInstanceOf(AccessDenied);
    }
    expect(await db.select().from(careItems)).toEqual([]);
    expect(await db.select().from(miSheberachEntries)).toEqual([]);
  });

  it("the rabbis to choose from are active clergy, by name and id only", async () => {
    await addActor(db, "gone@example.test", "clergy", false);
    const choices = await listClergyChoices(db, r.staff);
    expect(choices.map((c) => c.id).sort()).toEqual([t.clergy.id, t.clergy2.id, t.owner.id].sort());
    expect(Object.keys(choices[0]).sort()).toEqual(["away", "id", "name"]);
  });
});

describe("staff add a member to a rabbi's care list", () => {
  it("makes a new care item for that rabbi at once, with the name from Salesforce and the words as its summary; nothing waits in the Inbox", async () => {
    for (const a of [r.staff, r.lead]) {
      const made = await staffAddCareItem(deps(), a, ask({ displayName: "Someone Else" }));
      expect(made.ownerUserId).toBe(t.clergy.id);
      const [item] = await db.select().from(careItems).where(eq(careItems.id, made.careItemId));
      expect(item).toMatchObject({ sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", status: "new", source: "staff", ownerUserId: t.clergy.id, visibility: "clergy", restricted: false, createdBy: a.id });
      expect(item.summary).toContain("In hospital");
    }
    expect((await listCareItems(db, t.clergy)).length).toBe(2);
    expect(await listInbox(db, t.clergy)).toEqual([]);
    expect(await listMyReports(db, r.staff)).toEqual([]);
  });

  it("is audited with ids only", async () => {
    const made = await staffAddCareItem(deps(), r.staff, ask());
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, "care_item.staff_add"));
    expect(rows).toMatchObject([{ actorUserId: r.staff.id, subjectId: made.careItemId, detail: { restricted: false } }]);
    expect(JSON.stringify(rows)).not.toMatch(/Ruth|hospital/);
  });

  it("'sensitive' restricts the item to the chosen rabbi: other clergy, the owner role included, see only that it is in that rabbi's care", async () => {
    const made = await staffAddCareItem(deps(), r.staff, ask({ sensitive: true, category: "mental_health" }));
    expect((await listCareItems(db, t.clergy)).map((i) => i.id)).toEqual([made.careItemId]);
    expect(await listCareItems(db, t.owner)).toEqual([]);
    expect((await listCareItemStubs(db, t.owner)).map((s) => s.id)).toEqual([made.careItemId]);
  });

  it("the answer is the same whatever the person already has, so it says nothing about who is in care, restricted or not", async () => {
    const fresh = await staffAddCareItem(deps(), r.staff, ask());
    await createCareItem(db, t.owner, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "mental_health", restricted: true, restrictedShowsCarer: false });
    const again = await staffAddCareItem(deps(), r.staff, ask());
    expect(Object.keys(again).sort()).toEqual(Object.keys(fresh).sort());
    expect(again.ownerName).toBe(fresh.ownerName);
    expect(await db.select().from(careItems)).toHaveLength(3);
  });

  it("staff still see no care item afterwards", async () => {
    await staffAddCareItem(deps(), r.staff, ask());
    expect(await listCareItems(db, r.staff)).toEqual([]);
    expect(await listCareItemStubs(db, r.staff)).toEqual([]);
  });

  it("refuses a rabbi who is not active clergy, an unknown member, an unknown kind and empty or over-long words", async () => {
    const inactive = await addActor(db, "gone@example.test", "clergy", false);
    for (const owner of [r.staff.id, r.lead.id, t.carer.id, inactive.id]) await expect(staffAddCareItem(deps(), r.staff, ask({ ownerUserId: owner }))).rejects.toBeInstanceOf(InvalidInput);
    await expect(staffAddCareItem(deps(), r.staff, ask({ contactId: CONTACT2 }))).rejects.toBeInstanceOf(NotFound);
    await expect(staffAddCareItem(deps(), r.staff, ask({ category: "gossip" }))).rejects.toBeInstanceOf(InvalidInput);
    await expect(staffAddCareItem(deps(), r.staff, ask({ words: "  " }))).rejects.toBeInstanceOf(InvalidInput);
    await expect(staffAddCareItem(deps(), r.staff, ask({ words: "x".repeat(501) }))).rejects.toBeInstanceOf(InvalidInput);
    expect(await db.select().from(careItems)).toEqual([]);
  });
});

describe("staff add a name to the Mi Sheberach list", () => {
  it("puts the name on at once, not yet confirmed, linked to no person and no care item", async () => {
    expect(await staffAddMiSheberach(db, r.staff, { name: "Ruth bat Sarah", askedBy: "her daughter" }, NOW)).toEqual({ result: "taken" });
    const list = await listEntries(db, t.clergy, NOW);
    expect(list.current).toMatchObject([{ name: "Ruth bat Sarah", askedBy: "her daughter", consent: "not_confirmed", kind: "dated" }]);
    const [row] = await db.select().from(miSheberachEntries);
    expect(row).toMatchObject({ sfContactId: null, outsidePersonId: null, careItemId: null, createdBy: r.staff.id });
  });

  it("a name already on the list is not added twice", async () => {
    await addEntry(db, t.clergy, { name: "Ruth bat Sarah" }, { now: NOW });
    expect(await staffAddMiSheberach(db, r.lead, { name: "ruth bat sarah" }, NOW)).toEqual({ result: "already" });
    expect(await db.select().from(miSheberachEntries)).toHaveLength(1);
  });

  it("a name whose person asked not to be listed is not added; a rabbi finds it in the Inbox, and staff get the same answer and no trace of it", async () => {
    const { entry } = await addEntry(db, t.clergy, { name: "Gil Levy" }, { now: NOW });
    await updateEntry(db, t.clergy, entry.id, { consent: "asked_not_listed" }, NOW);
    const barred = await staffAddMiSheberach(db, r.staff, { name: "Gil Levy", askedBy: "a friend" }, NOW);
    const fine = await staffAddMiSheberach(db, r.staff, { name: "Dina Katz" }, NOW);
    expect(barred.result).toBe(fine.result);
    expect((await listEntries(db, t.clergy, NOW)).current.map((e) => e.name)).toEqual(["Dina Katz"]);
    expect(await listInbox(db, t.clergy)).toMatchObject([{ id: barred.proposalId, channel: "staff", submittedBy: null, submitterLabel: "Staff" }]);
    expect(await listMyReports(db, r.staff)).toEqual([]);
  });

  it("takes only a name and who asked: an override, a consent or a kind slipped in is ignored", async () => {
    const { entry } = await addEntry(db, t.clergy, { name: "Gil Levy" }, { now: NOW });
    await updateEntry(db, t.clergy, entry.id, { consent: "asked_not_listed" }, NOW);
    const sneaky = { name: "Gil Levy", override: true, consent: "confirmed", kind: "standing", careItemId: "x", sfContactId: CONTACT } as { name: string };
    await staffAddMiSheberach(db, r.staff, sneaky, NOW);
    expect((await listEntries(db, t.clergy, NOW)).current).toEqual([]);
    await staffAddMiSheberach(db, r.staff, { ...sneaky, name: "Dina Katz" }, NOW);
    expect(await db.select().from(miSheberachEntries).where(eq(miSheberachEntries.name, "Dina Katz"))).toMatchObject([{ consent: "not_confirmed", kind: "dated", sfContactId: null, careItemId: null }]);
  });

  it("refuses an empty name and a name with parentheses; staff still cannot read or change the list", async () => {
    await expect(staffAddMiSheberach(db, r.staff, { name: " " }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(staffAddMiSheberach(db, r.staff, { name: "Ruth (her mother Sarah)" }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(listEntries(db, r.staff, NOW)).rejects.toBeInstanceOf(AccessDenied);
    await expect(addEntry(db, r.staff, { name: "Ruth Cohen" }, { now: NOW })).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe("limits and guards", () => {
  it("one person's additions are capped per hour, for each list on its own", async () => {
    for (let i = 0; i < STAFF_ADD_LIMITS.perHour; i++) await staffAddMiSheberach(db, r.staff, { name: `Name ${String.fromCharCode(65 + i)}` }, NOW);
    await expect(staffAddMiSheberach(db, r.staff, { name: "One More" }, NOW)).rejects.toBeInstanceOf(TooMany);
    // Another person, and the other list, are not held back by it.
    expect((await staffAddMiSheberach(db, r.lead, { name: "One More" }, NOW)).result).toBe("taken");
    for (let i = 0; i < STAFF_ADD_LIMITS.perHour; i++) await staffAddCareItem({ ...deps(), now: NOW }, r.staff, ask());
    await expect(staffAddCareItem({ ...deps(), now: NOW }, r.staff, ask())).rejects.toBeInstanceOf(TooMany);
    expect(await db.select().from(careItems)).toHaveLength(STAFF_ADD_LIMITS.perHour);
  });

  it("a rabbi who is away is marked, and a sensitive item cannot go to them (no one covering could open it); an ordinary one can", async () => {
    await db.update(users).set({ awayFrom: "2026-11-24", awayUntil: "2026-11-30", coverUserId: t.clergy2.id }).where(eq(users.id, t.clergy.id));
    expect((await listClergyChoices(db, r.staff, NOW)).filter((c) => c.away).map((c) => c.id)).toEqual([t.clergy.id]);
    await expect(staffAddCareItem({ ...deps(), now: NOW }, r.staff, ask({ sensitive: true }))).rejects.toBeInstanceOf(InvalidInput);
    expect((await staffAddCareItem({ ...deps(), now: NOW }, r.staff, ask())).ownerUserId).toBe(t.clergy.id);
    expect((await staffAddCareItem({ ...deps(), now: NOW }, r.staff, ask({ sensitive: true, ownerUserId: t.clergy2.id }))).ownerUserId).toBe(t.clergy2.id);
  });

  it("a sensitive add about someone who already has a restricted item answers like any other, and leaves no report", async () => {
    await createCareItem(db, t.owner, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "mental_health", restricted: true, restrictedShowsCarer: false });
    const made = await staffAddCareItem(deps(), r.staff, ask({ sensitive: true }));
    expect(Object.keys(made).sort()).toEqual(["careItemId", "ownerName", "ownerUserId"]);
    expect(await listMyReports(db, r.staff)).toEqual([]);
  });

  it("the shared writer refuses everyone but clergy and staff adding directly, and refuses staff anything beyond a plain clergy-only item", async () => {
    const base = { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", ownerUserId: t.clergy.id };
    for (const a of [r.senior, t.carer]) await expect(writeCareItem(db, a, base)).rejects.toBeInstanceOf(AccessDenied);
    for (const extra of [{ visibility: "caregivers" }, { accessUserIds: [t.clergy2.id], restricted: true }, { outsidePersonId: "00000000-0000-4000-8000-000000000000" }, { restrictedShowsCarer: false }]) await expect(writeCareItem(db, r.staff, { ...base, ...extra })).rejects.toBeInstanceOf(AccessDenied);
    expect(await db.select().from(careItems)).toEqual([]);
  });
});
