import Link from "next/link";
import { personPath } from "@/lib/care-labels";
import { dueLabel } from "@/lib/format";
import { ADD_TO_LIST, asksAboutMiSheberach } from "@/lib/misheberach-wording";
import type { FollowUp } from "@/server/care/follow-ups";
import type { TeamChoice } from "./care-fields";
import { FollowUpControls } from "./follow-up-controls";
import { btnText, cardClass, titleClass } from "./ui";

/** One follow-up on Today: whom it is about, what, when, its controls and a link to the person. */
export function FollowUpRow({ followUp: f, today, ownerName, canEdit = false, holders = [], actorId = "" }: { followUp: FollowUp; today: string; ownerName?: string | null; canEdit?: boolean; holders?: TeamChoice[]; actorId?: string }) {
  const overdue = f.dueDate < today;
  const who = f.displayName ?? "this person";
  return (
    <li className={cardClass} data-testid="follow-up-row">
      <h3 className={titleClass}>{f.displayName ?? "A person on your list"}</h3>
      <p className="text-base">{f.title}</p>
      <p className={`mt-1 text-sm ${overdue ? "font-semibold text-alert" : "text-rubric"}`}>
        {dueLabel(today, f.dueDate)}
        {ownerName ? ` · ${ownerName}` : ""}
        {f.forLead ? " · for Mitzvah Corps" : ""}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <FollowUpControls f={f} who={who} canEdit={canEdit} holders={holders} actorId={actorId} />
        {canEdit && asksAboutMiSheberach(f) ? (
          <Link href={`/mi-sheberach/new?careItem=${f.careItemId}`} className={btnText}>
            {ADD_TO_LIST}
          </Link>
        ) : null}
        {f.sfContactId || f.outsidePersonId ? (
          <Link href={personPath(f)} className={btnText}>
            Open {f.displayName ? f.displayName.split(" ")[0] : "person"}
          </Link>
        ) : null}
      </div>
    </li>
  );
}
