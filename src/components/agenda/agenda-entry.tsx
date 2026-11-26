import Link from "next/link";
import { carryAgendaAction, discussAgendaAction, removeAgendaAction } from "@/app/agenda-actions";
import { AGENDA_WORDS } from "@/lib/clergy-wording";
import { personPath } from "@/lib/care-labels";
import { instantDate } from "@/lib/format";
import type { AgendaEntry } from "@/server/care/agenda";
import { ActionForm } from "../action-form";
import { Sheet } from "../sheet";
import { btnPrimary, btnQuiet, cardClass, inputClass, labelClass, nameClass, nameLink, tagQuiet } from "../ui";
import { ActionButton } from "@/components/confirm-sheet";

const personHref = (e: AgendaEntry) => (e.outsidePersonId || e.sfContactId ? personPath(e) : null);

/** The line under a name: why, who added it and when. Shared by the screen and the print view. */
export function EntryText({ e }: { e: AgendaEntry }) {
  return (
    <>
      {e.why ? <p className="text-base [overflow-wrap:anywhere]">{e.why}</p> : null}
      <p className="text-sm text-rubric">
        {AGENDA_WORDS.addedBy} {e.addedByName ?? "a colleague"}, {instantDate(e.createdAt)}
      </p>
      {e.discussedAt ? (
        <p className="text-sm text-rubric [overflow-wrap:anywhere]">
          {AGENDA_WORDS.discuss}, {instantDate(e.discussedAt)}
          {e.outcome ? `: ${e.outcome}` : ""}
        </p>
      ) : null}
    </>
  );
}

/** One entry on the agenda screen, with its three things to do: tick it, carry it, take it off. */
export function AgendaEntryRow({ e, holders, actorId, canRemove }: { e: AgendaEntry; holders: { id: string; name: string }[]; actorId: string; canRemove: boolean }) {
  const href = personHref(e);
  const canFollowUp = e.careItemId !== null || e.sfContactId !== null || e.outsidePersonId !== null;
  return (
    <li className={cardClass} data-testid="agenda-entry">
      {href ? (
        <Link href={href} className={`${nameLink} ${nameClass}`}>
          {e.displayName}
        </Link>
      ) : (
        <p className={`${nameClass} [overflow-wrap:anywhere]`}>{e.displayName}</p>
      )}
      {e.careItemId ? (
        <p className="mt-0.5">
          <span className={tagQuiet}>Care item</span>
        </p>
      ) : null}
      <EntryText e={e} />
      {!e.discussedAt ? (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <Sheet label={AGENDA_WORDS.discuss} ariaLabel={`${AGENDA_WORDS.discussTitle}: ${e.displayName}`} title={AGENDA_WORDS.discussTitle} triggerClassName={btnPrimary}>
            <ActionForm action={discussAgendaAction} className="flex flex-col gap-4">
              <input type="hidden" name="entryId" value={e.id} />
              <div>
                <label htmlFor={`out-${e.id}`} className={labelClass}>
                  {AGENDA_WORDS.outcome}
                </label>
                <input id={`out-${e.id}`} name="outcome" maxLength={200} className={inputClass} autoComplete="off" />
              </div>
              {canFollowUp ? (
                <div>
                  <label htmlFor={`fu-${e.id}`} className={labelClass}>
                    {AGENDA_WORDS.makeFollowUp}
                  </label>
                  <select id={`fu-${e.id}`} name="followUpOwner" className={inputClass} defaultValue="">
                    <option value="">{AGENDA_WORDS.nobody}</option>
                    {holders.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.id === actorId ? `${h.name} (you)` : h.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <button type="submit" className={btnPrimary}>
                {AGENDA_WORDS.discuss}
              </button>
            </ActionForm>
          </Sheet>
          <ActionButton action={carryAgendaAction} fields={{ entryId: e.id }} label={AGENDA_WORDS.carry} className={btnQuiet} showOk={false} />
          {canRemove ? (
            <ActionButton action={removeAgendaAction} fields={{ entryId: e.id }} label={AGENDA_WORDS.remove} className={btnQuiet} showOk={false} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
