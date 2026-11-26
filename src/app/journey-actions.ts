"use server";

import type { ActionState } from "@/lib/action-state";
import { fields, runAction, runData, type DataState } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import { setCorpsNote, setKeepNotes } from "@/server/care/care-items";
import { completeLeadStep } from "@/server/care/follow-ups";
import { setSummaryPref } from "@/server/daily/summary";
import { endJourney, previewJourney, startJourney, type JourneyOptions, type JourneyPreview } from "@/server/journeys/journeys";
import { newStepId, resetJourneyTemplate, saveJourneyTemplate } from "@/server/journeys/template-store";
import { RULE_KINDS, type JourneyStep, type RuleKind } from "@/server/journeys/templates";

type F = Record<string, string | undefined>;

/** The journey fields of a form (the start sheet, or the accept sheet), as startJourney expects them. */
function journeyFrom(form: FormData, f: F): JourneyOptions {
  return {
    templateKey: f.journeyKey,
    anchorDate: f.journeyAnchor,
    secondDate: f.journeySecond || undefined,
    intervalWeeks: f.journeyInterval || undefined,
    // The lead picker sends "" for "no lead": the owner holds those steps. Absent (no lead step ticked): the default.
    leadUserId: f.journeyLead,
    // Only a previewed list is a choice of steps; without one, every step is made.
    stepIds: f.journeyPreviewed === "yes" ? form.getAll("journeyStep").filter((v): v is string => typeof v === "string") : undefined,
  };
}

/** The steps a journey would make, with dates, for the preview. Nothing is saved. */
export async function previewJourneyAction(input: { templateKey: string; anchorDate: string; secondDate?: string; intervalWeeks?: string }): Promise<DataState<JourneyPreview>> {
  return runData(await getViewer(), (actor, db) =>
    previewJourney(db, actor, { templateKey: input.templateKey, anchorDate: input.anchorDate, secondDate: input.secondDate || undefined, intervalWeeks: input.intervalWeeks || undefined }),
  );
}

export async function startJourneyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const { followUpIds } = await startJourney(db, actor, f.careItemId, journeyFrom(form, f));
    return followUpIds.length === 1 ? "Journey started: 1 step added." : `Journey started: ${followUpIds.length} steps added.`;
  });
}

export async function endJourneyAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await endJourney(db, actor, f.journeyId);
    return "Journey ended.";
  });
}

/** A Mitzvah Corps lead marks their step done, with a one-line outcome for the clergy. */
export async function completeLeadStepAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await completeLeadStep(db, actor, f.followUpId, f.outcome ?? "");
    return "Done. Thank you.";
  });
}

/** The clergy's logistics-only line for Mitzvah Corps on a care item (not on a restricted one: the server refuses). */
export async function setCorpsNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const item = await setCorpsNote(db, actor, f.careItemId, f.corpsNote ?? "");
    return item.corpsNote ? "Saved." : "Cleared.";
  });
}

export async function setKeepNotesAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    const keep = f.keep === "true";
    await setKeepNotes(db, actor, f.careItemId, keep);
    return keep ? "These notes will be kept." : "These notes follow the usual rule again.";
  });
}

export async function setSummaryPrefAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await setSummaryPref(db, actor, f.summaryPref);
    return "Saved.";
  });
}

/** The edited steps of one template: step_<n>_* fields in order, removed ones left out, and one new step when its title is filled in. */
function stepsFrom(f: F): JourneyStep[] {
  const count = Number(f.stepCount ?? "0");
  const steps: JourneyStep[] = [];
  for (let i = 0; i < count && i < 40; i++) {
    if (f[`step_${i}_remove`] === "on") continue;
    steps.push(stepOf(f, `step_${i}`, f[`step_${i}_id`] ?? ""));
  }
  if (f.new_title?.trim()) steps.push(stepOf(f, "new", newStepId(steps.map((s) => s.id))));
  return steps;
}

function stepOf(f: F, p: string, id: string): JourneyStep {
  const kind = (RULE_KINDS as readonly string[]).includes(f[`${p}_rule`] ?? "") ? (f[`${p}_rule`] as RuleKind) : "days";
  const n = Number(f[`${p}_amount`] ?? "0");
  const rule = kind === "every" ? { kind } : kind === "months" ? { kind, months: n } : { kind, days: n };
  const link = f[`${p}_link`] === "meals" ? ({ link: "meals" } as const) : {};
  return { id, title: f[`${p}_title`] ?? "", who: f[`${p}_who`] === "lead" ? "lead" : "clergy", rule, ...link } as JourneyStep;
}

export async function saveJourneyTemplateAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    if (f.intent === "reset") {
      await resetJourneyTemplate(db, actor, f.templateKey);
      return "Back to the default steps. Journeys started from now on use them.";
    }
    await saveJourneyTemplate(db, actor, f.templateKey, stepsFrom(f));
    return "Saved. Journeys started from now on use these steps.";
  });
}
