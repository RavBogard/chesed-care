import Link from "next/link";
import { redirect } from "next/navigation";
import { CLOSED_WORDS, ClosedReportCard } from "@/components/closed-report-card";
import { LoadNotice } from "@/components/load-notice";
import { AppShell } from "@/components/shell/app-shell";
import { btnText } from "@/components/ui";
import { canReadOriginalReports } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { listClosedReports } from "@/server/care/closed-reports";
import { isUuid } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
// Numbers in the words are the sender's, never something to ring: iOS must not turn them into links.
export const metadata = { title: `${CLOSED_WORDS.title} · CRC Care`, formatDetection: { telephone: false } };

/** "Closed without action": dismissed reports and their words, for the clergy who may read them, newest closed first, 25 at a time. */
export default async function ClosedReportsPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const actor = actorOrRedirect(await getViewer());
  if (!canReadOriginalReports(actor)) redirect("/");
  const { before: asked } = await searchParams;
  // The cursor is an id and nothing else; anything that is not one starts from the newest.
  const before = isUuid(asked) ? asked : undefined;
  const page = await soft("Closed reports unavailable", null, () => listClosedReports(getDb(), actor, before ? { before } : {}));
  return (
    <AppShell actor={actor} title={CLOSED_WORDS.title}>
      <p className="mb-3">
        <Link href="/inbox" className={btnText}>
          {CLOSED_WORDS.backToInbox}
        </Link>
      </p>
      <p className="mb-4 text-sm text-rubric">{CLOSED_WORDS.intro}</p>
      {page === null ? <LoadNotice what="Closed reports" /> : null}
      {page && page.reports.length === 0 ? (
        <p className="text-base" data-testid="closed-empty">
          {CLOSED_WORDS.empty}
        </p>
      ) : null}
      {page && page.reports.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label={CLOSED_WORDS.title}>
          {page.reports.map((r) => (
            <ClosedReportCard key={r.id} report={r} />
          ))}
        </ul>
      ) : null}
      {page?.older || before ? (
        <nav aria-label="Older and newer" className="mt-4 flex flex-wrap gap-x-6">
          {page?.older ? (
            <Link href={`/inbox/closed?before=${page.older}`} className={btnText} data-testid="closed-older">
              {CLOSED_WORDS.older}
            </Link>
          ) : null}
          {before ? (
            <Link href="/inbox/closed" className={btnText}>
              {CLOSED_WORDS.newest}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </AppShell>
  );
}
