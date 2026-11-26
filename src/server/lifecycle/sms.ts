/**
 * The "Text" link: an sms: URL that opens the phone's Messages app with the number
 * and a short draft. The app never sends anything itself. PURE.
 */
import type { Occasion } from "./types";

/** A dialable number (+1 assumed for 10-digit US numbers), or null. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const main = raw.split(/\s*(?:x|ext\.?|#)\s*\d+\s*$/i)[0];
  const digits = main.replace(/\D/g, "");
  if (main.trim().startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** sms: URL with a prefilled body (the `?&body=` form works on both iOS and Android). */
export function smsHref(phone: string, body: string): string {
  return `sms:${phone}?&body=${encodeURIComponent(body)}`;
}

/** The number to text for an occasion: mobile first, then the other phone. */
export function textableNumber(o: Pick<Occasion, "mobile" | "phone">): string | null {
  return normalizePhone(o.mobile) ?? normalizePhone(o.phone);
}

/** A short default draft per occasion type. `today` decides "today" vs "this week". */
export function defaultDraft(o: Occasion, today: string): string {
  const hi = o.contactFirstName ? `Hi ${o.contactFirstName}, ` : "";
  switch (o.type) {
    case "birthday": {
      const self = o.contactId !== null && o.contactId === o.subjectId;
      if (self) return `Happy birthday${o.personFirstName ? `, ${o.personFirstName}` : ""}! Wishing you a sweet year ahead.`;
      return `${hi}wishing ${o.personFirstName ?? o.personName} a very happy birthday! Thinking of your family today.`;
    }
    case "anniversary":
      return `Happy anniversary${o.informalGreeting ? `, ${o.informalGreeting}` : " to you both"}! Wishing you a year full of joy together.`;
    case "yahrzeit":
      return `${hi}I'm thinking of you as you mark the yahrzeit of ${o.personName} ${o.date === today ? "today" : "this week"}. May their memory be a blessing.`;
    case "shloshim":
      return `${hi}I'm thinking of you as you mourn ${o.personName}. Please let me know if there is anything you need.`;
  }
}

/** Placeholders a user's own draft may use (Settings, "Text drafts"). */
export const DRAFT_PLACEHOLDERS = ["{first_name}", "{name}", "{household}", "{when}"] as const;

/**
 * Fill a user's own draft for this occasion. {first_name}: the person being texted;
 * {name}: whom the occasion is about; {household}: the informal household greeting;
 * {when}: "today" or "this week". A missing value leaves no stray punctuation behind.
 */
export function renderDraft(template: string, o: Occasion, today: string): string {
  const values: Record<string, string> = {
    "{first_name}": o.contactFirstName ?? "",
    "{name}": o.personFirstName && o.type === "birthday" ? o.personFirstName : o.personName,
    "{household}": o.informalGreeting ?? o.household ?? "",
    "{when}": o.date === today ? "today" : "this week",
  };
  return template
    .replace(/\{(first_name|name|household|when)\}/g, (m) => values[m] ?? "")
    .replace(/[ \t]+,/g, ",")
    .replace(/(^|[\s])[,]\s*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** The draft for an occasion: the user's own for its type when they have one, else the default. */
export function draftFor(o: Occasion, today: string, own: Partial<Record<Occasion["type"], string>>): string {
  const t = own[o.type];
  return t ? renderDraft(t, o, today) : defaultDraft(o, today);
}

/** A tel: URL for the occasion's or a person's number, or null. */
export function telHref(raw: string | null | undefined): string | null {
  const n = normalizePhone(raw);
  return n ? `tel:${n}` : null;
}
