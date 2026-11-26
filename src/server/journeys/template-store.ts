/**
 * Editing the journey templates (Settings, owner and clergy): step titles and
 * offsets, adding and removing steps, and reset to the default. A change affects
 * only journeys started afterwards: running journeys already have their steps.
 */
import { asc, eq } from "drizzle-orm";
import { canEditJourneyTemplates, deny, type Actor } from "@/server/access/policy";
import { journeyTemplates } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { writeAudit } from "@/server/care/audit";
import { InvalidInput, oneOf } from "@/server/care/validate";
import { DEFAULT_TEMPLATES, JOURNEY_KEYS, stepsFit, stepsSchema, storedSteps, type JourneyKey, type JourneyStep } from "./templates";

export type TemplateView = { key: JourneyKey; name: string; active: boolean; steps: JourneyStep[]; isDefault: boolean };

/** The audit trail needs a uuid subject: one fixed id per template key. */
const AUDIT_ID: Record<JourneyKey, string> = {
  bereavement_year: "00000000-0000-4000-8000-000000000001",
  illness: "00000000-0000-4000-8000-000000000002",
  standing: "00000000-0000-4000-8000-000000000003",
  new_baby: "00000000-0000-4000-8000-000000000004",
};

const sameSteps = (a: JourneyStep[], b: JourneyStep[]) => JSON.stringify(a) === JSON.stringify(b);

export async function listJourneyTemplates(db: Db, actor: Actor): Promise<TemplateView[]> {
  if (!canEditJourneyTemplates(actor)) deny();
  const rows = await db.select().from(journeyTemplates).orderBy(asc(journeyTemplates.key));
  const views: TemplateView[] = [];
  for (const key of JOURNEY_KEYS) {
    const row = rows.find((r) => r.key === key);
    const steps = row ? storedSteps(key, row.steps) : null;
    if (!row || !steps) continue;
    views.push({ key, name: row.name, active: row.active, steps, isDefault: sameSteps(steps, DEFAULT_TEMPLATES[key].steps) });
  }
  return views;
}

/** Replace a template's steps. A new step without an id is given one. */
export async function saveJourneyTemplate(db: Db, actor: Actor, key: unknown, steps: unknown): Promise<TemplateView> {
  if (!canEditJourneyTemplates(actor)) deny();
  const k = oneOf(key, "templateKey", JOURNEY_KEYS);
  const parsed = stepsSchema.safeParse(steps);
  if (!parsed.success || !stepsFit(k, parsed.data)) throw new InvalidInput("steps");
  return db.transaction(async (tx) => {
    const [row] = await tx.update(journeyTemplates).set({ steps: parsed.data, updatedBy: actor.id }).where(eq(journeyTemplates.key, k)).returning();
    if (!row) throw new InvalidInput("templateKey");
    await writeAudit(tx, actor, "journey_template.update", "journey_template", AUDIT_ID[k], { templateKey: k, count: parsed.data.length });
    return { key: k, name: row.name, active: row.active, steps: parsed.data, isDefault: sameSteps(parsed.data, DEFAULT_TEMPLATES[k].steps) };
  });
}

export async function resetJourneyTemplate(db: Db, actor: Actor, key: unknown): Promise<TemplateView> {
  if (!canEditJourneyTemplates(actor)) deny();
  const k = oneOf(key, "templateKey", JOURNEY_KEYS);
  const steps = DEFAULT_TEMPLATES[k].steps;
  return db.transaction(async (tx) => {
    const [row] = await tx.update(journeyTemplates).set({ steps, updatedBy: actor.id }).where(eq(journeyTemplates.key, k)).returning();
    if (!row) throw new InvalidInput("templateKey");
    await writeAudit(tx, actor, "journey_template.reset", "journey_template", AUDIT_ID[k], { templateKey: k, count: steps.length });
    return { key: k, name: row.name, active: row.active, steps, isDefault: true };
  });
}

/** A fresh id for a step added in Settings. */
export function newStepId(existing: readonly string[]): string {
  for (let i = 1; ; i++) if (!existing.includes(`step_${i}`)) return `step_${i}`;
}
