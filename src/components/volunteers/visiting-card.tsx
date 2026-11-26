import Link from "next/link";
import { endVisitingEntryAction, logVisitAction, setVisitorAction, updateVisitingEntryAction } from "@/app/visiting-actions";
import { ActionForm } from "@/components/action-form";
import { ConfirmAction } from "@/components/confirm-sheet";
import { Sheet } from "@/components/sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, inputClass, labelClass } from "@/components/ui";
import { mapsUrlForPlace } from "@/lib/address";
import { shortDate } from "@/lib/format";
import { lastVisitWords, NO_VISITOR, VISITING_HINT, VISITING_LABELS, visitCountWords, visitorWords } from "@/lib/visiting-wording";
import { addDays } from "@/server/lifecycle/window";
import { visitingPersonHref, type VisitingEntry, type VisitorChoice } from "@/server/volunteers/visiting";

/** One person on the visiting list, with the controls the viewer may use. Health information is never shown: there is none. */
export function VisitingCard({ entry, choices, today, canManage }: { entry: VisitingEntry; choices: VisitorChoice[]; today: string; canManage: boolean }) {
  const maps = mapsUrlForPlace(entry.place);
  const id = `v-${entry.id}`;
  return (
    <li className="px-4 py-3" data-testid="visiting-entry">
      <h3 className="font-serif text-[1.0625rem] font-semibold leading-snug">
        {canManage ? (
          <Link href={visitingPersonHref(entry)} className="underline decoration-control underline-offset-4">
            {entry.name}
          </Link>
        ) : (
          entry.name
        )}
      </h3>
      {entry.place ? (
        <p className="mt-1 break-words text-base">
          {entry.place}
          {maps ? (
            <>
              {" "}
              <a href={maps} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-action underline underline-offset-4">
                Map
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {entry.contactLine ? <p className="break-words text-base">{entry.contactLine}</p> : null}
      {entry.visitorNote ? <p className="mt-1 break-words text-sm">Note: {entry.visitorNote}</p> : null}
      <p className="mt-1 text-sm text-rubric">{visitorWords(entry.visitorName)}</p>
      <p className="text-sm text-rubric">
        {lastVisitWords(entry.lastVisit ? shortDate(entry.lastVisit) : null)}
        {entry.visitCount > 0 ? ` · ${visitCountWords(entry.visitCount)}` : ""}
      </p>
      <div className="mt-2 flex flex-wrap items-start gap-2">
        <Sheet label="Regular visitor" ariaLabel={`Choose a regular visitor for ${entry.name}`} title="Regular visitor" triggerClassName={btnQuiet}>
          <ActionForm action={setVisitorAction} className="flex flex-col gap-4">
            <input type="hidden" name="entryId" value={entry.id} />
            <div>
              <label htmlFor={`${id}-who`} className={labelClass}>
                Who visits
              </label>
              <select id={`${id}-who`} name="memberId" defaultValue={entry.visitorMemberId ?? ""} className={inputClass}>
                <option value="">{NO_VISITOR}</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.canVisit ? "" : " (has not said visits)"}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
              Save
            </button>
          </ActionForm>
        </Sheet>
        <Sheet label="Log a visit" ariaLabel={`Log a visit to ${entry.name}`} title="Log a visit" triggerClassName={btnPrimary}>
          <ActionForm action={logVisitAction} className="flex flex-col gap-4">
            <input type="hidden" name="entryId" value={entry.id} />
            <div>
              <label htmlFor={`${id}-day`} className={labelClass}>
                Day of the visit
              </label>
              <input id={`${id}-day`} name="visitedOn" type="date" required min={addDays(today, -60)} max={today} defaultValue={today} className={inputClass} />
            </div>
            <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
              Log the visit
            </button>
          </ActionForm>
        </Sheet>
        {canManage ? (
          <>
            <Sheet label="Edit" ariaLabel={`Edit ${entry.name}`} title={`Edit ${entry.name}`} triggerClassName={btnQuiet}>
              <ActionForm action={updateVisitingEntryAction} className="flex flex-col gap-4">
                <input type="hidden" name="entryId" value={entry.id} />
                <div>
                  <label htmlFor={`${id}-place`} className={labelClass}>
                    {VISITING_LABELS.place}
                  </label>
                  <input id={`${id}-place`} name="place" required maxLength={300} defaultValue={entry.place ?? ""} className={inputClass} />
                </div>
                <div>
                  <label htmlFor={`${id}-contact`} className={labelClass}>
                    {VISITING_LABELS.contactLine}
                  </label>
                  <input id={`${id}-contact`} name="contactLine" maxLength={200} defaultValue={entry.contactLine ?? ""} className={inputClass} />
                </div>
                <div>
                  <label htmlFor={`${id}-note`} className={labelClass}>
                    {VISITING_LABELS.note}
                  </label>
                  <textarea id={`${id}-note`} name="visitorNote" rows={2} maxLength={300} defaultValue={entry.visitorNote ?? ""} className={`${inputClass} py-2`} aria-describedby={`${id}-note-help`} />
                  <p id={`${id}-note-help`} className="mt-1 text-sm text-rubric">
                    {VISITING_HINT}
                  </p>
                </div>
                <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                  Save
                </button>
              </ActionForm>
            </Sheet>
            <ConfirmAction action={endVisitingEntryAction} fields={{ entryId: entry.id }} label="Take off the list" ariaLabel={`Take ${entry.name} off the visiting list`} title={`Take ${entry.name} off the list?`} explain="They are no longer shown here, and the entry and its visits are deleted after 30 days." confirmLabel="Take off the list" />
          </>
        ) : null}
      </div>
    </li>
  );
}
