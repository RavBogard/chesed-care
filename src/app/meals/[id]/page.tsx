import Link from "next/link";
import { notFound } from "next/navigation";
import { AddCoOrganiser, AddDatesForm, BookForm, DetailsForm, RemoveCoOrganiser, RemoveForm, StatusControls, WithdrawButton } from "@/components/meals/organiser-forms";
import { DateHead, FoodTag, notesByDate } from "@/components/meals/parts";
import { ShareKit } from "@/components/meals/share-kit";
import { AppShell } from "@/components/shell/app-shell";
import { Section } from "@/components/section";
import { btnQuiet, noticeClass, tagNew, tagQuiet } from "@/components/ui";
import { instantDate, monthDay } from "@/lib/format";
import { heading, mealWord } from "@/lib/meals-wording";
import { AccessDenied, canOrganiseMealPages, isClergyLevel } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { addressSuggestion } from "@/server/care/person-address";
import { NotFound } from "@/server/care/validate";
import { listTeam } from "@/server/care/users";
import { getDb } from "@/server/db/client";
import { getSalesforce } from "@/server/salesforce";
import { calendarNotes } from "@/server/meals/calendar-notes";
import { gridData } from "@/server/meals/grid-data";
import { getMealPageForOrganiser, type MealPageForOrganiser, type OrganiserSlot } from "@/server/meals/pages";
import { listPastHelpers, type PastHelper } from "@/server/meals/slots";
import { nightLabel } from "@/components/meals/parts";
import { LoadNotice } from "@/components/load-notice";
import { appOriginOrNull, logFailure } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mitzvah Meals · CRC Care" };

const STATUS = { draft: "Draft", live: "Live", paused: "Paused", ended: "Ended" } as const;

const origin = () => appOriginOrNull() ?? "";

function Night({ slot, pageId, notes, editable }: { slot: OrganiserSlot; pageId: string; notes: ReturnType<typeof notesByDate>; editable: boolean }) {
  const s = slot.signup;
  const label = nightLabel(slot.date, slot.meal);
  const name = s ? [s.firstName, s.lastName].filter(Boolean).join(" ") || "this helper" : "";
  const open = !s && slot.status === "open";
  return (
    <li data-testid={open ? "night-open" : "night"} className={open && !slot.past ? "rounded-md border-2 border-action bg-surface px-4 py-3" : "rounded-md border border-rule-soft px-4 py-3"}>
      <DateHead date={slot.date} meal={slot.meal} note={notes.get(slot.date)} candles />
      {slot.status === "withdrawn" && !s ? <p className="mt-1 text-base text-rubric">Taken off the page.</p> : null}
      {open ? <p className="mt-1 text-lg font-bold text-action">{slot.past ? "Past, nobody took it" : "Open"}</p> : null}
      {s ? (
        <div className="mt-1 text-base">
          {slot.needsCall ? <p className={`${tagNew} mb-1`}>Taken off the page. Please call this helper.</p> : null}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{name}</span>
            <span>
              {s.kind === "delivery" ? "is sending a delivery" : "is bringing"}
              {s.bringing ? `: ${s.bringing}` : ""}
            </span>
            <FoodTag foodType={s.foodType} />
            {s.onBehalf ? <span className={tagQuiet}>Booked by you</span> : null}
          </p>
          {s.email ? <p className="break-all text-sm text-rubric">{s.email}</p> : null}
          {s.note ? <p className="whitespace-pre-line text-sm">{s.note}</p> : null}
          {s.thankedAt ? <p className="text-sm font-semibold text-done">Thanked</p> : null}
        </div>
      ) : null}
      {editable && !slot.past ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {open ? <BookForm pageId={pageId} slotId={slot.id} label={label} /> : null}
          {s ? <RemoveForm pageId={pageId} signupId={s.id} name={name} /> : null}
          {slot.status === "open" ? <WithdrawButton pageId={pageId} slotId={slot.id} label={label} /> : null}
        </div>
      ) : null}
    </li>
  );
}

export default async function MealsPageRoute({ params }: { params: Promise<{ id: string }> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  const { id } = await params;
  let page: MealPageForOrganiser;
  try {
    page = await getMealPageForOrganiser(getDb(), actor, id);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    if (error instanceof AccessDenied) {
      return (
        <AppShell actor={actor} title="Mitzvah Meals">
          <p className={noticeClass}>You do not have access to this page.</p>
        </AppShell>
      );
    }
    logFailure("Meals: page unavailable", error);
    return (
      <AppShell actor={actor} title="Mitzvah Meals">
        <LoadNotice what="This page" />
      </AppShell>
    );
  }

  const db = getDb();
  const [team, past, suggestion] = await Promise.all([
    isClergyLevel(actor) ? listTeam(db, actor).catch(() => []) : Promise.resolve([]),
    listPastHelpers(db, actor).catch((): PastHelper[] => []),
    page.status === "ended" ? Promise.resolve(null) : addressSuggestion({ db, sf: getSalesforce, now: new Date() }, actor, { sfContactId: page.sfContactId, outsidePersonId: page.outsidePersonId }),
  ]);
  const o = origin();
  const publicUrl = page.publicToken ? `${o}/m/${page.publicToken}` : null;
  const familyUrl = page.familyToken ? `${o}/m/f/${page.familyToken}` : null;
  const grid = gridData(page.today);
  const notes = notesByDate(calendarNotes(page.slots.map((s) => s.date)));
  const upcoming = page.slots.filter((s) => !s.past);
  const earlier = page.slots.filter((s) => s.past);
  const ended = page.status === "ended";
  const { coverage } = page;
  const organiserIds = new Set(page.organisers.map((p) => p.userId));
  const addable = team.filter((u) => canOrganiseMealPages(u) && !organiserIds.has(u.id)).map((u) => ({ id: u.id, name: u.name ?? u.email }));
  const calls = page.slots.filter((s) => s.needsCall).length;

  return (
    <AppShell actor={actor} title={heading(page.title)}>
      <div className="flex flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className={tagQuiet}>{STATUS[page.status]}</span>
          {page.status === "paused" ? <span className="text-sm text-rubric">{page.pausedBy === "family" ? "Paused by the family" : "Paused by an organiser"}</span> : null}
        </p>
        {ended ? null : coverage.openDates > 0 ? (
          <p className="font-serif text-2xl font-bold" data-testid="open-count">
            {coverage.openDates === 1 ? "1 open night" : `${coverage.openDates} open nights`}
          </p>
        ) : (
          <p className="font-serif text-2xl font-bold" data-testid="open-count">
            {coverage.coveredThrough ? `Covered through ${monthDay(coverage.coveredThrough)}` : "No nights left on the page"}
          </p>
        )}
        {coverage.nextOpenDate && !ended ? <p className="text-base text-rubric">The next open night is {monthDay(coverage.nextOpenDate)}.</p> : null}
        {calls ? <p className={`${noticeClass} mt-2`}>{calls === 1 ? "A helper's night was taken off the page. Please call them." : `${calls} helpers' nights were taken off the page. Please call them.`}</p> : null}
      </div>

      {page.status === "draft" ? (
        <div className="mt-5">
          <p className="mb-2 text-base">{page.familyAgreedAt ? "The family has said yes. The page can go live." : "The page goes live once the family has said yes."}</p>
          <StatusControls pageId={page.id} status={page.status} agreed={page.familyAgreedAt !== null} />
        </div>
      ) : null}

      {page.status !== "draft" && page.status !== "ended" && publicUrl ? (
        <Section title="Share">
          <div className="mt-2">
            <ShareKit title={page.title} publicUrl={publicUrl} familyUrl={familyUrl} flyerHref={`/meals/${page.id}/flyer`} />
          </div>
        </Section>
      ) : null}

      <Section title="Nights">
        {upcoming.length === 0 ? (
          <p className="mt-2 text-sm text-rubric">No nights are left on this page.</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-2" aria-label="Nights">
            {upcoming.map((s) => (
              <Night key={s.id} slot={s} pageId={page.id} notes={notes} editable={!ended} />
            ))}
          </ol>
        )}
        {earlier.length ? (
          <details className="mt-4">
            <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-action underline underline-offset-4">Earlier nights ({earlier.length})</summary>
            <ol className="mt-2 flex flex-col gap-2" aria-label="Earlier nights">
              {earlier.map((s) => (
                <Night key={s.id} slot={s} pageId={page.id} notes={notes} editable={false} />
              ))}
            </ol>
          </details>
        ) : null}
      </Section>

      {ended ? null : (
        <>
          <Section title="Add nights">
            <details className="mt-2">
              <summary className={`${btnQuiet} cursor-pointer`}>Choose more nights</summary>
              <div className="mt-4">
                <AddDatesForm pageId={page.id} today={page.today} months={grid.months} notes={grid.notes} />
              </div>
            </details>
          </Section>

          <Section title="Details and food needs">
            <details className="mt-2">
              <summary className={`${btnQuiet} cursor-pointer`}>Edit the page</summary>
              <div className="mt-4">
                <DetailsForm
                  pageId={page.id}
                  addressSuggestion={suggestion}
                  v={{
                    title: page.title,
                    note: page.note,
                    foodFor: page.foodFor,
                    kashrut: page.kashrut,
                    dietary: page.dietary,
                    allergies: page.allergies,
                    dropOffWindow: page.dropOffWindow,
                    dropOffInstructions: page.dropOffInstructions,
                    dropOffAddress: page.dropOffAddress,
                    dropOffIsHome: page.dropOffIsHome,
                    deliveryPlaces: page.deliveryPlaces,
                    giftCards: page.giftCards,
                    giftCardEmail: page.giftCardEmail,
                  }}
                />
              </div>
            </details>
          </Section>

          {page.status !== "draft" ? (
            <Section title="The page">
              <div className="mt-2">
                <StatusControls pageId={page.id} status={page.status} agreed={page.familyAgreedAt !== null} />
              </div>
            </Section>
          ) : null}
        </>
      )}

      <Section title="Organisers">
        <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface">
          {page.organisers.map((p) => (
            <li key={p.userId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <span className="min-w-0 break-words">
                {p.name} {p.lead ? <span className="text-sm text-rubric">(started it)</span> : null}
              </span>
              {!p.lead && !ended ? <RemoveCoOrganiser pageId={page.id} userId={p.userId} name={p.name} /> : null}
            </li>
          ))}
        </ul>
        {ended ? null : (
          <div className="mt-3">
            <AddCoOrganiser pageId={page.id} people={addable} />
          </div>
        )}
      </Section>

      {page.cancelledSignups.length ? (
        <Section title="Cancelled sign-ups">
          <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="cancelled">
            {page.cancelledSignups.map((c) => (
              <li key={c.id} className="px-4 py-2 text-base">
                <span className="font-semibold">{[c.firstName, c.lastName].filter(Boolean).join(" ") || "A helper"}</span>, {mealWord(c.meal).toLowerCase()} on {monthDay(c.date)}
                <span className="block text-sm text-rubric">
                  Cancelled by {c.cancelledBy === "organiser" ? "an organiser" : "the helper"}
                  {c.cancelledAt ? ` on ${instantDate(c.cancelledAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {past.length ? (
        <Section title="Past helpers who would help again">
          <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="past-helpers">
            {past.map((h) => (
              <li key={h.email} className="px-4 py-2 text-base">
                <span className="font-semibold">{[h.firstName, h.lastName].filter(Boolean).join(" ") || "A helper"}</span>
                <span className="block break-all text-sm text-rubric">
                  {h.email} · last helped {monthDay(h.lastHelped)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <p className="mt-8">
        <Link href="/meals" className="inline-flex min-h-11 items-center text-sm font-medium text-action underline underline-offset-4">
          All Mitzvah Meals pages
        </Link>
      </p>
    </AppShell>
  );
}
