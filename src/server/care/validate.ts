/**
 * Input checks for the care data functions. Error messages name the field, never
 * its value (a value could be pastoral note text).
 */
import { assertAccountId, assertContactId, InvalidSalesforceId } from "@/server/salesforce/ids";
import { isDateKey } from "@/server/lifecycle/window";

export class InvalidInput extends Error {
  constructor(field: string) {
    super(`Invalid ${field}`);
    this.name = "InvalidInput";
  }
}

/** Raised when a person has done something too often in an hour. Says nothing of what it was. */
export class TooMany extends Error {
  constructor() {
    super("Too many");
    this.name = "TooMany";
  }
}

/** Raised for a record that does not exist or that the actor may not see (indistinguishable on purpose). */
export class NotFound extends Error {
  constructor() {
    super("Not found");
    this.name = "NotFound";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export function uuidOrNotFound(v: unknown): string {
  if (!isUuid(v)) throw new NotFound();
  return v;
}

export function uuidField(v: unknown, field: string): string {
  if (!isUuid(v)) throw new InvalidInput(field);
  return v;
}

export function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new InvalidInput(field);
  return v.trim();
}

export function optionalText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) throw new InvalidInput(field);
  return v.trim() || null;
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new InvalidInput(field);
  return v as T;
}

export function dateField(v: unknown, field: string): string {
  if (!isDateKey(v)) throw new InvalidInput(field);
  return v;
}

/** A YYYY-MM-DD date no earlier than `from` and no later than `to` (both YYYY-MM-DD). */
export function dateWithin(v: unknown, field: string, from: string, to: string): string {
  const d = dateField(v, field);
  if (d < from || d > to) throw new InvalidInput(field);
  return d;
}

export function instantField(v: unknown, field: string): Date {
  const d = v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new InvalidInput(field);
  return d;
}

function sf<T>(fn: () => T, field: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof InvalidSalesforceId) throw new InvalidInput(field);
    throw e;
  }
}

/** Stored and queried Ids are the canonical 18-character form only, so one person never has two keys. */
function canonical18(id: string, what: string): string {
  if (id.length !== 18) throw new InvalidSalesforceId(what);
  return id;
}

export function contactIdField(v: unknown, field = "sfContactId"): string {
  return sf(() => canonical18(assertContactId(v), "Contact"), field);
}

/** A Contact Id as typed in a URL: 15 or 18 characters, to be resolved to its canonical form before use. */
export function lookupContactIdField(v: unknown, field = "sfContactId"): string {
  return sf(() => assertContactId(v), field);
}

export function optionalAccountIdField(v: unknown, field = "sfAccountId"): string | null {
  if (v === undefined || v === null || v === "") return null;
  return sf(() => canonical18(assertAccountId(v), "Account"), field);
}

export function optionalBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new InvalidInput(field);
  return v;
}

/** A short list of distinct user ids (e.g. the clergy named on a restricted item). */
export function uuidList(v: unknown, field: string, max: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw new InvalidInput(field);
  return [...new Set(v.map((id) => uuidField(id, field)))];
}
