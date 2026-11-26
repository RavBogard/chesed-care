import Link from "next/link";
import { setVisitLocationAction, visitedAction } from "@/app/visits-actions";
import { VISITS_WORDS } from "@/lib/clergy-wording";
import { monthDay } from "@/lib/format";
import type { VisitRow } from "@/server/care/visits";
import { ActionForm } from "../action-form";
import { btnPrimary, btnQuiet, cardClass, inputClass, labelClass, nameClass, nameLink, tagQuiet } from "../ui";
import { ActionButton } from "@/components/confirm-sheet";

/** One person on the hospital list: since when, last contact, next follow-up, and one tap for "Visited". */
export function VisitRowView({ row, unplaced = false }: { row: VisitRow; unplaced?: boolean }) {
  return (
    <li className={`${cardClass} break-inside-avoid`} data-testid="visit-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href={row.href} className={`${nameLink} ${nameClass}`}>
          {row.name}
        </Link>
        {row.visitedToday ? <span className={tagQuiet}>{VISITS_WORDS.visitedToday}</span> : null}
      </div>
      <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-rubric">{VISITS_WORDS.since}</dt>
          <dd className="tabular-nums">{monthDay(row.since)}</dd>
        </div>
        <div>
          <dt className="text-rubric">{VISITS_WORDS.lastContact}</dt>
          <dd className="tabular-nums">{row.lastContact ? monthDay(row.lastContact) : VISITS_WORDS.none}</dd>
        </div>
        <div>
          <dt className="text-rubric">{VISITS_WORDS.nextFollowUp}</dt>
          <dd className="tabular-nums">{row.nextFollowUp ? monthDay(row.nextFollowUp) : VISITS_WORDS.none}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-end gap-2 print:hidden">
        {unplaced ? (
          <ActionForm action={setVisitLocationAction} className="flex flex-wrap items-end gap-2" closeSheetOnOk={false}>
            <input type="hidden" name="careItemId" value={row.careItemId} />
            <div className="min-w-0 flex-1 basis-56">
              <label htmlFor={`loc-${row.careItemId}`} className={labelClass}>
                {VISITS_WORDS.where}
              </label>
              <input id={`loc-${row.careItemId}`} name="location" required maxLength={200} placeholder={VISITS_WORDS.placePlaceholder} className={inputClass} autoComplete="off" />
            </div>
            <button type="submit" className={btnQuiet}>
              {VISITS_WORDS.setPlace}
            </button>
          </ActionForm>
        ) : null}
        <ActionButton action={visitedAction} fields={{ careItemId: row.careItemId }} label={VISITS_WORDS.visited} className={row.visitedToday ? btnQuiet : btnPrimary} showOk={false} ariaLabel={`${VISITS_WORDS.visited}: ${row.name}`} />
      </div>
    </li>
  );
}
