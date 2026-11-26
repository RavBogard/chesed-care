import Link from "next/link";
import { closeLinksAction } from "@/app/volunteers-actions";
import { ConfirmAction } from "@/components/confirm-sheet";
import { Section } from "@/components/section";
import { btnQuiet, nameClass, noticeClass, tagNew, tagQuiet } from "@/components/ui";
import { shortDate } from "@/lib/format";
import { KIND_WORDS, placesWords } from "@/lib/volunteers-wording";
import { isClergyLevel, type Actor } from "@/server/access/policy";
import { getDb } from "@/server/db/client";
import { listTasksForCareItems, type CareItemTask } from "@/server/volunteers/organiser";
import { soft } from "@/server/soft";

/**
 * The volunteer tasks linked to a person's care items, for clergy who fully see those items (the
 * caller passes only items the actor fully reads). Null when the role may not see it or it could not
 * be read: a failure must not break the person's page.
 */
export async function loadVolunteerTasks(actor: Actor, careItemIds: string[]): Promise<CareItemTask[] | null> {
  if (!isClergyLevel(actor) || careItemIds.length === 0) return null;
  return soft("Volunteer tasks unavailable", null, () => listTasksForCareItems(getDb(), actor, careItemIds));
}

function tag(t: CareItemTask) {
  if (t.status === "cancelled") return <span className={tagQuiet}>Cancelled</span>;
  if (t.status === "done") return <span className={tagQuiet}>Done</span>;
  if (t.section === "finished") return <span className={tagQuiet}>Passed</span>;
  if (t.taken === 0) return <span className={tagNew}>Nobody yet</span>;
  return t.placesLeft === 0 ? <span className={tagQuiet}>Filled</span> : <span className={tagQuiet}>{placesWords(t.placesLeft)}</span>;
}

/** "Volunteer tasks": this person's tasks with their status, and a way to post one. */
export function PersonVolunteers({ tasks, careItemId, restrictedItemIds = [] }: { tasks: CareItemTask[] | null; careItemId: string | null; restrictedItemIds?: string[] }) {
  if (tasks === null || careItemId === null) return null;
  // Tasks made before an item was restricted keep working for volunteers: say so, and offer to close them.
  const stillOpen = restrictedItemIds.filter((id) => tasks.some((t) => t.careItemId === id && t.linkOpen));
  return (
    <Section title="Volunteer tasks">
      {stillOpen.map((id) => (
        <div key={id} className={`${noticeClass} mt-2 flex flex-col items-start gap-3`} data-testid="restricted-links-open">
          <p>This care is now restricted, but the public links for its volunteer tasks are still open. They show volunteers only what you typed for them. Nothing was closed for you.</p>
          <ConfirmAction action={closeLinksAction} fields={{ careItemId: id }} label="Close these links" title="Close these links?" explain="Every open volunteer task for this care is cancelled and its link stops working. Anyone who signed up will see that it was cancelled." confirmLabel="Close these links" />
        </div>
      ))}
      {tasks.length ? (
        <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="volunteer-tasks">
          {tasks.map((t) => (
            <li key={t.id}>
              <Link href={`/volunteers/${t.id}`} className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 transition-colors hover:bg-tint focus-visible:-outline-offset-3">
                <span className={`${nameClass} min-w-0 break-words underline decoration-control underline-offset-4`}>
                  {KIND_WORDS[t.kind]} for {t.forLabel}
                </span>
                {tag(t)}
                <span className="w-full text-sm text-rubric">
                  {shortDate(t.date)} · {t.taken} of {t.peopleNeeded} taken
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-rubric">No volunteer tasks yet.</p>
      )}
      <p className="mt-3">
        <Link href={`/volunteers/new?careItem=${careItemId}`} className={btnQuiet}>
          Post a task
        </Link>
      </p>
    </Section>
  );
}
