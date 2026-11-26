import { instantDate } from "@/lib/format";
import { tagNew, tagQuiet } from "@/components/ui";
import { FLAG_WORDS } from "@/lib/volunteers-wording";
import type { ClaimView } from "@/server/volunteers/organiser";
import { RemoveClaim } from "./claim-rows";

const fullName = (c: ClaimView) => [c.firstName, c.lastName].filter(Boolean).join(" ") || "A volunteer";

function status(c: ClaimView): string | null {
  if (c.cancelledBy === "poster") return "Removed by you";
  if (c.cancelledAt) return "Gave the place back";
  if (c.doneAt) return "Done";
  return null;
}

/** Only THAT a volunteer sent something to the rabbis, and when: what they wrote went to the clergy Inbox alone. */
function FlagMarker({ claims }: { claims: ClaimView[] }) {
  const last = claims.reduce<Date | null>((at, c) => (c.flaggedAt && (!at || c.flaggedAt > at) ? c.flaggedAt : at), null);
  if (!last) return null;
  return (
    <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-rubric" data-testid="flag-marker">
      <span className={tagNew}>{FLAG_WORDS.marker}</span>
      <span>{instantDate(last)}</span>
    </p>
  );
}

/** Who has claimed, with their contact and note, and a way to remove a place that still stands. */
export function ClaimList({ claims, editable }: { claims: ClaimView[]; editable: boolean }) {
  if (claims.length === 0) return <p className="mt-2 text-base text-rubric">Nobody has signed up yet.</p>;
  return (
    <>
      <FlagMarker claims={claims} />
      <ul className="mt-2 divide-y divide-rule-soft overflow-hidden rounded-md border border-rule bg-surface" data-testid="claims">
        {claims.map((c) => {
          const s = status(c);
          const standing = !c.cancelledAt;
          return (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3" data-testid="claim">
              <div className="min-w-0 break-words">
                <p className="text-base font-semibold">{c.forgotten ? "Details deleted" : fullName(c)}</p>
                {c.contact ? <p className="text-base">{c.contact}</p> : null}
                {c.note ? <p className="text-sm text-rubric">Note: {c.note}</p> : null}
                {c.doneNote ? <p className="text-sm text-rubric">Back to you: {c.doneNote}</p> : null}
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-rubric">
                  <span>{instantDate(c.createdAt)}</span>
                  {c.mayAskAgain && !c.cancelledAt ? <span className={tagQuiet}>You may ask again</span> : null}
                  {s ? <span className={tagQuiet}>{s}</span> : null}
                </p>
              </div>
              {editable && standing && !c.doneAt ? <RemoveClaim claimId={c.id} name={fullName(c)} everyTime={c.everyTime} /> : null}
            </li>
          );
        })}
      </ul>
    </>
  );
}
