/**
 * Every word the app puts in an email. PURE: each function is given only what its email may say (a date, a link), so a
 * name, a place, a note or a diagnosis cannot reach it. Plain text, ending with the congregation's name.
 */
import { longDate } from "@/lib/format";

export type Mail = { subject: string; text: string };

const SIGN = "Central Reform Congregation";
const mail = (subject: string, ...paragraphs: string[]): Mail => ({ subject, text: `${paragraphs.join("\n\n")}\n\n${SIGN}` });
const KEEP = "Please keep this email: that link is the only way back to your page.";

/** The morning summary: the app's counts-only message, which already ends with the link to the app. */
export function morningSummaryMail(body: string): Mail {
  return mail("CRC Care this morning", body);
}

export function mealSignupMail(input: { date: string; pageUrl: string }): Mail {
  return mail(
    "Thank you for bringing a meal",
    `Thank you for signing up to bring a meal on ${longDate(input.date)}.`,
    `The address, the family's notes and a way to change or cancel are on your own page:\n${input.pageUrl}`,
    KEEP,
  );
}

export function volunteerSignupMail(input: { date: string; pageUrl: string; repeating: boolean }): Mail {
  return mail(
    "Thank you for helping",
    `Thank you for signing up to help ${input.repeating ? "starting" : "on"} ${longDate(input.date)}.`,
    `The details and a way to change or cancel are on your own page:\n${input.pageUrl}`,
    KEEP,
  );
}

export function joinMail(input: { stopUrl: string }): Mail {
  return mail("Welcome to Mitzvah Corps", "Thank you for offering to help. A coordinator will be in touch when something comes up that fits what you chose.", `To stop hearing from us at any time:\n${input.stopUrl}`);
}

/** Asking a roster member: the app's own ask words (askBody) and a link that stops these emails. */
export function askMail(input: { askText: string; stopUrl: string }): Mail {
  return mail("Can you help?", `${input.askText}\n\nTo stop these emails: ${input.stopUrl}`);
}

export function reminderMail(input: { what: "meal" | "help"; date: string }): Mail {
  return mail(
    input.what === "meal" ? "Tomorrow: your meal" : "Tomorrow: you're helping",
    `A reminder that you signed up to ${input.what === "meal" ? "bring a meal" : "help"} tomorrow, ${longDate(input.date)}.`,
    "The details are on your own page. The link is in the email we sent when you signed up.",
  );
}

/**
 * Put at the top of the first email of any kind to someone brought in from the old Mitzvah Corps spreadsheet, once the
 * owner has turned their email on: what this is, and how to stop it.
 */
export function importedIntro(stopUrl: string): string {
  return `Central Reform Congregation's Mitzvah Corps now asks for help through this app, CRC Care, and you were on our volunteer list. To stop hearing from us: ${stopUrl}`;
}
