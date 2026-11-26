import { checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "@/components/ui";
import { DIETARY_CHOICES, KASHRUT_ORDER, KASHRUT_WORDS, type Kashrut } from "@/lib/meals-wording";

export type FoodNeedsValues = { foodFor: string | null; kashrut: Kashrut; dietary: string[]; allergies: string | null; dropOffWindow: string | null; dropOffInstructions: string | null };

/**
 * The food needs, as one set of fields for the family's link and the organiser's page:
 * kashrut (pick one), dietary needs (pick any, and add your own), allergies in their own
 * box, and the drop-off window and instructions. Field names match the actions.
 */
export function FoodNeedsFields({ values, idPrefix }: { values: FoodNeedsValues; idPrefix: string }) {
  const offered = new Set<string>(DIETARY_CHOICES);
  const own = values.dietary.filter((d) => !offered.has(d));
  const id = (n: string) => `${idPrefix}-${n}`;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <label htmlFor={id("allergies")} className={labelClass}>
          Allergies
        </label>
        <textarea id={id("allergies")} name="allergies" rows={2} maxLength={500} defaultValue={values.allergies ?? ""} className={`${inputClass} py-2`} aria-describedby={id("allergies-help")} />
        <p id={id("allergies-help")} className="mt-1 text-sm text-rubric">
          Helpers see this first, apart from preferences.
        </p>
      </div>

      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>Kosher</legend>
        {KASHRUT_ORDER.map((k) => (
          <label key={k} className={`${checkRow} items-start py-2`}>
            <input type="radio" name="kashrut" value={k} defaultChecked={values.kashrut === k} className={`${checkBox} mt-0.5`} />
            {KASHRUT_WORDS[k]}
          </label>
        ))}
      </fieldset>

      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>Dietary needs (choose any)</legend>
        <div className="grid gap-x-6 sm:grid-cols-2">
          {DIETARY_CHOICES.map((d) => (
            <label key={d} className={checkRow}>
              <input type="checkbox" name="dietary" value={d} defaultChecked={values.dietary.includes(d)} className={checkBox} />
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </label>
          ))}
        </div>
        <label htmlFor={id("other")} className={`${labelClass} mt-2`}>
          Anything else (separate with commas)
        </label>
        <input id={id("other")} name="dietaryOther" maxLength={200} defaultValue={own.join(", ")} className={inputClass} />
      </fieldset>

      <div>
        <label htmlFor={id("for")} className={labelClass}>
          Who is eating
        </label>
        <input id={id("for")} name="foodFor" maxLength={200} defaultValue={values.foodFor ?? ""} placeholder="For example: 2 adults, 3 children" className={inputClass} />
      </div>
      <div>
        <label htmlFor={id("window")} className={labelClass}>
          Drop-off window
        </label>
        <input id={id("window")} name="dropOffWindow" maxLength={120} defaultValue={values.dropOffWindow ?? ""} placeholder="For example: 5 to 6 pm" className={inputClass} />
      </div>
      <div>
        <label htmlFor={id("instructions")} className={labelClass}>
          Drop-off instructions
        </label>
        <textarea id={id("instructions")} name="dropOffInstructions" rows={2} maxLength={500} defaultValue={values.dropOffInstructions ?? ""} placeholder="For example: leave it in the cooler on the porch, please do not knock" className={`${inputClass} py-2`} />
      </div>
    </div>
  );
}
