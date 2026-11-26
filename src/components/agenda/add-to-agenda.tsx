import { addAgendaAction } from "@/app/agenda-actions";
import { AGENDA_WORDS } from "@/lib/clergy-wording";
import { ActionForm } from "../action-form";
import { Sheet } from "../sheet";
import { btnPrimary, btnQuiet, inputClass, labelClass } from "../ui";

/**
 * "Add to this week's agenda" from a care item, a person's page or the Inbox: a small sheet with one optional line, and for a
 * restricted item a plain warning that only the named clergy will see the entry. Clergy level only (the caller checks).
 */
export function AddToAgenda({ about, careItemId, sfContactId, outsidePersonId, displayName, restricted = false, idPrefix, triggerClassName = btnQuiet }: { about: string; careItemId?: string; sfContactId?: string; outsidePersonId?: string; displayName?: string; restricted?: boolean; idPrefix: string; triggerClassName?: string }) {
  return (
    <Sheet label={AGENDA_WORDS.add} ariaLabel={`${AGENDA_WORDS.add}: ${about}`} title={AGENDA_WORDS.addTitle} triggerClassName={triggerClassName}>
      <ActionForm action={addAgendaAction} className="flex flex-col gap-4">
        {careItemId ? <input type="hidden" name="careItemId" value={careItemId} /> : null}
        {!careItemId && sfContactId ? <input type="hidden" name="sfContactId" value={sfContactId} /> : null}
        {!careItemId && outsidePersonId ? <input type="hidden" name="outsidePersonId" value={outsidePersonId} /> : null}
        {!careItemId && displayName ? <input type="hidden" name="displayName" value={displayName} /> : null}
        <p className="text-base font-semibold [overflow-wrap:anywhere]">{about}</p>
        {restricted ? <p className="rounded-md bg-alert-band p-3 text-sm text-alert">{AGENDA_WORDS.restrictedWarning}</p> : null}
        <div>
          <label htmlFor={`${idPrefix}-why`} className={labelClass}>
            {AGENDA_WORDS.why}
          </label>
          <input id={`${idPrefix}-why`} name="why" maxLength={200} className={inputClass} autoComplete="off" />
        </div>
        <button type="submit" className={btnPrimary}>
          {AGENDA_WORDS.add}
        </button>
      </ActionForm>
    </Sheet>
  );
}
