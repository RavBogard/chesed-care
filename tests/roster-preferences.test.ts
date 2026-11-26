import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { HOW_OFTEN, HOW_OFTEN_DAYS, PREFER_CONTACT } from "@/lib/can-do";
import { InvalidInput } from "@/server/care/validate";
import { corpsAsks, corpsMembers } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { submitJoin } from "@/server/volunteers/join";
import { createVolunteerTask } from "@/server/volunteers/organiser";
import { acceptMember, addMember, listAskCandidates, listRoster, updateMember } from "@/server/volunteers/roster";
import { reporters, team, testDb } from "./support/db";
import { meta, NOW } from "./support/meals";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const form = (over: Record<string, unknown> = {}) => ({ firstName: "Rina", lastName: "Stein", contact: "rina@example.test", canDo: ["visits"], availability: null, consent: true, ...over });
const member = (n: string, over: Record<string, unknown> = {}) => ({ firstName: n, lastName: "Mor", email: `${n.toLowerCase()}@example.test`, mobile: null, canDo: ["visits"], ...over });
const post = () => createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-05" }, NOW);

beforeEach(async () => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-roster-preferences";
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});

describe("the join form and the coordinator's form", () => {
  it("the join form accepts and stores both preferences and the new things people can do", async () => {
    const r = await submitJoin(db, form({ canDo: ["soup", "baking", "care_packages", "house_sitting"], howOften: "quarterly", preferContact: "text" }), meta(), NOW);
    expect(r).toEqual({ ok: true });
    const [row] = await db.select().from(corpsMembers);
    expect(row).toMatchObject({ canDo: ["soup", "baking", "care_packages", "house_sitting"], howOften: "quarterly", preferContact: "text" });
  });

  it("both are optional on the join form, and a value that is not one of the choices is refused", async () => {
    expect(await submitJoin(db, form(), meta(), NOW)).toEqual({ ok: true });
    expect(await db.select().from(corpsMembers)).toMatchObject([{ howOften: null, preferContact: null }]);
    expect(await submitJoin(db, form({ contact: "x@example.test", howOften: "daily" }), meta(), NOW)).toMatchObject({ ok: false, reason: "invalid" });
    expect(await submitJoin(db, form({ contact: "y@example.test", preferContact: "pigeon" }), meta(), NOW)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("the coordinator can set, change and clear them on the member", async () => {
    const m = await addMember(db, t.lead, member("Avi", { howOften: "monthly", preferContact: "call" }), NOW);
    expect(m).toMatchObject({ howOften: "monthly", preferContact: "call" });
    expect(await updateMember(db, t.lead, m.id, member("Avi", { howOften: "as_needed", preferContact: "" }), NOW)).toMatchObject({ howOften: "as_needed", preferContact: null });
    // Left out of the input, a value is left alone.
    expect(await updateMember(db, t.lead, m.id, member("Avi", { firstName: "Avraham" }), NOW)).toMatchObject({ howOften: "as_needed" });
    await expect(updateMember(db, t.lead, m.id, member("Avi", { howOften: "hourly" }), NOW)).rejects.toBeInstanceOf(InvalidInput);
    expect((await listRoster(db, t.lead, {}, NOW))[0]).toMatchObject({ firstName: "Avraham", howOften: "as_needed" });
  });

  it("an accepted member from the form keeps what they chose", async () => {
    await submitJoin(db, form({ howOften: "monthly", preferContact: "email" }), meta(), NOW);
    const [row] = await db.select().from(corpsMembers);
    await acceptMember(db, t.lead, row.id);
    expect((await listRoster(db, t.lead, {}, NOW))[0]).toMatchObject({ howOften: "monthly", preferContact: "email" });
  });
});

describe("asking the roster", () => {
  async function asked(memberId: string, daysAgo: number, taskId: string) {
    await db.insert(corpsAsks).values({ memberId, taskId, askedBy: t.lead.id, askedAt: at(-daysAgo) });
  }

  it("someone asked more recently than they said they would like goes to the end, and is flagged", async () => {
    const task = await post();
    const a = await addMember(db, t.lead, member("Aaa", { howOften: "once_a_year" }), NOW);
    const b = await addMember(db, t.lead, member("Bbb", { howOften: "monthly" }), NOW);
    const c = await addMember(db, t.lead, member("Ccc"), NOW);
    const d = await addMember(db, t.lead, member("Ddd", { howOften: "as_needed" }), NOW);
    const e = await addMember(db, t.lead, member("Eee"), NOW);
    await asked(a.id, 100, task.id); // once a year: 265 days to go
    await asked(b.id, 31, task.id); // monthly: due again
    await asked(c.id, 200, task.id); // nothing chosen: never moved
    await asked(d.id, 1, task.id); // as needed: never moved
    const out = await listAskCandidates(db, t.lead, { taskId: task.id }, NOW);
    // Never asked first (Eee), then least recently asked as before (Ccc, Bbb, Ddd), and the one asked too recently last.
    expect(out.map((x) => x.id)).toEqual([e.id, c.id, b.id, d.id, a.id]);
    expect(out.map((x) => x.askedRecently)).toEqual([false, false, false, false, true]);
  });

  it("each interval is honoured at its edge, and a member who has never been asked is never moved", async () => {
    const task = await post();
    const cases = [["once_a_year", 364, true], ["once_a_year", 365, false], ["twice_a_year", 181, true], ["twice_a_year", 182, false], ["quarterly", 90, true], ["quarterly", 91, false], ["monthly", 29, true], ["monthly", 30, false]] as const;
    expect(HOW_OFTEN.map((k) => HOW_OFTEN_DAYS[k])).toEqual([365, 182, 91, 30, 0]);
    for (const [i, [how, days, recent]] of cases.entries()) {
      const m = await addMember(db, t.lead, member(`M${i}`, { howOften: how }), NOW);
      await asked(m.id, days, task.id);
      const got = (await listAskCandidates(db, t.lead, { taskId: task.id }, NOW)).find((x) => x.id === m.id)!;
      expect([how, days, got.askedRecently]).toEqual([how, days, recent]);
    }
    const fresh = await addMember(db, t.lead, member("Fresh", { howOften: "once_a_year" }), NOW);
    expect((await listAskCandidates(db, t.lead, { taskId: task.id }, NOW)).find((x) => x.id === fresh.id)).toMatchObject({ askedRecently: false, lastAsked: null });
  });

  it("each candidate carries the preferred way to be reached", async () => {
    const task = await post();
    const a = await addMember(db, t.lead, member("Aaa", { preferContact: "text" }), NOW);
    await addMember(db, t.lead, member("Bbb"), NOW);
    const out = await listAskCandidates(db, t.lead, { taskId: task.id }, NOW);
    expect(out.map((x) => [x.firstName, x.preferContact])).toEqual([["Aaa", "text"], ["Bbb", null]]);
    expect(PREFER_CONTACT).toContain(out.find((x) => x.id === a.id)!.preferContact);
    // Sorting by last asked still holds for people who are not flagged.
    await db.update(corpsMembers).set({ howOften: null }).where(eq(corpsMembers.id, a.id));
  });
});
