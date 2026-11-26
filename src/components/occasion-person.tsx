"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { markOccasionAction, unmarkOccasionAction } from "@/app/actions";
import { IDLE } from "@/lib/action-state";
import { Hebrew } from "./hebrew";
import { useAnnounce } from "./mark-announcer";
import { markTexted, useTexted } from "./texted-store";
import type { OccasionType } from "@/server/lifecycle/types";
import { btnKind, btnQuiet, btnText, facingLine, nameClass, nameLink } from "./ui";
import { CheckIcon } from "./check-icon";

export type PersonRow = {
  /** sessionStorage key for "texted": the occasion and its year. */
  textedKey: string;
  done: boolean;
  /** The person or household to reach; null when it is the person the occasion is about, or nobody. */
  name: string | null;
  /** The Hebrew name of the person to reach, shown facing their name when there is one. */
  hebrewName: string | null;
  /** Shown when there is nobody on file to reach. */
  missing: boolean;
  personHref: string | null;
  /** The mourner's household, when it is not already their name. */
  relation: string | null;
  /** A memorial: what the deceased was to the person to reach ("Parent"), when Salesforce says. */
  relationship: string | null;
  firstName: string | null;
  /** What Done refers to, e.g. "Ruth's birthday" or "Dana Levy's yahrzeit for Sarah Levy". */
  subject: string;
  sms: string | null;
  call: string | null;
  draft: string | null;
  fields: Record<string, string>;
};

function MarkForm({ row, primaryClass, errorClass = "text-alert" }: { row: PersonRow; primaryClass: string | null; errorClass?: string }) {
  const action = row.done ? unmarkOccasionAction : markOccasionAction;
  // `dispatch` stays on the form so the server-rendered markup is a POST before hydration.
  const [state, dispatch] = useActionState(action, IDLE);
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState<string | null>(null);
  const announce = useAnnounce();
  const error = failed ?? (state.status === "error" ? state.message : null);
  return (
    <form
      action={dispatch}
      className="flex flex-col items-end"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        setFailed(null);
        start(async () => {
          // Called directly: on success this row is replaced, so the result is announced from above it.
          const result = await action(IDLE, data);
          if (result.status === "error") {
            setFailed(result.message);
            announce(result.message);
          } else {
            announce(row.done ? `${row.subject} marked not done.` : `${row.subject} marked done.`);
          }
        });
      }}
    >
      {Object.entries(row.fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" disabled={pending} aria-busy={pending} aria-label={row.done ? `Undo ${row.subject} done` : `Mark ${row.subject} done`} className={primaryClass ?? btnQuiet}>
        {pending ? "Saving…" : row.done ? "Undo" : "Done"}
      </button>
      {error ? <p className={`mt-1 max-w-48 text-right text-sm font-medium ${errorClass}`}>{error}</p> : null}
    </form>
  );
}

/**
 * Done for a card whose title is the person to reach (a mourner): it sits on the card's band,
 * at the top right beside the title. Solid once the row is texted, as on any other row; an
 * error beneath it is in ink, since it is on a band.
 */
export function OccasionMark({ row, kind }: { row: PersonRow; kind: OccasionType }) {
  const texted = useTexted(row.textedKey) && !row.done;
  return <MarkForm row={row} primaryClass={texted ? btnKind[kind] : null} errorClass="text-ink" />;
}

/**
 * One person to reach for an occasion: who (with their Hebrew name facing, when known) and Done set apart at the top right, then the draft across the row, then Text and Call. The one solid button is in the fill of the occasion's kind.
 * `headed` is for a card whose title already is this person, with Done beside it (see OccasionMark): the row is then their household, the draft, Text and Call.
 */
export function OccasionPerson({ row, kind = "yahrzeit", headed = false }: { row: PersonRow; kind?: OccasionType; headed?: boolean }) {
  const texted = useTexted(row.textedKey) && !row.done;
  const who = row.firstName ? ` ${row.firstName}` : "";
  const primary = btnKind[kind];
  // A row with no name line (the card title names the person) has nothing to put beside Done at the top: Done goes at the end of the button row.
  const lone = !headed && !row.name && !row.missing && !row.relation;
  const mark = <MarkForm row={row} primaryClass={texted ? primary : null} />;
  const textedNote = texted ? (
    <p className="flex items-center gap-1.5 text-sm font-semibold text-done">
      <CheckIcon size={14} />
      Texted
    </p>
  ) : null;
  return (
    <li className="px-4 py-3" data-testid="occasion-row" data-texted={texted ? "true" : undefined}>
      {headed ? (
        row.relation || textedNote ? (
          <div>
            {row.relation ? <p className="text-sm break-words text-rubric">{row.relation}</p> : null}
            {textedNote}
          </div>
        ) : null
      ) : lone ? null : (
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1">
            {row.name ? (
              <p className={`${facingLine} ${nameClass}`}>
                {row.personHref ? (
                  <Link href={row.personHref} className={`${nameLink} -mb-2`}>
                    {row.name}
                  </Link>
                ) : (
                  <span>{row.name}</span>
                )}
                {row.hebrewName ? <Hebrew className="text-action">{row.hebrewName}</Hebrew> : null}
              </p>
            ) : null}
            {row.missing ? <p className="text-sm text-rubric">No one to contact on file.</p> : null}
            {row.relation ? <p className="text-sm text-rubric">{row.relation}</p> : null}
            {textedNote}
          </div>
          {mark}
        </div>
      )}
      {/* The words that will be sent, across the whole row: two lines on a phone, all of them on a laptop. */}
      {row.draft && !row.done ? (
        <p className={`mt-2 line-clamp-2 text-sm text-pretty text-rubric lg:line-clamp-none ${headed ? "first:mt-0" : ""}`} data-testid="occasion-draft">
          <span className="font-semibold">Draft:</span> {row.draft}
        </p>
      ) : null}
      {lone && (row.done || row.missing) ? <div className="flex justify-end">{mark}</div> : null}
      {row.done || row.missing ? null : (
        <div className={`mt-3 flex flex-wrap items-center gap-2 ${headed ? "first:mt-0" : ""}`}>
          {lone ? textedNote : null}
          {row.sms ? (
            <a href={row.sms} onClick={() => markTexted(row.textedKey)} className={`${texted ? btnQuiet : primary} flex-1 lg:min-w-44 lg:flex-none`}>
              Text{who}
            </a>
          ) : null}
          {row.call ? (
            <a href={row.call} aria-label={`Call${who}`} className={btnQuiet}>
              Call
            </a>
          ) : null}
          {lone ? <div className="ml-auto pl-4">{mark}</div> : null}
          {row.sms ? null : (
            <>
              {row.call ? null : <span className="text-sm text-rubric">No number on file.</span>}
              {row.personHref ? (
                <Link href={row.personHref} className={btnText}>
                  Open{who || " person"}
                </Link>
              ) : null}
            </>
          )}
        </div>
      )}
    </li>
  );
}
