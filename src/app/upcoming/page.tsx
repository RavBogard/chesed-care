import { redirect } from "next/navigation";
import { Chip } from "@/components/chip";
import { DayAnchorOpener } from "@/components/day-anchor-opener";
import { MarkAnnouncer } from "@/components/mark-announcer";
import { OccasionList } from "@/components/occasion-list";
import { AppShell } from "@/components/shell/app-shell";
import { Hebrew } from "@/components/hebrew";
import { KindTag } from "@/components/kind-tag";
import { LoadNotice } from "@/components/load-notice";
import { titleClass } from "@/components/ui";
import { longDate } from "@/lib/format";
import { hebrewDate } from "@/lib/hebrew-date";
import { canSeeLifecycle, type Actor } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { listMarkKeys } from "@/server/care/occasion-marks";
import { getTextDrafts } from "@/server/care/text-drafts";
import { getDb } from "@/server/db/client";
import { dayAnchor, kindCounts } from "@/server/lifecycle/cards";
import {
  getUpcomingOccasions,
  UPCOMING_WINDOWS,
  type UpcomingWindow,
} from "@/server/lifecycle/occasions";
import { getSalesforce } from "@/server/salesforce";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Upcoming · CRC Care" };

async function load(actor: Actor, days: UpcomingWindow) {
  const db = getDb();
  const view = await getUpcomingOccasions(
    { db, sf: getSalesforce, now: new Date() },
    actor,
    days,
  );
  const years = view.byDay.flatMap((d) =>
    d.occasions.map((o) => Number(o.date.slice(0, 4))),
  );
  const [marks, drafts] = await Promise.all([
    listMarkKeys(
      db,
      actor,
      years.length ? years : [Number(view.today.slice(0, 4))],
    ),
    getTextDrafts(db, actor),
  ]);
  return { view, marks, drafts };
}

export default async function UpcomingPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const actor = actorOrRedirect(await getViewer());
  if (!canSeeLifecycle(actor)) redirect("/");
  const { days: raw } = await searchParams;
  const days: UpcomingWindow = Number(raw) === 30 ? 30 : 7;

  const data: Awaited<ReturnType<typeof load>> | null = await soft("Upcoming: dates unavailable", null, () => load(actor, days));

  return (
    <AppShell actor={actor} title="Upcoming">
      <nav aria-label="How far ahead" className="mb-5 flex flex-wrap gap-2">
        {UPCOMING_WINDOWS.map((n) => (
          <Chip key={n} to={`/upcoming?days=${n}`} active={n === days}>
            {n} days
          </Chip>
        ))}
      </nav>
      {data === null ? (
        <LoadNotice what="Dates from Salesforce" />
      ) : null}
      {data && data.view.byDay.length === 0 ? (
        <p className="text-rubric">Nothing dated in the next {days} days.</p>
      ) : null}
      <MarkAnnouncer>
        <DayAnchorOpener />
        {data?.view.byDay.map((day, i) => (
          <details
            key={day.date}
            id={dayAnchor(day.date)}
            open={i < 2}
            className="group mt-4 scroll-mt-20 first:mt-0"
          >
            <summary className="flex min-h-11 cursor-pointer flex-wrap items-baseline gap-x-2 rounded-md border-b border-rule py-2 [&::-webkit-details-marker]:hidden">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="mt-1.5 shrink-0 self-start text-rubric transition-transform group-open:rotate-90"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              <h2 className={`${titleClass} min-w-0 flex-1 basis-40 text-balance`}>
                {day.date === data.view.today
                  ? `Today, ${longDate(day.date)}`
                  : longDate(day.date)}
              </h2>
              {hebrewDate(day.date) ? (
                <Hebrew size="text-[1.375rem]" className="text-action">
                  {hebrewDate(day.date) ?? ""}
                </Hebrew>
              ) : null}
              <span className="flex min-w-0 basis-full flex-wrap gap-1.5 pt-1 pl-6">
                {kindCounts(day.occasions).map((k) => (
                  <KindTag key={k.type} type={k.type}>
                    {k.label}
                  </KindTag>
                ))}
              </span>
            </summary>
            <OccasionList
              items={day.occasions}
              today={data.view.today}
              marks={data.marks}
              drafts={data.drafts}
              doneLabel="Done"
            />
          </details>
        ))}
      </MarkAnnouncer>
    </AppShell>
  );
}
