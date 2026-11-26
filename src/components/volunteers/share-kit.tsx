import { ShareKit as SharedKit } from "@/components/share-kit";
import { SHARE_SUBJECT, shareBody } from "@/lib/volunteers-wording";

/** The shared kit with the volunteers' words: the link and nothing about a person. */
export function ShareKit({ url, name, flyerHref }: { url: string; name: string; flyerHref?: string }) {
  const body = shareBody(url);
  return <SharedKit url={url} shareTitle={SHARE_SUBJECT} text={body} message={body} shareLabel={`Share ${name}`} emailSubject={SHARE_SUBJECT} flyerHref={flyerHref} />;
}
