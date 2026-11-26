import Link from "next/link";
import { addToVisitingListAction } from "@/app/visiting-actions";
import { ActionForm } from "@/components/action-form";
import { Section } from "@/components/section";
import { Sheet } from "@/components/sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, inputClass, labelClass } from "@/components/ui";
import { VISITING_ADD_LABEL, VISITING_HINT, VISITING_LABELS, VISITING_ON_LIST } from "@/lib/visiting-wording";
import { canManageVisitingList, type Actor } from "@/server/access/policy";
import { getDb } from "@/server/db/client";
import { visitingEntryFor } from "@/server/volunteers/visiting";
import { soft } from "@/server/soft";

export type VisitingRef = { sfContactId?: string; outsidePersonId?: string; displayName: string };

/** For clergy only: whether this person is on the visiting list. Null (nothing shown) for everyone else, or when it could not be read. */
export async function loadVisitingState(actor: Actor, ref: VisitingRef): Promise<{ onList: boolean } | null> {
  if (!canManageVisitingList(actor)) return null;
  return soft("Visiting list unavailable", null, async () => ({ onList: (await visitingEntryFor(getDb(), actor, ref)) !== null }));
}

/** On a person's page, for clergy: a line linking to the list, or a small form to add them. */
export function PersonVisiting({ state, person }: { state: { onList: boolean } | null; person: VisitingRef }) {
  if (state === null) return null;
  if (state.onList) {
    return (
      <p className="mb-5 text-base" data-testid="visiting-on-list">
        <Link href="/volunteers/visiting" className="font-medium text-action underline underline-offset-4">
          {VISITING_ON_LIST}
        </Link>
      </p>
    );
  }
  return (
    <Section title="Volunteer visits">
      <div className="mt-2" data-testid="visiting-add">
        <Sheet label={VISITING_ADD_LABEL} title={VISITING_ADD_LABEL} triggerClassName={btnQuiet}>
          <ActionForm action={addToVisitingListAction} className="flex flex-col gap-4">
            {person.sfContactId ? <input type="hidden" name="sfContactId" value={person.sfContactId} /> : null}
            {person.outsidePersonId ? <input type="hidden" name="outsidePersonId" value={person.outsidePersonId} /> : null}
            <div>
              <label htmlFor="vl-place" className={labelClass}>
                {VISITING_LABELS.place}
              </label>
              <input id="vl-place" name="place" required maxLength={300} className={inputClass} />
            </div>
            <div>
              <label htmlFor="vl-contact" className={labelClass}>
                {VISITING_LABELS.contactLine}
              </label>
              <input id="vl-contact" name="contactLine" maxLength={200} className={inputClass} />
            </div>
            <div>
              <label htmlFor="vl-note" className={labelClass}>
                {VISITING_LABELS.note}
              </label>
              <textarea id="vl-note" name="visitorNote" rows={2} maxLength={300} className={`${inputClass} py-2`} aria-describedby="vl-note-help" />
              <p id="vl-note-help" className="mt-1 text-sm text-rubric">
                {VISITING_HINT}
              </p>
            </div>
            <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
              {VISITING_ADD_LABEL}
            </button>
          </ActionForm>
        </Sheet>
      </div>
    </Section>
  );
}
