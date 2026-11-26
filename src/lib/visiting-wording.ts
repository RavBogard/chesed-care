/** The words of the volunteer visiting list, in one place so they can be read and changed together. */
export const VISITING_NAME = "Visiting list";
export const VISITING_INTRO = "Members whom a volunteer visits regularly. The clergy decide who is on this list. No health details are kept here.";
export const VISITING_EMPTY = "Nobody is on the visiting list yet. The clergy add people from their page.";
export const VISITING_HINT = "Volunteers' coordinator sees this. No health details.";
export const VISITING_ON_LIST = "On the volunteer visiting list";
export const VISITING_ADD_LABEL = "Add to the visiting list";
export const VISITING_LABELS = { place: "Where (a care home or an address)", contactLine: "Who to contact (optional)", note: "Note for the visitor (optional)" } as const;
export const visitorWords = (name: string | null) => (name ? `Regular visitor: ${name}` : "No regular visitor yet");
export const lastVisitWords = (date: string | null) => (date ? `Last visit ${date}` : "Not visited yet");
export const visitCountWords = (n: number) => (n === 1 ? "1 visit logged" : `${n} visits logged`);
export const NO_VISITOR = "No regular visitor";
