import { CopyButton } from "@/components/copy-button";
import { ShareKit as SharedKit } from "@/components/share-kit";

/**
 * Everything the organiser needs to send the page out: the shared kit (nothing is sent
 * from here), plus the family's private link.
 */
export function ShareKit({ title, publicUrl, familyUrl, flyerHref }: { title: string; publicUrl: string; familyUrl: string | null; flyerHref: string }) {
  const text = `Mitzvah Meals for ${title}. Please sign up to bring a meal:`;
  return (
    <SharedKit url={publicUrl} shareTitle={`Mitzvah Meals for ${title}`} text={text} message={`${text} ${publicUrl}`} flyerHref={flyerHref} className="flex flex-col gap-4">
      {familyUrl ? (
        <div>
          <p className="mb-1 text-sm font-semibold">The family&rsquo;s own link</p>
          <p className="mb-2 text-sm text-rubric">Send this only to the family. It lets them see who is coming, change food needs, pause or end the page.</p>
          <CopyButton text={familyUrl} label="Copy the family link" />
        </div>
      ) : null}
    </SharedKit>
  );
}
