import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDenied, canManageRoster } from "@/server/access/policy";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { auditLog, corpsAsks, corpsMembers, corpsStoppedContacts, mealSignups, mealRateLimits, volunteerClaims } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { tokenHash } from "@/server/meals/tokens";
import { JOIN_LIMITS, stopAsking, stopLinkWorks, submitJoin } from "@/server/volunteers/join";
import { notifyMembers } from "@/server/volunteers/notify";
import { createVolunteerSheet, createVolunteerTask } from "@/server/volunteers/organiser";
import { claimTask } from "@/server/volunteers/public";
import { acceptAllPending, acceptMember, addFromPastHelper, addMember, listAskCandidates, listPastHelperCandidates, listRoster, makeStopLink, markMemberLeft, pauseMember, prepareAsk, reactivateMember, rosterUpkeep, updateMember } from "@/server/volunteers/roster";
import { JOIN_REFUSED } from "@/lib/roster-wording";
import { refCookie } from "@/lib/vol-cookie";
import { ASK_LINK_CAP, askBody, mailtoLinks, smsLinks } from "@/lib/ask-links";
import { reporters, team, testDb } from "./support/db";
import { livePage, meta, NOW } from "./support/meals";
import { signUp } from "./support/corps";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const form = (over: Record<string, unknown> = {}) => ({ firstName: "Rina", lastName: "Stein", contact: "Rina.Stein@Example.test", canDo: ["visits", "calls"], availability: "Weekday mornings", consent: true, ...over });
const member = (over: Record<string, unknown> = {}) => ({ firstName: "Avi", lastName: "Mor", email: "avi@example.test", mobile: null, canDo: ["visits"], ...over });

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-corps-roster";
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});

describe("the public join form", () => {
  it("makes one PENDING member, stores only a hash of the stop link, and answers the same every time", async () => {
    const first = await submitJoin(db, form(), meta(), NOW);
    const again = await submitJoin(db, form({ firstName: "Rina B", canDo: ["rides"] }), meta(), NOW);
    expect(first).toEqual({ ok: true });
    expect(again).toEqual(first);
    const rows = await db.select().from(corpsMembers);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstName: "Rina", canDo: ["visits", "calls"], emailKey: "rina.stein@example.test", source: "form", status: "pending", askedToJoinAgainAt: expect.any(Date) });
    expect(rows[0].stopTokenHash).toMatch(/^[\w-]{43}$/);
    expect(rows[0].consentAt).toEqual(NOW);
  });

  it("a submission for a contact that exists changes NOTHING on that member but a timestamp, whatever their state", async () => {
    const m = await addMember(db, t.lead, member({ firstName: "Avi", canDo: ["visits"], availability: "Sundays" }), NOW);
    await pauseMember(db, t.lead, m.id, "2026-12-20", NOW);
    const [before] = await db.select().from(corpsMembers);
    const r = await submitJoin(db, form({ contact: "AVI@example.test", firstName: "Someone Else", lastName: "Else", canDo: ["rides"], availability: "Never" }), meta(), at(1));
    expect(r).toEqual({ ok: true });
    const [after] = await db.select().from(corpsMembers);
    expect({ ...after, askedToJoinAgainAt: null, updatedAt: before.updatedAt }).toEqual({ ...before, askedToJoinAgainAt: null, updatedAt: before.updatedAt });
    expect(after.askedToJoinAgainAt).toEqual(at(1));
    expect(after).toMatchObject({ firstName: "Avi", status: "paused", pausedUntil: "2026-12-20", consentAt: before.consentAt });
    expect(await db.select().from(corpsMembers)).toHaveLength(1);
  });

  it("recognises the same person by a mobile number written differently, and a left member who joins again stays left until a coordinator confirms", async () => {
    const m = await addMember(db, t.lead, member({ email: null, mobile: "(314) 555-0101" }), NOW);
    await submitJoin(db, form({ contact: "+1 314-555-0101" }), meta(), NOW);
    expect(await db.select().from(corpsMembers)).toHaveLength(1);
    const { token } = await makeStopLink(db, t.lead, m.id, true);
    await stopAsking(db, token, meta(), at(1));
    await submitJoin(db, form({ contact: "3145550101" }), meta(), at(2));
    const [row] = await db.select().from(corpsMembers);
    expect(row).toMatchObject({ status: "left", stoppedBy: "self", leftAt: at(1) });
    expect(row.askedToJoinAgainAt).toEqual(at(2));
    // Not by the coordinator alone, and not without the person having asked.
    await expect(reactivateMember(db, t.lead, m.id)).rejects.toBeInstanceOf(InvalidInput);
    await expect(reactivateMember(db, t.lead, m.id, { confirmed: false })).rejects.toBeInstanceOf(InvalidInput);
    expect((await db.select().from(corpsMembers))[0].status).toBe("left");
    await reactivateMember(db, t.lead, m.id, { confirmed: true });
    expect((await db.select().from(corpsMembers))[0]).toMatchObject({ status: "active", stoppedBy: null, leftAt: null, askedToJoinAgainAt: null });
  });

  it("a person who stopped and never asked again cannot be brought back even with a confirmation; one a coordinator took off can be", async () => {
    const a = await addMember(db, t.lead, member(), NOW);
    const b = await addMember(db, t.lead, member({ email: "b@example.test" }), NOW);
    await stopAsking(db, (await makeStopLink(db, t.lead, a.id, true)).token, meta(), NOW);
    await expect(reactivateMember(db, t.lead, a.id, { confirmed: true })).rejects.toBeInstanceOf(InvalidInput);
    await markMemberLeft(db, t.lead, b.id, NOW);
    await reactivateMember(db, t.lead, b.id);
    expect((await db.select().from(corpsMembers).where(eq(corpsMembers.id, b.id)))[0].status).toBe("active");
  });

  it("refuses a form without consent or without a usable contact, and names only the fields", async () => {
    expect(await submitJoin(db, form({ consent: false }), meta(), NOW)).toMatchObject({ ok: false, reason: "invalid", fields: ["consent"] });
    expect(await submitJoin(db, form({ contact: "not a contact" }), meta(), NOW)).toMatchObject({ ok: false, fields: ["contact"] });
    expect(await db.select().from(corpsMembers)).toHaveLength(0);
  });

  it("bot controls: a filled honeypot or a too-fast form looks like success and makes nothing; a missing stamp asks for a reload", async () => {
    expect(await submitJoin(db, form(), { ...meta(), honeypot: "http://spam" }, NOW)).toEqual({ ok: true });
    expect(await submitJoin(db, form(), { ...meta(), elapsedMs: 300 }, NOW)).toEqual({ ok: true });
    expect(await db.select().from(corpsMembers)).toHaveLength(0);
    expect(await submitJoin(db, form(), { ...meta(), elapsedMs: null }, NOW)).toMatchObject({ ok: false, reason: "stale" });
    expect(await submitJoin(db, form(), { clientKey: "" }, NOW)).toMatchObject({ ok: false, reason: "refused" });
  });

  it("limits one client; the global caps count only NEW rows, drop quietly past them, and repeats never use them up", async () => {
    const same = meta("203.0.113.9");
    for (let i = 0; i < JOIN_LIMITS.perClient; i++) expect((await submitJoin(db, form({ contact: `p${i}@example.test` }), same, NOW)).ok).toBe(true);
    expect(await submitJoin(db, form({ contact: "extra@example.test" }), same, NOW)).toMatchObject({ ok: false, reason: "limited" });
    // Repeat submissions by existing contacts never touch the new-row counters.
    const counters = async () => (await db.select().from(mealRateLimits)).filter((r) => r.key.includes("join:new"));
    const before = (await counters()).map((r) => r.count);
    for (let i = 0; i < 5; i++) await submitJoin(db, form({ contact: "p0@example.test" }), meta(), NOW);
    expect((await counters()).map((r) => r.count)).toEqual(before);
    // Once the hourly cap on new rows is reached, EVERY valid submission gets the same plain refusal before any lookup, and nothing is stored.
    const windowStart = new Date(Math.floor(NOW.getTime() / 3_600_000) * 3_600_000);
    await db.insert(mealRateLimits).values({ key: "join:new:hour", windowStart, count: JOIN_LIMITS.newPerHour }).onConflictDoUpdate({ target: [mealRateLimits.key, mealRateLimits.windowStart], set: { count: JOIN_LIMITS.newPerHour } });
    const members = (await db.select().from(corpsMembers)).length;
    const [existingBefore] = await db.select().from(corpsMembers).where(eq(corpsMembers.emailKey, "p1@example.test"));
    const fresh = await submitJoin(db, form({ contact: "another@example.test" }), meta(), NOW);
    const known = await submitJoin(db, form({ contact: "p1@example.test" }), meta(), NOW);
    expect(fresh).toEqual({ ok: false, reason: "capped", fields: [] });
    expect(known).toEqual(fresh);
    expect(await db.select().from(corpsMembers)).toHaveLength(members);
    // Nothing was stored for the existing contact either: no flag, so the answer tells nothing.
    expect((await db.select().from(corpsMembers).where(eq(corpsMembers.emailKey, "p1@example.test")))[0].askedToJoinAgainAt).toEqual(existingBefore.askedToJoinAgainAt);
    expect(JOIN_REFUSED.capped).toBe("We could not take this just now. Please try again later, or call the office.");
    // The daily cap does the same.
    await db.delete(mealRateLimits).where(eq(mealRateLimits.key, "join:new:hour"));
    await db.insert(mealRateLimits).values({ key: "day:join:new", windowStart: new Date(Math.floor(NOW.getTime() / 86_400_000) * 86_400_000), count: JOIN_LIMITS.newPerDay }).onConflictDoUpdate({ target: [mealRateLimits.key, mealRateLimits.windowStart], set: { count: JOIN_LIMITS.newPerDay } });
    expect(await submitJoin(db, form({ contact: "third@example.test" }), meta(), NOW)).toMatchObject({ ok: false, reason: "capped" });
  });

  it("pending members are not asked, can be accepted one at a time or all at once, and are deleted after 14 days", async () => {
    await submitJoin(db, form({ contact: "one@example.test" }), meta(), NOW);
    await submitJoin(db, form({ contact: "two@example.test", firstName: "Two" }), meta(), NOW);
    const task = await post();
    expect(await listAskCandidates(db, t.lead, { taskId: task.id }, NOW)).toEqual([]);
    const [one] = await db.select().from(corpsMembers).where(eq(corpsMembers.emailKey, "one@example.test"));
    await expect(prepareAsk(db, t.lead, { taskId: task.id }, [one.id], "https://care.example.test", NOW)).rejects.toBeInstanceOf(InvalidInput);
    await acceptMember(db, t.lead, one.id);
    expect((await listAskCandidates(db, t.lead, { taskId: task.id }, NOW)).map((c) => c.id)).toEqual([one.id]);
    await expect(acceptMember(db, t.lead, one.id)).rejects.toBeInstanceOf(InvalidInput);
    for (const a of [t.staff, t.senior, t.carer]) await expect(acceptAllPending(db, a)).rejects.toBeInstanceOf(AccessDenied);
    expect(await acceptAllPending(db, t.lead)).toBe(1);
    // A third who is never accepted goes after 14 days.
    await submitJoin(db, form({ contact: "three@example.test" }), meta(), NOW);
    await db.update(corpsMembers).set({ createdAt: NOW }).where(eq(corpsMembers.emailKey, "three@example.test"));
    expect(await rosterUpkeep(db, at(13))).toMatchObject({ pendingDeleted: 0 });
    expect(await rosterUpkeep(db, at(15))).toMatchObject({ pendingDeleted: 1 });
    expect(await db.select().from(corpsMembers)).toHaveLength(2);
  });
});

describe("the stop-asking link", () => {
  it("looking at it changes nothing, confirming stops the asks and marks it self-chosen, twice is once; only a hash is stored", async () => {
    const m = await addMember(db, t.lead, member(), NOW);
    const { token } = await makeStopLink(db, t.lead, m.id, true);
    const [stored] = await db.select().from(corpsMembers);
    expect(stored.stopTokenHash).toBe(tokenHash(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(await stopLinkWorks(db, token)).toBe(true);
    expect((await db.select().from(corpsMembers))[0].status).toBe("active");
    expect(await stopAsking(db, token, meta(), NOW)).toEqual({ ok: true });
    expect(await stopAsking(db, token, meta(), at(1))).toEqual({ ok: true });
    const [after] = await db.select().from(corpsMembers);
    expect(after).toMatchObject({ status: "left", leftAt: NOW, stoppedBy: "self" });
    expect((await listAskCandidates(db, t.lead, { taskId: (await post()).id }, NOW)).map((c) => c.id)).not.toContain(m.id);
  });

  it("a member has a link from the start; a new one is made only when the coordinator chooses to replace, and that kills the old one", async () => {
    const m = await addMember(db, t.lead, member(), NOW);
    expect((await db.select().from(corpsMembers))[0].stopTokenHash).not.toBeNull();
    await expect(makeStopLink(db, t.lead, m.id)).rejects.toBeInstanceOf(InvalidInput);
    const { token } = await makeStopLink(db, t.lead, m.id, true);
    expect(await stopLinkWorks(db, token)).toBe(true);
    await makeStopLink(db, t.lead, m.id, true);
    expect(await stopLinkWorks(db, token)).toBe(false);
    expect(await stopAsking(db, token, meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
    expect(await stopAsking(db, "nonsense", meta(), NOW)).toEqual({ ok: false, reason: "not_found" });
    expect((await db.select().from(corpsMembers))[0].status).toBe("active");
  });

  it("on stop or left, the ask-me-again ticks are turned off, and a hash (not the contact) outlives the purge so they are never offered or re-added", async () => {
    const task = await post();
    await claimTask(db, task.publicToken!, { firstName: "Dana", lastName: "Lev", contact: "Dana@Example.test", mayAskAgain: true }, meta(), NOW);
    const page = await livePage(db, t.lead);
    await signUp(db, page, "dana@example.test", "2026-12-03", true);
    const m = await addMember(db, t.lead, member({ email: "dana@example.test" }), NOW);
    await markMemberLeft(db, t.lead, m.id, at(1));
    expect((await db.select().from(volunteerClaims))[0].mayAskAgain).toBe(false);
    expect((await db.select().from(mealSignups))[0].mayContactAgain).toBe(false);
    await rosterUpkeep(db, at(40));
    const hashes = await db.select().from(corpsStoppedContacts);
    expect(hashes).toHaveLength(1);
    expect(JSON.stringify(hashes)).not.toContain("dana");
    // The row is purged, yet she is not offered as a past helper even if a tick came back, and nobody can add her by hand.
    await db.update(volunteerClaims).set({ mayAskAgain: true });
    await db.update(mealSignups).set({ mayContactAgain: true });
    expect(await listPastHelperCandidates(db, t.lead, at(41))).toEqual([]);
    await expect(addMember(db, t.lead, member({ email: "Dana@example.test" }), at(41))).rejects.toBeInstanceOf(InvalidInput);
    // Joining again only raises a flag on a fresh pending row, which a coordinator must confirm.
    await submitJoin(db, form({ contact: "dana@example.test" }), meta(), at(41));
    const fresh = (await db.select().from(corpsMembers)).find((r) => r.contactPurgedAt === null)!;
    expect(fresh).toMatchObject({ status: "pending", stoppedBy: "self" });
    expect(fresh.askedToJoinAgainAt).not.toBeNull();
    await expect(acceptMember(db, t.lead, fresh.id)).rejects.toBeInstanceOf(InvalidInput);
    expect(await acceptAllPending(db, t.lead)).toBe(0);
    await acceptMember(db, t.lead, fresh.id, { confirmed: true });
    expect((await db.select().from(corpsStoppedContacts))).toHaveLength(0);
  });
});

async function post(kind = "visit") {
  return createVolunteerTask(db, t.lead, { kind, forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-05" }, NOW);
}

describe("who sees the roster", () => {
  it("owner, clergy and the lead do; staff, caregivers and senior staff see none of it", async () => {
    for (const a of [t.owner, t.clergy, t.lead]) {
      expect(canManageRoster(a)).toBe(true);
      await expect(listRoster(db, a, {}, NOW)).resolves.toBeInstanceOf(Array);
    }
    const m = await addMember(db, t.lead, member(), NOW);
    for (const a of [t.staff, t.carer, t.senior]) {
      expect(canManageRoster(a)).toBe(false);
      await expect(listRoster(db, a, {}, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(addMember(db, a, member({ email: "x@example.test" }), NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(updateMember(db, a, m.id, member(), NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(markMemberLeft(db, a, m.id, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(makeStopLink(db, a, m.id, true)).rejects.toBeInstanceOf(AccessDenied);
      await expect(listPastHelperCandidates(db, a, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(prepareAsk(db, a, { taskId: (await post()).id }, [m.id], "https://care.example.test", NOW)).rejects.toBeInstanceOf(AccessDenied);
    }
  });

  it("filters by name, by what they can do and by status; add needs a contact and refuses the same person twice", async () => {
    await addMember(db, t.clergy, member(), NOW);
    const ruth = await addMember(db, t.clergy, member({ firstName: "Ruth", email: null, mobile: "314-555-0188", canDo: ["rides", "meals"] }), NOW);
    await pauseMember(db, t.clergy, ruth.id, "2026-12-20", NOW);
    expect((await listRoster(db, t.lead, { q: "rut" }, NOW)).map((m) => m.firstName)).toEqual(["Ruth"]);
    expect((await listRoster(db, t.lead, { can: "rides" }, NOW)).map((m) => m.firstName)).toEqual(["Ruth"]);
    expect((await listRoster(db, t.lead, { status: "paused" }, NOW)).map((m) => m.firstName)).toEqual(["Ruth"]);
    await expect(addMember(db, t.lead, member({ email: null }), NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(addMember(db, t.lead, member({ email: "AVI@example.test" }), NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(pauseMember(db, t.lead, ruth.id, "2026-11-01", NOW)).rejects.toBeInstanceOf(InvalidInput);
    await reactivateMember(db, t.lead, ruth.id);
    expect((await listRoster(db, t.lead, { status: "active" }, NOW)).map((m) => m.firstName).sort()).toEqual(["Avi", "Ruth"]);
  });

  it("shows when each person last helped and how many times in twelve months, from claims and meal sign-ups together", async () => {
    const m = await addMember(db, t.lead, member({ email: "sam@example.test" }), NOW);
    const task = await post();
    await claimTask(db, task.publicToken!, { firstName: "Sam", lastName: "K", contact: "Sam@Example.test", mayAskAgain: false }, meta(), NOW);
    const page = await livePage(db, t.lead);
    await signUp(db, page, "sam@example.test", "2026-12-03");
    const later = new Date("2026-12-10T18:00:00Z");
    const [row] = await listRoster(db, t.lead, {}, later);
    expect(row.id).toBe(m.id);
    expect(row).toMatchObject({ lastHelpedOn: "2026-12-05", helpedLast12Months: 2 });
  });
});

describe("past helpers who said ask me again", () => {
  it("one tap moves them onto the roster, de-duplicated by normalised contact across claims and meal sign-ups", async () => {
    const task = await post();
    await claimTask(db, task.publicToken!, { firstName: "Dana", lastName: "Lev", contact: "Dana@Example.test", mayAskAgain: true }, meta(), NOW);
    await claimTask(db, (await post("call")).publicToken!, { firstName: "Moe", lastName: "Gold", contact: "(314) 555-0177", mayAskAgain: true }, meta(), NOW);
    const page = await livePage(db, t.lead);
    await signUp(db, page, "dana@example.test", "2026-12-03", true);
    const candidates = await listPastHelperCandidates(db, t.lead, at(10));
    expect(candidates.map((c) => c.key).sort()).toEqual(["3145550177", "dana@example.test"]);
    const dana = candidates.find((c) => c.key === "dana@example.test")!;
    const added = await addFromPastHelper(db, t.lead, dana.key, at(10));
    expect(added).toMatchObject({ firstName: "Dana", source: "ask_again" });
    expect((await listPastHelperCandidates(db, t.lead, at(10))).map((c) => c.key)).toEqual(["3145550177"]);
    await expect(addFromPastHelper(db, t.lead, dana.key, at(10))).rejects.toBeInstanceOf(NotFound);
    expect(await db.select().from(corpsMembers)).toHaveLength(1);
    // Someone who then leaves is never offered again.
    await markMemberLeft(db, t.lead, added.id, at(11));
    expect((await listPastHelperCandidates(db, t.lead, at(12))).map((c) => c.key)).toEqual(["3145550177"]);
  });
});

describe("asking the roster", () => {
  it("lists active members who can do the kind, least recently asked first, and records who was asked", async () => {
    const a = await addMember(db, t.lead, member({ firstName: "Avi", email: "a@example.test", canDo: ["visits"] }), NOW);
    const b = await addMember(db, t.lead, member({ firstName: "Bea", email: "b@example.test", canDo: ["visits", "rides"] }), NOW);
    const c = await addMember(db, t.lead, member({ firstName: "Cal", email: "c@example.test", canDo: ["rides"] }), NOW);
    const gone = await addMember(db, t.lead, member({ firstName: "Gil", email: "g@example.test", canDo: ["visits"] }), NOW);
    await markMemberLeft(db, t.lead, gone.id, NOW);
    const task = await post("visit");
    const target = { taskId: task.id };
    expect((await listAskCandidates(db, t.lead, target, NOW)).map((x) => x.firstName)).toEqual(["Avi", "Bea"]);
    const first = await prepareAsk(db, t.lead, target, [a.id], "https://care.example.test", at(0));
    expect(first.count).toBe(1);
    const sooner = await post("visit");
    await prepareAsk(db, t.lead, { taskId: sooner.id }, [b.id], "https://care.example.test", at(1));
    // Avi was asked first, then Bea: Avi is asked again before Bea only once Bea has been asked more recently.
    expect((await listAskCandidates(db, t.lead, target, at(2))).map((x) => x.firstName)).toEqual(["Avi", "Bea"]);
    await prepareAsk(db, t.lead, target, [a.id], "https://care.example.test", at(3));
    expect((await listAskCandidates(db, t.lead, target, at(4))).map((x) => x.firstName)).toEqual(["Bea", "Avi"]);
    const asks = await db.select().from(corpsAsks);
    expect(asks).toHaveLength(3);
    expect(asks.every((r) => r.askedBy === t.lead.id)).toBe(true);
    // A member who cannot do the kind, or who left, is not asked even when named.
    const out = await prepareAsk(db, t.lead, target, [c.id, gone.id, b.id], "https://care.example.test", at(3));
    expect(out.count).toBe(2);
    // The audit row holds ids and a count, never a name or a contact.
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "corps_member.ask"));
    expect(JSON.stringify(audit)).not.toMatch(/example\.test|Avi|Bea/);
  });

  it("prepares the contacts and links for the coordinator's own mail app and phone, with only the public link and text, and sends nothing", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const a = await addMember(db, t.lead, member({ email: "a@example.test", mobile: "314-555-0101" }), NOW);
    const b = await addMember(db, t.lead, member({ firstName: "Bea", email: "b@example.test", mobile: null }), NOW);
    const task = await post();
    const out = await prepareAsk(db, t.lead, { taskId: task.id }, [a.id, b.id], "https://care.example.test", NOW);
    expect(out.emails).toEqual(["a@example.test", "b@example.test"]);
    expect(out.mobiles).toEqual(["3145550101"]);
    expect(out.mailto).toHaveLength(1);
    expect(out.mailto[0]).toContain("bcc=a%40example.test,b%40example.test");
    expect(out.body).toContain(`https://care.example.test/v/${task.publicToken}`);
    expect(out.body).toContain("Sit with Ruth for an hour");
    expect(out.body).not.toMatch(/Avi|Mor|Bea|Elm Court|Ruth Cohen/);
    expect(out.texts).toEqual([{ name: "Avi", href: expect.stringMatching(/^sms:3145550101\?&body=/) }]);
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });

  it("a sheet can be asked about too, as shiva minyan, against the sheet", async () => {
    const m = await addMember(db, t.lead, member({ canDo: ["shiva_minyan"] }), NOW);
    const sheet = await createVolunteerSheet(db, t.lead, { title: "the Levy family", evenings: [{ date: "2026-12-04" }] }, NOW);
    expect((await listAskCandidates(db, t.lead, { groupId: sheet.id }, NOW)).map((x) => x.id)).toEqual([m.id]);
    await prepareAsk(db, t.lead, { groupId: sheet.id }, [m.id], "https://care.example.test", NOW);
    expect((await db.select().from(corpsAsks))[0].groupId).toBe(sheet.id);
  });

  it("notifyMembers says it is not configured and sends nothing", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    expect(await notifyMembers([{ id: "x" }], { subject: "s", body: "b" })).toEqual({ status: "not_configured", sent: 0, channel: "email" });
    expect(await notifyMembers([{ id: "x" }], { subject: "s", body: "b" }, "sms")).toMatchObject({ status: "not_configured", sent: 0 });
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  });
});

describe("mail and text links", () => {
  it("encodes everything, caps at 40 recipients a link, and cannot be bent into another header", () => {
    const emails = Array.from({ length: 95 }, (_, i) => `p${i}@example.test`);
    const links = mailtoLinks(emails, "Can you help?", askBody("Bring soup\r\nBcc: evil@example.test", "https://care.example.test/v/abc"));
    expect(links).toHaveLength(3);
    expect(links[0].split("&")[0].split(",")).toHaveLength(ASK_LINK_CAP);
    for (const l of links) {
      expect(l).not.toMatch(/[\r\n ]/);
      expect(l.replace("mailto:?", "").split("&").filter((p) => p.startsWith("bcc="))).toHaveLength(1);
      expect(l).not.toContain("evil@example.test");
      expect(l).toContain("%0D%0ABcc%3A%20evil%40example.test");
    }
    // An address that carries a header or a second recipient is dropped, not escaped into place.
    const bad = mailtoLinks(["ok@example.test", "x@example.test%0d%0abcc:y@example.test", "a@b.test,c@d.test", "x@y.test\nBcc: z@y.test"], "s", "b");
    expect(bad).toHaveLength(1);
    expect(bad[0]).toBe("mailto:?bcc=ok%40example.test&subject=s&body=b");
    expect(mailtoLinks([], "s", "b")).toEqual([]);
    // Never a group text: one number to a link.
    expect(smsLinks(["314-555-0101", "+1 (314) 555-0102", "junk", "3145550101"], "Hi there")).toEqual(["sms:3145550101?&body=Hi%20there", "sms:+13145550102?&body=Hi%20there"]);
    for (const l of smsLinks(Array.from({ length: 41 }, (_, i) => `31455501${String(i).padStart(2, "0")}`), "x")) expect(l.split("?")[0]).not.toContain(",");
  });
});

describe("the daily upkeep", () => {
  it("makes paused members active on their day", async () => {
    const m = await addMember(db, t.lead, member(), NOW);
    await pauseMember(db, t.lead, m.id, "2026-12-10", NOW);
    expect(await rosterUpkeep(db, new Date("2026-12-09T18:00:00Z"))).toMatchObject({ unpaused: 0 });
    expect((await db.select().from(corpsMembers))[0].status).toBe("paused");
    expect(await rosterUpkeep(db, new Date("2026-12-10T18:00:00Z"))).toMatchObject({ unpaused: 1 });
    expect((await db.select().from(corpsMembers))[0]).toMatchObject({ status: "active", pausedUntil: null });
  });

  it("deletes a left member's contact details after 30 days, not at 29, keeping the first name and a count", async () => {
    const m = await addMember(db, t.lead, member({ availability: "Sundays", area: "63105", coordinatorNotes: "Prefers texts" }), NOW);
    await markMemberLeft(db, t.lead, m.id, NOW);
    expect(await rosterUpkeep(db, at(29))).toMatchObject({ purged: 0 });
    expect((await db.select().from(corpsMembers))[0].email).toBe("avi@example.test");
    expect(await rosterUpkeep(db, at(31))).toMatchObject({ purged: 1 });
    const [row] = await db.select().from(corpsMembers);
    expect(row).toMatchObject({ firstName: "Avi", status: "left", lastName: null, email: null, mobile: null, emailKey: null, mobileKey: null, availability: null, area: null, coordinatorNotes: null, stopTokenHash: null });
    expect(row.contactPurgedAt).not.toBeNull();
    // A purged member cannot be brought back or edited: they are added afresh.
    await expect(reactivateMember(db, t.lead, m.id)).rejects.toBeInstanceOf(InvalidInput);
    await expect(updateMember(db, t.lead, m.id, member(), at(32))).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe("small fixes from the re-review", () => {
  it("N1: the device cookie is a __Host- cookie in production (Secure, HttpOnly, Lax, path /, no Domain) and a plain one elsewhere", () => {
    const prod = refCookie("production");
    expect(prod.name).toBe("__Host-crc_vol_ref");
    expect(prod.options).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 180 * 86_400 });
    expect(prod.options).not.toHaveProperty("domain");
    for (const env of ["development", "test", undefined]) {
      const c = refCookie(env);
      expect(c.name).toBe("crc_vol_ref");
      expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, path: "/v" });
      expect(c.options).not.toHaveProperty("domain");
    }
  });

  it("N4: a self-stop stays self when a coordinator then marks them left, so bringing them back still needs the confirmation", async () => {
    const m = await addMember(db, t.lead, member(), NOW);
    await stopAsking(db, (await makeStopLink(db, t.lead, m.id, true)).token, meta(), NOW);
    await markMemberLeft(db, t.lead, m.id, at(1));
    await submitJoin(db, form({ contact: "avi@example.test" }), meta(), at(2));
    expect((await db.select().from(corpsMembers))[0].stoppedBy).toBe("self");
    await expect(reactivateMember(db, t.lead, m.id)).rejects.toBeInstanceOf(InvalidInput);
    await reactivateMember(db, t.lead, m.id, { confirmed: true });
    expect((await db.select().from(corpsMembers))[0].status).toBe("active");
  });
});
