import Link from "next/link";
import { redirect } from "next/navigation";
import { PrintButton } from "@/components/print-button";
import { Section } from "@/components/section";
import { AppShell } from "@/components/shell/app-shell";
import { VisitRowView } from "@/components/visits/visit-row";
import { btnQuiet, rubric } from "@/components/ui";
import { VISITS_WORDS } from "@/lib/clergy-wording";
import { canSeeVisits } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { listVisits, type Visits } from "@/server/care/visits";
import { getDb } from "@/server/db/client";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "In hospital now · CRC Care" };

export default async function VisitsPage() {
  const actor = actorOrRedirect(await getViewer());
  if (!canSeeVisits(actor)) redirect("/");
  const visits: Visits | null = await soft("Visits: unavailable", null, () => listVisits(getDb(), actor));
  return (
    <AppShell actor={actor} title={VISITS_WORDS.title}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-rubric">{VISITS_WORDS.intro}</p>
        <PrintButton hideOnPaper />
      </div>
      {visits === null ? <LoadNotice what="The list" /> : null}
      {visits && visits.groups.length === 0 && visits.unplaced.length === 0 ? (
        <p className="text-base" data-testid="visits-empty">
          {VISITS_WORDS.empty}
        </p>
      ) : null}
      {visits?.groups.map((g) => (
        <section key={g.key} className="mt-7 first:mt-0 break-inside-avoid" aria-label={g.label} data-testid="visit-group">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className={`${rubric} min-w-0 [overflow-wrap:anywhere]`}>{g.label}</h2>
            {g.mapsHref ? (
              <a href={g.mapsHref} target="_blank" rel="noopener noreferrer" className={`${btnQuiet} print:hidden`} data-testid="visit-plan">
                {VISITS_WORDS.plan}
                <span className="sr-only">, {g.label}, opens in a new tab</span>
              </a>
            ) : null}
          </div>
          <ul className="mt-2 flex flex-col gap-3">
            {g.rows.map((r) => (
              <VisitRowView key={r.careItemId} row={r} />
            ))}
          </ul>
        </section>
      ))}
      {visits && visits.unplaced.length > 0 ? (
        <Section title={VISITS_WORDS.where}>
          <p className="mt-2 text-sm text-rubric">{VISITS_WORDS.whereHint}</p>
          <ul className="mt-2 flex flex-col gap-3" data-testid="visit-unplaced">
            {visits.unplaced.map((r) => (
              <VisitRowView key={r.careItemId} row={r} unplaced />
            ))}
          </ul>
        </Section>
      ) : null}
      <p className="mt-6 print:hidden">
        <Link href="/" className={btnQuiet}>
          Back to Today
        </Link>
      </p>
    </AppShell>
  );
}
