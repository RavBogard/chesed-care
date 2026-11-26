import type { Metadata } from "next";
import { PublicFrame } from "@/components/meals/parts";
import { publicMetadata } from "@/components/public-meta";
import { StopForm } from "@/components/roster/stop-form";
import { STOP_EXPLAIN, STOP_HEADING } from "@/lib/roster-wording";
import { CONGREGATION } from "@/server/meals/core";

export const stopMetadata: Metadata = publicMetadata(STOP_HEADING);

/** What both stop links show (the plain token and the signed one in the app's emails): one sentence and the button, which is a POST. */
export function StopBody({ token }: { token: string }) {
  return (
    <PublicFrame congregation={CONGREGATION} title={STOP_HEADING}>
      <p className="mt-3 max-w-prose text-lg">{STOP_EXPLAIN}</p>
      <StopForm token={token} />
    </PublicFrame>
  );
}
