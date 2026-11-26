/** "Send me a test": one fixed notice to the actor's OWN devices, a few times an hour at most. */
import { canSetNotifications, deny, type Actor } from "@/server/access/policy";
import { TooMany } from "@/server/care/validate";
import type { Db } from "@/server/db/types";
import { withinLimit } from "@/server/meals/rate-limit";
import { pushStatus } from "./config";
import { sendPush } from "./send";

export const TESTS_PER_HOUR = 5;

export type TestResult = "sent" | "not_configured" | "no_device" | "failed";

export async function sendTestNotice(db: Db, actor: Actor, now: Date = new Date()): Promise<TestResult> {
  if (!canSetNotifications(actor)) deny();
  if (!pushStatus().configured) return "not_configured";
  if (!(await withinLimit(db, `push:test:${actor.id}`, TESTS_PER_HOUR, now))) throw new TooMany();
  const result = await sendPush(db, actor.id, { kind: "test" }, now);
  if (result.status === "not_configured") return "not_configured";
  if (result.devices === 0) return "no_device";
  return result.sent > 0 ? "sent" : "failed";
}
