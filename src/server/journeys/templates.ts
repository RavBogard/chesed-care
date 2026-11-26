/**
 * The journey templates: their steps, the rules that date each step, and the
 * defaults the migration seeds (and "Reset to the default" restores). PURE.
 *
 * A step is for the clergy (it goes to the care item's owner) or for the Mitzvah
 * Corps lead (it goes to the lead chosen at the start, or to the owner marked
 * "for Mitzvah Corps"). Titles are plain and carry no diagnosis or note.
 */
import { z } from "zod";

export const JOURNEY_KEYS = ["bereavement_year", "illness", "standing", "new_baby"] as const;
export type JourneyKey = (typeof JOURNEY_KEYS)[number];

/** How a step is dated. Days and months count from the start date; the rest from the dates named. */
export const RULE_KINDS = ["days", "months", "after_second", "before_rosh_hashana", "before_pesach", "before_first_yahrzeit", "every"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const STEP_WHO = ["clergy", "lead"] as const;
export type StepWho = (typeof STEP_WHO)[number];

const amount = z.number().int().min(0).max(400);
export const stepRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("days"), days: amount }),
  z.strictObject({ kind: z.literal("months"), months: z.number().int().min(0).max(24) }),
  z.strictObject({ kind: z.literal("after_second"), days: amount }),
  z.strictObject({ kind: z.literal("before_rosh_hashana"), days: z.number().int().min(0).max(60) }),
  z.strictObject({ kind: z.literal("before_pesach"), days: z.number().int().min(0).max(60) }),
  z.strictObject({ kind: z.literal("before_first_yahrzeit"), days: z.number().int().min(0).max(60) }),
  z.strictObject({ kind: z.literal("every") }),
]);
export type StepRule = z.infer<typeof stepRuleSchema>;

export const stepSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/),
  title: z.string().trim().min(1).max(120),
  who: z.enum(STEP_WHO),
  rule: stepRuleSchema,
  link: z.literal("meals").optional(),
});
export type JourneyStep = z.infer<typeof stepSchema>;
export const MAX_STEPS = 20;
export const stepsSchema = z.array(stepSchema).min(1).max(MAX_STEPS);

/** What each template is anchored on, and which rules and roles its steps may use. Fixed in code; only the steps are edited. */
export type TemplateMeta = {
  anchorLabel: string;
  /** The second date (funeral, discharge), and how many days after the start it is taken to be when it is not known. */
  second: { label: string; fallbackDays: number | null } | null;
  rules: readonly RuleKind[];
  leadSteps: boolean;
  /** A standing check-in: one step, made again each time the last is done. */
  standing: boolean;
};

export const TEMPLATE_META: Record<JourneyKey, TemplateMeta> = {
  bereavement_year: {
    anchorLabel: "Date of death",
    second: { label: "Funeral date (if known)", fallbackDays: null },
    rules: ["days", "months", "before_rosh_hashana", "before_pesach", "before_first_yahrzeit"],
    leadSteps: true,
    standing: false,
  },
  illness: { anchorLabel: "Start date", second: { label: "Discharge date (if known)", fallbackDays: 7 }, rules: ["days", "months", "after_second"], leadSteps: true, standing: false },
  standing: { anchorLabel: "Start date", second: null, rules: ["every"], leadSteps: false, standing: true },
  new_baby: { anchorLabel: "Date of birth or the simcha", second: null, rules: ["days", "months"], leadSteps: true, standing: false },
};

/** Standing check-ins: every 4 weeks unless changed, between 1 and 26. */
export const STANDING_DEFAULT_WEEKS = 4;
export const STANDING_MIN_WEEKS = 1;
export const STANDING_MAX_WEEKS = 26;

const clergy = (id: string, title: string, rule: StepRule): JourneyStep => ({ id, title, who: "clergy", rule });
const lead = (id: string, title: string, rule: StepRule, link?: "meals"): JourneyStep => ({ id, title, who: "lead", rule, ...(link ? { link } : {}) });

/** Draft steps from Daniel's answers of 2026-11-24, editable in Settings. */
export const DEFAULT_TEMPLATES: Record<JourneyKey, { name: string; steps: JourneyStep[] }> = {
  bereavement_year: {
    name: "Bereavement year",
    steps: [
      clergy("call_on_hearing", "Call on hearing", { kind: "days", days: 0 }),
      clergy("funeral_shiva_details", "Record the funeral and shiva details", { kind: "days", days: 0 }),
      clergy("shiva_visit", "Shiva visit", { kind: "days", days: 2 }),
      clergy("call_week_two", "Call in the second week", { kind: "days", days: 10 }),
      clergy("shloshim", "Shloshim: be in touch", { kind: "days", days: 30 }),
      clergy("plan_unveiling", "Plan the unveiling", { kind: "months", months: 11 }),
      clergy("note_high_holidays", "A note before the first High Holidays without them", { kind: "before_rosh_hashana", days: 14 }),
      clergy("note_pesach", "A note before the first Pesach without them", { kind: "before_pesach", days: 14 }),
      clergy("call_first_yahrzeit", "Call before the first yahrzeit", { kind: "before_first_yahrzeit", days: 7 }),
      lead("arrange_meals", "Arrange meals", { kind: "days", days: 0 }, "meals"),
      lead("arrange_minyan", "Arrange the shiva minyan", { kind: "days", days: 0 }),
      lead("check_in_month_3", "Check-in call, three months on", { kind: "months", months: 3 }),
      lead("check_in_month_6", "Check-in call, six months on", { kind: "months", months: 6 }),
    ],
  },
  illness: {
    name: "Illness and hospital",
    steps: [
      clergy("visit_or_call", "Visit or call", { kind: "days", days: 0 }),
      clergy("ask_meals_rides", "Ask about meals, rides and the Mi Sheberach list", { kind: "days", days: 1 }),
      clergy("after_discharge", "Check in after discharge", { kind: "after_second", days: 0 }),
      clergy("week_after_discharge", "Check in, one week after discharge", { kind: "after_second", days: 7 }),
      clergy("three_weeks_after_discharge", "Check in, three weeks after discharge", { kind: "after_second", days: 21 }),
      clergy("close_or_continue", "Close this care, or keep going?", { kind: "days", days: 42 }),
    ],
  },
  standing: {
    name: "Standing check-in",
    steps: [clergy("be_in_touch", "Be in touch", { kind: "every" })],
  },
  new_baby: {
    name: "New baby and simchas",
    steps: [
      clergy("mazal_tov_call", "Mazal tov call", { kind: "days", days: 0 }),
      clergy("ask_naming_bris", "Ask about the naming or bris", { kind: "days", days: 3 }),
      lead("meals_for_parents", "Arrange meals for the parents", { kind: "days", days: 0 }, "meals"),
      clergy("check_in_month_3", "Check in, three months on", { kind: "months", months: 3 }),
    ],
  },
};

/** Whether a list of steps fits its template: allowed rules and roles, unique ids, and one "every" step for a standing check-in. */
export function stepsFit(key: JourneyKey, steps: JourneyStep[]): boolean {
  const meta = TEMPLATE_META[key];
  if (new Set(steps.map((s) => s.id)).size !== steps.length) return false;
  if (meta.standing && steps.length !== 1) return false;
  return steps.every((s) => meta.rules.includes(s.rule.kind) && (meta.leadSteps || s.who === "clergy") && (s.link === undefined || s.who === "lead"));
}

/** The stored steps, or null when they do not parse (a template is then treated as unavailable). */
export function storedSteps(key: JourneyKey, value: unknown): JourneyStep[] | null {
  const parsed = stepsSchema.safeParse(value);
  return parsed.success && stepsFit(key, parsed.data) ? parsed.data : null;
}

export function isJourneyKey(v: unknown): v is JourneyKey {
  return typeof v === "string" && (JOURNEY_KEYS as readonly string[]).includes(v);
}
