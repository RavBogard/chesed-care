import { addFollowUpAction, addToCareListAction, logContactAction } from "@/app/care-actions";
import { CATEGORY_LABEL } from "@/lib/care-labels";
import { canManageCareItems, type Actor } from "@/server/access/policy";
import type { OutsidePersonPage, PersonPage } from "@/server/care/person-page";
import { ActionForm } from "./action-form";
import { CareFields } from "./care-fields";
import { OutcomeButtons } from "./outcome-buttons";
import { Sheet } from "./sheet";
import { btnLaptopNatural, btnPrimary, inputClass, labelClass } from "./ui";
import { holdersOf } from "@/components/holders";

export { CATEGORY_LABEL };

/** A person's page, whether they are in Salesforce or kept only in this app. */
export type AnyPersonPage = PersonPage | OutsidePersonPage;

/** The hidden field that says whom a form is about: the Contact Id, or the outside person's id. */
function PersonFields({ page }: { page: AnyPersonPage }) {
  return "outsidePersonId" in page ? <input type="hidden" name="outsidePersonId" value={page.outsidePersonId} /> : <input type="hidden" name="sfContactId" value={page.contactId} />;
}

/** A caregiver can only act on a care item they can see; a clergy member may also act on the person alone. */
export function canLogContact(page: AnyPersonPage, actor: Actor): boolean {
  return canManageCareItems(actor) || page.careItems.some((i) => i.status !== "closed");
}

/** The id of the log-a-contact form set on the page itself on a laptop (see the person page). */
export const LOG_INLINE_ID = "log-inline";

/**
 * The log-a-contact form. It is shown two ways from this one component: in a sheet on a
 * phone, and on the page beside the contact history on a laptop. `idPrefix` keeps the two
 * sets of field ids apart.
 */
export function LogContactForm({ page, actor, idPrefix }: { page: AnyPersonPage; actor: Actor; idPrefix: string }) {
  const clergy = canManageCareItems(actor);
  const openItems = page.careItems.filter((i) => i.status !== "closed");
  return (
    <ActionForm action={logContactAction} className="flex flex-col gap-4">
      <PersonFields page={page} />
      <div>
        <label htmlFor={`${idPrefix}-when`} className={labelClass}>
          When
        </label>
        <input id={`${idPrefix}-when`} name="when" type="date" required max={page.today} defaultValue={page.today} className={inputClass} />
      </div>
      {openItems.length > 0 || !clergy ? (
        <div>
          <label htmlFor={`${idPrefix}-item`} className={labelClass}>
            About
          </label>
          <select id={`${idPrefix}-item`} name="careItemId" className={inputClass} required={!clergy}>
            {clergy ? <option value="">Just this person</option> : null}
            {openItems.map((i) => (
              <option key={i.id} value={i.id}>
                {CATEGORY_LABEL[i.category]} care item
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div>
        <label htmlFor={`${idPrefix}-note`} className={labelClass}>
          Note (optional)
        </label>
        <textarea id={`${idPrefix}-note`} name="note" rows={8} maxLength={5000} className={`${inputClass} min-h-48 resize-y py-2`} />
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" name="private" className="size-5 accent-action" />
        Private: only I can read this note
      </label>
      <OutcomeButtons legend="What happened? Tap one to save." other />
    </ActionForm>
  );
}

/**
 * The quick actions on a person's page, each in its own bottom sheet. `open` names one to open
 * on arrival. With `logInline`, a laptop has the log-a-contact form on the page already, so its
 * button is hidden there and `?action=log` goes to that form.
 */
export function PersonActions({ page, actor, open, logInline = false }: { page: AnyPersonPage; actor: Actor; open: string | undefined; logInline?: boolean }) {
  const clergy = canManageCareItems(actor);
  const openItems = page.careItems.filter((i) => i.status !== "closed");
  const canLog = canLogContact(page, actor);
  const team = page.team.filter((m) => m.active);
  const holders = holdersOf(page.team);
  return (
    <div className="flex flex-wrap gap-2">
      {canLog ? (
        <Sheet label="Log a contact" title={`Log a contact with ${page.name}`} defaultOpen={open === "log"} triggerClassName={btnPrimary} inlineId={logInline ? LOG_INLINE_ID : undefined}>
          <LogContactForm page={page} actor={actor} idPrefix="log" />
        </Sheet>
      ) : null}

      {clergy ? (
        <Sheet label="Add to care list" title={`Add ${page.name} to the care list`} defaultOpen={open === "care"}>
          <ActionForm action={addToCareListAction} className="flex flex-col gap-4">
            <PersonFields page={page} />
            <CareFields idPrefix="care" holders={holders} actorId={actor.id} restrictedControls />
            <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
              Add to care list
            </button>
          </ActionForm>
        </Sheet>
      ) : null}

      {clergy || openItems.length > 0 ? (
        <Sheet label="Add follow-up" title={`Add a follow-up for ${page.name}`} defaultOpen={open === "follow"}>
          <ActionForm action={addFollowUpAction} className="flex flex-col gap-4">
            <PersonFields page={page} />
            <div>
              <label htmlFor="fu-title" className={labelClass}>
                What needs doing
              </label>
              <input id="fu-title" name="title" required maxLength={200} className={inputClass} placeholder="Call to check in" />
            </div>
            <div>
              <label htmlFor="fu-due" className={labelClass}>
                Due
              </label>
              <input id="fu-due" name="dueDate" type="date" required defaultValue={page.today} className={inputClass} />
            </div>
            {openItems.length > 0 || !clergy ? (
              <div>
                <label htmlFor="fu-item" className={labelClass}>
                  About
                </label>
                <select id="fu-item" name="careItemId" className={inputClass} required={!clergy}>
                  {clergy ? <option value="">Just this person</option> : null}
                  {openItems.map((i) => (
                    <option key={i.id} value={i.id}>
                      {CATEGORY_LABEL[i.category]} care item
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            {clergy ? (
              <div>
                <label htmlFor="fu-owner" className={labelClass}>
                  Who
                </label>
                <select id="fu-owner" name="ownerUserId" className={inputClass} defaultValue={actor.id}>
                  {team.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id === actor.id ? "Me" : (m.name ?? m.email)}
                      {m.role === "caregiver" ? " (caregiver)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
              Add follow-up
            </button>
          </ActionForm>
        </Sheet>
      ) : null}
    </div>
  );
}
