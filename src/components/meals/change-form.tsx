import { changeSignupAction } from "@/app/m/actions";
import { ActionForm } from "@/components/action-form";
import { btnLaptopNatural, btnPrimary, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "@/components/ui";
import { FOOD_TYPE_WORDS } from "@/lib/meals-wording";

const FOODS = ["meat", "dairy", "pareve", "not_sure"] as const;

/** A helper's own change: what they are bringing, whether they cook or send, or another night. */
export function ChangeForm({ token, current, nights }: { token: string; current: { kind: string; bringing: string | null; foodType: string; note: string | null }; nights: { slotId: string; label: string }[] }) {
  return (
    <ActionForm action={changeSignupAction} className="flex flex-col gap-4" closeSheetOnOk={false}>
      <input type="hidden" name="token" value={token} />
      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>How will you help?</legend>
        <label className={checkRow}>
          <input type="radio" name="kind" value="cook" defaultChecked={current.kind !== "delivery"} className={checkBox} />I will cook and bring a meal
        </label>
        <label className={checkRow}>
          <input type="radio" name="kind" value="delivery" defaultChecked={current.kind === "delivery"} className={checkBox} />I will send a delivery
        </label>
      </fieldset>
      <div>
        <label htmlFor="ch-bringing" className={labelClass}>
          What are you bringing?
        </label>
        <input id="ch-bringing" name="bringing" maxLength={200} defaultValue={current.bringing ?? ""} className={inputClass} />
      </div>
      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>Is it meat, dairy or pareve?</legend>
        <div className="flex flex-wrap gap-x-6">
          {FOODS.map((f) => (
            <label key={f} className={checkRow}>
              <input type="radio" name="foodType" value={f} defaultChecked={current.foodType === f} className={checkBox} />
              {FOOD_TYPE_WORDS[f]}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="ch-note" className={labelClass}>
          A note (optional)
        </label>
        <textarea id="ch-note" name="note" rows={3} maxLength={300} defaultValue={current.note ?? ""} className={`${inputClass} py-2`} />
      </div>
      {nights.length ? (
        <div>
          <label htmlFor="ch-move" className={labelClass}>
            Move to a different night
          </label>
          <select id="ch-move" name="moveToSlotId" defaultValue="" className={inputClass}>
            <option value="">Keep my night</option>
            {nights.map((n) => (
              <option key={n.slotId} value={n.slotId}>
                {n.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        Save changes
      </button>
    </ActionForm>
  );
}
