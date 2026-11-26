import { addMemberAction, updateMemberAction } from "@/app/roster-actions";
import { ActionForm } from "@/components/action-form";
import { btnLaptopNatural, btnPrimary, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "@/components/ui";
import { CAN_DO_LABEL, HOW_OFTEN_LABEL, HOW_OFTEN_QUESTION, NOT_CHOSEN, PREFER_CONTACT_LABEL, PREFER_CONTACT_QUESTION, ROSTER_HINTS } from "@/lib/roster-wording";
import { CAN_DO, HOW_OFTEN, PREFER_CONTACT } from "@/lib/can-do";
import type { MemberView } from "@/server/volunteers/roster";

/** Add a member, or change one (`member` given). Contacts and notes are typed here and shown only on the roster. */
export function MemberForm({ member, idPrefix }: { member?: MemberView; idPrefix: string }) {
  const editing = member !== undefined;
  return (
    <ActionForm action={editing ? updateMemberAction : addMemberAction} className="flex flex-col gap-4" closeSheetOnOk={editing}>
      {member ? <input type="hidden" name="memberId" value={member.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-first`} className={labelClass}>
            First name
          </label>
          <input id={`${idPrefix}-first`} name="firstName" required maxLength={60} defaultValue={member?.firstName ?? ""} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-last`} className={labelClass}>
            Last name
          </label>
          <input id={`${idPrefix}-last`} name="lastName" required maxLength={60} defaultValue={member?.lastName ?? ""} className={inputClass} />
        </div>
      </div>
      <p className="-mb-2 text-sm text-rubric">{ROSTER_HINTS.contact}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-email`} className={labelClass}>
            Email
          </label>
          <input id={`${idPrefix}-email`} name="email" type="email" maxLength={254} defaultValue={member?.email ?? ""} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-mobile`} className={labelClass}>
            Mobile number
          </label>
          <input id={`${idPrefix}-mobile`} name="mobile" type="tel" maxLength={40} defaultValue={member?.mobile ?? ""} className={inputClass} />
        </div>
      </div>
      <fieldset className={fieldsetClass}>
        <legend className={legendClass}>What they can do</legend>
        {CAN_DO.map((k) => (
          <label key={k} className={checkRow}>
            <input type="checkbox" name="canDo" value={k} defaultChecked={member?.canDo.includes(k) ?? false} className={checkBox} />
            {CAN_DO_LABEL[k]}
          </label>
        ))}
      </fieldset>
      <div>
        <label htmlFor={`${idPrefix}-when`} className={labelClass}>
          When they are free (optional)
        </label>
        <input id={`${idPrefix}-when`} name="availability" maxLength={200} defaultValue={member?.availability ?? ""} className={inputClass} aria-describedby={`${idPrefix}-when-help`} />
        <p id={`${idPrefix}-when-help`} className="mt-1 text-sm text-rubric">
          {ROSTER_HINTS.availability}
        </p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-area`} className={labelClass}>
          Neighbourhood or ZIP (optional)
        </label>
        <input id={`${idPrefix}-area`} name="area" maxLength={60} defaultValue={member?.area ?? ""} className={inputClass} aria-describedby={`${idPrefix}-area-help`} />
        <p id={`${idPrefix}-area-help`} className="mt-1 text-sm text-rubric">
          {ROSTER_HINTS.area}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idPrefix}-often`} className={labelClass}>
            {HOW_OFTEN_QUESTION}
          </label>
          <select id={`${idPrefix}-often`} name="howOften" defaultValue={member?.howOften ?? ""} className={inputClass}>
            <option value="">{NOT_CHOSEN}</option>
            {HOW_OFTEN.map((k) => (
              <option key={k} value={k}>
                {HOW_OFTEN_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-prefer`} className={labelClass}>
            {PREFER_CONTACT_QUESTION}
          </label>
          <select id={`${idPrefix}-prefer`} name="preferContact" defaultValue={member?.preferContact ?? ""} className={inputClass}>
            <option value="">{NOT_CHOSEN}</option>
            {PREFER_CONTACT.map((k) => (
              <option key={k} value={k}>
                {PREFER_CONTACT_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-notes`} className={labelClass}>
          Notes for coordinators (optional)
        </label>
        <textarea id={`${idPrefix}-notes`} name="coordinatorNotes" rows={2} maxLength={300} defaultValue={member?.coordinatorNotes ?? ""} className={`${inputClass} py-2`} aria-describedby={`${idPrefix}-notes-help`} />
        <p id={`${idPrefix}-notes-help`} className="mt-1 text-sm text-rubric">
          {ROSTER_HINTS.notes}
        </p>
      </div>
      <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
        {editing ? "Save" : "Add to the roster"}
      </button>
    </ActionForm>
  );
}
