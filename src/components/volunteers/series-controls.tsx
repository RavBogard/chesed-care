import { cancelSeriesAction, updateSeriesAction } from "@/app/volunteers-actions";
import { ActionForm } from "@/components/action-form";
import { Sheet } from "@/components/sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, checkBox, checkRow, inputClass, labelClass } from "@/components/ui";
import { shortDate } from "@/lib/format";

export type Occurrence = { id: string; date: string; status: string; taken: number; peopleNeeded: number };

/**
 * A repeating task's series: its dates, how many are taken, and the two things done to all of them. Editing and
 * cancelling touch the dates nobody has taken; the dates someone has taken are changed or cancelled only when the
 * box is ticked, so the poster is asked before a volunteer's date moves.
 */
export function SeriesControls({ taskId, occurrences, claimedAhead, values, today }: { taskId: string; occurrences: Occurrence[]; claimedAhead: number; values: { forLabel: string; needed: string; timeWindow: string; place: string; contactLine: string }; today: string }) {
  const ahead = occurrences.filter((o) => o.status === "open" && o.date >= today);
  const ask = claimedAhead > 0 ? `${claimedAhead === 1 ? "1 date" : `${claimedAhead} dates`} ahead ${claimedAhead === 1 ? "has" : "have"} someone signed up.` : "";
  return (
    <div data-testid="series-controls">
      <p className="text-base">
        Repeats on {occurrences.length} dates{ahead.length !== occurrences.length ? `, ${ahead.length} still ahead` : ""}.
      </p>
      <ul className="mt-2 flex flex-col gap-1 text-sm" data-testid="series-dates">
        {occurrences.map((o) => (
          <li key={o.id} className={o.status === "open" ? "" : "text-rubric line-through"}>
            {shortDate(o.date)}, {o.taken} of {o.peopleNeeded} taken{o.status === "cancelled" ? ", cancelled" : ""}
          </li>
        ))}
      </ul>
      {ahead.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Sheet label="Edit all the dates ahead" title="Edit the dates ahead" triggerClassName={btnQuiet}>
            <ActionForm action={updateSeriesAction} className="flex flex-col gap-4" closeSheetOnOk={false}>
              <input type="hidden" name="taskId" value={taskId} />
              <div>
                <label htmlFor="s-for" className={labelClass}>
                  Who it is for
                </label>
                <input id="s-for" name="forLabel" required maxLength={80} defaultValue={values.forLabel} className={inputClass} />
              </div>
              <div>
                <label htmlFor="s-needed" className={labelClass}>
                  What is needed
                </label>
                <textarea id="s-needed" name="needed" required rows={3} maxLength={300} defaultValue={values.needed} className={`${inputClass} py-2`} />
              </div>
              <div>
                <label htmlFor="s-window" className={labelClass}>
                  Time (optional)
                </label>
                <input id="s-window" name="timeWindow" maxLength={60} defaultValue={values.timeWindow} className={inputClass} />
              </div>
              <div>
                <label htmlFor="s-place" className={labelClass}>
                  Where (optional)
                </label>
                <textarea id="s-place" name="place" rows={2} maxLength={300} defaultValue={values.place} className={`${inputClass} py-2`} />
              </div>
              <div>
                <label htmlFor="s-contact" className={labelClass}>
                  Who to ask with questions (optional)
                </label>
                <input id="s-contact" name="contactLine" maxLength={120} defaultValue={values.contactLine} className={inputClass} />
              </div>
              {claimedAhead > 0 ? (
                <label className={checkRow}>
                  <input type="checkbox" name="includeClaimed" className={checkBox} />
                  <span>Also change the dates that are taken. {ask}</span>
                </label>
              ) : null}
              <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                Change the dates ahead
              </button>
            </ActionForm>
          </Sheet>
          <Sheet label="Cancel the dates ahead" title="Cancel the dates ahead?" triggerClassName={btnQuiet}>
            <ActionForm action={cancelSeriesAction} className="flex flex-col gap-4" closeSheetOnOk={false}>
              <input type="hidden" name="taskId" value={taskId} />
              <p className="text-base">The dates ahead that nobody has taken are cancelled and their links stop working.</p>
              {claimedAhead > 0 ? (
                <label className={checkRow}>
                  <input type="checkbox" name="includeClaimed" className={checkBox} />
                  <span>Also cancel the dates that are taken. {ask} They will see, on their own page, that it was cancelled.</span>
                </label>
              ) : null}
              <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                Cancel the dates ahead
              </button>
            </ActionForm>
          </Sheet>
        </div>
      ) : null}
    </div>
  );
}
