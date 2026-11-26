import Link from "next/link";
import { redirect } from "next/navigation";
import { ADMIN_TITLE, hasAdmin } from "../admin-rule";
import { addTeamMemberAction, changeTeamMemberRoleAction, handOverRestrictedAction, setTeamMemberActiveAction } from "@/app/settings-actions";
import { ActionForm } from "@/components/action-form";
import { ActionButton, ConfirmAction } from "@/components/confirm-sheet";
import { Section } from "@/components/section";
import { Sheet } from "@/components/sheet";
import { AppShell } from "@/components/shell/app-shell";
import { btnLaptopNatural, btnPrimary, btnQuiet, cardClass, checkBox, fieldsetClass, inputClass, labelClass, legendClass, noticeClass, titleClass } from "@/components/ui";
import { ROLE_OPTIONS } from "@/lib/care-labels";
import { JourneyTemplateForm } from "@/components/journey-template-form";
import { getSyncStatus, type SyncStatus } from "@/server/misheberach/sync";
import { serviceAccountEmail, syncMode } from "@/server/misheberach/google";
import { DescribePacket } from "@/components/misheberach/entry-forms";
import { NOT_CONNECTED, SHARE_WITH, syncProblem } from "@/lib/misheberach-wording";
import { canSeeMiSheberachSync } from "@/server/access/policy";
import { jobIsOverdue, latestJobRuns, type JobRunView } from "@/server/daily/run";
import { listJourneyTemplates, type TemplateView } from "@/server/journeys/template-store";
import * as W from "@/lib/shortcut-wording";
import { canEditJourneyTemplates, canHoldRestricted, canManageUsers, canPrintTellSign, canReleaseImportedEmails, canSeeJobRuns, normalizeEmail } from "@/server/access/policy";
import { countReleasable, type Releasable } from "@/server/volunteers/release-emails";
import { ReleaseEmailsSection } from "@/components/roster/release-emails";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { aiSortingStatus } from "@/server/care/ai-config";
import { listStrandedRestricted, type StrandedHolder } from "@/server/care/care-items";
import { listTeam, type TeamMember } from "@/server/care/users";
import { HandoverSheet } from "@/components/team/handover-sheet";
import { getHeldWork, heldCounts, type HeldWork } from "@/server/team/handover";
import { getDb } from "@/server/db/client";
import { ownerEmails } from "@/server/env";
import { LoadNotice } from "@/components/load-notice";
import { logFailure } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · CRC Care" };

const TASK_LABEL: Record<string, string> = {
  meal_purge: "Mitzvah Meals clean-up: notes and old links",
  volunteer_purge: "Volunteer tasks clean-up: notes and old links",
  mi_sheberach_expiry: "Mi Sheberach names that came off",
  mi_sheberach_sync: "Mi Sheberach packet sync",
  standing_check_ins: "Standing check-ins",
  housekeeping: "Housekeeping",
  morning_summary: "Morning summaries",
  volunteer_asks_notice: "Volunteer asks that still need someone",
  push_upkeep: "Phone notifications clean-up",
  cover_notice: "Cover notices",
  roster_upkeep: "Roster clean-up",
  corps_referral_lapse: "Mitzvah Corps referrals nobody took, withdrawn",
  helper_reminders: "Day-before reminders",
};

/** A task's counts as a short line: "items 2 · contacts 5". Counts only. */
const countsLine = (counts: Record<string, number> | null) =>
  counts && Object.keys(counts).length
    ? Object.entries(counts)
        .map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()} ${v}`)
        .join(" · ")
    : "Done";

const instantDateTime = (d: Date) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" }).format(d);

/** Who has anything on the Admin page. Each section keeps its own rule; this only decides whether the page and its links exist for the person. */
export default async function AdminPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!hasAdmin(actor)) redirect("/settings");
  const db = getDb();
  let team: TeamMember[] | null = null;
  let stranded: StrandedHolder[] = [];
  const held = new Map<string, HeldWork>();
  let templates: TemplateView[] | null = null;
  let jobRuns: JobRunView[] | null = null;
  let packet: SyncStatus | null = null;
  let releasable: Releasable | null = null;
  try {
    if (canReleaseImportedEmails(actor)) releasable = await countReleasable(db, actor);
    if (canEditJourneyTemplates(actor)) templates = await listJourneyTemplates(db, actor);
    if (canSeeJobRuns(actor)) jobRuns = await latestJobRuns(db, actor);
    if (canSeeMiSheberachSync(actor)) packet = await getSyncStatus(db, actor, syncMode());
  } catch (error) {
    logFailure("Admin: journeys, job or packet unavailable", error);
  }
  let failed = false;
  try {
    if (canManageUsers(actor)) {
      team = await listTeam(db, actor);
      stranded = await listStrandedRestricted(db, actor);
      // Who holds open work, so Deactivate offers the hand-over sheet first (restricted items are never counted).
      const counts = await heldCounts(db, actor);
      const holding = team.filter((m) => m.active && (counts.get(m.id)?.items ?? 0) + (counts.get(m.id)?.followUps ?? 0) > 0);
      for (const w of await Promise.all(holding.map((m) => getHeldWork(db, actor, m.id)))) held.set(w.userId, w);
    }
  } catch (error) {
    failed = true;
    logFailure("Admin: people unavailable", error);
  }

  // OWNER_EMAILS is the only source of owners: a row that still says owner after its email left the list acts as clergy.
  const owners = ownerEmails();
  const isCurrentOwner = (m: TeamMember) => owners.has(normalizeEmail(m.email));

  return (
    <AppShell actor={actor} title={ADMIN_TITLE}>
      {failed ? <LoadNotice what="People and roles" /> : null}

      {templates ? (
        <Section title="Journeys">
          <p className="mt-2 max-w-prose text-sm text-rubric">The steps each journey adds when it is started on a care item. Changes apply to journeys started from now on; journeys already running keep their steps.</p>
          <div className="mt-3 flex flex-col gap-3">
            {templates.map((t) => (
              <JourneyTemplateForm key={t.key} template={t} />
            ))}
          </div>
        </Section>
      ) : null}

      {releasable !== null ? <ReleaseEmailsSection count={releasable.count} token={releasable.token} /> : null}

      {canManageUsers(actor) ? (
        <Section title="AI reading">
          <p className="mt-2 max-w-prose text-sm text-rubric" data-testid="ai-sorting-status">
            {aiSortingStatus().on
              ? `On. New reports are read by ${aiSortingStatus().model} ${aiSortingStatus().route === "anthropic" ? "with the congregation's own Anthropic key" : "through Vercel AI Gateway"}. It sees only the message, never the member list.`
              : "Off. New reports wait in the Inbox without a suggestion. It is on in the live (production) app, or wherever CARE_AI_SORTING is set to on; CARE_AI_SORTING set to off always turns it off."}
          </p>
        </Section>
      ) : null}

      {jobRuns ? (
        <Section title="Daily job">
          {jobIsOverdue(jobRuns, new Date()) ? (
            <p className={`${noticeClass} mt-2`} role="alert" data-testid="job-overdue">
              The daily job has not finished a run in the last day{jobRuns.length === 0 ? " (it has never run)" : ""}. Check that its schedule is still on, and look at the list below.
            </p>
          ) : null}
          {jobRuns.length === 0 ? (
            <p className="mt-2 text-sm text-rubric" data-testid="job-never">
              It has not run yet. It runs once a day at about 6 in the morning.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-rubric">Last run {instantDateTime(new Date(Math.max(...jobRuns.map((r) => r.startedAt.getTime()))))}. Numbers only; nothing of what it touched is shown.</p>
              <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="job-runs">
                {jobRuns.map((r) => (
                  <li key={r.task} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3" data-testid="job-run">
                    <span className="font-semibold">{TASK_LABEL[r.task] ?? r.task}</span>
                    <span className={`text-sm ${r.ok === false ? "font-semibold text-alert" : "text-rubric"}`}>
                      {r.ok === null ? "Did not finish" : r.ok ? countsLine(r.counts) : `Failed (${r.errorName ?? "unknown"})`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      ) : null}

      {packet ? (
        <Section title="Mi Sheberach and the bima packet">
          <div className="mt-2 max-w-prose text-sm text-rubric" data-testid="packet-status">
            {!packet.connected ? (
              <>
                <p>{NOT_CONNECTED}</p>
                {serviceAccountEmail() ? (
                  <p className="mt-1">
                    {SHARE_WITH} <span className="font-semibold text-ink [overflow-wrap:anywhere]">{serviceAccountEmail()}</span>
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <p>
                  Connected. {packet.lastOkAt ? `Last synced ${instantDateTime(packet.lastOkAt)}.` : "Not synced yet."}{packet.lastCheckedAt ? ` Last checked ${instantDateTime(packet.lastCheckedAt)}.` : ""} Numbers only; no names are shown here.
                </p>
                {packet.ok === false ? <p className="mt-1 font-semibold text-alert">{syncProblem(packet.errorName)}</p> : null}
                {packet.counts ? <p className="mt-1">{countsLine(packet.counts)}</p> : null}
                <p className="mt-1">{packet.mode === "dry-run" ? "Trial mode: it shows what it would do and changes nothing." : "Syncing."}</p>
                <div className="mt-2">
                  <DescribePacket />
                </div>
              </>
            )}
          </div>
        </Section>
      ) : null}

      {canPrintTellSign(actor) ? (
        <Section title={W.TELL_SIGN_TITLE}>
          <p className="mt-2 max-w-prose text-sm text-rubric">{W.TELL_SIGN_HELP}</p>
          <Link href="/settings/tell-sign" className={`${btnQuiet} mt-3`}>
            {W.TELL_SIGN_LINK}
          </Link>
        </Section>
      ) : null}

      {team && canManageUsers(actor) && stranded.length > 0 ? (
        <Section title="Hand over">
          <p className="mt-2 text-sm text-rubric">These people can no longer hold restricted items. You see how many, never whose they are. Give them all to one member of the clergy.</p>
          <ul className="mt-2 flex flex-col gap-3">
            {stranded.map((h) => (
              <li key={h.userId} className={cardClass} data-testid="hand-over">
                <p className="text-base">
                  {h.count === 1 ? "1 restricted item was" : `${h.count} restricted items were`} held by {h.name}
                </p>
                <div className="mt-3">
                  <Sheet label="Hand over" title={`Hand over what ${h.name} held`}>
                    <ActionForm action={handOverRestrictedAction} className="flex flex-col gap-4">
                      <input type="hidden" name="fromUserId" value={h.userId} />
                      <p className="text-base">
                        {h.count === 1 ? "The 1 restricted item goes" : `All ${h.count} restricted items go`} to the person you pick. Who may read each one stays as it was.
                      </p>
                      <div>
                        <label htmlFor={`hand-${h.userId}`} className={labelClass}>
                          Give them to
                        </label>
                        <select id={`hand-${h.userId}`} name="toUserId" required defaultValue="" className={inputClass}>
                          <option value="" disabled>
                            Choose a member of the clergy
                          </option>
                          {team
                            .filter((m) => canHoldRestricted(m) && m.id !== actor.id && m.id !== h.userId)
                            .map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.name ?? m.email}
                              </option>
                            ))}
                        </select>
                      </div>
                      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                        Hand over
                      </button>
                    </ActionForm>
                  </Sheet>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {team && canManageUsers(actor) ? (
        <Section title="People and roles">
          <ul className="mt-2 flex flex-col gap-3">
            {team.map((m) => (
              <li key={m.id} className={cardClass} data-testid="team-member">
                <p className={`${titleClass} [overflow-wrap:anywhere]`}>{m.name ?? m.email}</p>
                <p className="text-sm text-rubric [overflow-wrap:anywhere]">
                  {m.email} · {isCurrentOwner(m) ? "owner" : m.role === "owner" ? "clergy" : m.role}
                  {m.active ? "" : " · deactivated"}
                </p>
                {!isCurrentOwner(m) && m.active ? (
                  <ActionForm action={changeTeamMemberRoleAction} className="mt-3 flex flex-wrap items-end gap-2" closeSheetOnOk={false}>
                    <input type="hidden" name="userId" value={m.id} />
                    <div className="min-w-0 flex-1 basis-56">
                      <label htmlFor={`role-${m.id}`} className={labelClass}>
                        Role
                      </label>
                      <select id={`role-${m.id}`} name="role" className={inputClass} defaultValue={m.role === "owner" ? "clergy" : m.role}>
                        {ROLE_OPTIONS.map((r) => (
                          <option key={r.role} value={r.role}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button type="submit" className={btnQuiet}>
                      Change role
                    </button>
                  </ActionForm>
                ) : null}
                {!isCurrentOwner(m) ? (
                  <div className="mt-3">
                    {m.active && held.has(m.id) ? (
                      <HandoverSheet
                        work={held.get(m.id)!}
                        holders={team.filter((t) => canHoldRestricted(t) && t.id !== m.id).map((t) => ({ id: t.id, name: t.name ?? t.email }))}
                        leads={team.filter((t) => t.active && t.role === "lead").map((t) => ({ id: t.id, name: t.name ?? t.email }))}
                      />
                    ) : m.active ? (
                      <ConfirmAction
                        action={setTeamMemberActiveAction}
                        fields={{ userId: m.id, active: "false" }}
                        label="Deactivate"
                        title={`Deactivate ${m.name ?? m.email}?`}
                        explain={`${m.name ?? m.email} will be signed out and cannot sign in again, and their Claude connection ends. Their care notes stay. You can reactivate them at any time.`}
                        confirmLabel="Deactivate"
                      />
                    ) : (
                      <ActionButton action={setTeamMemberActiveAction} fields={{ userId: m.id, active: "true" }} label="Reactivate" className={btnQuiet} closeSheetOnOk={false} />
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <h3 className={`${titleClass} mt-6`}>Add someone</h3>
          <ActionForm action={addTeamMemberAction} className="mt-3 flex flex-col gap-4" closeSheetOnOk={false}>
            <div>
              <label htmlFor="team-email" className={labelClass}>
                Google account email
              </label>
              <input id="team-email" name="email" type="email" required autoComplete="off" className={inputClass} />
            </div>
            <div>
              <label htmlFor="team-name" className={labelClass}>
                Name (optional)
              </label>
              <input id="team-name" name="name" maxLength={200} className={inputClass} />
            </div>
            <fieldset id="team-role" className={fieldsetClass}>
              <legend className={legendClass}>Role</legend>
              {ROLE_OPTIONS.map((r, i) => (
                <label key={r.role} className="flex min-h-11 items-start gap-3 py-2">
                  <input type="radio" name="role" value={r.role} defaultChecked={i === 0} className={`${checkBox} mt-0.5`} />
                  <span>
                    <span className="block text-base font-semibold">{r.label}</span>
                    <span className="block text-sm text-rubric">{r.help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
              Add to the team
            </button>
          </ActionForm>
        </Section>
      ) : null}
    </AppShell>
  );
}
