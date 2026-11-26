import { notFound } from "next/navigation";
import { StopBody, stopMetadata } from "@/components/roster/stop-page";
import { getDb } from "@/server/db/client";
import { stopLinkWorks } from "@/server/volunteers/join";

export const dynamic = "force-dynamic";
export const metadata = stopMetadata;

/**
 * Opening the link only shows a button: a mail program that scans links changes nothing. Pressing it (a POST) stops
 * the asks. A link that matches nothing is any other missing page.
 */
export default async function StopPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await stopLinkWorks(getDb(), token))) notFound();
  return <StopBody token={token} />;
}
