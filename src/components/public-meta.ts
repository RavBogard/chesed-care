import type { Metadata } from "next";
import { CONGREGATION } from "@/server/meals/core";

/**
 * The tab and link-preview title of a public (no account) page, and nothing else: no
 * description (the signed-in app's own is cleared), no image, no address, no reason.
 * Never indexed, and the referrer is withheld so a secret link does not travel on a click.
 */
export function publicMetadata(title: string): Metadata {
  const shown = `${title} · ${CONGREGATION}`;
  return {
    title: shown,
    description: null,
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
    openGraph: { title: shown, siteName: CONGREGATION, type: "website", description: undefined },
    twitter: { card: "summary", title: shown },
    appleWebApp: undefined,
  };
}
