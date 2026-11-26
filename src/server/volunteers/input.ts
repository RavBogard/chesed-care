/**
 * Every input to volunteer tasks, as strict zod schemas, built on the Mitzvah Meals
 * text rules (../meals/input.ts): unknown keys refused, every text capped, control and
 * bidirectional characters refused. Public functions accept nothing that has not passed here.
 */
import { z } from "zod";
import { clean, day } from "@/server/meals/input";

export { badFields, parse, type ClientMeta } from "@/server/meals/input";

export const KINDS = ["visit", "call", "meal", "ride", "shiva_minyan", "errand", "other"] as const;
export type Kind = (typeof KINDS)[number];
/** Ten make a minyan. */
export const MINYAN = 10;
export const MAX_EVENINGS = 14;
export const MAX_PEOPLE = 50;

const req = (max: number, lines = false) => clean(max, lines).refine((v) => v.length > 0);
const opt = (max: number, lines = false) => z.union([z.null(), clean(max, lines)]).transform((v) => v || null);
const people = z.number().int().min(1).max(MAX_PEOPLE);

const taskFields = {
  kind: z.enum(KINDS),
  forLabel: req(80),
  needed: req(300, true),
  date: day,
  timeWindow: opt(60),
  place: opt(300, true),
  peopleNeeded: people,
  contactLine: opt(120),
};

export const createTaskInput = z.strictObject({
  ...z.strictObject(taskFields).partial().shape,
  kind: taskFields.kind,
  forLabel: taskFields.forLabel,
  needed: taskFields.needed,
  date: taskFields.date,
  /** Checked by the care validators and the access policy in organiser.ts. */
  careItemId: z.unknown().optional(),
});
export const taskPatch = z.strictObject(taskFields).partial();

export const createSheetInput = z.strictObject({
  title: req(80),
  needed: opt(300, true).optional(),
  place: opt(300, true).optional(),
  contactLine: opt(120).optional(),
  evenings: z
    .array(z.strictObject({ date: day, timeWindow: opt(60).optional() }))
    .min(1)
    .max(MAX_EVENINGS),
  careItemId: z.unknown().optional(),
});

/** An email (lower-cased) or a mobile number. `key` is how a block recognises the same person. */
export function normalizeContact(raw: string): { contact: string; key: string } | null {
  const value = raw.trim();
  if (value.includes("@")) {
    const email = value.toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? { contact: email, key: email } : null;
  }
  if (!/^[0-9+().\-\s]+$/.test(value)) return null;
  let digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length >= 7 && digits.length <= 15 ? { contact: value, key: digits } : null;
}

const contact = clean(254, false).refine((v) => normalizeContact(v) !== null);

export const claimInput = z.strictObject({
  firstName: req(60),
  lastName: req(60),
  contact,
  note: opt(200, true).optional(),
  mayAskAgain: z.boolean().default(false),
});

export const doneInput = opt(200).optional();

export const bringingInput = z.strictObject({ firstName: req(60), line: req(120) });
