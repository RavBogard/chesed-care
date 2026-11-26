import { familyFoodAction, familyStatusAction } from "@/app/m/actions";
import { ActionForm } from "@/components/action-form";
import { ActionButton, ConfirmAction } from "@/components/confirm-sheet";
import { btnLaptopNatural, btnPrimary } from "@/components/ui";
import { FoodNeedsFields, type FoodNeedsValues } from "./food-needs-fields";

/** Change the food needs; what is saved is what every new helper sees. */
export function FamilyFoodForm({ token, values }: { token: string; values: FoodNeedsValues }) {
  return (
    <ActionForm action={familyFoodAction} className="flex flex-col gap-4" closeSheetOnOk={false}>
      <input type="hidden" name="token" value={token} />
      <FoodNeedsFields values={values} idPrefix="fam" />
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        Save
      </button>
    </ActionForm>
  );
}

/** Resume a pause the family made. */
export function ResumeButton({ token }: { token: string }) {
  return (
    <ActionButton action={familyStatusAction} fields={{ token, op: "resume" }} label="Open the page again" className={`${btnPrimary} ${btnLaptopNatural}`} closeSheetOnOk={false} />
  );
}

export function PauseButton({ token }: { token: string }) {
  return <ConfirmAction action={familyStatusAction} fields={{ token, op: "pause" }} label="Pause the page" title="Pause the page?" explain="Nobody new can sign up while it is paused, and the page shows a kind note instead of the dates. You can open it again whenever you like." confirmLabel="Pause" />;
}

export function EndButton({ token }: { token: string }) {
  return <ConfirmAction action={familyStatusAction} fields={{ token, op: "end" }} label="End the page" title="End the page for good?" explain="The page closes for everyone and cannot be opened again. You will still be able to thank the people who helped." confirmLabel="End the page" />;
}
