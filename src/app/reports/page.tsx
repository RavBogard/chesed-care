import { redirect } from "next/navigation";
import { CHANNEL_LABEL } from "@/components/inbox-card";
import { PrintButton } from "@/components/print-button";
import { Section } from "@/components/section";
import { AppShell } from "@/components/shell/app-shell";
import { btnQuiet, inputClass, labelClass, noticeClass } from "@/components/ui";
import { shortDate } from "@/lib/format";
import { REPORT_WORDS } from "@/lib/team-wording";
import { canSeeReports, reportsAreNameless } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getReport, parsePeriod, periodChoices, type Report } from "@/server/reports/report";
import type { Cell } from "@/server/reports/small-number";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports · CRC Care" };

const show = (c: Cell) => (c === null ? REPORT_WORDS.small : String(c));
const th = "px-3 py-2 text-left text-sm font-semibold";
const td = "px-3 py-2 text-base tabular-nums";
const tableWrap = "mt-2 overflow-x-auto rounded-md border border-rule bg-surface";

function Pair({ caption, a, b, left, right }: { caption: string; a: Cell; b: Cell; left: string; right: string }) {
  return (
    <div className={tableWrap}>
      <table className="w-full">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-rule-soft">
            <th scope="col" className={th}>
              {left}
            </th>
            <th scope="col" className={th}>
              {right}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={td}>{show(a)}</td>
            <td className={td}>{show(b)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Tables({ r }: { r: Report }) {
  const median = r.firstContact.medianDays;
  return (
    <>
      <Section title={REPORT_WORDS.openItems}>
        <div className={tableWrap}>
          <table className="w-full" data-testid="report-open-items">
            <caption className="sr-only">{REPORT_WORDS.openItems}</caption>
            <thead>
              <tr className="border-b border-rule-soft">
                <th scope="col" className={th}>
                  Kind
                </th>
                {r.openItems.bands.map((b) => (
                  <th key={b} scope="col" className={th}>
                    {b}
                  </th>
                ))}
                <th scope="col" className={th}>
                  All
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule-soft">
              {r.openItems.rows.map((row) => (
                <tr key={row.kind}>
                  <th scope="row" className={`${th} font-normal`}>
                    {row.kind}
                  </th>
                  {row.cells.map((c, i) => (
                    <td key={i} className={td}>
                      {show(c)}
                    </td>
                  ))}
                  <td className={td}>{show(row.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-rule">
                <th scope="row" className={th}>
                  All open items
                </th>
                <td className={td} colSpan={r.openItems.bands.length + 1}>
                  {show(r.openItems.total)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>

      <Section title={REPORT_WORDS.firstContact}>
        <p className="mt-2 text-base" data-testid="report-first-contact">
          {median === null && r.firstContact.count === null
            ? REPORT_WORDS.small
            : median === null
              ? "No reports in this period have had a contact logged yet."
              : `The middle one took ${median} ${median === 1 ? "day" : "days"}, across ${show(r.firstContact.count)} reports.`}
        </p>
      </Section>

      <Section title={REPORT_WORDS.journeys}>
        <Pair caption={REPORT_WORDS.journeys} a={r.journeys.planned} b={r.journeys.done} left="Planned in this period" right="Done" />
      </Section>

      <Section title={REPORT_WORDS.channels}>
        <div className={tableWrap}>
          <table className="w-full" data-testid="report-channels">
            <caption className="sr-only">{REPORT_WORDS.channels}</caption>
            <thead>
              <tr className="border-b border-rule-soft">
                <th scope="col" className={th}>
                  Channel
                </th>
                <th scope="col" className={th}>
                  Reports
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule-soft">
              {r.channels.rows.map((row) => (
                <tr key={row.channel}>
                  <th scope="row" className={`${th} font-normal`}>
                    {CHANNEL_LABEL[row.channel]}
                  </th>
                  <td className={td}>{show(row.n)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-rule">
                <th scope="row" className={th}>
                  All reports
                </th>
                <td className={td}>{show(r.channels.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Section>

      <Section title={REPORT_WORDS.volunteers}>
        <Pair caption={REPORT_WORDS.volunteers} a={r.volunteers.posted} b={r.volunteers.filled} left="Posted" right="Filled" />
      </Section>
      <Section title={REPORT_WORDS.meals}>
        <Pair caption={REPORT_WORDS.meals} a={r.meals.offered} b={r.meals.covered} left="Offered" right="Covered" />
      </Section>
      <Section title={REPORT_WORDS.miSheberach}>
        <Pair caption={REPORT_WORDS.miSheberach} a={r.miSheberach.added} b={r.miSheberach.ended} left="Added" right="Ended" />
      </Section>
    </>
  );
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; period?: string }> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canSeeReports(actor)) redirect("/");
  const q = await searchParams;
  const whole = reportsAreNameless(actor);
  const period = parsePeriod(q, new Date(), { whole });
  const choices = whole ? periodChoices(new Date()) : [];
  const chosen = choices.find((c) => c.period.from === period.from && c.period.to === period.to)?.value ?? "";
  const report: Report | null = await soft("Reports: unavailable", null, () => getReport(getDb(), actor, period));
  return (
    <AppShell actor={actor} title={REPORT_WORDS.title}>
      <form method="get" className="mb-5 flex flex-wrap items-end gap-3 print:hidden" aria-label={REPORT_WORDS.period}>
        {whole ? (
          <div className="min-w-0 flex-1 basis-56">
            <label htmlFor="period" className={labelClass}>
              {REPORT_WORDS.period}
            </label>
            <select id="period" name="period" defaultValue={chosen} className={inputClass}>
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <>
        <div className="min-w-0 flex-1 basis-40">
          <label htmlFor="from" className={labelClass}>
            {REPORT_WORDS.from}
          </label>
          <input id="from" name="from" type="date" defaultValue={period.from} className={inputClass} />
        </div>
        <div className="min-w-0 flex-1 basis-40">
          <label htmlFor="to" className={labelClass}>
            {REPORT_WORDS.to}
          </label>
          <input id="to" name="to" type="date" defaultValue={period.to} className={inputClass} />
        </div>
          </>
        )}
        <button type="submit" className={btnQuiet}>
          {REPORT_WORDS.show}
        </button>
        <PrintButton />
      </form>
      <p className="mb-5 text-sm text-rubric">
        {shortDate(period.from)} to {shortDate(period.to)}
      </p>
      {report?.nameless ? <p className={`${noticeClass} mb-5`}>{REPORT_WORDS.nameless}</p> : null}
      {report ? <Tables r={report} /> : <LoadNotice what="The reports" />}
    </AppShell>
  );
}
