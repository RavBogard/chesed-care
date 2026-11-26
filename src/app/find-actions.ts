"use server";

import { AccessDenied } from "@/server/access/policy";
import { getViewer } from "@/server/auth/session";
import { InvalidInput, TooMany } from "@/server/care/validate";
import { MAX_OFFSET, searchNotes, type HitKind } from "@/server/care/notes-search";
import { canLoadMore, findPeopleCapped, type PersonMatch } from "@/server/lifecycle/find-people";
import { searchOutsidePeople } from "@/server/care/outside-people";
import { getDb } from "@/server/db/client";
import { getSalesforce } from "@/server/salesforce";

/** A person kept only in this app: not in Salesforce. */
export type OutsideMatch = { id: string; name: string; note: string | null };
export type NotesHitView = { kind: HitKind; id: string; snippet: string; at: string; careItemId: string | null };
export type NotesGroupView = { key: string; name: string; href: string | null; hits: NotesHitView[]; newest: string };
export type NotesState = { status: "idle" } | { status: "results"; groups: NotesGroupView[]; hasMore: boolean; offset: number; shown: number } | { status: "error"; message: string };
export type FindState = { status: "idle" } | { status: "results"; results: PersonMatch[]; outside: OutsideMatch[]; capped: boolean; offset: number } | { status: "error"; message: string };

/** Search by POST so the name never appears in a URL. The text is never logged. */
export async function findPeopleAction(_prev: FindState, form: FormData): Promise<FindState> {
  const viewer = await getViewer();
  if (viewer.kind !== "ok") return { status: "error", message: "Please sign in again." };
  try {
    // "Load more" asks for the next page of the same search; the people outside Salesforce come with the first page only.
    const offset = Number(form.get("offset") ?? 0) || 0;
    const { people: results, capped } = await findPeopleCapped({ sf: getSalesforce }, viewer.actor, form.get("q"), offset);
    const outside = offset > 0 ? [] : (await searchOutsidePeople(getDb(), viewer.actor, form.get("q"))).map((p) => ({ id: p.id, name: p.name, note: p.note }));
    return { status: "results", results, outside, capped: canLoadMore(capped, results.length, offset), offset };
  } catch (error) {
    if (error instanceof AccessDenied) return { status: "error", message: "You do not have access to do that." };
    if (error instanceof InvalidInput) return { status: "error", message: "Please use at least two letters, and only letters in the name." };
    console.error("Find: search unavailable", error instanceof Error ? error.name : "unknown");
    return { status: "error", message: "Salesforce could not be reached just now. Try again in a minute." };
  }
}

/** "In notes": search by POST, so the words never appear in a URL; nothing about the query is logged or stored. No Salesforce call. */
export async function searchNotesAction(_prev: NotesState, form: FormData): Promise<NotesState> {
  const viewer = await getViewer();
  if (viewer.kind !== "ok") return { status: "error", message: "Please sign in again." };
  try {
    const offset = Math.min(Number(form.get("offset") ?? 0) || 0, MAX_OFFSET);
    const found = await searchNotes(getDb(), viewer.actor, form.get("q"), { offset });
    return { status: "results", groups: found.groups.map((g) => ({ ...g, newest: g.newest.toISOString(), hits: g.hits.map((h) => ({ ...h, at: h.at.toISOString() })) })), hasMore: found.hasMore, offset, shown: found.shown };
  } catch (error) {
    if (error instanceof AccessDenied) return { status: "error", message: "You do not have access to do that." };
    if (error instanceof InvalidInput) return { status: "error", message: "Please type at least three letters." };
    if (error instanceof TooMany) return { status: "error", message: "That is enough searching for now. Try again in a while." };
    console.error("Find: notes search unavailable", error instanceof Error ? error.name : "unknown");
    return { status: "error", message: "The search could not run just now. Try again in a minute." };
  }
}
