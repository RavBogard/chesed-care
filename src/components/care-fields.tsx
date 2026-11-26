"use client";

import { useId, useState } from "react";
import { CATEGORY_KEYS, CATEGORY_LABEL } from "@/lib/care-labels";
import { checkBox, checkRow, fieldsetClass, inputClass, labelClass, legendClass } from "./ui";

/** Someone who can hold a care item: an active member of the clergy. */
export type TeamChoice = { id: string; name: string; stale?: boolean };

export type CareDefaults = {
  category?: string;
  summary?: string;
  location?: string;
  learnedFrom?: string;
  ownerUserId?: string;
  restricted?: boolean;
  showsCarer?: boolean;
  accessUserIds?: string[];
};

/**
 * The fields of a care item, shared by Add to the care list, Edit, and the decision sheet:
 * kind, what is going on, where, how we learned, who has it, and the restriction. The
 * restriction is offered only where `restrictedControls` says so (a new item, or the item's
 * own owner); it reveals who else may see it and what the others see.
 */
export function CareFields({
  idPrefix,
  holders,
  actorId,
  defaults = {},
  restrictedControls,
  showOwner = true,
}: {
  idPrefix: string;
  holders: TeamChoice[];
  actorId: string;
  defaults?: CareDefaults;
  restrictedControls: boolean;
  showOwner?: boolean;
}) {
  const [owner, setOwner] = useState(defaults.ownerUserId ?? actorId);
  const [restricted, setRestricted] = useState(defaults.restricted ?? false);
  const restrictedId = useId();
  const ownerName = holders.find((h) => h.id === owner)?.name ?? "someone";
  const others = holders.filter((h) => h.id !== owner && !h.stale);
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-category`} className={labelClass}>
          What kind of care
        </label>
        <select id={`${idPrefix}-category`} name="category" className={inputClass} defaultValue={defaults.category ?? "illness"}>
          {CATEGORY_KEYS.map((k) => (
            <option key={k} value={k}>
              {CATEGORY_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-summary`} className={labelClass}>
          What is going on
        </label>
        <textarea id={`${idPrefix}-summary`} name="summary" rows={3} maxLength={500} defaultValue={defaults.summary ?? ""} className={`${inputClass} py-2`} />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-location`} className={labelClass}>
          Where
        </label>
        <input id={`${idPrefix}-location`} name="location" maxLength={200} defaultValue={defaults.location ?? ""} className={inputClass} placeholder="Hospital, home, city" />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-learned`} className={labelClass}>
          How we learned
        </label>
        <input id={`${idPrefix}-learned`} name="learnedFrom" maxLength={200} defaultValue={defaults.learnedFrom ?? ""} className={inputClass} placeholder="Told by a family member" />
      </div>
      {showOwner ? (
        <div>
          <label htmlFor={`${idPrefix}-owner`} className={labelClass}>
            Who is caring for them
          </label>
          <select id={`${idPrefix}-owner`} name="ownerUserId" className={inputClass} value={owner} onChange={(e) => setOwner(e.target.value)}>
            {holders.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {h.id === actorId ? " (me)" : ""}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {restrictedControls ? (
        <div className="flex flex-col gap-4">
          <input type="hidden" name="restrictionShown" value="yes" />
          <label className={checkRow}>
            <input type="checkbox" name="restricted" className={checkBox} checked={restricted} onChange={(e) => setRestricted(e.target.checked)} aria-controls={restrictedId} />
            <span>Restricted: only the people I name can read it</span>
          </label>
          <div id={restrictedId} hidden={!restricted} className="flex flex-col gap-4">
            {restricted ? (
              <>
                <fieldset className={fieldsetClass}>
                  <legend className={legendClass}>Who else may see it</legend>
                  {others.length === 0 ? (
                    <p className="text-sm text-rubric">No other clergy to name.</p>
                  ) : (
                    others.map((h) => (
                      <label key={h.id} className={checkRow}>
                        <input type="checkbox" name="accessUserId" value={h.id} defaultChecked={defaults.accessUserIds?.includes(h.id)} className={checkBox} />
                        <span>{h.name}</span>
                      </label>
                    ))
                  )}
                </fieldset>
                <fieldset className={fieldsetClass}>
                  <legend className={legendClass}>What others see</legend>
                  <label className={checkRow}>
                    <input type="radio" name="shows" value="carer" defaultChecked={defaults.showsCarer !== false} className={checkBox} />
                    <span>In {ownerName}&rsquo;s care</span>
                  </label>
                  <label className={checkRow}>
                    <input type="radio" name="shows" value="none" defaultChecked={defaults.showsCarer === false} className={checkBox} />
                    <span>Nothing</span>
                  </label>
                </fieldset>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
