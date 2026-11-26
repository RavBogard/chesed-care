import { Section } from "@/components/section";
import { shortDate } from "@/lib/format";
import { ASK_HEADING } from "@/lib/roster-wording";
import type { Actor } from "@/server/access/policy";
import type { Db } from "@/server/db/types";
import { listAskCandidates, type AskCandidate, type AskTarget } from "@/server/volunteers/roster";
import { AskRoster, type AskRow } from "./ask-roster";
import { LoadNotice } from "@/components/load-notice";
import { logFailure } from "@/server/soft";

/** The roster members who can be asked about this task or sheet, as rows for the picker (names and history only), or null when they could not be loaded. */
export async function loadAskRows(db: Db, actor: Actor, target: AskTarget): Promise<AskRow[] | null> {
  try {
    const candidates: AskCandidate[] = await listAskCandidates(db, actor, target);
    return candidates.map((c) => ({
      id: c.id,
      name: [c.firstName, c.lastName].filter(Boolean).join(" "),
      hasEmail: c.hasEmail,
      hasMobile: c.hasMobile,
      lastAsked: c.lastAsked ? shortDate(c.lastAsked.toISOString().slice(0, 10)) : null,
      lastHelped: c.lastHelpedOn,
      helpedLast12Months: c.helpedLast12Months,
      preferContact: c.preferContact,
      askedRecently: c.askedRecently,
    }));
  } catch (error) {
    logFailure("Roster: ask list unavailable", error);
    return null;
  }
}

/** "Ask the roster" on a task or shiva sheet, for those who see the roster. Contacts come only with the tap. */
export function AskRosterSection({ target, rows }: { target: AskTarget; rows: AskRow[] | null }) {
  return (
    <div id="ask-roster" className="scroll-mt-20">
      <Section title={ASK_HEADING}>
        <div className="mt-2">{rows === null ? <LoadNotice what="The roster" /> : <AskRoster target={target} rows={rows} />}</div>
      </Section>
    </div>
  );
}
