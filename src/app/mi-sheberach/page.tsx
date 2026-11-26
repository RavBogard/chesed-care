import Link from "next/link";
import { Section } from "@/components/section";
import { AppShell } from "@/components/shell/app-shell";
import { CurrentRow, EndedRow } from "@/components/misheberach/entry-list";
import { ApplyAnyway, ImportCurrent, SyncNow } from "@/components/misheberach/entry-forms";
import { LeftAloneNotice, PlanView } from "@/components/misheberach/plan-view";
import { btnPrimary, btnQuiet, btnText, noticeClass } from "@/components/ui";
import { instantDate } from "@/lib/format";
import { DRY_RUN_NOTE, LAST_CHECKED, MI_NAME, NOT_CONNECTED, SHARE_WITH, syncProblem } from "@/lib/misheberach-wording";
import { canManageMiSheberach, canSeeMiSheberachSync } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getDb } from "@/server/db/client";
import { packetConfig, serviceAccountEmail, syncMode } from "@/server/misheberach/google";
import { listEntries, type ListView } from "@/server/misheberach/list";
import { getSyncStatus, type SyncStatus } from "@/server/misheberach/sync";
import { LoadNotice } from "@/components/load-notice";
import { soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mi Sheberach · CRC Care" };

export default async function MiSheberachPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canManageMiSheberach(actor)) {
    return (
      <AppShell actor={actor} title={MI_NAME}>
        <p className={noticeClass}>The Mi Sheberach list is kept by the clergy. If someone should be on it, send a report and a member of the clergy will see it.</p>
      </AppShell>
    );
  }
  const db = getDb();
  const mode = syncMode();
  const connected = packetConfig() !== null;
  const [view, status] = await soft<[ListView | null, SyncStatus | null]>("Mi Sheberach: list unavailable", [null, null], () => Promise.all([listEntries(db, actor), getSyncStatus(db, actor, mode)]));
  const address = canSeeMiSheberachSync(actor) ? serviceAccountEmail() : null;
  return (
    <AppShell actor={actor} title={MI_NAME}>
      <p className="mb-5 flex flex-wrap gap-2">
        <Link href="/mi-sheberach/new" className={btnPrimary}>
          Add a name
        </Link>
        <Link href="/mi-sheberach/read" className={btnQuiet}>
          Read-aloud view
        </Link>
      </p>
      {view === null ? <LoadNotice what="The list" /> : null}
      {!connected ? (
        <div className={`${noticeClass} mb-5`} data-testid="mi-not-connected">
          <p>{NOT_CONNECTED}</p>
          {address ? (
            <p className="mt-2">
              {SHARE_WITH} <span className="font-semibold [overflow-wrap:anywhere]">{address}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {connected && mode === "dry-run" ? (
        <p className={`${noticeClass} mb-5`} data-testid="mi-dry-run">
          {DRY_RUN_NOTE}
        </p>
      ) : null}
      {connected && status && status.ok === false ? (
        <div className={`${noticeClass} mb-5 flex flex-col items-start gap-3`} data-testid="mi-sync-problem">
          <p>{syncProblem(status.errorName, status.counts)}</p>
          {status.errorName === "PacketChangeTooLarge" ? <ApplyAnyway /> : null}
        </div>
      ) : null}
      {connected && status?.plan && status.plan.leftAlone.length > 0 ? <LeftAloneNotice plan={status.plan} counts={status.counts} canRemove={mode === "on"} /> : null}
      {view ? (
        <>
          <Section title={`On the list (${view.current.length})`} empty="No names on the list. Add a name when someone asks.">
            {view.current.length > 0 ? (
              <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="mi-list">
                {view.current.map((e) => (
                  <CurrentRow key={e.id} e={e} />
                ))}
              </ul>
            ) : undefined}
          </Section>
          {view.ended.length > 0 ? (
            <details className="mt-7">
              <summary className={`${btnText} cursor-pointer`}>Ended in the last 12 months ({view.ended.length})</summary>
              <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="mi-ended">
                {view.ended.map((e) => (
                  <EndedRow key={e.id} e={e} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
      {connected ? (
        <Section title="The bima packet">
          <p className="mt-2 text-base text-rubric">
            {status?.lastOkAt ? `Last synced ${instantDate(status.lastOkAt)}.` : "Not synced yet."}{status?.lastCheckedAt ? ` ${LAST_CHECKED} ${instantDate(status.lastCheckedAt)}.` : ""}{mode === "on" ? " It also syncs each morning." : ""}
          </p>
          <div className="mt-3 flex flex-wrap items-start gap-2">
            <SyncNow />
            {mode === "dry-run" && status?.canImport ? <ImportCurrent /> : null}
          </div>
        </Section>
      ) : null}
      {connected && status?.plan && (mode === "dry-run" || status.ok === false) ? <PlanView plan={status.plan} /> : null}
    </AppShell>
  );
}
