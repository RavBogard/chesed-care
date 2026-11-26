/**
 * A calendar file for one delivery: the title, the date, the drop-off window and
 * the address. PURE. Nothing else goes in: no food needs, no instructions, no
 * reason, so a shared or synced calendar says nothing about the household's health.
 */

export const escapeText = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n?|[\n\u0085\u2028\u2029]/g, "\\n");

/** Lines are folded at 75 octets (RFC 5545), never inside a character. */
export function fold(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join("\r\n ");
}

const compact = (dateKey: string) => dateKey.replace(/-/g, "");

/** One all-day event as a calendar file. `product` names the feature in PRODID, `uidDomain` follows the "@" of the UID. */
export function allDayIcs(e: { product: string; uidDomain: string; uid: string; stamp: Date; date: string; nextDay: string; summary: string; location: string | null; description: string | null }): string {
  const stamp = e.stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//Central Reform Congregation//${e.product}//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.uid}@${e.uidDomain}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compact(e.date)}`,
    `DTEND;VALUE=DATE:${compact(e.nextDay)}`,
    `SUMMARY:${escapeText(e.summary)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export type DeliveryEvent = { uid: string; date: string; nextDay: string; summary: string; address: string | null; window: string | null; stamp: Date };

export function deliveryIcs(e: DeliveryEvent): string {
  return allDayIcs({ product: "Mitzvah Meals", uidDomain: "mitzvah-meals", uid: e.uid, stamp: e.stamp, date: e.date, nextDay: e.nextDay, summary: e.summary, location: e.address, description: e.window ? `Drop-off: ${e.window}` : null });
}
