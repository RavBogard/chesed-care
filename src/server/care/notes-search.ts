/**
 * Search across notes ("In notes" on /find): care item summaries, contact log notes, follow-up titles and outcome lines,
 * and agenda entries. Clergy level only; no Salesforce; the query text is never logged or stored.
 *
 * Visibility is applied IN THE SQL of every source, with the predicates the rest of the app uses
 * (careItemVisibleWhere, contactEntryVisibleWhere + contactNoteReadableWhere, followUpVisibleWhere, agendaEntryVisibleWhere
 * in src/server/access/policy.ts). A row the viewer may not read is never selected, so it cannot reach a count, an ordering,
 * a page boundary or a snippet. A private note matches only for its author. Text that the retention job purged is null, so it
 * is naturally absent.
 *
 * Matching: Postgres full-text with the `simple` configuration (no stemming, no stop-word guessing) and prefix matching on each
 * word, plus an ILIKE on the person's name. pg_trgm is not enabled in this database, so none is used.
 */
import { and, desc, ilike, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { personPath } from "@/lib/care-labels";
import { agendaEntryVisibleWhere, canSearchNotes, careItemVisibleWhere, contactEntryVisibleWhere, contactNoteReadableWhere, deny, followUpVisibleWhere, type Actor } from "@/server/access/policy";
import { agendaEntries, careItems, contactLog, followUps } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { withinLimit } from "@/server/meals/rate-limit";
import { auditRestrictedReadsByItem } from "./audit";
import { InvalidInput, TooMany } from "./validate";

export const MIN_QUERY = 3;
export const MAX_QUERY = 60;
export const PAGE_SIZE = 20;
/** Searches per person per clock hour. */
export const SEARCHES_PER_HOUR = 60;
/** No page starts beyond this many hits in: a deeper search is narrowed instead. */
export const MAX_OFFSET = 500;
/** Each search is cut off after this long (set for its own transaction only). */
export const STATEMENT_TIMEOUT_MS = 5000;

export type HitKind = "care_item" | "contact" | "follow_up" | "agenda";
export type NoteHit = { kind: HitKind; id: string; snippet: string; at: Date; careItemId: string | null };
export type NoteGroup = { key: string; name: string; href: string | null; hits: NoteHit[]; newest: Date };
export type NoteSearch = { groups: NoteGroup[]; hasMore: boolean; offset: number; shown: number };

/** The words of a query as a prefix tsquery string ("word:* & word:*"), or null when none is usable. Only letters and digits survive. */
export function prefixQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return words && words.length > 0 ? words.map((w) => `${w}:*`).join(" & ") : null;
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const matches = (col: SQL | { _: unknown }, tsq: string): SQL => sql`to_tsvector('simple', coalesce(${col}, '')) @@ to_tsquery('simple', ${tsq})`;

/** A short piece of `text` around the first word of the query that it contains; the start of the text when none shows. Pure. */
export function snippet(text: string, q: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const lower = flat.toLowerCase();
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 50);
  const piece = flat.slice(start, start + 160);
  return `${start > 0 ? "…" : ""}${piece}${start + 160 < flat.length ? "…" : ""}`;
}

type Raw = { kind: HitKind; id: string; text: string; at: Date; careItemId: string | null; sfContactId: string | null; outsidePersonId: string | null; name: string | null };

export async function searchNotes(db: Db, actor: Actor, query: unknown, opts: { offset?: number } = {}, now: Date = new Date()): Promise<NoteSearch> {
  if (!canSearchNotes(actor)) deny();
  const q = typeof query === "string" ? query.trim() : "";
  if (q.length < MIN_QUERY || q.length > MAX_QUERY) throw new InvalidInput("query");
  const tsq = prefixQuery(q);
  if (!tsq) throw new InvalidInput("query");
  if (!(await withinLimit(db, `find-notes:${actor.id}`, SEARCHES_PER_HOUR, now))) throw new TooMany();
  const offset = Math.min(MAX_OFFSET, Math.max(0, Math.floor(opts.offset ?? 0)) || 0);
  const want = offset + PAGE_SIZE + 1;
  const name = like(q);

  const [items, contacts, steps, agenda] = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`);
    return Promise.all([
    tx
      .select({ id: careItems.id, text: careItems.summary, at: careItems.updatedAt, sfContactId: careItems.sfContactId, outsidePersonId: careItems.outsidePersonId, name: careItems.displayName })
      .from(careItems)
      .where(and(careItemVisibleWhere(actor), isNotNull(careItems.summary), or(matches(careItems.summary, tsq), ilike(careItems.displayName, name))))
      .orderBy(desc(careItems.updatedAt))
      .limit(want),
    tx
      .select({ id: contactLog.id, text: contactLog.note, at: contactLog.occurredAt, careItemId: contactLog.careItemId, sfContactId: contactLog.sfContactId, outsidePersonId: contactLog.outsidePersonId, name: contactLog.displayName })
      .from(contactLog)
      .where(and(contactEntryVisibleWhere(actor), contactNoteReadableWhere(actor), isNotNull(contactLog.note), or(matches(contactLog.note, tsq), ilike(contactLog.displayName, name))))
      .orderBy(desc(contactLog.occurredAt))
      .limit(want),
    tx
      .select({ id: followUps.id, title: followUps.title, outcome: followUps.outcomeNote, at: followUps.updatedAt, careItemId: followUps.careItemId, sfContactId: followUps.sfContactId, outsidePersonId: followUps.outsidePersonId, name: followUps.displayName })
      .from(followUps)
      .where(and(followUpVisibleWhere(actor), or(matches(followUps.title, tsq), matches(followUps.outcomeNote, tsq), ilike(followUps.displayName, name))))
      .orderBy(desc(followUps.updatedAt))
      .limit(want),
    tx
      .select({ id: agendaEntries.id, why: agendaEntries.why, outcome: agendaEntries.outcome, free: agendaEntries.displayName, at: agendaEntries.createdAt, careItemId: agendaEntries.careItemId, sfContactId: agendaEntries.sfContactId, outsidePersonId: agendaEntries.outsidePersonId })
      .from(agendaEntries)
      .where(and(agendaEntryVisibleWhere(actor), or(matches(agendaEntries.why, tsq), matches(agendaEntries.outcome, tsq), matches(agendaEntries.displayName, tsq), ilike(agendaEntries.displayName, name))))
      .orderBy(desc(agendaEntries.createdAt))
      .limit(want),
    ]);
  });

  const raw: Raw[] = [
    ...items.map((r): Raw => ({ kind: "care_item", id: r.id, text: r.text ?? "", at: r.at, careItemId: r.id, sfContactId: r.sfContactId, outsidePersonId: r.outsidePersonId, name: r.name })),
    ...contacts.map((r): Raw => ({ kind: "contact", id: r.id, text: r.text ?? "", at: r.at, careItemId: r.careItemId, sfContactId: r.sfContactId, outsidePersonId: r.outsidePersonId, name: r.name })),
    ...steps.map((r): Raw => ({ kind: "follow_up", id: r.id, text: pick(q, r.title, r.outcome), at: r.at, careItemId: r.careItemId, sfContactId: r.sfContactId, outsidePersonId: r.outsidePersonId, name: r.name })),
    ...agenda.map((r): Raw => ({ kind: "agenda", id: r.id, text: pick(q, r.why, r.outcome, r.free), at: r.at, careItemId: r.careItemId, sfContactId: r.sfContactId, outsidePersonId: r.outsidePersonId, name: r.free })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));

  const page = raw.slice(offset, offset + PAGE_SIZE);
  // Full reads of restricted items (ids only, never the query).
  await auditRestrictedReadsByItem(db, actor, page.map((r) => r.careItemId));
  const groups = new Map<string, NoteGroup>();
  for (const r of page) {
    const key = r.sfContactId ? `sf:${r.sfContactId}` : r.outsidePersonId ? `outside:${r.outsidePersonId}` : "none";
    const href = r.sfContactId || r.outsidePersonId ? personPath(r) : null;
    const g = groups.get(key) ?? { key, name: key === "none" ? "Not about one person" : (r.name ?? "A person"), href, hits: [], newest: r.at };
    g.hits.push({ kind: r.kind, id: r.id, snippet: snippet(r.text, q), at: r.at, careItemId: r.careItemId });
    groups.set(key, g);
  }
  return { groups: [...groups.values()], hasMore: raw.length > offset + PAGE_SIZE && offset + PAGE_SIZE < MAX_OFFSET, offset, shown: page.length };
}

/** Of several candidate texts, the first that holds a word of the query (else the first that exists). */
function pick(q: string, ...texts: (string | null)[]): string {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const present = texts.filter((t): t is string => !!t);
  return present.find((t) => words.some((w) => t.toLowerCase().includes(w))) ?? present[0] ?? "";
}
