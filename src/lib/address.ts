/**
 * A postal address and the two things done with it: showing it, and opening it in Google Maps.
 * PURE: no I/O, safe in server and client code. An address is only ever shown to the people
 * who already see phone numbers; nothing here decides that.
 */
export type Address = {
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** Where it was read: the person's own mailing address or their household's billing address. */
  source: "contact" | "household" | "app";
};

// C0 and C1 control characters, other than the whitespace ones collapsed below.
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]");
const LINE_BREAK = new RegExp("\\r\\n|\\r|\\n|\\u2028|\\u2029");

/** Trimmed, whitespace collapsed; null when nothing is left or the value is not text. */
function tidy(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s || null;
}

/** A street: each line trimmed, empty lines dropped, the lines joined with ", ". */
function tidyStreet(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const parts = v
    .split(LINE_BREAK)
    .map((p) => tidy(p))
    .filter((p): p is string => !!p);
  return parts.length ? parts.join(", ") : null;
}

/** An address from raw parts, tidied; null when every part is empty. */
export function makeAddress(parts: { street?: unknown; city?: unknown; state?: unknown; postalCode?: unknown }, source: Address["source"]): Address | null {
  const a: Address = { street: tidyStreet(parts.street), city: tidy(parts.city), state: tidy(parts.state), postalCode: tidy(parts.postalCode), source };
  return a.street || a.city || a.state || a.postalCode ? a : null;
}

function hasControl(a: Address): boolean {
  return [a.street, a.city, a.state, a.postalCode].some((p) => p !== null && CONTROL.test(p));
}

const clean = (s: string | null): string | null => (s === null ? null : tidy(s.replace(new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g"), " ")));

/** The lines to show: the street, then "City, ST 63105". A line with nothing in it is left out. */
export function formatAddress(a: Address): { lines: string[]; oneLine: string } {
  const street = clean(a.street);
  const cityState = [clean(a.city), clean(a.state)].filter(Boolean).join(", ");
  const place = [cityState, clean(a.postalCode)].filter(Boolean).join(" ");
  const lines = [street, place].filter((l): l is string => !!l);
  return { lines, oneLine: lines.join(", ") };
}

/** City and state only, for telling two people with the same name apart. Null when neither is known. */
export function placeOf(a: Address | null): string | null {
  if (!a) return null;
  return [clean(a.city), clean(a.state)].filter(Boolean).join(", ") || null;
}

/** The Google Maps link for an address (opens the app on a phone and the site on a computer). Null with no street or with control characters. */
export function mapsUrl(a: Address): string | null {
  if (!a.street || hasControl(a)) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatAddress(a).oneLine)}`;
}

/** The Google Maps link for a place typed as free text (a task's "where"). Null when it is empty or carries control characters. */
export function mapsUrlForPlace(place: string | null | undefined): string | null {
  const a = makeAddress({ street: place }, "app");
  return a ? mapsUrl(a) : null;
}
