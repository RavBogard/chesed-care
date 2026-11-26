import { chicagoToday, parseDate } from "@/server/lifecycle/window";
import { InvalidInput } from "./validate";

/**
 * When a logged contact happened, from the form's date. Today (or no date) is the moment of
 * saving; an earlier day is stored at noon UTC, which is the same calendar day in Chicago.
 * A future or malformed date is refused.
 */
export function contactOccurredAt(when: string | undefined, now: Date): Date {
  if (when === undefined || when === "") return now;
  const parsed = parseDate(when);
  if (!parsed) throw new InvalidInput("when");
  const today = chicagoToday(now);
  if (when > today) throw new InvalidInput("when");
  if (when === today) return now;
  const day = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12));
  if (day.getUTCMonth() !== parsed.month - 1) throw new InvalidInput("when"); // 31 February and the like
  return day;
}
