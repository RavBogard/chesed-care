"use client";

import { startTransition, useId, useState } from "react";
import { findPeopleAction } from "@/app/find-actions";
import { btnQuiet, btnText, fieldsetClass, inputClass, labelClass, tagQuiet } from "./ui";

/** Whom a care record is about: a person in Salesforce, or someone kept only in this app. */
export type PersonChoice = { kind: "sf"; contactId: string; name: string; household: string | null } | { kind: "outside"; id: string; name: string; note: string | null };

type Found = { people: PersonChoice[]; capped: boolean };

const IDLE_FIND = { status: "idle" } as const;

/**
 * Pick the person for a care record: search Salesforce people and outside people together,
 * or add "Someone not in the directory" with a name, a phone and a short note. It is not a
 * form of its own (it sits inside the decision form), so Enter in the box searches. The chosen
 * person goes with the form as hidden fields; a new outside person as newName, newPhone, newNote.
 */
export function PersonPicker({ value, onChange, candidates = [], idPrefix, legend = "Who needs care", allowNew = true }: { value: PersonChoice | null; onChange: (p: PersonChoice | null) => void; candidates?: PersonChoice[]; idPrefix: string; legend?: string; allowNew?: boolean }) {
  const [found, setFound] = useState<Found | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const statusId = useId();

  const search = () => {
    if (busy) return;
    const data = new FormData();
    data.set("q", q);
    setBusy(true);
    setMessage(null);
    startTransition(async () => {
      const state = await findPeopleAction(IDLE_FIND, data);
      setBusy(false);
      if (state.status === "error") {
        setFound(null);
        setMessage(state.message);
        return;
      }
      if (state.status !== "results") return;
      const people: PersonChoice[] = [
        ...state.outside.map((o): PersonChoice => ({ kind: "outside", id: o.id, name: o.name, note: o.note })),
        ...state.results.map((p): PersonChoice => ({ kind: "sf", contactId: p.contactId, name: p.name, household: p.household })),
      ];
      setFound({ people, capped: state.capped });
      setMessage(people.length === 0 ? "No one found. Try fewer letters or just a last name." : null);
    });
  };

  if (value) {
    return (
      <div>
        <p className={labelClass}>{legend}</p>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md border border-rule bg-surface px-3 py-2">
          <span className="min-w-0 break-words">
            <span className="font-serif text-[1.0625rem] font-semibold">{value.name}</span>
            {value.kind === "outside" ? (
              <>
                {" "}
                <span className={tagQuiet}>Not in Salesforce</span>
              </>
            ) : value.household && value.household !== value.name ? (
              <span className="block text-sm text-rubric">{value.household}</span>
            ) : null}
          </span>
          <button type="button" className={btnText} onClick={() => onChange(null)}>
            Change
          </button>
        </div>
        {value.kind === "sf" ? <input type="hidden" name="contactId" value={value.contactId} /> : <input type="hidden" name="outsidePersonId" value={value.id} />}
      </div>
    );
  }

  const list = found?.people ?? candidates;
  return (
    <fieldset className="min-w-0 border-0 p-0">
      <legend className={labelClass}>{legend}</legend>
      {adding ? (
        <div className={`${fieldsetClass} flex flex-col gap-3`}>
          <p className="text-sm font-semibold">Someone not in the directory</p>
          <div>
            <label htmlFor={`${idPrefix}-new-name`} className={labelClass}>
              Name
            </label>
            <input id={`${idPrefix}-new-name`} name="newName" maxLength={200} required className={inputClass} autoComplete="off" />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-new-phone`} className={labelClass}>
              Phone (optional)
            </label>
            <input id={`${idPrefix}-new-phone`} name="newPhone" type="tel" maxLength={40} className={inputClass} autoComplete="off" />
          </div>
          <div>
            <label htmlFor={`${idPrefix}-new-note`} className={labelClass}>
              A short note (optional)
            </label>
            <input id={`${idPrefix}-new-note`} name="newNote" maxLength={200} className={inputClass} placeholder="Mother of a member, lives in Denver" />
          </div>
          <button type="button" className={`${btnText} self-start`} onClick={() => setAdding(false)}>
            Search the directory instead
          </button>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <label htmlFor={`${idPrefix}-q`} className="sr-only">
              Search by name
            </label>
            <input
              id={`${idPrefix}-q`}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  search();
                }
              }}
              maxLength={60}
              autoComplete="off"
              enterKeyHint="search"
              placeholder="Name or household"
              className={inputClass}
              aria-describedby={statusId}
            />
            <button type="button" className={btnQuiet} aria-disabled={busy} onClick={search}>
              Find
            </button>
          </div>
          <div id={statusId} role="status" aria-live="polite" className="mt-2 text-sm text-rubric empty:hidden">
            {busy ? "Searching…" : (message ?? (found && found.people.length > 0 ? `${found.people.length} found.` : ""))}
          </div>
          {list.length > 0 ? (
            <>
              {!found ? <p className="mt-2 text-sm text-rubric">Possible matches</p> : null}
              <ul className="mt-2 flex flex-col gap-2" aria-label="People found">
                {list.map((p) => (
                  <li key={p.kind === "sf" ? p.contactId : p.id}>
                    <button type="button" className="flex min-h-11 w-full flex-wrap items-baseline gap-x-3 rounded-md border border-control bg-surface px-3 py-2 text-left transition-colors hover:bg-tint" onClick={() => onChange(p)}>
                      <span className="font-serif text-[1.0625rem] font-semibold">{p.name}</span>
                      {p.kind === "outside" ? <span className={tagQuiet}>Not in Salesforce</span> : p.household && p.household !== p.name ? <span className="text-sm text-rubric">{p.household}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {allowNew ? (
            <button type="button" className={`${btnText} mt-2`} onClick={() => setAdding(true)}>
              Someone not in the directory
            </button>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
