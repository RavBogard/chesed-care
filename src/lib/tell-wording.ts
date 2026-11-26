/** Every word of the public "Let the clergy know" form and its sign. Each is listed for Daniel in the pull request. */
export const TELL_PATH = "/tell";
export const TELL_NAME = "Let the clergy know";
export const TELL_INTRO = "If someone in our community is ill, grieving or in need of care, tell us here. One of our clergy reads every message.";
export const TELL_LABELS = {
  about: "Who is this about?",
  what: "What is happening?",
  sender: "Your name",
  contact: "How can we reach you? An email or a phone number.",
  mayTellThem: "May we tell them you let us know?",
  miSheberach: "May we add their name to the Mi Sheberach (healing prayers) list?",
  help: "What kind of help is this?",
} as const;
/** The two answers to "What kind of help is this?". */
export const TELL_HELP_ANSWERS = { clergy: "Something the clergy should know", practical: "Practical help from Mitzvah Corps, like a meal, a ride or soup" } as const;
/** Under the help choice: who sees a practical request. */
export const TELL_HELP_NOTE = "The Mitzvah Corps coordinator sees practical requests as well as the clergy. Please leave out medical details.";
/** Shown under the "May we tell them" question: what is kept of the sender, and for how long. */
export const TELL_KEEP = "If we act on your message, we keep your name and email for 30 days so a member of the clergy can thank you, then delete them.";
export const TELL_ANSWERS = { yes: "Yes", no: "No", not_sure: "Not sure" } as const;
export const TELL_SUBMIT = "Send to the clergy";
export const TELL_SENDING = "Sending";
export const TELL_THANKS_HEADING = "Thank you";
export const TELL_THANKS = "Your message has gone to the clergy. If it cannot wait, please call the synagogue office.";
export const TELL_PRIVACY = "Your message goes only to the clergy. It is not shared.";
export type TellReason = "stale" | "invalid" | "limited" | "refused" | "unknown";
export const TELL_REFUSED: Record<TellReason, string> = {
  stale: "This page has been open a while. Please reload it and try again.",
  invalid: "Please fill in every box so we can read your message.",
  limited: "Many messages have been sent just now. Please try again in a little while. You can also phone the office.",
  refused: "We could not send this just now. Please try again.",
  unknown: "We could not send this just now. Please try again.",
};
export const TELL_SIGN_LINE = "Scan to let the clergy know about someone who needs care.";
