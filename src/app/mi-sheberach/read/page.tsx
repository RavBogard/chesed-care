import Link from "next/link";
import { PrintButton } from "@/components/print-button";
import { btnQuiet, noticeClass } from "@/components/ui";
import { MI_PATH, READ_EMPTY, READ_HEADING, READ_HINT } from "@/lib/misheberach-wording";
import { canManageMiSheberach } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { listEntries, type EntryView } from "@/server/misheberach/list";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Read aloud · CRC Care" };

const HEBREW = /\p{Script=Hebrew}/u;

/**
 * The names alone, in the order they are read, in large type for a tablet on the bima or a page
 * of paper. Each name sets itself right to left when it begins with Hebrew (dir="auto"); the
 * controls are not printed. No shell: nothing but the names.
 */
export default async function ReadAloudPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canManageMiSheberach(actor)) {
    return (
      <main id="main" className="mx-auto max-w-xl px-4 py-8">
        <p className={noticeClass}>The Mi Sheberach list is kept by the clergy.</p>
      </main>
    );
  }
  const current: EntryView[] | null = await soft("Mi Sheberach: read view unavailable", null, async () => (await listEntries(getDb(), actor)).current);
  return (
    <main id="main" className="mx-auto min-h-dvh max-w-3xl bg-surface px-6 py-8 text-ink print:max-w-none print:p-0">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={MI_PATH} className={btnQuiet}>
          Back to the list
        </Link>
        <PrintButton hideOnPaper />
      </div>
      <h1 className="font-serif text-3xl font-bold leading-tight sm:text-4xl print:text-[26pt]">{READ_HEADING}</h1>
      <p className="mt-1 text-base text-rubric print:hidden">{READ_HINT}</p>
      {current === null ? <LoadNotice what="The list" className="mt-6" /> : null}
      {current && current.length === 0 ? <p className="mt-6 text-xl text-rubric">{READ_EMPTY}</p> : null}
      {current && current.length > 0 ? (
        <ol className="mt-6 flex flex-col gap-5 print:gap-4" data-testid="mi-read">
          {current.map((e) => (
            <li key={e.id} lang={HEBREW.test(e.name) ? "he" : undefined} dir="auto" className="break-words text-start font-serif text-4xl font-semibold leading-snug sm:text-5xl print:break-inside-avoid print:text-[28pt]" data-testid="mi-read-name">
              {e.name}
            </li>
          ))}
        </ol>
      ) : null}
    </main>
  );
}
