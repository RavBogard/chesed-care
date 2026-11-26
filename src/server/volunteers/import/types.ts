/** The shapes the spreadsheet import passes between its steps. Plain data. */
import type { CanDo, HowOften } from "@/lib/can-do";

/** The file the import reads: raw cell values per tab, as the Google Sheets values API gives them (rows may be ragged). */
export type SheetFile = { tabs: Record<string, unknown[][]> };

/** One person as one row of one tab said it. */
export type SheetPerson = {
  tab: string;
  /** The row number in the sheet, from 1. */
  row: number;
  firstName: string;
  lastName: string | null;
  markers: string[];
  emails: string[];
  phones: string[];
  zip: string | null;
  address: string | null;
  city: string | null;
  canDo: CanDo[];
  /** Offers with no category in the app, as words. */
  offers: string[];
  frequency: string | null;
  howOften: HowOften | null;
  notes: string[];
  /** For the lead and clergy level only: whom they helped, and titles that may name a member. */
  history: string[];
  okToText: boolean | null;
  coordinatorInterest: boolean | null;
  /** ISO date-time. */
  formAt: string | null;
  /** ISO date-time: "date info entered" on the old sheet. */
  enteredAt: string | null;
  /** On "IL members" without the "*" that marks a volunteer: a member, not a volunteer. */
  notVolunteered: boolean;
  /** A hash of the tab and the row's content: the same row is recognised on a re-run (set by readFile). */
  fingerprint: string;
};

/** Labels the import could not map, and rows it could not read (tab and row number only). */
export type TabResult = { people: SheetPerson[]; unparsed: number[]; unmappedOffers: string[] };

/** The same person across tabs and rows, merged. */
export type MergedPerson = {
  firstName: string;
  lastName: string | null;
  markers: string[];
  emails: string[];
  phones: string[];
  zip: string | null;
  address: string | null;
  city: string | null;
  canDo: CanDo[];
  offers: string[];
  frequency: string | null;
  howOften: HowOften | null;
  notes: string[];
  history: string[];
  okToText: boolean | null;
  coordinatorInterest: boolean | null;
  formAt: string | null;
  enteredAt: string | null;
  sources: string[];
  /** Every row came from "IL members" without a volunteer "*". */
  notVolunteered: boolean;
  fingerprints: string[];
  /** Where each part came from: tab and row, for the counts and the preview. */
  rows: { tab: string; row: number }[];
};
