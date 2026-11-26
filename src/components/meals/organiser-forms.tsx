import { addDatesAction, agreedAction, bookOnBehalfAction, coOrganiserAction, removeSignupAction, statusAction, updateDetailsAction, withdrawDateAction } from "@/app/meals-actions";
import { ActionForm } from "@/components/action-form";
import { ActionButton, ConfirmAction } from "@/components/confirm-sheet";
import { UseAddressButton } from "@/components/use-address-button";
import { Sheet } from "@/components/sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "@/components/ui";
import { FOOD_TYPE_WORDS, type Kashrut } from "@/lib/meals-wording";
import { DateGrid, type DayNote, type Month } from "./date-grid";
import { FoodNeedsFields } from "./food-needs-fields";

export type DetailsValues = {
  title: string;
  note: string | null;
  foodFor: string | null;
  kashrut: Kashrut;
  dietary: string[];
  allergies: string | null;
  dropOffWindow: string | null;
  dropOffInstructions: string | null;
  dropOffAddress: string | null;
  dropOffIsHome: boolean;
  deliveryPlaces: string | null;
  giftCards: string | null;
  giftCardEmail: string | null;
};

/** Everything about a page that is words: what helpers read and what the family needs. All optional. */
export function DetailsForm({ pageId, v, addressSuggestion = null }: { pageId: string; v: DetailsValues; addressSuggestion?: string | null }) {
  return (
    <ActionForm action={updateDetailsAction} className="flex flex-col gap-4" closeSheetOnOk={false}>
      <input type="hidden" name="pageId" value={pageId} />
      <div>
        <label htmlFor="d-title" className={labelClass}>
          Name on the page
        </label>
        <input id="d-title" name="title" required maxLength={120} defaultValue={v.title} className={inputClass} />
      </div>
      <div>
        <label htmlFor="d-note" className={labelClass}>
          A short note for helpers
        </label>
        <textarea id="d-note" name="note" rows={3} maxLength={500} defaultValue={v.note ?? ""} className={`${inputClass} py-2`} aria-describedby="d-note-help" />
        <p id="d-note-help" className="mt-1 text-sm text-rubric">
          Everyone with the link reads this. Please do not say why the family needs meals.
        </p>
      </div>
      <FoodNeedsFields idPrefix="d" values={v} />
      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>Where the food goes</legend>
        <label htmlFor="d-address" className={labelClass}>
          Address
        </label>
        <UseAddressButton targetId="d-address" address={addressSuggestion} />
        <textarea id="d-address" name="dropOffAddress" rows={2} maxLength={300} defaultValue={v.dropOffAddress ?? ""} className={`${inputClass} py-2`} aria-describedby="d-address-help" />
        <p id="d-address-help" className="mb-2 mt-1 text-sm text-rubric">
          Shown only to people who have signed up. It can be somewhere other than the home.
        </p>
        <label className={checkRow}>
          <input type="checkbox" name="dropOffIsHome" value="yes" defaultChecked={v.dropOffIsHome} className={checkBox} />
          This is the family&rsquo;s home
        </label>
      </fieldset>
      <div>
        <label htmlFor="d-places" className={labelClass}>
          Places that deliver (for helpers who send a meal)
        </label>
        <textarea id="d-places" name="deliveryPlaces" rows={2} maxLength={500} defaultValue={v.deliveryPlaces ?? ""} className={`${inputClass} py-2`} />
      </div>
      <div>
        <label htmlFor="d-gift" className={labelClass}>
          Gift cards the family would use
        </label>
        <textarea id="d-gift" name="giftCards" rows={2} maxLength={500} defaultValue={v.giftCards ?? ""} className={`${inputClass} py-2`} />
      </div>
      <div>
        <label htmlFor="d-gift-email" className={labelClass}>
          Where to send gift cards (an email address)
        </label>
        <input id="d-gift-email" name="giftCardEmail" type="email" maxLength={254} defaultValue={v.giftCardEmail ?? ""} className={inputClass} />
      </div>
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        Save
      </button>
    </ActionForm>
  );
}

export function AgreedButton({ pageId }: { pageId: string }) {
  return (
    <ActionButton action={agreedAction} fields={{ pageId }} label="The family has said yes" className={btnQuiet} closeSheetOnOk={false} />
  );
}

function StatusButton({ pageId, op, label, primary = false }: { pageId: string; op: string; label: string; primary?: boolean }) {
  return (
    <ActionButton action={statusAction} fields={{ pageId, op }} label={label} className={primary ? btnPrimary : btnQuiet} closeSheetOnOk={false} />
  );
}

/** Go live, pause, resume, end: only the ones that make sense for the page's state. */
export function StatusControls({ pageId, status, agreed }: { pageId: string; status: "draft" | "live" | "paused" | "ended"; agreed: boolean }) {
  if (status === "ended") return <p className="text-base text-rubric">This page has ended.</p>;
  return (
    <div className="flex flex-wrap items-start gap-2">
      {status === "draft" ? agreed ? <StatusButton pageId={pageId} op="live" label="Go live" primary /> : <AgreedButton pageId={pageId} /> : null}
      {status === "live" ? <StatusButton pageId={pageId} op="pause" label="Pause" /> : null}
      {status === "paused" ? <StatusButton pageId={pageId} op="resume" label="Resume" primary /> : null}
      <ConfirmAction action={statusAction} fields={{ pageId, op: "end" }} label="End the page" title="End this page for good?" explain="Helpers can no longer sign up and the link shows that the page has ended. Thirty days later helpers' names and emails are deleted. This cannot be undone." confirmLabel="End the page" />
    </div>
  );
}

export function AddDatesForm({ pageId, today, months, notes }: { pageId: string; today: string; months: Month[]; notes: Record<string, DayNote> }) {
  return (
    <ActionForm action={addDatesAction} className="flex flex-col gap-4" closeSheetOnOk={false}>
      <input type="hidden" name="pageId" value={pageId} />
      <DateGrid today={today} months={months} notes={notes} suggested={[]} initial={[]} />
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        Add these nights
      </button>
    </ActionForm>
  );
}

export function WithdrawButton({ pageId, slotId, label }: { pageId: string; slotId: string; label: string }) {
  return (
    <ConfirmAction action={withdrawDateAction} fields={{ pageId, slotId }} label="Take off" ariaLabel={`Take ${label} off the page`} title="Take this night off the page?" explain="Helpers will no longer see it. If someone has already taken it, you will see that they need a call." confirmLabel="Take it off" />
  );
}

/** Book a night for someone who phoned or said so in person. A first name is enough. */
export function BookForm({ pageId, slotId, label }: { pageId: string; slotId: string; label: string }) {
  return (
    <Sheet label="Book for someone" ariaLabel={`Book ${label} for someone`} title={`Book ${label}`}>
      <ActionForm action={bookOnBehalfAction} className="flex flex-col gap-3">
        <input type="hidden" name="pageId" value={pageId} />
        <input type="hidden" name="slotId" value={slotId} />
        <div>
          <label htmlFor={`bk-first-${slotId}`} className={labelClass}>
            First name
          </label>
          <input id={`bk-first-${slotId}`} name="firstName" required maxLength={60} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`bk-last-${slotId}`} className={labelClass}>
            Last name (optional)
          </label>
          <input id={`bk-last-${slotId}`} name="lastName" maxLength={60} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`bk-email-${slotId}`} className={labelClass}>
            Email (optional)
          </label>
          <input id={`bk-email-${slotId}`} name="email" type="email" maxLength={254} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`bk-bring-${slotId}`} className={labelClass}>
            What they are bringing (optional)
          </label>
          <input id={`bk-bring-${slotId}`} name="bringing" maxLength={200} className={inputClass} />
        </div>
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>How they will help</legend>
          <label className={checkRow}>
            <input type="radio" name="kind" value="cook" defaultChecked className={checkBox} />
            Cooking
          </label>
          <label className={checkRow}>
            <input type="radio" name="kind" value="delivery" className={checkBox} />
            Sending a delivery
          </label>
        </fieldset>
        <div>
          <label htmlFor={`bk-food-${slotId}`} className={labelClass}>
            Meat, dairy or pareve
          </label>
          <select id={`bk-food-${slotId}`} name="foodType" defaultValue="not_sure" className={inputClass}>
            {Object.entries(FOOD_TYPE_WORDS).map(([k, w]) => (
              <option key={k} value={k}>
                {w}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className={btnPrimary}>
          Book this night
        </button>
      </ActionForm>
    </Sheet>
  );
}

/** Remove a helper from a night, and if asked stop their email signing up to this page again. */
export function RemoveForm({ pageId, signupId, name }: { pageId: string; signupId: string; name: string }) {
  return (
    <Sheet label="Remove" ariaLabel={`Remove ${name}`} title={`Remove ${name}?`}>
      <p className="mb-3 text-base">The night opens again. {name} is not told.</p>
      <ActionForm action={removeSignupAction} className="flex flex-col gap-3">
        <input type="hidden" name="pageId" value={pageId} />
        <input type="hidden" name="signupId" value={signupId} />
        <label className={checkRow}>
          <input type="checkbox" name="blockEmail" className={checkBox} />
          Also stop this email address signing up to this page
        </label>
        <button type="submit" className={btnPrimary}>
          Remove
        </button>
      </ActionForm>
    </Sheet>
  );
}

export function AddCoOrganiser({ pageId, people }: { pageId: string; people: { id: string; name: string }[] }) {
  if (people.length === 0) return null;
  return (
    <ActionForm action={coOrganiserAction} className="flex flex-wrap items-end gap-2" closeSheetOnOk={false}>
      <input type="hidden" name="pageId" value={pageId} />
      <div className="min-w-0 flex-1">
        <label htmlFor="co-add" className={labelClass}>
          Add a co-organiser
        </label>
        <select id="co-add" name="userId" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            Choose a colleague
          </option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className={btnQuiet}>
        Add
      </button>
    </ActionForm>
  );
}

export function RemoveCoOrganiser({ pageId, userId, name }: { pageId: string; userId: string; name: string }) {
  return (
    <ActionButton action={coOrganiserAction} fields={{ pageId, userId, op: "remove" }} label="Remove" className={btnQuiet} closeSheetOnOk={false} ariaLabel={`Remove ${name} as co-organiser`} />
  );
}
