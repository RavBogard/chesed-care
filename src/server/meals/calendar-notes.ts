/**
 * Notes for the organiser's grid of dates: the Hebrew date, whether the day is
 * Shabbat or a holiday, and candle-lighting time in St. Louis on Fridays and
 * holiday eves. Holidays follow the one-day schedule a Reform congregation keeps
 * (the calendar of Israel: one day of Pesach, Shavuot and Sukkot at each end, not two).
 * Dates are marked, never blocked: every day can be offered.
 * PURE (no I/O); the calendar is @hebcal/core's, the Hebrew lettering is ours.
 */
import { flags, HebrewCalendar, Location } from "@hebcal/core";
import { hebrewDayMonth } from "@/lib/hebrew-date";
import { CONGREGATION_TZ, parseDate } from "@/server/lifecycle/window";

export type CalendarNote = {
  date: string;
  /** "י״ג כסלו" */
  hebrewDate: string | null;
  shabbat: boolean;
  /** "Rosh Hashana", "Erev Pesach", "Chanukah" (from the evening of the first candle), ... */
  holiday: string | null;
  /** "4:21 PM" on a Friday or the eve of a holiday; null on other days. */
  candleLighting: string | null;
};

const ST_LOUIS = new Location(38.627, -90.1994, false, CONGREGATION_TZ, "St. Louis", "US");
const TIMED = new Set(["Candle lighting", "Havdalah"]);
const MAX_SPAN_DAYS = 400;

const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const local = (dateKey: string) => {
  const p = parseDate(dateKey)!;
  return new Date(p.year, p.month - 1, p.day);
};

/** "16:21" → "4:21 PM" */
function twelveHour(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** One note per valid YYYY-MM-DD date given, in the order given. Dates more than 400 days apart are refused (an empty list). */
export function calendarNotes(dates: readonly string[]): CalendarNote[] {
  const valid = dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && parseDate(d));
  if (valid.length === 0) return [];
  const sorted = [...valid].sort();
  const [start, end] = [local(sorted[0]), local(sorted.at(-1)!)];
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_SPAN_DAYS) return [];
  const events = HebrewCalendar.calendar({ start, end, location: ST_LOUIS, candlelighting: true, il: true, sedrot: false, omer: false, noRoshChodesh: true, noSpecialShabbat: true, noMinorFast: true });
  const holidays = new Map<string, string>();
  const candles = new Map<string, string>();
  for (const event of events) {
    const day = key(event.getDate().greg());
    const desc = event.getDesc();
    const time = (event as { eventTimeStr?: string }).eventTimeStr;
    if (desc === "Candle lighting" && time) candles.set(day, twelveHour(time));
    // Other timed lines (when to stop eating chametz, fast times) are not holidays. Chanukah's carries its candle time.
    else if (!TIMED.has(desc) && (!time || event.getFlags() & flags.CHANUKAH_CANDLES) && !holidays.has(day)) holidays.set(day, desc.startsWith("Erev ") ? desc : event.basename());
  }
  return valid.map((date) => ({ date, hebrewDate: hebrewDayMonth(date), shabbat: local(date).getDay() === 6, holiday: holidays.get(date) ?? null, candleLighting: candles.get(date) ?? null }));
}
