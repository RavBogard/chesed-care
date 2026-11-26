/**
 * A proposal's "reading": what an arrival seems to say, sorted into fields for the
 * reviewer to confirm. Every field is optional and nothing in it is trusted: clergy
 * set the final values when they accept.
 *
 * A reading comes from the connector (the person's own Claude fills it in), from the
 * app's own server-side AI reading of a new report (ai-reading.ts; it sees only the
 * message text, never any directory), or is absent.
 */
import { z } from "zod";
import { isDateKey } from "@/server/lifecycle/window";
import { CARE_CATEGORIES } from "./care-items";
import { InvalidInput } from "./validate";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isDateKey);
const contactId = z.string().regex(/^003[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/);

/** The fields a quoted span of the message may be given as the reason for. */
export const EVIDENCE_FIELDS = ["names", "summary", "category", "urgency", "dates", "sensitive", "followUp"] as const;

export const URGENCIES = ["now", "today", "week", "routine"] as const;

export const readingSchema = z.strictObject({
  person: z
    .strictObject({
      contactId: contactId.optional(),
      outsidePersonId: uuid.optional(),
      name: z.string().max(200).optional(),
      candidates: z
        .array(z.strictObject({ contactId, name: z.string().max(200), household: z.string().max(200).nullable() }))
        .max(10)
        .optional(),
    })
    .optional(),
  category: z.enum(CARE_CATEGORIES).optional(),
  urgency: z.enum(URGENCIES).optional(),
  summary: z.string().max(500).optional(),
  location: z.string().max(200).optional(),
  dates: z
    .array(z.strictObject({ label: z.string().max(100), date: day }))
    .max(10)
    .optional(),
  restrictedSuggested: z.boolean().optional(),
  existingCareItemId: uuid.optional(),
  ownerUserId: uuid.optional(),
  followUp: z.strictObject({ title: z.string().min(1).max(200), dueDate: day }).optional(),
  /** App AI reading only: the people the message is about, as written. Matched to real people when the Inbox is drawn, never stored matched. */
  names: z.array(z.string().min(1).max(120)).max(8).optional(),
  /** App AI reading only: a short first follow-up idea, without a date. */
  followUpIdea: z.string().max(200).optional(),
  /** App AI reading only: the exact words of the message that led to each field. */
  evidence: z.array(z.strictObject({ field: z.enum(EVIDENCE_FIELDS), text: z.string().min(1).max(300) })).max(20).optional(),
  /** Set when the app's own AI reading made this one. */
  by: z.literal("app_ai").optional(),
});

export type Reading = z.infer<typeof readingSchema>;

/** A reading from outside (the connector), checked. The error names the field only, never a value. */
export function readingField(v: unknown): Reading | null {
  if (v === undefined || v === null) return null;
  const parsed = readingSchema.safeParse(v);
  if (!parsed.success) throw new InvalidInput("reading");
  // The fields only the app's own AI reading sets are never taken from a client: `by` is the server's label.
  const { by: _by, names: _names, evidence: _evidence, followUpIdea: _idea, ...rest } = parsed.data;
  void [_by, _names, _evidence, _idea];
  return rest;
}

/** A reading as stored; one that no longer fits the shape is treated as absent. */
export function storedReading(v: unknown): Reading | null {
  const parsed = readingSchema.safeParse(v);
  return parsed.success ? parsed.data : null;
}

/**
 * Reads nothing at write time: a proposal without a connector reading has none when it
 * is created. The app's own AI reading runs afterwards, off the request
 * (ai-reading.ts `scheduleReading`), and fills the reading in only while undecided.
 */
export async function readProposal(rawText: string | null): Promise<Reading | null> {
  void rawText;
  return null;
}
