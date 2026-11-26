"use client";

import { useState } from "react";
import { addEntryAction, applyAnywayAction, describePacketAction, endEntryAction, importCurrentAction, removeBarredAction, renewEntryAction, syncNowAction, updateEntryAction } from "@/app/misheberach-actions";
import { ActionButton, ConfirmAction } from "@/components/confirm-sheet";
import { ActionForm } from "@/components/action-form";
import { PersonPicker, type PersonChoice } from "@/components/person-picker";
import { Sheet } from "@/components/sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "@/components/ui";
import { APPLY_EXPLAIN, APPLY_LABEL, ASK_NOT_LISTED, REMOVE_BARRED_EXPLAIN, REMOVE_BARRED_LABEL, DESCRIBE_LABEL, END_CHOICES, IMPORT_EXPLAIN, IMPORT_LABEL, KIND_LABEL, RENEW_LABEL } from "@/lib/misheberach-wording";

const NAME_HINT = "As it is read aloud: English, or a Hebrew name with ben or bat. Two people may share one entry. No parentheses.";

function KindChoice({ idPrefix, value }: { idPrefix: string; value: "dated" | "standing" }) {
  return (
    <fieldset className={fieldsetClass}>
      <legend className={legendClass}>How long</legend>
      {(["dated", "standing"] as const).map((k) => (
        <label key={k} className={checkRow} htmlFor={`${idPrefix}-${k}`}>
          <input id={`${idPrefix}-${k}`} type="radio" name="kind" value={k} defaultChecked={value === k} className={checkBox} />
          <span>{KIND_LABEL[k]}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Add a name: it goes on at once, marked not yet confirmed. The link to a person is optional and searches only people this viewer may see. */
export function AddEntryForm({ careItemId, preset }: { careItemId?: string; preset?: { name: string; contactId?: string; outsidePersonId?: string; personName?: string } }) {
  const initial: PersonChoice | null = preset?.contactId ? { kind: "sf", contactId: preset.contactId, name: preset.personName ?? preset.name, household: null } : preset?.outsidePersonId ? { kind: "outside", id: preset.outsidePersonId, name: preset.personName ?? preset.name, note: null } : null;
  const [person, setPerson] = useState<PersonChoice | null>(initial);
  return (
    <ActionForm action={addEntryAction} className="flex flex-col gap-4">
      <div>
        <label htmlFor="mi-name" className={labelClass}>
          Name
        </label>
        <input id="mi-name" name="name" required maxLength={200} defaultValue={preset?.name ?? ""} className={inputClass} autoComplete="off" aria-describedby="mi-name-hint" />
        <p id="mi-name-hint" className="mt-1 text-sm text-rubric">
          {NAME_HINT}
        </p>
      </div>
      <KindChoice idPrefix="mi-add" value="dated" />
      <div>
        <label htmlFor="mi-asked" className={labelClass}>
          Who asked, and how they are related (optional)
        </label>
        <input id="mi-asked" name="askedBy" maxLength={200} className={inputClass} autoComplete="off" placeholder="friend of Dana Levy" />
      </div>
      <PersonPicker value={person} onChange={setPerson} idPrefix="mi-person" legend="Link to a person (optional)" allowNew={false} />
      {careItemId ? <input type="hidden" name="careItemId" value={careItemId} /> : null}
      <details className="text-sm">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-action underline underline-offset-4">This person asked not to be listed</summary>
        <label className={`${checkRow} mt-1`}>
          <input type="checkbox" name="override" className={checkBox} />
          <span>I have checked with them</span>
        </label>
        <p className="text-rubric">{ASK_NOT_LISTED}</p>
      </details>
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        Add to the list
      </button>
    </ActionForm>
  );
}

type EditProps = { id: string; name: string; kind: "dated" | "standing"; askedBy: string | null; consent: "confirmed" | "not_confirmed" | "asked_not_listed"; specialRequest: boolean };

/** Change one entry. Saying the person asked not to be listed takes it off the list. */
export function EditEntry({ entry }: { entry: EditProps }) {
  return (
    <Sheet label="Edit" ariaLabel={`Edit ${entry.name}`} title="Edit this name">
      <ActionForm action={updateEntryAction} className="flex flex-col gap-4">
        <input type="hidden" name="entryId" value={entry.id} />
        <div>
          <label htmlFor={`mi-edit-${entry.id}-name`} className={labelClass}>
            Name
          </label>
          <input id={`mi-edit-${entry.id}-name`} name="name" required maxLength={200} defaultValue={entry.name} className={inputClass} autoComplete="off" />
        </div>
        <KindChoice idPrefix={`mi-edit-${entry.id}`} value={entry.kind} />
        <div>
          <label htmlFor={`mi-edit-${entry.id}-asked`} className={labelClass}>
            Who asked, and how they are related
          </label>
          <input id={`mi-edit-${entry.id}-asked`} name="askedBy" maxLength={200} defaultValue={entry.askedBy ?? ""} className={inputClass} autoComplete="off" />
        </div>
        <div>
          <label htmlFor={`mi-edit-${entry.id}-consent`} className={labelClass}>
            Has the person agreed?
          </label>
          <select id={`mi-edit-${entry.id}-consent`} name="consent" defaultValue={entry.consent === "confirmed" ? "confirmed" : "not_confirmed"} className={inputClass}>
            <option value="not_confirmed">Not yet confirmed</option>
            <option value="confirmed">Agreed</option>
            <option value="asked_not_listed">Asked not to be listed (takes the name off)</option>
          </select>
        </div>
        <label className={checkRow}>
          <input type="checkbox" name="specialRequest" defaultChecked={entry.specialRequest} className={checkBox} />
          <span>Special request (marked with * in the packet)</span>
        </label>
        <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
          Save
        </button>
      </ActionForm>
    </Sheet>
  );
}

/** Take a name off, with the reason. `suggest` leads with the reason the care closing suggests. */
export function EndEntry({ id, name, suggest, label = "Take off", triggerClassName }: { id: string; name: string; suggest?: "recovered" | "died"; label?: string; triggerClassName?: string }) {
  return (
    <Sheet label={label} ariaLabel={`Take ${name} off the list`} title="Take this name off?" triggerClassName={triggerClassName}>
      <ActionForm action={endEntryAction} className="flex flex-col gap-4">
        <input type="hidden" name="entryId" value={id} />
        <fieldset className={fieldsetClass}>
          <legend className={legendClass}>Why</legend>
          {END_CHOICES.map((c) => (
            <label key={c.value} className={checkRow}>
              <input type="radio" name="reason" value={c.value} defaultChecked={suggest ? c.value === suggest : c.value === "removed_by_clergy"} className={checkBox} />
              <span>{c.label}</span>
            </label>
          ))}
        </fieldset>
        <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
          Take off the list
        </button>
      </ActionForm>
    </Sheet>
  );
}

/** The three one-tap answers to "still needed?". */
export function RenewButtons({ id, name }: { id: string; name: string }) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      {(["keep", "standing", "let_off"] as const).map((choice) => (
        <ActionForm key={choice} action={renewEntryAction} showOk={false}>
          <input type="hidden" name="entryId" value={id} />
          <input type="hidden" name="choice" value={choice} />
          <button type="submit" className={btnQuiet} aria-label={`${RENEW_LABEL[choice]}: ${name}`}>
            {RENEW_LABEL[choice]}
          </button>
        </ActionForm>
      ))}
    </div>
  );
}

/** "Sync now". */
export function SyncNow() {
  return (
    <ActionButton action={syncNowAction} fields={{}} label="Sync now" className={btnQuiet} formClassName="flex flex-wrap items-center gap-2" closeSheetOnOk={false} />
  );
}

/** The trial mode's one write: make entries from the packet's current list (entries only; the packet is not touched). Confirmed first. */
export function ImportCurrent() {
  return <ConfirmAction action={importCurrentAction} fields={{}} label={IMPORT_LABEL} title={`${IMPORT_LABEL}?`} explain={IMPORT_EXPLAIN} confirmLabel={IMPORT_LABEL} />;
}

/** Run the sync once although it is larger than it makes on its own. Confirmed first, and recorded. */
export function ApplyAnyway() {
  return <ConfirmAction action={applyAnywayAction} fields={{}} label={APPLY_LABEL} title={`${APPLY_LABEL}?`} explain={APPLY_EXPLAIN} confirmLabel={APPLY_LABEL} />;
}

/** The owner's check of the packet's shape: counts only. */
export function DescribePacket() {
  return (
    <ActionButton action={describePacketAction} fields={{}} label={DESCRIBE_LABEL} className={btnQuiet} formClassName="flex flex-wrap items-center gap-2" closeSheetOnOk={false} />
  );
}

/** Take the lines of people who asked not to be listed out of the packet. Confirmed first, and recorded. */
export function RemoveBarred() {
  return <ConfirmAction action={removeBarredAction} fields={{}} label={REMOVE_BARRED_LABEL} title={`${REMOVE_BARRED_LABEL}?`} explain={REMOVE_BARRED_EXPLAIN} confirmLabel={REMOVE_BARRED_LABEL} />;
}
