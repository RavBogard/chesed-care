import Link from "next/link";
import { Section } from "@/components/section";
import { AppShell } from "@/components/shell/app-shell";
import { btnPrimary, nameClass, noticeClass, tagNew, tagQuiet } from "@/components/ui";
import { monthDay } from "@/lib/format";
import { canManageMealPages } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { listMealPages, type MealPageSummary } from "@/server/meals/pages";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mitzvah Meals · CRC Care" };

const STATUS = { draft: "Draft", live: "Live", paused: "Paused", ended: "Ended" } as const;

function coverage(p: MealPageSummary): string {
  if (p.status === "ended") return "Ended";
  if (p.status === "draft") return "Not yet live";
  if (p.openDates === 0) return p.coveredThrough ? `Covered through ${monthDay(p.coveredThrough)}` : "No nights left";
  const open = p.openDates === 1 ? "1 open night" : `${p.openDates} open nights`;
  return p.nextOpenDate ? `${open}, the next on ${monthDay(p.nextOpenDate)}` : open;
}

function Row({ p }: { p: MealPageSummary }) {
  return (
    <li>
      <Link href={`/meals/${p.id}`} className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-tint focus-visible:-outline-offset-3" data-testid="meals-row">
        <span className={`${nameClass} min-w-0 break-words underline decoration-control underline-offset-4`}>{p.title}</span>
        <span className="flex flex-wrap items-center gap-2 text-sm">
          {p.needsCall ? <span className={tagNew}>{p.needsCall === 1 ? "1 helper to call" : `${p.needsCall} helpers to call`}</span> : null}
          <span className={tagQuiet}>{STATUS[p.status]}</span>
        </span>
        <span className="w-full text-base text-rubric">{coverage(p)}</span>
      </Link>
    </li>
  );
}

function Group({ title, pages }: { title: string; pages: MealPageSummary[] }) {
  if (pages.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface">
        {pages.map((p) => (
          <Row key={p.id} p={p} />
        ))}
      </ul>
    </Section>
  );
}

export default async function MealsPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canManageMealPages(actor)) {
    return (
      <AppShell actor={actor} title="Mitzvah Meals">
        <p className={noticeClass}>You do not have access to Mitzvah Meals. If you would like a page for a family, send a report and a member of the clergy will see it.</p>
      </AppShell>
    );
  }
  const pages: MealPageSummary[] | null = await soft("Meals: list unavailable", null, () => listMealPages(getDb(), actor));
  return (
    <AppShell actor={actor} title="Mitzvah Meals">
      <p className="mb-5">
        <Link href="/meals/new" className={btnPrimary}>
          Start a page
        </Link>
      </p>
      {pages === null ? <LoadNotice what="The pages" /> : null}
      {pages?.length === 0 ? <p className="text-rubric">No pages yet. Start one when a family could use meals.</p> : null}
      {pages ? (
        <>
          <Group title="Live and paused" pages={pages.filter((p) => p.status === "live" || p.status === "paused")} />
          <Group title="Drafts" pages={pages.filter((p) => p.status === "draft")} />
          <Group title="Ended" pages={pages.filter((p) => p.status === "ended")} />
        </>
      ) : null}
    </AppShell>
  );
}
