/**
 * The two-way sync of the list with the bima packet's Healing Prayers section. One run: take the
 * sync lock, read the section (through `PacketDoc`), merge it three ways against the last synced
 * snapshot (./merge.ts), check the change is not suspiciously large, write only the paragraphs that
 * must change (once more after a revision conflict, then stop), then record what changed. A run
 * that cannot find the section, sees suggested edits, or whose write conflicts twice stops without
 * guessing and records the error's NAME only. Names and lines are never logged; a run's record holds
 * counts, an error name and (for a dry run or a stopped run) a plan that only clergy can read.
 *
 * Modes (MISHEBERACH_SYNC_MODE): "dry-run" reads the packet and records what the sync WOULD do,
 * and changes nothing (the one exception is the explicit first-run "Import the current list", which
 * only makes entries); "on" syncs.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { canManageMiSheberach, canSeeMiSheberachSync, deny, type Actor } from "@/server/access/policy";
import { writeAudit } from "@/server/care/audit";
import { miSheberachEntries, miSheberachSync } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { chicagoToday } from "@/server/lifecycle/window";
import { withinLimit } from "@/server/meals/rate-limit";
import { mergeSection, reconcileSection, type EntryState, type MergeResult, type NewEntry, type Plan, type Reconciled, type SnapshotItem, type SnapshotLine } from "./merge";
import { PacketRevisionConflict, PacketStructureUnexpected, type PacketDoc, type SectionDescription, type SectionRead, type SyncMode } from "./packet";

const KEY = "packet";
/** One advisory lock for the whole sync: the daily job and "Sync now" never overlap. */
const LOCK = 7_341_901;
/** "Sync now" presses allowed per person per hour. */
export const SYNC_NOW_PER_HOUR = 6;

export type { SyncMode };
export type SyncOptions = { mode: SyncMode; /** Clergy confirmed: apply this one run although it is larger than the sync makes on its own. */ force?: boolean; /** Dry run only: make entries from the packet's current list (first run), and nothing else. */ importOnly?: boolean; /** Clergy asked: take the lines of people who asked not to be listed out of the packet (a real run only). */ removeBarred?: boolean; /** For tests: runs inside the sync lock after the plan is made and before it is applied, as a person editing at that moment would. */ onPlanned?: (db: Db) => Promise<void> };
export type SyncCounts = Record<string, number>;
export type SyncResult = { status: "not_connected" } | { status: "busy" } | { status: "ok"; counts: SyncCounts; wrote: boolean; dryRun: boolean } | { status: "failed"; errorName: string };

type Snapshot = SnapshotItem[];
type State = { snapshot: Snapshot | null; lastOkAt: Date | null; lastErrorName: string | null; lastPlan: Plan | null };

async function loadState(db: Db): Promise<State> {
  const [row] = await db.select({ snapshot: miSheberachSync.snapshot, lastOkAt: miSheberachSync.lastOkAt, errorName: miSheberachSync.errorName, plan: miSheberachSync.plan }).from(miSheberachSync).where(eq(miSheberachSync.key, KEY)).limit(1);
  const raw = row?.snapshot;
  const snapshot = Array.isArray(raw) ? (raw as Snapshot).filter((s) => typeof s?.line === "string" && typeof s?.entryId === "string") : null;
  return { snapshot, lastOkAt: row?.lastOkAt ?? null, lastErrorName: row?.errorName ?? null, lastPlan: (row?.plan as Plan | null) ?? null };
}

async function loadEntries(db: Db, snapshot: Snapshot | null): Promise<EntryState[]> {
  const ids = (snapshot ?? []).map((s) => s.entryId);
  // Without a snapshot every entry is needed (to match the packet's lines to names, ended ones included); otherwise live ones, those barred, and those the snapshot names.
  const rows = await db
    .select()
    .from(miSheberachEntries)
    .where(snapshot === null ? undefined : or(isNull(miSheberachEntries.endedAt), eq(miSheberachEntries.consent, "asked_not_listed"), ids.length ? inArray(miSheberachEntries.id, ids) : sql`false`));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    nameKey: r.nameKey,
    dateAdded: r.dateAdded,
    kind: r.kind,
    askedBy: r.askedBy,
    specialRequest: r.specialRequest,
    consent: r.consent,
    docLine: r.docLine,
    ended: r.endedAt !== null,
    updatedAt: r.updatedAt.getTime(),
  }));
}

type Planned = { kind: "merge"; merged: MergeResult; live: number; lines: number; firstRun: boolean } | { kind: "reconcile"; rec: Reconciled };

/** Work out what this run would do against the packet as read. Stops (throws) when the packet looks wrong. */
async function plan(db: Db, read: SectionRead, today: string, opts: SyncOptions): Promise<{ planned: Planned; state: State }> {
  const state = await loadState(db);
  if (read.lines.length === 0 && state.snapshot && state.snapshot.length > 0) throw new PacketStructureUnexpected();
  const entries = await loadEntries(db, state.snapshot);
  // A snapshot that was lost after a successful sync, with entries on the list: reconcile, read-only.
  if (state.snapshot === null && state.lastOkAt !== null && entries.length > 0) return { planned: { kind: "reconcile", rec: reconcileSection({ doc: read.lines, entries, today }) }, state };
  const merged = mergeSection({ snapshot: state.snapshot, doc: read.lines, entries, firstRun: state.snapshot === null, today, removeBarred: opts.mode === "on" && opts.removeBarred === true });
  return { planned: { kind: "merge", merged, live: entries.filter((e) => !e.ended).length, lines: read.lines.length, firstRun: state.snapshot === null }, state };
}

export type BrakeCounts = { wouldEnd: number; wouldRemoveLines: number; wouldChange: number; live: number; lines: number };

/** What a run would do, in the three numbers the brake looks at. */
export function brakeCounts(p: { live: number; lines: number; merged: MergeResult }): BrakeCounts {
  return { wouldEnd: p.merged.end.length, wouldRemoveLines: p.merged.counts.removedFromPacket + p.merged.counts.removedBarred, wouldChange: p.merged.edits.replace.length, live: p.live, lines: p.lines };
}

/** The sanity brake: a run that would end names, or remove or change lines of the packet, in more than a third of the list (and more than three) is not made on its own. */
export function tooLarge(p: { live: number; lines: number; merged: MergeResult }): BrakeCounts | null {
  const c = brakeCounts(p);
  const over = c.wouldEnd > Math.max(3, p.live / 3) || c.wouldRemoveLines > Math.max(3, p.lines / 3) || c.wouldChange > Math.max(3, p.lines / 3);
  return over ? c : null;
}

/** JSON with sorted keys, so the same plan always hashes the same. */
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null);

/** A stable hash of what a merge would do to the packet's lines and to entries. Kept with a stopped run's plan; it holds no text. */
export function planHash(m: MergeResult): string {
  return createHash("sha256").update(stable({ edits: m.edits, create: m.create, update: m.update, end: m.end, relink: m.relink })).digest("hex").slice(0, 32);
}

/** "Apply anyway" covers only what was shown: a fresh plan that is the SAME plan as the one of the run that was stopped, not merely one of the same size. */
const sameAsShown = (fresh: MergeResult, shown: Plan | null) => shown?.hash !== undefined && shown.hash === planHash(fresh);

/** Run one sync. `by` is the person who pressed the button, or null for the daily job. */
export async function syncPacket(db: Db, doc: PacketDoc | null, now: Date, by: Actor | null, opts: SyncOptions): Promise<SyncResult> {
  if (!doc || opts.mode === "off") return { status: "not_connected" };
  try {
    return await db.transaction(async (tx) => {
      const res = (await tx.execute(sql`select pg_try_advisory_xact_lock(${LOCK}) as got`)) as unknown as { rows?: { got: boolean }[] } | { got: boolean }[];
      const rows = Array.isArray(res) ? res : (res.rows ?? []);
      if (!rows[0]?.got) return { status: "busy" } as const;
      return run(tx as unknown as Db, doc, now, by, opts);
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "unknown";
    console.error("Mi Sheberach sync failed", errorName);
    return { status: "failed", errorName };
  }
}

async function run(db: Db, doc: PacketDoc, now: Date, by: Actor | null, opts: SyncOptions): Promise<SyncResult> {
  const today = chicagoToday(now);
  try {
    let read = await doc.read();
    let { planned, state } = await plan(db, read, today, opts);
    const dry = opts.mode === "dry-run";
    // "Apply anyway" counts only when a stopped run was shown and this run is no larger than it.
    const forced = (p: Planned, st: State) => opts.force === true && p.kind === "merge" && st.lastErrorName === "PacketChangeTooLarge" && sameAsShown(p.merged, st.lastPlan);
    const brake = (p: Planned, st: State) => (p.kind === "merge" && !dry && !forced(p, st) ? tooLarge(p) : null);
    let braked = brake(planned, state);
    let wrote = false;
    if (braked) return await stopped(db, now, "PacketChangeTooLarge", braked, planned);
    await opts.onPlanned?.(db);

    if (dry) {
      const importing = opts.importOnly === true && state.snapshot === null && state.lastOkAt === null && planned.kind === "merge";
      if (importing && planned.kind === "merge") {
        const m = planned.merged;
        const fromDoc = m.snapshot.filter((l) => !l.viaWrite);
        await record(db, { create: m.create, update: [], end: [], relink: m.relink.filter((r) => fromDoc.some((l) => "id" in l.ref && l.ref.id === r.id)), snapshot: fromDoc }, now);
        if (by) await writeAudit(db, by, "mi_sheberach.import", "mi_sheberach_sync", by.id, { count: m.create.length });
        await finish(db, now, { ok: true, real: false, errorName: null, counts: { ...m.counts, lines: planned.lines, dryRun: 1, imported: m.create.length }, plan: null });
        return { status: "ok", counts: { ...m.counts, imported: m.create.length }, wrote: false, dryRun: true };
      }
      const counts = { ...countsOf(planned, false, 0), dryRun: 1 };
      await finish(db, now, { ok: true, real: false, errorName: null, counts, plan: planOf(planned) });
      return { status: "ok", counts, wrote: false, dryRun: true };
    }

    let skipped = 0;
    if (planned.kind === "reconcile") {
      skipped = await record(db, { create: planned.rec.create, update: planned.rec.update, end: [], relink: planned.rec.relink, snapshot: planned.rec.snapshot }, now);
    } else {
      if (forced(planned, state) && by && tooLarge(planned)) await writeAudit(db, by, "mi_sheberach.apply_anyway", "mi_sheberach_sync", by.id, { count: planned.merged.end.length + planned.merged.counts.removedFromPacket });
      if (planned.merged.write) {
        try {
          await doc.write(read, planned.merged.edits);
        } catch (error) {
          if (!(error instanceof PacketRevisionConflict)) throw error;
          // The packet moved on while we worked out the write: read it again, plan again and try once more, then stop.
          read = await doc.read();
          ({ planned, state } = await plan(db, read, today, opts));
          braked = brake(planned, state);
          if (braked) return await stopped(db, now, "PacketChangeTooLarge", braked, planned);
          if (planned.kind === "merge" && planned.merged.write) await doc.write(read, planned.merged.edits);
        }
        wrote = planned.kind === "merge" && planned.merged.write;
      }
      if (planned.kind === "merge") skipped = await record(db, { ...planned.merged }, now);
      else skipped = await record(db, { create: planned.rec.create, update: planned.rec.update, end: [], relink: planned.rec.relink, snapshot: planned.rec.snapshot }, now);
    }
    const counts = countsOf(planned, wrote, skipped);
    // A real run keeps only the lines it is leaving alone (and why), for the standing notice.
    await finish(db, now, { ok: true, real: true, errorName: null, counts, plan: { ...emptyPlanView(), leftAlone: planOf(planned).leftAlone } });
    if (by && planned.kind === "merge" && planned.merged.counts.removedBarred > 0) await writeAudit(db, by, "mi_sheberach.remove_barred", "mi_sheberach_sync", by.id, { count: planned.merged.counts.removedBarred });
    if (by) await writeAudit(db, by, "mi_sheberach.sync", "mi_sheberach_sync", by.id, { count: counts.lines });
    return { status: "ok", counts, wrote, dryRun: false };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "unknown";
    console.error("Mi Sheberach sync failed", errorName);
    // A failed run keeps the previous run's "left alone" notice in view rather than clearing it.
    const kept = await keptLeftAlone(db).catch(() => undefined);
    await finish(db, now, { ok: false, real: false, errorName, counts: null, plan: kept && kept.length > 0 ? { ...emptyPlanView(), leftAlone: kept } : null }).catch(() => undefined);
    return { status: "failed", errorName };
  }
}

/** A run stopped by the sanity brake: nothing was written or changed; clergy get the counts and the plan, and may apply it anyway. */
async function stopped(db: Db, now: Date, errorName: string, counts: SyncCounts, planned: Planned): Promise<SyncResult> {
  console.error("Mi Sheberach sync failed", errorName);
  const hash = planned.kind === "merge" ? planHash(planned.merged) : undefined;
  await finish(db, now, { ok: false, real: false, errorName, counts, plan: { ...planOf(planned), ...(hash ? { hash } : {}) } });
  return { status: "failed", errorName };
}

/** The lines the previous run left alone, from its stored plan. */
async function keptLeftAlone(db: Db): Promise<Plan["leftAlone"]> {
  const [row] = await db.select({ plan: miSheberachSync.plan }).from(miSheberachSync).where(eq(miSheberachSync.key, KEY)).limit(1);
  const left = (row?.plan as Plan | null)?.leftAlone;
  return Array.isArray(left) ? left : [];
}

const countsOf = (p: Planned, wrote: boolean, skipped: number): SyncCounts =>
  p.kind === "merge"
    ? { ...p.merged.counts, lines: p.merged.snapshot.length, wrote: wrote ? 1 : 0, skipped, wouldAdd: p.merged.edits.insert.length, wouldChange: p.merged.edits.replace.length, wouldRemove: p.merged.edits.remove.length }
    : { ...p.rec.counts, lines: p.rec.snapshot.length, wrote: 0, skipped, reconciled: 1 };
const emptyPlanView = (): Plan => ({ addLines: [], changeLines: [], removeLines: [], addEntries: [], endEntries: [], leftAlone: [] });
const planOf = (p: Planned): Plan => (p.kind === "merge" ? p.merged.plan : p.rec.plan);

type Recorded = { create: NewEntry[]; update: MergeResult["update"]; end: MergeResult["end"]; relink: MergeResult["relink"]; snapshot: SnapshotLine[] };

/** Entry changes are guarded by the time the entry was last changed: one edited by a person since the plan was made is skipped (it converges next run). Returns how many were skipped. */
const unchanged = (expect: number | undefined) => (expect === undefined ? undefined : sql`date_trunc('milliseconds', ${miSheberachEntries.updatedAt}) = ${new Date(expect)}`);

/** Apply a plan to the entries and keep the snapshot of what the packet now holds. */
async function record(db: Db, r: Recorded, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    let skipped = 0;
    const created: string[] = [];
    for (const n of r.create) {
      const [row] = await tx.insert(miSheberachEntries).values({ ...n, source: "bima_packet" }).returning({ id: miSheberachEntries.id });
      created.push(row.id);
    }
    const guarded = async (id: string, expect: number | undefined, set: Partial<typeof miSheberachEntries.$inferInsert>, live = true) => {
      const done = await tx.update(miSheberachEntries).set(set).where(and(eq(miSheberachEntries.id, id), live ? isNull(miSheberachEntries.endedAt) : undefined, unchanged(expect))).returning({ id: miSheberachEntries.id });
      if (done.length === 0) skipped++;
    };
    for (const u of r.update) await guarded(u.id, u.expect, u.patch);
    for (const e of r.end) await guarded(e.id, e.expect, { endedAt: now, endedReason: "removed_in_packet", needsReview: false });
    for (const l of r.relink) await guarded(l.id, l.expect, { docLine: l.docLine }, false);
    const snapshot: Snapshot = r.snapshot.map((l) => ({ line: l.text, bold: l.bold, entryId: "id" in l.ref ? l.ref.id : created[l.ref.create] }));
    await upsertState(tx as unknown as Db, { snapshot });
    return skipped;
  });
}

type Run = { ok: boolean; /** A real ("on") run that succeeded: only this sets "last synced". */ real: boolean; errorName: string | null; counts: SyncCounts | null; plan: Plan | null };

async function upsertState(db: Db, set: { snapshot?: Snapshot } & Partial<{ lastRunAt: Date; lastOkAt: Date; ok: boolean; errorName: string | null; counts: SyncCounts | null; plan: Plan | null }>): Promise<void> {
  await db.insert(miSheberachSync).values({ key: KEY, ...set }).onConflictDoUpdate({ target: miSheberachSync.key, set });
}

async function finish(db: Db, now: Date, run: Run): Promise<void> {
  await upsertState(db, { lastRunAt: now, ...(run.ok && run.real ? { lastOkAt: now } : {}), ok: run.ok, errorName: run.errorName, counts: run.counts, plan: run.plan });
}

export type SyncStatus = {
  mode: SyncMode;
  connected: boolean;
  lastRunAt: Date | null;
  /** The last real ("on") sync that succeeded. A trial-mode check never sets it. */
  lastOkAt: Date | null;
  /** The last trial-mode check, when that was the last run. */
  lastCheckedAt: Date | null;
  ok: boolean | null;
  errorName: string | null;
  counts: SyncCounts | null;
  /** What the last dry run (or stopped run) would do. Names are in it: clergy and owner only. */
  plan: Plan | null;
  /** The packet has never been synced and no snapshot exists: "Import the current list" is offered. */
  canImport: boolean;
};

/** For the list page (the plan, the notice when the last run stopped) and Settings. Managers see the state; the plan has names in it. */
export async function getSyncStatus(db: Db, actor: Actor, mode: SyncMode): Promise<SyncStatus> {
  if (!canManageMiSheberach(actor)) deny();
  const [row] = await db.select().from(miSheberachSync).where(eq(miSheberachSync.key, KEY)).limit(1);
  return {
    mode,
    connected: mode !== "off",
    lastRunAt: row?.lastRunAt ?? null,
    lastOkAt: row?.lastOkAt ?? null,
    lastCheckedAt: row?.lastRunAt && (row.counts as SyncCounts | null)?.dryRun === 1 ? row.lastRunAt : null,
    ok: row?.ok ?? null,
    errorName: row?.errorName ?? null,
    counts: (row?.counts as SyncCounts | null) ?? null,
    plan: (row?.plan as Plan | null) ?? null,
    canImport: (row?.snapshot ?? null) === null && !row?.lastOkAt,
  };
}

/** "Sync now" (and "Import the current list", "Apply anyway"): clergy and owner, rate limited per person. */
export async function syncNow(db: Db, doc: PacketDoc | null, actor: Actor, now: Date, opts: SyncOptions): Promise<SyncResult | { status: "limited" }> {
  if (!canManageMiSheberach(actor)) deny();
  if (!(await withinLimit(db, `misheberach:sync:${actor.id}`, SYNC_NOW_PER_HOUR, now))) return { status: "limited" };
  return syncPacket(db, doc, now, actor, opts);
}

/** The shape of the located section as counts (the owner's diagnostic in Settings). No names. */
export async function describePacket(db: Db, doc: PacketDoc | null, actor: Actor, now: Date = new Date()): Promise<SectionDescription | "limited" | null> {
  if (!canSeeMiSheberachSync(actor)) deny();
  if (!doc) return null;
  if (!(await withinLimit(db, `misheberach:describe:${actor.id}`, SYNC_NOW_PER_HOUR, now))) return "limited";
  return doc.describe();
}
