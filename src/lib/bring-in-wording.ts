import type { LastContact } from "@/server/care/bring-in-rules";

/** How the "last contact was about ... ago" choices read. */
export const LAST_CONTACT_LABEL: Record<LastContact, string> = {
  today: "Today",
  week: "This week",
  month: "This month",
  longer: "Longer ago",
  unsure: "Not sure",
};
