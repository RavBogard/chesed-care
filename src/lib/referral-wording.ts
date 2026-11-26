/** The words of a referral to Mitzvah Corps, in one place so they can be read and changed together. No database, no server code. */
export const REFERRAL_KINDS = ["call", "meal", "soup", "visit", "ride", "other", "ask"] as const;
export type ReferralKind = (typeof REFERRAL_KINDS)[number];
export const REFERRAL_CONSENTS = ["yes", "coordinator_asks", "rabbi_asks"] as const;
export type ReferralConsent = (typeof REFERRAL_CONSENTS)[number];
export const REFERRAL_LIMITS = { contactLine: 200, alreadyInvolved: 200, note: 300, outcomeLine: 200 } as const;

export const REFER_LABEL = "Refer to Mitzvah Corps";
export const REFER_SECTION = "Mitzvah Corps";
export const REFER_INTRO = "The Mitzvah Corps coordinator sees the name and what you write here, and nothing else from the care record. The other rabbis see that this person was referred, not by whom.";
/** Under the intro on the form. What to tell the coordinator is the rabbi's to decide (Daniel, 2026-11-25); the app does not police it. */
export const REFER_HELP = "Tell her what she needs to know. You decide how much.";

export const REFERRAL_KIND_WORDS: Record<ReferralKind, string> = {
  call: "A phone call",
  meal: "A meal",
  soup: "Soup",
  visit: "A visit",
  ride: "A ride",
  other: "Something else",
  ask: "Not sure, please ask them",
};

/** The three answers on the form, as the rabbi reads them. */
export const CONSENT_CHOICES: Record<ReferralConsent, string> = {
  yes: "They said yes to Mitzvah Corps",
  coordinator_asks: "Not asked yet. The coordinator should ask them",
  rabbi_asks: "A rabbi will ask first. Do not contact them yet",
};

/** The same answers, as the coordinator reads them on a referral. */
export const CONSENT_LINES: Record<ReferralConsent, string> = {
  yes: "They have said yes to Mitzvah Corps.",
  coordinator_asks: "They have not been asked yet. Please ask them first.",
  rabbi_asks: "A rabbi will ask them first. Please do not contact them yet.",
};

export const REFER_LABELS = {
  kind: "What kind of help",
  consent: "Have they said yes",
  contactLine: "Best way to reach them (optional)",
  mayShareAddress: "The address may be given to a volunteer",
  alreadyInvolved: "Who is already involved (optional)",
  note: "Anything practical (optional)",
} as const;
export const REFER_PLACEHOLDERS = { contactLine: "Her mobile, afternoons", alreadyInvolved: "A rabbi has called. Family in town" } as const;
export const REFER_SENT = "Sent to Mitzvah Corps.";

export const ADDRESS_WORDS = { yes: "The address may be given to a volunteer.", no: "Please do not give out the address." } as const;
export const SHOWN_LABELS = { contactLine: "Reach them", alreadyInvolved: "Already involved", note: "Note" } as const;

export const REFERRALS_SECTION = "Referred by the rabbis";
export const TAKE_LABEL = "I'll take this";
export const TAKEN_OK = "It is yours.";
export const TAKEN_ALREADY = "Someone has already taken this.";
export const TAKE_WAITS = "A rabbi is asking them first. You can take this once they have.";
export const DONE_LABEL = "Done";
export const DONE_TITLE = "Mark this done";
export const DONE_CONFIRM = "Mark done";
export const OUTCOME_LABEL = "How it went, in a line (optional)";
export const OUTCOME_HELP = "The rabbis will see it. Logistics only, please: no health details.";
export const DECLINED_LABEL = "They said no thank you";
export const DECLINED_TITLE = "They said no thank you?";
export const DECLINED_EXPLAIN = "This closes the referral. The rabbis will see that the person said no for now.";
export const CLOSED_OK = "Closed. The rabbis will see it.";

export const WITHDRAW_LABEL = "Withdraw";
export const WITHDRAW_TITLE = "Withdraw this referral?";
export const WITHDRAW_EXPLAIN = "It comes off the coordinator's list at once. Tell the coordinator yourself if someone has already started.";
export const WITHDRAWN_OK = "Withdrawn.";
/** On the person's page while a rabbi is asking first: the two ways to say it is settled. */
export const CONSENT_NOW = { yes: "They said yes", coordinator_asks: "The coordinator should ask them" } as const;
export const CONSENT_SAVED = "Saved. The coordinator can go ahead.";

export const takenWords = (name: string | null) => (name ? `taken by ${name}` : "waiting");
export const referredWords = (date: string, takenBy: string | null) => `Referred on ${date} · ${takenWords(takenBy)}`;
export const referredByWords = (name: string, date: string) => `Referred by ${name}, ${date}`;
export const CLOSED_WORDS = { done: "Done", declined: "They said no thank you", withdrawn: "Withdrawn" } as const;
export const PAST_REFERRALS = "Earlier referrals";
export const olderReferralsWords = (n: number) => (n === 1 ? "And 1 older referral." : `And ${n} older referrals.`);
