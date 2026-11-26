/**
 * Calendar days for the congregation (America/Chicago). Dates are YYYY-MM-DD
 * strings; arithmetic is on noon-UTC instants so daylight saving never moves a day.
 */
export const CONGREGATION_TZ = "America/Chicago";
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export type DayEntry = { dateKey: string; year: number; month: number; day: number };

const DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Today's date in Chicago for the given instant. */
export function chicagoToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: CONGREGATION_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function parseDate(value: string | null | undefined): { year: number; month: number; day: number } | null {
  const m = DATE.exec(value ?? "");
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** A bare YYYY-MM-DD day that exists in the calendar (2026-02-31 does not). */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !parseDate(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  return back.getUTCMonth() === m - 1 && back.getUTCDate() === d;
}

/** A bare YYYY-MM-DD day, safe to place in SOQL as a date literal; throws otherwise. */
export function assertDateKey(value: unknown): string {
  if (!isDateKey(value)) throw new Error("Invalid date");
  return value;
}

function fmt(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function addDays(dateKey: string, days: number): string {
  const p = parseDate(dateKey);
  if (!p) throw new Error("Invalid date");
  return fmt(Date.UTC(p.year, p.month - 1, p.day, 12) + days * DAY_MS);
}

/** `days` consecutive days starting at `start`. */
export function windowDays(start: string, days: number): DayEntry[] {
  const out: DayEntry[] = [];
  for (let i = 0; i < Math.max(1, Math.floor(days)); i++) {
    const dateKey = addDays(start, i);
    out.push({ dateKey, ...parseDate(dateKey)! });
  }
  return out;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Feb 29 dates are observed on Feb 28 in a common year. */
function observesLeapDay(e: DayEntry): boolean {
  return e.month === 2 && e.day === 28 && !isLeapYear(e.year);
}

/** SOQL matching any (month, day) in the window, for a recurring date field. */
export function monthDayOrClause(field: string, entries: DayEntry[]): string {
  if (!/^[A-Za-z0-9_.]+$/.test(field)) throw new Error("Invalid field");
  const pairs: Array<[number, number]> = [];
  const seen = new Set<string>();
  const add = (m: number, d: number) => {
    if (seen.has(`${m}-${d}`)) return;
    seen.add(`${m}-${d}`);
    pairs.push([m, d]);
  };
  for (const e of entries) {
    add(e.month, e.day);
    if (observesLeapDay(e)) add(2, 29);
  }
  return pairs.map(([m, d]) => `(CALENDAR_MONTH(${field}) = ${m} AND DAY_IN_MONTH(${field}) = ${d})`).join(" OR ");
}

/** The window day on which a recurring date (birthday, wedding) falls, or null. */
export function windowHit(date: string | null | undefined, entries: DayEntry[]): DayEntry | null {
  const p = parseDate(date);
  if (!p) return null;
  return entries.find((e) => (e.month === p.month && e.day === p.day) || (p.month === 2 && p.day === 29 && observesLeapDay(e))) ?? null;
}

/** Whole years between two dates, rounded (yahrzeits drift by weeks against the civil calendar). */
export function roundedYears(from: string | null, to: string | null): number | null {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return null;
  const n = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / (365.25 * DAY_MS));
  return n > 0 ? n : null;
}
