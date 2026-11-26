/**
 * Inputs to the Mitzvah Corps roster, as strict zod schemas on the same text rules as the rest of the
 * volunteer side (control and bidirectional characters refused, every text capped, unknown keys refused).
 */
import { z } from "zod";
import { CAN_DO, HOW_OFTEN, PREFER_CONTACT } from "@/lib/can-do";
import { isDateKey } from "@/server/lifecycle/window";
import { clean } from "@/server/meals/input";
import { normalizeContact } from "./input";

export const MEMBER_STATUSES = ["active", "paused", "left", "pending"] as const;

const req = (max: number) => clean(max, false).refine((v) => v.length > 0);
const opt = (max: number, lines = false) => z.union([z.null(), clean(max, lines)]).transform((v) => v || null);
const canDo = z
  .array(z.enum(CAN_DO))
  .max(CAN_DO.length)
  .transform((v) => [...new Set(v)]);

const optChoice = <T extends readonly [string, ...string[]]>(values: T) => z.union([z.null(), z.literal(""), z.enum(values)]).transform((v) => (v === "" ? null : v)).optional();
const howOften = optChoice(HOW_OFTEN);
const preferContact = optChoice(PREFER_CONTACT);

const emailValue = clean(254, false).refine((v) => v.includes("@") && normalizeContact(v) !== null);
const mobileValue = clean(40, false).refine((v) => !v.includes("@") && normalizeContact(v) !== null);
const optEmail = z.union([z.null(), z.literal(""), emailValue]).transform((v) => v || null);
const optMobile = z.union([z.null(), z.literal(""), mobileValue]).transform((v) => v || null);

export type Contacts = { email: string | null; emailKey: string | null; mobile: string | null; mobileKey: string | null };

/** The stored contact values and their keys. Null when neither is given. */
export function contactsOf(input: { email?: string | null; mobile?: string | null }): Contacts | null {
  const e = input.email ? normalizeContact(input.email) : null;
  const m = input.mobile ? normalizeContact(input.mobile) : null;
  if (!e && !m) return null;
  return { email: e?.contact ?? null, emailKey: e?.key ?? null, mobile: m?.contact ?? null, mobileKey: m?.key ?? null };
}

/** A coordinator adding or editing a member. At least one contact (checked by contactsOf). */
export const memberInput = z.strictObject({
  firstName: req(60),
  lastName: req(60),
  email: optEmail.optional(),
  mobile: optMobile.optional(),
  canDo,
  availability: opt(200).optional(),
  area: opt(60).optional(),
  howOften,
  preferContact,
  coordinatorNotes: opt(300, true).optional(),
});

/** The public form: one contact box (an email or a mobile number) and the consent tick. */
export const joinInput = z.strictObject({
  firstName: req(60),
  lastName: req(60),
  contact: clean(254, false).refine((v) => normalizeContact(v) !== null),
  canDo,
  availability: opt(200).optional(),
  howOften,
  preferContact,
  consent: z.literal(true),
});

export const pauseInput = z.string().refine(isDateKey);
