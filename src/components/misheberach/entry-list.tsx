import Link from "next/link";
import { personPath } from "@/lib/care-labels";
import { instantDate } from "@/lib/format";
import { comesOffWords, CONSENT_LABEL, END_LABEL, NEEDS_REVIEW, SOURCE_LABEL, whenWords } from "@/lib/misheberach-wording";
import type { EntryView } from "@/server/misheberach/list";
import { nameClass, tagNew, tagQuiet } from "../ui";
import { EditEntry, EndEntry } from "./entry-forms";

/** The name as it is read aloud: a Hebrew name sets right to left by itself. */
export function SpokenName({ children, className = "" }: { children: string; className?: string }) {
  return (
    <span dir="auto" className={`min-w-0 break-words ${className}`}>
      {children}
    </span>
  );
}

/** One current entry, as it will be read: the name, when, who asked; what still needs a person marked; Edit and Take off. */
export function CurrentRow({ e }: { e: EntryView }) {
  const person = e.sfContactId || e.outsidePersonId ? personPath(e) : null;
  const off = comesOffWords(e);
  return (
    <li className="px-4 py-3" data-testid="mi-row">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <SpokenName className={nameClass}>{e.name}</SpokenName>
        <span className="flex flex-wrap items-center gap-2">
          {e.consent !== "confirmed" ? (
            <span className={tagNew} data-testid="mi-unconfirmed">
              {CONSENT_LABEL.not_confirmed}
            </span>
          ) : null}
          {e.expiringSoon && off ? (
            <span className={tagNew} data-testid="mi-expiring">
              {off}
            </span>
          ) : null}
          {e.needsReview ? <span className={tagNew}>{NEEDS_REVIEW}</span> : null}
        </span>
      </div>
      <p className="mt-0.5 text-base text-rubric">
        {whenWords(e)}
        {e.askedBy ? ` · ${e.askedBy}` : ""}
        {e.specialRequest ? " · Special request" : ""}
        {!e.expiringSoon && off ? ` · ${off}` : ""}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <EditEntry entry={{ id: e.id, name: e.name, kind: e.kind, askedBy: e.askedBy, consent: e.consent, specialRequest: e.specialRequest }} />
        <EndEntry id={e.id} name={e.name} />
        {person ? (
          <Link href={person} className="inline-flex min-h-11 items-center text-sm font-medium text-action underline underline-offset-4">
            Open the person
          </Link>
        ) : null}
      </div>
    </li>
  );
}

/** An entry that has ended: the name, when, and why. */
export function EndedRow({ e }: { e: EntryView }) {
  return (
    <li className="flex flex-col gap-0.5 px-4 py-2.5" data-testid="mi-ended-row">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <SpokenName className="font-serif text-base font-semibold">{e.name}</SpokenName>
        <span className={tagQuiet}>{e.endedReason ? END_LABEL[e.endedReason] : "Ended"}</span>
      </div>
      <p className="text-sm text-rubric">
        {e.endedAt ? `Off the list ${instantDate(e.endedAt)}` : ""}
        {` · ${SOURCE_LABEL[e.source]}`}
      </p>
    </li>
  );
}
