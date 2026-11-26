import type { Metadata } from "next";
import { PublicFrame } from "@/components/meals/parts";
import { TellForm } from "@/components/tell/tell-form";
import { TELL_INTRO, TELL_NAME } from "@/lib/tell-wording";
import { signRenderStamp } from "@/server/meals/client-meta";
import { CONGREGATION } from "@/server/meals/core";
import { TELL_STAMP_SCOPE } from "./scope";

export const dynamic = "force-dynamic";

/** The tab title and nothing else: never indexed, no preview, the referrer withheld. */
export const metadata: Metadata = {
  title: `${TELL_NAME} · ${CONGREGATION}`,
  description: null,
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
  openGraph: { title: `${TELL_NAME} · ${CONGREGATION}`, siteName: CONGREGATION, type: "website", description: undefined },
  twitter: { card: "summary", title: `${TELL_NAME} · ${CONGREGATION}` },
  appleWebApp: undefined,
};

/** The public form: no account, no shell, no search of people, one screen. It only ever sends a message to the clergy. */
export default function TellPage() {
  return (
    <PublicFrame congregation={CONGREGATION} title={TELL_NAME}>
      <p className="mt-3 max-w-prose text-lg">{TELL_INTRO}</p>
      <TellForm stamp={signRenderStamp(TELL_STAMP_SCOPE, new Date())} />
    </PublicFrame>
  );
}
