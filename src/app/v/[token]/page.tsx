import { notFound } from "next/navigation";
import { PageSection, PublicFrame } from "@/components/meals/parts";
import { ClaimForm } from "@/components/volunteers/claim-form";
import { Facts, taskHeading, whenWords } from "@/components/volunteers/parts";
import { publicMetadata } from "@/components/public-meta";
import { placesWords, PREVIEW_TITLE, refusalMessage, towardTen } from "@/lib/volunteers-wording";
import { getDb } from "@/server/db/client";
import { signRenderStamp } from "@/server/meals/client-meta";
import { getPublicTask } from "@/server/volunteers/public";

export const dynamic = "force-dynamic";
export const metadata = publicMetadata(PREVIEW_TITLE);

/**
 * One task for a volunteer with no account. Everything on it passed the allow-list in
 * server/volunteers/public.ts: no place and no contact line until someone has signed up.
 */
export default async function PublicTaskPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const task = await getPublicTask(getDb(), token);
  if (!task) notFound();
  const minyan = task.kind === "shiva_minyan";
  const facts = [
    { term: "When", text: whenWords(task.date, task.timeWindow) },
    { term: minyan ? "Toward ten" : "People", text: minyan ? towardTen(task.taken, task.peopleNeeded) : task.peopleNeeded === 1 ? "1 person" : `${task.peopleNeeded} people` },
    { term: "Where", text: "Given to you when you sign up." },
  ];
  return (
    <PublicFrame congregation={task.congregation} title={taskHeading(task.kind, task.forLabel)}>
      <p className="mt-3 max-w-prose whitespace-pre-line text-lg">{task.needed}</p>
      <Facts rows={facts} />
      <PageSection id="sign-up" heading="Sign up">
        {task.past ? (
          <p className="text-base" data-testid="past">
            {refusalMessage("past")}
          </p>
        ) : task.placesLeft === 0 ? (
          <p className="font-serif text-xl font-bold" data-testid="full">
            {refusalMessage("full")}
          </p>
        ) : (
          <>
            <p className="mb-4 text-base font-semibold text-action" data-testid="places-left">
              {placesWords(task.placesLeft)}
            </p>
            <ClaimForm token={token} stamp={signRenderStamp(token, new Date())} what={taskHeading(task.kind, task.forLabel)} everyTime={task.everyTimeDates} />
          </>
        )}
      </PageSection>
    </PublicFrame>
  );
}
