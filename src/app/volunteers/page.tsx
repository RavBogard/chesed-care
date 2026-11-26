import Link from "next/link";
import { makeBoardLinkAction, replaceBoardLinkAction } from "@/app/volunteers-actions";
import { ActionButton, ConfirmAction } from "@/components/confirm-sheet";
import { CopyButton } from "@/components/copy-button";
import { Section } from "@/components/section";
import { AppShell } from "@/components/shell/app-shell";
import { btnPrimary, btnQuiet, nameClass, noticeClass, tagNew, tagQuiet } from "@/components/ui";
import { CoordinatorHomeView } from "@/components/volunteers/coordinator-home";
import { ShareKit } from "@/components/volunteers/share-kit";
import { shortDate } from "@/lib/format";
import { KIND_WORDS, placesWords } from "@/lib/volunteers-wording";
import { canPostVolunteerTasks, canSeeVisitingList } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { getCoordinatorHome, type CoordinatorHome } from "@/server/volunteers/home";
import { findBoardLink, listAskAgain, listVolunteerTasks, type PastHelper, type SheetSummary, type TaskSection, type TaskSummary } from "@/server/volunteers/organiser";
import { LoadNotice } from "@/components/load-notice";
import { appOriginOrNull, soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Volunteers · CRC Care" };

const origin = () => appOriginOrNull() ?? "";

function taskTag(t: TaskSummary) {
  if (t.status === "cancelled") return <span className={tagQuiet}>Cancelled</span>;
  if (t.status === "done") return <span className={tagQuiet}>Done</span>;
  if (t.section === "finished") return <span className={tagQuiet}>Passed</span>;
  if (t.taken === 0) return <span className={tagNew}>Nobody yet</span>;
  return t.placesLeft === 0 ? <span className={tagQuiet}>Filled</span> : <span className={tagQuiet}>{placesWords(t.placesLeft)}</span>;
}

function Row({ href, title, date, tag, line }: { href: string; title: string; date: string | null; tag: React.ReactNode; line: string }) {
  return (
    <li>
      <Link href={href} className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-tint focus-visible:-outline-offset-3" data-testid="volunteer-row">
        <span className={`${nameClass} min-w-0 break-words underline decoration-control underline-offset-4`}>{title}</span>
        <span className="flex flex-wrap items-center gap-2 text-sm">{tag}</span>
        <span className="w-full text-base text-rubric">
          {date ? `${shortDate(date)} · ` : ""}
          {line}
        </span>
      </Link>
    </li>
  );
}

function Group({ title, section, tasks, sheets }: { title: string; section: TaskSection; tasks: TaskSummary[]; sheets: SheetSummary[] }) {
  const ts = tasks.filter((t) => t.section === section);
  const ss = sheets.filter((s) => s.section === section);
  if (ts.length + ss.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface">
        {ss.map((s) => (
          <Row
            key={s.groupId}
            href={`/volunteers/sheets/${s.groupId}`}
            title={`Shiva for ${s.title}`}
            date={s.nextDate}
            tag={s.section === "finished" ? <span className={tagQuiet}>Passed</span> : <span className={tagQuiet}>Shiva sheet</span>}
            line={`${s.evenings === 1 ? "1 evening" : `${s.evenings} evenings`}, ${s.evenFilled} with a minyan`}
          />
        ))}
        {ts.map((t) => (
          <Row key={t.id} href={`/volunteers/${t.id}`} title={`${KIND_WORDS[t.kind]} for ${t.forLabel}`} date={t.date} tag={taskTag(t)} line={`${t.taken} of ${t.peopleNeeded} taken${t.mine ? "" : ", posted by a colleague"}`} />
        ))}
      </ul>
    </Section>
  );
}

function AskAgain({ helpers }: { helpers: PastHelper[] }) {
  if (helpers.length === 0) return null;
  return (
    <Section title="Past helpers who said ask me again">
      <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="ask-again">
        {helpers.map((h) => (
          <li key={h.contact} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
            <span className="min-w-0 break-words text-base">
              <span className="font-semibold">{[h.firstName, h.lastName].filter(Boolean).join(" ")}</span>
              <span className="block text-sm text-rubric">{h.contact}</span>
            </span>
            <CopyButton text={h.contact} label="Copy contact" />
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default async function VolunteersPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canPostVolunteerTasks(actor)) {
    return (
      <AppShell actor={actor} title="Volunteers">
        <p className={noticeClass}>You do not have access to Volunteers. If a family could use volunteers, send a report and a member of the clergy will see it.</p>
      </AppShell>
    );
  }
  const db = getDb();
  const [data, helpers, board, home] = await soft<[Awaited<ReturnType<typeof listVolunteerTasks>> | null, PastHelper[], { token: string } | null, CoordinatorHome | null]>("Volunteers: list unavailable", [null, [], null, null], () => Promise.all([listVolunteerTasks(db, actor), listAskAgain(db, actor), findBoardLink(db, actor), getCoordinatorHome(db, actor)]));
  const boardUrl = board ? `${origin()}/v/b/${board.token}` : null;
  return (
    <AppShell actor={actor} title="Volunteers">
      <p className="mb-5 flex flex-wrap gap-2">
        <Link href="/volunteers/new" className={btnPrimary}>
          Post a task
        </Link>
        <Link href="/volunteers/sheets/new" className={btnQuiet}>
          Post a shiva sheet
        </Link>
        <Link href="/volunteers/roster" className={btnQuiet}>
          The roster
        </Link>
        {canSeeVisitingList(actor) ? (
          <Link href="/volunteers/visiting" className={btnQuiet}>
            Visiting list
          </Link>
        ) : null}
      </p>
      {home ? <CoordinatorHomeView home={home} canComplete={actor.role === "lead"} /> : null}
      {data === null ? <LoadNotice what="Volunteers" /> : null}
      {data && data.tasks.length + data.sheets.length === 0 ? <p className="text-rubric">Nothing posted yet. Post a task when someone could use a hand.</p> : null}
      {data ? (
        <>
          <h2 className="mb-1 mt-2 font-serif text-xl font-bold">All volunteer tasks</h2>
          <Group title="Needs people" section="needs_people" tasks={data.tasks} sheets={data.sheets} />
          <Group title="Filled" section="filled" tasks={data.tasks} sheets={data.sheets} />
          <Group title="Done and past" section="finished" tasks={data.tasks} sheets={data.sheets} />
        </>
      ) : null}
      <Section title="One link for all your open tasks">
        <p className="mt-2 text-base">A single page listing your open tasks, to send to the Mitzvah Corps list or a group text. It shows only what each task is for, when, and the places left.</p>
        <div className="mt-3">
          {boardUrl ? (
            <div className="flex flex-col gap-3">
              <ShareKit url={boardUrl} name="your board link" flyerHref="/volunteers/board/flyer" />
              <div>
                <ConfirmAction action={replaceBoardLinkAction} fields={{}} label="Make a new board link" title="Make a new board link?" explain="You get a new link and the old one stops working at once. Anyone who has the old one will see it is no longer open. Your tasks keep their own links." confirmLabel="Make a new link" />
              </div>
            </div>
          ) : (
            <ActionButton action={makeBoardLinkAction} fields={{}} label="Make my board link" className={btnQuiet} formClassName="flex flex-wrap items-center gap-2" />
          )}
        </div>
      </Section>
      <AskAgain helpers={helpers} />
    </AppShell>
  );
}
