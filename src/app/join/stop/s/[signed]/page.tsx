import { notFound } from "next/navigation";
import { StopBody, stopMetadata } from "@/components/roster/stop-page";
import { getDb } from "@/server/db/client";
import { stopLinkWorks } from "@/server/volunteers/join";

export const dynamic = "force-dynamic";
export const metadata = stopMetadata;

/**
 * The signed stop link in the emails the app sends to the roster. Like /join/stop/[token], opening it only shows the
 * button; pressing it (a POST) stops the asks. A link whose signature does not match is any other missing page.
 */
export default async function SignedStopPage({ params }: { params: Promise<{ signed: string }> }) {
  const { signed } = await params;
  if (!(await stopLinkWorks(getDb(), signed))) notFound();
  return <StopBody token={signed} />;
}
