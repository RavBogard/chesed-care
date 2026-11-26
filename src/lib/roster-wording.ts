/** Every word of the Mitzvah Corps roster, the join form and the coordinator home, in one place so the wording can be read and changed together. */
import { APP_NAME, CONGREGATION_NAME } from "./brand";
import type { CanDo, HowOften, PreferContact } from "@/lib/can-do";

export const JOIN_NAME = "Join Mitzvah Corps";
export const JOIN_PATH = "/join";
export const JOIN_INTRO = `Mitzvah Corps is the group of people at ${CONGREGATION_NAME} who help when someone needs a hand: a visit, a call, a meal, a ride. Tell us how you would like to help.`;
export const JOIN_SIGN_LINE = "Would you like to help when someone in our community needs a hand? Scan the code or visit the link to join Mitzvah Corps.";
export const JOIN_LABELS = {
  firstName: "First name",
  lastName: "Last name",
  contact: "Email or mobile number",
  canDo: "What would you like to help with?",
  availability: "When are you usually free? (optional)",
  consent: "Mitzvah Corps coordinators and clergy will see this and may contact you about ways to help.",
} as const;
export const JOIN_AVAILABILITY_HINT = "For example: weekday mornings, or most Sundays.";
export const JOIN_SUBMIT = "Join Mitzvah Corps";
export const JOIN_SENDING = "Sending";
export const JOIN_THANKS_HEADING = "Thank you";
export const JOIN_THANKS = "Thank you for offering to help. A coordinator may be in touch when there is something that fits. You can say stop at any time.";
export const JOIN_REFUSED = {
  stale: "This page was open for a while. Please reload it and send again.",
  invalid: "Please check what you entered and try again.",
  limited: "Too many tries just now. Please wait a little and try again.",
  capped: "We could not take this just now. Please try again later, or call the office.",
  refused: "We could not take that just now. Please try again in a minute.",
  unknown: "Something went wrong. Please try again in a minute.",
} as const;
export type JoinReason = keyof typeof JOIN_REFUSED;

export const STOP_HEADING = "Stop asking me";
export const STOP_EXPLAIN = "If you stop, Mitzvah Corps will not ask you to help again. The congregation keeps your contact details. Thank you for all you have done.";
export const STOP_BUTTON = "Yes, stop asking me";
export const STOP_DONE_HEADING = "You are off the list";
export const STOP_DONE = "We will not ask you again. Thank you for the help you gave, and for being willing.";
export const STOP_FAILED = "That did not work. Please try again in a minute, or tell the person who sent you this link.";

export const CAN_DO_LABEL: Record<CanDo, string> = {
  visits: "Visits",
  calls: "Phone calls",
  meals: "Meals",
  rides: "Rides",
  shiva_minyan: "Shiva minyan",
  errands: "Errands",
  soup: "Making soup",
  baking: "Baking challah",
  care_packages: "Care packages",
  house_sitting: "Staying at a house during a funeral",
  other: "Something else",
};

export const HOW_OFTEN_LABEL: Record<HowOften, string> = {
  once_a_year: "About once a year",
  twice_a_year: "About twice a year",
  quarterly: "About every three months",
  monthly: "About once a month",
  as_needed: "As often as you need me",
};
export const PREFER_CONTACT_LABEL: Record<PreferContact, string> = { email: "Email", text: "Text message", call: "Phone call" };
export const HOW_OFTEN_QUESTION = "How often would you like us to ask you?";
export const PREFER_CONTACT_QUESTION = "How do you prefer to hear from us?";
export const NOT_CHOSEN = "No preference";
export const ASKED_RECENTLY = "Asked recently for what they chose";
export const prefersWords = (c: PreferContact) => `Prefers ${PREFER_CONTACT_LABEL[c].toLowerCase()}`;

export const ROSTER_HINTS = {
  notes: "For coordinators only. Never anything medical or pastoral: logistics, like \"prefers texts\" or \"no driving at night\".",
  availability: "A short line, like \"weekday mornings\".",
  area: "A neighbourhood or ZIP code, for rides and visits.",
  contact: "At least one: an email, a mobile number, or both.",
  noExport: "Contact details are shown here and when you copy them to ask for help. They cannot be exported.",
} as const;
export const SOURCE_LABEL = { form: "Joined by the form", coordinator: "Added by a coordinator", ask_again: "Said \"ask me again\"" } as const;
export const STATUS_LABEL = { active: "Active", paused: "Paused", left: "Left", pending: "Waiting" } as const;
export const PENDING_HEADING = "Waiting for you to accept";
export const PENDING_NOTE = "People who used the sign-up page. They are not asked about anything until you accept them, and are deleted after 14 days if you do not.";
export const stoppedSelfWords = (date: string) => `They asked us to stop on ${date}.`;
/** The confirmation before bringing back someone who stopped: it does not claim that they asked, only that the sign-up page was used. */
export const returnConfirmWords = (askedOn: string | null, stoppedOn: string | null) => `Someone used the sign-up page with this contact${askedOn ? ` on ${askedOn}` : ""}. They asked us to stop${stoppedOn ? ` on ${stoppedOn}` : " before"}. Only bring them back if you have checked with them.`;
export const askedAgainWords = (date: string) => `Asked to join again on ${date}.`;
export const NOT_ASKED_BACK = "They have not asked to return, so they cannot be brought back.";
export const STOP_LINK_REPLACES = "This makes a new link and replaces the old one: anyone holding the old link can no longer use it. It is shown once.";
export const ROSTER_EMPTY = "Nobody is on the roster yet. Share the sign-up page, add someone, or bring in past helpers who said ask me again.";
export const PAST_HELPERS_HEADING = "Past helpers who said ask me again";
export const PAST_HELPERS_NOTE = "They ticked the box when they helped. One tap puts them on the roster; you can fill in what they can do afterwards.";
export const helpedWords = (last: string | null, n: number) => (last ? `${n} in the last 12 months` : "Has not helped yet");

export const ASK_HEADING = "Ask the roster";
export const ASK_INTRO = `Tick the people to ask. You can send the ask by email from ${APP_NAME}, or get their addresses and numbers to use from your own mail app or phone, with a message already written.`;
export const ASK_EMAIL_BUTTON = `Send from ${APP_NAME}`;
export const ASK_EMAIL_TOO_MANY = `Pick at most 60 people to send from ${APP_NAME} at once.`;
export const ASK_EMAIL_OFF = "Email is not set up yet. Use your own mail app instead.";
export const askEmailResult = (sent: number, noEmail: number, notSent: number) =>
  [`Sent to ${sent}`, noEmail > 0 ? `${noEmail} had no email address` : null, notSent > 0 ? `${notSent} could not be sent` : null].filter(Boolean).join(". ") + ".";
export const ASK_EMPTY = "Nobody on the roster can be asked about this yet.";
export const ASK_SUBMIT = "Get their contacts";
export const ASK_RECORDED = "Noted as asked today.";
export const askedWords = (when: string | null) => (when ? `Asked ${when}` : "Not asked yet");

export const HOME_SECTIONS = { asked: "Asked for help", needs: "Needs someone", steps: "My steps", meals: "Meals", changes: "Changed since yesterday", week: "This week" } as const;
export const HOME_EMPTY = {
  needs: "Nothing is waiting for someone right now.",
  steps: "No Mitzvah Corps steps are waiting for you.",
  meals: "No open nights in the next seven days.",
  changes: "Nothing has changed in the last two days.",
  week: "Nothing is filled yet this week.",
} as const;
export const daysLeftWords = (n: number) => (n === 0 ? "Today" : n === 1 ? "Tomorrow" : `${n} days left`);
export const CHANGE_WORDS = {
  signed_up: (who: string, what: string) => `${who} signed up for ${what}`,
  gave_back: (who: string, what: string) => `${who} gave back ${what}`,
  removed: (who: string, what: string) => `${who} was taken off ${what}`,
  done: (who: string, what: string) => `${who} finished ${what}`,
  meal_signed_up: (who: string, what: string) => `${who} signed up for meals for ${what}`,
  meal_cancelled: (who: string, what: string) => `${who} cancelled a meal for ${what}`,
} as const;

export const CORPS_NOTE_LABEL = "For Mitzvah Corps";
export const CORPS_NOTE_HINT = "Logistics only. Nothing medical or private: the coordinator and volunteers may see this.";
export const CORPS_NOTE_SHOWN = "From the clergy";

export const SERIES_LABELS = {
  repeat: "Repeats",
  none: "Once",
  weekly: "Every week",
  biweekly: "Every two weeks",
  days: "On these days",
  end: "Ends",
  count: "After a number of times",
  until: "On a date",
  times: "Number of times (up to 26)",
  untilDate: "Last date",
} as const;
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const EVERY_TIME_BUTTON = "I can do this every time";
export const EVERY_TIME_NOTE = "Signs you up for every date still open in this series, on one page of your own.";
