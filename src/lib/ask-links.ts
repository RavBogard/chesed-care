/**
 * The mail and text links a coordinator opens on their own phone or computer to ask the roster. PURE: nothing is
 * sent from here. Only what is passed in goes in, every part is percent-encoded, and addresses are checked first,
 * so a name or an odd address can never add a header or a recipient. Names are never used.
 */

import { CONGREGATION_NAME } from "./brand";

/** Most recipients in one link: longer lists are split into several. */
export const ASK_LINK_CAP = 40;
export const ASK_SUBJECT = "Can you help?";

/** An address with nothing in it that could end a header or start a new one. */
const SAFE_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const SAFE_NUMBER = /^\+?\d{7,15}$/;

const chunks = <T,>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** The words the app writes: the task's public text and the public link, nothing else. */
export function askBody(publicText: string, url: string): string {
  return `Can you help? ${CONGREGATION_NAME} has a small request.\n\n${publicText.trim()}\n\nDetails and one tap to sign up: ${url}`;
}

/** Addresses that are safe to put in a link, once each, in order. */
export function safeEmails(emails: string[]): string[] {
  return [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length <= 254 && SAFE_EMAIL.test(e)))];
}

/** Numbers as a phone dials them: digits with an optional leading plus, once each. */
export function safeNumbers(numbers: string[]): string[] {
  const out = numbers.map((n) => {
    const t = n.trim();
    const digits = t.replace(/\D/g, "");
    return t.startsWith("+") ? `+${digits}` : digits;
  });
  return [...new Set(out.filter((n) => SAFE_NUMBER.test(n)))];
}

/** One mailto link per 40 addresses, each with the recipients in BCC so nobody sees the others. */
export function mailtoLinks(emails: string[], subject: string, body: string): string[] {
  return chunks(safeEmails(emails), ASK_LINK_CAP).map((list) => `mailto:?bcc=${list.map(encodeURIComponent).join(",")}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
}

/**
 * One text link for ONE number, never several: a group text shows every recipient everyone else's number. Several
 * numbers give several links. `?&body=` is the form both iPhone and Android read.
 */
export function smsLinks(numbers: string[], body: string): string[] {
  return safeNumbers(numbers).map((n) => `sms:${n}?&body=${encodeURIComponent(body)}`);
}
