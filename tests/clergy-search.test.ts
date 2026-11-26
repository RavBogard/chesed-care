import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDenied, type Actor } from "@/server/access/policy";
import { addAgendaEntry } from "@/server/care/agenda";
import { createCareItem } from "@/server/care/care-items";
import { createContactEntry } from "@/server/care/contact-log";
import { createFollowUp, setFollowUpDone } from "@/server/care/follow-ups";
import { PAGE_SIZE, prefixQuery, searchNotes, SEARCHES_PER_HOUR, snippet } from "@/server/care/notes-search";
import { InvalidInput, TooMany } from "@/server/care/validate";
import { purgeOldNotes } from "@/server/daily/retention";
import { careItems } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { CONTACT, CONTACT2, addActor, reporters, team, testDb } from "./support/db";
import { words } from "./support/words";

const NOW = new Date("2026-11-23T16:00:00Z");
const WHEN = "2026-11-20T15:00:00Z";
let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
let third: Actor;

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
  third = await addActor(db, "clergy3@example.test", "clergy");
});
afterEach(() => vi.restoreAllMocks());

const find = async (actor: Actor, q: string) => (await searchNotes(db, actor, q, {}, NOW)).groups.flatMap((g) => g.hits.map((h) => ({ ...h, person: g.name })));
const open = () => createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Open Olivia", category: "illness", summary: "Pneumonia, doing better" });

describe("search in notes: who and what", () => {
  it("is for clergy and the owner only", async () => {
    await open();
    for (const actor of [t.owner, t.clergy2]) await expect(searchNotes(db, actor, "pneumonia", {}, NOW)).resolves.toBeTruthy();
    for (const actor of [t.carer, r.staff, r.lead, r.senior]) await expect(searchNotes(db, actor, "pneumonia", {}, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("searches care summaries, contact notes, follow-up titles and outcomes, and agenda entries, grouped by person, newest first", async () => {
    const item = await open();
    await createContactEntry(db, t.clergy, { careItemId: item.id, kind: "call", occurredAt: WHEN, note: "Asked about the pneumonia medicine" });
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Bring pneumonia soup", dueDate: "2026-11-30" });
    await addAgendaEntry(db, t.clergy, { careItemId: item.id, why: "pneumonia update" }, NOW);
    const hits = await find(t.clergy2, "pneumon");
    expect(hits.map((h) => h.kind).sort()).toEqual(["agenda", "care_item", "contact", "follow_up"]);
    expect((await searchNotes(db, t.clergy2, "pneumonia", {}, NOW)).groups).toHaveLength(1);
    expect(hits[0].person).toBe("Open Olivia");
    const times = hits.map((h) => h.at.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(hits.find((h) => h.kind === "contact")!.snippet).toContain("pneumonia");
  });

  it("matches the beginning of a word and a person's name", async () => {
    const item = await open();
    await createContactEntry(db, t.clergy, { careItemId: item.id, kind: "call", occurredAt: WHEN, note: "Spoke at length" });
    expect((await find(t.clergy, "pneumo")).length).toBeGreaterThan(0);
    expect((await find(t.clergy, "olivia")).map((h) => h.kind)).toContain("contact");
  });
});

describe("search in notes: visibility is applied in the SQL of every source", () => {
  it("never returns another clergy member's private note, but does return that note to its author", async () => {
    const item = await open();
    await createContactEntry(db, t.clergy2, { careItemId: item.id, kind: "call", occurredAt: WHEN, note: "Zebra confidences", private: true });
    await createContactEntry(db, t.clergy2, { careItemId: item.id, kind: "call", occurredAt: WHEN, note: "Zebra shared note" });
    expect((await find(t.clergy, "zebra")).map((h) => h.snippet)).toEqual(["Zebra shared note"]);
    expect((await find(t.owner, "zebra")).map((h) => h.snippet)).toEqual(["Zebra shared note"]);
    expect((await find(t.clergy2, "zebra")).map((h) => h.snippet).sort()).toEqual(["Zebra confidences", "Zebra shared note"]);
    // A name match must not smuggle the private note's words either.
    expect(words(await find(t.clergy, "olivia"))).not.toMatch(/confidences/);
  });

  it("never returns anything from a restricted item to clergy or the owner who cannot see it: not rows, not paging", async () => {
    const secret = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Hidden Hannah", category: "mental_health", restricted: true, summary: "Quokka diagnosis" });
    await createContactEntry(db, t.clergy, { careItemId: secret.id, kind: "visit", occurredAt: WHEN, note: "Quokka visit" });
    await createFollowUp(db, t.clergy, { careItemId: secret.id, title: "Quokka call", dueDate: "2026-11-30" });
    await addAgendaEntry(db, t.clergy, { careItemId: secret.id, why: "Quokka matter" }, NOW);
    expect(await find(t.clergy, "quokka")).toHaveLength(4);
    for (const actor of [t.clergy2, t.owner, third]) {
      const res = await searchNotes(db, actor, "quokka", {}, NOW);
      expect(res).toMatchObject({ groups: [], hasMore: false, shown: 0 });
      expect(words(await find(actor, "hannah"))).toBe("[]");
    }
  });

  it("returns a restricted item to a clergy member named on it", async () => {
    const named = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Hidden Hannah", category: "mental_health", restricted: true, summary: "Quokka diagnosis", accessUserIds: [t.clergy2.id] });
    expect(named.restricted).toBe(true);
    expect(await find(t.clergy2, "quokka")).toHaveLength(1);
    expect(await find(third, "quokka")).toHaveLength(0);
  });

  it("returns a caregiver-visible note to clergy, and a clergy-only item's text to no caregiver (caregivers cannot search at all)", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Open Olivia", category: "illness", ownerUserId: t.carer.id, visibility: "caregivers" });
    await createContactEntry(db, t.carer, { careItemId: item.id, kind: "visit", occurredAt: WHEN, note: "Gnu brought flowers" });
    expect(await find(t.clergy, "gnu")).toHaveLength(1);
    await expect(searchNotes(db, t.carer, "gnu", {}, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("does not find text the retention job purged", async () => {
    const item = await open();
    await createContactEntry(db, t.clergy, { careItemId: item.id, kind: "call", occurredAt: WHEN, note: "Ibex was mentioned" });
    await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Ibex follow-up", dueDate: "2026-11-30" });
    expect(await find(t.clergy, "ibex")).toHaveLength(2);
    await db.update(careItems).set({ status: "closed", closedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(careItems.id, item.id));
    await purgeOldNotes(db, NOW);
    expect(await find(t.clergy, "ibex")).toHaveLength(0);
    expect(await find(t.clergy, "pneumonia")).toHaveLength(0);
  });

  it("finds a follow-up's outcome line", async () => {
    const item = await open();
    const fu = await createFollowUp(db, t.clergy, { careItemId: item.id, title: "Call", dueDate: "2026-11-24" });
    await setFollowUpDone(db, t.clergy, fu.id, true, { now: NOW });
    expect((await find(t.clergy, "call")).some((h) => h.kind === "follow_up")).toBe(true);
  });
});

describe("search in notes: limits and silence", () => {
  it("needs at least three characters of usable text", async () => {
    await expect(searchNotes(db, t.clergy, "ab", {}, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchNotes(db, t.clergy, "  a ", {}, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchNotes(db, t.clergy, "---", {}, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(searchNotes(db, t.clergy, "x".repeat(61), {}, NOW)).rejects.toBeInstanceOf(InvalidInput);
    expect(prefixQuery("o'brien; drop--table")).toBe("o:* & brien:* & drop:* & table:*");
  });

  it("pages its results", async () => {
    const item = await open();
    for (let i = 0; i < PAGE_SIZE + 5; i++) await createContactEntry(db, t.clergy, { careItemId: item.id, kind: "call", occurredAt: new Date(Date.parse(WHEN) + i * 60_000).toISOString(), note: `Wombat entry ${i}` });
    const first = await searchNotes(db, t.clergy, "wombat", {}, NOW);
    expect(first.shown).toBe(PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    const second = await searchNotes(db, t.clergy, "wombat", { offset: PAGE_SIZE }, NOW);
    expect(second.shown).toBe(5);
    expect(second.hasMore).toBe(false);
    const ids = [...first.groups, ...second.groups].flatMap((g) => g.hits.map((h) => h.id));
    expect(new Set(ids).size).toBe(PAGE_SIZE + 5);
  });

  it("is rate limited per person", async () => {
    for (let i = 0; i < SEARCHES_PER_HOUR; i++) await searchNotes(db, t.clergy, "anything", {}, NOW);
    await expect(searchNotes(db, t.clergy, "anything", {}, NOW)).rejects.toBeInstanceOf(TooMany);
    await expect(searchNotes(db, t.clergy2, "anything", {}, NOW)).resolves.toBeTruthy();
  });

  it("never logs the query text, even when it fails", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await searchNotes(db, t.clergy, "secretphrase", {}, NOW);
    await expect(searchNotes(db, t.carer, "secretphrase", {}, NOW)).rejects.toBeInstanceOf(AccessDenied);
    await expect(searchNotes(db, t.clergy, "se", {}, NOW)).rejects.toBeInstanceOf(InvalidInput);
    expect(spies.flatMap((s) => s.mock.calls)).toEqual([]);
  });

  it("makes no Salesforce call: neither the search nor its action reaches the Salesforce client", () => {
    const search = readFileSync("src/server/care/notes-search.ts", "utf8");
    const imports = search.split(/\r?\n/).filter((l) => l.startsWith("import"));
    expect(imports.join(" ")).not.toMatch(/salesforce|lifecycle|find-people/);
    const actions = readFileSync("src/app/find-actions.ts", "utf8");
    const body = actions.slice(actions.indexOf("export async function searchNotesAction"));
    expect(body).not.toMatch(/getSalesforce|findPeople/);
  });

  it("snippets are short and centred on the match", () => {
    const long = `${"a ".repeat(100)}needle ${"b ".repeat(100)}`;
    const s = snippet(long, "needle");
    expect(s).toContain("needle");
    expect(s.length).toBeLessThan(170);
  });
});
