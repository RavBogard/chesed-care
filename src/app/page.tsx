import { Suspense } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { ContentSkeleton } from "@/components/skeleton";
import { TodayBody } from "@/components/today-body";
import { hebrewDate } from "@/lib/hebrew-date";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { chicagoToday } from "@/server/lifecycle/window";

export const metadata = { title: "Today · CRC Care" };
export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const actor = actorOrRedirect(await getViewer());
  return (
    <AppShell actor={actor} title="Today" facing={hebrewDate(chicagoToday(new Date()))}>
      <Suspense fallback={<ContentSkeleton />}>
        <TodayBody actor={actor} />
      </Suspense>
    </AppShell>
  );
}
