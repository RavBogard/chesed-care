import Link from "next/link";
import { redirect } from "next/navigation";
import { FindForm } from "@/components/find-form";
import { FindNotesForm } from "@/components/find-notes-form";
import { AppShell } from "@/components/shell/app-shell";
import { btnQuiet, btnSelected } from "@/components/ui";
import { FIND_WORDS } from "@/lib/clergy-wording";
import { canSearchNotes, canSeeLifecycle } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Find a person · CRC Care" };

/** The search itself runs as a server action (see FindForm), so no name is ever in this page's URL. The second mode, "In notes", works the same way. */
export default async function FindPage({ searchParams }: { searchParams: Promise<{ for?: string; mode?: string }> }) {
  const actor = actorOrRedirect(await getViewer());
  if (!canSeeLifecycle(actor)) redirect("/care");
  const { for: purpose, mode } = await searchParams;
  const notes = mode === "notes" && canSearchNotes(actor);
  return (
    <AppShell actor={actor} title="Find a person">
      {canSearchNotes(actor) ? (
        <nav aria-label="What to search" className="mb-4 flex flex-wrap gap-2" data-testid="find-modes">
          <Link href="/find" aria-current={notes ? undefined : "true"} className={notes ? btnQuiet : btnSelected}>
            {FIND_WORDS.people}
          </Link>
          <Link href="/find?mode=notes" aria-current={notes ? "true" : undefined} className={notes ? btnSelected : btnQuiet}>
            {FIND_WORDS.notes}
          </Link>
        </nav>
      ) : null}
      {notes ? <FindNotesForm /> : <FindForm purpose={typeof purpose === "string" ? purpose : undefined} />}
    </AppShell>
  );
}
