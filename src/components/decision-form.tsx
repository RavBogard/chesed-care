"use client";

import { useState, useTransition } from "react";
import { acceptProposalAction, existingItemsAction, type ExistingItem } from "@/app/inbox-actions";
import { CATEGORY_LABEL, type CategoryKey } from "@/lib/care-labels";
import { ActionForm } from "./action-form";
import { CareFields, type TeamChoice } from "./care-fields";
import { JourneyPicker, type JourneyOption } from "./journey-picker";
import { PersonPicker, type PersonChoice } from "./person-picker";
import { ADD_TO_LIST, KIND_LABEL } from "@/lib/misheberach-wording";
import { LAST_CONTACT_LABEL } from "@/lib/bring-in-wording";
import { btnLaptopNatural, btnPrimary, btnQuiet, checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "./ui";

export type DecisionInitial = {
  person: PersonChoice | null;
  candidates?: PersonChoice[];
  existing?: ExistingItem[];
  existingCareItemId?: string;
  category?: string;
  summary?: string;
  location?: string;
  learnedFrom?: string;
  ownerUserId?: string;
  restricted?: boolean;
  followUp?: { title: string; dueDate: string } | null;
  followUpIdea?: string;
  /** A journey to offer: preselected (`on`, e.g. a death from Salesforce) or only suggested, from a date (the date of death). */
  journey?: { key: string; on: boolean; anchorDate?: string };
  /** Offer to add the name to the Mi Sheberach list: ticked when the public sender said yes, unticked for "not sure". Never offered for "no". */
  miSheberach?: { offer: "yes" | "not_sure"; name: string; askedBy: string };
};

/**
 * The decision sheet: what a clergy member settles when a proposal becomes care. It is shared
 * by the Inbox (Edit) and quick capture. The person (searched, or someone not in the
 * directory); a new care item, or "Add to" one that person already has; the kind, what is
 * going on, where, how we learned, who has it, the restriction; and an optional first
 * follow-up. `words` are what was written, shown above the fields. `footer` holds buttons
 * that are forms of their own, so it sits beside this form, not inside it.
 */
export function DecisionForm({
  proposalId,
  words,
  today,
  actorId,
  holders,
  initial,
  submitLabel = "Save",
  onOk,
  footer,
  journeyChoices = [],
  offerLastContact = false,
}: {
  proposalId: string;
  words: string | null;
  today: string;
  actorId: string;
  holders: TeamChoice[];
  initial: DecisionInitial;
  submitLabel?: string;
  onOk?: () => void;
  footer?: React.ReactNode;
  /** The journeys that can be started on accepting (clergy level). */
  journeyChoices?: JourneyOption[];
  /** An entry from the clergy member's own list: offer "last contact was about ... ago", which sets the first follow-up and logs nothing. */
  offerLastContact?: boolean;
}) {
  const [person, setPerson] = useState<PersonChoice | null>(initial.person);
  const [existing, setExisting] = useState<ExistingItem[]>(initial.existing ?? []);
  const [target, setTarget] = useState(initial.existingCareItemId ?? "");
  // The app's follow-up idea is only ever offered: nothing is filled in, and no follow-up exists unless it is typed or the button is pressed.
  const [followTitle, setFollowTitle] = useState(initial.followUp?.title ?? "");
  const [, startTransition] = useTransition();
  const pick = (p: PersonChoice | null) => {
    setPerson(p);
    setExisting([]);
    setTarget("");
    if (!p) return;
    startTransition(async () => {
      const found = await existingItemsAction(p.kind === "sf" ? { contactId: p.contactId } : { outsidePersonId: p.id });
      if (found.status === "ok") setExisting(found.data);
    });
  };
  const adding = target !== "";
  const label = (c: string) => CATEGORY_LABEL[c as CategoryKey] ?? c;
  return (
    <>
      {words ? (
        <figure className="mb-4 rounded-md border border-rule bg-surface p-3">
          <figcaption className="text-xs font-bold uppercase tracking-[0.09em] text-rubric">What was written</figcaption>
          <blockquote className="mt-1 whitespace-pre-wrap break-words text-base" data-testid="decision-words">
            {words}
          </blockquote>
        </figure>
      ) : null}
      <ActionForm action={acceptProposalAction} className="flex flex-col gap-4" onOk={onOk}>
        <input type="hidden" name="proposalId" value={proposalId} />
        <PersonPicker value={person} onChange={pick} candidates={initial.candidates} idPrefix={`dec-${proposalId}`} />

        {existing.length > 0 ? (
          <fieldset className={fieldsetClass}>
            <legend className={legendClass}>Is this a new need?</legend>
            <label className={checkRow}>
              <input type="radio" name="careItemId" value="" checked={!adding} onChange={() => setTarget("")} className={checkBox} />
              <span>New care item</span>
            </label>
            {existing.map((i) => (
              <label key={i.id} className={checkRow}>
                <input type="radio" name="careItemId" value={i.id} checked={target === i.id} onChange={() => setTarget(i.id)} className={checkBox} />
                <span>Add to the open {label(i.category).toLowerCase()} care</span>
              </label>
            ))}
            {initial.restricted ? (
              <p className="mt-1 text-sm text-alert" data-testid="decision-sensitive-hint">
                This looks sensitive. Adding it to an open care item saves it as a private note on that item; a new restricted care item is safer.
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {adding ? (
          <div>
            <label htmlFor={`dec-${proposalId}-add`} className={labelClass}>
              What to add
            </label>
            <textarea id={`dec-${proposalId}-add`} name="summary" rows={3} maxLength={500} required defaultValue={initial.summary ?? ""} className={`${inputClass} py-2`} />
          </div>
        ) : (
          <CareFields
            idPrefix={`dec-${proposalId}`}
            holders={holders}
            actorId={actorId}
            restrictedControls
            defaults={{ category: initial.category, summary: initial.summary, location: initial.location, learnedFrom: initial.learnedFrom, ownerUserId: initial.ownerUserId, restricted: initial.restricted }}
          />
        )}

        {offerLastContact && !adding ? (
          <div>
            <label htmlFor={`dec-${proposalId}-last`} className={labelClass}>
              Last contact was about
            </label>
            <select id={`dec-${proposalId}-last`} name="lastContact" defaultValue="unsure" className={inputClass} data-testid="decision-last-contact">
              {(Object.keys(LAST_CONTACT_LABEL) as (keyof typeof LAST_CONTACT_LABEL)[]).map((k) => (
                <option key={k} value={k}>
                  {LAST_CONTACT_LABEL[k]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-sm text-rubric">This is not logged as a contact. It only suggests when to check in: leave &ldquo;What&rdquo; below empty to use it.</p>
          </div>
        ) : null}

        <fieldset className={`${fieldsetClass} flex flex-col gap-3`}>
          <legend className={legendClass}>First follow-up (optional)</legend>
          <div>
            <label htmlFor={`dec-${proposalId}-fu`} className={labelClass}>
              What
            </label>
            <input id={`dec-${proposalId}-fu`} name="followUpTitle" maxLength={200} value={followTitle} onChange={(e) => setFollowTitle(e.target.value)} className={inputClass} placeholder="Call to check in" />
            {initial.followUpIdea && followTitle !== initial.followUpIdea ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm" data-testid="decision-followup-idea">
                <span className="text-rubric">
                  Suggested by the app&rsquo;s AI reading: <q className="break-words text-ink">{initial.followUpIdea}</q>
                </span>
                <button type="button" className={btnQuiet} onClick={() => setFollowTitle(initial.followUpIdea ?? "")}>
                  Use this
                </button>
              </div>
            ) : null}
          </div>
          <div>
            <label htmlFor={`dec-${proposalId}-due`} className={labelClass}>
              When
            </label>
            <input id={`dec-${proposalId}-due`} name="followUpDue" type="date" defaultValue={initial.followUp?.dueDate ?? today} className={inputClass} />
          </div>
          <div>
            <label htmlFor={`dec-${proposalId}-who`} className={labelClass}>
              Who
            </label>
            <select id={`dec-${proposalId}-who`} name="followUpOwner" className={inputClass} defaultValue={initial.ownerUserId ?? actorId}>
              {holders.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.id === actorId ? " (me)" : ""}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        {journeyChoices.length > 0 ? (
          <fieldset className={`${fieldsetClass} flex flex-col gap-3`}>
            <legend className={legendClass}>Journey (optional)</legend>
            <JourneyPicker
              options={journeyChoices}
              today={today}
              optional
              idPrefix={`dec-${proposalId}-j`}
              initialKey={initial.journey?.on ? initial.journey.key : ""}
              initialAnchor={initial.journey?.anchorDate}
              suggestedKey={initial.journey && !initial.journey.on ? initial.journey.key : undefined}
            />
          </fieldset>
        ) : null}

        {initial.miSheberach ? (
          <fieldset className={`${fieldsetClass} flex flex-col gap-3`} data-testid="decision-mi-sheberach">
            <legend className={legendClass}>Mi Sheberach</legend>
            <label className={checkRow}>
              <input type="checkbox" name="miSheberach" defaultChecked={initial.miSheberach.offer === "yes"} className={checkBox} />
              <span>{ADD_TO_LIST}</span>
            </label>
            <div>
              <label htmlFor={`dec-${proposalId}-mi-name`} className={labelClass}>
                Name as it is read aloud
              </label>
              <input id={`dec-${proposalId}-mi-name`} name="miName" maxLength={200} defaultValue={initial.miSheberach.name} className={inputClass} autoComplete="off" />
            </div>
            <div>
              <label htmlFor={`dec-${proposalId}-mi-kind`} className={labelClass}>
                How long
              </label>
              <select id={`dec-${proposalId}-mi-kind`} name="miKind" defaultValue="dated" className={inputClass}>
                <option value="dated">{KIND_LABEL.dated}</option>
                <option value="standing">{KIND_LABEL.standing}</option>
              </select>
            </div>
            <div>
              <label htmlFor={`dec-${proposalId}-mi-asked`} className={labelClass}>
                Who asked (optional)
              </label>
              <input id={`dec-${proposalId}-mi-asked`} name="miAskedBy" maxLength={200} defaultValue={initial.miSheberach.askedBy} className={inputClass} autoComplete="off" />
            </div>
          </fieldset>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
            {submitLabel}
          </button>
        </div>
      </ActionForm>
      {footer ? <div className="mt-3 flex flex-wrap items-start gap-2 border-t border-rule pt-3">{footer}</div> : null}
    </>
  );
}
