import Link from "next/link";
import { dismissSuggestionAction } from "@/app/today-actions";
import { ActionForm } from "@/components/action-form";
import { Group } from "@/components/today-dates";
import { nameClass, nameLink } from "@/components/ui";
import { OUTREACH_WORDS } from "@/lib/team-wording";
import type { Suggestion } from "@/server/care/suggestions";

/**
 * A short, quiet list: who might like a call, and why, in plain words. It is not a score and has
 * no numbers of its own. Each one can be set aside for 30 days.
 */
export function Outreach({ suggestions }: { suggestions: Suggestion[] }) {
  if (suggestions.length === 0) return null;
  return (
    <Group title={OUTREACH_WORDS.title}>
      <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="outreach">
        {suggestions.map((s) => (
          <li key={`${s.kind}|${s.subjectId}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2" data-testid="outreach-row">
            <div className="min-w-0 flex-1 basis-56">
              <Link href={s.href} className={`${nameLink} ${nameClass}`}>
                {s.name}
              </Link>
              <p className="text-sm text-rubric">{s.reason}</p>
            </div>
            <ActionForm action={dismissSuggestionAction} closeSheetOnOk={false} showOk={false}>
              <input type="hidden" name="kind" value={s.kind} />
              <input type="hidden" name="subjectId" value={s.subjectId} />
              <button type="submit" className="inline-flex min-h-11 items-center text-sm font-medium text-action underline underline-offset-4 hover:text-action-strong" title={OUTREACH_WORDS.dismissHelp}>
                {OUTREACH_WORDS.dismiss}
              </button>
            </ActionForm>
          </li>
        ))}
      </ul>
    </Group>
  );
}
