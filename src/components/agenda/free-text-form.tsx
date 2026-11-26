import { addAgendaAction } from "@/app/agenda-actions";
import { AGENDA_WORDS } from "@/lib/clergy-wording";
import { ActionForm } from "../action-form";
import { btnPrimary, inputClass, labelClass } from "../ui";

/** A line for the agenda about no one in particular. Every clergy member sees it. */
export function FreeTextForm() {
  return (
    <ActionForm action={addAgendaAction} className="mt-3 flex flex-col gap-3" closeSheetOnOk={false}>
      <div>
        <label htmlFor="agenda-free" className={labelClass}>
          {AGENDA_WORDS.freeText}
        </label>
        <input id="agenda-free" name="displayName" required maxLength={120} className={inputClass} autoComplete="off" />
        <p className="mt-1 text-sm text-rubric">{AGENDA_WORDS.freeTextHint}</p>
      </div>
      <div>
        <label htmlFor="agenda-free-why" className={labelClass}>
          {AGENDA_WORDS.why}
        </label>
        <input id="agenda-free-why" name="why" maxLength={200} className={inputClass} autoComplete="off" />
      </div>
      <button type="submit" className={`${btnPrimary} self-start`}>
        {AGENDA_WORDS.add}
      </button>
    </ActionForm>
  );
}
