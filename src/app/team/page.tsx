import Link from "next/link";
import { redirect } from "next/navigation";
import { reassignCareItemAction, reassignFollowUpAction } from "@/app/team-actions";
import { Section } from "@/components/section";
import { AwayLines, loadAwayLines } from "@/components/team/away-lines";
import { AGENDA_WORDS } from "@/lib/clergy-wording";
import { AppShell } from "@/components/shell/app-shell";
import { ReassignForm } from "@/components/team/reassign-form";
import { cardClass, nameClass, nameLink, tagQuiet } from "@/components/ui";
import { monthDay } from "@/lib/format";
import { TEAM_WORDS } from "@/lib/team-wording";
import { canSeeTeamView } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { listActiveLeads } from "@/server/journeys/journeys";
import { getTeamOverview, type NeedsRow, type TeamOverview } from "@/server/team/overview";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team · CRC Care" };

function Count({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-rubric">{label}</dt>
      <dd className="text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function NeedsList({ title, rows, empty, children }: { title: string; rows: NeedsRow[]; empty: string; children?: (row: NeedsRow) => React.ReactNode }) {
  return (
    <Section title={title} empty={rows.length === 0 ? empty : undefined}>
      {rows.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.id} className={cardClass} data-testid="needs-row">
              <Link href={r.href} className={`${nameLink} ${nameClass}`}>
                {r.label}
              </Link>
              <p className="text-sm text-rubric [overflow-wrap:anywhere]">{r.detail}</p>
              {children?.(r)}
            </li>
          ))}
        </ul>
      ) : undefined}
    </Section>
  );
}

export default async function TeamPage() {
  const actor = actorOrRedirect(await getViewer());
  if (!canSeeTeamView(actor)) redirect("/");
  const db = getDb();
  const [overview, leads] = await soft<[TeamOverview | null, { id: string; name: string }[]]>("Team: unavailable", [null, []], () => Promise.all([getTeamOverview(db, actor), listActiveLeads(db, actor).catch(() => [])]));
  if (!overview) {
    return (
      <AppShell actor={actor} title="Team">
        <LoadNotice what="The team view" />
      </AppShell>
    );
  }
  const awayText = await loadAwayLines(actor, overview.today);
  const holders = overview.people.filter((p) => p.role === "owner" || p.role === "clergy").map((p) => ({ id: p.userId, name: p.name }));
  const withLeads = [...holders, ...leads];

  return (
    <AppShell actor={actor} title="Team">
      <AwayLines lines={awayText} />
      <p className="mb-5">
        <Link href="/team/agenda" className="font-medium text-action underline underline-offset-4" data-testid="team-agenda-link">
          {AGENDA_WORDS.title}
        </Link>
      </p>
      <Section title={TEAM_WORDS.people}>
        <ul className="mt-2 flex flex-col gap-3">
          {overview.people.map((p) => (
            <li key={p.userId} className={cardClass} data-testid="team-person">
              <p className={`${nameClass} [overflow-wrap:anywhere]`}>
                {p.name}
                {p.self ? <span className="ml-2 align-middle"><span className={tagQuiet}>You</span></span> : null}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                <Count label={TEAM_WORDS.openItems} value={p.openItems} />
                <Count label={TEAM_WORDS.overdue} value={p.overdue} />
                <Count label={TEAM_WORDS.dueThisWeek} value={p.dueThisWeek} />
                <Count label={TEAM_WORDS.journeySteps} value={p.journeyStepsComing} />
                <Count label={TEAM_WORDS.lastContact} value={p.lastContact ? monthDay(p.lastContact) : TEAM_WORDS.none} />
              </dl>
              {p.restrictedNote ? <p className="mt-2 text-sm text-rubric">{TEAM_WORDS.restrictedLine}</p> : null}
            </li>
          ))}
        </ul>
      </Section>

      <Section title={TEAM_WORDS.needsSomeone}>
        <p className="mt-2 text-sm text-rubric">{TEAM_WORDS.needsIntro}</p>
      </Section>
      <NeedsList title={TEAM_WORDS.noOwner} rows={overview.noOwner} empty={TEAM_WORDS.nothing}>
        {(r) => <ReassignForm action={reassignCareItemAction} idField="careItemId" id={r.id} holders={holders} label={TEAM_WORDS.giveTo} />}
      </NeedsList>
      <NeedsList title={TEAM_WORDS.unassigned} rows={overview.unassignedFollowUps} empty={TEAM_WORDS.nothing}>
        {(r) => <ReassignForm action={reassignFollowUpAction} idField="followUpId" id={r.id} holders={r.forLead ? withLeads : holders} label={TEAM_WORDS.giveTo} />}
      </NeedsList>
      <NeedsList title={TEAM_WORDS.inbox} rows={overview.inboxWaiting} empty={TEAM_WORDS.nothing} />
      <NeedsList title={TEAM_WORDS.volunteers} rows={overview.volunteerTasks} empty={TEAM_WORDS.nothing} />
      <NeedsList title={TEAM_WORDS.meals} rows={overview.mealNights} empty={TEAM_WORDS.nothing} />
    </AppShell>
  );
}
