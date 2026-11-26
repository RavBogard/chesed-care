import { cache } from "react";
import { listInbox } from "@/server/care/proposals";
import type { Actor } from "@/server/access/policy";
import { getDb } from "@/server/db/client";

/** One count per request, however many times the menu and the side rail ask. */
const pendingFor = cache(async (actor: Actor): Promise<number> => {
  try {
    return (await listInbox(getDb(), actor)).length;
  } catch {
    return 0;
  }
});

/** The number of proposals waiting for this reader, beside "Inbox" in the menu. Nothing when there are none. */
export async function InboxCount({ actor }: { actor: Actor }) {
  const n = await pendingFor(actor);
  if (n === 0) return null;
  return (
    <span className="ml-auto rounded-sm bg-selected px-2 py-0.5 text-sm font-bold tabular-nums text-action" data-testid="inbox-count">
      {n}
      <span className="sr-only"> waiting</span>
    </span>
  );
}
