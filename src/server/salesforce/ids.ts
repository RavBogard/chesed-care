/**
 * Salesforce Id validation. Every Id that is interpolated into SOQL, or stored as a
 * person reference, passes through here first.
 */
const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

export class InvalidSalesforceId extends Error {
  constructor(what: string) {
    super(`Invalid Salesforce ${what} Id`);
    this.name = "InvalidSalesforceId";
  }
}

export function isSfId(value: unknown): value is string {
  return typeof value === "string" && SF_ID.test(value);
}

export function assertSfId(value: unknown, what = "record"): string {
  if (!isSfId(value)) throw new InvalidSalesforceId(what);
  return value;
}

/** A Contact Id (key prefix 003). */
export function assertContactId(value: unknown): string {
  const id = assertSfId(value, "Contact");
  if (!id.startsWith("003")) throw new InvalidSalesforceId("Contact");
  return id;
}

/** An Account (household) Id (key prefix 001). */
export function assertAccountId(value: unknown): string {
  const id = assertSfId(value, "Account");
  if (!id.startsWith("001")) throw new InvalidSalesforceId("Account");
  return id;
}

/** A quoted SOQL literal for a validated Id. */
export function soqlId(value: unknown, what?: string): string {
  return `'${assertSfId(value, what)}'`;
}
