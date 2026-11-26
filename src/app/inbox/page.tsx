import Link from "next/link";
import { redirect } from "next/navigation";
import { CHANNEL_LABEL, InboxCard, type InboxEntry } from "@/components/inbox-card";
import { entryFor } from "./entry";
import { AppShell } from "@/components/shell/app-shell";
import { btnQuiet, btnSelected, btnText } from "@/components/ui";
import { canSeeLifecycle, isClergyLevel } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { createMatcher, LIST_MAX_NAMES } from "@/server/care/reading-match";
import { listInbox, type Proposal } from "@/server/care/proposals";
import { listJourneyChoices, type JourneyChoice } from "@/server/journeys/journeys";
import { listTeam } from "@/server/care/users";
import { getDb } from "@/server/db/client";
import { chicagoToday } from "@/server/lifecycle/window";
import { getSalesforce } from "@/server/salesforce";
import { AwayLines, loadAwayLines } from "@/components/team/away-lines";
import { coverMap, listAwayToday, suggestInstead } from "@/server/team/away";
import { LoadNotice } from "@/components/load-notice";
import { logFailure } from "@/server/soft";
import { holdersOf } from "@/components/holders";

export const dynamic = "force-dynamic";
// Numbers in a suggestion are the sender's words, never something to ring: iOS must not turn them into links.
export const metadata = { title: "Inbox · CRC Care", formatDetection: { telephone: false } };

/** Proposals matched to people when the list is drawn, newest first; the rest wait to be opened. */
const MATCH_LIST_LIMIT = 15;

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ channel?: string; match?: string }> }) {
  const actor = actorOrRedirect(await getViewer());
  if (!canSeeLifecycle(actor)) redirect("/");
  const { channel: asked, match: matchAsked } = await searchParams;
  const db = getDb();
  const today = chicagoToday(new Date());
  let entries: InboxEntry[] | null = null;
  let channels: Proposal["channel"][] = [];
  const channel = asked && Object.hasOwn(CHANNEL_LABEL, asked) ? (asked as Proposal["channel"]) : null;
  const awayText = await loadAwayLines(actor, today);
  let holders: { id: string; name: string }[] = [];
  let journeyChoices: JourneyChoice[] = [];
  try {
    const [proposals, team, choices] = await Promise.all([listInbox(db, actor), listTeam(db, actor), listJourneyChoices(db, actor).catch(() => [])]);
    journeyChoices = choices;
    const names = new Map(team.map((m) => [m.id, m.name ?? m.email]));
    holders = holdersOf(team);
    channels = (Object.keys(CHANNEL_LABEL) as Proposal["channel"][]).filter((c) => proposals.some((p) => p.channel === c));
    // Matching costs searches: only the newest few are matched up front, one more when its card asks, and no name is searched twice.
    const match = createMatcher({ db, sf: getSalesforce }, actor, { maxNames: LIST_MAX_NAMES });
    // A suggestion for someone who is away today becomes their coverer; the stored reading is not touched, and it reverts by itself.
    const cover = coverMap(await listAwayToday(db, today));
    const shown = proposals
      .filter((p) => !channel || p.channel === channel)
      .map((p) => (p.reading?.ownerUserId && cover.has(p.reading.ownerUserId) ? { ...p, reading: { ...p.reading, ownerUserId: suggestInstead(p.reading.ownerUserId, cover) } } : p));
    entries = await Promise.all(shown.map((p, i) => entryFor(db, actor, p, names, today, i < MATCH_LIST_LIMIT || p.id === matchAsked ? match : null)));
  } catch (error) {
    logFailure("Inbox unavailable", error);
  }
  return (
    <AppShell actor={actor} title="Inbox">
      <AwayLines lines={awayText} />
      {isClergyLevel(actor) ? (
        <p className="mb-3">
          <Link href="/inbox/bring-in" className={btnText} data-testid="inbox-bring-in-link">
            Bring in your list
          </Link>
        </p>
      ) : null}
      {entries === null ? <LoadNotice what="The Inbox" /> : null}
      {entries && entries.length === 0 ? (
        <div data-testid="inbox-empty">
          <p className="text-base">Nothing is waiting.</p>
          <p className="mt-2 text-sm text-rubric">
            The Inbox is where a need that someone else reports waits for you: from staff, from Claude, from an email or a form. Nothing reaches the care list until you accept it. A note you write yourself on Today stays yours until you send it here.
          </p>
          {isClergyLevel(actor) ? (
            <p className="mt-3 text-sm" data-testid="inbox-empty-bring-in">
              Already caring for people? <Link href="/inbox/bring-in" className="font-medium text-action underline underline-offset-4">Bring in your current list</Link> in one sitting, instead of one at a time.
            </p>
          ) : null}
        </div>
      ) : null}
      {channels.length > 1 ? (
        <nav aria-label="Filter by where it came from" className="mb-4 flex flex-wrap gap-2" data-testid="inbox-channels">
          <Link href="/inbox" scroll={false} aria-current={channel === null ? "true" : undefined} className={channel === null ? btnSelected : btnQuiet}>
            All
          </Link>
          {channels.map((c) => (
            <Link key={c} href={`/inbox?channel=${c}`} scroll={false} aria-current={channel === c ? "true" : undefined} className={channel === c ? btnSelected : btnQuiet}>
              {CHANNEL_LABEL[c]}
            </Link>
          ))}
        </nav>
      ) : null}
      {entries && entries.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label="Waiting">
          {entries.map((e) => (
            <InboxCard key={e.proposal.id} entry={e} today={today} actorId={actor.id} holders={holders} journeyChoices={journeyChoices} />
          ))}
        </ul>
      ) : null}
    </AppShell>
  );
}
