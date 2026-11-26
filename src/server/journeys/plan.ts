/**
 * The dates of a journey's steps. PURE: no I/O, no clock (today is passed in).
 *
 * Days and months count from the start date (the date of death, the day an illness
 * began, the birth). The Jewish-calendar steps use @hebcal/core, the calendar the
 * app already uses: the first Rosh Hashanah and the first Pesach after the death,
 * and the first yahrzeit on the HEBREW date of death. A civil date is taken as a
 * whole day, as everywhere in the app (src/lib/hebrew-date.ts): a death after
 * sunset is entered by clergy with the next day's date if they want the later one.
 * A step whose date has already passed is due today, never in the past.
 */
import { HDate, HebrewCalendar, months } from "@hebcal/core";
import { addDays, parseDate } from "@/server/lifecycle/window";
import type { JourneyKey, JourneyStep, StepWho } from "./templates";
import { STANDING_DEFAULT_WEEKS, TEMPLATE_META } from "./templates";

export type PlanInput = {
  /** YYYY-MM-DD */
  anchorDate: string;
  secondDate: string | null;
  /** A standing check-in's interval. */
  intervalWeeks: number | null;
  today: string;
};

export type PlannedStep = { stepId: string; title: string; who: StepWho; dueDate: string; link: "meals" | null };

const local = (key: string): Date => {
  const p = parseDate(key)!;
  return new Date(p.year, p.month - 1, p.day);
};
const keyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The same day n months on; a day the month does not have becomes its last day (31 Jan + 1 month = 28 or 29 Feb). */
export function addMonths(key: string, n: number): string {
  const p = parseDate(key)!;
  const total = p.month - 1 + n;
  const year = p.year + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(Math.min(p.day, last)).padStart(2, "0")}`;
}

/** 1 Tishrei of the next Hebrew year (or `skip` years later): the first Rosh Hashanah after the day. */
export function firstRoshHashanahAfter(day: string, skip = 0): string {
  const year = new HDate(local(day)).getFullYear();
  return keyOf(new HDate(1, months.TISHREI, year + 1 + skip).greg());
}

/** 15 Nisan: the first Pesach after the day (or `skip` years later; Nisan falls in the second half of a Hebrew year). */
export function firstPesachAfter(day: string, skip = 0): string {
  const date = local(day);
  const year = new HDate(date).getFullYear();
  const thisYear = new HDate(15, months.NISAN, year).greg();
  return keyOf(new HDate(15, months.NISAN, (thisYear > date ? year : year + 1) + skip).greg());
}

/**
 * A note `days` before a holiday. When the death falls inside those days, there is no time
 * for the note before this year's: it is for the next year's, the first one met in mourning.
 */
function noteBefore(anchor: string, days: number, holiday: (day: string, skip?: number) => string): string {
  const first = addDays(holiday(anchor), -days);
  return first >= anchor ? first : addDays(holiday(anchor, 1), -days);
}

/** The first yahrzeit: the anniversary of the death on the Hebrew calendar, one Hebrew year on. */
export function firstYahrzeit(deathDate: string): string {
  const date = local(deathDate);
  const year = new HDate(date).getFullYear();
  const yahrzeit = HebrewCalendar.getYahrzeit(year + 1, date);
  if (!yahrzeit) throw new Error("No yahrzeit");
  return keyOf(yahrzeit.greg());
}

function dateOf(key: JourneyKey, step: JourneyStep, input: PlanInput): string {
  const rule = step.rule;
  switch (rule.kind) {
    case "days":
      return addDays(input.anchorDate, rule.days);
    case "months":
      return addMonths(input.anchorDate, rule.months);
    case "after_second": {
      const fallback = TEMPLATE_META[key].second?.fallbackDays ?? 0;
      return addDays(input.secondDate ?? addDays(input.anchorDate, fallback), rule.days);
    }
    case "before_rosh_hashana":
      return noteBefore(input.anchorDate, rule.days, firstRoshHashanahAfter);
    case "before_pesach":
      return noteBefore(input.anchorDate, rule.days, firstPesachAfter);
    case "before_first_yahrzeit":
      return addDays(firstYahrzeit(input.anchorDate), -rule.days);
    case "every":
      return addDays(input.anchorDate, 7 * (input.intervalWeeks ?? STANDING_DEFAULT_WEEKS));
  }
}

/** Every step of a template with its due date, in date order (the template's order within a day). */
export function planJourney(key: JourneyKey, steps: JourneyStep[], input: PlanInput): PlannedStep[] {
  const planned = steps.map((step, i) => {
    const due = dateOf(key, step, input);
    return { i, step: { stepId: step.id, title: step.title, who: step.who, dueDate: due < input.today ? input.today : due, link: step.link ?? null } };
  });
  return planned.sort((a, b) => a.step.dueDate.localeCompare(b.step.dueDate) || a.i - b.i).map((p) => p.step);
}
