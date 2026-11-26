/** The owner's one switch on Admin: email on for everyone from the old Mitzvah Corps sheet, behind a sheet that says how many. */
import { releaseImportedEmailsAction } from "@/app/settings-actions";
import { ConfirmAction } from "@/components/confirm-sheet";
import { Section } from "@/components/section";
import { RELEASE_EXPLAIN, RELEASE_NONE, RELEASE_TITLE, releaseConfirmWords } from "@/lib/roster-wording";

export function ReleaseEmailsSection({ count, token }: { count: number; token: string }) {
  return (
    <Section title={RELEASE_TITLE}>
      <p className="mt-2 max-w-prose text-sm text-rubric">{RELEASE_EXPLAIN}</p>
      <div className="mt-3" data-testid="release-emails">
        {count === 0 ? (
          <p className="text-sm text-rubric">{RELEASE_NONE}</p>
        ) : (
          <ConfirmAction
            action={releaseImportedEmailsAction}
            fields={{ token }}
            label={count === 1 ? "Turn on email for 1 person" : `Turn on email for ${count} people`}
            title="Turn on email?"
            explain={releaseConfirmWords(count)}
            confirmLabel="Turn on email"
          />
        )}
      </div>
    </Section>
  );
}
