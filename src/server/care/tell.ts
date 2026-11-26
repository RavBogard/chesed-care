/**
 * The public "Let the clergy know" form. No account, so the route builds a clientMeta
 * from things the client cannot choose (src/server/meals/client-meta.ts) and passes
 * it here. The only thing this does is create a proposal for clergy. It never
 * searches people and its answer never depends on whether anyone is known: a
 * submission that is accepted, one caught by the honeypot and one for a person who
 * is a member all return the same `{ ok: true }`. Nothing is logged.
 */
import { z } from "zod";
import type { Db } from "@/server/db/types";
import { badFields, clean, clientMetaInput } from "@/server/meals/input";
import { atLimit, readClient, withinLimit } from "@/server/meals/rate-limit";
import { afterResponse, noticePracticalRequest } from "@/server/notify/notify";
import { scheduleReading } from "./ai-reading";
import { touchesSensitiveFloor } from "./bring-in-rules";
import { createPublicProposal, MAY_TELL, MI_SHEBERACH } from "./intake";

export const TELL_LIMITS = {
  /** Attempts from one client per clock hour (every attempt counts). */
  perClient: 20,
  /** Proposals the form may create per clock hour, from everyone. */
  perHour: 120,
} as const;

export const TELL_TEXT_MAX = 1000;

const required = (max: number, lines = false) => clean(max, lines).refine((v) => v.length > 0);
const tellInput = z.strictObject({
  about: required(200),
  what: required(TELL_TEXT_MAX, true),
  sender: required(200),
  contact: required(254),
  mayTellThem: z.enum(MAY_TELL),
  miSheberach: z.enum(MI_SHEBERACH),
  /** Who the message is for. Absent means clergy only: a missing answer never widens who sees it. */
  help: z.enum(["clergy", "practical"]).default("clergy"),
});

/** Practical, and neither the sender's words nor the subject touch the sensitive-word floor. Any doubt or error is false. */
const SOFT_HYPHEN = String.fromCharCode(0xad);
function leadMaySee(...parts: string[]): boolean {
  try {
    // Everything the coordinator would see is checked, folded to its plain form first, so a soft hyphen or a full-width letter does not slip a word past.
    return parts.every((p) => !touchesSensitiveFloor(p.normalize("NFKC").replaceAll(SOFT_HYPHEN, "")));
  } catch {
    return false;
  }
}

export type TellRefusal = { ok: false; reason: "stale" | "invalid" | "limited" | "refused"; fields: string[] };
export type TellResult = { ok: true } | TellRefusal;

const no = (reason: TellRefusal["reason"], fields: string[] = []): TellRefusal => ({ ok: false, reason, fields });

/**
 * Take one submission. `meta.elapsedMs` is null when the render stamp was missing,
 * forged or old: the form is asked to be reloaded.
 */
export async function submitTell(db: Db, input: unknown, meta: unknown, now: Date = new Date()): Promise<TellResult> {
  const parsedMeta = clientMetaInput.safeParse(meta);
  if (!parsedMeta.success) return no("refused");
  if (parsedMeta.data.elapsedMs === null || parsedMeta.data.elapsedMs === undefined) return no("stale");
  const client = readClient(parsedMeta.data, now, true);
  if (!client) return no("refused");
  // A robot gets the same thank-you as anyone: nothing is made, and it learns nothing.
  if (client.bot) return { ok: true };
  const parsed = tellInput.safeParse(input);
  if (!parsed.success) return no("invalid", badFields(parsed.error));
  // Only a submission that passed validation counts against the client (a shared wifi is not used up by typos).
  if (!(await withinLimit(db, `tell:client:${client.hash}`, TELL_LIMITS.perClient, now))) return no("limited");
  if (await atLimit(db, "tell:all", TELL_LIMITS.perHour, now)) return no("limited");
  const v = parsed.data;
  const practical = v.help === "practical";
  const leadVisible = practical && leadMaySee(v.about, v.what, v.sender, v.contact);
  const id = await createPublicProposal(db, {
    rawText: v.what,
    intake: { kind: "public_form", about: v.about, sender: v.sender, contact: v.contact },
    mayTellThem: v.mayTellThem,
    miSheberach: v.miSheberach,
    practical,
    leadVisible,
  });
  await withinLimit(db, "tell:all", TELL_LIMITS.perHour, now);
  // After the thank-you is sent: the reading never delays or changes the answer.
  scheduleReading(db, id);
  if (leadVisible) afterResponse(() => noticePracticalRequest(db, id));
  return { ok: true };
}
