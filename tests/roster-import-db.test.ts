/**
 * The roster import against a real (in-memory) database: what it writes, that a second run changes nothing, that it
 * never overwrites what a person edited, never links on a guess and never brings back someone who left, the secret
 * check, who may read the old sheet's history, that members who have not volunteered are never asked, the owner's
 * email switch, and which email an imported member gets. Invented data only; nothing reaches the network.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDenied, ROLES, canManageRoster, canReadImportHistory, canReleaseImportedEmails } from "@/server/access/policy";
import { InvalidInput } from "@/server/care/validate";
import { auditLog, corpsMembers, emailLog, notificationLog } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { runHelperReminders } from "@/server/email/reminders";
import { sendEmail } from "@/server/email/send";
import { DAILY_TASKS, runDailyJob } from "@/server/daily/run";
import { runRosterImport } from "@/server/volunteers/import/run";
import { SecretUnverified } from "@/server/volunteers/import/secret-check";
import { submitJoin } from "@/server/volunteers/join";
import { createVolunteerTask } from "@/server/volunteers/organiser";
import { claimTask } from "@/server/volunteers/public";
import { countReleasable, releaseImportedEmails } from "@/server/volunteers/release-emails";
import { ImportBusy, takeImportLock } from "@/server/volunteers/import/lock";
import { stoppedAmong } from "@/server/volunteers/stopped";
import { addMember, emailAsk, listAskCandidates, listPastHelperCandidates, listRoster, markMemberLeft, prepareAsk, rosterUpkeep, updateMember } from "@/server/volunteers/roster";
import { listVisitorChoices } from "@/server/volunteers/visiting";
import { reporters, team, testDb } from "./support/db";
import { meta, NOW } from "./support/meals";
import { SHEET_HEADER, sampleSheet, sheetRow } from "./support/roster-sheet";

const ORIGIN = "https://care.example.test";
const ON = { RESEND_API_KEY: "re_test_key", CARE_EMAIL: "on" };
type Sent = { to: string; text: string; headers?: Record<string, string> };
let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
let sent: Sent[];
const fakeFetch = () =>
  vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { to: string[]; text: string; headers?: Record<string, string> };
    sent.push({ to: body.to[0], text: body.text, headers: body.headers });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
const deps = (now = NOW) => ({ fetch: fakeFetch(), now, env: ON });
const mail = (to: string, kind: string, ref = kind) => sendEmail(db, { to, subject: "Hi", text: "Hello.", kind, ref }, deps());

const rows = () => db.select().from(corpsMembers).orderBy(corpsMembers.firstName);
const byFirst = async (first: string) => (await rows()).find((r) => r.firstName === first)!;
const apply = (sheet: unknown = sampleSheet(), now = NOW) => runRosterImport(db, sheet, { apply: true, now });

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-for-roster-import");
  vi.stubEnv("BETTER_AUTH_URL", ORIGIN);
  sent = [];
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("applying the import", () => {
  it("adds everyone as imported, not yet asked: held from email, no consent, with sources, history and details", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const s = await apply();
    expect(s.outcome).toMatchObject({ new: 10, update: 0, unchanged: 0, skipped_left: 0, skipped_ambiguous: 0 });
    const all = await rows();
    expect(all).toHaveLength(10);
    for (const m of all) expect(m).toMatchObject({ source: "import", status: "active", emailsHeld: true, introPending: false, consentAt: null, importedAt: NOW, stopTokenHash: null, emailsReleasedAt: null });
    const rina = await byFirst("Rina");
    expect(rina).toMatchObject({ lastName: "Stein", email: "rina.stein@example.test", emailKey: "rina.stein@example.test", mobile: "314-555-0168", mobileKey: "3145550168", area: "63130", howOften: "monthly", importSources: ["MC Volunteers", "Volunteer Form Responses"], importHistory: "meal for Ploni Almoni 3/22", joinedOn: "2023-01-05", notVolunteered: false });
    expect(rina.importFingerprints).toHaveLength(2);
    expect(rina.canDo.sort()).toEqual(["baking", "meals", "pet_care", "rides", "visits"]);
    // Hana and Eli share a home phone: it is Hana's on her row and kept as Eli's other phone. Eli has not volunteered.
    expect(await byFirst("Hana")).toMatchObject({ mobileKey: "3145550177", notVolunteered: false });
    expect(await byFirst("Eli")).toMatchObject({ mobile: null, mobileKey: null, notVolunteered: true, importDetails: { otherPhones: ["314-555-0177"] } });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(await db.select().from(emailLog)).toEqual([]);
    expect(await db.select().from(notificationLog)).toEqual([]);
  });

  it("writes one audit row of counts, last: no name, contact, tab words or history", async () => {
    await apply();
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "corps_member.import"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: null, subjectType: "corps_import", detail: { by: "system", counts: { new: 10, merged: 10, sharedContacts: 1 } } });
    expect(JSON.stringify(audit)).not.toMatch(/Rina|Stein|example\.test|Ploni|Almonit|MC Volunteers|555/);
  });

  it("a dry run writes nothing", async () => {
    const s = await runRosterImport(db, sampleSheet(), { now: NOW });
    expect(s).toMatchObject({ applied: false, outcome: { new: 10 } });
    expect(await rows()).toEqual([]);
  });

  it("runs through a batch runner, as the script does with Neon, the audit row in its own last batch", async () => {
    const batches: number[] = [];
    await runRosterImport(db, sampleSheet(), {
      apply: true,
      now: NOW,
      run: async (qs) => {
        batches.push(qs.length);
        for (const q of qs) await q;
      },
    });
    expect(batches).toEqual([10, 1]);
  });

  it("cuts values to the app's limits and keeps the whole in the notes; strips unsafe characters", async () => {
    const long = `${"Bartholomew".repeat(7)}`;
    await apply({ tabs: { "MC Volunteers": [SHEET_HEADER, sheetRow({ first: `Yo‮av`, last: long, phone1: "314-555-0190" })] } });
    const [m] = await rows();
    expect(m.firstName).toBe("Yoav");
    expect(m.lastName).toHaveLength(60);
    expect(m.importDetails?.notes).toEqual([`Last name in full: ${long}`]);
  });
});

describe("running it again", () => {
  it("adds nobody twice and changes nothing when the sheet is the same", async () => {
    await apply();
    const before = await rows();
    const again = await apply(sampleSheet(), new Date(NOW.getTime() + 86_400_000));
    expect(again.outcome).toMatchObject({ new: 0, update: 0, unchanged: 10 });
    expect(await rows()).toEqual(before);
  });

  it("rows with no contact and no first name are found again by their fingerprint, and the name is not a placeholder", async () => {
    const sheet = { tabs: { "MC Volunteers": [SHEET_HEADER, sheetRow({ first: "", last: "Gold", offers: { Drive: "X" } }), sheetRow({ first: "", last: "Gold", zip: "63130" })] } };
    expect((await apply(sheet)).outcome).toMatchObject({ new: 2 });
    expect((await rows()).map((r) => r.firstName)).toEqual(["", ""]);
    expect((await apply(sheet)).outcome).toMatchObject({ new: 0, unchanged: 2 });
    expect(await rows()).toHaveLength(2);
  });

  it("brings an untouched imported row up to date, and keeps every source and all history", async () => {
    await apply();
    const sheet = sampleSheet();
    sheet.tabs["MC Volunteers"][3] = sheetRow({ first: "Noa", last: "Levi", phone1: "314-555-0150", offers: { "Make soup": "X" }, responded: "soup for Almonit 1/2" });
    const s = await apply(sheet);
    expect(s.outcome).toMatchObject({ new: 0, update: 1, unchanged: 9 });
    const noa = await byFirst("Noa");
    expect(noa.canDo).toEqual(["soup"]);
    expect(noa.importSources).toEqual(["MC Volunteers", "Special situations"]);
    expect(noa.importHistory!.split("\n")).toEqual(["Dog walking for Ploni Almoni Feb 2023", "walked Tuesdays", "soup for Almonit 1/2"]);
    expect(noa.importFingerprints).toHaveLength(3);
  });

  it("an update lands only if the row still has the import_hash it was read with", async () => {
    await apply();
    const sheet = sampleSheet();
    sheet.tabs["MC Volunteers"][3] = sheetRow({ first: "Noa", last: "Levi", phone1: "314-555-0150", offers: { "Make soup": "X" } });
    const noa = await byFirst("Noa");
    await runRosterImport(db, sheet, {
      apply: true,
      now: NOW,
      run: async (qs) => {
        // A person edits Noa after the plan was made and before it is written.
        await db.update(corpsMembers).set({ importHash: "edited" }).where(eq(corpsMembers.id, noa.id));
        for (const q of qs) await q;
      },
    });
    expect((await byFirst("Noa")).canDo).toEqual(["baking"]);
  });

  it("never overwrites what a person edited in the app, and never turns email back off", async () => {
    await apply();
    const rina = await byFirst("Rina");
    await updateMember(db, t.lead, rina.id, { firstName: "Rina", lastName: "Stein-Cohen", email: "rina.stein@example.test", mobile: "314-555-0168", canDo: ["calls"], availability: "Sundays" }, NOW);
    await db.update(corpsMembers).set({ emailsHeld: false }).where(eq(corpsMembers.id, (await byFirst("Gil")).id));
    const sheet = sampleSheet();
    sheet.tabs["Volunteer Form Responses"][1][3] = "Steyn";
    const s = await apply(sheet);
    expect(s.outcome.kept_edited).toBe(1);
    expect(await byFirst("Rina")).toMatchObject({ lastName: "Stein-Cohen", canDo: ["calls"], availability: "Sundays" });
    expect(await byFirst("Gil")).toMatchObject({ emailsHeld: false });
  });

  it("someone who left (their row is kept) is always matched and skipped: never re-added or made active", async () => {
    const gil = await addMember(db, t.lead, { firstName: "Gil", lastName: "Paz", email: "gil@example.test", mobile: null, canDo: ["visits"] }, NOW);
    await markMemberLeft(db, t.lead, gil.id, NOW);
    // A loose match to them (same contact, another spelling) is skipped as left too.
    const tal = await addMember(db, t.lead, { firstName: "Talia", lastName: "Ron", email: "tal@example.test", mobile: null, canDo: [] }, NOW);
    await markMemberLeft(db, t.lead, tal.id, NOW);
    const s = await apply();
    expect(s.outcome).toMatchObject({ skipped_left: 2, new: 8 });
    await rosterUpkeep(db, new Date(NOW.getTime() + 400 * 86_400_000));
    expect((await apply()).outcome.skipped_left).toBe(2);
    const left = await db.select().from(corpsMembers).where(eq(corpsMembers.status, "left"));
    expect(left.map((m) => [m.firstName, m.importSources])).toEqual([
      ["Gil", null],
      ["Talia", null],
    ]);
    expect((await rows()).filter((r) => r.lastName === "Paz")).toHaveLength(1);
  });

  it("a member who joined another way is linked only on an exact match; a loose match is skipped, listed and left alone", async () => {
    const dov = await addMember(db, t.lead, { firstName: "Dov", lastName: "Katz", email: "dov@example.test", mobile: null, canDo: ["visits"] }, NOW);
    // Same name as the sheet's Maya Ron, a different contact: a name-only match.
    const maya = await addMember(db, t.lead, { firstName: "Maya", lastName: "Ron", email: "maya.other@example.test", mobile: null, canDo: ["calls"] }, NOW);
    // Rina's email under another first name: a contact match that is not exact.
    const rena = await addMember(db, t.lead, { firstName: "Rena", lastName: "Stein", email: "rina.stein@example.test", mobile: null, canDo: [] }, NOW);
    const s = await apply();
    expect(s.outcome).toMatchObject({ linked: 1, skipped_ambiguous: 1, skipped_contact_clash: 1, new: 7 });
    expect(s.ambiguousRows).toEqual(expect.arrayContaining([{ tab: "Other volunteers", row: 3 }, { tab: "MC Volunteers", row: 2 }, { tab: "Volunteer Form Responses", row: 2 }]));
    const [d] = await db.select().from(corpsMembers).where(eq(corpsMembers.id, dov.id));
    expect(d).toMatchObject({ source: "coordinator", canDo: ["visits"], emailsHeld: false, importedAt: null, importSources: ["Volunteer Form Responses"], consentAt: expect.any(Date) });
    for (const id of [maya.id, rena.id]) {
      const [m] = await db.select().from(corpsMembers).where(eq(corpsMembers.id, id));
      expect(m).toMatchObject({ importSources: null, importHistory: null, importFingerprints: null, emailsHeld: false });
    }
  });
});

describe("the secret check", () => {
  it("passes when a stored stopped contact matches a roster contact under this secret", async () => {
    const gil = await addMember(db, t.lead, { firstName: "Gil", lastName: "Paz", email: "gil@example.test", mobile: null, canDo: [] }, NOW);
    await markMemberLeft(db, t.lead, gil.id, NOW);
    await expect(apply()).resolves.toMatchObject({ applied: true });
  });

  it("a wrong secret stops the run before anything is written", async () => {
    const gil = await addMember(db, t.lead, { firstName: "Gil", lastName: "Paz", email: "gil@example.test", mobile: null, canDo: [] }, NOW);
    await markMemberLeft(db, t.lead, gil.id, NOW);
    vi.stubEnv("BETTER_AUTH_SECRET", "not-the-apps-secret");
    const err = await runRosterImport(db, sampleSheet(), { apply: true, now: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretUnverified);
    expect(String((err as Error).message)).not.toContain("not-the-apps-secret");
    expect(await rows()).toHaveLength(1);
    // A dry run with a database checks it too.
    await expect(runRosterImport(db, sampleSheet(), { now: NOW })).rejects.toBeInstanceOf(SecretUnverified);
  });

  it("stopped contacts with no roster contact left to check against: refuses", async () => {
    const gil = await addMember(db, t.lead, { firstName: "Gil", lastName: "Paz", email: "gil@example.test", mobile: null, canDo: [] }, NOW);
    await markMemberLeft(db, t.lead, gil.id, NOW);
    await db.delete(corpsMembers);
    await expect(apply()).rejects.toBeInstanceOf(SecretUnverified);
  });
});

describe("who reads the old sheet's record", () => {
  it("only the lead and clergy level (owner, clergy); staff, caregivers and senior staff never", () => {
    for (const role of ROLES) expect(canReadImportHistory({ role })).toBe(role === "owner" || role === "clergy" || role === "lead");
    for (const role of ROLES) if (canManageRoster({ role })) expect(canReadImportHistory({ role })).toBe(true);
  });

  it("the roster gives the lead, clergy and owner the history and sources; everyone else gets no roster at all", async () => {
    await apply();
    for (const who of [t.lead, t.clergy, t.owner]) {
      const rina = (await listRoster(db, who, {}, NOW)).find((m) => m.firstName === "Rina")!;
      expect(rina).toMatchObject({ emailsHeld: true, source: "import", imported: { sources: ["MC Volunteers", "Volunteer Form Responses"], history: "meal for Ploni Almoni 3/22" } });
    }
    for (const who of [t.staff, t.carer, t.senior]) await expect(listRoster(db, who, {}, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("the server leaves the record out for anyone the history rule does not allow, even if the roster rule ever did", async () => {
    await apply();
    const policy = await import("@/server/access/policy");
    const spy = vi.spyOn(policy, "canReadImportHistory").mockReturnValue(false);
    try {
      const all = await listRoster(db, t.lead, {}, NOW);
      expect(all.every((m) => m.imported === null)).toBe(true);
      expect(JSON.stringify(all)).not.toMatch(/Ploni|Almonit|MC Volunteers/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("members from IL members who have not volunteered", () => {
  it("are on the roster, but never in an ask, a text link, a visitor choice or a count of who can be asked", async () => {
    await apply();
    const eli = await byFirst("Eli");
    const hana = await byFirst("Hana");
    expect(eli.canDo).toEqual([]);
    expect((await listRoster(db, t.lead, {}, NOW)).find((m) => m.id === eli.id)).toMatchObject({ notVolunteered: true });
    const task = await createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date: "2026-12-05" }, NOW);
    const ids = (await listAskCandidates(db, t.lead, { taskId: task.id }, NOW)).map((c) => c.id);
    expect(ids).not.toContain(eli.id);
    // Hana is starred as a volunteer on that tab: she can be asked.
    expect(ids).toContain(hana.id);
    await expect(prepareAsk(db, t.lead, { taskId: task.id }, [eli.id], ORIGIN, NOW)).rejects.toBeInstanceOf(InvalidInput);
    const prepared = await prepareAsk(db, t.lead, { taskId: task.id }, [eli.id, hana.id], ORIGIN, NOW);
    expect(prepared.count).toBe(1);
    expect((await listVisitorChoices(db, t.lead, NOW)).map((c) => c.id)).not.toContain(eli.id);
  });
});

describe("an imported member and email, while held", () => {
  it("asks: emailAsk sends none and says why; the ask list and 'get their contacts' leave their email out", async () => {
    await apply();
    const [rina, gil] = [await byFirst("Rina"), await byFirst("Gil")];
    const task = await createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date: "2026-12-05" }, NOW);
    expect(await emailAsk(db, t.lead, { taskId: task.id }, [rina.id, gil.id], ORIGIN, NOW, deps())).toEqual({ configured: true, sent: 0, noEmail: 0, notSent: 0, held: 2 });
    expect(sent).toEqual([]);
    expect((await listAskCandidates(db, t.lead, { taskId: task.id }, NOW)).find((c) => c.id === rina.id)).toMatchObject({ hasEmail: false, emailsHeld: true, hasMobile: true });
    const prepared = await prepareAsk(db, t.lead, { taskId: task.id }, [rina.id, gil.id], ORIGIN, NOW);
    expect(prepared.emails).toEqual([]);
    expect(prepared.mobiles.length).toBe(2);
  });

  it("mail the roster starts is held; what they asked for themselves goes; the morning summary is never affected", async () => {
    await apply();
    for (const kind of ["roster_ask", "join_welcome", "anything_new"]) expect(await mail("rina.stein@example.test", kind)).toBe("held");
    expect(sent).toEqual([]);
    for (const kind of ["meal_signup", "volunteer_signup", "reminder_meal", "reminder_help", "morning_summary"]) expect(await mail("rina.stein@example.test", kind)).toBe("sent");
    // Held people get no intro: that comes only after the owner turns their email on.
    expect(sent.every((s) => !s.text.includes("Mitzvah Corps now asks"))).toBe(true);
  });

  it("welcome: using the join form with their contact sends no welcome and changes nothing but a flag", async () => {
    await apply();
    const rina = await byFirst("Rina");
    const onNew = vi.fn();
    await submitJoin(db, { firstName: "Rina", lastName: "Stein", contact: "rina.stein@example.test", canDo: ["visits"], consent: true }, meta(), NOW, { onNew });
    expect(onNew).not.toHaveBeenCalled();
    expect(await byFirst("Rina")).toMatchObject({ id: rina.id, emailsHeld: true, askedToJoinAgainAt: NOW });
  });

  it("a task they claimed themselves still gets its day-before reminder, from the daily job too", async () => {
    await apply();
    const task = await createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date: "2026-12-03" }, NOW);
    expect((await claimTask(db, task.publicToken, { firstName: "Gil", lastName: "Paz", contact: "gil@example.test", note: null, mayAskAgain: false }, meta(), NOW)).ok).toBe(true);
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("CARE_EMAIL", "on");
    vi.stubGlobal("fetch", fakeFetch());
    const at = new Date("2026-12-02T12:00:00Z");
    const results = await runDailyJob({ db, now: at, owners: new Set(), origin: ORIGIN, packet: null }, DAILY_TASKS);
    expect(results.find((r) => r.task === "helper_reminders")?.counts).toMatchObject({ sent: 1, held: 0 });
    expect(sent.map((s) => s.to)).toContain("gil@example.test");
    expect(await runHelperReminders(db, at, deps(at))).toMatchObject({ duplicate: 1 });
    // Nothing else in the daily job wrote to any imported member.
    expect((await rows()).every((m) => m.emailsHeld && m.status === "active")).toBe(true);
  });
});

describe("the owner's switch: email on for everyone imported", () => {
  it("is the owner's alone: not the lead, not clergy, not anyone else", async () => {
    for (const role of ROLES) expect(canReleaseImportedEmails({ role })).toBe(role === "owner");
    await apply();
    const { token } = await countReleasable(db, t.owner);
    for (const who of [t.lead, t.clergy, t.staff, t.carer, t.senior]) {
      await expect(countReleasable(db, who)).rejects.toBeInstanceOf(AccessDenied);
      await expect(releaseImportedEmails(db, who, token)).rejects.toBeInstanceOf(AccessDenied);
    }
  });

  it("covers imported people with an email who did not leave and have volunteered; checks the very set shown; sends nothing", async () => {
    const sheet = sampleSheet();
    sheet.tabs["IL members"][3] = ["63124", "Eli", "Bar", "9 Oak Ave", "Ladue", "314-555-0177", "", "eli@example.test"];
    await apply(sheet);
    await markMemberLeft(db, t.lead, (await byFirst("Tal")).id, NOW);
    // Rina, Avi (the Drivers row), Dov, Gil, Hana: not Tal (left), Eli (has not volunteered), nor those with no email.
    const shown = await countReleasable(db, t.owner);
    expect(shown.count).toBe(5);
    // The same count with a different set (one left, another came in) is refused: the owner must look again.
    await markMemberLeft(db, t.lead, (await byFirst("Gil")).id, NOW);
    await db.update(corpsMembers).set({ notVolunteered: false }).where(eq(corpsMembers.id, (await byFirst("Eli")).id));
    expect((await countReleasable(db, t.owner)).count).toBe(5);
    await expect(releaseImportedEmails(db, t.owner, shown.token, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(releaseImportedEmails(db, t.owner, 5, NOW)).rejects.toBeInstanceOf(InvalidInput);
    expect((await rows()).every((m) => m.emailsHeld)).toBe(true);
    const now = await countReleasable(db, t.owner);
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    expect(await releaseImportedEmails(db, t.owner, now.token, NOW)).toBe(5);
    expect(globalFetch).not.toHaveBeenCalled();
    const released = (await rows()).filter((m) => !m.emailsHeld);
    expect(released.map((m) => m.firstName).sort()).toEqual(["Avi", "Dov", "Eli", "Hana", "Rina"]);
    for (const m of released) expect(m).toMatchObject({ introPending: true, emailsReleasedAt: NOW, consentAt: null });
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "corps_member.release_emails"));
    expect(audit).toHaveLength(1);
    // The subject is the owner who pressed it, not one of the members.
    expect(audit[0]).toMatchObject({ actorUserId: t.owner.id, subjectType: "corps_import", subjectId: t.owner.id, detail: { counts: { released: 5 } } });
    expect(JSON.stringify(audit[0].detail)).not.toMatch(/example\.test|Rina|Gil/);
    expect((await countReleasable(db, t.owner)).count).toBe(0);
  });

  it("their first email of any kind says what this is and carries the stop link; later ones do not", async () => {
    await apply();
    await releaseImportedEmails(db, t.owner, (await countReleasable(db, t.owner)).token, NOW);
    const rina = await byFirst("Rina");
    expect(await mail("rina.stein@example.test", "meal_signup", "a")).toBe("sent");
    expect(sent[0].text.startsWith("Central Reform Congregation's Mitzvah Corps now asks for help through this app, CRC Care")).toBe(true);
    expect(sent[0].text).toContain(`${ORIGIN}/join/stop/s/${rina.id}.`);
    expect(sent[0].headers?.["List-Unsubscribe"]).toContain(`/join/stop/s/${rina.id}.`);
    expect(await byFirst("Rina")).toMatchObject({ introPending: false });
    expect(await mail("rina.stein@example.test", "roster_ask", "b")).toBe("sent");
    expect(sent[1].text).not.toContain("Mitzvah Corps now asks");
  });

  it("two emails at the same moment: only one carries the intro; one that fails gives it back", async () => {
    await apply();
    await releaseImportedEmails(db, t.owner, (await countReleasable(db, t.owner)).token, NOW);
    expect(await Promise.all([mail("gil@example.test", "roster_ask", "x"), mail("gil@example.test", "volunteer_signup", "y")])).toEqual(["sent", "sent"]);
    expect(sent.filter((m) => m.text.includes("Mitzvah Corps now asks"))).toHaveLength(1);
    const failing = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    expect(await sendEmail(db, { to: "dov@example.test", subject: "Hi", text: "Hello.", kind: "roster_ask", ref: "f" }, { fetch: failing, now: NOW, env: ON })).toBe("failed");
    expect(await byFirst("Dov")).toMatchObject({ introPending: true });
  });
});

describe("stopping covers every contact the sheet gave for a person", () => {
  async function withSecondEmail() {
    const sheet = sampleSheet();
    // Dov gives a second address on another row: the same person by phone and first name.
    sheet.tabs["Other volunteers"].push(["63110", "Dov", "Katz", "", "", "314-555-0199", "", "dov.work@example.test"]);
    await apply(sheet);
    const dov = await byFirst("Dov");
    expect(dov.importDetails?.otherEmails).toEqual(["dov.work@example.test"]);
    return dov;
  }

  it("someone who stops is not offered as a past helper through their second email", async () => {
    const dov = await withSecondEmail();
    const task = await createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth", date: "2026-11-25" }, new Date("2026-11-20T18:00:00Z"));
    const r = await claimTask(db, task.publicToken, { firstName: "Dov", lastName: "Katz", contact: "dov.work@example.test", note: null, mayAskAgain: true }, meta(), new Date("2026-11-20T18:00:00Z"));
    expect(r.ok).toBe(true);
    // On the roster with that address as his other contact: not offered even before he stops.
    expect((await listPastHelperCandidates(db, t.lead, NOW)).map((c) => c.key)).not.toContain("dov.work@example.test");
    await markMemberLeft(db, t.lead, dov.id, NOW);
    expect(await stoppedAmong(db, ["dov.work@example.test", "3145550199"])).toEqual(new Set(["dov.work@example.test", "3145550199"]));
    expect((await listPastHelperCandidates(db, t.lead, NOW)).map((c) => c.key)).not.toContain("dov.work@example.test");
  });

  it("the join form with the second email flags the existing row instead of making a new member", async () => {
    const dov = await withSecondEmail();
    await submitJoin(db, { firstName: "Dov", lastName: "Katz", contact: "Dov.Work@example.test", canDo: ["visits"], consent: true }, meta(), NOW);
    expect((await rows()).filter((m) => m.lastName === "Katz")).toHaveLength(1);
    expect(await byFirst("Dov")).toMatchObject({ id: dov.id, askedToJoinAgainAt: NOW, status: "active" });
  });
});

describe("two runs at once", () => {
  it("a second --apply while one holds the lock is refused and writes nothing; the lock is released at the end", async () => {
    await takeImportLock(db, NOW);
    await expect(apply(sampleSheet(), new Date(NOW.getTime() + 5 * 60_000))).rejects.toBeInstanceOf(ImportBusy);
    expect(await rows()).toEqual([]);
    // A dry run does not need the lock.
    await expect(runRosterImport(db, sampleSheet(), { now: NOW })).resolves.toMatchObject({ applied: false });
    // A lock older than its time is taken over (a run that died), and released when the run ends.
    await expect(apply(sampleSheet(), new Date(NOW.getTime() + 20 * 60_000))).resolves.toMatchObject({ applied: true });
    await expect(apply(sampleSheet(), new Date(NOW.getTime() + 21 * 60_000))).resolves.toMatchObject({ outcome: { unchanged: 10 } });
  });
});
