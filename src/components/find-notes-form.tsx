"use client";

import Link from "next/link";
import { startTransition, useActionState, useRef } from "react";
import { searchNotesAction, type NotesState } from "@/app/find-actions";
import { FIND_WORDS } from "@/lib/clergy-wording";
import { instantDate } from "@/lib/format";
import { btnPrimary, btnQuiet, cardClass, inputClass, labelClass, nameClass, noticeClass } from "./ui";

/** A later page is added to the ones already shown, merged by person. */
async function more(prev: NotesState, form: FormData): Promise<NotesState> {
  const next = await searchNotesAction(prev, form);
  if (next.status !== "results" || next.offset === 0 || prev.status !== "results") return next;
  const groups = prev.groups.map((g) => ({ ...g, hits: [...g.hits] }));
  for (const g of next.groups) {
    const have = groups.find((x) => x.key === g.key);
    if (have) have.hits.push(...g.hits);
    else groups.push(g);
  }
  return { ...next, groups, shown: prev.shown + next.shown };
}

const KIND_LABEL = { care_item: "Care summary", contact: "Contact note", follow_up: "Follow-up", agenda: "Agenda" } as const;

/**
 * "In notes": the words typed are posted by a server action, so they are never in the URL; they are not stored in this tab
 * either. The server returns only what this person may already read, grouped by person, newest first.
 */
export function FindNotesForm() {
  const [state, dispatch, pending] = useActionState<NotesState, FormData>(more, { status: "idle" });
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <form
        role="search"
        className="mb-5"
        action={dispatch}
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          const data = new FormData(e.currentTarget);
          startTransition(() => dispatch(data));
        }}
      >
        <label htmlFor="find-notes-q" className={labelClass}>
          {FIND_WORDS.notesLabel}
        </label>
        <div className="flex gap-2">
          <input ref={input} id="find-notes-q" name="q" type="search" autoComplete="off" enterKeyHint="search" minLength={3} maxLength={60} required className={inputClass} aria-describedby="find-notes-hint" />
          <button type="submit" aria-disabled={pending} className={btnPrimary}>
            Find
          </button>
        </div>
        <p id="find-notes-hint" className="mt-1 text-sm text-rubric">
          {FIND_WORDS.notesHint}
        </p>
      </form>
      <div role="status" aria-live="polite">
        {pending ? <p className="text-rubric">Searching&hellip;</p> : null}
        {!pending && state.status === "error" ? <p className={noticeClass}>{state.message}</p> : null}
        {!pending && state.status === "results" && state.shown === 0 ? <p className="text-rubric">{FIND_WORDS.notesNone}</p> : null}
      </div>
      {state.status === "results" && state.groups.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label="Results" data-testid="notes-results">
          {state.groups.map((g) => (
            <li key={g.key} className={cardClass} data-testid="notes-group">
              {g.href ? (
                <Link href={g.href} className={`${nameClass} inline-flex min-h-11 items-center underline decoration-control underline-offset-4`}>
                  {g.name}
                </Link>
              ) : (
                <p className={nameClass}>{g.name}</p>
              )}
              <ul className="mt-1 flex flex-col gap-2">
                {g.hits.map((h) => (
                  <li key={`${h.kind}-${h.id}`} className="border-t border-rule-soft pt-2 first:border-t-0 first:pt-0" data-testid="notes-hit">
                    <p className="text-sm text-rubric">
                      {KIND_LABEL[h.kind]}, {instantDate(new Date(h.at))}
                    </p>
                    <p className="text-base [overflow-wrap:anywhere]">{h.snippet}</p>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      {state.status === "results" && state.hasMore ? (
        <div className="mt-3">
          <button
            type="button"
            className={btnQuiet}
            aria-disabled={pending}
            onClick={() => {
              if (pending || !input.current) return;
              const data = new FormData();
              data.set("q", input.current.value);
              data.set("offset", String(state.offset + 20));
              startTransition(() => dispatch(data));
            }}
          >
            {FIND_WORDS.more}
          </button>
        </div>
      ) : null}
    </>
  );
}
