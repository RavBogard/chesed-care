import { beforeEach, describe, expect, it } from "vitest";
import { proposals, mealSignups, volunteerClaims } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { DAILY_TASKS, runDailyJob } from "@/server/daily/run";
import { NOT_CONFIGURED } from "@/server/daily/summary";
import { endMealPage } from "@/server/meals/pages";
import { signUpForMeal } from "@/server/meals/public";
import { createVolunteerTask } from "@/server/volunteers/organiser";
import { claimTask } from "@/server/volunteers/public";
import { reporters, team, testDb } from "./support/db";
import { helper, livePage, meta, NOW } from "./support/meals";

/**
 * Daniel, 2026-11-25: "Keep everything". The daily job no longer clears the name and contact of a volunteer who
 * claimed a task or a helper who signed up for a meal, however long after the old 30-day (and 24-month) windows.
 */
const DAY = 86_400_000;
let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;

beforeEach(async () => {
  db = await testDb();
  t = { ...(await team(db)), ...(await reporters(db)) };
});

const runAt = (now: Date) => runDailyJob({ db, now, owners: new Set(["owner@example.test"]), origin: null, channels: NOT_CONFIGURED, packet: null }, DAILY_TASKS.filter((x) => x.key !== "helper_reminders"));

describe("the daily job keeps outside people's contact details", () => {
  it("no task clears contacts any more", () => {
    expect(DAILY_TASKS.map((x) => x.key)).not.toContain("clergy_upkeep");
    expect(DAILY_TASKS.map((x) => x.key)).not.toContain("visiting_purge");
  });

  it("a volunteer's claim and a meal helper's sign-up keep their name and contact long after the old window", async () => {
    const task = await createVolunteerTask(db, t.lead, { kind: "visit", forLabel: "Ruth", needed: "Sit with Ruth for an hour", date: "2026-12-05", peopleNeeded: 2 }, NOW);
    const once = await claimTask(db, task.publicToken!, { firstName: "Sam", lastName: "Katz", contact: "sam@example.test", note: "Happy to help", mayAskAgain: false }, meta(), NOW);
    const again = await claimTask(db, task.publicToken!, { firstName: "Ana", lastName: "Roth", contact: "314-555-0101", mayAskAgain: true }, meta(), NOW);
    if (!once.ok || !again.ok) throw new Error("setup");
    const page = await livePage(db, t.lead);
    const meal = await signUpForMeal(db, page.publicToken, page.slots[0].id, helper({ email: "eli@example.test", firstName: "Eli" }), meta(), NOW);
    if (!meal.ok) throw new Error("setup");
    await endMealPage(db, t.lead, page.id, NOW);

    for (const days of [31, 400, 800, 3 * 365]) {
      const results = await runAt(new Date(NOW.getTime() + days * DAY));
      expect(results.filter((r) => !r.ok)).toEqual([]);
    }

    const claims = (await db.select().from(volunteerClaims)).map((c) => [c.firstName, c.lastName, c.contact, c.note]).sort();
    expect(claims).toEqual([["Ana", "Roth", "314-555-0101", null], ["Sam", "Katz", "sam@example.test", null]]);
    const [signup] = await db.select().from(mealSignups);
    expect(signup).toMatchObject({ firstName: "Eli", email: "eli@example.test", bringing: null, note: null });
    expect(await db.select().from(proposals)).toEqual([]);
  });
});
