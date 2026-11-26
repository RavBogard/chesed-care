/** Reading Salesforce rows. PURE: no I/O. */
import { isSfId } from "@/server/salesforce/ids";
import type { SfRow } from "@/server/salesforce/client";
import { makeAddress, type Address } from "@/lib/address";
import { hebrewDateOfDeath } from "@/lib/hebrew-date";

export function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function obj(v: unknown): SfRow | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as SfRow) : null;
}

export function sfId(v: unknown): string | null {
  return isSfId(v) ? v : null;
}

/** Fields of a household Account (prefix "" on Account, "Account." from a Contact, etc.). */
export function householdFields(prefix: string): string {
  return [
    "Name",
    "npo02__Formal_Greeting__c",
    "npo02__Informal_Greeting__c",
    "cs_Member__c",
    "npe01__One2OneContact__c",
    "npe01__One2OneContact__r.Name",
    "npe01__One2OneContact__r.FirstName",
    "npe01__One2OneContact__r.MobilePhone",
    "npe01__One2OneContact__r.Phone",
    "npe01__One2OneContact__r.Hebrew_Name__c",
  ]
    .map((f) => `${prefix}${f}`)
    .join(", ");
}

export type Reach = { contactId: string | null; contactName: string | null; contactFirstName: string | null; contactHebrewName: string | null; mobile: string | null; phone: string | null };

/** The fields of a Contact that make a Reach, for a query (prefix "Contact__r." and the like). */
export function reachFields(prefix: string): string {
  return ["Name", "FirstName", "MobilePhone", "Phone", "Hebrew_Name__c"].map((f) => `${prefix}${f}`).join(", ");
}

export function reachOf(contactId: unknown, c: SfRow | null): Reach {
  return { contactId: sfId(contactId), contactName: str(c?.Name), contactFirstName: str(c?.FirstName), contactHebrewName: str(c?.Hebrew_Name__c), mobile: str(c?.MobilePhone), phone: str(c?.Phone) };
}

export function hasNumber(r: Reach): boolean {
  return !!(r.mobile || r.phone);
}

/** The first candidate with a phone number, else the first with a name, else an empty reach. */
export function pickReach(...candidates: Reach[]): Reach {
  return (
    candidates.find(hasNumber) ??
    candidates.find((c) => c.contactName) ?? { contactId: null, contactName: null, contactFirstName: null, contactHebrewName: null, mobile: null, phone: null }
  );
}

export type Household = {
  accountId: string | null;
  household: string | null;
  informalGreeting: string | null;
  isCurrentMember: boolean;
  primary: Reach;
};

export function householdOf(acct: SfRow | null, accountId: unknown): Household {
  return {
    accountId: sfId(accountId),
    household: str(acct?.npo02__Formal_Greeting__c) ?? str(acct?.npo02__Informal_Greeting__c) ?? str(acct?.Name),
    informalGreeting: str(acct?.npo02__Informal_Greeting__c),
    isCurrentMember: acct?.cs_Member__c === true,
    primary: reachOf(acct?.npe01__One2OneContact__c, obj(acct?.npe01__One2OneContact__r)),
  };
}

/** A Contact's standard mailing address fields, for a query (prefix "" on Contact, "Contact__r." and the like). */
export function mailingFields(prefix: string): string {
  return ["MailingStreet", "MailingCity", "MailingState", "MailingPostalCode"].map((f) => `${prefix}${f}`).join(", ");
}

/** A household Account's standard billing address fields, for a query (prefix "Account." from a Contact). */
export function billingFields(prefix: string): string {
  return ["BillingStreet", "BillingCity", "BillingState", "BillingPostalCode"].map((f) => `${prefix}${f}`).join(", ");
}

/**
 * The address of a person: the Contact's own mailing address, else the household Account's billing address.
 * A candidate with a street wins; failing that, the first with any part (a city and state still help).
 */
export function addressOf(contact: SfRow | null, account: SfRow | null): Address | null {
  const mailing = makeAddress({ street: contact?.MailingStreet, city: contact?.MailingCity, state: contact?.MailingState, postalCode: contact?.MailingPostalCode }, "contact");
  const billing = makeAddress({ street: account?.BillingStreet, city: account?.BillingCity, state: account?.BillingState, postalCode: account?.BillingPostalCode }, "household");
  return [mailing, billing].find((a) => a?.street) ?? mailing ?? billing;
}

export function deceasedName(r: SfRow): string {
  return str(r.Deceased_Name__c) || [str(r.Deceased_First_Name__c), str(r.Deceased_Last_Name__c)].filter(Boolean).join(" ") || str(r.Name) || "(unnamed)";
}

export function deceasedHebrewName(r: SfRow): string | null {
  return str(r.Deceased_Hebrew_Name__c) ?? str(r.Hebrew_Name__c);
}

export function deathDateOf(r: SfRow): string | null {
  return str(r.English_Date_of_Death__c) ?? str(r.Eng_Death_Date__c);
}

/** The Hebrew date of death as Yahrzeit__c records it: day ("10"), month ("Tevet") and the text date with the true year. Hebrew_Year__c is the next observance's year, so it is not selected. */
export function hebrewDeathFields(prefix: string): string {
  return ["Hebrew_Day__c", "Hebrew_Month__c", "Hebrew_Date_of_Death_In_Hebrew__c"].map((f) => `${prefix}${f}`).join(", ");
}

/** The Hebrew date of death in Hebrew letters, from the recorded Hebrew date, else the civil date of death; the record's day and month alone as a last resort. */
export function hebrewDeathDateOf(r: SfRow): string | null {
  const day = typeof r.Hebrew_Day__c === "number" ? r.Hebrew_Day__c : str(r.Hebrew_Day__c);
  return hebrewDateOfDeath({ text: str(r.Hebrew_Date_of_Death_In_Hebrew__c), day, month: str(r.Hebrew_Month__c) }, deathDateOf(r));
}
