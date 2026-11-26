import Link from "next/link";
import { redirect } from "next/navigation";
import { AgendaEntryRow } from "@/components/agenda/agenda-entry";
import { FreeTextForm } from "@/components/agenda/free-text-form";
import { Section } from "@/components/section";
import { AppShell } from "@/components/shell/app-shell";
import { btnQuiet } from "@/components/ui";
import { AGENDA_WORDS } from "@/lib/clergy-wording";
import { canUseAgenda } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { listAgenda, type AgendaView } from "@/server/care/agenda";
import { listTeam } from "@/server/care/users";
import { getDb } from "@/server/db/client";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";
import { holdersOf } from "@/components/holders";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clergy agenda · CRC Care" };

export default async function AgendaPage() {
  const actor = actorOrRedirect(await getViewer());
  if (!canUseAgenda(actor)) redirect("/");
  const db = getDb();
  const [view, holders] = await soft<[AgendaView | null, { id: string; name: string }[]]>("Agenda: unavailable", [null, []], () => Promise.all([listAgenda(db, actor), listTeam(db, actor).then(holdersOf)]));
  if (!view) {
    return (
      <AppShell actor={actor} title={AGENDA_WORDS.title}>
        <LoadNotice what="The agenda" />
      </AppShell>
    );
  }
  const list = (entries: AgendaView["toDiscuss"]) => (
    <ul className="mt-2 flex flex-col gap-3">
      {entries.map((e) => (
        <AgendaEntryRow key={e.id} e={e} holders={holders} actorId={actor.id} canRemove />
      ))}
    </ul>
  );
  const nothing = view.toDiscuss.length + view.nextWeek.length + view.discussed.length === 0;
  return (
    <AppShell actor={actor} title={AGENDA_WORDS.title}>
      <p className="mb-5">
        <Link href="/team/agenda/print" className={btnQuiet} data-testid="agenda-print-link">
          {AGENDA_WORDS.printLink}
        </Link>
      </p>
      {nothing ? (
        <p className="mb-5 text-base text-rubric" data-testid="agenda-empty">
          {AGENDA_WORDS.empty}
        </p>
      ) : null}
      {view.toDiscuss.length > 0 ? <Section title={AGENDA_WORDS.toDiscuss}>{list(view.toDiscuss)}</Section> : null}
      {view.nextWeek.length > 0 ? <Section title={AGENDA_WORDS.nextWeek}>{list(view.nextWeek)}</Section> : null}
      <Section title={AGENDA_WORDS.add}>
        <FreeTextForm />
      </Section>
      {view.discussed.length > 0 ? <Section title={AGENDA_WORDS.discussed}>{list(view.discussed)}</Section> : null}
    </AppShell>
  );
}
