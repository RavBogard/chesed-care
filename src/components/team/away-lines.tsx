import { AWAY_WORDS } from "@/lib/clergy-wording";
import type { Actor } from "@/server/access/policy";
import { getDb } from "@/server/db/client";
import { awayLine, awayLines, getCovering, type Covering } from "@/server/team/away";
import type { TeamChoice } from "../care-fields";
import { FollowUpRow } from "../follow-up-row";
import { Group } from "../today-dates";
import { noticeClass } from "../ui";

/** The away lines for a screen ("Name is away until Friday. Other is covering."). Clergy level only; a failure shows nothing. */
export async function loadAwayLines(actor: Actor, today: string): Promise<string[]> {
  try {
    return (await awayLines(getDb(), actor, today)).map((a) => awayLine(a, today));
  } catch {
    return [];
  }
}

/** Who this person is covering today, and their follow-ups due in the window that this person can already see. */
export async function loadCovering(actor: Actor, today: string): Promise<Covering[]> {
  try {
    return await getCovering(getDb(), actor, today);
  } catch {
    return [];
  }
}

export function AwayLines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="mb-5 flex flex-col gap-2" aria-label="Away" data-testid="away-lines">
      {lines.map((l) => (
        <li key={l} className={`${noticeClass} bg-tint text-ink`}>
          {l}
        </li>
      ))}
    </ul>
  );
}

/** "Covering for X" on Today. */
export function CoveringSection({ covering, actor, today, holders }: { covering: Covering[]; actor: Actor; today: string; holders: TeamChoice[] }) {
  return (
    <>
      {covering.map((c) => (
        <div key={c.away.userId} data-testid="covering-section">
          <Group title={AWAY_WORDS.coveringFor(c.away.name)}>
            {c.followUps.length === 0 ? (
              <p className="mt-2 text-sm text-rubric">{AWAY_WORDS.coveringNone}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-3">
                {c.followUps.map((f) => (
                  <FollowUpRow key={f.id} followUp={f} today={today} ownerName={c.away.name} canEdit holders={holders} actorId={actor.id} />
                ))}
              </ul>
            )}
          </Group>
        </div>
      ))}
    </>
  );
}
