import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_PERSONAS, demoEmail } from "@/lib/demo";
import { resolveActor } from "@/server/access/actor";
import { parseOwnerEmails, type Actor } from "@/server/access/policy";
import { listCareItems, listCareItemStubs } from "@/server/care/care-items";
import { listFollowUps } from "@/server/care/follow-ups";
import { getPersonPage } from "@/server/care/person-page";
import { listInbox } from "@/server/care/proposals";
import { careItems, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { accountId, contactId, CONTACTS, HOUSEHOLDS } from "@/server/demo/congregation";
import { demoAccessCode, demoCodeMatches, demoGateOpen, demoGateToken } from "@/server/demo/gate";
import { assertDemoDatabase, ensureDemoFresh, NotADemoDatabase, resetDemo } from "@/server/demo/reset";
import { demoSalesforce } from "@/server/demo/salesforce";
import { emailStatus } from "@/server/email/config";
import { aiSortingEnabled } from "@/server/care/ai-config";
import { findPeople } from "@/server/lifecycle/find-people";
import { resolveHouseholdName, searchHouseholdNames } from "@/server/lifecycle/household-names";
import { getOccasions } from "@/server/lifecycle/occasions";
import { fetchPerson } from "@/server/lifecycle/person";
import { newBabyQuery } from "@/server/lifecycle/proposals-from-salesforce";
import { fetchShloshim } from "@/server/lifecycle/shloshim";
import { listMealPages } from "@/server/meals/pages";
import { listEntries } from "@/server/misheberach/list";
import { listVolunteerTasks } from "@/server/volunteers/organiser";
import { listOpenReferrals } from "@/server/volunteers/referrals";
import { listRoster } from "@/server/volunteers/roster";
import { listVisiting } from "@/server/volunteers/visiting";
import { addActor, testDb } from "./support/db";

// A Wednesday at noon in St. Louis.
const NOW = new Date("2026-12-02T18:00:00Z");
const TODAY = "2026-12-02";
const sf = demoSalesforce(() => NOW);
const clergy: Actor = { id: "00000000-0000-4000-8000-000000000001", email: "x@example.test", name: "X", role: "clergy" };

let db: Db;
beforeEach(async () => {
  vi.stubEnv("NEXT_PUBLIC_CARE_DEMO", "on");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-for-the-demo");
  db = await testDb();
});
afterEach(() => vi.unstubAllEnvs());

async function persona(key: (typeof DEMO_PERSONAS)[number]["key"]): Promise<Actor> {
  const actor = await resolveActor(db, { email: demoEmail(key) }, parseOwnerEmails(demoEmail("rabbi")));
  if (!actor) throw new Error("no such persona");
  return actor;
}

describe("the invented congregation answers the app's own Salesforce queries", () => {
  it("has a birthday, a yahrzeit and two houses of mourning today, whatever today is", async () => {
    for (const now of [NOW, new Date("2027-02-28T18:00:00Z"), new Date("2028-02-29T18:00:00Z"), new Date("2026-12-31T18:00:00Z")]) {
      const view = await getOccasions({ db: await testDb(), sf: () => demoSalesforce(() => now), now }, { ...clergy, role: "owner" });
      const flat = JSON.stringify(view);
      for (const name of ["Ruth Friedman", "Marcus Green", "Lillian Shapiro", "David Kaplan", "Morris Blum"]) expect(flat).toContain(name);
    }
  });

  it("finds people by name, pages the search, and never answers a write", async () => {
    expect((await findPeople({ sf: () => sf }, clergy, "rosen")).map((p) => p.name)).toEqual(["Harold Rosen", "Judith Rosen"]);
    expect((await findPeople({ sf: () => sf }, clergy, "ruth fried"))[0]).toMatchObject({ contactId: contactId(11), household: "Ruth Friedman", place: "Riverton, MO" });
    expect(await findPeople({ sf: () => sf }, clergy, "nobody")).toEqual([]);
    const lead: Actor = { ...clergy, role: "lead" };
    expect((await searchHouseholdNames({ sf: () => sf }, lead, "levy")).map((p) => p.name).sort()).toEqual(["Ben Levy", "Noa Levy", "Talia Levy"]);
    expect(await resolveHouseholdName({ sf: () => sf }, lead, contactId(9))).toEqual({ contactId: contactId(9), name: "Talia Levy", accountId: accountId(4), household: "Ben and Talia Levy" });
    await expect(sf.query("UPDATE Contact SET Name = 'x'")).rejects.toThrow();
    await expect(sf.query("SELECT Id FROM Opportunity WHERE Amount > 0")).rejects.toThrow("does not understand");
  });

  it("gives every person a page: household, phones, address and the year's dates", async () => {
    for (const c of CONTACTS) {
      const p = await fetchPerson(sf, contactId(c.n), TODAY);
      expect(p).toMatchObject({ contactId: contactId(c.n), name: `${c.first} ${c.last}`, isCurrentMember: true, accountId: accountId(c.household) });
      expect(p!.address?.street).toBe(HOUSEHOLDS.find((h) => h.n === c.household)!.street);
    }
    const harold = await fetchPerson(sf, contactId(1), TODAY);
    expect(harold!.members.map((m) => m.name)).toEqual(["Judith Rosen"]);
    expect(harold!.occasions.map((o) => o.type).sort()).toEqual(["anniversary", "birthday", "birthday", "yahrzeit"]);
    expect(await fetchPerson(sf, "003000000000009AAA", TODAY)).toBeNull();
  });

  it("knows the recent deaths with their mourners, and the new baby", async () => {
    const mourning = await fetchShloshim(sf, TODAY);
    expect(mourning.map((o) => [o.personName, o.household])).toEqual([
      ["David Kaplan", "Naomi Kaplan"],
      ["David Kaplan", "Rachel Kaplan-Stein and Michael Stein"],
      ["Morris Blum", "Sylvia Blum"],
    ]);
    expect((await sf.query(newBabyQuery(TODAY))).map((r) => r.Id)).toEqual([contactId(10)]);
  });
});

describe("the starting story", () => {
  it("writes every scene, and each role then sees its own share", async () => {
    const done = await resetDemo(db, NOW);
    expect(done).toEqual({ reset: true, failed: [] });
    expect((await db.select().from(users)).map((u) => u.email).sort()).toEqual(DEMO_PERSONAS.map((p) => demoEmail(p.key)).sort());

    const [rabbi, rabbi2, lead] = [await persona("rabbi"), await persona("rabbi2"), await persona("lead")];
    expect(rabbi.role).toBe("owner");

    // The care list, and the one item kept from a colleague.
    const mine = (await listCareItems(db, rabbi)).map((i) => i.displayName).sort();
    expect(mine).toEqual(["Aaron Goldberg", "Bella Mendel", "Deborah Abrams", "Gloria Abrams", "Harold Rosen", "Ruth Friedman", "Sara Cohen", "Sylvia Blum"]);
    expect((await listCareItems(db, rabbi2)).map((i) => i.displayName)).not.toContain("Aaron Goldberg");
    expect(await listCareItemStubs(db, rabbi2)).toMatchObject([{ displayName: "Aaron Goldberg", ownerName: "Rabbi Miriam Adler" }]);

    // Something is due today and something is overdue.
    const due = await listFollowUps(db, rabbi, {});
    expect(due.some((f) => f.dueDate === TODAY)).toBe(true);
    expect(due.some((f) => f.dueDate < TODAY)).toBe(true);

    // The Inbox: the death, the birth, the office's call and two notes from the public form. The rabbi's own capture is hers alone.
    const inbox = await listInbox(db, rabbi2);
    expect(inbox.map((p) => p.channel).sort()).toEqual(["form", "form", "salesforce", "salesforce", "staff"]);
    expect((await listInbox(db, rabbi)).length).toBe(inbox.length + 1);

    expect((await listEntries(db, rabbi, NOW)).current.length).toBe(4);
    const page = await getPersonPage({ db, sf: () => sf, now: NOW }, rabbi, contactId(1));
    expect(page.person?.name).toBe("Harold Rosen");

    // The Mitzvah Corps lead: tasks, the sheet, the roster, the referral, the visiting list, the meal page. Never a care item.
    const board = await listVolunteerTasks(db, lead, NOW);
    expect(board.tasks.length).toBe(3);
    expect(board.sheets.length).toBe(1);
    expect((await listRoster(db, lead, {}, NOW)).length).toBe(6);
    expect(await listOpenReferrals(db, lead)).toMatchObject([{ kind: "visit" }]);
    expect((await listVisiting(db, lead, NOW)).map((v) => v.name).sort()).toEqual(["Harold Rosen", "Ruth Friedman"]);
    expect(await listMealPages(db, lead, NOW)).toMatchObject([{ title: "the Levy family", status: "live" }]);
    expect(await listCareItems(db, lead)).toEqual([]);
  });

  it("is written once a day, and again only when the day changes", async () => {
    await ensureDemoFresh(db, NOW);
    const [first] = await db.select({ id: users.id }).from(users).where(eq(users.email, demoEmail("rabbi")));
    await ensureDemoFresh(db, new Date(NOW.getTime() + 3_600_000));
    expect((await db.select({ id: users.id }).from(users).where(eq(users.email, demoEmail("rabbi"))))[0].id).toBe(first.id);
    // A visitor's addition is gone the next morning.
    const rabbi = await persona("rabbi");
    await db.update(careItems).set({ summary: "typed by a visitor" }).where(eq(careItems.ownerUserId, rabbi.id));
    await ensureDemoFresh(db, new Date(NOW.getTime() + 24 * 3_600_000));
    expect((await db.select().from(careItems)).some((i) => i.summary === "typed by a visitor")).toBe(false);
    expect((await db.select({ id: users.id }).from(users).where(eq(users.email, demoEmail("rabbi"))))[0].id).not.toBe(first.id);
  });

  it("'Start over' does nothing within half a minute of the last one", async () => {
    await resetDemo(db, NOW);
    expect((await resetDemo(db, new Date(NOW.getTime() + 5_000), { minGapMs: 30_000 })).reset).toBe(false);
    expect((await resetDemo(db, new Date(NOW.getTime() + 31_000), { minGapMs: 30_000 })).reset).toBe(true);
  });
});

describe("the fences", () => {
  it("never empties a database that holds a real account", async () => {
    await addActor(db, "rabbi@example.test", "clergy");
    await expect(resetDemo(db, NOW)).rejects.toBeInstanceOf(NotADemoDatabase);
    await expect(ensureDemoFresh(db, NOW)).rejects.toBeInstanceOf(NotADemoDatabase);
    expect((await db.select().from(users)).map((u) => u.email)).toEqual(["rabbi@example.test"]);
  });

  it("does nothing at all outside a demo build", async () => {
    vi.stubEnv("NEXT_PUBLIC_CARE_DEMO", "");
    await expect(assertDemoDatabase(db)).rejects.toBeInstanceOf(NotADemoDatabase);
    await expect(resetDemo(db, NOW)).rejects.toBeInstanceOf(NotADemoDatabase);
    expect(await db.select().from(users)).toEqual([]);
  });

  it("a demo build sends no email and calls no model, whatever else is configured", () => {
    const env = { NEXT_PUBLIC_CARE_DEMO: "on", RESEND_API_KEY: "k", CARE_EMAIL: "on", CARE_AI_SORTING: "on", VERCEL_ENV: "production", ANTHROPIC_API_KEY: "k" };
    expect(emailStatus(env).configured).toBe(false);
    expect(aiSortingEnabled(env)).toBe(false);
    expect(emailStatus({ ...env, NEXT_PUBLIC_CARE_DEMO: "" }).configured).toBe(true);
    expect(aiSortingEnabled({ ...env, NEXT_PUBLIC_CARE_DEMO: "" })).toBe(true);
  });

  it("with an access code set, only a visitor who typed it gets in; with none, anyone does", () => {
    const env = { DEMO_ACCESS_CODE: " Shalom-Bayit ", BETTER_AUTH_SECRET: "s" };
    expect(demoAccessCode(env)).toBe("shalom-bayit");
    expect(demoCodeMatches("SHALOM-bayit  ", env)).toBe(true);
    for (const wrong of ["shalom", "", undefined, 42, "x".repeat(300)]) expect(demoCodeMatches(wrong, env)).toBe(false);
    const token = demoGateToken(env)!;
    expect(token).not.toContain("shalom");
    expect(demoGateOpen(token, env)).toBe(true);
    for (const cookie of [undefined, "", "shalom-bayit", token.slice(1), demoGateToken({ ...env, DEMO_ACCESS_CODE: "other" })!]) expect(demoGateOpen(cookie, env)).toBe(false);
    // A new secret or a new code locks everyone out again.
    expect(demoGateOpen(token, { ...env, BETTER_AUTH_SECRET: "t" })).toBe(false);
    for (const none of [{}, { DEMO_ACCESS_CODE: "  " }]) {
      expect(demoGateToken(none)).toBeNull();
      expect(demoGateOpen(undefined, none)).toBe(true);
      expect(demoCodeMatches("anything", none)).toBe(true);
    }
  });
});
