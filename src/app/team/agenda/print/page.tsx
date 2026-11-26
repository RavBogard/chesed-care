import Link from "next/link";
import { EntryText } from "@/components/agenda/agenda-entry";
import { PrintButton } from "@/components/print-button";
import { btnQuiet, noticeClass } from "@/components/ui";
import { AGENDA_WORDS } from "@/lib/clergy-wording";
import { longDate } from "@/lib/format";
import { canUseAgenda } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { listAgenda, type AgendaView } from "@/server/care/agenda";
import { getDb } from "@/server/db/client";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clergy agenda, to print · CRC Care" };

/** The agenda for the meeting, on paper: what is to be discussed, with a line to write the outcome. Read through the same visibility as the screen. */
export default async function AgendaPrintPage() {
  const actor = actorOrRedirect(await getViewer());
  if (!canUseAgenda(actor)) {
    return (
      <main id="main" className="mx-auto max-w-xl px-4 py-8">
        <p className={noticeClass}>The agenda is kept by the clergy.</p>
      </main>
    );
  }
  const view: AgendaView | null = await soft("Agenda: print view unavailable", null, () => listAgenda(getDb(), actor));
  const entries = view ? view.toDiscuss : [];
  return (
    <main id="main" className="mx-auto min-h-dvh max-w-3xl bg-surface px-4 py-8 text-ink sm:px-6 print:max-w-none print:p-0">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/team/agenda" className={btnQuiet}>
          Back to the agenda
        </Link>
        <PrintButton hideOnPaper />
      </div>
      <h1 className="font-serif text-3xl font-bold leading-tight print:text-[22pt]">{AGENDA_WORDS.title}</h1>
      {view ? <p className="mt-1 text-base text-rubric">Week of {longDate(view.thisWeek)}</p> : null}
      {view === null ? <LoadNotice what="The agenda" className="mt-6" /> : null}
      {view && entries.length === 0 ? <p className="mt-6 text-lg text-rubric">Nothing to discuss.</p> : null}
      {entries.length > 0 ? (
        <ol className="mt-6 flex flex-col gap-5 print:gap-4" data-testid="agenda-print">
          {entries.map((e) => (
            <li key={e.id} className="break-inside-avoid border-b border-rule pb-4" data-testid="agenda-print-entry">
              <p className="font-serif text-xl font-semibold leading-snug [overflow-wrap:anywhere] print:text-[14pt]">{e.displayName}</p>
              <EntryText e={e} />
              <p className="mt-3 border-b border-rule" aria-hidden="true">
                &nbsp;
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </main>
  );
}
