export type OccasionType = "yahrzeit" | "shloshim" | "birthday" | "anniversary";

/** One row to act on: whom to text, about what, on which date. */
export type Occasion = {
  type: OccasionType;
  /** The occasion date, YYYY-MM-DD: the yahrzeit observance, the end of shloshim, this year's birthday or anniversary. */
  date: string;
  /** The Salesforce record the occasion comes from (Yahrzeit__c or Contact for deaths, Contact for birthdays, Account for anniversaries). */
  subjectId: string;
  /** Who the occasion is about: the deceased, the birthday person, or the couple's household. */
  personName: string;
  personFirstName: string | null;
  hebrewName: string | null;
  /** A yahrzeit or a shloshim: the Hebrew date of death in Hebrew letters. Null for a celebration, or when no date of death is known. */
  hebrewDeathDate: string | null;
  /** The household to reach: formal greeting ("Michael and Deborah Cohen") and informal ("Mike and Debbie"). */
  household: string | null;
  informalGreeting: string | null;
  accountId: string | null;
  /** The person to text. */
  contactId: string | null;
  contactName: string | null;
  contactFirstName: string | null;
  /** The Hebrew name of the person to text, when Salesforce has one. */
  contactHebrewName: string | null;
  mobile: string | null;
  phone: string | null;
  /** Age, years married, or years since the death (yahrzeit). */
  years: number | null;
  relationship: string | null;
  deathDate: string | null;
  /** A death: the deceased's Contact id when Salesforce has one, so the same death has the same key however it is first seen. */
  deceasedContactId?: string | null;
};
