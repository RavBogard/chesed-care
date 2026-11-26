import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { careItems, followUps, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { createCareItem, listCareItems } from "@/server/care/care-items";
import { listContactEntries } from "@/server/care/contact-log";
import { createFollowUp, listFollowUps } from "@/server/care/follow-ups";
import { DRAFT_MAX, getTextDrafts } from "@/server/care/text-drafts";
import { listTeam } from "@/server/care/users";
import { contactIdField } from "@/server/care/validate";
import type { SalesforceClient } from "@/server/salesforce/client";
import { ACCOUNT, CONTACT, CONTACT2, team, testDb } from "./support/db";

// Only the viewer is mocked (plus Salesforce, which tests may never reach): policy, validation and the database are real.
const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const ruth = { Id: "003000000000001AAA", Name: "Ruth Cohen", FirstName: "Ruth", AccountId: "001000000000001AAA", npsp__Deceased__c: false, Account: { Name: "Cohen Household", cs_Member__c: true } };
vi.mock("@/server/salesforce", () => ({
  getSalesforce: (): SalesforceClient => ({
    async query(soql) {
      // Only Ruth (by her 15- or 18-character Id) exists.
      return soql.includes("WHERE Id = '003000000000001") ? [ruth] : [];
    },
  }),
}));

import { addFollowUpAction, addToCareListAction, closeCareItemAction, logContactAction, moveFollowUpAction, setFollowUpDoneAction } from "@/app/care-actions";
import { addTeamMemberAction, saveTextDraftAction, setTeamMemberActiveAction } from "@/app/settings-actions";
import { IDLE } from "@/lib/action-state";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
type Action = (prev: typeof IDLE, f: FormData) => Promise<{ status: string; message?: string }>;

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let ids: { item: string; fu: string; item2: string; fu2: string; clergyItem: string };
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });

beforeAll(() => {
  process.env.OWNER_EMAILS = "owner@example.test";
});

beforeEach(async () => {
  db = await testDb();
  state.db = db;
  t = await team(db);
  // Real records: two caregiver-visible items (one each), a clergy-only item, and a follow-up on each of the first two.
  const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", visibility: "caregivers", ownerUserId: t.carer.id });
  const item2 = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam Levy", category: "other", visibility: "caregivers", ownerUserId: t.carer2.id });
  const clergyItem = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam Levy", category: "bereavement" });
  const fu = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Soup", dueDate: "2026-12-01", ownerUserId: t.carer.id });
  const fu2 = await createFollowUp(db, t.clergy, { careItemId: item2.id, title: "Cards", dueDate: "2026-12-01", ownerUserId: t.carer2.id });
  ids = { item: item.id, fu: fu.id, item2: item2.id, fu2: fu2.id, clergyItem: clergyItem.id };
});

const person = () => ({ sfContactId: CONTACT });
const cases = (): [string, Action, Record<string, string>][] => [
  ["logContact", logContactAction, { ...person(), kind: "call" }],
  ["addToCareList", addToCareListAction, { ...person(), category: "illness" }],
  ["addFollowUp", addFollowUpAction, { ...person(), title: "Call", dueDate: "2026-12-01" }],
  ["closeCareItem", closeCareItemAction, { careItemId: ids.item }],
  ["setFollowUpDone", setFollowUpDoneAction, { followUpId: ids.fu }],
  ["moveFollowUp", moveFollowUpAction, { followUpId: ids.fu, dueDate: "2026-12-09" }],
  ["saveTextDraft", saveTextDraftAction, { occasionType: "birthday", body: "Hi" }],
  ["addTeamMember", addTeamMemberAction, { email: "new@example.test", role: "clergy" }],
  ["setTeamMemberActive", setTeamMemberActiveAction, { userId: t.clergy.id, active: "false" }],
];

/** Nothing the seed created has changed, and nothing new exists. */
async function untouched() {
  expect((await db.select().from(careItems)).map((i) => i.status)).toEqual(["new", "new", "new"]);
  expect((await db.select().from(followUps)).every((f) => f.doneAt === null && f.dueDate === "2026-12-01")).toBe(true);
  expect(await listContactEntries(db, t.owner)).toEqual([]);
  expect(await getTextDrafts(db, t.clergy)).toEqual({});
  expect((await listTeam(db, t.owner)).length).toBe(5);
  expect((await listTeam(db, t.owner)).every((m) => m.active)).toBe(true);
}

describe("screen server actions: who may act", () => {
  it("every action refuses a signed-out viewer, using real ids, and changes nothing", async () => {
    state.viewer = { kind: "signed-out" };
    for (const [name, action, input] of cases()) expect((await action(IDLE, form(input))).status, name).toBe("error");
    await untouched();
  });

  it("every action refuses a viewer who is not on the allowlist, using real ids, and changes nothing", async () => {
    state.viewer = { kind: "not-authorised" };
    for (const [name, action, input] of cases()) expect((await action(IDLE, form(input))).status, name).toBe("error");
    await untouched();
  });

  it("a caregiver cannot reach team management, drafts, care-list creation or a person without an item", async () => {
    as(t.carer);
    for (const [name, action, input] of cases().filter(([n]) => ["logContact", "addToCareList", "addFollowUp", "saveTextDraft", "addTeamMember", "setTeamMemberActive"].includes(n))) {
      expect((await action(IDLE, form(input))).status, name).toBe("error");
    }
    await untouched();
    expect(await listContactEntries(db, t.owner, { sfContactId: CONTACT })).toEqual([]);
  });

  it("a caregiver cannot close even their own item, nor anyone else's follow-up, nor hand work to someone else", async () => {
    as(t.carer);
    expect((await closeCareItemAction(IDLE, form({ careItemId: ids.item }))).status).toBe("error");
    expect((await closeCareItemAction(IDLE, form({ careItemId: ids.item2 }))).status).toBe("error");
    expect((await setFollowUpDoneAction(IDLE, form({ followUpId: ids.fu2 }))).status).toBe("error");
    expect((await moveFollowUpAction(IDLE, form({ followUpId: ids.fu2, dueDate: "2026-12-09" }))).status).toBe("error");
    // On their own item, but for someone else.
    expect((await addFollowUpAction(IDLE, form({ careItemId: ids.item, title: "x", dueDate: "2026-12-02", ownerUserId: t.carer2.id }))).status).toBe("error");
    // On items that are not theirs: another caregiver's, and a clergy-only one.
    for (const careItemId of [ids.item2, ids.clergyItem]) {
      expect((await addFollowUpAction(IDLE, form({ careItemId, title: "x", dueDate: "2026-12-02" }))).status).toBe("error");
      expect((await logContactAction(IDLE, form({ careItemId, kind: "call", note: "n" }))).status).toBe("error");
    }
    await untouched();
    expect(await db.select().from(followUps)).toHaveLength(2);
  });

  it("a caregiver may finish and move their own follow-up, and log against their own item using the item's name", async () => {
    as(t.carer);
    expect((await moveFollowUpAction(IDLE, form({ followUpId: ids.fu, dueDate: "2026-12-09" }))).status).toBe("ok");
    expect((await logContactAction(IDLE, form({ careItemId: ids.item, kind: "call", note: "Spoke", sfContactId: CONTACT2, displayName: "Forged" }))).status).toBe("ok");
    const [entry] = await listContactEntries(db, t.carer);
    expect(entry.displayName).toBe("Ruth Cohen");
    expect(entry.sfContactId).toBe(CONTACT);
    expect((await setFollowUpDoneAction(IDLE, form({ followUpId: ids.fu }))).status).toBe("ok");
  });

  it("clergy cannot manage the team", async () => {
    as(t.clergy);
    expect((await addTeamMemberAction(IDLE, form({ email: "x@example.test", role: "clergy" }))).status).toBe("error");
  });

  it("an owner adds and deactivates a team member, but a current owner cannot be deactivated", async () => {
    as(t.owner);
    expect((await addTeamMemberAction(IDLE, form({ email: "New@Example.test", role: "caregiver" }))).status).toBe("ok");
    const added = (await listTeam(db, t.owner)).find((m) => m.email === "new@example.test")!;
    expect(added.role).toBe("caregiver");
    expect((await setTeamMemberActiveAction(IDLE, form({ userId: added.id, active: "false" }))).status).toBe("ok");
    expect((await listTeam(db, t.owner)).find((m) => m.id === added.id)!.active).toBe(false);
    expect((await setTeamMemberActiveAction(IDLE, form({ userId: t.owner.id, active: "false" }))).status).toBe("error");
    expect((await listTeam(db, t.owner)).find((m) => m.id === t.owner.id)!.active).toBe(true);
  });

  it("a stale owner row (email no longer in OWNER_EMAILS) can be deactivated like clergy", async () => {
    const [stale] = await db.insert(users).values({ email: "stale@example.test", role: "owner", active: true }).returning();
    as(t.owner);
    expect((await setTeamMemberActiveAction(IDLE, form({ userId: stale.id, active: "false" }))).status).toBe("ok");
    expect((await listTeam(db, t.owner)).find((m) => m.id === stale.id)!.active).toBe(false);
  });
});

describe("screen server actions: care work", () => {
  it("clergy add to the care list, add a follow-up, log a private contact, move and finish the follow-up", async () => {
    as(t.clergy);
    expect((await addToCareListAction(IDLE, form({ ...person(), category: "illness" }))).status).toBe("ok");
    const item = (await listCareItems(db, t.clergy, { sfContactId: CONTACT, status: "active" })).find((i) => i.ownerUserId === t.clergy.id)!;

    expect((await addFollowUpAction(IDLE, form({ careItemId: item.id, title: "Call", dueDate: "2026-12-01" }))).status).toBe("ok");
    expect((await logContactAction(IDLE, form({ ...person(), kind: "visit", note: "secret", private: "on" }))).status).toBe("ok");

    // Another clergy member sees that a contact happened, not the note.
    const seen = (await listContactEntries(db, t.clergy2, { sfContactId: CONTACT })).filter((e) => e.authorUserId === t.clergy.id);
    expect(seen).toHaveLength(1);
    expect(seen[0].noteHidden).toBe(true);
    expect(seen[0].note).toBeNull();

    const mine = (await listFollowUps(db, t.clergy, { open: true, careItemId: item.id }))[0];
    expect((await moveFollowUpAction(IDLE, form({ followUpId: mine.id, dueDate: "2026-12-09" }))).status).toBe("ok");
    expect((await setFollowUpDoneAction(IDLE, form({ followUpId: mine.id }))).status).toBe("ok");
    expect(await listFollowUps(db, t.clergy, { open: true, careItemId: item.id })).toEqual([]);
    expect((await closeCareItemAction(IDLE, form({ careItemId: item.id }))).status).toBe("ok");
  });

  it("the name and household come from Salesforce, never from the form", async () => {
    as(t.clergy);
    expect((await addToCareListAction(IDLE, form({ ...person(), category: "illness", displayName: "Forged", sfAccountId: "001999999999999AAA" }))).status).toBe("ok");
    const created = (await listCareItems(db, t.clergy, { sfContactId: CONTACT })).find((i) => i.ownerUserId === t.clergy.id)!;
    expect(created.displayName).toBe("Ruth Cohen");
    expect(created.sfAccountId).toBe("001000000000001AAA");
  });

  it("refuses a contact Salesforce does not have, and stores nothing for it", async () => {
    as(t.clergy);
    const missing = "003000000000099AAA";
    for (const [action, extra] of [
      [addToCareListAction, { category: "illness" }],
      [logContactAction, { kind: "call", note: "n" }],
      [addFollowUpAction, { title: "x", dueDate: "2026-12-02" }],
    ] as [Action, Record<string, string>][]) {
      expect((await action(IDLE, form({ sfContactId: missing, ...extra }))).status).toBe("error");
    }
    expect(await db.select().from(careItems).where(eq(careItems.sfContactId, missing))).toEqual([]);
    expect(await listContactEntries(db, t.owner, { sfContactId: missing })).toEqual([]);
  });

  it("only canonical 18-character Ids are ever stored; a 15-character Id is resolved to its canonical form", async () => {
    expect(() => contactIdField("003000000000001")).toThrow();
    expect(contactIdField(CONTACT)).toBe(CONTACT);
    as(t.clergy);
    expect((await addToCareListAction(IDLE, form({ sfContactId: "003000000000001", category: "birth" }))).status).toBe("ok");
    const created = (await db.select().from(careItems).where(and(eq(careItems.category, "birth"))))[0];
    expect(created.sfContactId).toBe(CONTACT);
  });

  it("refuses to add a contact or follow-up to a closed care item", async () => {
    as(t.clergy);
    expect((await closeCareItemAction(IDLE, form({ careItemId: ids.clergyItem }))).status).toBe("ok");
    expect((await logContactAction(IDLE, form({ careItemId: ids.clergyItem, kind: "call" }))).status).toBe("error");
    expect((await addFollowUpAction(IDLE, form({ careItemId: ids.clergyItem, title: "x", dueDate: "2026-12-02" }))).status).toBe("error");
    expect(await listContactEntries(db, t.owner)).toEqual([]);
    expect(await db.select().from(followUps)).toHaveLength(2);
  });

  it("an error never echoes the input back", async () => {
    as(t.clergy);
    const r = await logContactAction(IDLE, form({ ...person(), kind: "nonsense", note: "very private words" }));
    expect(r.status).toBe("error");
    expect(JSON.stringify(r)).not.toContain("very private words");
  });
});

describe("text draft settings", () => {
  it("saves, rejects a draft that is too long or has an unknown type, and resets", async () => {
    as(t.clergy);
    expect((await saveTextDraftAction(IDLE, form({ occasionType: "birthday", body: "Mazal tov, {first_name}!" }))).status).toBe("ok");
    expect(await getTextDrafts(db, t.clergy)).toEqual({ birthday: "Mazal tov, {first_name}!" });
    expect((await saveTextDraftAction(IDLE, form({ occasionType: "birthday", body: "x".repeat(DRAFT_MAX + 1) }))).status).toBe("error");
    expect((await saveTextDraftAction(IDLE, form({ occasionType: "wedding", body: "hi" }))).status).toBe("error");
    expect((await saveTextDraftAction(IDLE, form({ occasionType: "birthday", body: "keep", intent: "reset" }))).status).toBe("ok");
    expect(await getTextDrafts(db, t.clergy)).toEqual({});
  });

  it("drafts are private to their author", async () => {
    as(t.clergy);
    await saveTextDraftAction(IDLE, form({ occasionType: "yahrzeit", body: "Mine" }));
    expect(await getTextDrafts(db, t.clergy2)).toEqual({});
  });
});
