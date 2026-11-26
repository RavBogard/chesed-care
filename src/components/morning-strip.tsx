import Link from "next/link";
import type { MorningSummary } from "@/server/daily/summary";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "This morning": the counts the daily job worked out at six, each a link to where it is
 * waiting. Quiet on purpose: a tint, no colour of its own. Nothing shows on an empty day.
 * The counts are of the morning; the lists below them are of now.
 */
export function MorningStrip({ summary, followUpsHref = "#follow-ups", stepsHref = "#follow-ups" }: { summary: MorningSummary; followUpsHref?: string; stepsHref?: string }) {
  const items = [
    summary.overdue ? { key: "overdue", href: followUpsHref, text: plural(summary.overdue, "overdue follow-up", "overdue follow-ups") } : null,
    summary.dueToday ? { key: "today", href: followUpsHref, text: plural(summary.dueToday, "due today", "due today") } : null,
    summary.newSteps ? { key: "steps", href: stepsHref, text: plural(summary.newSteps, "new journey step", "new journey steps") } : null,
    summary.inbox ? { key: "inbox", href: "/inbox", text: plural(summary.inbox, "new in the Inbox", "new in the Inbox") } : null,
  ].filter((i): i is { key: string; href: string; text: string } => i !== null);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="this-morning" className="mb-5 rounded-md bg-tint px-4 py-3" data-testid="morning-strip">
      <h2 id="this-morning" className="text-sm font-semibold text-ink">
        This morning
      </h2>
      <ul className="mt-1 flex flex-wrap gap-x-4">
        {items.map((i) => (
          <li key={i.key} data-testid={`morning-${i.key}`}>
            <Link href={i.href} className="inline-flex min-h-11 items-center text-base text-action underline decoration-control underline-offset-4 hover:decoration-action">
              {i.text}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
