import { handOverWorkAction } from "@/app/settings-actions";
import { ActionForm } from "@/components/action-form";
import { Sheet } from "@/components/sheet";
import { btnPrimary, inputClass, labelClass, rubric } from "@/components/ui";
import { CATEGORY_LABEL, type CategoryKey } from "@/lib/care-labels";
import { monthDay } from "@/lib/format";
import { HANDOVER_WORDS } from "@/lib/team-wording";
import type { HeldWork } from "@/server/team/handover";

type Person = { id: string; name: string };

function Choose({ id, name, people, extra, required, label }: { id: string; name: string; people: Person[]; extra?: { value: string; label: string }[]; required?: boolean; label: string }) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select id={id} name={name} required={required} defaultValue="" className={inputClass}>
        <option value="" disabled={required}>
          {required ? "Choose someone" : "As above"}
        </option>
        {extra?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The owner deactivates someone who holds open work: one sheet to give it on first, in bulk
 * or one by one, then deactivate. Restricted items are neither listed nor counted here.
 */
export function HandoverSheet({ work, holders, leads }: { work: HeldWork; holders: Person[]; leads: Person[] }) {
  const mine = holders.filter((h) => h.id !== work.userId);
  const ordinary = work.followUps.filter((f) => !f.leadStep);
  const lead = work.followUps.filter((f) => f.leadStep);
  return (
    <Sheet label={HANDOVER_WORDS.button} title={`${HANDOVER_WORDS.title}: ${work.name}`}>
      <p className="mb-4 text-base">{HANDOVER_WORDS.explain}</p>
      <ActionForm action={handOverWorkAction} showOk={false} className="flex flex-col gap-5">
        <input type="hidden" name="userId" value={work.userId} />
        {work.items.length > 0 ? (
          <div className="flex flex-col gap-3" data-testid="handover-items">
            <h3 className={rubric}>{HANDOVER_WORDS.items}</h3>
            <Choose id={`ho-items-${work.userId}`} name="itemsTo" people={mine} required label={HANDOVER_WORDS.giveAllTo} />
            <details>
              <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-action underline underline-offset-4">One by one</summary>
              <div className="mt-2 flex flex-col gap-3">
                {work.items.map((i) => (
                  <Choose key={i.id} id={`ho-item-${i.id}`} name={`item:${i.id}`} people={mine} label={`${i.name} (${CATEGORY_LABEL[i.category as CategoryKey] ?? i.category})`} />
                ))}
              </div>
            </details>
          </div>
        ) : null}
        {ordinary.length > 0 ? (
          <div className="flex flex-col gap-3" data-testid="handover-follow-ups">
            <h3 className={rubric}>{HANDOVER_WORDS.followUps}</h3>
            <Choose id={`ho-fus-${work.userId}`} name="followUpsTo" people={mine} required label={HANDOVER_WORDS.giveAllTo} />
            <details>
              <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-action underline underline-offset-4">One by one</summary>
              <div className="mt-2 flex flex-col gap-3">
                {ordinary.map((f) => (
                  <Choose key={f.id} id={`ho-fu-${f.id}`} name={`fu:${f.id}`} people={mine} label={`${f.name}: ${f.title} (${monthDay(f.due)})`} />
                ))}
              </div>
            </details>
          </div>
        ) : null}
        {lead.length > 0 ? (
          <div className="flex flex-col gap-3" data-testid="handover-lead-steps">
            <h3 className={rubric}>{HANDOVER_WORDS.leadSteps}</h3>
            <Choose id={`ho-lead-${work.userId}`} name="leadStepsTo" people={leads.filter((l) => l.id !== work.userId)} extra={[{ value: "owners", label: HANDOVER_WORDS.ownersOption }]} required label={HANDOVER_WORDS.giveAllTo} />
          </div>
        ) : null}
        <p className="text-sm text-rubric">{HANDOVER_WORDS.restrictedNote}</p>
        <button type="submit" className={btnPrimary}>
          {HANDOVER_WORDS.confirm}
        </button>
      </ActionForm>
    </Sheet>
  );
}
