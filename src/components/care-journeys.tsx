import { endJourneyAction, setKeepNotesAction, startJourneyAction } from "@/app/journey-actions";
import { instantDate, shortDate } from "@/lib/format";
import { notesDeleteOn } from "@/server/daily/retention";
import type { CareItem } from "@/server/care/care-items";
import type { JourneyChoice, JourneyView } from "@/server/journeys/journeys";
import { ActionForm } from "./action-form";
import { ConfirmAction } from "./confirm-sheet";
import { JourneyPicker } from "./journey-picker";
import { Sheet } from "./sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, rubric } from "./ui";

/**
 * The journeys running on one care item: the name, the next step and its day, what a
 * Mitzvah Corps lead reported back, and End. Ending removes the steps still to do and keeps
 * the done ones, so it asks first.
 */
export function ItemJourneys({ journeys, manage }: { journeys: JourneyView[]; manage: boolean }) {
  const running = journeys.filter((j) => !j.ended);
  const reports = journeys.flatMap((j) => j.steps.filter((s) => s.forLead && s.done && s.outcomeNote).map((s) => ({ ...s, journey: j.name })));
  if (running.length === 0 && reports.length === 0) return null;
  return (
    <div className="mt-3 border-t border-rule-soft pt-3" data-testid="care-journeys">
      <h4 className={rubric}>Journeys</h4>
      <ul className="mt-1 flex flex-col gap-2">
        {running.map((j) => {
          const left = j.steps.filter((s) => !s.done).length;
          return (
            <li key={j.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1" data-testid="care-journey">
              <div className="min-w-0">
                <p className="text-base font-semibold">{j.name}</p>
                <p className="text-sm text-rubric">{j.next ? `Next: ${j.next.title}, ${shortDate(j.next.dueDate)}` : "Nothing left to do"}</p>
              </div>
              {manage ? (
                <ConfirmAction
                  action={endJourneyAction}
                  fields={{ journeyId: j.id }}
                  label="End"
                  ariaLabel={`End the ${j.name.toLowerCase()} journey`}
                  title={`End the ${j.name.toLowerCase()} journey?`}
                  explain={left === 0 ? "Its done steps stay in the record." : `${left === 1 ? "The 1 step" : `The ${left} steps`} still to do will be removed. Done steps stay in the record.`}
                  confirmLabel="End journey"
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {reports.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1" data-testid="lead-reports">
          {reports.map((r) => (
            <li key={r.id} className="text-sm">
              <span className="font-semibold">Mitzvah Corps, {r.title.toLowerCase()}:</span> {r.outcomeNote}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** "Start a journey": a sheet with the picker and its preview. Journeys already running on the item are not offered. */
export function StartJourney({ item, who, choices, running, today }: { item: CareItem; who: string; choices: JourneyChoice[]; running: Set<string>; today: string }) {
  const offered = choices.filter((c) => !running.has(c.key));
  if (offered.length === 0) return null;
  return (
    <Sheet label="Start a journey" title={`Start a journey for ${who}`}>
      <ActionForm action={startJourneyAction} className="flex flex-col gap-4">
        <input type="hidden" name="careItemId" value={item.id} />
        <JourneyPicker options={offered} today={today} idPrefix={`journey-${item.id}`} initialKey={offered.length === 1 ? offered[0].key : ""} />
        <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
          Start the journey
        </button>
      </ActionForm>
    </Sheet>
  );
}

/**
 * On a closed item: when its note text will be deleted (three years after closing), and
 * "Keep these notes" for clergy who fully see it. The fact of care itself is always kept.
 */
export function NotesRetention({ item, manage }: { item: CareItem; manage: boolean }) {
  const due = notesDeleteOn(item);
  const line = item.notesPurgedAt
    ? `Notes deleted ${instantDate(item.notesPurgedAt)}. The record of care is kept.`
    : item.keepNotes
      ? "Notes kept: they will not be deleted."
      : due
        ? `Notes will be deleted ${instantDate(due)}, three years after closing.`
        : null;
  if (!line) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="notes-retention">
      <span className="text-sm text-rubric">{line}</span>
      {manage && !item.notesPurgedAt ? (
        <ActionForm action={setKeepNotesAction} showOk={false}>
          <input type="hidden" name="careItemId" value={item.id} />
          <input type="hidden" name="keep" value={item.keepNotes ? "false" : "true"} />
          <button type="submit" className={btnQuiet} aria-describedby={`keep-${item.id}`}>
            {item.keepNotes ? "Stop keeping these notes" : "Keep these notes"}
          </button>
          <span id={`keep-${item.id}`} className="mt-1 block text-sm text-rubric">
            {item.keepNotes ? "They will then be deleted three years after closing, like any other." : "For notes that matter for the long term: they are never deleted."}
          </span>
        </ActionForm>
      ) : null}
    </div>
  );
}
