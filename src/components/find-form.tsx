"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef } from "react";
import { findPeopleAction, type FindState } from "@/app/find-actions";
import { AddOutsidePerson } from "./add-outside-person";
import { Hebrew } from "./hebrew";
import { btnPrimary, btnQuiet, facingLine, inputClass, labelClass, noticeClass, tagQuiet, titleClass } from "./ui";

const PURPOSES = ["care", "log", "follow"] as const;

/** Where a result leads: the person page, optionally opening the sheet the search was started for. */
function personHref(path: string, purpose: string | undefined): string {
  return purpose && (PURPOSES as readonly string[]).includes(purpose) ? `${path}?action=${purpose}` : path;
}

const LAST_QUERY = "crc-care:find-last-query";

/** The last search of this tab, so Back from a person lands on the same results. Never in the URL: a name there reaches request logs. */
function rememberQuery(q: string) {
  try {
    sessionStorage.setItem(LAST_QUERY, q);
  } catch {
    // Storage blocked: Back simply shows an empty search.
  }
}

function recalledQuery(): string {
  try {
    return sessionStorage.getItem(LAST_QUERY) ?? "";
  } catch {
    return "";
  }
}

const cappedLabel = (n: number) => `Showing ${n}. Load more, or narrow the search.`;

/** A later page is added to the ones already shown (and the people outside Salesforce stay from the first page). */
async function findMore(prev: FindState, form: FormData): Promise<FindState> {
  const next = await findPeopleAction(prev, form);
  if (next.status === "results" && next.offset > 0 && prev.status === "results") return { ...next, results: [...prev.results, ...next.results], outside: prev.outside };
  return next;
}
const countLabel = (n: number) => (n === 1 ? "1 person found." : `${n} people found.`);
const total = (s: { results: unknown[]; outside: unknown[] }) => s.results.length + s.outside.length;

/** The person search. It posts through a server action, so the typed name is never in the URL. */
export function FindForm({ purpose }: { purpose?: string }) {
  const [state, dispatch, pending] = useActionState<FindState, FormData>(findMore, { status: "idle" });
  const input = useRef<HTMLInputElement>(null);
  const restored = useRef(false);

  // Back from a person: put the last query back and run it again (a fresh, cached Salesforce read).
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const q = recalledQuery();
    if (!q || !input.current) return;
    input.current.value = q;
    input.current.select();
    const data = new FormData();
    data.set("q", q);
    startTransition(() => dispatch(data));
  }, [dispatch]);

  return (
    <>
      <form
        role="search"
        className="mb-5"
        action={dispatch}
        onSubmit={(e) => {
          e.preventDefault();
          // Not `disabled` while searching: that would drop focus to the page body.
          if (pending) return;
          const data = new FormData(e.currentTarget);
          rememberQuery(String(data.get("q") ?? ""));
          startTransition(() => dispatch(data));
        }}
      >
        <label htmlFor="find-page-q" className={labelClass}>
          {purpose === "care" ? "Who needs care?" : "Name or household"}
        </label>
        <div className="flex gap-2">
          <input ref={input} id="find-page-q" name="q" type="search" autoComplete="off" autoFocus enterKeyHint="search" maxLength={60} required className={inputClass} />
          <button type="submit" aria-disabled={pending} className={btnPrimary}>
            Find
          </button>
        </div>
      </form>

      <div role="status" aria-live="polite">
        {pending ? <p className="text-rubric">Searching&hellip;</p> : null}
        {!pending && state.status === "idle" ? <p className="text-rubric">Type part of a name. Only people in current member households are searched.</p> : null}
        {!pending && state.status === "error" ? <p className={noticeClass}>{state.message}</p> : null}
        {!pending && state.status === "results" ? (
          <p className={total(state) === 0 ? "text-rubric" : "mb-3 text-sm text-rubric"}>{total(state) === 0 ? "No one found. Try fewer letters or just a last name." : state.capped ? cappedLabel(state.results.length) : countLabel(total(state))}</p>
        ) : null}
      </div>
      {state.status === "results" && total(state) > 0 ? (
        <ul className="flex flex-col gap-3" aria-label="Results">
          {state.outside.map((o) => (
            <li key={o.id}>
              <Link href={personHref(`/people/outside/${o.id}`, purpose)} className="block min-h-11 rounded-md border border-control bg-surface px-4 py-3 transition-colors hover:bg-tint">
                <span className={facingLine}>
                  <span className={`${titleClass} min-w-0 break-words`}>{o.name}</span>
                  <span className={tagQuiet}>Not in Salesforce</span>
                </span>
                {o.note ? <span className="block text-sm text-rubric">{o.note}</span> : null}
              </Link>
            </li>
          ))}
          {state.results.map((p) => (
            <li key={p.contactId}>
              <Link href={personHref(`/people/${p.contactId}`, purpose)} className="block min-h-11 rounded-md border border-control bg-surface px-4 py-3 transition-colors hover:bg-tint">
                <span className={facingLine}>
                  <span className={`${titleClass} min-w-0 break-words`}>{p.name}</span>
                  {p.hebrewName ? (
                    <Hebrew size="text-[1.375rem]" className="text-action">
                      {p.hebrewName}
                    </Hebrew>
                  ) : null}
                </span>
                {p.household || p.place ? (
                  <span className="block text-sm text-rubric" data-testid="find-secondary">
                    {[p.household, p.place].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {state.status === "results" && state.capped ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btnQuiet}
            aria-disabled={pending}
            onClick={() => {
              if (pending) return;
              const data = new FormData();
              data.set("q", recalledQuery() || (input.current?.value ?? ""));
              data.set("offset", String(state.results.length));
              startTransition(() => dispatch(data));
            }}
          >
            Load more
          </button>
          <p className="text-sm text-rubric">{cappedLabel(state.results.length)}</p>
        </div>
      ) : null}
      <div className="mt-5">
        <AddOutsidePerson purpose={purpose} />
      </div>
    </>
  );
}
