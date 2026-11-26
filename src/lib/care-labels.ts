/** Words for the care records, shared by every screen. */
import type { CareStatus } from "@/server/care/status";
import { isPausedCareItem } from "@/server/care/status";
import { monthDay } from "./format";

export const CATEGORY_LABEL = {
  illness: "Illness",
  bereavement: "Bereavement",
  birth: "New baby",
  ongoing: "Ongoing",
  caregiver: "Caregiver",
  life_change: "Life change",
  mental_health: "Mental health",
  simcha: "Simcha",
  other: "Other",
} as const;
export type CategoryKey = keyof typeof CATEGORY_LABEL;
export const CATEGORY_KEYS = Object.keys(CATEGORY_LABEL) as CategoryKey[];

export const OUTCOME_LABEL = { spoke: "Spoke", no_answer: "No answer", left_message: "Left a message", visited: "Visited", texted: "Texted" } as const;
export type OutcomeKey = keyof typeof OUTCOME_LABEL;
export const OUTCOME_KEYS = Object.keys(OUTCOME_LABEL) as OutcomeKey[];
/** What kind of contact each outcome was (the same mapping the server uses for Done and log it). */
export const OUTCOME_KIND = { spoke: "call", no_answer: "call", left_message: "call", visited: "visit", texted: "text" } as const satisfies Record<OutcomeKey, "call" | "visit" | "text">;

export const ROLE_OPTIONS = [
  { role: "clergy", label: "Clergy", help: "sees every care record that is not restricted, and the dates" },
  { role: "caregiver", label: "Caregiver", help: "sees only the care items given to them" },
  { role: "staff", label: "Staff", help: "reports a need, adds a member to a rabbi's care list or a name to the Mi Sheberach list, and sees neither list" },
  { role: "lead", label: "Mitzvah Corps lead", help: "runs volunteer tasks, Mitzvah Meals, the roster and the visiting list; adds people as staff do; never sees clergy notes" },
  { role: "senior_staff", label: "Senior staff", help: "reports a need and sees the numbers, without names" },
] as const;

/** A care item's state in words: New, Open, or Paused until a day (Closed for a closed one). */
export function statusLabel(item: { status: CareStatus; pausedUntil: string | null }, today: string): string {
  if (item.status === "closed") return "Closed";
  if (item.status === "new") return "New";
  if (isPausedCareItem(item, today)) return `Paused until ${monthDay(item.pausedUntil!)}`;
  return "Open";
}

export const REPORT_STATUS = (r: { status: "pending" | "accepted" | "dismissed"; pickedUpBy: string | null }): string => {
  if (r.status === "pending") return "Waiting";
  if (r.status === "dismissed") return "Closed without action";
  return r.pickedUpBy ? `Picked up by ${r.pickedUpBy}` : "Picked up";
};

/** Where a person's page is: Salesforce people by Contact Id, outside people under /people/outside. */
export function personPath(who: { sfContactId?: string | null; outsidePersonId?: string | null }): string {
  return who.outsidePersonId ? `/people/outside/${who.outsidePersonId}` : `/people/${who.sfContactId ?? ""}`;
}
