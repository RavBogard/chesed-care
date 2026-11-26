/**
 * The words of the Mi Sheberach screens. Every string here is listed for Daniel in the pull
 * request under "Wording for Daniel".
 */
import type { EntryView } from "@/server/misheberach/list";
import { monthDay } from "./format";

export const MI_NAME = "Mi Sheberach";
export const MI_PATH = "/mi-sheberach";

export const KIND_LABEL = { dated: "Comes off after 120 days", standing: "Until further notice" } as const;
export const CONSENT_LABEL = { confirmed: "Agreed", not_confirmed: "Not yet confirmed", asked_not_listed: "Asked not to be listed" } as const;
export const SOURCE_LABEL = { app: "Added in the app", public_form: "From the public form", bima_packet: "From the bima packet" } as const;
export const END_LABEL = {
  expired: "Came off after 120 days",
  removed_by_clergy: "Removed by clergy",
  removed_in_packet: "Removed in the packet",
  recovered: "Recovered",
  died: "Died",
  asked_to_be_removed: "Asked to be removed",
} as const;
/** The reasons clergy choose, with the question each answers. */
export const END_CHOICES = [
  { value: "recovered", label: "Recovered" },
  { value: "removed_by_clergy", label: "Taking the name off" },
  { value: "died", label: "Died" },
  { value: "asked_to_be_removed", label: "Asked to be removed" },
] as const;

/** When a name was added, or that it stays. */
export const whenWords = (e: Pick<EntryView, "kind" | "dateAdded">) => (e.kind === "standing" ? "Until further notice" : `Added ${monthDay(e.dateAdded)}`);
export const comesOffWords = (e: Pick<EntryView, "expiresOn">) => (e.expiresOn ? `Comes off ${monthDay(e.expiresOn)}` : null);

export const NOT_CONNECTED = "The bima packet is not connected yet. The list works on its own; names will not reach the packet until it is connected.";
export const SHARE_WITH = "To connect it, share the packet document with this address (as an editor):";
export const SYNC_LIMITED = "That is enough syncs for now. Try again in a while.";
export const SYNC_DONE = "Synced with the bima packet.";
export const SYNC_NOTHING = "The bima packet is not connected.";

/** What clergy are told when the last run stopped. The packet was not changed by a run that stopped. */
export function syncProblem(errorName: string | null, counts: Record<string, number> | null = null): string {
  if (errorName === "PacketSectionNotFound" || errorName === "PacketSectionAmbiguous" || errorName === "PacketStructureUnexpected" || errorName === "PacketNoBulletRun") {
    return "The last sync with the bima packet stopped. It could not find the Healing Prayers list exactly as expected (the Healing Prayers heading, the bullets, and the line “(end of prayer list)”). Nothing was changed in the packet. Check those in the packet, then press Sync now.";
  }
  if (errorName === "PacketLineNotPlainText") return "The last sync with the bima packet stopped because one line in the Healing Prayers list has something in it that cannot be read as words, such as a picture, a footnote or a page break. Take it out of that line in the packet, then press Sync now. Nothing was changed in the packet.";
  if (errorName === "PacketHasSuggestions") return "The last sync with the bima packet stopped because the Healing Prayers list has suggested edits waiting in it. Accept or reject them in the packet, then press Sync now. Nothing was changed.";
  if (errorName === "PacketChangeTooLarge") {
    const end = counts?.wouldEnd ?? 0;
    const remove = counts?.wouldRemoveLines ?? 0;
    return `The last sync with the bima packet stopped because it would have taken ${end} ${end === 1 ? "name" : "names"} off the list and ${remove} ${remove === 1 ? "line" : "lines"} out of the packet, which is more than it does on its own. Nothing was changed. Look at what it would do below; if it is right, press Apply anyway.`;
  }
  if (errorName === "PacketRevisionConflict") return "The last sync with the bima packet stopped because the packet was being edited at the same time. Nothing was changed. Press Sync now to try again.";
  return "The last sync with the bima packet did not finish, so the packet and this list may differ. Press Sync now to try again.";
}

export const DRY_RUN_NOTE = "The sync is in trial mode: it reads the packet and shows what it would do, and changes nothing yet.";
export const PLAN_TITLE = "What the sync would do";
export const PLAN_NOTHING = "Nothing. The packet and the list agree.";
export const IMPORT_LABEL = "Import the current list";
export const IMPORT_EXPLAIN = "Makes a list entry for every name in the packet, marked as agreed. It does not change the packet.";
export const APPLY_LABEL = "Apply anyway";
export const APPLY_EXPLAIN = "Runs the sync once with the changes shown, although they are larger than it makes on its own. It is recorded.";
export const LEFT_ALONE_WHY = { unreadable: "Not read as a name", duplicate: "Same name as another line", asked_not_listed: "Asked not to be listed", ended_in_app: "Taken off here but still in the packet" } as const;
export const SYNC_BUSY = "A sync is already running. Try again in a minute.";
export const DESCRIBE_LABEL = "Check the packet’s shape";

export const READ_HEADING = "Mi Sheberach";
export const READ_HINT = "Names in the order they are read.";
export const READ_EMPTY = "No names on the list.";

export const PROMPT_TITLE = "Still needed?";
export const promptLine = (expiresOn: string) => `Comes off the Mi Sheberach list on ${monthDay(expiresOn)}.`;
export const RENEW_LABEL = { keep: "Keep 120 more days", standing: "Until further notice", let_off: "Let it come off" } as const;

export const NEEDS_REVIEW = "Changed in the packet. Please look.";
export const ADD_TO_LIST = "Add to the Mi Sheberach list";
export const ASK_NOT_LISTED = "This person asked not to be listed. Add them only after you have checked with them.";
export const CLOSED_PROMPT = (name: string) => `${name} is still on the Mi Sheberach list. Take the name off?`;

/** The illness journey's "ask about ... the Mi Sheberach list" step (and any journey step worded so): it links to the add form. */
export const asksAboutMiSheberach = (f: { title: string; journeyId: string | null; careItemId: string | null }): boolean => !!f.careItemId && !!f.journeyId && /mi sheberach/i.test(f.title);

export const LEFT_ALONE_TITLE = "Lines the sync is leaving alone";
export const BARRED_NOTICE = "This name is still in the packet and would be read aloud.";
export const BARRED_HELP = "The person asked not to be listed. The sync does not take a line out of the packet unless you ask.";
export const REMOVE_BARRED_LABEL = "Remove it from the packet";
export const REMOVE_BARRED_EXPLAIN = "Takes every line of someone who asked not to be listed out of the packet, now. It is recorded.";
export const LEFT_ALONE_KIND = {
  unreadable: "Not read as a name, so left as it is",
  duplicate: "Same name as another entry, so left as it is",
  ended_in_app: "Taken off here but still in the packet",
} as const;
export const LAST_CHECKED = "Last checked";
