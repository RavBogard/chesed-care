import { publicMetadata } from "@/components/public-meta";
import { PublicNotFound } from "@/components/public-not-found";
import { PREVIEW_TITLE, refusalMessage } from "@/lib/volunteers-wording";

export const metadata = publicMetadata(PREVIEW_TITLE);

/** An unknown, mistyped, expired, cancelled or purged link: one kind sentence, and nothing about whether a task ever existed. */
export default function VolunteersNotFound() {
  return <PublicNotFound title={PREVIEW_TITLE} message={refusalMessage("not_found")} />;
}
