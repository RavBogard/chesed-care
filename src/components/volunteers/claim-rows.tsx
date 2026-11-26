import { removeClaimAction, removeFromAllDatesAction } from "@/app/volunteers-actions";
import { ActionForm } from "@/components/action-form";
import { Sheet } from "@/components/sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, checkBox, checkRow } from "@/components/ui";

/** Takes one volunteer's place away; the tick box also stops that contact from claiming this task again. */
export function RemoveClaim({ claimId, name, everyTime = false }: { claimId: string; name: string; everyTime?: boolean }) {
  return (
    <Sheet label="Remove" ariaLabel={`Remove ${name}`} title={`Remove ${name}?`} triggerClassName={btnQuiet}>
      <p className="mb-4 text-base">Their place opens again. They are not told.</p>
      <ActionForm action={removeClaimAction} showOk={false} className="flex flex-col gap-3">
        <input type="hidden" name="claimId" value={claimId} />
        <label className={checkRow}>
          <input type="checkbox" name="block" className={checkBox} />
          Also stop this email or number from signing up for this task again
        </label>
        <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
          Remove from this date
        </button>
      </ActionForm>
      {everyTime ? (
        <ActionForm action={removeFromAllDatesAction} showOk={false} className="mt-4 flex flex-col gap-3 border-t border-rule pt-4">
          <input type="hidden" name="claimId" value={claimId} />
          <p className="text-base">They signed up for every date. This takes them off all of them.</p>
          <label className={checkRow}>
            <input type="checkbox" name="block" className={checkBox} />
            Also stop this email or number from taking any date of this series again
          </label>
          <button type="submit" className={`${btnQuiet} ${btnLaptopNatural}`}>
            Remove from all dates
          </button>
        </ActionForm>
      ) : null}
    </Sheet>
  );
}
