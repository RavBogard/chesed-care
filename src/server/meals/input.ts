/**
 * Every input to Mitzvah Meals, as strict zod schemas: unknown keys are refused,
 * every text has a length cap, control characters are refused, emails are lower
 * case. The public functions accept nothing that has not passed through here.
 */
import { z } from "zod";
import { InvalidInput } from "@/server/care/validate";
import { isDateKey } from "@/server/lifecycle/window";

export const KASHRUT = ["anything", "kosher_style", "vegetarian_or_dairy", "strictly_kosher"] as const;
export const MEALS = ["dinner", "lunch"] as const;
export const SIGNUP_KINDS = ["cook", "delivery"] as const;
export const FOOD_TYPES = ["meat", "dairy", "pareve", "not_sure"] as const;
export const MAX_DATES = 40;

/** Bidirectional and zero-width characters (U+200B to U+200F, U+202A to U+202E, U+2060 to U+2069, U+FEFF) are refused too: they can make a name read as another. C0 and DEL, plus NEL (U+0085) and the line and paragraph separators (U+2028, U+2029): line breaks to a calendar reader, so refused like CR and LF. */
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
/** Multi-line text: a line break is \n or \r\n (stored as \n). A bare \r is refused, as every other control character is. */
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]|\r(?!\n)/;

export const clean = (max: number, lines: boolean) =>
  z
    .string()
    .max(max)
    .refine((v) => !(lines ? CONTROL_BUT_NEWLINE : CONTROL).test(v))
    .transform((v) => v.replace(/\r\n/g, "\n").trim());

/** Required text on one line. */
const req = (max: number) => clean(max, false).refine((v) => v.length > 0);
/** Optional text: null or "" clears it. */
const opt = (max: number, lines = false) =>
  z.union([z.null(), clean(max, lines)]).transform((v) => v || null);

const email = clean(254, false)
  .transform((v) => v.toLowerCase())
  .refine((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v));
const optEmail = z.union([z.null(), z.literal(""), email]).transform((v) => v || null);

export const day = z.string().refine(isDateKey);

const dietary = z
  .array(req(40))
  .max(15)
  .transform((v) => [...new Set(v.map((d) => d.toLowerCase()))]);

/** What the family may also change through their own link. */
const foodNeeds = {
  foodFor: opt(200),
  kashrut: z.enum(KASHRUT),
  dietary,
  allergies: opt(500, true),
  dropOffWindow: opt(120),
  dropOffInstructions: opt(500, true),
};

const pageFields = {
  title: req(120),
  note: opt(500, true),
  ...foodNeeds,
  dropOffAddress: opt(300, true),
  dropOffIsHome: z.boolean(),
  deliveryPlaces: opt(500, true),
  giftCards: opt(500, true),
  giftCardEmail: optEmail,
};

export const slotInput = z.strictObject({ date: day, meal: z.enum(MEALS).default("dinner") });
export const slotInputs = z.array(slotInput).min(1).max(MAX_DATES);

export const createPageInput = z.strictObject({
  ...z.strictObject(pageFields).partial().shape,
  title: pageFields.title,
  /** Ids are checked by the care validators (and the access policy) in pages.ts. */
  careItemId: z.unknown().optional(),
  sfContactId: z.unknown().optional(),
  sfAccountId: z.unknown().optional(),
  outsidePersonId: z.unknown().optional(),
  dates: z.array(slotInput).max(MAX_DATES).optional(),
});

export const pagePatch = z.strictObject(pageFields).partial();
export const familyPatch = z.strictObject(foodNeeds).partial();
export const FAMILY_FIELDS = ["foodFor", "kashrut", "dietary", "allergies", "dropOffWindow", "dropOffInstructions"] as const;

const signupFields = {
  firstName: req(60),
  lastName: req(60),
  email,
  kind: z.enum(SIGNUP_KINDS),
  bringing: opt(200).optional(),
  foodType: z.enum(FOOD_TYPES).default("not_sure"),
  note: opt(300, true).optional(),
  mayContactAgain: z.boolean().default(false),
};
export const signupInput = z.strictObject(signupFields);
/** An organiser booking for someone who phoned: a first name is enough. */
export const behalfInput = z.strictObject({ ...signupFields, lastName: opt(60).optional(), email: optEmail.optional() });

export const changeInput = z.strictObject({
  kind: z.enum(SIGNUP_KINDS).optional(),
  bringing: opt(200).optional(),
  foodType: z.enum(FOOD_TYPES).optional(),
  note: opt(300, true).optional(),
  moveToSlotId: z.uuid().optional(),
});

export const thanksInput = req(300);

/**
 * What the public route passes with a request.
 *  - clientKey: the client's address AS THE PLATFORM REPORTS IT (the address the
 *    host sets itself; never a forwarded-for header the client can write), with an
 *    IPv6 address collapsed to its /64, so one home or phone is one client. The
 *    per-client limits are only as good as this value. It is hashed before it is
 *    stored.
 *  - honeypot: the hidden field as submitted (a person leaves it empty).
 *  - elapsedMs: how long the form was open.
 */
export const clientMetaInput = z.strictObject({ clientKey: z.string().min(1).max(200), honeypot: z.string().max(2000).nullish(), elapsedMs: z.number().nullish() });
export type ClientMeta = z.input<typeof clientMetaInput>;

/** For signed-in callers: the parsed value, or InvalidInput naming the first bad field (never its value). */
export function parse<S extends z.ZodType>(schema: S, value: unknown, fallbackField = "input"): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidInput(String(result.error.issues[0]?.path[0] ?? fallbackField));
  return result.data;
}

/** For the public functions: the names of the bad fields, never their values. */
export function badFields(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((i) => String(i.path[0] ?? "input")))];
}
