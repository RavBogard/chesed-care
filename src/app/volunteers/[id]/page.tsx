import Link from "next/link";
import { notFound } from "next/navigation";
import { cancelTaskAction, doneTaskAction } from "@/app/volunteers-actions";
import { ConfirmAction } from "@/components/confirm-sheet";
import { Section } from "@/components/section";
import { Sheet } from "@/components/sheet";
import { AppShell } from "@/components/shell/app-shell";
import { btnQuiet, btnText, noticeClass, tagNew, tagQuiet } from "@/components/ui";
import { ClaimList } from "@/components/volunteers/claim-list";
import { Facts, whenWords } from "@/components/volunteers/parts";
import { AskRosterSection, loadAskRows } from "@/components/roster/ask-section";
import { SeriesControls } from "@/components/volunteers/series-controls";
import { ShareKit } from "@/components/volunteers/share-kit";
import { TaskForm } from "@/components/volunteers/task-form";
import { KIND_WORDS, placesWords } from "@/lib/volunteers-wording";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { NotFound } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import { AccessDenied } from "@/server/access/policy";
import { getVolunteerTask, type TaskView } from "@/server/volunteers/organiser";
import { listSeriesOccurrences } from "@/server/volunteers/series";
import { LoadNotice } from "@/components/load-notice";
import { appOriginOrNull, logFailure } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Volunteer task · CRC Care" };

const origin = () => appOriginOrNull() ?? "";

function state(t: TaskView) {
  if (t.status === "cancelled") return <span className={tagQuiet}>Cancelled</span>;
  if (t.status === "done") return <span className={tagQuiet}>Done</span>;
  if (t.taken === 0) return <span className={tagNew}>Nobody yet</span>;
  return t.placesLeft === 0 ? <span className={tagQuiet}>Filled</span> : <span className={tagQuiet}>{placesWords(t.placesLeft)}</span>;
}

/** One task for the person who posted it (or a colleague who may see it): its link, who has claimed, and what can be changed. */
export default async function VolunteerTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  const { id } = await params;
  let task: TaskView;
  try {
    task = await getVolunteerTask(getDb(), actor, id);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    if (error instanceof AccessDenied) {
      return (
        <AppShell actor={actor} title="Volunteer task">
          <p className={noticeClass}>You do not have access to Volunteers.</p>
        </AppShell>
      );
    }
    logFailure("Volunteer task unavailable", error);
    return (
      <AppShell actor={actor} title="Volunteer task">
        <LoadNotice what="This task" />
      </AppShell>
    );
  }
  const open = task.status === "open";
  const askRows = open ? await loadAskRows(getDb(), actor, { taskId: task.id }) : undefined;
  const series = task.seriesId ? await listSeriesOccurrences(getDb(), actor, task.id).catch(() => null) : null;
  const title = `${KIND_WORDS[task.kind]} for ${task.forLabel}`;
  const url = task.publicToken ? `${origin()}/v/${task.publicToken}` : null;
  const rows = [
    { term: "What", text: task.needed },
    { term: "When", text: whenWords(task.date, task.timeWindow) },
    { term: "Where", text: task.place ?? "Not given" },
    { term: "People", text: `${task.taken} of ${task.peopleNeeded}` },
    { term: "Questions", text: task.contactLine ?? "No contact line" },
  ];
  return (
    <AppShell actor={actor} title={title}>
      <p className="mb-4 flex flex-wrap items-center gap-2">
        {state(task)}
        {task.groupId ? (
          <Link href={`/volunteers/sheets/${task.groupId}`} className={btnText}>
            Part of a shiva sheet
          </Link>
        ) : null}
      </p>
      {task.careItemId ? <p className="mb-4 text-sm text-rubric">Linked to a care item you can see. Volunteers never see that.</p> : null}

      {open && url ? (
        <Section title="Share the link">
          <div className="mt-2">
            <ShareKit url={url} name={title} flyerHref={`/volunteers/${id}/flyer`} />
          </div>
        </Section>
      ) : null}

      {askRows !== undefined ? <AskRosterSection target={{ taskId: task.id }} rows={askRows} /> : null}

      {series ? (
        <Section title="Repeating">
          <div className="mt-2">
            <SeriesControls
              taskId={task.id}
              occurrences={series}
              claimedAhead={series.filter((o) => o.status === "open" && o.date >= task.today && o.taken > 0).length}
              today={task.today}
              values={{ forLabel: task.forLabel, needed: task.needed, timeWindow: task.timeWindow ?? "", place: task.place ?? "", contactLine: task.contactLine ?? "" }}
            />
          </div>
        </Section>
      ) : null}

      <Section title="The task">
        <Facts rows={rows} />
        {open ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <Sheet label="Edit" ariaLabel={`Edit ${title}`} title="Edit the task" triggerClassName={btnQuiet}>
              <TaskForm
                taskId={task.id}
                today={task.today}
                values={{ kind: task.kind, forLabel: task.forLabel, needed: task.needed, date: task.date, timeWindow: task.timeWindow ?? "", place: task.place ?? "", peopleNeeded: String(task.peopleNeeded), contactLine: task.contactLine ?? "" }}
              />
            </Sheet>
            <ConfirmAction action={doneTaskAction} fields={{ taskId: task.id }} label="Mark done" title="Mark this task done?" explain="The link stops working. Volunteers keep their own pages until a month after the date." confirmLabel="Mark done" />
            <ConfirmAction action={cancelTaskAction} fields={{ taskId: task.id }} label="Cancel the task" title="Cancel this task?" explain="The link stops working at once. Anyone who signed up will see, on their own page, that it was cancelled." confirmLabel="Cancel the task" />
          </div>
        ) : null}
      </Section>

      <Section title="Who signed up">
        <ClaimList claims={task.claims} editable={open} />
      </Section>
    </AppShell>
  );
}
