import Link from "next/link";
import { redirect } from "next/navigation";
import { BringInReview } from "@/components/bring-in-review";
import { AppShell } from "@/components/shell/app-shell";
import { btnQuiet } from "@/components/ui";
import { isClergyLevel } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { listBatchQueue, quickPerson } from "@/server/care/bring-in";
import { createMatcher, LIST_MAX_NAMES } from "@/server/care/reading-match";
import { listTeam } from "@/server/care/users";
import { getDb } from "@/server/db/client";
import { listJourneyChoices } from "@/server/journeys/journeys";
import { chicagoToday } from "@/server/lifecycle/window";
import { getSalesforce } from "@/server/salesforce";
import { entryFor } from "../../entry";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";
import { holdersOf } from "@/components/holders";

export const dynamic = "force-dynamic";
export const metadata = { title: "Check your list · CRC Care", formatDetection: { telephone: false } };

/** Your own list, one entry at a time. `after` is the place in the list already looked at: Skip moves it on, and so does deciding one. */
export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  const actor = actorOrRedirect(await getViewer());
  if (!isClergyLevel(actor)) redirect("/");
  const { after } = await searchParams;
  const done = after !== undefined && /^\d{1,2}$/.test(after) ? Number(after) : -1;
  const db = getDb();
  const today = chicagoToday(new Date());
  const queue: Awaited<ReturnType<typeof listBatchQueue>> | null = await soft("List review unavailable", null, () => listBatchQueue(db, actor));
  const current = queue ? (queue.find((q) => q.n > done) ?? queue[0]) : undefined;
  let body: React.ReactNode;
  if (queue === null) {
    body = <LoadNotice what="Your list" />;
  } else if (!current) {
    body = (
      <div data-testid="bring-in-finished">
        <p className="text-base">That is everyone on your list.</p>
        <p className="mt-2 text-sm text-rubric">Anyone you left unfinished waits in your Inbox.</p>
        <p className="mt-4">
          <Link href="/" className={btnQuiet}>
            Back to Today
          </Link>
        </p>
      </div>
    );
  } else {
    const [team, choices] = await Promise.all([listTeam(db, actor), listJourneyChoices(db, actor).catch(() => [])]);
    const names = new Map(team.map((m) => [m.id, m.name ?? m.email]));
    const holders = holdersOf(team);
    const entry = await entryFor(db, actor, current.proposal, names, today, createMatcher({ db, sf: getSalesforce }, actor, { maxNames: LIST_MAX_NAMES }));
    const quick = await quickPerson({ db, sf: getSalesforce, now: new Date() }, actor, current.proposal).catch(() => null);
    body = <BringInReview key={current.proposal.id} entry={entry} quick={quick} position={current.n + 1} total={current.total} left={queue!.length} skipHref={`/inbox/bring-in/review?after=${current.n}`} today={today} actorId={actor.id} holders={holders} journeyChoices={choices} />;
  }
  return (
    <AppShell actor={actor} title="Check your list">
      {body}
    </AppShell>
  );
}
