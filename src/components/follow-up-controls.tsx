import { deleteFollowUpAction, setFollowUpDoneAction, updateFollowUpAction } from "@/app/care-actions";
import { ActionForm } from "./action-form";
import type { TeamChoice } from "./care-fields";
import { ConfirmAction } from "./confirm-sheet";
import { DoneAndLog } from "./done-and-log";
import { Sheet } from "./sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, inputClass, labelClass } from "./ui";

export type FollowUpLite = { id: string; title: string; dueDate: string; ownerUserId: string | null };

/**
 * What can be done with an open follow-up: Done (one tap), Done and log it, and for clergy
 * Edit (title, day, who has it) and Delete (asks first). `who` is for the accessible names.
 */
export function FollowUpControls({ f, who, canEdit, holders, actorId, doneLabel }: { f: FollowUpLite; who: string; canEdit: boolean; holders: TeamChoice[]; actorId: string; doneLabel?: string }) {
  // Whoever has it now stays a choice, even if they are no longer in the list of clergy.
  const owners = f.ownerUserId && !holders.some((h) => h.id === f.ownerUserId) ? [...holders, { id: f.ownerUserId, name: "Current holder", stale: true }] : holders;
  return (
    <>
      <ActionForm action={setFollowUpDoneAction} showOk={false}>
        <input type="hidden" name="followUpId" value={f.id} />
        <button type="submit" aria-label={doneLabel ?? `Mark follow-up for ${who} done`} className={btnQuiet}>
          Done
        </button>
      </ActionForm>
      <DoneAndLog followUpId={f.id} who={who} />
      {canEdit ? (
        <>
          <Sheet label="Edit" ariaLabel={`Edit the follow-up for ${who}`} title={`Edit the follow-up for ${who}`}>
            <ActionForm action={updateFollowUpAction} className="flex flex-col gap-4">
              <input type="hidden" name="followUpId" value={f.id} />
              <div>
                <label htmlFor={`fu-title-${f.id}`} className={labelClass}>
                  What needs doing
                </label>
                <input id={`fu-title-${f.id}`} name="title" required maxLength={200} defaultValue={f.title} className={inputClass} />
              </div>
              <div>
                <label htmlFor={`fu-due-${f.id}`} className={labelClass}>
                  Due
                </label>
                <input id={`fu-due-${f.id}`} name="dueDate" type="date" required defaultValue={f.dueDate} className={inputClass} />
              </div>
              <div>
                <label htmlFor={`fu-owner-${f.id}`} className={labelClass}>
                  Who has it
                </label>
                <select id={`fu-owner-${f.id}`} name="ownerUserId" className={inputClass} defaultValue={f.ownerUserId ?? actorId}>
                  {owners.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                      {h.id === actorId ? " (me)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                Save
              </button>
            </ActionForm>
          </Sheet>
          <ConfirmAction action={deleteFollowUpAction} fields={{ followUpId: f.id }} label="Delete" ariaLabel={`Delete the follow-up for ${who}`} title="Delete this follow-up?" explain={`The follow-up for ${who} is removed for good. A follow-up that is finished is better marked Done, which keeps it in the history.`} confirmLabel="Delete follow-up" />
        </>
      ) : null}
    </>
  );
}
