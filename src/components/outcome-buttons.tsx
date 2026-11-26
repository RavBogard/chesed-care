import { OUTCOME_KEYS, OUTCOME_LABEL } from "@/lib/care-labels";
import { btnQuiet } from "./ui";

/**
 * One tap per common outcome. Each is a submit button named "outcome", so tapping it saves
 * the form with that outcome: a usual entry needs no typing. `other` adds a last button for
 * something that is none of these (it saves with kind "other" and no outcome).
 */
export function OutcomeButtons({ legend, other = false }: { legend: string; other?: boolean }) {
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className="mb-1.5 text-sm font-semibold text-ink">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {OUTCOME_KEYS.map((k) => (
          <button key={k} type="submit" name="outcome" value={k} className={btnQuiet} data-testid="outcome-button">
            {OUTCOME_LABEL[k]}
          </button>
        ))}
        {other ? (
          <button type="submit" name="kind" value="other" className={btnQuiet} data-testid="outcome-other">
            Something else
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}
