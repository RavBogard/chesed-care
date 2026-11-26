import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { AccessDenied, canEditFollowUp, canSeeFollowUp, type Actor } from "@/server/access/policy";
import { closeCareItem, createCareItem, pauseCareItem, updateCareItem } from "@/server/care/care-items";
import { ensureNextStandingStep } from "@/server/journeys/lifecycle";
import { addDays } from "@/server/lifecycle/window";
import { completeLeadStep, listFollowUps, listLeadSteps, setFollowUpDone, updateFollowUp, deleteFollowUp } from "@/server/care/follow-ups";
import { getTodayCare } from "@/server/care/boards";
import { getCareItem } from "@/server/care/care-items";
import { listContactEntries } from "@/server/care/contact-log";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { auditLog, careItemJourneys, followUps, journeyTemplates, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { endJourney, listJourneys, previewJourney, startJourney } from "@/server/journeys/journeys";
import { addMonths, firstPesachAfter, firstRoshHashanahAfter, firstYahrzeit, planJourney } from "@/server/journeys/plan";
import { listJourneyTemplates, resetJourneyTemplate, saveJourneyTemplate } from "@/server/journeys/template-store";
import { DEFAULT_TEMPLATES, JOURNEY_KEYS } from "@/server/journeys/templates";
import { addActor, CONTACT, CONTACT2, team, testDb } from "./support/db";
import { words } from "./support/words";

/** 10am in Chicago on Wednesday 25 November 2026; the death was the day before. */
const NOW = new Date("2026-11-25T16:00:00Z");
const DEATH = "2026-11-24";

async function setup() {
  const db = await testDb();
  const t = await team(db);
  const lead = await addActor(db, "lead@example.test", "lead");
  const staff = await addActor(db, "staff@example.test", "staff");
  const senior = await addActor(db, "senior@example.test", "senior_staff");
  const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "bereavement", summary: "Lost her husband" });
  return { db, t, lead, staff, senior, item };
}

const steps = async (db: Db, journeyId: string) =>
  (await db.select().from(followUps).where(eq(followUps.journeyId, journeyId))).map((f) => ({ title: f.title, due: f.dueDate, owner: f.ownerUserId, forLead: f.forLead, done: f.doneAt !== null })).sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));

describe("journey dates (pure)", () => {
  it("counts the Jewish-calendar steps from the death: first Rosh Hashanah, first Pesach, first yahrzeit on the Hebrew date", () => {
    // 24 November 2026 is 14 Kislev 5787.
    expect(firstRoshHashanahAfter(DEATH)).toBe("2027-10-02");
    expect(firstPesachAfter(DEATH)).toBe("2027-04-22");
    // 14 Kislev 5788, not 24 November 2027.
    expect(firstYahrzeit(DEATH)).toBe("2027-12-14");
    // A death after Pesach waits for next year's.
    expect(firstPesachAfter("2027-05-10")).toBe("2028-04-11");
    expect(addMonths("2027-01-31", 1)).toBe("2027-02-28");
  });

  it("never dates a step before today, and keeps the template's order within a day", () => {
    const planned = planJourney("bereavement_year", DEFAULT_TEMPLATES.bereavement_year.steps, { anchorDate: DEATH, secondDate: null, intervalWeeks: null, today: "2026-11-25" });
    expect(planned.every((s) => s.dueDate >= "2026-11-25")).toBe(true);
    expect(planned.slice(0, 2).map((s) => s.stepId)).toEqual(["call_on_hearing", "funeral_shiva_details"]);
  });

  it("an illness counts from the discharge when it is known, else from a week in", () => {
    const base = { anchorDate: "2026-11-25", intervalWeeks: null, today: "2026-11-25" };
    const due = (second: string | null) => Object.fromEntries(planJourney("illness", DEFAULT_TEMPLATES.illness.steps, { ...base, secondDate: second }).map((s) => [s.stepId, s.dueDate]));
    expect(due(null)).toMatchObject({ after_discharge: "2026-12-02", week_after_discharge: "2026-12-09", three_weeks_after_discharge: "2026-12-23", close_or_continue: "2027-01-06" });
    expect(due("2026-11-28")).toMatchObject({ after_discharge: "2026-11-28", week_after_discharge: "2026-12-05" });
  });
});

describe("starting a journey", () => {
  it("the bereavement year makes each step with its date and holder; a single active lead is preselected", async () => {
    const { db, t, lead, item } = await setup();
    const { journeyId } = await startJourney(db, t.clergy, item.id, { templateKey: "bereavement_year", anchorDate: DEATH }, NOW);
    const C = t.clergy.id;
    const L = lead.id;
    expect(await steps(db, journeyId)).toEqual([
      { title: "Arrange meals", due: "2026-11-25", owner: L, forLead: true, done: false },
      { title: "Arrange the shiva minyan", due: "2026-11-25", owner: L, forLead: true, done: false },
      { title: "Call on hearing", due: "2026-11-25", owner: C, forLead: false, done: false },
      { title: "Record the funeral and shiva details", due: "2026-11-25", owner: C, forLead: false, done: false },
      { title: "Shiva visit", due: "2026-11-26", owner: C, forLead: false, done: false },
      { title: "Call in the second week", due: "2026-12-04", owner: C, forLead: false, done: false },
      { title: "Shloshim: be in touch", due: "2026-12-24", owner: C, forLead: false, done: false },
      { title: "Check-in call, three months on", due: "2027-02-24", owner: L, forLead: true, done: false },
      { title: "A note before the first Pesach without them", due: "2027-04-08", owner: C, forLead: false, done: false },
      { title: "Check-in call, six months on", due: "2027-05-24", owner: L, forLead: true, done: false },
      { title: "A note before the first High Holidays without them", due: "2027-09-18", owner: C, forLead: false, done: false },
      { title: "Plan the unveiling", due: "2027-10-24", owner: C, forLead: false, done: false },
      { title: "Call before the first yahrzeit", due: "2027-12-07", owner: C, forLead: false, done: false },
    ]);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "journey.start"));
    expect(audit.detail).toEqual({ careItemId: item.id, templateKey: "bereavement_year", count: 13 });
  });

  it("only the ticked steps are made; with no lead chosen the Mitzvah Corps steps go to the owner, marked for Mitzvah Corps", async () => {
    const { db, t, item } = await setup();
    const preview = await previewJourney(db, t.clergy, { templateKey: "new_baby", anchorDate: "2026-11-25" }, "2026-11-25");
    expect(preview.steps.map((s) => s.stepId)).toEqual(["mazal_tov_call", "meals_for_parents", "ask_naming_bris", "check_in_month_3"]);
    expect(preview.defaultLeadId).toBe(preview.leads[0].id);
    const { journeyId } = await startJourney(db, t.clergy, item.id, { templateKey: "new_baby", anchorDate: "2026-11-25", stepIds: ["mazal_tov_call", "meals_for_parents"], leadUserId: "" }, NOW);
    expect((await steps(db, journeyId)).map((s) => [s.title, s.owner, s.forLead])).toEqual([
      ["Arrange meals for the parents", t.clergy.id, true],
      ["Mazal tov call", t.clergy.id, false],
    ]);
    await expect(startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate: "2026-11-25", stepIds: [] }, NOW)).rejects.toBeInstanceOf(InvalidInput);
  });

  it("starting the same journey twice on an item is refused; another journey, or the same one after it ends, is not", async () => {
    const { db, t, item } = await setup();
    const first = await startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW);
    await expect(startJourney(db, t.clergy2, item.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await startJourney(db, t.clergy, item.id, { templateKey: "standing", anchorDate: "2026-11-25" }, NOW);
    await endJourney(db, t.clergy, first.journeyId, NOW);
    await expect(startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW)).resolves.toBeTruthy();
  });

  it("only clergy level who fully see the item start or end one", async () => {
    const { db, t, lead, staff, senior, item } = await setup();
    for (const a of [t.carer, lead, staff, senior]) await expect(startJourney(db, a, item.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW)).rejects.toBeInstanceOf(NotFound);
    for (const a of [t.carer, lead, staff, senior]) await expect(previewJourney(db, a, { templateKey: "illness", anchorDate: "2026-11-25" })).rejects.toBeInstanceOf(AccessDenied);
    const restricted = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam Cohen", category: "illness", restricted: true });
    await expect(startJourney(db, t.owner, restricted.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW)).rejects.toBeInstanceOf(NotFound);
    const { journeyId } = await startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW);
    await expect(endJourney(db, t.carer, journeyId, NOW)).rejects.toBeInstanceOf(NotFound);
  });

  it("ending a journey removes its steps still to do and keeps the done ones; closing the item ends its journeys; pausing shifts nothing", async () => {
    const { db, t, item } = await setup();
    const { journeyId } = await startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW);
    const before = await steps(db, journeyId);
    await pauseCareItem(db, t.clergy, item.id, "2026-12-20", "2026-11-25");
    expect(await steps(db, journeyId)).toEqual(before);
    const [first] = await listFollowUps(db, t.clergy, { careItemId: item.id });
    await setFollowUpDone(db, t.clergy, first.id, true, { now: NOW });
    expect(await endJourney(db, t.clergy, journeyId, NOW)).toEqual({ removed: before.length - 1 });
    expect((await steps(db, journeyId)).map((s) => s.done)).toEqual([true]);
    await expect(endJourney(db, t.clergy, journeyId, NOW)).rejects.toBeInstanceOf(InvalidInput);

    const other = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam Cohen", category: "illness" });
    const second = await startJourney(db, t.clergy, other.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW);
    const manual = await db.insert(followUps).values({ careItemId: other.id, sfContactId: CONTACT2, displayName: "Sam Cohen", title: "Hand-made", dueDate: "2026-12-01", ownerUserId: t.clergy.id, createdBy: t.clergy.id }).returning();
    await closeCareItem(db, t.clergy, other.id, NOW);
    expect(await steps(db, second.journeyId)).toEqual([]);
    const [run] = await db.select().from(careItemJourneys).where(eq(careItemJourneys.id, second.journeyId));
    expect(run.endedAt).toEqual(NOW);
    // A follow-up that is not a journey's stays as it was.
    expect((await db.select().from(followUps).where(eq(followUps.id, manual[0].id))).length).toBe(1);
    await expect(startJourney(db, t.clergy, other.id, { templateKey: "standing", anchorDate: "2026-11-25" }, NOW)).rejects.toBeInstanceOf(InvalidInput);
  });

  it("a journey's steps are ordinary follow-ups: moved, reassigned, skipped (done without a contact)", async () => {
    const { db, t, item } = await setup();
    await startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW);
    const [a, b, c] = await listFollowUps(db, t.clergy, { careItemId: item.id });
    expect((await updateFollowUp(db, t.clergy, a.id, { dueDate: "2026-12-30" })).dueDate).toBe("2026-12-30");
    expect((await updateFollowUp(db, t.clergy, b.id, { ownerUserId: t.clergy2.id })).ownerUserId).toBe(t.clergy2.id);
    await setFollowUpDone(db, t.clergy, c.id, true, { now: NOW });
    expect(await listContactEntries(db, t.clergy, {})).toEqual([]);
  });
});

describe("standing check-ins", () => {
  it("the next step comes only when the last is done, `interval` weeks on; ending stops it", async () => {
    const { db, t, item } = await setup();
    const { journeyId } = await startJourney(db, t.clergy, item.id, { templateKey: "standing", anchorDate: "2026-11-25", intervalWeeks: 2 }, NOW);
    expect(await steps(db, journeyId)).toEqual([{ title: "Be in touch", due: "2026-12-09", owner: t.clergy.id, forLead: false, done: false }]);
    const [first] = await db.select().from(followUps).where(eq(followUps.journeyId, journeyId));
    await updateFollowUp(db, t.clergy, first.id, { dueDate: "2026-12-01" });
    expect(await steps(db, journeyId)).toHaveLength(1);
    await setFollowUpDone(db, t.clergy, first.id, true, { now: new Date("2026-12-01T16:00:00Z") });
    expect((await steps(db, journeyId)).map((s) => [s.due, s.done])).toEqual([
      ["2026-12-01", true],
      ["2026-12-15", false],
    ]);
    await endJourney(db, t.clergy, journeyId, NOW);
    expect((await steps(db, journeyId)).map((s) => s.done)).toEqual([true]);
  });

  it("the interval is between 1 and 26 weeks, 4 when not given", async () => {
    const { db, t, item } = await setup();
    for (const intervalWeeks of [0, 27, 2.5, "x"]) await expect(startJourney(db, t.clergy, item.id, { templateKey: "standing", anchorDate: "2026-11-25", intervalWeeks }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    const { journeyId } = await startJourney(db, t.clergy, item.id, { templateKey: "standing", anchorDate: "2026-11-25" }, NOW);
    expect((await steps(db, journeyId))[0].due).toBe("2026-12-23");
  });
});

describe("Mitzvah Corps leads", () => {
  async function withLeadSteps() {
    const s = await setup();
    const { journeyId } = await startJourney(s.db, s.t.clergy, s.item.id, { templateKey: "bereavement_year", anchorDate: DEATH }, NOW);
    return { ...s, journeyId };
  }

  it("a lead sees only the steps assigned to them: the person, the step, the date and the meals link; nothing of the item", async () => {
    const { db, t, lead, item } = await withLeadSteps();
    const mine = await listLeadSteps(db, lead, NOW);
    expect(mine.map((s) => s.title)).toEqual(["Arrange meals", "Arrange the shiva minyan", "Check-in call, three months on", "Check-in call, six months on"]);
    expect(Object.keys(mine[0]).sort()).toEqual(["corpsNote", "done", "dueDate", "id", "mealsHref", "outcomeNote", "person", "title"]);
    expect(mine[0]).toMatchObject({ person: "Ruth Cohen", mealsHref: `/meals/new?contact=${CONTACT}` });
    expect(words(mine)).not.toMatch(/bereavement|Lost her husband|careItem/i);
    // The general list gives them the same steps and no item id; the care item itself does not exist for them.
    const rows = await listFollowUps(db, lead, {});
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.careItemId === null && r.journeyId === null)).toBe(true);
    await expect(getCareItem(db, lead, item.id)).rejects.toBeInstanceOf(NotFound);
    expect(await listJourneys(db, lead, [item.id])).toEqual([]);
    expect(await getTodayCare(db, lead, "2026-11-25")).toEqual({ due: [], attention: [], doneToday: 0 });
    // Not another lead's, not the clergy's.
    const other = await addActor(db, "lead2@example.test", "lead");
    expect(await listLeadSteps(db, other, NOW)).toEqual([]);
    const clergyStep = (await listFollowUps(db, t.clergy, { careItemId: item.id })).find((f) => !f.forLead)!;
    await expect(completeLeadStep(db, lead, clergyStep.id, "", NOW)).rejects.toBeInstanceOf(NotFound);
  });

  it("a lead completes their own step with a one-line outcome the owner reads; they cannot move, reassign, reopen or delete it", async () => {
    const { db, t, lead, item } = await withLeadSteps();
    const [step] = await listLeadSteps(db, lead, NOW);
    await expect(updateFollowUp(db, lead, step.id, { dueDate: "2027-01-01" })).rejects.toBeInstanceOf(AccessDenied);
    await expect(setFollowUpDone(db, lead, step.id, true)).rejects.toBeInstanceOf(AccessDenied);
    await expect(deleteFollowUp(db, lead, step.id)).rejects.toBeInstanceOf(AccessDenied);
    await completeLeadStep(db, lead, step.id, "Six families signed up\nthrough December", NOW);
    await expect(completeLeadStep(db, lead, step.id, "", NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(completeLeadStep(db, lead, (await listLeadSteps(db, lead, NOW))[1].id, "x".repeat(201), NOW)).rejects.toBeInstanceOf(InvalidInput);
    const [journey] = await listJourneys(db, t.clergy, [item.id]);
    expect(journey.steps.find((s) => s.id === step.id)).toMatchObject({ done: true, outcomeNote: "Six families signed up through December" });
    // No contact log entry: a lead never writes to it.
    expect(await listContactEntries(db, t.clergy, {})).toEqual([]);
  });

  it("on a restricted item no lead step is made at all: they go to the owner, marked for Mitzvah Corps, and no lead can see or infer them", async () => {
    const { db, t, lead } = await setup();
    const restricted = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam Cohen", category: "bereavement", restricted: true });
    await expect(startJourney(db, t.clergy, restricted.id, { templateKey: "bereavement_year", anchorDate: DEATH, leadUserId: lead.id }, NOW)).resolves.toBeTruthy();
    const made = await db.select().from(followUps).where(eq(followUps.careItemId, restricted.id));
    expect(made.filter((f) => f.forLead).every((f) => f.ownerUserId === t.clergy.id)).toBe(true);
    expect(made.some((f) => f.ownerUserId === lead.id)).toBe(false);
    expect(await listLeadSteps(db, lead, NOW)).toEqual([]);
    expect(await listFollowUps(db, lead, {})).toEqual([]);
    const [run] = await db.select().from(careItemJourneys).where(eq(careItemJourneys.careItemId, restricted.id));
    expect(run.leadUserId).toBeNull();
    // A restricted item's step cannot be handed to a lead later either.
    const step = made.find((f) => f.forLead)!;
    await expect(updateFollowUp(db, t.clergy, step.id, { ownerUserId: lead.id })).rejects.toBeInstanceOf(InvalidInput);
    // Even forced onto a lead, the policy hides a step on a restricted item.
    await db.update(followUps).set({ ownerUserId: lead.id }).where(eq(followUps.careItemId, restricted.id));
    expect(await listLeadSteps(db, lead, NOW)).toEqual([]);
    const access = { ownerUserId: lead.id, forLead: true, careItem: { ownerUserId: t.clergy.id, restricted: true, named: false } };
    expect(canSeeFollowUp(lead, access)).toBe(false);
  });

  it("a lead step can be handed to another lead, never to staff; an inactive lead is not chosen", async () => {
    const { db, t, lead, staff, item } = await withLeadSteps();
    const other = await addActor(db, "lead2@example.test", "lead");
    const [step] = await listLeadSteps(db, lead, NOW);
    await updateFollowUp(db, t.clergy, step.id, { ownerUserId: other.id });
    expect((await listLeadSteps(db, other, NOW)).map((s) => s.id)).toEqual([step.id]);
    await expect(updateFollowUp(db, t.clergy, step.id, { ownerUserId: staff.id })).rejects.toBeInstanceOf(InvalidInput);
    // A clergy step cannot go to a lead.
    const clergyStep = (await listFollowUps(db, t.clergy, { careItemId: item.id })).find((f) => !f.forLead)!;
    await expect(updateFollowUp(db, t.clergy, clergyStep.id, { ownerUserId: other.id })).rejects.toBeInstanceOf(InvalidInput);
    const gone = await addActor(db, "lead3@example.test", "lead", false);
    const item2 = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Sam Cohen", category: "birth" });
    await expect(startJourney(db, t.clergy, item2.id, { templateKey: "new_baby", anchorDate: "2026-11-25", leadUserId: gone.id }, NOW)).rejects.toBeInstanceOf(InvalidInput);
  });

  it("caregivers, staff and senior staff are unchanged: none of them sees a journey step", async () => {
    const { db, t, staff, senior } = await withLeadSteps();
    for (const a of [t.carer, staff, senior] as Actor[]) {
      expect(await listFollowUps(db, a, {})).toEqual([]);
      expect(await listLeadSteps(db, a, NOW)).toEqual([]);
    }
    const access = { ownerUserId: staff.id, forLead: true, careItem: { ownerUserId: t.clergy.id, restricted: false, named: false } };
    expect([canSeeFollowUp(staff, access), canEditFollowUp(staff, access), canSeeFollowUp({ ...senior }, { ...access, ownerUserId: senior.id })]).toEqual([false, false, false]);
  });
});

describe("journey templates in Settings", () => {
  it("owner and clergy edit steps; the change affects only journeys started afterwards; reset restores the default", async () => {
    const { db, t, item } = await setup();
    const before = await startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW);
    const [illness] = (await listJourneyTemplates(db, t.owner)).filter((x) => x.key === "illness");
    expect(illness.isDefault).toBe(true);
    const edited = [{ ...illness.steps[0], title: "Visit", rule: { kind: "days" as const, days: 1 } }, { id: "step_1", title: "Send a card", who: "clergy" as const, rule: { kind: "days" as const, days: 5 } }];
    expect((await saveJourneyTemplate(db, t.clergy2, "illness", edited)).isDefault).toBe(false);
    expect((await steps(db, before.journeyId)).length).toBe(6);
    await endJourney(db, t.clergy, before.journeyId, NOW);
    const after = await startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW);
    expect((await steps(db, after.journeyId)).map((s) => [s.title, s.due])).toEqual([
      ["Visit", "2026-11-26"],
      ["Send a card", "2026-11-30"],
    ]);
    await resetJourneyTemplate(db, t.owner, "illness");
    const [row] = await db.select().from(journeyTemplates).where(eq(journeyTemplates.key, "illness"));
    expect(row.steps).toEqual(DEFAULT_TEMPLATES.illness.steps);
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "journey_template.update"))).map((a) => a.detail)).toEqual([{ templateKey: "illness", count: 2 }]);
  });

  it("is refused for every other role, and a step that does not fit its template is refused", async () => {
    const { db, t, lead, staff, senior } = await setup();
    for (const a of [t.carer, lead, staff, senior]) {
      await expect(listJourneyTemplates(db, a)).rejects.toBeInstanceOf(AccessDenied);
      await expect(saveJourneyTemplate(db, a, "illness", DEFAULT_TEMPLATES.illness.steps)).rejects.toBeInstanceOf(AccessDenied);
      await expect(resetJourneyTemplate(db, a, "illness")).rejects.toBeInstanceOf(AccessDenied);
    }
    const bad = [
      [{ id: "x", title: "Before Pesach", who: "clergy", rule: { kind: "before_pesach", days: 14 } }], // not an illness rule
      [{ id: "x", title: "Lead", who: "lead", rule: { kind: "every" } }], // standing has no lead steps
      [],
    ];
    await expect(saveJourneyTemplate(db, t.clergy, "illness", bad[0])).rejects.toBeInstanceOf(InvalidInput);
    await expect(saveJourneyTemplate(db, t.clergy, "standing", bad[1])).rejects.toBeInstanceOf(InvalidInput);
    await expect(saveJourneyTemplate(db, t.clergy, "illness", bad[2])).rejects.toBeInstanceOf(InvalidInput);
  });

  it("the migration seeds exactly the defaults in code", async () => {
    const { db } = await setup();
    const rows = await db.select().from(journeyTemplates);
    expect(rows.map((r) => r.key).sort()).toEqual([...JOURNEY_KEYS].sort());
    for (const r of rows) expect([r.name, r.steps]).toEqual([DEFAULT_TEMPLATES[r.key as (typeof JOURNEY_KEYS)[number]].name, DEFAULT_TEMPLATES[r.key as (typeof JOURNEY_KEYS)[number]].steps]);
  });
});

describe("review round", () => {
  it("two completions racing make one next standing step; reopening a done step removes the next one", async () => {
    const { db, t, item } = await setup();
    const { journeyId, followUpIds } = await startJourney(db, t.clergy, item.id, { templateKey: "standing", anchorDate: "2026-11-25", intervalWeeks: 2 }, NOW);
    await db.update(followUps).set({ doneAt: NOW }).where(eq(followUps.id, followUpIds[0]));
    const made = await Promise.all([ensureNextStandingStep(db, journeyId, NOW), ensureNextStandingStep(db, journeyId, NOW), ensureNextStandingStep(db, journeyId, NOW)]);
    expect(made.filter(Boolean)).toHaveLength(1);
    expect((await steps(db, journeyId)).filter((s) => !s.done)).toHaveLength(1);
    await setFollowUpDone(db, t.clergy, followUpIds[0], false);
    expect((await steps(db, journeyId)).map((s) => s.done)).toEqual([false]);
    // Done again: one next step, never two.
    await setFollowUpDone(db, t.clergy, followUpIds[0], true, { now: NOW });
    expect((await steps(db, journeyId)).filter((s) => !s.done)).toHaveLength(1);
  });

  it("reopening a step of another journey leaves its other steps alone", async () => {
    const { db, t, item } = await setup();
    const { journeyId, followUpIds } = await startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate: "2026-11-25" }, NOW);
    await setFollowUpDone(db, t.clergy, followUpIds[0], true, { now: NOW });
    await setFollowUpDone(db, t.clergy, followUpIds[0], false);
    expect(await steps(db, journeyId)).toHaveLength(6);
  });

  it("the next standing step is left unassigned when the item's holder can no longer hold it", async () => {
    const { db, t, item } = await setup();
    const { journeyId, followUpIds } = await startJourney(db, t.clergy, item.id, { templateKey: "standing", anchorDate: "2026-11-25" }, NOW);
    await db.update(users).set({ active: false }).where(eq(users.id, t.clergy.id));
    await setFollowUpDone(db, t.clergy2, followUpIds[0], true, { now: NOW });
    const open = (await steps(db, journeyId)).filter((s) => !s.done);
    expect(open.map((s) => s.owner)).toEqual([null]);
    // Unassigned work shows on clergy Today once due.
    const due = await getTodayCare(db, t.clergy2, open[0].due);
    expect(due.due.some((f) => f.journeyId === journeyId)).toBe(true);
  });

  it("restricting an item hands a lead's open steps to its owner, still for Mitzvah Corps", async () => {
    const { db, t, lead, item } = await setup();
    const { journeyId } = await startJourney(db, t.clergy, item.id, { templateKey: "bereavement_year", anchorDate: DEATH }, NOW);
    await updateCareItem(db, t.clergy, item.id, { restricted: true });
    const leadSteps = (await steps(db, journeyId)).filter((s) => s.forLead);
    expect(leadSteps.every((s) => s.owner === t.clergy.id)).toBe(true);
    expect(await listLeadSteps(db, lead, NOW)).toEqual([]);
  });

  it("a lead's step is completed once, and audited with ids only", async () => {
    const { db, t, lead, item } = await setup();
    await startJourney(db, t.clergy, item.id, { templateKey: "bereavement_year", anchorDate: DEATH }, NOW);
    const [step] = await listLeadSteps(db, lead, NOW);
    await Promise.allSettled([completeLeadStep(db, lead, step.id, "first", NOW), completeLeadStep(db, lead, step.id, "second", NOW)]);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "follow_up.lead_done"));
    expect(audit.map((a) => [a.actorUserId, a.subjectId, a.detail])).toEqual([[lead.id, step.id, { careItemId: item.id }]]);
  });

  it("a death inside the 14 days before Rosh Hashanah or Pesach dates the note before NEXT year's", () => {
    const steps = DEFAULT_TEMPLATES.bereavement_year.steps;
    const due = (death: string) => Object.fromEntries(planJourney("bereavement_year", steps, { anchorDate: death, secondDate: null, intervalWeeks: null, today: death }).map((s) => [s.stepId, s.dueDate]));
    // Rosh Hashanah 5788 is 2 October 2027; a death on 25 September is inside the 14 days.
    expect(due("2027-09-25").note_high_holidays).toBe(addDays(firstRoshHashanahAfter("2027-09-25", 1), -14));
    expect(due("2027-09-10").note_high_holidays).toBe("2027-09-18");
    // Pesach 5787 is 22 April 2027.
    expect(due("2027-04-15").note_pesach).toBe(addDays(firstPesachAfter("2027-04-15", 1), -14));
    expect(due("2027-04-01").note_pesach).toBe("2027-04-08");
  });

  it("the start date is between 400 days ago and 60 days ahead", async () => {
    const { db, t, item } = await setup();
    for (const anchorDate of ["2025-10-20", "2027-01-25"]) await expect(startJourney(db, t.clergy, item.id, { templateKey: "illness", anchorDate }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(previewJourney(db, t.clergy, { templateKey: "illness", anchorDate: "2026-11-25" }, "2026-11-25")).resolves.toBeTruthy();
    await expect(startJourney(db, t.clergy, item.id, { templateKey: "new_baby", anchorDate: "2027-01-24" }, NOW)).resolves.toBeTruthy();
  });
});
