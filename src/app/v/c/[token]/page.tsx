import { notFound } from "next/navigation";
import { cancelClaimAction, cancelDateAction, doneClaimAction } from "@/app/v/actions";
import { ActionForm } from "@/components/action-form";
import { ConfirmAction } from "@/components/confirm-sheet";
import { PageSection, PublicFrame } from "@/components/meals/parts";
import { Facts, taskHeading, whenWords } from "@/components/volunteers/parts";
import { publicMetadata } from "@/components/public-meta";
import { btnLaptopNatural, btnPrimary, btnQuiet, inputClass, labelClass, tagQuiet } from "@/components/ui";
import { longDate } from "@/lib/format";
import { mapsUrlForPlace } from "@/lib/address";
import { getDb } from "@/server/db/client";
import { CONGREGATION } from "@/server/meals/core";
import { getMyClaim, getMyCommitments, getMySeries, type Commitment, type MyDate } from "@/server/volunteers/public";
import { KIND_WORDS, PREVIEW_TITLE } from "@/lib/volunteers-wording";

export const dynamic = "force-dynamic";
export const metadata = publicMetadata(PREVIEW_TITLE);

const ENDED = {
  cancelled: "Your place has been given back. Thank you for letting us know.",
  done: "This is marked done. Thank you for helping.",
  task_cancelled: "This request was cancelled. Thank you for being ready to help.",
  passed: "This has passed. Thank you for helping.",
} as const;

const STATE_WORDS = { active: "You are signed up", cancelled: "Given back", done: "Done", task_cancelled: "Cancelled by the organiser", passed: "Passed" } as const;

/** Only while the place is live and the claim stands: the page already withholds the place otherwise, so a link here never outlives it. */
function MapsLink({ place }: { place: string | null }) {
  const href = mapsUrlForPlace(place);
  if (!href) return null;
  return (
    <a href={href} className={btnQuiet} target="_blank" rel="noreferrer noopener" data-testid="maps-link">
      Open in Google Maps
    </a>
  );
}

/** What this person has promised elsewhere, seen only from a link of their own: kind, label and time, never a place. */
function Commitments({ items }: { items: Commitment[] }) {
  if (items.length === 0) return null;
  return (
    <PageSection id="commitments" heading="Your other dates">
      <ul className="flex flex-col gap-2 text-base" data-testid="commitments">
        {items.map((c) => (
          <li key={`${c.date}-${c.forLabel}-${c.kind}`}>
            <span className="font-semibold">{taskHeading(c.kind, c.forLabel)}</span>
            <span className="block text-rubric">{whenWords(c.date, c.timeWindow)}</span>
          </li>
        ))}
      </ul>
    </PageSection>
  );
}

function DateRow({ d, token }: { d: MyDate; token: string }) {
  return (
    <li className="py-3" data-testid="my-date">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="font-semibold">{whenWords(d.date, d.timeWindow)}</span>
        <span className={tagQuiet}>{STATE_WORDS[d.state]}</span>
      </div>
      {d.state === "active" && d.place ? (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-base">
          <span className="min-w-0 whitespace-pre-line break-words">{d.place}</span>
          <MapsLink place={d.place} />
        </p>
      ) : null}
      {d.cancellable ? (
        <div className="mt-2">
          <ConfirmAction action={cancelDateAction} fields={{ token, claimId: d.claimId }} label="Cannot make this one" ariaLabel={`Give back ${longDate(d.date)}`} title="Give back this date?" explain="This one date opens again for someone else. Your other dates stay." confirmLabel="Give it back" />
        </div>
      ) : null}
    </li>
  );
}

/** A volunteer's own page, by their personal link: where and when while their place stands, a calendar file, and a way to give it back or say it is done. For an "every time" claim, every date on one page. */
export default async function MyClaimPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ new?: string }> }) {
  const [{ token }, { new: isNew }] = await Promise.all([params, searchParams]);
  const db = getDb();
  const set = await getMySeries(db, token);
  if (set) {
    const ahead = set.dates.filter((d) => d.cancellable).length;
    const first = set.dates[0];
    return (
      <PublicFrame congregation={CONGREGATION} title={isNew ? "Thank you for helping" : first ? `${KIND_WORDS[first.kind]} for ${first.forLabel}` : "Your dates"}>
        {isNew ? <p className="mt-3 text-lg">You are signed up for every date{set.firstName ? `, ${set.firstName}` : ""}. This page is yours: keep the link, and use it to give back one date or all of them.</p> : null}
        <PageSection id="dates" heading={first ? `${KIND_WORDS[first.kind]} for ${first.forLabel}` : "Your dates"}>
          {first?.needed ? <p className="mb-3 max-w-prose whitespace-pre-line text-base">{first.needed}</p> : null}
          <ul className="divide-y divide-rule-soft" data-testid="my-dates">
            {set.dates.map((d) => (
              <DateRow key={d.claimId} d={d} token={token} />
            ))}
          </ul>
        </PageSection>
        {ahead > 0 ? (
          <PageSection id="cancel-all" heading="Cannot do these any more?">
            <ConfirmAction action={cancelDateAction} fields={{ token, claimId: "" }} label="Give back all the dates ahead" title="Give back every date ahead?" explain="Every date still ahead opens again for someone else. Dates already passed stay as they are." confirmLabel="Give them all back" />
          </PageSection>
        ) : null}
        <Commitments items={await getMyCommitments(db, token)} />
      </PublicFrame>
    );
  }

  const mine = await getMyClaim(db, token);
  if (!mine) notFound();

  if (mine.state !== "active") {
    return (
      <PublicFrame congregation={CONGREGATION} title={taskHeading(mine.kind, mine.forLabel)}>
        <p className="mt-4 text-lg" data-testid={`state-${mine.state}`}>
          {ENDED[mine.state]}
        </p>
        <p className="mt-2 text-base text-rubric">{longDate(mine.date)}</p>
      </PublicFrame>
    );
  }

  const d = mine.details;
  const rows = [
    { term: "What", text: d.needed },
    { term: "When", text: whenWords(d.date, d.timeWindow) },
    ...(d.place ? [{ term: "Where", text: d.place }] : []),
    ...(d.contactLine ? [{ term: "Questions", text: d.contactLine }] : []),
  ];
  return (
    <PublicFrame congregation={CONGREGATION} title={isNew ? "Thank you for helping" : taskHeading(d.kind, d.forLabel)}>
      {isNew ? <p className="mt-3 text-lg">You are signed up{mine.firstName ? `, ${mine.firstName}` : ""}. This page is yours: keep the link, and use it to add this to your calendar, give your place back or say it is done.</p> : null}
      <PageSection id="details" heading={taskHeading(d.kind, d.forLabel)}>
        <Facts rows={rows} />
        <p className="mt-5 flex flex-wrap gap-2">
          <a href={`/v/c/${token}/calendar.ics`} className={btnPrimary} data-testid="calendar">
            Add to my calendar
          </a>
          <MapsLink place={d.place} />
        </p>
      </PageSection>

      <PageSection id="done" heading="When it is done">
        <ActionForm action={doneClaimAction} className="flex flex-col gap-3" closeSheetOnOk={false}>
          <input type="hidden" name="token" value={token} />
          <div>
            <label htmlFor="mc-note" className={labelClass}>
              A line back to whoever asked (optional)
            </label>
            <input id="mc-note" name="note" maxLength={200} className={inputClass} aria-describedby="mc-note-help" />
            <p id="mc-note-help" className="mt-1 text-sm text-rubric">
              Please keep it to how it went. No health details.
            </p>
          </div>
          <button type="submit" className={`${btnQuiet} ${btnLaptopNatural}`}>
            Mark it done
          </button>
        </ActionForm>
      </PageSection>

      {mine.past ? null : (
        <PageSection id="cancel" heading="Cannot make it?">
          <p className="mb-3 text-base">Giving your place back lets someone else take it.</p>
          <ConfirmAction action={cancelClaimAction} fields={{ token }} label="Give my place back" title="Give your place back?" explain="Your place will open again for someone else. Your details stay only until a month after the date." confirmLabel="Give it back" />
        </PageSection>
      )}
      <Commitments items={await getMyCommitments(db, token)} />
    </PublicFrame>
  );
}
