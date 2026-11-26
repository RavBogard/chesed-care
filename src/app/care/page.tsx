import Link from "next/link";
import { AppShell } from "@/components/shell/app-shell";
import { Chip } from "@/components/chip";
import { LockIcon } from "@/components/lock-icon";
import { btnPrimary, cardClass, nameLink, rubric, tagNew, tagQuiet, tagRestricted, titleClass } from "@/components/ui";
import { CATEGORY_LABEL, personPath, statusLabel } from "@/lib/care-labels";
import { monthDay } from "@/lib/format";
import { canManageCareItems } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { CARE_CATEGORIES, listCareBoard, parseCareBoardFilter, type CareBoardFilter, type CareBoardRow } from "@/server/care/boards";
import { listCareItemStubs, type CareItemStub } from "@/server/care/care-items";
import { getDb } from "@/server/db/client";
import { chicagoToday } from "@/server/lifecycle/window";
import { LoadNotice } from "@/components/load-notice";
import { logFailure } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Care list · CRC Care" };


const filterLabel = `${rubric} mb-1.5`;

function href(filter: CareBoardFilter, change: Partial<{ scope: string; category: string | null; status: string }>): string {
  const next = { ...filter, ...change };
  const q = new URLSearchParams();
  q.set("scope", next.scope);
  q.set("status", next.status);
  if (next.category) q.set("category", next.category);
  return `/care?${q.toString()}`;
}

export default async function CareListPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = actorOrRedirect(await getViewer());
  const filter = parseCareBoardFilter(await searchParams);

  const today = chicagoToday(new Date());
  let rows: CareBoardRow[] | null = null;
  let stubs: CareItemStub[] = [];
  try {
    rows = await listCareBoard(getDb(), actor, filter, today);
    // Restricted items in someone else's care are listed quietly at the end of the whole active list, never under a filter they cannot match.
    if (filter.status === "open" && filter.scope === "all" && filter.category === null) stubs = await listCareItemStubs(getDb(), actor);
  } catch (error) {
    logFailure("Care list unavailable", error);
  }

  return (
    <AppShell actor={actor} title="Care list">
      {/* A phone: the button across the top, the filters beneath. A laptop: the button on its own row at the right, the filters beneath at the full width so no chip is orphaned. */}
      <div className="mb-5 flex flex-col gap-5">
        {canManageCareItems(actor) ? (
          <Link href="/find?for=care" className={`${btnPrimary} w-full lg:w-auto lg:min-w-44 lg:self-end`}>
            Add to care list
          </Link>
        ) : null}

        <div className="flex min-w-0 flex-wrap gap-x-8 gap-y-4">
          <div>
            <p id="care-filter-whose" className={filterLabel}>
              Whose
            </p>
            <nav aria-labelledby="care-filter-whose" className="flex flex-wrap gap-2">
              <Chip to={href(filter, { scope: "mine" })} active={filter.scope === "mine"}>
                Mine
              </Chip>
              <Chip to={href(filter, { scope: "all" })} active={filter.scope === "all"}>
                All
              </Chip>
            </nav>
          </div>
          <div>
            <p id="care-filter-status" className={filterLabel}>
              Status
            </p>
            <nav aria-labelledby="care-filter-status" className="flex flex-wrap gap-2">
              <Chip to={href(filter, { status: "open" })} active={filter.status === "open"}>
                Active
              </Chip>
              <Chip to={href(filter, { status: "paused" })} active={filter.status === "paused"}>
                Paused
              </Chip>
              <Chip to={href(filter, { status: "closed" })} active={filter.status === "closed"}>
                Closed
              </Chip>
            </nav>
          </div>
          <div className="basis-full">
            <p id="care-filter-category" className={filterLabel}>
              Category
            </p>
            <nav aria-labelledby="care-filter-category" className="flex flex-wrap gap-2">
              <Chip to={href(filter, { category: null })} active={filter.category === null}>
                Any kind
              </Chip>
              {CARE_CATEGORIES.map((c) => (
                <Chip key={c} to={href(filter, { category: c })} active={filter.category === c}>
                  {CATEGORY_LABEL[c]}
                </Chip>
              ))}
            </nav>
          </div>
        </div>
      </div>

      {rows === null ? <LoadNotice what="The care list" /> : null}
      {rows && rows.length === 0 && stubs.length === 0 ? <p className="text-rubric">{filter.status === "open" ? "No one is on the care list with these filters." : filter.status === "paused" ? "Nothing is paused with these filters." : "Nothing closed with these filters."}</p> : null}
      {rows && (rows.length > 0 || stubs.length > 0) ? (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.id} className={`${cardClass} pt-2`} data-testid="care-row">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className={titleClass}>
                  <Link href={personPath(r)} className={nameLink}>
                    {r.displayName}
                  </Link>
                </p>
                {r.status === "new" ? (
                  <span className={tagNew} data-testid="new-tag">
                    New
                  </span>
                ) : null}
                {r.outsidePersonId ? <span className={tagQuiet}>Not in Salesforce</span> : null}
                {r.restricted ? (
                  <span className={tagRestricted}>
                    <LockIcon /> Restricted
                  </span>
                ) : null}
              </div>
              <p className="text-sm font-semibold text-ink">{CATEGORY_LABEL[r.category]}</p>
              <p className="text-sm text-rubric">
                {r.ownerName ? `With ${r.ownerName}` : "No owner"}
                {r.status === "closed" ? " · closed" : r.status === "paused" && filter.status === "paused" ? ` · ${statusLabel(r, today).toLowerCase()}` : r.nextFollowUp ? ` · next follow-up ${monthDay(r.nextFollowUp)}` : " · no follow-up set"}
              </p>
            </li>
          ))}
          {stubs.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-md border border-rule-soft px-4 py-3 text-base text-rubric" data-testid="restricted-stub">
              <LockIcon />
              <span>
                {s.displayName} · In {s.ownerName ?? "a colleague"}&rsquo;s care
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </AppShell>
  );
}
