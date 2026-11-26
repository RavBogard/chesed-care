import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied, canReferToCorps, canSeeCorpsReferrals, type Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { InvalidInput, NotFound, TooMany } from "@/server/care/validate";
import { DAILY_TASKS } from "@/server/daily/run";
import { auditLog, corpsReferrals, outsidePeople } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { TOOLS } from "@/server/mcp/tools";
import { callTool } from "@/server/mcp/transport";
import { getCoordinatorHome } from "@/server/volunteers/home";
import { closeReferral, createReferral, listOpenReferrals, lapseReferrals, referralsForPerson, REFERRALS_PER_HOUR, setReferralConsent, takeReferral, withdrawReferral, type ReferralInput } from "@/server/volunteers/referrals";
import { ACCOUNT, addActor, CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";
import { NOW } from "./support/meals";
import { fakeSf } from "./support/sf";
import { words } from "./support/words";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const sf = fakeSf();
const NOWHERE = "5f1f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f5f";
const CONTACT_LINE = "Her mobile, 314 555 0100, afternoons";
const INVOLVED = "Rabbi Dana has called";
const NOTE = "Side door, the bell is broken";
const refer = (actor: Actor, over: ReferralInput = {}, now: Date = NOW) => createReferral(db, actor, { sfContactId: CONTACT, kind: "meal", consent: "yes", contactLine: CONTACT_LINE, mayShareAddress: true, alreadyInvolved: INVOLVED, note: NOTE, ...over }, { sf: sf.sf, now });
const outside = async (name: string) => (await db.insert(outsidePeople).values({ name, createdBy: t.clergy.id }).returning())[0];
const ruthItem = (over: Record<string, unknown> = {}) => createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: "Chemotherapy on Tuesdays", ...over });

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-corps-referrals";
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});

describe("who may do what", () => {
  it("the policy: clergy level refer; the lead also sees and acts; nobody else gets anything", () => {
    for (const a of [t.owner, t.clergy]) expect([canReferToCorps(a), canSeeCorpsReferrals(a)]).toEqual([true, true]);
    expect([canReferToCorps(t.lead), canSeeCorpsReferrals(t.lead)]).toEqual([false, true]);
    for (const a of [t.carer, t.staff, t.senior]) expect([canReferToCorps(a), canSeeCorpsReferrals(a)]).toEqual([false, false]);
  });

  it("staff, senior staff and a caregiver are refused by every function, and learn nothing on a person's page", async () => {
    const { id } = await refer(t.clergy);
    for (const a of [t.carer, t.staff, t.senior]) {
      await expect(refer(a, { sfContactId: undefined, outsidePersonId: (await outside("Someone Else")).id })).rejects.toBeInstanceOf(AccessDenied);
      await expect(listOpenReferrals(db, a)).rejects.toBeInstanceOf(AccessDenied);
      await expect(takeReferral(db, a, id, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(closeReferral(db, a, id, { as: "done" }, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(withdrawReferral(db, a, id, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(setReferralConsent(db, a, id, "yes")).rejects.toBeInstanceOf(AccessDenied);
      expect(await referralsForPerson(db, a, { sfContactId: CONTACT })).toBeNull();
    }
    expect(await db.select().from(corpsReferrals)).toHaveLength(1);
    expect((await db.select().from(corpsReferrals))[0]).toMatchObject({ takenBy: null, closedAt: null, consent: "yes" });
  });

  it("the lead sees and acts but cannot refer, withdraw or change consent; clergy and the owner can", async () => {
    const { id } = await refer(t.clergy, { consent: "rabbi_asks" });
    await expect(refer(t.lead, { sfContactId: undefined, outsidePersonId: (await outside("Someone Else")).id })).rejects.toBeInstanceOf(AccessDenied);
    await expect(withdrawReferral(db, t.lead, id, NOW)).rejects.toBeInstanceOf(AccessDenied);
    await expect(setReferralConsent(db, t.lead, id, "yes")).rejects.toBeInstanceOf(AccessDenied);
    expect(await referralsForPerson(db, t.lead, { sfContactId: CONTACT })).toBeNull();
    for (const a of [t.owner, t.clergy, t.clergy2]) expect((await listOpenReferrals(db, a)).map((r) => r.id)).toEqual([id]);
    // Any rabbi may settle the consent or withdraw, not only the one who referred.
    await setReferralConsent(db, t.owner, id, "coordinator_asks");
    expect((await listOpenReferrals(db, t.lead)).map((r) => r.id)).toEqual([id]);
    await withdrawReferral(db, t.clergy2, id, NOW);
    expect(await listOpenReferrals(db, t.lead)).toEqual([]);
  });

  it("the coordinator home carries the open referrals for the lead and for clergy", async () => {
    const { id } = await refer(t.clergy);
    for (const a of [t.lead, t.owner, t.clergy]) expect((await getCoordinatorHome(db, a, NOW)).referrals.map((r) => r.id)).toEqual([id]);
    await expect(getCoordinatorHome(db, t.staff, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe("what a referral holds", () => {
  it("the name comes from the server, never from the form; the list is oldest first", async () => {
    const second = await refer(t.owner, { sfContactId: undefined, outsidePersonId: (await outside("Sam Outside")).id, kind: "ask", consent: "coordinator_asks", contactLine: null, mayShareAddress: undefined, alreadyInvolved: null, note: null }, at(1));
    const first = await refer(t.clergy, { displayName: "Made Up" } as ReferralInput);
    const list = await listOpenReferrals(db, t.lead);
    expect(list.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(list[0]).toEqual({ id: first.id, name: "Ruth Cohen", kind: "meal", consent: "yes", contactLine: CONTACT_LINE, mayShareAddress: true, alreadyInvolved: INVOLVED, note: NOTE, referredByName: "clergy", createdAt: NOW, takenByName: null, takenAt: null, takenByMe: false, canTake: true });
    expect(list[1]).toMatchObject({ name: "Sam Outside", kind: "ask", consent: "coordinator_asks", contactLine: null, mayShareAddress: false, alreadyInvolved: null, note: null, referredByName: "owner" });
  });

  it("needs exactly one person, a known kind and consent, and one-line texts within their limits", async () => {
    const o = await outside("Both");
    await expect(refer(t.clergy, { sfContactId: undefined })).rejects.toBeInstanceOf(InvalidInput);
    await expect(refer(t.clergy, { outsidePersonId: o.id })).rejects.toBeInstanceOf(InvalidInput);
    await expect(refer(t.clergy, { sfContactId: undefined, outsidePersonId: NOWHERE })).rejects.toBeInstanceOf(NotFound);
    // A Salesforce contact the server cannot find is refused, whatever name the form claims.
    await expect(refer(t.clergy, { sfContactId: CONTACT2, displayName: "Made Up" } as ReferralInput)).rejects.toBeInstanceOf(NotFound);
    for (const bad of [{ kind: "surgery" }, { kind: undefined }, { consent: "maybe" }, { consent: undefined }, { mayShareAddress: "on" }, { contactLine: "c".repeat(201) }, { alreadyInvolved: "a".repeat(201) }, { note: "n".repeat(301) }, { note: 5 }]) {
      await expect(refer(t.clergy, bad as ReferralInput)).rejects.toBeInstanceOf(InvalidInput);
    }
    // One line each: a line break, a control character or a direction override is refused.
    for (const field of ["contactLine", "alreadyInvolved", "note"] as const) {
      for (const bad of ["one\ntwo", "one\rtwo", "tab\there", "bell\u0007", "flip‮ped"]) await expect(refer(t.clergy, { [field]: bad })).rejects.toBeInstanceOf(InvalidInput);
    }
    expect(await db.select().from(corpsReferrals)).toHaveLength(0);
  });

  it("one open referral per person: a second is refused until the first is closed", async () => {
    const { id } = await refer(t.clergy);
    await expect(refer(t.owner, { kind: "ride" })).rejects.toBeInstanceOf(InvalidInput);
    await withdrawReferral(db, t.clergy, id, NOW);
    await expect(refer(t.owner, { kind: "ride" })).resolves.toMatchObject({ id: expect.any(String) });
    const o = await outside("Sam Outside");
    await refer(t.clergy, { sfContactId: undefined, outsidePersonId: o.id });
    await expect(refer(t.clergy, { sfContactId: undefined, outsidePersonId: o.id })).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe("privacy", () => {
  it("rule 1: from the person's page (no care item) a referral is allowed even when the person has restricted care, by anyone who may see the person", async () => {
    await ruthItem({ restricted: true, accessUserIds: [] });
    await expect(refer(t.clergy2)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("rule 3: a lead receives exactly the listed fields: no care item id, no person id, nothing of the care record", async () => {
    const item = await ruthItem();
    const { id } = await refer(t.clergy);
    const [stored] = await db.select().from(corpsReferrals);
    // Nothing links the stored row to the care item either.
    expect(JSON.stringify(stored)).not.toContain(item.id);
    expect(Object.keys(stored)).not.toContain("careItemId");
    for (const view of [await listOpenReferrals(db, t.lead), (await getCoordinatorHome(db, t.lead, NOW)).referrals]) {
      expect(view.map((r) => r.id)).toEqual([id]);
      expect(Object.keys(view[0]).sort()).toEqual(["alreadyInvolved", "canTake", "consent", "contactLine", "createdAt", "id", "kind", "mayShareAddress", "name", "note", "referredByName", "takenAt", "takenByMe", "takenByName"]);
      const text = JSON.stringify(view);
      for (const secret of [item.id, CONTACT, ACCOUNT, t.clergy.id, "illness", "Chemotherapy", "Tuesdays", "/people/", "example.test"]) expect(text).not.toContain(secret);
    }
  });

  it("rule 2: a hidden outside person is NotFound for a clergy viewer who cannot see them, absent from their list, and still there for the lead", async () => {
    const x = await outside("Hidden Hal");
    await createCareItem(db, t.clergy, { outsidePersonId: x.id, displayName: "Hidden Hal", category: "mental_health", restricted: true, accessUserIds: [] });
    const { id } = await refer(t.clergy, { sfContactId: undefined, outsidePersonId: x.id });
    expect((await listOpenReferrals(db, t.clergy)).map((r) => r.name)).toEqual(["Hidden Hal"]);
    for (const shut of [t.clergy2, t.owner]) {
      expect(await listOpenReferrals(db, shut)).toEqual([]);
      expect((await getCoordinatorHome(db, shut, NOW)).referrals).toEqual([]);
      expect(await referralsForPerson(db, shut, { outsidePersonId: x.id })).toEqual({ open: null, closed: [], olderClosed: 0 });
      await expect(refer(shut, { sfContactId: undefined, outsidePersonId: x.id })).rejects.toBeInstanceOf(NotFound);
      await expect(setReferralConsent(db, shut, id, "yes")).rejects.toBeInstanceOf(NotFound);
      await expect(takeReferral(db, shut, id, NOW)).rejects.toBeInstanceOf(NotFound);
      await expect(closeReferral(db, shut, id, { as: "done" }, NOW)).rejects.toBeInstanceOf(NotFound);
      await expect(withdrawReferral(db, shut, id, NOW)).rejects.toBeInstanceOf(NotFound);
    }
    // The lead has no care access and keeps seeing the referral (no person link is made for them).
    expect((await listOpenReferrals(db, t.lead)).map((r) => r.name)).toEqual(["Hidden Hal"]);
    expect((await referralsForPerson(db, t.clergy, { outsidePersonId: x.id }))?.open?.id).toBe(id);
    // Once it is closed the same holds for the history on the person's page.
    await withdrawReferral(db, t.clergy, id, NOW);
    for (const shut of [t.clergy2, t.owner]) expect(await referralsForPerson(db, shut, { outsidePersonId: x.id })).toEqual({ open: null, closed: [], olderClosed: 0 });
    expect((await referralsForPerson(db, t.clergy, { outsidePersonId: x.id }))?.closed).toHaveLength(1);
  });

  it("rule 4: while a rabbi asks first the lead learns nothing of it, by list, home or id; once a rabbi settles it, it is hers to take", async () => {
    const { id } = await refer(t.clergy, { consent: "rabbi_asks" });
    expect(await listOpenReferrals(db, t.lead)).toEqual([]);
    expect((await getCoordinatorHome(db, t.lead, NOW)).referrals).toEqual([]);
    // By its id it is exactly like one that does not exist.
    await expect(takeReferral(db, t.lead, id, NOW)).rejects.toBeInstanceOf(NotFound);
    await expect(closeReferral(db, t.lead, id, { as: "done" }, NOW)).rejects.toBeInstanceOf(NotFound);
    await expect(takeReferral(db, t.lead, NOWHERE, NOW)).rejects.toBeInstanceOf(NotFound);
    // The clergy see it with the line they wrote, and cannot take it for themselves either.
    expect((await listOpenReferrals(db, t.clergy2))[0]).toMatchObject({ id, consent: "rabbi_asks", contactLine: CONTACT_LINE, canTake: false });
    for (const a of [t.clergy, t.owner]) expect(await takeReferral(db, a, id, NOW)).toEqual({ ok: false, reason: "rabbi_asks_first" });
    expect((await db.select().from(corpsReferrals))[0].takenBy).toBeNull();
    // Only forward: never back to "a rabbi will ask", and nothing else.
    for (const bad of ["rabbi_asks", "no", undefined]) await expect(setReferralConsent(db, t.clergy, id, bad)).rejects.toBeInstanceOf(InvalidInput);
    await setReferralConsent(db, t.clergy2, id, "yes");
    expect((await listOpenReferrals(db, t.lead))[0]).toMatchObject({ consent: "yes", contactLine: CONTACT_LINE, canTake: true });
    expect(await takeReferral(db, t.lead, id, NOW)).toEqual({ ok: true });
  });

  it("rule 6: audit rows hold ids and enum values only: no name, contact line, note or outcome", async () => {
    const { id } = await refer(t.clergy, { consent: "rabbi_asks" });
    await setReferralConsent(db, t.clergy, id, "coordinator_asks");
    await takeReferral(db, t.lead, id, NOW);
    await closeReferral(db, t.lead, id, { as: "done", outcomeLine: "Brought lasagne on Thursday" }, NOW);
    const again = await refer(t.owner);
    await withdrawReferral(db, t.owner, again.id, NOW);
    const rows = (await db.select().from(auditLog)).filter((r) => r.subjectType === "corps_referral");
    expect(rows.map((r) => [r.action, r.detail])).toEqual([
      ["corps_referral.create", { referralKind: "meal", consent: "rabbi_asks" }],
      ["corps_referral.consent", { consent: "coordinator_asks" }],
      ["corps_referral.take", null],
      ["corps_referral.close", { closedAs: "done" }],
      ["corps_referral.create", { referralKind: "meal", consent: "yes" }],
      ["corps_referral.close", { closedAs: "withdrawn" }],
    ]);
    expect(new Set(rows.map((r) => r.subjectId))).toEqual(new Set([id, again.id]));
    const text = words(rows);
    for (const secret of ["Ruth", "Cohen", "mobile", "afternoons", "555", "Dana", "called", "Side door", "bell", "lasagne", "Thursday"]) expect(text).not.toContain(secret);
  });
});

describe("taking and closing", () => {
  it("the first taker wins; only the taker closes; the line they leave reaches the clergy on the person's page", async () => {
    const lead2 = await addActor(db, "lead2@example.test", "lead");
    const { id } = await refer(t.clergy);
    expect(await takeReferral(db, t.lead, id, NOW)).toEqual({ ok: true });
    expect(await takeReferral(db, lead2, id, at(1))).toEqual({ ok: false, reason: "already_taken" });
    expect(await takeReferral(db, t.clergy, id, at(1))).toEqual({ ok: false, reason: "already_taken" });
    // Pressing twice is harmless and keeps the first time.
    expect(await takeReferral(db, t.lead, id, at(2))).toEqual({ ok: true });
    expect((await listOpenReferrals(db, lead2))[0]).toMatchObject({ takenByName: "lead", takenAt: NOW, takenByMe: false, canTake: false });
    expect((await listOpenReferrals(db, t.lead))[0]).toMatchObject({ takenByMe: true, canTake: false });
    expect((await referralsForPerson(db, t.clergy, { sfContactId: CONTACT }))?.open).toMatchObject({ id, kind: "meal", consent: "yes", takenByName: "lead" });

    for (const other of [lead2, t.clergy, t.owner]) await expect(closeReferral(db, other, id, { as: "done" }, NOW)).rejects.toBeInstanceOf(AccessDenied);
    for (const bad of [{ as: "withdrawn" }, { as: "gone" }, { as: "done", outcomeLine: "o".repeat(201) }, { as: "done", outcomeLine: "one\ntwo" }]) await expect(closeReferral(db, t.lead, id, bad, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await closeReferral(db, t.lead, id, { as: "done", outcomeLine: "Brought lasagne on Thursday" }, at(3));
    expect(await listOpenReferrals(db, t.lead)).toEqual([]);
    for (const a of [t.clergy, t.clergy2, t.owner]) {
      expect(await referralsForPerson(db, a, { sfContactId: CONTACT })).toEqual({ open: null, closed: [{ id, kind: "meal", closedAs: "done", closedAt: at(3), outcomeLine: "Brought lasagne on Thursday", contactLine: CONTACT_LINE, alreadyInvolved: INVOLVED, note: NOTE }], olderClosed: 0 });
    }
    // Closed is closed: nothing more can be done to it.
    await expect(closeReferral(db, t.lead, id, { as: "declined" }, at(4))).rejects.toBeInstanceOf(NotFound);
    await expect(withdrawReferral(db, t.clergy, id, at(4))).rejects.toBeInstanceOf(NotFound);
    await expect(takeReferral(db, lead2, id, at(4))).rejects.toBeInstanceOf(NotFound);
  });

  it("\"They said no thank you\" closes it as declined, and clergy who took one may close it too", async () => {
    const { id } = await refer(t.clergy, { consent: "coordinator_asks" });
    await expect(closeReferral(db, t.lead, id, { as: "declined" }, NOW)).rejects.toBeInstanceOf(AccessDenied);
    await takeReferral(db, t.owner, id, NOW);
    await closeReferral(db, t.owner, id, { as: "declined" }, at(1));
    expect((await referralsForPerson(db, t.clergy, { sfContactId: CONTACT }))?.closed).toEqual([{ id, kind: "meal", closedAs: "declined", closedAt: at(1), outcomeLine: null, contactLine: CONTACT_LINE, alreadyInvolved: INVOLVED, note: NOTE }]);
    expect((await db.select().from(corpsReferrals))[0]).toMatchObject({ closedBy: t.owner.id, closedAs: "declined" });
  });

  it("a withdrawn referral leaves the lead's list at once, even after someone took it", async () => {
    const { id } = await refer(t.clergy);
    await takeReferral(db, t.lead, id, NOW);
    await withdrawReferral(db, t.clergy, id, at(1));
    expect(await listOpenReferrals(db, t.lead)).toEqual([]);
    await expect(closeReferral(db, t.lead, id, { as: "done" }, at(2))).rejects.toBeInstanceOf(NotFound);
    expect((await referralsForPerson(db, t.owner, { sfContactId: CONTACT }))?.closed).toMatchObject([{ closedAs: "withdrawn" }]);
  });
});

describe("the daily job: closed referrals are kept (Daniel, 2026-11-25: \"I want it all kept\")", () => {
  it("withdraws an open referral nobody took at 60 days, and deletes no closed referral after 90 days, a year or five", async () => {
    const { id } = await refer(t.clergy);
    const keep = await refer(t.clergy, { sfContactId: undefined, outsidePersonId: (await outside("Still Open")).id });
    await withdrawReferral(db, t.clergy, id, NOW);
    expect(await lapseReferrals(db, at(59))).toEqual({ lapsed: 0 });
    // An open referral nobody took is withdrawn at 60 days; what was written stays.
    // One a coordinator has taken and is working is never lapsed.
    const working = await refer(t.owner, { sfContactId: undefined, outsidePersonId: (await outside("Being Helped")).id });
    await takeReferral(db, t.lead, working.id, NOW);
    expect(await lapseReferrals(db, at(60))).toEqual({ lapsed: 1 });
    expect((await listOpenReferrals(db, t.lead)).map((r) => r.id)).toEqual([working.id]);
    await closeReferral(db, t.lead, working.id, { as: "done", outcomeLine: "Soup on Thursday" }, at(60));
    expect((await db.select().from(corpsReferrals).where(eq(corpsReferrals.id, keep.id)))[0]).toMatchObject({ closedAs: "withdrawn", closedBy: null, contactLine: CONTACT_LINE, alreadyInvolved: INVOLVED, note: NOTE });
    expect(await listOpenReferrals(db, t.lead)).toEqual([]);
    const task = DAILY_TASKS.find((x) => x.key === "corps_referral_lapse")!;
    for (const days of [90, 91, 365, 5 * 365, 10 * 365]) {
      expect(await task.run({ db, now: at(days), owners: new Set(), origin: null })).toEqual({ lapsed: 0 });
      expect((await db.select().from(corpsReferrals)).map((r) => r.id).sort()).toEqual([id, keep.id, working.id].sort());
    }
    // The outcome line the coordinator left is still there, and the person's page still shows the old referral.
    expect((await db.select().from(corpsReferrals).where(eq(corpsReferrals.id, working.id)))[0].outcomeLine).toBe("Soup on Thursday");
    expect((await referralsForPerson(db, t.clergy, { sfContactId: CONTACT }))?.closed.map((c) => c.id)).toEqual([id]);
  });

  it("a person's page shows the five most recent closed referrals, newest first, and counts the older ones", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const { id } = await refer(t.clergy);
      await withdrawReferral(db, t.clergy, id, at(i));
      ids.push(id);
    }
    const page = await referralsForPerson(db, t.clergy, { sfContactId: CONTACT });
    expect(page?.closed.map((c) => c.id)).toEqual(ids.slice(2).reverse());
    expect(page?.olderClosed).toBe(2);
  });

  it("runs in the daily job, before the reminders that must stay last, under a name that says what it does", () => {
    const keys = DAILY_TASKS.map((x) => x.key);
    expect(keys).toContain("corps_referral_lapse");
    expect(keys).not.toContain("corps_referral_purge");
    expect(keys.at(-1)).toBe("helper_reminders");
  });
});

describe("the rate limit", () => {
  it("one person may refer 30 times in an hour; a colleague is not held up, and the next hour is open again", async () => {
    for (let i = 0; i < REFERRALS_PER_HOUR; i++) await refer(t.clergy, { sfContactId: undefined, outsidePersonId: (await outside(`Person ${i}`)).id });
    const one = await outside("One Too Many");
    await expect(refer(t.clergy, { sfContactId: undefined, outsidePersonId: one.id })).rejects.toBeInstanceOf(TooMany);
    await expect(refer(t.clergy2, { sfContactId: undefined, outsidePersonId: one.id })).resolves.toMatchObject({ id: expect.any(String) });
    await expect(refer(t.clergy, {}, new Date(NOW.getTime() + 3_600_000))).resolves.toMatchObject({ id: expect.any(String) });
    expect(await db.select().from(corpsReferrals)).toHaveLength(REFERRALS_PER_HOUR + 2);
  });

  it("a refused form does not use up the hour", async () => {
    for (let i = 0; i < REFERRALS_PER_HOUR + 5; i++) await expect(refer(t.clergy, { kind: "nonsense" })).rejects.toBeInstanceOf(InvalidInput);
    await expect(refer(t.clergy)).resolves.toMatchObject({ id: expect.any(String) });
  });
});

describe("the connector", () => {
  const tool = TOOLS.find((x) => x.name === "volunteers_refer")!;
  const call = (actor: Actor, args: unknown) => callTool(tool, args, { db, sf: sf.sf, now: NOW, actor });

  it("clergy refer through volunteers_refer; the answer names nobody; everyone else is refused", async () => {
    const made = await call(t.clergy, { contactId: CONTACT, kind: "call", consent: "coordinator_asks", note: NOTE });
    expect(made.isError).toBe(false);
    expect(made.structuredContent).toEqual({ referred: true, kind: "call", consent: "coordinator_asks" });
    expect(words(made)).not.toContain("Ruth");
    expect((await listOpenReferrals(db, t.lead))[0]).toMatchObject({ name: "Ruth Cohen", kind: "call", consent: "coordinator_asks", mayShareAddress: false, note: NOTE });
    for (const a of [t.lead, t.staff, t.senior, t.carer]) expect(await call(a, { contactId: CONTACT, kind: "call", consent: "yes" })).toMatchObject({ isError: true, content: [{ text: "You do not have access to do that." }] });
    // No argument links a care item, names the person or skips the consent answer.
    for (const bad of [{ contactId: CONTACT, kind: "call", consent: "yes", careItemId: NOWHERE }, { contactId: CONTACT, kind: "call", consent: "yes", displayName: "X" }, { contactId: CONTACT, kind: "call" }, { kind: "call", consent: "yes" }]) expect((await call(t.owner, bad)).isError).toBe(true);
    expect(await db.select().from(corpsReferrals)).toHaveLength(1);
    expect(tool.description).toMatch(/add nothing from a care record of your own accord/);
  });
});

describe("stored rows", () => {
  it("the database refuses a row with two people, an unknown kind, or closed without a reason", async () => {
    const o = await outside("Sam Outside");
    const base = { displayName: "X", kind: "meal", consent: "yes", referredBy: t.clergy.id };
    await expect(db.insert(corpsReferrals).values({ ...base, sfContactId: CONTACT, outsidePersonId: o.id })).rejects.toThrow();
    await expect(db.insert(corpsReferrals).values({ ...base })).rejects.toThrow();
    await expect(db.insert(corpsReferrals).values({ ...base, sfContactId: CONTACT, kind: "surgery" })).rejects.toThrow();
    await expect(db.insert(corpsReferrals).values({ ...base, sfContactId: CONTACT, consent: "maybe" })).rejects.toThrow();
    await expect(db.insert(corpsReferrals).values({ ...base, sfContactId: CONTACT, closedAt: NOW })).rejects.toThrow();
    const { id } = await refer(t.clergy);
    await expect(db.update(corpsReferrals).set({ closedAs: "done" }).where(eq(corpsReferrals.id, id))).rejects.toThrow();
  });
});

describe("the review's fixes", () => {
  it("who referred is for the coordinator and the referrer: another rabbi, the owner included, sees only that a rabbi did", async () => {
    await ruthItem({ restricted: true, restrictedShowsCarer: false, accessUserIds: [] });
    await refer(t.clergy);
    expect((await listOpenReferrals(db, t.lead))[0].referredByName).toBe("clergy");
    expect((await listOpenReferrals(db, t.clergy))[0].referredByName).toBe("clergy");
    for (const other of [t.clergy2, t.owner]) {
      const seen = await listOpenReferrals(db, other);
      expect(seen[0].referredByName).toBe("A rabbi");
      expect(JSON.stringify(seen)).not.toContain(t.clergy.id);
      expect(JSON.stringify(await referralsForPerson(db, other, { sfContactId: CONTACT }))).not.toMatch(/clergy@|"clergy"/);
    }
  });

  it("nothing written is erased when a referral closes: the rabbis read all of it on the person's page, and the lead no longer has it", async () => {
    const a = await refer(t.clergy);
    await takeReferral(db, t.lead, a.id, NOW);
    await closeReferral(db, t.lead, a.id, { as: "done", outcomeLine: "Soup on Thursday" }, NOW);
    const b = await refer(t.clergy, {}, at(1));
    await withdrawReferral(db, t.clergy, b.id, at(1));
    for (const who of [t.clergy, t.clergy2, t.owner]) {
      const closed = (await referralsForPerson(db, who, { sfContactId: CONTACT }))!.closed;
      expect(closed).toHaveLength(2);
      for (const c of closed) expect(c).toMatchObject({ contactLine: CONTACT_LINE, alreadyInvolved: INVOLVED, note: NOTE });
      expect(closed.map((c) => c.outcomeLine).sort()).toEqual(["Soup on Thursday", null].sort());
    }
    expect(await listOpenReferrals(db, t.lead)).toEqual([]);
    expect(await referralsForPerson(db, t.lead, { sfContactId: CONTACT })).toBeNull();
  });

  it("the rabbi decides what the coordinator needs to know: no word is refused in a line", async () => {
    const { id } = await refer(t.clergy, { note: "Home from the hospital on Friday after chemo; tires easily", alreadyInvolved: "Her daughter is in town until the divorce hearing" });
    expect((await listOpenReferrals(db, t.lead))[0]).toMatchObject({ id, note: "Home from the hospital on Friday after chemo; tires easily" });
  });

  it("refuses the line separators and invisible characters the house refuses everywhere", async () => {
    for (const bad of ["two\u2028lines", "next\u0085line", "zero\u200bwidth", "word\u2060joiner", "byte\ufefforder"]) await expect(refer(t.clergy, { note: bad })).rejects.toBeInstanceOf(InvalidInput);
    expect(await db.select().from(corpsReferrals)).toHaveLength(0);
  });

  it("a consent change on a referral that closed in the meantime is not found and leaves no audit row", async () => {
    const { id } = await refer(t.clergy, { consent: "rabbi_asks" });
    await withdrawReferral(db, t.clergy, id, NOW);
    await expect(setReferralConsent(db, t.clergy, id, "yes")).rejects.toBeInstanceOf(NotFound);
    expect((await db.select().from(auditLog)).filter((r) => r.action === "corps_referral.consent")).toEqual([]);
  });
});
