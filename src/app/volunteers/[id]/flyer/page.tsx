import { notFound } from "next/navigation";
import { Flyer } from "@/components/flyer/flyer";
import { noticeClass } from "@/components/ui";
import { taskHeading, whenWords } from "@/components/volunteers/parts";
import { AccessDenied } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { NotFound } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import { taskFlyerUrl } from "@/server/volunteers/flyer";
import { getVolunteerTask } from "@/server/volunteers/organiser";
import { appOriginOrNull } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Flyer · CRC Care" };

/** A page to print for one task: what is needed and when, as the public page shows it before a claim. Never the place or the contact line. */
export default async function VolunteerTaskFlyerPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  const { id } = await params;
  let task;
  try {
    task = await getVolunteerTask(getDb(), actor, id);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    if (error instanceof AccessDenied) return <p className={`${noticeClass} m-4`}>You do not have access to Volunteers.</p>;
    throw error;
  }
  // Without the app's address the flyer cannot carry a whole link.
  const origin = appOriginOrNull() ?? "";
  const heading = taskHeading(task.kind, task.forLabel);
  return (
    <Flyer
      backHref={`/volunteers/${id}`}
      backLabel="Back to the task"
      heading={heading}
      invitation={task.needed}
      details={[whenWords(task.date, task.timeWindow)]}
      url={taskFlyerUrl(task, origin)}
      qrLabel={`QR code to sign up for ${heading}`}
      noLinkMessage="This task has no link to print: it is no longer open."
    />
  );
}
