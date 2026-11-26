/** Date helpers for display. Dates are YYYY-MM-DD keys in the congregation's time zone; never shifted by the device zone. */

function utcNoon(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

const fmt = (opts: Intl.DateTimeFormatOptions) => (key: string) => new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(utcNoon(key));

export const longDate = fmt({ weekday: "long", month: "long", day: "numeric" });
export const shortDate = fmt({ weekday: "short", month: "short", day: "numeric" });
export const monthDay = fmt({ month: "short", day: "numeric" });

export function daysBetween(from: string, to: string): number {
  return Math.round((utcNoon(to).getTime() - utcNoon(from).getTime()) / 86_400_000);
}

/** "Overdue by 3 days", "Due today", "Due tomorrow", "Due Fri, Nov 28". */
export function dueLabel(today: string, due: string): string {
  const n = daysBetween(today, due);
  if (n < 0) return `Overdue by ${-n} ${n === -1 ? "day" : "days"}`;
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  return `Due ${shortDate(due)}`;
}

/** A timestamp as a calendar date in Chicago ("Nov 23, 2026"). */
export function instantDate(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" }).format(d);
}
