import Link from "next/link";
import { completeLeadStepAction } from "@/app/journey-actions";
import { dueLabel, shortDate } from "@/lib/format";
import { CORPS_NOTE_SHOWN } from "@/lib/roster-wording";
import type { LeadStep } from "@/server/care/follow-ups";
import { ActionForm } from "./action-form";
import { Sheet } from "./sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, cardClass, inputClass, labelClass, nameClass } from "./ui";

/**
 * A Mitzvah Corps lead's own steps: whom it is for, what to arrange, and when. Nothing of
 * the care behind it is here, by design. Done opens a sheet for a one-line outcome the
 * clergy will read (optional).
 */
export function LeadSteps({ steps, today, canComplete = true }: { steps: LeadStep[]; today: string; /** Only a Mitzvah Corps lead marks a step done from here; clergy and the owner work these steps from the care item. */ canComplete?: boolean }) {
  const open = steps.filter((s) => !s.done);
  const done = steps.filter((s) => s.done);
  return (
    <>
      {open.length === 0 ? (
        <p className="mt-2 text-base text-rubric">Nothing is waiting for you.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-3" data-testid="lead-steps">
          {open.map((s) => (
            <li key={s.id} className={cardClass} data-testid="lead-step">
              <h3 className={nameClass}>{s.person}</h3>
              <p className="text-base">{s.title}</p>
              {s.corpsNote ? (
                <p className="mt-1 text-base" data-testid="lead-step-note">
                  <span className="font-semibold">{CORPS_NOTE_SHOWN}:</span> {s.corpsNote}
                </p>
              ) : null}
              <p className={`mt-1 text-sm ${s.dueDate < today ? "font-semibold text-alert" : "text-rubric"}`}>{dueLabel(today, s.dueDate)}</p>
              <div className="mt-3 flex flex-wrap items-start gap-2">
                {canComplete ? (
                <Sheet label="Done" ariaLabel={`Done: ${s.title} for ${s.person}`} title={`${s.title}: done`} triggerClassName={btnPrimary}>
                  <ActionForm action={completeLeadStepAction} className="flex flex-col gap-4">
                    <input type="hidden" name="followUpId" value={s.id} />
                    <div>
                      <label htmlFor={`outcome-${s.id}`} className={labelClass}>
                        How it went, in a line (optional)
                      </label>
                      <input id={`outcome-${s.id}`} name="outcome" maxLength={200} className={inputClass} aria-describedby={`outcome-help-${s.id}`} />
                      <p id={`outcome-help-${s.id}`} className="mt-1 text-sm text-rubric">
                        The clergy holding this care will see it. Logistics only, please: no health details.
                      </p>
                    </div>
                    <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
                      Mark done
                    </button>
                  </ActionForm>
                </Sheet>
                ) : null}
                <Link href={`/volunteers/new?step=${s.id}`} className={btnQuiet}>
                  Post this to volunteers
                </Link>
                {s.mealsHref ? (
                  <Link href={s.mealsHref} className={btnQuiet}>
                    Start a Mitzvah Meals page
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {done.length > 0 ? (
        <details className="mt-4">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-action underline underline-offset-4">Done lately ({done.length})</summary>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {done.map((s) => (
              <li key={s.id} data-testid="lead-step-done">
                <span className="font-semibold">{s.person}</span>: {s.title}, due {shortDate(s.dueDate)}
                {s.outcomeNote ? <span className="block text-rubric">{s.outcomeNote}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
