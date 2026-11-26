import { reopenProposalAction } from "@/app/inbox-actions";
import { instantDate } from "@/lib/format";
import type { ClosedReport } from "@/server/care/closed-reports";
import { ActionButton } from "./confirm-sheet";
import { CHANNEL_LABEL } from "./inbox-card";
import { btnQuiet, cardClass } from "./ui";

/** The words of "Closed without action", in one place. */
export const CLOSED_WORDS = {
  title: "Closed without action",
  link: (n: number) => `Closed without action (${n})`,
  intro: "Reports a rabbi closed without action. Their words are kept for the rabbis. Reopen one to put it back in the Inbox.",
  empty: "Nothing has been closed without action.",
  arrived: "Arrived",
  closed: "Closed",
  by: (name: string) => `by ${name}`,
  own: "Your own note. Only you see it.",
  reopen: "Reopen",
  reopenAria: "Reopen: put it back in the Inbox",
  older: "Load older",
  newest: "Back to the newest",
  backToInbox: "Back to the Inbox",
} as const;

const Row = ({ term, children }: { term: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
    <dt className="shrink-0 text-sm font-semibold text-rubric sm:w-24">{term}</dt>
    <dd className="min-w-0 break-words text-base">{children}</dd>
  </div>
);

/** One dismissed report: where it came from, when it arrived and was closed, its words as plain text, and Reopen. */
export function ClosedReportCard({ report }: { report: ClosedReport }) {
  const from = report.ownCapture ? "You" : report.from;
  return (
    <li className={cardClass} data-testid="closed-report">
      <p className="text-sm text-rubric">
        {from ? `${from} · ` : ""}
        {CHANNEL_LABEL[report.channel]}
      </p>
      {report.ownCapture ? <p className="mt-1 text-sm text-rubric">{CLOSED_WORDS.own}</p> : null}
      <dl className="mt-2 flex flex-col gap-2">
        <Row term={CLOSED_WORDS.arrived}>{instantDate(report.receivedAt)}</Row>
        {report.closedAt ? (
          <Row term={CLOSED_WORDS.closed}>
            {instantDate(report.closedAt)}
            {report.closedByName ? ` ${CLOSED_WORDS.by(report.closedByName)}` : ""}
          </Row>
        ) : null}
      </dl>
      <blockquote className="mt-3 whitespace-pre-wrap break-words rounded-md bg-tint p-3 text-base" data-testid="closed-words">
        {report.words}
      </blockquote>
      <div className="mt-3">
        <ActionButton action={reopenProposalAction} fields={{ proposalId: report.id }} label={CLOSED_WORDS.reopen} ariaLabel={CLOSED_WORDS.reopenAria} className={btnQuiet} />
      </div>
    </li>
  );
}
