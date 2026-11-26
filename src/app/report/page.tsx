import { reportAction } from "@/app/inbox-actions";
import { ActionForm } from "@/components/action-form";
import { Section } from "@/components/section";
import { AppShell } from "@/components/shell/app-shell";
import { btnLaptopNatural, btnPrimary, inputClass, labelClass, noticeClass, rubric } from "@/components/ui";
import { REPORT_STATUS } from "@/lib/care-labels";
import { longDate } from "@/lib/format";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { listMyReports, type MyReport } from "@/server/care/proposals";
import { getDb } from "@/server/db/client";
import { listLeadSteps, type LeadStep } from "@/server/care/follow-ups";
import { getMorningSummary, type MorningSummary } from "@/server/daily/summary";
import { chicagoToday } from "@/server/lifecycle/window";
import { LeadSteps } from "@/components/lead-steps";
import { AddToCareList, AddToMiSheberach } from "@/components/report/add-directly";
import { ADD_CARE_TITLE, ADD_MI_TITLE, TELL_TITLE } from "@/lib/staff-add-wording";
import { canAddDirectly } from "@/server/access/policy";
import { listClergyChoices, type ClergyChoice } from "@/server/care/staff-add";
import { MorningStrip } from "@/components/morning-strip";
import { LoadNotice } from "@/components/load-notice";
import { logFailure, soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Report a need · CRC Care" };

/**
 * Report a need: the landing page of staff, the Mitzvah Corps lead and senior staff, and a
 * page any caregiver can open. One box and a list of one's own reports with a date and a
 * status, never what was written or what became of it beyond who picked it up.
 */
export default async function ReportPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  const reports: MyReport[] | null = await soft("Report: list unavailable", null, () => listMyReports(getDb(), actor));
  // A Mitzvah Corps lead lands here: their morning and their own journey steps come first.
  const lead = actor.role === "lead";
  const today = chicagoToday(new Date());
  let steps: LeadStep[] | null = [];
  let morning: MorningSummary | null = null;
  if (lead) {
    try {
      [steps, morning] = await Promise.all([listLeadSteps(getDb(), actor), getMorningSummary(getDb(), actor, today)]);
    } catch (error) {
      steps = null;
      logFailure("Report: steps unavailable", error);
    }
  }
  // Staff and leads add directly: the rabbis to choose from (names only).
  const direct = canAddDirectly(actor);
  const clergy: ClergyChoice[] = direct ? await soft("Report: clergy list unavailable", [], () => listClergyChoices(getDb(), actor)) : [];
  return (
    <AppShell actor={actor} title="Report a need">
      {morning ? <MorningStrip summary={morning} followUpsHref="#mitzvah-corps" stepsHref="#mitzvah-corps" /> : null}
      {lead ? (
        <div id="mitzvah-corps" className="mb-8 scroll-mt-20">
          <Section title="For you from Mitzvah Corps">
            {steps === null ? <LoadNotice what="Your steps" className="mt-2" /> : <LeadSteps steps={steps} today={today} />}
          </Section>
        </div>
      ) : null}
      {direct ? (
        <div className="mb-8">
          <Section title={ADD_CARE_TITLE}>{clergy.length > 0 ? <AddToCareList clergy={clergy} /> : <p className={`${noticeClass} mt-2`}>The rabbis could not be loaded just now. Use the box below.</p>}</Section>
          <Section title={ADD_MI_TITLE}>
            <AddToMiSheberach />
          </Section>
          <h2 className={`${rubric} mt-7`}>{TELL_TITLE}</h2>
        </div>
      ) : null}
      <ActionForm action={reportAction} className="flex flex-col gap-3">
        <label htmlFor="report-words" className={labelClass}>
          Who needs care, and what is going on?
        </label>
        <textarea id="report-words" name="words" rows={6} required maxLength={5000} className={`${inputClass} min-h-40 py-2`} aria-describedby="report-help" />
        <p id="report-help" className="text-sm text-rubric">
          A member of the clergy reads this. It goes nowhere else.
        </p>
        <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
          Send
        </button>
      </ActionForm>

      <div className="mt-8">
        <Section title="Your reports" empty="You have not sent a report yet.">
          {reports === null ? (
            <LoadNotice what="Your reports" className="mt-2" />
          ) : reports.length > 0 ? (
            <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="my-reports">
              {reports.map((r) => (
                <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3" data-testid="my-report">
                  <span className="font-semibold">{longDate(r.createdOn)}</span>
                  <span className="text-base text-rubric">{REPORT_STATUS(r)}</span>
                </li>
              ))}
            </ul>
          ) : undefined}
        </Section>
      </div>
    </AppShell>
  );
}
