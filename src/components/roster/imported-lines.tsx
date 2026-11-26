/**
 * The quiet lines on a roster row for someone brought in from the old spreadsheet: the "Imported, not yet asked" mark,
 * the tabs they came from, what else they offered, the sheet's notes, and its history of whom they helped. The server
 * sends `imported` only to the lead and clergy level (canReadImportHistory); this component shows what it is given.
 */
import { IMPORTED_HISTORY_LABEL, IMPORTED_NOTE, IMPORTED_NOTES_LABEL, IMPORTED_OFFERS_LABEL, NOT_VOLUNTEERED_NOTE, NOT_VOLUNTEERED_WORDS, importedFromWords } from "@/lib/roster-wording";
import type { MemberView } from "@/server/volunteers/roster";

export function ImportedLines({ m }: { m: MemberView }) {
  const d = m.imported?.details;
  const otherContacts = [...(d?.otherPhones ?? []), ...(d?.otherEmails ?? [])];
  const place = [d?.address, d?.city].filter(Boolean).join(", ");
  return (
    <>
      {m.notVolunteered ? (
        <p className="mt-1 text-sm font-semibold text-rubric" data-testid="not-volunteered">
          {NOT_VOLUNTEERED_WORDS}. {NOT_VOLUNTEERED_NOTE}
        </p>
      ) : null}
      {m.emailsHeld && !m.notVolunteered ? (
        <p className="mt-1 text-sm text-rubric" data-testid="imported-note">
          {IMPORTED_NOTE}
        </p>
      ) : null}
      {m.imported ? (
        <div className="mt-1 space-y-0.5 text-sm text-rubric" data-testid="imported-detail">
          {m.imported.sources.length ? <p>{importedFromWords(m.imported.sources)}</p> : null}
          {otherContacts.length ? <p className="break-words">Also: {otherContacts.join(", ")}</p> : null}
          {place ? <p className="break-words">{place}</p> : null}
          {d?.offers?.length ? (
            <p>
              {IMPORTED_OFFERS_LABEL}: {d.offers.join("; ")}
            </p>
          ) : null}
          {d?.frequency ? <p>How often, in their words: {d.frequency}</p> : null}
          {d?.coordinatorInterest ? <p>Interested in being a coordinator</p> : null}
          {d?.okToText === false ? <p>Asked not to be texted</p> : null}
          {d?.notes?.length ? (
            <p className="whitespace-pre-line break-words text-ink">
              {IMPORTED_NOTES_LABEL}: {d.notes.join("\n")}
            </p>
          ) : null}
          {m.imported.history ? (
            <details className="mt-1">
              <summary className="cursor-pointer">{IMPORTED_HISTORY_LABEL}</summary>
              <p className="mt-1 whitespace-pre-line break-words text-ink" data-testid="imported-history">
                {m.imported.history}
              </p>
            </details>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
