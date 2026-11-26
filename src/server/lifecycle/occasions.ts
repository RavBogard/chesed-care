import { canSeeLifecycle, deny, type Actor } from "@/server/access/policy";
import { CACHE_SHAPE, cachedForDay } from "@/server/cache/day-cache";
import type { Db } from "@/server/db/types";
import type { SalesforceClient } from "@/server/salesforce/client";
import { fetchAnniversaries } from "./anniversaries";
import { fetchBirthdays } from "./birthdays";
import { proposeBereavementYears, proposeNewBabies } from "./proposals-from-salesforce";
import { fetchShloshim } from "./shloshim";
import type { Occasion } from "./types";
import { chicagoToday, windowDays } from "./window";
import { fetchYahrzeits } from "./yahrzeits";

export const WEEK_DAYS = 7;

export type OccasionsView = {
  today: string;
  weekEnd: string;
  /** Yahrzeits, birthdays and anniversaries dated today. */
  todays: Occasion[];
  /** The same, dated tomorrow through the end of the seven-day window. */
  week: Occasion[];
  /** Households in shloshim now. */
  mourning: Occasion[];
};

const ORDER = { yahrzeit: 0, shloshim: 1, birthday: 2, anniversary: 3 } as const;

function byDateThenType(a: Occasion, b: Occasion): number {
  return a.date.localeCompare(b.date) || ORDER[a.type] - ORDER[b.type] || a.personName.localeCompare(b.personName);
}

type Deps = { db: Db; sf: () => SalesforceClient; now: Date };

/** Dated occasions (yahrzeits, birthdays, anniversaries) from today for `days` days, sorted. */
async function datedWindow(deps: Deps, today: string, days: number): Promise<{ end: string; dated: Occasion[] }> {
  const entries = windowDays(today, days);
  const end = entries[entries.length - 1].dateKey;
  const cached = (type: string, fetch: () => Promise<Occasion[]>) => cachedForDay(deps.db, `lifecycle:${CACHE_SHAPE}:${type}:${days}`, today, fetch);
  const [yahrzeits, birthdays, anniversaries] = await Promise.all([
    cached("yahrzeit", () => fetchYahrzeits(deps.sf(), today, end)),
    cached("birthday", () => fetchBirthdays(deps.sf(), entries)),
    cached("anniversary", () => fetchAnniversaries(deps.sf(), entries)),
  ]);
  return { end, dated: [...yahrzeits, ...birthdays, ...anniversaries].filter((o) => o.date >= today && o.date <= end).sort(byDateThenType) };
}

/**
 * The once-a-day Salesforce read of the households in shloshim, and, from the same read, one
 * proposal for clergy per new death and per new baby (idempotent: proposals-from-salesforce.ts).
 * A failure to propose never costs anyone the day's list, and logs only the error's name.
 */
async function fetchShloshimAndPropose(deps: Deps, today: string): Promise<Occasion[]> {
  const mourning = await fetchShloshim(deps.sf(), today);
  try {
    await proposeBereavementYears(deps.db, mourning);
    await proposeNewBabies(deps.db, deps.sf(), today);
  } catch (error) {
    console.error("Salesforce proposals failed", error instanceof Error ? error.name : "unknown");
  }
  return mourning;
}

/**
 * Today's and this week's occasions for current-member households, read from
 * Salesforce at most once per Chicago day per type (the day cache).
 */
export async function getOccasions(deps: Deps, actor: Actor): Promise<OccasionsView> {
  if (!canSeeLifecycle(actor)) deny();
  const today = chicagoToday(deps.now);
  const [{ end: weekEnd, dated }, mourning] = await Promise.all([
    datedWindow(deps, today, WEEK_DAYS),
    cachedForDay(deps.db, `lifecycle:${CACHE_SHAPE}:shloshim:${WEEK_DAYS}`, today, () => fetchShloshimAndPropose(deps, today)),
  ]);
  return {
    today,
    weekEnd,
    todays: dated.filter((o) => o.date === today),
    week: dated.filter((o) => o.date > today),
    mourning,
  };
}

export const UPCOMING_WINDOWS = [7, 30] as const;
export type UpcomingWindow = (typeof UPCOMING_WINDOWS)[number];
export type UpcomingView = { today: string; end: string; days: UpcomingWindow; byDay: { date: string; occasions: Occasion[] }[] };

/** The next 7 or 30 days of occasions (today included), grouped by day; a shloshim on the day it ends. */
export async function getUpcomingOccasions(deps: Deps, actor: Actor, days: UpcomingWindow): Promise<UpcomingView> {
  if (!canSeeLifecycle(actor)) deny();
  if (!UPCOMING_WINDOWS.includes(days)) throw new Error("Invalid window");
  const today = chicagoToday(deps.now);
  const [{ end, dated: anniversaries }, mourning] = await Promise.all([
    datedWindow(deps, today, days),
    // The same once-a-day read as Today: each household in shloshim, on the day its shloshim ends.
    cachedForDay(deps.db, `lifecycle:${CACHE_SHAPE}:shloshim:${WEEK_DAYS}`, today, () => fetchShloshimAndPropose(deps, today)),
  ]);
  const dated = [...anniversaries, ...mourning.filter((o) => o.date >= today && o.date <= end)].sort(byDateThenType);
  const byDay: UpcomingView["byDay"] = [];
  for (const o of dated) {
    const last = byDay[byDay.length - 1];
    if (last && last.date === o.date) last.occasions.push(o);
    else byDay.push({ date: o.date, occasions: [o] });
  }
  return { today, end, days, byDay };
}
