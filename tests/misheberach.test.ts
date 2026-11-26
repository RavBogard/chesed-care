import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDenied, canManageMiSheberach, ROLES, type Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { createPublicProposal } from "@/server/care/intake";
import { acceptProposal } from "@/server/care/proposals";
import { NotFound } from "@/server/care/validate";
import { DAILY_TASKS, runDailyJob } from "@/server/daily/run";
import { auditLog, jobRuns, miSheberachEntries, miSheberachSync, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { parseLine, type PacketLine } from "@/server/misheberach/line";
import {
  addEntry,
  endEntry,
  expireDueEntries,
  listEntries,
  listPrompts,
  liveEntriesForCareItems,
  liveEntriesForPerson,
  MiSheberachBarred,
  renewEntry,
  updateEntry,
} from "@/server/misheberach/list";
import { buildWriteRequests, describeSection, locateSection, PacketHasSuggestions, PacketRevisionConflict, PacketSectionNotFound, SECTION_END, SECTION_HEADING, type GoogleDocument, type PacketDoc, type SectionDescription, type SectionEdits, type SectionRead } from "@/server/misheberach/packet";
import { describePacket, getSyncStatus, syncNow, syncPacket } from "@/server/misheberach/sync";
import { AFTER, applyEdits, BEFORE, bullets, makeDoc } from "./support/packet";
import { navItems } from "@/components/shell/app-shell";
import { miSheberachFor, type InboxEntry } from "@/components/inbox-card";
import { CONTACT, reporters, team, testDb } from "./support/db";
import { fakeSf } from "./support/sf";
import { words } from "./support/words";

const NOW = new Date("2026-11-24T18:00:00Z");
const TODAY = "2026-11-24";
const ON = { mode: "on" } as const;
const at = (day: string) => new Date(`${day}T18:00:00Z`);
const ln = (bold: string, rest = ""): PacketLine => ({ text: bold + rest, bold: [[0, bold.length]] });

/** An in-memory packet: the section's lines and a revision. `external` is someone editing it by hand. */
class FakePacket implements PacketDoc {
  reads = 0;
  writes: SectionEdits[] = [];
  conflicts = 0;
  failRead: Error | null = null;
  revision = 1;
  constructor(public lines: PacketLine[]) {}
  async read(): Promise<SectionRead> {
    this.reads++;
    if (this.failRead) throw this.failRead;
    return { revisionId: `r${this.revision}`, lines: this.lines.map((l) => ({ ...l })), target: { paragraphs: this.lines.map((_, i) => ({ start: 10 + i * 10, end: 20 + i * 10 })), insertAt: 5, paragraphStyle: null, plainText: {} } };
  }
  async write(read: SectionRead, edits: SectionEdits): Promise<void> {
    if (this.conflicts > 0) {
      this.conflicts--;
      this.revision++;
      throw new PacketRevisionConflict();
    }
    if (read.revisionId !== `r${this.revision}`) throw new PacketRevisionConflict();
    this.writes.push(edits);
    this.lines = applyEdits(this.lines, edits);
    this.revision++;
  }
  async describe(): Promise<SectionDescription> {
    return { bullets: this.lines.length, otherParagraphs: 2, boldShapes: { name: this.lines.length }, nesting: { "0": this.lines.length }, suggestions: false, ruleLineIsBullet: false, avLineIsBullet: false };
  }
  texts = () => this.lines.map((l) => l.text);
  external(lines: PacketLine[]) {
    this.lines = lines;
    this.revision++;
  }
}

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
let logged: unknown[][];

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
  logged = [];
  for (const m of ["error", "warn", "log", "info"] as const) vi.spyOn(console, m).mockImplementation((...a) => void logged.push(a));
});
afterEach(() => vi.restoreAllMocks());

const entries = () => db.select().from(miSheberachEntries);
const byName = async (name: string) => (await entries()).find((e) => e.name === name)!;
const add = (a: Actor, name: string, extra: Record<string, unknown> = {}) => addEntry(db, a, { name, ...extra }, { now: NOW }).then((x) => x.entry);

describe("who may use the list", () => {
  it("only owner and clergy: every other role is refused on every function, and Today gets no prompts", async () => {
    const e = await add(t.clergy, "Ruth Cohen");
    const others = [t.carer, r.staff, r.lead, r.senior];
    for (const a of others) {
      expect(canManageMiSheberach(a)).toBe(false);
      await expect(listEntries(db, a, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(addEntry(db, a, { name: "Someone Else" })).rejects.toBeInstanceOf(AccessDenied);
      await expect(updateEntry(db, a, e.id, { askedBy: "x" })).rejects.toBeInstanceOf(AccessDenied);
      await expect(endEntry(db, a, e.id, "recovered")).rejects.toBeInstanceOf(AccessDenied);
      await expect(renewEntry(db, a, e.id, "keep")).rejects.toBeInstanceOf(AccessDenied);
      await expect(syncNow(db, new FakePacket([]), a, NOW, ON)).rejects.toBeInstanceOf(AccessDenied);
      expect(await listPrompts(db, a, NOW)).toEqual([]);
      expect(await liveEntriesForPerson(db, a, { sfContactId: CONTACT })).toEqual([]);
      expect(navItems(a).some((i) => i.href === "/mi-sheberach")).toBe(false);
    }
    for (const a of [t.owner, t.clergy]) {
      expect(navItems(a).some((i) => i.href === "/mi-sheberach")).toBe(true);
      expect((await listEntries(db, a, NOW)).current).toHaveLength(1);
    }
    expect(ROLES.filter((role) => canManageMiSheberach({ role }))).toEqual(["owner", "clergy"]);
  });

  it("a requested name goes on at once, dated and not yet confirmed, as read aloud; a second add finds the first", async () => {
    const e = await add(t.clergy, "Ya’akov ben Avraham", { askedBy: "friend of Ruth" });
    expect(e).toMatchObject({ kind: "dated", consent: "not_confirmed", source: "app", dateAdded: TODAY, askedBy: "friend of Ruth" });
    const again = await addEntry(db, t.owner, { name: "Yaakov  ben Avraham" }, { now: NOW });
    expect(again.created).toBe(false);
    expect(again.entry.id).toBe(e.id);
    expect((await listEntries(db, t.owner, NOW)).current.map((x) => x.name)).toEqual(["Ya’akov ben Avraham"]);
  });

  it("refuses text that would break a packet line", async () => {
    await expect(addEntry(db, t.clergy, { name: "Ruth (Ruthie) Cohen" })).rejects.toThrow();
    const e = await add(t.clergy, "Line One\nLine Two*", { askedBy: "a\n b" });
    expect(e.name).toBe("Line One Line Two");
    expect(e.askedBy).toBe("a b");
  });
});

describe("a name linked to a restricted care item", () => {
  async function restricted() {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: "001000000000001AAA", displayName: "Ruth Cohen", category: "mental_health", summary: "PRIVATE SUMMARY", restricted: true, restrictedShowsCarer: true, accessUserIds: [] });
    const e = await add(t.clergy, "Ruth Cohen", { careItemId: item.id, sfContactId: CONTACT });
    return { item, e };
  }

  it("still lists by name for every manager, but the link to the care item shows only to those with full access (the owner role included)", async () => {
    const { item, e } = await restricted();
    const full = (await listEntries(db, t.clergy, NOW)).current[0];
    expect(full).toMatchObject({ name: "Ruth Cohen", careItemId: item.id });
    for (const a of [t.clergy2, t.owner]) {
      const seen = (await listEntries(db, a, NOW)).current;
      expect(seen.map((x) => x.name)).toEqual(["Ruth Cohen"]);
      expect(seen[0].careItemId).toBeNull();
      expect(JSON.stringify(seen)).not.toContain(item.id);
      expect(JSON.stringify(seen)).not.toContain("PRIVATE SUMMARY");
      expect(await liveEntriesForCareItems(db, a, [item.id])).toEqual([]);
      expect((await liveEntriesForPerson(db, a, { sfContactId: CONTACT })).map((x) => [x.name, x.careItemId])).toEqual([["Ruth Cohen", null]]);
      // Linking to the item, or clearing the link, needs sight of it.
      await expect(addEntry(db, a, { name: "Someone New", careItemId: item.id })).rejects.toBeInstanceOf(NotFound);
      await expect(updateEntry(db, a, e.id, { careItemId: null })).rejects.toBeInstanceOf(NotFound);
    }
    expect((await liveEntriesForCareItems(db, t.clergy, [item.id])).map((x) => x.id)).toEqual([e.id]);
  });
});

describe("120 days and the one-week prompt", () => {
  async function dated(name: string, dateAdded: string, kind: "dated" | "standing" = "dated") {
    const e = await add(t.clergy, name, { kind });
    await db.update(miSheberachEntries).set({ dateAdded }).where(eq(miSheberachEntries.id, e.id));
    return e;
  }

  it("a dated name comes off on its 120th day, not before; a standing one never does", async () => {
    await dated("Dated Name", "2026-01-01");
    await dated("Standing Name", "2025-01-01", "standing");
    expect(await expireDueEntries(db, at("2026-04-30"))).toEqual({ expired: 0 });
    expect(await expireDueEntries(db, at("2026-05-01"))).toEqual({ expired: 1 });
    expect(await expireDueEntries(db, at("2027-05-01"))).toEqual({ expired: 0 });
    const rows = await entries();
    expect(rows.find((e) => e.name === "Dated Name")).toMatchObject({ endedReason: "expired" });
    expect(rows.find((e) => e.name === "Standing Name")!.endedAt).toBeNull();
  });

  it("the prompt appears exactly seven days before it comes off and not after, and standing names never prompt", async () => {
    await dated("Dated Name", "2026-01-01");
    await dated("Standing Name", "2026-01-01", "standing");
    const names = async (day: string) => (await listPrompts(db, t.clergy, at(day))).map((p) => p.name);
    expect(await names("2026-04-23")).toEqual([]);
    expect(await names("2026-04-24")).toEqual(["Dated Name"]);
    expect(await names("2026-04-30")).toEqual(["Dated Name"]);
    expect(await names("2026-05-01")).toEqual([]);
    const marked = (await listEntries(db, t.clergy, at("2026-04-26"))).current.find((e) => e.name === "Dated Name")!;
    expect(marked).toMatchObject({ expiringSoon: true, expiresOn: "2026-05-01" });
  });

  it("the three one-tap answers", async () => {
    const a = await dated("Keep Me", "2026-01-01");
    const b = await dated("Standing Soon", "2026-01-01");
    const c = await dated("Let Go", "2026-01-01");
    const day = at("2026-04-26");
    expect(await renewEntry(db, t.clergy, a.id, "keep", day)).toMatchObject({ kind: "dated", dateAdded: "2026-04-26" });
    expect(await renewEntry(db, t.clergy, b.id, "standing", day)).toMatchObject({ kind: "standing" });
    expect(await renewEntry(db, t.clergy, c.id, "let_off", day)).toMatchObject({ endedReason: "expired" });
    expect(await listPrompts(db, t.clergy, day)).toEqual([]);
    await expect(renewEntry(db, t.clergy, a.id, "nonsense", day)).rejects.toThrow();
  });
});

describe("someone who asked not to be listed", () => {
  it("ends the entry, and no form or add brings the name back without a clergy override", async () => {
    const e = await add(t.clergy, "Gil Amir");
    expect(await updateEntry(db, t.clergy, e.id, { consent: "asked_not_listed" }, NOW)).toMatchObject({ endedReason: "asked_to_be_removed", consent: "asked_not_listed" });
    await expect(addEntry(db, t.clergy, { name: "gil  amir" })).rejects.toBeInstanceOf(MiSheberachBarred);
    const forced = await addEntry(db, t.clergy, { name: "Gil Amir", override: true });
    expect(forced.created).toBe(true);
  });

  it("an accepted public-form proposal reports it was barred and still accepts", async () => {
    const e = await add(t.clergy, "Gil Amir");
    await endEntry(db, t.clergy, e.id, "asked_to_be_removed", NOW);
    const id = await createPublicProposal(db, { rawText: "words", intake: { kind: "public_form", about: "Gil Amir", sender: "Dana", contact: "d@x.test" }, mayTellThem: "yes", miSheberach: "yes" });
    const done = await acceptProposal({ db, sf: fakeSf().sf, now: NOW }, t.clergy, id, { target: { kind: "new" }, person: { newOutsidePerson: { name: "Gil Amir" } }, category: "illness", summary: "s", miSheberach: { name: "Gil Amir" } });
    expect(done.miSheberach).toBe("barred");
    expect((await entries()).filter((x) => x.endedAt === null)).toEqual([]);
  });
});

describe("accepting a proposal and the Mi Sheberach offer", () => {
  const entryFor = async (answer: "yes" | "no" | "not_sure", mayTell: "yes" | "no") => {
    const id = await createPublicProposal(db, { rawText: "words", intake: { kind: "public_form", about: "Ruth Cohen", sender: "Dana Levy", contact: "d@x.test" }, mayTellThem: mayTell, miSheberach: answer });
    const [p] = await db.select().from(proposals).where(eq(proposals.id, id));
    return { id, entry: { proposal: p, person: null, intake: { kind: "public_form", about: "Ruth Cohen", sender: "Dana Levy", contact: "d@x.test" } } as unknown as InboxEntry };
  };

  it("offers it ticked for yes, unticked for not sure, and not at all for no; who asked only when we may say they told us", async () => {
    expect(miSheberachFor((await entryFor("yes", "yes")).entry)).toEqual({ offer: "yes", name: "Ruth Cohen", askedBy: "added by Dana Levy" });
    expect(miSheberachFor((await entryFor("not_sure", "no")).entry)).toEqual({ offer: "not_sure", name: "Ruth Cohen", askedBy: "" });
    expect(miSheberachFor((await entryFor("no", "yes")).entry)).toBeUndefined();
  });

  it("puts the name on the list with the public form as its source when ticked, and adds nothing otherwise", async () => {
    const yes = await entryFor("yes", "yes");
    const done = await acceptProposal({ db, sf: fakeSf().sf, now: NOW }, t.clergy, yes.id, { target: { kind: "new" }, person: { newOutsidePerson: { name: "Ruth Cohen" } }, category: "illness", summary: "s", miSheberach: { name: "Ruth Cohen", askedBy: "added by Dana Levy" } });
    expect(done.miSheberach).toBe("added");
    expect(await byName("Ruth Cohen")).toMatchObject({ source: "public_form", consent: "not_confirmed", kind: "dated", askedBy: "added by Dana Levy", careItemId: done.careItemId });
    const none = await entryFor("not_sure", "no");
    const second = await acceptProposal({ db, sf: fakeSf().sf, now: NOW }, t.clergy, none.id, { target: { kind: "new" }, person: { newOutsidePerson: { name: "Sam Roth" } }, category: "illness", summary: "s" });
    expect(second.miSheberach).toBeUndefined();
    expect(await entries()).toHaveLength(1);
  });
});

describe("the sync", () => {
  const doc = (...lines: PacketLine[]) => new FakePacket(lines);
  const live = async () => (await entries()).filter((e) => e.endedAt === null).map((e) => e.name).sort();

  it("not connected: nothing happens and the list works on its own", async () => {
    expect(await syncPacket(db, null, NOW, null, ON)).toEqual({ status: "not_connected" });
    await add(t.clergy, "Ruth Cohen");
    expect((await getSyncStatus(db, t.clergy, "off")).connected).toBe(false);
  });

  it("first run imports every line as confirmed; names that appear later are not yet confirmed", async () => {
    const p = doc(ln("Ann Roth ", "(11/19/26), added by Dana"), ln("Dan Weiss", " (7/10/26 included until further notice)"), ln("Eva Stern", " (1/2/2026) niece of*"));
    const result = await syncPacket(db, p, NOW, null, ON);
    expect(result).toMatchObject({ status: "ok", wrote: false });
    const rows = await entries();
    expect(rows.map((e) => [e.name, e.consent, e.source, e.kind]).sort()).toEqual([
      ["Ann Roth", "confirmed", "bima_packet", "dated"],
      ["Dan Weiss", "confirmed", "bima_packet", "standing"],
      ["Eva Stern", "confirmed", "bima_packet", "dated"],
    ]);
    expect(rows.find((e) => e.name === "Eva Stern")).toMatchObject({ specialRequest: true, askedBy: "niece of", dateAdded: "2026-01-02" });
    expect(p.writes).toEqual([]);
    p.external([ln("Cal Dror", " (11/23/26) friend of Ann"), ...p.lines]);
    await syncPacket(db, p, NOW, null, ON);
    expect(await byName("Cal Dror")).toMatchObject({ consent: "not_confirmed", source: "bima_packet" });
  });

  it("writes an app-added name to the packet, newest first, and leaves untouched lines exactly as they were", async () => {
    const odd = [ln("Ann Roth ", "(11/19/26), added by Dana"), ln("Dan Weiss", " (7/10/26 included until further notice)  friend of  X")];
    const p = doc(...odd);
    await syncPacket(db, p, NOW, null, ON);
    await add(t.clergy, "Cal Dror", { askedBy: "friend of Ann" });
    const r1 = await syncPacket(db, p, NOW, null, ON);
    expect(r1).toMatchObject({ status: "ok", wrote: true });
    expect(p.texts()).toEqual(["Cal Dror (11/24/26) friend of Ann", odd[0].text, odd[1].text]);
    expect(p.lines[0].bold).toEqual([[0, 8]]);
    // Parse, write, parse again: stable, and a further sync writes nothing.
    expect(p.lines.map((l) => parseLine(l)!.name)).toEqual(["Cal Dror", "Ann Roth", "Dan Weiss"]);
    expect((await syncPacket(db, p, NOW, null, ON)) as unknown).toMatchObject({ wrote: false });
    expect(p.writes).toHaveLength(1);
  });

  it("a removal on either side wins over an untouched copy on the other, and the name does not come back", async () => {
    const p = doc(ln("Ann Roth", " (11/19/26)"), ln("Ben Levi", " (11/05/26)"), ln("Cal Dror", " (11/01/26)"));
    await syncPacket(db, p, NOW, null, ON);
    // Removed in the app: the packet's line goes.
    await endEntry(db, t.clergy, (await byName("Ann Roth")).id, "recovered", NOW);
    // Removed in the packet: the entry ends.
    p.external(p.lines.filter((l) => !l.text.startsWith("Ben")));
    const result = await syncPacket(db, p, NOW, null, ON);
    expect(result).toMatchObject({ status: "ok", counts: { removedInPacket: 1, removedFromPacket: 1 } });
    expect(p.texts()).toEqual(["Cal Dror (11/01/26)"]);
    expect(await byName("Ben Levi")).toMatchObject({ endedReason: "removed_in_packet" });
    expect(await live()).toEqual(["Cal Dror"]);
    for (let i = 0; i < 3; i++) await syncPacket(db, p, NOW, null, ON);
    expect(await live()).toEqual(["Cal Dror"]);
    expect(p.texts()).toEqual(["Cal Dror (11/01/26)"]);
  });

  it("an expired entry is taken out of the packet by the next sync", async () => {
    const p = doc(ln("Old Name", " (1/1/26)"), ln("New Name", " (11/20/26)"));
    await syncPacket(db, p, at("2026-02-01"), null, ON);
    await expireDueEntries(db, NOW);
    await syncPacket(db, p, NOW, null, ON);
    expect(p.texts()).toEqual(["New Name (11/20/26)"]);
  });

  it("a line edited in the packet updates the same entry; a retyped name is remove plus add, flagged for a person", async () => {
    const p = doc(ln("Ann Roth", " (11/19/26)"), ln("Ben Levi", " (11/05/26)"));
    await syncPacket(db, p, NOW, null, ON);
    p.external([ln("Ann Roth", " (11/19/26) friend of Dana"), ln("Benjamin Roth", " (11/05/26)")]);
    await syncPacket(db, p, NOW, null, ON);
    const rows = await entries();
    expect(rows.filter((e) => e.name === "Ann Roth")).toHaveLength(1);
    expect(await byName("Ann Roth")).toMatchObject({ askedBy: "friend of Dana", needsReview: false });
    expect(await byName("Ben Levi")).toMatchObject({ endedReason: "removed_in_packet" });
    expect(await byName("Benjamin Roth")).toMatchObject({ needsReview: true, consent: "not_confirmed" });
  });

  it("someone who asked not to be listed is never re-added from the packet; the line is left where it is and clergy are told", async () => {
    const e = await add(t.clergy, "Gil Amir");
    await updateEntry(db, t.clergy, e.id, { consent: "asked_not_listed" }, NOW);
    const p = doc(ln("Ann Roth", " (11/19/26)"));
    await syncPacket(db, p, NOW, null, ON);
    p.external([ln("Gil Amir", " (11/24/26)"), ...p.lines]);
    const result = await syncPacket(db, p, NOW, null, ON);
    expect(result).toMatchObject({ status: "ok", counts: { blocked: 1 } });
    expect(await live()).toEqual(["Ann Roth"]);
    expect(p.texts()).toEqual(["Gil Amir (11/24/26)", "Ann Roth (11/19/26)"]);
    expect(p.writes).toEqual([]);
    expect((await getSyncStatus(db, t.clergy, "on")).counts).toMatchObject({ blocked: 1 });
  });

  it("a revision conflict re-reads and retries once; a second conflict stops, recording the error name only", async () => {
    const p = doc(ln("Ann Roth", " (11/19/26)"));
    await syncPacket(db, p, NOW, null, ON);
    await add(t.clergy, "Cal Dror");
    p.conflicts = 1;
    const reads = p.reads;
    expect(await syncPacket(db, p, NOW, null, ON)).toMatchObject({ status: "ok", wrote: true });
    expect(p.reads - reads).toBe(2);
    await add(t.clergy, "Dee Mor");
    p.conflicts = 2;
    const before = p.texts();
    expect(await syncPacket(db, p, NOW, null, ON)).toEqual({ status: "failed", errorName: "PacketRevisionConflict" });
    expect(p.texts()).toEqual(before);
    const status = await getSyncStatus(db, t.clergy, "on");
    expect(status).toMatchObject({ ok: false, errorName: "PacketRevisionConflict", counts: null });
  });

  it("stops without writing when the section cannot be found exactly once, and shows only the error name", async () => {
    const p = doc(ln("Ann Roth", " (11/19/26)"));
    await syncPacket(db, p, NOW, null, ON);
    await add(t.clergy, "Cal Dror");
    p.failRead = new PacketSectionNotFound();
    const writes = p.writes.length;
    expect(await syncPacket(db, p, NOW, null, ON)).toEqual({ status: "failed", errorName: "PacketSectionNotFound" });
    expect(p.writes).toHaveLength(writes);
    const [state] = await db.select().from(miSheberachSync);
    expect(state).toMatchObject({ ok: false, errorName: "PacketSectionNotFound" });
    expect(JSON.stringify(state.counts)).toBe("null");
  });

  it("a document with the heading twice is refused before any write", async () => {
    const heading = { paragraph: { elements: [{ textRun: { content: `${SECTION_HEADING}\n` } }], paragraphStyle: { namedStyleType: "HEADING_2" } }, startIndex: 1, endIndex: 17 };
    const end = { paragraph: { elements: [{ textRun: { content: `${SECTION_END}\n` } }], paragraphStyle: { namedStyleType: "NORMAL_TEXT" } }, startIndex: 40, endIndex: 62 };
    const document = { revisionId: "x", body: { content: [heading, heading, end] } } as unknown as GoogleDocument;
    let wrote = false;
    const p: PacketDoc = {
      read: async () => locateSection(document),
      write: async (read, edits) => {
        wrote = true;
        buildWriteRequests(read, edits);
      },
      describe: async () => describeSection(document),
    };
    await add(t.clergy, "Cal Dror");
    expect(await syncPacket(db, p, NOW, null, ON)).toEqual({ status: "failed", errorName: "PacketSectionAmbiguous" });
    expect(wrote).toBe(false);
  });

  it("Sync now is rate limited per person", async () => {
    const p = doc(ln("Ann Roth", " (11/19/26)"));
    const results = [];
    for (let i = 0; i < 8; i++) results.push((await syncNow(db, p, t.clergy, NOW, ON)).status);
    expect(results.filter((s) => s === "ok")).toHaveLength(6);
    expect(results.slice(6)).toEqual(["limited", "limited"]);
    expect((await syncNow(db, p, t.owner, NOW, ON)).status).toBe("ok");
  });

  it("logs and audits no name or line text anywhere", async () => {
    const SECRET = "Zerubbabel Quillfeather";
    const p = doc(ln(SECRET, " (11/19/26), added by Hephzibah Marsh"));
    await syncPacket(db, p, NOW, null, ON);
    await add(t.clergy, "Ottoline Brightwater", { askedBy: "friend of Hephzibah Marsh" });
    p.failRead = new PacketSectionNotFound();
    await syncPacket(db, p, NOW, null, ON);
    p.failRead = null;
    await syncNow(db, p, t.clergy, NOW, ON);
    await endEntry(db, t.clergy, (await byName("Ottoline Brightwater")).id, "died", NOW);
    expect(words(logged)).not.toMatch(/Zerubbabel|Hephzibah|Ottoline|Brightwater/);
    expect(words(await db.select().from(auditLog))).not.toMatch(/Zerubbabel|Hephzibah|Ottoline|Brightwater/);
    expect((await db.select().from(auditLog)).some((x) => x.action === "mi_sheberach.sync")).toBe(true);
  });
});

describe("the daily job", () => {
  it("expires names, syncs the packet, and a failed sync does not stop the other tasks", async () => {
    const e = await add(t.clergy, "Old Name");
    await db.update(miSheberachEntries).set({ dateAdded: "2026-01-01" }).where(eq(miSheberachEntries.id, e.id));
    const p = new FakePacket([]);
    p.failRead = new PacketSectionNotFound();
    const tasks = DAILY_TASKS.filter((x) => ["mi_sheberach_expiry", "mi_sheberach_sync", "housekeeping"].includes(x.key));
    expect(tasks.map((x) => x.key)).toEqual(["mi_sheberach_expiry", "mi_sheberach_sync", "housekeeping"]);
    const results = await runDailyJob({ db, now: NOW, owners: new Set(), origin: null, packet: p }, tasks);
    expect(results.map((x) => [x.task, x.ok, x.errorName])).toEqual([
      ["mi_sheberach_expiry", true, null],
      ["mi_sheberach_sync", false, "PacketSectionNotFound"],
      ["housekeeping", true, null],
    ]);
    expect(results[0].counts).toEqual({ expired: 1 });
    const runs = await db.select().from(jobRuns);
    expect(JSON.stringify(runs)).not.toContain("Old Name");
  });

  it("with the packet not configured the sync task is a quiet success", async () => {
    const tasks = DAILY_TASKS.filter((x) => x.key === "mi_sheberach_sync");
    const results = await runDailyJob({ db, now: NOW, owners: new Set(), origin: null, packet: null }, tasks);
    expect(results).toMatchObject([{ ok: true, counts: { connected: 0 } }]);
  });
});

// ─── the safety of the sync ──────────────────────────────────────────────────────────

describe("the sync's safety", () => {
  const names = ["Ann Roth", "Ben Levi", "Cal Dror", "Dee Mor", "Eli Ron", "Fay Gold"];
  const six = () => new FakePacket(names.map((n, i) => ln(n, ` (11/${20 - i}/26)`)));
  const live = async () => (await db.select().from(miSheberachEntries)).filter((e) => e.endedAt === null).map((e) => e.name).sort();
  const entry = async (name: string) => (await db.select().from(miSheberachEntries)).find((e) => e.name === name)!;

  it("a second sync with nothing changed writes nothing, whatever the lines look like", async () => {
    const p = new FakePacket([
      { text: "Ann Roth (11/19/26) friend of Dana", bold: [[0, 34]] },
      { text: "Ben and Bob Levi (11/18/26)", bold: [[0, 3]] },
      { text: "Cal Dror and Dee Mor (11/17/26)", bold: [[0, 8], [13, 20]] },
      { text: "Eli Ron", bold: [[0, 7]] },
      ln("Fay Gold  ", "(7/10/26 included until further notice)*"),
    ]);
    await syncPacket(db, p, NOW, null, ON);
    const before = p.texts();
    for (let i = 0; i < 3; i++) expect(await syncPacket(db, p, NOW, null, ON)).toMatchObject({ status: "ok", wrote: false });
    expect(p.writes).toEqual([]);
    expect(p.texts()).toEqual(before);
    // One person's edit changes one paragraph and nothing else.
    await updateEntry(db, t.clergy, (await entry("Eli Ron")).id, { askedBy: "friend of Z" });
    await syncPacket(db, p, NOW, null, ON);
    expect(p.writes).toHaveLength(1);
    expect(p.writes[0].replace).toHaveLength(1);
    expect(p.writes[0].remove).toEqual([]);
    expect(p.texts().filter((x, i) => before[i] === x)).toHaveLength(4);
  });

  it("two lines with one name stay as they are: one entry, the other line kept verbatim and counted, never dropped", async () => {
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)"), ln("Ben Levi", " (11/18/26)"), ln("Ann Roth", " (11/17/26) a different Ann")]);
    expect(await syncPacket(db, p, NOW, null, ON)).toMatchObject({ status: "ok", counts: { duplicates: 1, addedFromPacket: 2 } });
    expect(await live()).toEqual(["Ann Roth", "Ben Levi"]);
    await add(t.clergy, "Cal Dror");
    await syncPacket(db, p, NOW, null, ON);
    expect(p.texts()).toContain("Ann Roth (11/17/26) a different Ann");
    expect(p.texts()).toHaveLength(4);
    expect((await getSyncStatus(db, t.clergy, "on")).counts).toMatchObject({ duplicates: 1 });
  });

  it("lines the app cannot read are carried exactly where they are and counted", async () => {
    const odd = [{ text: "", bold: [] }, { text: "Some words that are not a name", bold: [] }];
    const p = new FakePacket([odd[0], ln("Ann Roth", " (11/19/26)"), odd[1], ln("Ben Levi", " (11/18/26)")]);
    expect(await syncPacket(db, p, NOW, null, ON)).toMatchObject({ status: "ok", counts: { leftAlone: 2 } });
    await add(t.clergy, "Cal Dror", { askedBy: "friend of Ann" });
    await endEntry(db, t.clergy, (await entry("Ben Levi")).id, "recovered", NOW);
    await syncPacket(db, p, NOW, null, ON);
    expect(p.texts()).toEqual(["", "Cal Dror (11/24/26) friend of Ann", "Ann Roth (11/19/26)", "Some words that are not a name"]);
  });

  it("refuses a run that would end more than a third of the list from the packet's side, changes nothing, and says so with counts", async () => {
    const p = six();
    await syncPacket(db, p, NOW, null, ON);
    p.external(p.lines.slice(4));
    expect(await syncPacket(db, p, NOW, null, ON)).toEqual({ status: "failed", errorName: "PacketChangeTooLarge" });
    expect(await live()).toEqual([...names].sort());
    expect(p.writes).toEqual([]);
    const status = await getSyncStatus(db, t.clergy, "on");
    expect(status).toMatchObject({ ok: false, errorName: "PacketChangeTooLarge", counts: { wouldEnd: 4, live: 6 } });
    expect(status.plan?.endEntries).toHaveLength(4);
    // Clergy press "Apply anyway": that one run goes through, and is audited.
    expect(await syncNow(db, p, t.clergy, NOW, { mode: "on", force: true })).toMatchObject({ status: "ok" });
    expect(await live()).toEqual(["Eli Ron", "Fay Gold"]);
    expect((await db.select().from(auditLog)).some((x) => x.action === "mi_sheberach.apply_anyway")).toBe(true);
    await expect(syncNow(db, p, t.carer, NOW, { mode: "on", force: true })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("refuses a run that would take more than a third of the lines out of the packet from the app's side", async () => {
    const p = six();
    await syncPacket(db, p, NOW, null, ON);
    for (const n of names.slice(0, 4)) await endEntry(db, t.clergy, (await entry(n)).id, "recovered", NOW);
    expect(await syncPacket(db, p, NOW, null, ON)).toEqual({ status: "failed", errorName: "PacketChangeTooLarge" });
    expect(p.writes).toEqual([]);
    expect(p.lines).toHaveLength(6);
  });

  it("a small change is not stopped", async () => {
    const q = six();
    await syncPacket(db, q, NOW, null, ON);
    await endEntry(db, t.clergy, (await entry("Fay Gold")).id, "recovered", NOW);
    expect(await syncPacket(db, q, NOW, null, ON)).toMatchObject({ status: "ok", wrote: true });
    expect(q.lines).toHaveLength(5);
  });

  it("zero bullets with a snapshot is a structure problem, not 'everyone was removed'", async () => {
    const p = six();
    await syncPacket(db, p, NOW, null, ON);
    p.external([]);
    expect(await syncPacket(db, p, NOW, null, ON)).toEqual({ status: "failed", errorName: "PacketStructureUnexpected" });
    expect(await live()).toHaveLength(6);
  });

  it("a section with suggested edits stops the run", async () => {
    const document = makeDoc([...BEFORE, ...bullets([ln("Ann Roth", " (11/19/26)")], { suggested: true }), ...AFTER]);
    const p: PacketDoc = { read: async () => locateSection(document), write: async () => undefined, describe: async () => describeSection(document) };
    expect(await syncPacket(db, p, NOW, null, ON)).toEqual({ status: "failed", errorName: "PacketHasSuggestions" });
    expect(() => locateSection(document)).toThrow(PacketHasSuggestions);
  });

  it("names imported with their 120 days up get the prompt and a week's grace before they can come off", async () => {
    const p = new FakePacket([ln("Old Name", " (1/2/26)"), ln("Fresh Name", " (11/20/26)")]);
    await syncPacket(db, p, NOW, null, ON);
    expect((await listPrompts(db, t.clergy, NOW)).map((x) => [x.name, x.expiresOn])).toEqual([["Old Name", "2026-12-01"]]);
    expect(await expireDueEntries(db, NOW)).toEqual({ expired: 0 });
    expect(await expireDueEntries(db, at("2026-11-30"))).toEqual({ expired: 0 });
    expect(await expireDueEntries(db, at("2026-12-01"))).toEqual({ expired: 1 });
    // Answering the prompt first: "keep" starts 120 days over.
    const q = new FakePacket([ln("Older Name", " (1/3/26)")]);
    await syncPacket(db, q, NOW, null, ON);
    const older = await entry("Older Name");
    expect(await renewEntry(db, t.clergy, older.id, "keep", NOW)).toMatchObject({ dateAdded: TODAY, keepUntil: null });
  });

  it("the first run matches names already on the list to the packet's lines before importing or writing anything", async () => {
    await add(t.clergy, "Ann Roth");
    await add(t.clergy, "Cal Dror");
    const p = new FakePacket([ln("Ann  Roth", " (11/19/26)"), ln("Ben Levi", " (11/18/26)")]);
    expect(await syncPacket(db, p, NOW, null, ON)).toMatchObject({ status: "ok", counts: { addedFromPacket: 1 } });
    const rows = await db.select().from(miSheberachEntries);
    expect(rows.filter((r) => r.name.replace(/\s+/g, " ") === "Ann Roth")).toHaveLength(1);
    expect(rows.find((r) => r.name === "Ben Levi")).toMatchObject({ consent: "confirmed" });
    expect(p.texts()).toContain("Ann  Roth (11/19/26)");
    expect(p.texts().some((x) => x.startsWith("Cal Dror"))).toBe(true);
  });

  it("a lost snapshot is a read-only reconciliation: nothing is written, nothing ended, nothing resurrected", async () => {
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)"), ln("Ben Levi", " (11/18/26)")]);
    await syncPacket(db, p, NOW, null, ON);
    await endEntry(db, t.clergy, (await entry("Ben Levi")).id, "recovered", NOW);
    await db.update(miSheberachSync).set({ snapshot: null });
    p.external([...p.lines, ln("Brand New", " (11/20/26)")]);
    const before = p.texts();
    expect(await syncPacket(db, p, NOW, null, ON)).toMatchObject({ status: "ok", wrote: false, counts: { reconciled: 1, stillInPacket: 1, created: 1, matched: 1 } });
    expect(p.writes).toEqual([]);
    expect(p.texts()).toEqual(before);
    expect(await live()).toEqual(["Ann Roth", "Brand New"]);
    expect((await entry("Ben Levi")).endedReason).toBe("recovered");
    expect((await db.select().from(miSheberachEntries)).filter((e) => e.name === "Ben Levi")).toHaveLength(1);
  });

  it("an entry a person edits while the sync is writing is skipped and converges on the next run", async () => {
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)")]);
    await syncPacket(db, p, NOW, null, ON);
    const cal = await add(t.clergy, "Cal Dror");
    const edit = async (tx: Db) => void (await updateEntry(tx, t.clergy, cal.id, { askedBy: "friend of Ann" }));
    expect(await syncPacket(db, p, NOW, null, { mode: "on", onPlanned: edit })).toMatchObject({ status: "ok", counts: { skipped: 1 } });
    expect((await entry("Cal Dror")).docLine).toBeNull();
    await syncPacket(db, p, NOW, null, ON);
    expect(p.texts()).toContain("Cal Dror (11/24/26) friend of Ann");
    expect(p.texts().filter((x) => x.startsWith("Cal Dror"))).toHaveLength(1);
    await syncPacket(db, p, NOW, null, ON);
    expect(p.texts().filter((x) => x.startsWith("Cal Dror"))).toHaveLength(1);
  });

  it("trial mode reads the packet and records what it would do, and changes nothing", async () => {
    await add(t.clergy, "Cal Dror");
    await syncPacket(db, new FakePacket([]), NOW, null, { mode: "on" });
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)")]);
    await db.update(miSheberachSync).set({ snapshot: [], lastOkAt: null });
    const result = await syncPacket(db, p, NOW, null, { mode: "dry-run" });
    expect(result).toMatchObject({ status: "ok", wrote: false, dryRun: true });
    expect(p.writes).toEqual([]);
    expect((await db.select().from(miSheberachEntries)).map((e) => e.name)).toEqual(["Cal Dror"]);
    const status = await getSyncStatus(db, t.clergy, "dry-run");
    expect(status.plan?.addEntries).toEqual(["Ann Roth"]);
    expect(status.plan?.addLines).toEqual(["Cal Dror (11/24/26)"]);
    expect(status.counts).toMatchObject({ wouldAdd: 1 });
  });

  it("the first-run import in trial mode makes entries (agreed) and a snapshot, and still writes nothing to the packet", async () => {
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)"), ln("Ben Levi", " (11/18/26)")]);
    await add(t.clergy, "Cal Dror");
    expect(await syncPacket(db, p, NOW, null, { mode: "dry-run", importOnly: true })).toMatchObject({ status: "ok", dryRun: true });
    expect(p.writes).toEqual([]);
    const rows = await db.select().from(miSheberachEntries);
    expect(rows.filter((r) => r.source === "bima_packet").map((r) => [r.name, r.consent])).toEqual([["Ann Roth", "confirmed"], ["Ben Levi", "confirmed"]]);
    expect((await entryDocLine("Cal Dror"))).toBeNull();
    // Only once: a second import press does nothing more.
    await syncPacket(db, p, NOW, null, { mode: "dry-run", importOnly: true });
    expect(await db.select().from(miSheberachEntries)).toHaveLength(3);
    expect((await getSyncStatus(db, t.clergy, "dry-run")).canImport).toBe(false);
  });

  async function entryDocLine(name: string) {
    return (await entry(name)).docLine;
  }

  it("the owner's shape check returns counts only, and only the owner may ask", async () => {
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)")]);
    const d = await describePacket(db, p, t.owner, NOW);
    expect(d).toMatchObject({ bullets: 1 });
    expect(JSON.stringify(d)).not.toContain("Ann");
    await expect(describePacket(db, p, t.clergy, NOW)).rejects.toBeInstanceOf(AccessDenied);
    expect(await describePacket(db, null, t.owner, NOW)).toBeNull();
  });

  it("trial mode is the daily job's mode when configured so, and 'off' reads nothing", async () => {
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)")]);
    const tasks = DAILY_TASKS.filter((x) => x.key === "mi_sheberach_sync");
    const dry = await runDailyJob({ db, now: NOW, owners: new Set(), origin: null, packet: p, packetMode: "dry-run" }, tasks);
    expect(dry[0].counts).toMatchObject({ addedFromPacket: 1, wrote: 0 });
    expect(await db.select().from(miSheberachEntries)).toEqual([]);
    const off = await runDailyJob({ db, now: NOW, owners: new Set(), origin: null, packet: p, packetMode: "off" }, tasks);
    expect(off[0]).toMatchObject({ ok: true, counts: { connected: 0 } });
    expect(p.reads).toBe(1);
  });
});

describe("trial mode, the standing notice and Apply anyway", () => {
  const names = ["Ann Roth", "Ben Levi", "Cal Dror", "Dee Mor", "Eli Ron", "Fay Gold"];
  const six = () => new FakePacket(names.map((n, i) => ln(n, ` (11/${20 - i}/26)`)));
  const live = async () => (await db.select().from(miSheberachEntries)).filter((e) => e.endedAt === null).map((e) => e.name).sort();
  const entry = async (name: string) => (await db.select().from(miSheberachEntries)).find((e) => e.name === name)!;
  const DRY = { mode: "dry-run" } as const;

  it("a trial-mode check never sets 'last synced', keeps the import on offer, and switching to on then takes the ordinary first-run path", async () => {
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)"), ln("Ben Levi", " (11/18/26)")]);
    await syncPacket(db, p, NOW, null, DRY);
    await syncPacket(db, p, at("2026-11-25"), null, DRY);
    const status = await getSyncStatus(db, t.clergy, "dry-run");
    expect(status).toMatchObject({ lastOkAt: null, canImport: true });
    expect(status.lastCheckedAt).toEqual(at("2026-11-25"));
    expect(status.counts).toMatchObject({ dryRun: 1 });
    // On: the first run, with names confirmed, not a reconciliation.
    const result = await syncPacket(db, p, at("2026-11-26"), null, ON);
    expect(result).toMatchObject({ status: "ok", wrote: false });
    expect(result.status === "ok" && result.counts.reconciled).toBeUndefined();
    expect((await db.select().from(miSheberachEntries)).map((e) => e.consent)).toEqual(["confirmed", "confirmed"]);
    const after = await getSyncStatus(db, t.clergy, "on");
    expect(after.lastOkAt).toEqual(at("2026-11-26"));
    expect(after.lastCheckedAt).toBeNull();
  });

  it("an import leaves 'last synced' empty and the next on-run ordinary", async () => {
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)")]);
    await syncPacket(db, p, NOW, null, { mode: "dry-run", importOnly: true });
    expect(await getSyncStatus(db, t.clergy, "dry-run")).toMatchObject({ lastOkAt: null, canImport: false });
    expect(await syncPacket(db, p, NOW, null, ON)).toMatchObject({ status: "ok", wrote: false });
  });

  it("a real run keeps what it is leaving alone, by kind, and 'Remove it from the packet' takes only the barred lines out, audited, through the normal write", async () => {
    const gil = await add(t.clergy, "Gil Amir");
    await updateEntry(db, t.clergy, gil.id, { consent: "asked_not_listed" }, NOW);
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)"), ln("Gil Amir", " (11/20/26)"), { text: "stray words", bold: [] }, ln("Ann Roth", " (11/10/26) other")]);
    expect(await syncPacket(db, p, NOW, null, ON)).toMatchObject({ status: "ok", counts: { blocked: 1, leftAlone: 1, duplicates: 1 } });
    const status = await getSyncStatus(db, t.clergy, "on");
    expect(status.counts).toMatchObject({ blocked: 1, leftAlone: 1, duplicates: 1 });
    expect(status.plan?.leftAlone.map((l) => l.why).sort()).toEqual(["asked_not_listed", "duplicate", "unreadable"]);
    expect(status.plan?.addLines).toEqual([]);
    expect(p.writes).toEqual([]);
    // Only a clergy member or the owner may ask, and only barred lines go.
    await expect(syncNow(db, p, t.carer, NOW, { mode: "on", removeBarred: true })).rejects.toBeInstanceOf(AccessDenied);
    expect(await syncNow(db, p, t.clergy, NOW, { mode: "on", removeBarred: true })).toMatchObject({ status: "ok", wrote: true });
    expect(p.texts()).toEqual(["Ann Roth (11/19/26)", "stray words", "Ann Roth (11/10/26) other"]);
    expect((await db.select().from(auditLog)).some((x) => x.action === "mi_sheberach.remove_barred")).toBe(true);
    // Not in trial mode: it only plans.
    const q = new FakePacket([ln("Gil Amir", " (11/20/26)")]);
    await syncPacket(db, q, NOW, null, { mode: "dry-run", removeBarred: true });
    expect(q.writes).toEqual([]);
  });

  it("the brake counts lines it would change, not only names it would end and lines it would remove", async () => {
    const p = six();
    await syncPacket(db, p, NOW, null, ON);
    for (const n of names.slice(0, 4)) await updateEntry(db, t.clergy, (await entry(n)).id, { askedBy: "friend of Z" });
    expect(await syncPacket(db, p, NOW, null, ON)).toEqual({ status: "failed", errorName: "PacketChangeTooLarge" });
    expect(p.writes).toEqual([]);
    expect((await getSyncStatus(db, t.clergy, "on")).counts).toMatchObject({ wouldChange: 4 });
  });

  it("'Apply anyway' covers only the plan that was shown: a bigger plan stops again and shows the new one; with nothing shown it does not bypass the brake", async () => {
    const p = six();
    await syncPacket(db, p, NOW, null, ON);
    // Nothing has been shown yet: forcing does not get past the brake.
    p.external(p.lines.slice(4));
    expect(await syncNow(db, p, t.clergy, NOW, { mode: "on", force: true })).toEqual({ status: "failed", errorName: "PacketChangeTooLarge" });
    expect(await live()).toHaveLength(6);
    // Now the plan has been shown (4 names). Before anyone presses the button the packet changes again: 5 names.
    p.external(p.lines.slice(1));
    expect(await syncNow(db, p, t.clergy, at("2026-11-24"), { mode: "on", force: true })).toEqual({ status: "failed", errorName: "PacketChangeTooLarge" });
    expect(await live()).toHaveLength(6);
    expect((await getSyncStatus(db, t.clergy, "on")).counts).toMatchObject({ wouldEnd: 5 });
    // The new plan was shown; applying exactly that goes through, and is audited.
    expect(await syncNow(db, p, t.clergy, NOW, { mode: "on", force: true })).toMatchObject({ status: "ok" });
    expect(await live()).toEqual(["Fay Gold"]);
    expect((await db.select().from(auditLog)).filter((x) => x.action === "mi_sheberach.apply_anyway")).toHaveLength(1);
  });
  it("'Apply anyway' applies only the same plan that was shown, not another plan of the same size", async () => {
    const p = six();
    await syncPacket(db, p, NOW, null, ON);
    const all = p.lines;
    // Shown: the names on lines 0 to 3 would end.
    p.external(all.slice(4));
    expect(await syncPacket(db, p, NOW, null, ON)).toEqual({ status: "failed", errorName: "PacketChangeTooLarge" });
    // Before anyone presses the button the packet changes: a different four would end (same counts).
    p.external(all.slice(0, 2));
    expect(await syncNow(db, p, t.clergy, NOW, { mode: "on", force: true })).toEqual({ status: "failed", errorName: "PacketChangeTooLarge" });
    expect(await live()).toHaveLength(6);
    // That new plan is now the one shown; applying exactly it goes through.
    expect(await syncNow(db, p, t.clergy, NOW, { mode: "on", force: true })).toMatchObject({ status: "ok" });
    expect(await live()).toHaveLength(2);
  });

  it("a failed run keeps the previous run's left-alone notice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const p = new FakePacket([ln("Ann Roth", " (11/19/26)"), { text: "stray words", bold: [] }]);
    expect(await syncPacket(db, p, NOW, null, ON)).toMatchObject({ status: "ok" });
    expect((await getSyncStatus(db, t.clergy, "on")).plan?.leftAlone).toEqual([{ text: "stray words", why: "unreadable" }]);
    const broken = { read: async () => { throw new Error("down"); }, write: async () => undefined, describe: async () => null } as unknown as PacketDoc;
    expect(await syncPacket(db, broken, NOW, null, ON)).toMatchObject({ status: "failed" });
    const status = await getSyncStatus(db, t.clergy, "on");
    expect(status.ok).toBe(false);
    expect(status.plan?.leftAlone).toEqual([{ text: "stray words", why: "unreadable" }]);
  });
});

describe("what goes into a name", () => {
  it("refuses controls, bidirectional and zero-width marks, private-use characters, unpaired surrogates and over-long names or requesters", async () => {
    for (const bad of ["Ruth\u0007Cohen", "Ruth\u202eCohen", "Ruth\u200bCohen", "Ruth\ud800Cohen", "Ruth\u000bCohen", "Ruth\u007fCohen", "N".repeat(121)]) {
      await expect(addEntry(db, t.clergy, { name: bad }), JSON.stringify(bad)).rejects.toThrow();
    }
    await expect(addEntry(db, t.clergy, { name: "Ruth Cohen", askedBy: "x".repeat(201) })).rejects.toThrow();
    expect((await addEntry(db, t.clergy, { name: "N".repeat(120), askedBy: "x".repeat(200) })).created).toBe(true);
    // Line breaks and tabs become spaces, as before.
    expect((await addEntry(db, t.clergy, { name: "A\tB\nC" })).entry.name).toBe("A B C");
  });

  it("renaming an entry to the name of someone who asked not to be listed is refused", async () => {
    const gone = await add(t.clergy, "Gil Amir");
    await endEntry(db, t.clergy, gone.id, "asked_to_be_removed", NOW);
    const other = await add(t.clergy, "Ann Roth");
    await expect(updateEntry(db, t.clergy, other.id, { name: "Gil  Amir" })).rejects.toBeInstanceOf(MiSheberachBarred);
    expect((await entries()).find((e) => e.id === other.id)!.name).toBe("Ann Roth");
  });

  it("a sender who answered no is not put on the list by an ordinary accept; an explicit override is audited", async () => {
    const make = () => createPublicProposal(db, { rawText: "words", intake: { kind: "public_form", about: "Ruth Cohen", sender: "Dana", contact: "d@x.test" }, mayTellThem: "yes", miSheberach: "no" });
    const decision = (override?: boolean) => ({ target: { kind: "new" }, person: { newOutsidePerson: { name: "Ruth Cohen" } }, category: "illness", summary: "s", miSheberach: { name: "Ruth Cohen", ...(override ? { override } : {}) } });
    await expect(acceptProposal({ db, sf: fakeSf().sf, now: NOW }, t.clergy, await make(), decision())).rejects.toThrow();
    expect(await entries()).toEqual([]);
    const done = await acceptProposal({ db, sf: fakeSf().sf, now: NOW }, t.clergy, await make(), decision(true));
    expect(done.miSheberach).toBe("added");
    expect((await db.select().from(auditLog)).some((x) => x.action === "mi_sheberach.add_over_no")).toBe(true);
  });
});
