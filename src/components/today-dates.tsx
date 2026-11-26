import Link from "next/link";
import { longDate, shortDate } from "@/lib/format";
import type { OwnDrafts } from "@/server/care/text-drafts";
import { hebrewDate, hebrewDayMonth } from "@/lib/hebrew-date";
import { byDay, dayAnchor, kindCounts } from "@/server/lifecycle/cards";
import type { OccasionsView } from "@/server/lifecycle/occasions";
import type { OccasionType } from "@/server/lifecycle/types";
import { addDays } from "@/server/lifecycle/window";
import { DateFilters } from "./date-filters";
import { DoneCount } from "./done-count";
import { Hebrew } from "./hebrew";
import { KindTag } from "./kind-tag";
import { isDone, OccasionList } from "./occasion-list";
import { rubric } from "./ui";

export const groupHeading = `${rubric} text-balance`;

/** A titled group on Today, with a real heading. */
export function Group({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className={`${groupHeading} min-w-0 flex-1 basis-56`}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const quiet = "mt-2 text-sm text-rubric";
const KIND_ORDER: OccasionType[] = ["yahrzeit", "shloshim", "birthday", "anniversary"];

/**
 * The dates on Today: today in full with a count of what is done, households in
 * shloshim, tomorrow in full (to text the evening before), and the rest of the week
 * as one line per day that opens Upcoming at that day. Within today and tomorrow the
 * cards are gathered by kind, each kind under its own heading.
 */
export function TodayDates({ view, marks, drafts, prefs = { kind: null, hideBirthdays: false } }: { view: OccasionsView; marks: ReadonlySet<string>; drafts: OwnDrafts; prefs?: { kind: OccasionType | null; hideBirthdays: boolean } }) {
  const tomorrow = addDays(view.today, 1);
  const tomorrows = view.week.filter((o) => o.date === tomorrow);
  const later = byDay(view.week.filter((o) => o.date > tomorrow));
  const total = view.todays.length;
  const finished = view.todays.filter((o) => isDone(marks, o)).length;
  const list = { today: view.today, marks, drafts };
  const tomorrowHebrew = hebrewDate(tomorrow);
  const kinds = KIND_ORDER.filter((k) => [...view.todays, ...view.mourning, ...view.week].some((o) => o.type === k));
  return (
    <DateFilters kinds={kinds} initial={prefs}>
      <Group
        title={longDate(view.today)}
        aside={
          total ? <DoneCount finished={finished} total={total} /> : null
        }
      >
        {total === 0 ? <p className={quiet}>Nothing dated today.</p> : null}
        {total > 0 && finished === total ? (
          <p className="mt-2 rounded-md bg-done-band px-3 py-2 text-sm font-medium text-done" data-testid="today-finished">
            All of today&rsquo;s dates are done.
          </p>
        ) : null}
        <OccasionList items={view.todays} doneLabel="Done today" {...list} />
      </Group>

      {view.mourning.length ? (
        <Group title="In shloshim">
          <OccasionList items={view.mourning} doneLabel="Already contacted" grouped={false} {...list} />
        </Group>
      ) : null}

      <Group
        title={`Tomorrow, ${longDate(tomorrow)}`}
        aside={
          tomorrowHebrew ? (
            <Hebrew size="text-lg" className="text-action">
              {tomorrowHebrew}
            </Hebrew>
          ) : null
        }
      >
        {tomorrows.length === 0 ? <p className={quiet}>Nothing dated tomorrow.</p> : null}
        <OccasionList items={tomorrows} doneLabel="Done" {...list} />
      </Group>

      <Group title="Later this week">
        {later.length === 0 ? (
          <p className={quiet}>Nothing else this week.</p>
        ) : (
          <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="week-days">
            {later.map((day) => {
              const hebrew = hebrewDayMonth(day.date);
              return (
                <li key={day.date}>
                  <Link href={`/upcoming#${dayAnchor(day.date)}`} className="flex min-h-11 flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-tint focus-visible:-outline-offset-3">
                    <span className="font-semibold">{shortDate(day.date)}</span>
                    {/* Each kind is counted on its own tag: the icon, the word and the fill of its cards. */}
                    <span className="flex max-w-full min-w-0 flex-wrap gap-1.5">
                      {kindCounts(day.occasions).map((k) => (
                        <KindTag key={k.type} type={k.type}>
                          {k.label}
                        </KindTag>
                      ))}
                    </span>
                    {hebrew ? (
                      <Hebrew size="text-lg" className="text-action">
                        {hebrew}
                      </Hebrew>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Group>
    </DateFilters>
  );
}
