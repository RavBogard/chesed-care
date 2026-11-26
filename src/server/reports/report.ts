/**
 * Reports: counts and medians for a period, as plain tables. Aggregate queries only; no
 * Salesforce, no names, no note text, no giving data. Clergy and owner see what they can fully
 * see (the same visibility rules as the lists). Senior staff get the same page without names:
 * only what is not restricted is broken down, every cell under 5 is withheld
 * (src/server/reports/small-number.ts), and restricted items enter a total only when that
 * total already exceeds 5. No export.
 */
import { and, count, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import {
  canSeeReports,
  careItemVisibleWhere,
  deny,
  followUpVisibleWhere,
  mealPageVisibleWhere,
  proposalReviewWhere,
  reportsAreNameless,
  SMALL_NUMBER,
  volunteerTaskVisibleWhere,
  type Actor,
} from "@/server/access/policy";
import { CATEGORY_LABEL } from "@/lib/care-labels";
import { activeWhere, CARE_CATEGORIES } from "@/server/care/care-items";
import { careItems, followUps, miSheberachEntries, mealPages, mealSignups, mealSlots, proposals, volunteerClaims, volunteerTasks } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { addDays, assertDateKey, chicagoToday } from "@/server/lifecycle/window";
import { grandTotal, hideSmall, hideSmallInGroup, type Cell } from "./small-number";

export const AGE_BANDS = ["Under 2 weeks", "2 to 8 weeks", "Over 8 weeks"] as const;
export const DEFAULT_PERIOD_DAYS = 90;
export const MAX_PERIOD_DAYS = 366;

export type Period = { from: string; to: string };

/** Parse ?from=&to=; anything unexpected falls back to the last 90 days, and a period is at most a year. */
export function parsePeriod(q: { from?: unknown; to?: unknown; period?: unknown }, now: Date, opts: { whole?: boolean } = {}): Period {
  const today = chicagoToday(now);
  if (opts.whole) {
    // No-names version: whole calendar months or quarters only, whatever was posted.
    const chosen = typeof q.period === "string" ? choiceToPeriod(q.period) : null;
    if (chosen) return chosen;
    try {
      return snapToWhole(assertDateKey(q.from), assertDateKey(q.to));
    } catch {
      return periodChoices(now).find((c) => c.value.startsWith("q:"))!.period;
    }
  }
  const day = (v: unknown): string | null => {
    try {
      return assertDateKey(v);
    } catch {
      return null;
    }
  };
  const to = day(q.to) ?? today;
  let from = day(q.from) ?? addDays(to, -DEFAULT_PERIOD_DAYS);
  if (from > to) from = addDays(to, -DEFAULT_PERIOD_DAYS);
  if (from < addDays(to, -MAX_PERIOD_DAYS)) from = addDays(to, -MAX_PERIOD_DAYS);
  return { from, to };
}

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthPeriod = (y: number, m: number): Period => ({ from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${lastDay(y, m)}` });
const quarterPeriod = (y: number, q: number): Period => ({ from: `${y}-${pad(q * 3 - 2)}-01`, to: `${y}-${pad(q * 3)}-${lastDay(y, q * 3)}` });

/** "m:2026-11" is a whole month, "q:2026-4" a whole quarter. Anything else is null. */
export function choiceToPeriod(v: string): Period | null {
  const m = /^m:(\d{4})-(\d{2})$/.exec(v);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return monthPeriod(Number(m[1]), Number(m[2]));
  const q = /^q:(\d{4})-([1-4])$/.exec(v);
  if (q) return quarterPeriod(Number(q[1]), Number(q[2]));
  return null;
}

/** Whole months (one month) or whole quarters (anything longer), covering what was asked, at most four quarters. */
export function snapToWhole(from: string, to: string): Period {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  if (to < from) return monthPeriod(fy, fm);
  if (fy === ty && fm === tm) return monthPeriod(fy, fm);
  const fq = Math.ceil(fm / 3);
  let tq = Math.ceil(tm / 3);
  const tyy = ty;
  // At most four quarters: the later end wins.
  const span = (tyy - fy) * 4 + (tq - fq) + 1;
  if (span > 4) {
    const total = tyy * 4 + (tq - 1) - 3;
    return { from: quarterPeriod(Math.floor(total / 4), (total % 4) + 1).from, to: quarterPeriod(tyy, tq).to };
  }
  tq = Math.max(tq, 1);
  return { from: quarterPeriod(fy, fq).from, to: quarterPeriod(tyy, tq).to };
}

/** What the no-names version offers: the last twelve months and the last four quarters, newest first. */
export function periodChoices(now: Date): { value: string; label: string; period: Period }[] {
  const [y, m] = chicagoToday(now).split("-").map(Number);
  const name = (yy: number, mm: number) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(yy, mm - 1, 15)));
  const out: { value: string; label: string; period: Period }[] = [];
  for (let i = 0; i < 12; i++) {
    const t = y * 12 + (m - 1) - i;
    const yy = Math.floor(t / 12);
    const mm = (t % 12) + 1;
    out.push({ value: `m:${yy}-${pad(mm)}`, label: name(yy, mm), period: monthPeriod(yy, mm) });
  }
  const cq = y * 4 + Math.ceil(m / 3) - 1;
  for (let i = 1; i <= 4; i++) {
    const t = cq - i;
    const yy = Math.floor(t / 4);
    const qq = (t % 4) + 1;
    out.push({ value: `q:${yy}-${qq}`, label: `Quarter ${qq}, ${yy}`, period: quarterPeriod(yy, qq) });
  }
  return out;
}

export type Report = {
  nameless: boolean;
  period: Period;
  today: string;
  openItems: { bands: readonly string[]; rows: { kind: string; cells: Cell[]; total: Cell }[]; total: Cell };
  firstContact: { medianDays: number | null; count: Cell };
  journeys: { planned: Cell; done: Cell };
  channels: { rows: { channel: (typeof proposals.$inferSelect)["channel"]; n: Cell }[]; total: Cell };
  volunteers: { posted: Cell; filled: Cell };
  meals: { offered: Cell; covered: Cell };
  miSheberach: { added: Cell; ended: Cell };
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** The Chicago calendar day of a timestamp column. */
const chicagoDay = (col: SQL | { _: unknown }) => sql`((${col}) at time zone 'America/Chicago')::date`;
const between = (col: SQL | { _: unknown }, p: Period): SQL => sql`${chicagoDay(col)} >= ${p.from}::date and ${chicagoDay(col)} <= ${p.to}::date`;

export async function getReport(db: Db, actor: Actor, period: Period, now: Date = new Date()): Promise<Report> {
  if (!canSeeReports(actor)) deny();
  const nameless = reportsAreNameless(actor);
  const today = chicagoToday(now);
  const d14 = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const d56 = new Date(now.getTime() - 56 * 86_400_000).toISOString();

  // What each query may count. Clergy: what they fully see. Senior staff: what is not restricted, everywhere, totals included, so no number moves when a restricted item is added or removed.
  const itemScope: SQL = nameless ? sql`not ${careItems.restricted}` : careItemVisibleWhere(actor);
  const plainItem = (col: SQL | { _: unknown }): SQL => sql`(${col} is null or exists (select 1 from ${careItems} ci where ci.id = ${col} and not ci.restricted))`;
  const followUpScope: SQL = nameless ? plainItem(followUps.careItemId) : followUpVisibleWhere(actor);
  const proposalScope: SQL = nameless ? and(eq(proposals.reviewScope, "clergy"), plainItem(proposals.scopeCareItemId))! : proposalReviewWhere(actor);
  const taskScope: SQL = nameless ? plainItem(volunteerTasks.careItemId) : volunteerTaskVisibleWhere(actor);
  const mealScope: SQL = nameless ? plainItem(mealPages.careItemId) : mealPageVisibleWhere(actor);

  const band = sql<string>`case when ${careItems.createdAt} >= ${d14}::timestamptz then '0' when ${careItems.createdAt} >= ${d56}::timestamptz then '1' else '2' end`;
  const claimsFor = (taskId: SQL | { _: unknown }) => sql`(select count(*) from ${volunteerClaims} where ${volunteerClaims.taskId} = ${taskId} and ${volunteerClaims.cancelledAt} is null)`;

  const [openRows, firstRows, journeyRow, channelRows, volunteerRow, mealRow, miRow] = await Promise.all([
    db
      .select({ kind: careItems.category, band, n: count() })
      .from(careItems)
      .where(and(itemScope, activeWhere(today)))
      .groupBy(sql`1`, sql`2`),
    db
      .select({ arrived: proposals.createdAt, first: sql<Date | null>`(select min(occurred_at) from contact_log where contact_log.care_item_id = ${proposals.resultCareItemId})` })
      .from(proposals)
      .innerJoin(careItems, eq(careItems.id, proposals.resultCareItemId))
      .where(and(eq(proposals.status, "accepted"), proposalScope, itemScope, between(sql`${proposals.createdAt}`, period))),
    db
      .select({ planned: count(), done: sql<number>`(count(*) filter (where ${followUps.doneAt} is not null))::int` })
      .from(followUps)
      .where(and(sql`${followUps.journeyId} is not null`, gte(followUps.dueDate, period.from), lte(followUps.dueDate, period.to), followUpScope)),
    db
      .select({ channel: proposals.channel, n: count() })
      .from(proposals)
      .where(and(proposalScope, between(sql`${proposals.createdAt}`, period)))
      .groupBy(proposals.channel),
    db
      .select({ posted: count(), filled: sql<number>`(count(*) filter (where ${claimsFor(sql`${volunteerTasks.id}`)} >= ${volunteerTasks.peopleNeeded}))::int` })
      .from(volunteerTasks)
      .where(and(taskScope, sql`${volunteerTasks.status} <> 'cancelled'`, between(sql`${volunteerTasks.createdAt}`, period))),
    db
      .select({ offered: count(), covered: sql<number>`(count(*) filter (where exists (select 1 from ${mealSignups} where ${mealSignups.slotId} = ${mealSlots.id} and ${mealSignups.cancelledAt} is null)))::int` })
      .from(mealSlots)
      .innerJoin(mealPages, eq(mealPages.id, mealSlots.pageId))
      .where(and(mealScope, eq(mealSlots.status, "open"), sql`${mealPages.status} <> 'draft'`, gte(mealSlots.date, period.from), lte(mealSlots.date, period.to))),
    db
      .select({
        added: sql<number>`(count(*) filter (where ${miSheberachEntries.dateAdded} >= ${period.from}::date and ${miSheberachEntries.dateAdded} <= ${period.to}::date))::int`,
        ended: sql<number>`(count(*) filter (where ${miSheberachEntries.endedAt} is not null and ${between(sql`${miSheberachEntries.endedAt}`, period)}))::int`,
      })
      .from(miSheberachEntries),
  ]);

  // Open items by kind and age band.
  const grid = new Map<string, number[]>();
  for (const r of openRows) {
    const row = grid.get(r.kind) ?? [0, 0, 0];
    row[Number(r.band)] += r.n;
    grid.set(r.kind, row);
  }
  const kinds = CARE_CATEGORIES.filter((k) => grid.has(k));
  const label = (k: (typeof CARE_CATEGORIES)[number]) => CATEGORY_LABEL[k];
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const fullTotal = sum([...grid.values()].map(sum));
  let rows: Report["openItems"]["rows"];
  let total: Cell;
  if (!nameless) {
    rows = kinds.map((k) => ({ kind: label(k), cells: grid.get(k)!, total: sum(grid.get(k)!) }));
    total = fullTotal;
  } else {
    // A kind with fewer than 5 items is not offered on its own: it is folded into "All other kinds".
    const big = kinds.filter((k) => sum(grid.get(k)!) >= SMALL_NUMBER);
    const rest = kinds.filter((k) => !big.includes(k)).reduce<number[]>((acc, k) => acc.map((v, i) => v + grid.get(k)![i]), [0, 0, 0]);
    const lines = [...big.map((k) => ({ kind: label(k), v: grid.get(k)! })), ...(sum(rest) > 0 ? [{ kind: "All other kinds", v: rest }] : [])];
    rows = lines.map(({ kind, v }) => {
      const g = hideSmallInGroup(v);
      return { kind, cells: g.cells, total: g.total };
    });
    total = grandTotal(rows.map((r) => r.total), fullTotal);
  }

  // Median time from arrival in the Inbox to the first logged contact.
  const gaps = firstRows.filter((r) => r.first).map((r) => (new Date(r.first!).getTime() - new Date(r.arrived).getTime()) / 86_400_000);
  const gapDays = gaps.map((g) => Math.max(0, g));
  const firstContact: Report["firstContact"] =
    nameless && gaps.length < SMALL_NUMBER
      ? { medianDays: null, count: hideSmall(gaps.length) }
      : nameless
        ? { medianDays: Math.round(median(gapDays)), count: hideSmall(gaps.length) }
        : { medianDays: gaps.length ? Math.round(median(gapDays) * 10) / 10 : null, count: gaps.length };

  const pair = (a: number, b: number): [Cell, Cell] => (nameless ? [hideSmall(a), hideSmall(b)] : [a, b]);
  const [planned, done] = pair(journeyRow[0].planned, journeyRow[0].done);
  const [posted, filled] = pair(volunteerRow[0].posted, volunteerRow[0].filled);
  const [offered, covered] = pair(mealRow[0].offered, mealRow[0].covered);
  const [added, ended] = pair(miRow[0].added, miRow[0].ended);

  const channelTotal = sum(channelRows.map((r) => r.n));
  const channelGroup = nameless ? hideSmallInGroup(channelRows.map((r) => r.n)) : { cells: channelRows.map((r) => r.n) as Cell[], total: channelTotal as Cell };
  const channels = { rows: channelRows.map((r, i) => ({ channel: r.channel, n: channelGroup.cells[i] })), total: channelGroup.total };

  return {
    nameless,
    period,
    today,
    openItems: { bands: AGE_BANDS, rows, total },
    firstContact,
    journeys: { planned, done },
    channels,
    volunteers: { posted, filled },
    meals: { offered, covered },
    miSheberach: { added, ended },
  };
}
