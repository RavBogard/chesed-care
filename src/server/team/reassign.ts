/** Reassigning one follow-up through the ordinary path (updateFollowUp, so the same policy), with an audit row (ids only). */
import type { Actor } from "@/server/access/policy";
import { writeAudit } from "@/server/care/audit";
import { updateFollowUp, type FollowUp } from "@/server/care/follow-ups";
import { uuidField } from "@/server/care/validate";
import type { Db } from "@/server/db/types";

export async function reassignFollowUp(db: Db, actor: Actor, id: unknown, toUserId: unknown): Promise<FollowUp> {
  const row = await updateFollowUp(db, actor, id, { ownerUserId: uuidField(toUserId, "ownerUserId") });
  await writeAudit(db, actor, "follow_up.reassign", "follow_up", row.id, { careItemId: row.careItemId, ownerUserId: row.ownerUserId ?? undefined });
  return row;
}
