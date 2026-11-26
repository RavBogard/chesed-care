import type { Metadata } from "next";
import { PublicFrame } from "@/components/meals/parts";
import { JoinForm } from "@/components/roster/join-form";
import { JOIN_INTRO, JOIN_NAME } from "@/lib/roster-wording";
import { signRenderStamp } from "@/server/meals/client-meta";
import { CONGREGATION } from "@/server/meals/core";
import { JOIN_STAMP_SCOPE } from "./scope";

export const dynamic = "force-dynamic";

/** The tab title and nothing else: never indexed, no preview, the referrer withheld. */
export const metadata: Metadata = {
  title: `${JOIN_NAME} · ${CONGREGATION}`,
  description: null,
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
  openGraph: { title: `${JOIN_NAME} · ${CONGREGATION}`, siteName: CONGREGATION, type: "website", description: undefined },
  twitter: { card: "summary", title: `${JOIN_NAME} · ${CONGREGATION}` },
  appleWebApp: undefined,
};

/** The public sign-up: no account, no shell, one screen. It only ever adds a person to the roster, and says the same to everyone. */
export default function JoinPage() {
  return (
    <PublicFrame congregation={CONGREGATION} title={JOIN_NAME}>
      <p className="mt-3 max-w-prose text-lg">{JOIN_INTRO}</p>
      <JoinForm stamp={signRenderStamp(JOIN_STAMP_SCOPE, new Date())} />
    </PublicFrame>
  );
}
