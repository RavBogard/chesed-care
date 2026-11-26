/**
 * Journeys: a template that, started on a care item, makes its steps as ordinary
 * follow-ups. Clergy steps go to the item's owner; Mitzvah Corps steps go to the
 * lead chosen at the start, or to the owner marked "for Mitzvah Corps" when there is
 * no lead, none was chosen, or the item is restricted (a restricted item never
 * reaches a lead). Access: src/server/access/policy.ts.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { canHoldLeadStep, canStartJourney, careItemVisibleWhere, deny, isClergyLevel, type Actor } from "@/server/access/policy";
import { careItemJourneys, careItems, followUps, journeyTemplates, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { writeAudit } from "@/server/care/audit";
import { assertCanHoldWorkOn, loadVisibleCareItemAccess, type CareItem } from "@/server/care/care-items";
import { dateField, dateWithin, InvalidInput, NotFound, oneOf, uuidField, uuidOrNotFound } from "@/server/care/validate";
import { addDays, chicagoToday } from "@/server/lifecycle/window";
import { endJourneyRun } from "./lifecycle";
import { planJourney, type PlannedStep } from "./plan";
import { JOURNEY_KEYS, STANDING_DEFAULT_WEEKS, STANDING_MAX_WEEKS, STANDING_MIN_WEEKS, TEMPLATE_META, storedSteps, type JourneyKey, type JourneyStep } from "./templates";

export type JourneyOptions = {
  templateKey: unknown;
  anchorDate: unknown;
  secondDate?: unknown;
  intervalWeeks?: unknown;
  /** The lead for the Mitzvah Corps steps. Undefined: the only active lead, if there is exactly one. Null or "": none (the owner holds them). */
  leadUserId?: unknown;
  /** The step ids to make (the ticked ones). Undefined: every step. */
  stepIds?: unknown;
};

export type ActiveLead = { id: string; name: string };
export type JourneyPreview = { key: JourneyKey; name: string; steps: PlannedStep[]; leads: ActiveLead[]; defaultLeadId: string | null };

type Parsed = { key: JourneyKey; name: string; steps: JourneyStep[]; anchorDate: string; secondDate: string | null; intervalWeeks: number | null };

async function loadTemplate(db: Db, key: JourneyKey): Promise<{ name: string; steps: JourneyStep[] }> {
  const [row] = await db.select().from(journeyTemplates).where(eq(journeyTemplates.key, key)).limit(1);
  const steps = row && row.active ? storedSteps(key, row.steps) : null;
  if (!row || !steps) throw new InvalidInput("templateKey");
  return { name: row.name, steps };
}

function intervalOf(key: JourneyKey, value: unknown): number | null {
  if (!TEMPLATE_META[key].standing) return null;
  if (value === undefined || value === null || value === "") return STANDING_DEFAULT_WEEKS;
  const n = typeof value === "string" && /^\d{1,2}$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < STANDING_MIN_WEEKS || n > STANDING_MAX_WEEKS) throw new InvalidInput("intervalWeeks");
  return n;
}

/** How far back a journey may start (a death learned of late) and how far ahead (a planned simcha). */
export const ANCHOR_DAYS_BACK = 400;
export const ANCHOR_DAYS_AHEAD = 60;

async function parse(db: Db, input: JourneyOptions, today: string): Promise<Parsed> {
  const key = oneOf(input.templateKey, "templateKey", JOURNEY_KEYS);
  const template = await loadTemplate(db, key);
  const secondDate = TEMPLATE_META[key].second && input.secondDate !== undefined && input.secondDate !== null && input.secondDate !== "" ? dateField(input.secondDate, "secondDate") : null;
  const anchorDate = dateWithin(input.anchorDate, "anchorDate", addDays(today, -ANCHOR_DAYS_BACK), addDays(today, ANCHOR_DAYS_AHEAD));
  return { key, ...template, anchorDate, secondDate, intervalWeeks: intervalOf(key, input.intervalWeeks) };
}

export type JourneyChoice = { key: JourneyKey; name: string; anchorLabel: string; secondLabel: string | null; standing: boolean };

/** The journeys that can be started, for the start and accept sheets. Clergy level. */
export async function listJourneyChoices(db: Db, actor: Actor): Promise<JourneyChoice[]> {
  if (!isClergyLevel(actor)) deny();
  const rows = await db.select({ key: journeyTemplates.key, name: journeyTemplates.name, active: journeyTemplates.active, steps: journeyTemplates.steps }).from(journeyTemplates);
  return JOURNEY_KEYS.flatMap((key) => {
    const row = rows.find((r) => r.key === key);
    if (!row || !row.active || !storedSteps(key, row.steps)) return [];
    const meta = TEMPLATE_META[key];
    return [{ key, name: row.name, anchorLabel: meta.anchorLabel, secondLabel: meta.second?.label ?? null, standing: meta.standing }];
  });
}

/** Active leads, for choosing who holds the Mitzvah Corps steps. Names only. */
export async function listActiveLeads(db: Db, actor: Actor): Promise<ActiveLead[]> {
  if (!isClergyLevel(actor)) deny();
  const rows = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(eq(users.role, "lead"), eq(users.active, true))).orderBy(asc(users.name), asc(users.email));
  return rows.map((r) => ({ id: r.id, name: r.name ?? r.email }));
}

/** The steps a journey would make, with their dates, before anything is saved. Clergy level. */
export async function previewJourney(db: Db, actor: Actor, input: JourneyOptions, today: string = chicagoToday(new Date())): Promise<JourneyPreview> {
  if (!isClergyLevel(actor)) deny();
  const p = await parse(db, input, today);
  const leads = await listActiveLeads(db, actor);
  return { key: p.key, name: p.name, steps: planJourney(p.key, p.steps, { ...p, today }), leads, defaultLeadId: leads.length === 1 ? leads[0].id : null };
}

/** Start a journey on a care item the actor fully sees (clergy level). Refused while the same journey is running on it. */
export async function startJourney(db: Db, actor: Actor, careItemId: unknown, input: JourneyOptions, now: Date = new Date()): Promise<{ journeyId: string; followUpIds: string[] }> {
  const { item, access } = await loadVisibleCareItemAccess(db, actor, careItemId);
  if (!canStartJourney(actor, access)) deny();
  return db.transaction((tx) => createJourneyRun(tx, actor, item, input, now));
}

/**
 * Make the run and its steps. For a caller that has already decided the actor may
 * start a journey on this item: startJourney, and accepting a proposal (whose
 * acceptor may be opening a restricted item for a colleague).
 */
export async function createJourneyRun(db: Db, actor: Actor, item: CareItem, input: JourneyOptions, now: Date): Promise<{ journeyId: string; followUpIds: string[] }> {
  if (item.status === "closed") throw new InvalidInput("careItemId");
  const today = chicagoToday(now);
  const p = await parse(db, input, today);
  const running = await db
    .select({ id: careItemJourneys.id })
    .from(careItemJourneys)
    .where(and(eq(careItemJourneys.careItemId, item.id), eq(careItemJourneys.templateKey, p.key), isNull(careItemJourneys.endedAt)))
    .limit(1);
  if (running.length > 0) throw new InvalidInput("alreadyRunning");

  let planned = planJourney(p.key, p.steps, { ...p, today });
  if (input.stepIds !== undefined) {
    if (!Array.isArray(input.stepIds) || input.stepIds.some((id) => typeof id !== "string")) throw new InvalidInput("stepIds");
    const ticked = new Set(input.stepIds as string[]);
    planned = planned.filter((s) => ticked.has(s.stepId));
  }
  if (planned.length === 0) throw new InvalidInput("stepIds");

  await assertCanHoldWorkOn(db, item.ownerUserId, item);
  const leadUserId = planned.some((s) => s.who === "lead") ? await leadFor(db, item, input.leadUserId) : null;

  const [run] = await db
    .insert(careItemJourneys)
    .values({ careItemId: item.id, templateKey: p.key, startedBy: actor.id, startedAt: now, anchorDate: p.anchorDate, secondDate: p.secondDate, intervalWeeks: p.intervalWeeks, leadUserId })
    .returning({ id: careItemJourneys.id });
  const person = { sfContactId: item.sfContactId, outsidePersonId: item.outsidePersonId, sfAccountId: item.sfAccountId, displayName: item.displayName };
  const made = await db
    .insert(followUps)
    .values(
      planned.map((s) => ({
        careItemId: item.id,
        ...person,
        title: s.title,
        dueDate: s.dueDate,
        ownerUserId: s.who === "lead" ? (leadUserId ?? item.ownerUserId) : item.ownerUserId,
        forLead: s.who === "lead",
        link: s.link,
        journeyId: run.id,
        createdBy: actor.id,
        createdAt: now,
      })),
    )
    .returning({ id: followUps.id });
  await writeAudit(db, actor, "journey.start", "journey", run.id, { careItemId: item.id, templateKey: p.key, count: made.length });
  return { journeyId: run.id, followUpIds: made.map((m) => m.id) };
}

/** Who holds the Mitzvah Corps steps: a chosen active lead, the only active lead by default, or nobody (the owner holds them). Never a lead on a restricted item. */
async function leadFor(db: Db, item: CareItem, chosen: unknown): Promise<string | null> {
  if (item.restricted) return null;
  if (chosen === null || chosen === "") return null;
  if (chosen === undefined) {
    const leads = await db.select({ id: users.id, role: users.role, active: users.active }).from(users).where(and(eq(users.role, "lead"), eq(users.active, true))).limit(2);
    return leads.length === 1 && canHoldLeadStep(leads[0], item) ? leads[0].id : null;
  }
  const id = uuidField(chosen, "leadUserId");
  const [lead] = await db.select({ role: users.role, active: users.active }).from(users).where(eq(users.id, id)).limit(1);
  if (!lead || !canHoldLeadStep(lead, item)) throw new InvalidInput("leadUserId");
  return id;
}

/** End a journey: its steps still to do are removed (the screen asks first), the done ones stay. */
export async function endJourney(db: Db, actor: Actor, journeyId: unknown, now: Date = new Date()): Promise<{ removed: number }> {
  const [run] = await db.select().from(careItemJourneys).where(eq(careItemJourneys.id, uuidOrNotFound(journeyId))).limit(1);
  if (!run) throw new NotFound();
  const { access } = await loadVisibleCareItemAccess(db, actor, run.careItemId);
  if (!canStartJourney(actor, access)) deny();
  if (run.endedAt) throw new InvalidInput("ended");
  return db.transaction(async (tx) => {
    const removed = await endJourneyRun(tx, run.id, actor.id, now);
    await writeAudit(tx, actor, "journey.end", "journey", run.id, { careItemId: run.careItemId, templateKey: run.templateKey, count: removed });
    return { removed };
  });
}

export type JourneyStepView = { id: string; title: string; dueDate: string; done: boolean; forLead: boolean; ownerUserId: string | null; outcomeNote: string | null };
export type JourneyView = { id: string; careItemId: string; templateKey: string; name: string; anchorDate: string; intervalWeeks: number | null; ended: boolean; next: { title: string; dueDate: string } | null; steps: JourneyStepView[] };

/**
 * The journeys on care items the actor fully sees, running ones first, each with its
 * next step and its steps (a lead's one-line outcome included, for the owner to read).
 * Items the actor cannot fully see are left out whatever ids are asked for.
 */
export async function listJourneys(db: Db, actor: Actor, careItemIds: string[]): Promise<JourneyView[]> {
  // A caregiver sees only their own follow-ups, so a journey's whole list of steps is for clergy level.
  if (careItemIds.length === 0 || !isClergyLevel(actor)) return [];
  const runs = await db
    .select({ run: careItemJourneys, name: journeyTemplates.name })
    .from(careItemJourneys)
    .innerJoin(careItems, eq(careItems.id, careItemJourneys.careItemId))
    .innerJoin(journeyTemplates, eq(journeyTemplates.key, careItemJourneys.templateKey))
    .where(and(inArray(careItemJourneys.careItemId, careItemIds), careItemVisibleWhere(actor)))
    .orderBy(asc(careItemJourneys.startedAt));
  if (runs.length === 0) return [];
  const steps = await db
    .select()
    .from(followUps)
    .where(
      inArray(
        followUps.journeyId,
        runs.map((r) => r.run.id),
      ),
    )
    .orderBy(asc(followUps.dueDate), asc(followUps.createdAt));
  return runs
    .map(({ run, name }) => {
      const mine = steps.filter((s) => s.journeyId === run.id);
      const next = mine.find((s) => !s.doneAt) ?? null;
      return {
        id: run.id,
        careItemId: run.careItemId,
        templateKey: run.templateKey,
        name,
        anchorDate: run.anchorDate,
        intervalWeeks: run.intervalWeeks,
        ended: run.endedAt !== null,
        next: next ? { title: next.title, dueDate: next.dueDate } : null,
        steps: mine.map((s) => ({ id: s.id, title: s.title, dueDate: s.dueDate, done: s.doneAt !== null, forLead: s.forLead, ownerUserId: s.ownerUserId, outcomeNote: s.outcomeNote })),
      };
    })
    .sort((a, b) => Number(a.ended) - Number(b.ended));
}

/** The running templates on an item, so the screen does not offer to start one twice. */
export function runningKeys(journeys: JourneyView[], careItemId: string): Set<string> {
  return new Set(journeys.filter((j) => j.careItemId === careItemId && !j.ended).map((j) => j.templateKey));
}
