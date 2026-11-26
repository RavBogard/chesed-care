import Link from "next/link";
import { FollowUpRow } from "./follow-up-row";
import { QuickCapture } from "./quick-capture";
import { MarkAnnouncer } from "./mark-announcer";
import { Group, TodayDates } from "./today-dates";
import { cardClass, nameClass, nameLink } from "./ui";
import { personPath } from "@/lib/care-labels";
import { longDate } from "@/lib/format";
import { canSeeLifecycle, isClergyLevel, type Actor } from "@/server/access/policy";
import { getTodayCare, type TodayCare } from "@/server/care/boards";
import { listCareItems } from "@/server/care/care-items";
import { getMorningSummary, type MorningSummary } from "@/server/daily/summary";
import { listJourneyChoices, type JourneyChoice } from "@/server/journeys/journeys";
import { MorningStrip } from "./morning-strip";
import { AwayLines, CoveringSection, loadAwayLines, loadCovering } from "./team/away-lines";
import { AGENDA_WORDS, VISITS_WORDS } from "@/lib/clergy-wording";
import { Outreach } from "./outreach";
import { isDone } from "./occasion-list";
import { getOutreachSuggestions, type Suggestion } from "@/server/care/suggestions";
import { getTodayPrefs, type TodayPrefs } from "@/server/care/today-prefs";
import { MiPrompts } from "./misheberach/prompts";
import { PROMPT_TITLE } from "@/lib/misheberach-wording";
import { listPrompts, type Prompt } from "@/server/misheberach/list";
import { listMarkKeys } from "@/server/care/occasion-marks";
import { listTeam } from "@/server/care/users";
import { getTextDrafts, type OwnDrafts } from "@/server/care/text-drafts";
import { getDb } from "@/server/db/client";
import { getOccasions, type OccasionsView } from "@/server/lifecycle/occasions";
import { chicagoToday } from "@/server/lifecycle/window";
import { getSalesforce } from "@/server/salesforce";
import { LoadNotice } from "@/components/load-notice";
import { logFailure, soft } from "@/server/soft";
import { holdersOf } from "@/components/holders";

async function loadCare(actor: Actor, today: string): Promise<TodayCare | null> {
  return soft("Today: care list unavailable", null, () => getTodayCare(getDb(), actor, today));
}

/** Whether this clergy member holds no open care items at all (a failure says no, so the invitation is never shown by mistake). */
async function holdsNone(actor: Actor, today: string): Promise<boolean> {
  return soft("Today: held items unavailable", false, async () => (await listCareItems(getDb(), actor, { status: "active", today, audit: false })).every((i) => i.ownerUserId !== actor.id));
}

/** Who can hold care: the choices for owning a follow-up and for the decision sheet. A failure leaves the list empty, never the page broken. */
async function loadHolders(actor: Actor): Promise<{ id: string; name: string }[]> {
  return soft("Today: holders unavailable", [], async () => holdersOf((await listTeam(getDb(), actor))));
}

/** The morning's counts (the daily job), and the journeys quick capture can start. Either failing leaves it off, never the page broken. */
async function loadMorning(actor: Actor, today: string): Promise<MorningSummary | null> {
  return soft("Today: morning summary unavailable", null, () => getMorningSummary(getDb(), actor, today));
}

async function loadJourneyChoices(actor: Actor): Promise<JourneyChoice[]> {
  return soft("Today: journey choices unavailable", [], () => listJourneyChoices(getDb(), actor));
}

/** Names that come off the Mi Sheberach list within a week (clergy). A failure leaves the prompt off, never the page broken. */
async function loadPrompts(actor: Actor): Promise<Prompt[]> {
  return soft("Today: Mi Sheberach prompts unavailable", [], () => listPrompts(getDb(), actor));
}

/** "You might reach out to" (clergy): a failure leaves it off, never the page broken. */
async function loadSuggestions(actor: Actor): Promise<Suggestion[]> {
  return soft("Today: suggestions unavailable", [], () => getOutreachSuggestions(getDb(), actor));
}

async function loadPrefs(actor: Actor): Promise<TodayPrefs> {
  return soft("Today: preferences unavailable", { kind: null, hideBirthdays: false }, () => getTodayPrefs(getDb(), actor));
}

async function loadDates(actor: Actor): Promise<{ view: OccasionsView; marks: Set<string>; drafts: OwnDrafts } | null> {
  try {
    const db = getDb();
    const view = await getOccasions({ db, sf: getSalesforce, now: new Date() }, actor);
    const years = [...view.todays, ...view.week, ...view.mourning].map((o) => Number(o.date.slice(0, 4)));
    const [marks, drafts] = await Promise.all([listMarkKeys(db, actor, years.length ? years : [Number(view.today.slice(0, 4))]), getTextDrafts(db, actor)]);
    return { view, marks, drafts };
  } catch (error) {
    logFailure("Today: dates unavailable", error);
    return null;
  }
}

/**
 * Today, in the order of the morning pass: follow-ups that are due, today's dates,
 * households in shloshim, tomorrow's dates, then the rest of the week in brief.
 * The date is shown once: as the heading of today's dates, or alone when there are none to show.
 */
export async function TodayBody({ actor }: { actor: Actor }) {
  const today = chicagoToday(new Date());
  const lifecycle = canSeeLifecycle(actor);
  const clergy = isClergyLevel(actor);
  const [care, dates, holders, morning, journeyChoices, prompts, suggestions, prefs, none, awayText, covering] = await Promise.all([
    loadCare(actor, today),
    lifecycle ? loadDates(actor) : Promise.resolve(null),
    clergy ? loadHolders(actor) : Promise.resolve([]),
    loadMorning(actor, today),
    clergy ? loadJourneyChoices(actor) : Promise.resolve([]),
    clergy ? loadPrompts(actor) : Promise.resolve([]),
    clergy ? loadSuggestions(actor) : Promise.resolve([]),
    lifecycle ? loadPrefs(actor) : Promise.resolve({ kind: null, hideBirthdays: false } as TodayPrefs),
    clergy ? holdsNone(actor, today) : Promise.resolve(false),
    clergy ? loadAwayLines(actor, today) : Promise.resolve([] as string[]),
    clergy ? loadCovering(actor, today) : Promise.resolve([]),
  ]);
  // One count for the whole day: what is due, what is dated today, and how much of it is done.
  const dayTotal = (care ? care.due.length + care.doneToday : 0) + (dates ? dates.view.todays.length : 0);
  const dayDone = (care ? care.doneToday : 0) + (dates ? dates.view.todays.filter((o) => isDone(dates.marks, o)).length : 0);
  const nothingToDo = care && care.due.length === 0 && care.attention.length === 0;

  return (
    <MarkAnnouncer>
      {dates ? null : <p className="mb-5 text-sm text-rubric">{longDate(today)}</p>}
      {morning ? <MorningStrip summary={morning} /> : null}
      <AwayLines lines={awayText} />

      {dayTotal > 0 ? (
        <p className="mb-5 text-sm font-medium text-rubric tabular-nums" data-testid="day-progress">
          {dayTotal === 1 ? "1 thing today" : `${dayTotal} things today`}, {dayDone} done
          {dayDone === dayTotal ? <span className="ml-2 font-semibold text-done" data-testid="day-finished">That is everything for today.</span> : null}
        </p>
      ) : null}

      {/* Follow-ups come first (DESIGN.md: order on Today follows the morning); capturing and the side doors sit beneath them. */}
      {care === null ? <LoadNotice what="Your follow-ups" className="mb-5" /> : null}
      {care && care.due.length > 0 ? (
        <div id="follow-ups" className="scroll-mt-20">
        <Group title="Follow-ups for you">
          <ul className="mt-2 flex flex-col gap-3">
            {care.due.map((f) => (
              <FollowUpRow key={f.id} followUp={f} today={today} canEdit={isClergyLevel(actor)} holders={holders} actorId={actor.id} />
            ))}
          </ul>
        </Group>
        </div>
      ) : null}
      {care && care.attention.length > 0 ? (
        <Group title="Care items with nothing planned">
          <ul className="mt-2 flex flex-col gap-3">
            {care.attention.map((i) => (
              <li key={i.id} className={cardClass}>
                <Link href={personPath(i)} className={`${nameLink} ${nameClass}`}>
                  {i.displayName}
                </Link>
                <p className="text-sm text-rubric">No follow-up is set.</p>
              </li>
            ))}
          </ul>
        </Group>
      ) : null}

      <CoveringSection covering={covering} actor={actor} today={today} holders={holders} />

      {clergy ? <QuickCapture today={today} actorId={actor.id} holders={holders} journeyChoices={journeyChoices} /> : null}

      {none ? (
        <p className="mb-6 text-base" data-testid="today-bring-in">
          Nobody is on your care list yet. If you are already caring for people, you can{" "}
          <Link href="/inbox/bring-in" className="font-medium text-action underline underline-offset-4">
            bring in your current list
          </Link>{" "}
          in one sitting.
        </p>
      ) : null}

      {prompts.length > 0 ? (
        <Group title={PROMPT_TITLE}>
          <MiPrompts prompts={prompts} />
        </Group>
      ) : null}

      {clergy ? (
        <p className="mb-5 flex flex-wrap gap-x-5">
          <Link href="/today/visits" className="inline-flex min-h-11 items-center font-medium text-action underline underline-offset-4" data-testid="today-visits-link">
            {VISITS_WORDS.link}
          </Link>
          <Link href="/team/agenda" className="inline-flex min-h-11 items-center font-medium text-action underline underline-offset-4" data-testid="today-agenda-link">
            {AGENDA_WORDS.title}
          </Link>
        </p>
      ) : null}

      {lifecycle && dates === null ? <LoadNotice what="Dates from Salesforce" className="mt-5" /> : null}
      {dates ? <TodayDates view={dates.view} marks={dates.marks} drafts={dates.drafts} prefs={prefs} /> : null}

      <Outreach suggestions={suggestions} />

      {!lifecycle && nothingToDo ? <p className="text-rubric">Nothing is waiting for you. Care items assigned to you will appear here.</p> : null}
    </MarkAnnouncer>
  );
}
