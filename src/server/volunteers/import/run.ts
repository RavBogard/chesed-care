/**
 * The one-time (and safely re-runnable) import of the old Mitzvah Corps spreadsheet into the roster. The command-line
 * wrapper is scripts/roster-import.ts. A dry run reads the roster and writes nothing; `apply` writes the plan in
 * batches (each one transaction where the driver allows it) and, last, one audit row of counts.
 *
 * It sends nothing: no email, no push, no welcome. Everyone it adds is "imported, not yet asked" (emails_held), and
 * the app's one way to send email (src/server/email/send.ts) holds roster mail to them until the owner turns it on.
 *
 * A partial failure leaves the batches before it written and no audit row. A re-run is the repair: rows already
 * written are found again by their fingerprints (or contact and first name) and are unchanged, so nobody is added twice.
 * Each update lands only if the row still has the import_hash it was read with.
 *
 * Its summary holds counts, tab names and row numbers only; `sample` adds the first five people, for a person to read.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, corpsMembers } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { stoppedAmong } from "@/server/volunteers/stopped";
import { cell, headerKey, phoneKey } from "./cells";
import { mergePeople } from "./merge";
import { planImport, type PlanItem } from "./plan";
import { releaseImportLock, takeImportLock } from "./lock";
import { verifyStopSecret } from "./secret-check";
import { readTab, tabKind } from "./tabs";
import type { MergedPerson, SheetFile, SheetPerson } from "./types";

type Where = { tab: string; row: number };

export type ImportSummary = {
  tabs: { tab: string; rows: number; people: number }[];
  ignoredTabs: string[];
  /** Tabs this import does not know. Only their number is printed. */
  unknownTabs: string[];
  merged: number;
  outcome: Record<PlanItem["action"], number>;
  /** People written with a contact someone else holds: kept as their "other" email or phone, not on their row. */
  sharedContacts: number;
  /** Rows matched loosely to someone on the roster (and so skipped, as ambiguous or as a contact clash), by tab and row. */
  ambiguousRows: Where[];
  /** Rows in the file with the same name but no shared contact: kept as separate people, for a person to check. */
  possibleDuplicates: Where[][];
  withoutEmail: number;
  withoutPhone: number;
  withoutEither: number;
  unmappedOffers: string[];
  unparsed: Where[];
  applied: boolean;
  sample?: MergedPerson[];
};

/** Statements run in this many at a time. */
export const BATCH = 50;

/** Runs a list of statements. The default runs them one by one; the script passes Neon's `batch`, which is one transaction. */
export type Runner = (statements: PromiseLike<unknown>[]) => Promise<unknown>;
const oneByOne: Runner = async (statements) => {
  for (const s of statements) await s;
};

/** The tab and the row's content, normalised: the same row hashes the same on every run, wherever it sits. */
export function fingerprintOf(tab: string, row: unknown[] | undefined): string {
  const cells = (row ?? []).map((c) => cell(c).toLowerCase());
  while (cells.length && cells[cells.length - 1] === "") cells.pop();
  return createHash("sha256").update(JSON.stringify([headerKey(tab), cells])).digest("base64url");
}

/** Read the file into people, tab by tab. Throws on a file that is not `{ tabs: { name: rows } }`. */
export function readFile(file: unknown): { people: SheetPerson[]; summary: Pick<ImportSummary, "tabs" | "ignoredTabs" | "unknownTabs" | "unmappedOffers" | "unparsed"> } {
  const tabs = (file as SheetFile | null)?.tabs;
  if (!tabs || typeof tabs !== "object" || Array.isArray(tabs)) throw new Error("The file must be { \"tabs\": { \"<tab name>\": [[cells]] } }");
  const people: SheetPerson[] = [];
  const summary: ReturnType<typeof readFile>["summary"] = { tabs: [], ignoredTabs: [], unknownTabs: [], unmappedOffers: [], unparsed: [] };
  for (const [name, raw] of Object.entries(tabs)) {
    const kind = tabKind(name);
    if (kind === "ignore") {
      summary.ignoredTabs.push(name);
      continue;
    }
    if (kind === null) {
      summary.unknownTabs.push(name);
      continue;
    }
    const rows = Array.isArray(raw) ? raw.map((r) => (Array.isArray(r) ? r : [])) : [];
    const result = readTab(kind, name, rows);
    people.push(...result.people.map((p) => ({ ...p, fingerprint: fingerprintOf(name, rows[p.row - 1]) })));
    summary.tabs.push({ tab: name, rows: rows.length, people: result.people.length });
    summary.unmappedOffers.push(...result.unmappedOffers.filter((l) => !summary.unmappedOffers.includes(l)));
    summary.unparsed.push(...result.unparsed.map((row) => ({ tab: name, row })));
  }
  return { people, summary };
}

const counts = (merged: MergedPerson[]) => ({
  merged: merged.length,
  withoutEmail: merged.filter((p) => p.emails.length === 0).length,
  withoutPhone: merged.filter((p) => p.phones.length === 0).length,
  withoutEither: merged.filter((p) => p.emails.length === 0 && p.phones.length === 0).length,
});

/** The file read and merged, with no database: what a dry run can say before it is pointed at the roster. */
export function previewFile(file: unknown, sample = false): Omit<ImportSummary, "outcome" | "applied" | "ambiguousRows" | "sharedContacts"> {
  const { people, summary } = readFile(file);
  const { people: merged, possibleDuplicates } = mergePeople(people);
  return { ...summary, ...counts(merged), possibleDuplicates, ...(sample ? { sample: merged.slice(0, 5) } : {}) };
}

/** The row is written only if it still has the import_hash it was read with (null for a member who joined another way). */
const unchangedSince = (id: string, was: string | null) => and(eq(corpsMembers.id, id), sql`${corpsMembers.importHash} is not distinct from ${was}`);

function statementsFor(db: Db, item: PlanItem): PromiseLike<unknown>[] {
  switch (item.action) {
    case "new":
      return [db.insert(corpsMembers).values(item.values).onConflictDoNothing()];
    case "update":
      return [db.update(corpsMembers).set(item.set).where(unchangedSince(item.id, item.was))];
    case "kept_edited":
    case "linked":
      return item.set ? [db.update(corpsMembers).set(item.set).where(unchangedSince(item.id, item.was))] : [];
    default:
      return [];
  }
}

export type ImportOptions = { apply?: boolean; sample?: boolean; now?: Date; run?: Runner };

export async function runRosterImport(db: Db, file: unknown, opts: ImportOptions = {}): Promise<ImportSummary> {
  const now = opts.now ?? new Date();
  const { people, summary } = readFile(file);
  // Before anything is matched: a wrong secret would let people who asked to stop back in.
  await verifyStopSecret(db);
  if (!opts.apply) return planAndWrite(db, people, summary, now, opts);
  // One --apply at a time, from reading the roster to the last write.
  const stamp = await takeImportLock(db, now);
  try {
    return await planAndWrite(db, people, summary, now, opts);
  } finally {
    await releaseImportLock(db, stamp);
  }
}

async function planAndWrite(db: Db, people: SheetPerson[], summary: ReturnType<typeof readFile>["summary"], now: Date, opts: ImportOptions): Promise<ImportSummary> {
  const { people: merged, possibleDuplicates } = mergePeople(people);
  const roster = await db.select().from(corpsMembers);
  const keys = [...new Set(merged.flatMap((p) => [...p.emails, ...p.phones.map(phoneKey)]))];
  const stopped = await stoppedAmong(db, keys);
  const plan = planImport(merged, roster, stopped, now, chicagoToday(now));
  const outcome = { new: 0, update: 0, kept_edited: 0, linked: 0, unchanged: 0, skipped_left: 0, skipped_ambiguous: 0, skipped_contact_clash: 0 } satisfies Record<PlanItem["action"], number>;
  for (const { item } of plan.items) outcome[item.action]++;

  if (opts.apply) {
    const run = opts.run ?? oneByOne;
    const runId = randomUUID();
    const statements = plan.items.flatMap(({ item }) => statementsFor(db, item));
    for (let i = 0; i < statements.length; i += BATCH) await run(statements.slice(i, i + BATCH));
    // Last, so a run that stopped part way has no audit row. Counts only: never a name, a contact, a tab's words or the history.
    await run([db.insert(auditLog).values({ actorUserId: null, action: "corps_member.import", subjectType: "corps_import", subjectId: runId, detail: { by: "system", counts: { ...outcome, merged: merged.length, sharedContacts: plan.sharedContacts } } })]);
  }

  return {
    ...summary,
    ...counts(merged),
    outcome,
    sharedContacts: plan.sharedContacts,
    ambiguousRows: plan.items.filter(({ item }) => item.action === "skipped_ambiguous" || item.action === "skipped_contact_clash").flatMap(({ person }) => person.rows),
    possibleDuplicates,
    applied: opts.apply === true,
    ...(opts.sample ? { sample: merged.slice(0, 5) } : {}),
  };
}
