/**
 * The text of a value with random ids, link tokens and timestamps removed. A check such as
 * "this must not contain Sam" is about words the app might leak, and a random token
 * can spell a short word by chance (which made such checks fail now and then).
 */
export function words(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "").replace(/[A-Za-z0-9_-]{20,}/g, "");
}
