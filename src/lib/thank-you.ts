/**
 * The "Thank them" link: opens the clergy member's OWN mail app with a short editable body. The body is fixed words:
 * nothing about the person in care (no name, no category, no detail). PURE: no I/O. The app sends nothing itself.
 */
export const THANK_SUBJECT = "Thank you";
export const THANK_BODY = "Thank you for letting us know. We're on it.";

export function thankYouMailto(email: string): string {
  return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}?subject=${encodeURIComponent(THANK_SUBJECT)}&body=${encodeURIComponent(THANK_BODY)}`;
}
