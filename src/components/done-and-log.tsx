import { setFollowUpDoneAction } from "@/app/care-actions";
import { ActionForm } from "./action-form";
import { OutcomeButtons } from "./outcome-buttons";
import { Sheet } from "./sheet";
import { btnQuiet } from "./ui";

/**
 * "Done and log it": finishes a follow-up and writes the contact entry in one step. The
 * sheet asks only how it went; each outcome button saves. A plain Done stays one tap beside it.
 */
export function DoneAndLog({ followUpId, who }: { followUpId: string; who: string }) {
  return (
    <Sheet label="Done and log it" ariaLabel={`Done and log it: the follow-up for ${who}`} title={`Done: ${who}`} triggerClassName={btnQuiet}>
      <ActionForm action={setFollowUpDoneAction} showOk={false} className="flex flex-col gap-4">
        <input type="hidden" name="followUpId" value={followUpId} />
        <OutcomeButtons legend="How did it go?" />
        <p className="text-sm text-rubric">This marks the follow-up done and adds the contact to the history, with today&rsquo;s date and no note.</p>
      </ActionForm>
    </Sheet>
  );
}
