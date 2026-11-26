/**
 * Arrivals that are not a signed-in person's own report: the public "Let the clergy
 * know" form, a volunteer's "Something a rabbi should know", and what Salesforce
 * tells us (a death, a birth). Each only ever
 * becomes a PROPOSAL for clergy; nothing here searches people, reads care records
 * or says whether anyone is known. What a sender stated is never verified.
 *
 * The stated words (raw_text) and the stated details (intake) are pastoral: never
 * logged or audited. When the proposal is decided the details (intake: the sender's
 * name and contact) are cleared; the words are kept for clergy (proposals.ts).
 */
import { z } from "zod";
import { proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";

export const MAY_TELL = ["yes", "no"] as const;
export const MI_SHEBERACH = ["yes", "no", "not_sure"] as const;

/** What a public sender stated, kept on the proposal until it is decided. */
export const publicIntake = z.strictObject({ kind: z.literal("public_form"), about: z.string().max(200), sender: z.string().max(200), contact: z.string().max(254) });
export type PublicIntake = z.infer<typeof publicIntake>;

/** What Salesforce told us: ids and the household's name, never anything about giving. */
export const salesforceIntake = z.strictObject({
  kind: z.literal("salesforce"),
  event: z.enum(["death", "birth"]),
  subjectId: z.string().max(18),
  accountId: z.string().max(18).nullable(),
  household: z.string().max(200).nullable(),
  /** A death: the date of death Salesforce has, YYYY-MM-DD, to start the bereavement year from. */
  deathDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});
export type SalesforceIntake = z.infer<typeof salesforceIntake>;

/** A "bring in your list" entry: only which batch it belongs to, its place in the list and the list's size. Never any words. */
export const batchIntake = z.strictObject({ kind: z.literal("batch"), batch: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i), n: z.number().int().min(0).max(39), total: z.number().int().min(1).max(40) });
export type BatchIntake = z.infer<typeof batchIntake>;

export type Intake = PublicIntake | SalesforceIntake | BatchIntake;

/** The stored intake, or null when there is none or it has an unknown shape. */
export function storedIntake(value: unknown): Intake | null {
  const parsed = z.union([publicIntake, salesforceIntake, batchIntake]).safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A public-form arrival: always the shared Inbox, no submitter. */
export async function createPublicProposal(db: Db, input: { rawText: string; intake: PublicIntake; mayTellThem: (typeof MAY_TELL)[number]; miSheberach: (typeof MI_SHEBERACH)[number]; practical?: boolean; leadVisible?: boolean }): Promise<string> {
  const [made] = await db
    .insert(proposals)
    .values({
    channel: "form",
    submittedBy: null,
    submitterLabel: "Public form",
    rawText: input.rawText,
    intake: input.intake,
    mayTellThem: input.mayTellThem,
    miSheberachAnswer: input.miSheberach,
    reviewScope: "clergy",
    practical: input.practical === true,
    // Only a practical request can ever be visible to the lead.
    leadVisible: input.practical === true && input.leadVisible === true,
  })
    .returning({ id: proposals.id });
  return made.id;
}

/** Who a volunteer's "Something a rabbi should know" is from, on the Inbox card. */
export const VOLUNTEER_FLAG_LABEL = "A volunteer";

/**
 * "Something a rabbi should know", sent from a volunteer's own page: always the shared Inbox, no submitter, nothing
 * stated beyond the words (no intake). The channel is "form", as for any arrival through a public link; it is never
 * practical, so the Mitzvah Corps lead never sees it. `scopeCareItemId`: the care item the task is linked to, if any;
 * only those who may open that item review the proposal (a restricted item: its owner and the clergy named on it).
 * `db` may be the caller's transaction.
 */
export async function createVolunteerFlagProposal(db: Db, rawText: string, scopeCareItemId: string | null): Promise<string> {
  const [made] = await db.insert(proposals).values({ channel: "form", submittedBy: null, submitterLabel: VOLUNTEER_FLAG_LABEL, rawText, reviewScope: "clergy", scopeCareItemId }).returning({ id: proposals.id });
  return made.id;
}

/**
 * An arrival from Salesforce, once per external key. The key stays on the row after
 * it is accepted or dismissed, so a later run never makes a second one. Returns
 * whether a proposal was created.
 */
export async function createSalesforceProposal(db: Db, input: { externalKey: string; rawText: string; intake: SalesforceIntake }): Promise<boolean> {
  const made = await db
    .insert(proposals)
    .values({ channel: "salesforce", submittedBy: null, submitterLabel: "Salesforce", rawText: input.rawText, intake: input.intake, reviewScope: "clergy", externalKey: input.externalKey })
    .onConflictDoNothing({ target: proposals.externalKey })
    .returning({ id: proposals.id });
  return made.length > 0;
}
