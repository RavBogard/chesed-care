import { setCorpsNoteAction } from "@/app/journey-actions";
import { CORPS_NOTE_HINT, CORPS_NOTE_LABEL } from "@/lib/roster-wording";
import type { CareItem } from "@/server/care/care-items";
import { ActionForm } from "./action-form";
import { Sheet } from "./sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, inputClass, labelClass } from "./ui";

/**
 * The "For Mitzvah Corps" line on a care item: a short, logistics-only note the lead sees on their own steps for this
 * person. Offered only on an item that is not restricted: a restricted item has no such line, so nothing is drawn.
 */
export function CorpsNote({ item, who }: { item: CareItem; who: string }) {
  if (item.restricted) return null;
  return (
    <div className="mt-3 flex flex-wrap items-start gap-x-3 gap-y-2" data-testid="corps-note">
      {item.corpsNote ? (
        <p className="min-w-0 break-words text-base">
          <span className="font-semibold">{CORPS_NOTE_LABEL}:</span> {item.corpsNote}
        </p>
      ) : null}
      <Sheet label={item.corpsNote ? "Change the Mitzvah Corps note" : "Add a note for Mitzvah Corps"} ariaLabel={`${CORPS_NOTE_LABEL} note for ${who}`} title={`${CORPS_NOTE_LABEL}: ${who}`} triggerClassName={btnQuiet}>
        <ActionForm action={setCorpsNoteAction} className="flex flex-col gap-4">
          <input type="hidden" name="careItemId" value={item.id} />
          <div>
            <label htmlFor={`corps-${item.id}`} className={labelClass}>
              {CORPS_NOTE_LABEL}
            </label>
            <textarea id={`corps-${item.id}`} name="corpsNote" rows={3} maxLength={300} defaultValue={item.corpsNote ?? ""} className={`${inputClass} py-2`} aria-describedby={`corps-help-${item.id}`} />
            <p id={`corps-help-${item.id}`} className="mt-1 text-sm text-rubric">
              {CORPS_NOTE_HINT} Up to 300 characters. Leave it empty to remove it.
            </p>
          </div>
          <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
            Save
          </button>
        </ActionForm>
      </Sheet>
    </div>
  );
}
