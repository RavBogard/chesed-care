/**
 * What the organiser's month grid needs for a run of months: the days, and for each the
 * Hebrew date, Shabbat, holiday and candle-lighting from ./calendar-notes.ts. PURE.
 */
import { addDays } from "@/server/lifecycle/window";
import { calendarNotes } from "./calendar-notes";
import { suggestDates } from "./slots";

export type GridMonth = { key: string; label: string; lead: number; days: string[] };
export type GridNote = { hebrew: string | null; shabbat: boolean; holiday: string | null; candle: string | null };

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayOfWeek = (key: string) => new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10))).getUTCDay();

/** `count` calendar months starting with the month of `today`. */
export function gridData(today: string, count = 4): { months: GridMonth[]; notes: Record<string, GridNote>; suggested: string[] } {
  const months: GridMonth[] = [];
  let year = +today.slice(0, 4);
  let month = +today.slice(5, 7);
  for (let i = 0; i < count; i++) {
    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
    months.push({ key: first.slice(0, 7), label: `${MONTH_NAMES[month - 1]} ${year}`, lead: dayOfWeek(first), days: Array.from({ length }, (_, d) => `${first.slice(0, 8)}${String(d + 1).padStart(2, "0")}`) });
    if (++month > 12) [month, year] = [1, year + 1];
  }
  const all = months.flatMap((m) => m.days);
  const notes: Record<string, GridNote> = {};
  for (const n of calendarNotes(all)) notes[n.date] = { hebrew: n.hebrewDate, shabbat: n.shabbat, holiday: n.holiday, candle: n.candleLighting };
  // Every other night for three weeks, from tomorrow.
  return { months, notes, suggested: suggestDates(addDays(today, 1), 3) };
}
