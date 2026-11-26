/**
 * The calm sentences every public (no account) side shares when it refuses something. Each side adds
 * its own cases (a night just taken, a date that has passed) and its own words for its fields.
 */

const listWords = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * The sentence for a refusal. `own` holds the reasons one side words for itself, and wins; `fields` are
 * the names of the fields that were wrong, never their values; `fieldWords` names them for the reader.
 */
export function publicRefusal<R extends string>(reason: R, fields: string[], own: Partial<Record<R, string>>, fieldWords: Record<string, string>): string {
  const mine = own[reason];
  if (mine !== undefined) return mine;
  switch (reason) {
    case "rate_limited":
      return "That was a lot of tries from one place. Please wait a little while and try again.";
    case "refused":
      return "Sorry, we could not complete that. If you think this is a mistake, please ask whoever sent you the link.";
    case "stale":
      return "This form has been open for a long time. Please reload the page and try again.";
    case "invalid": {
      if (fields.includes("clientMeta")) return "Please reload the page and try again.";
      const named = [...new Set(fields.map((f) => fieldWords[f]).filter(Boolean))];
      return named.length ? `Please check ${listWords(named)}.` : "Please check what you entered and try again.";
    }
    default:
      return "Something went wrong. Please try again.";
  }
}
