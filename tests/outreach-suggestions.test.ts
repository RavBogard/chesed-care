import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { closeCareItem, createCareItem } from "@/server/care/care-items";
import { createContactEntry } from "@/server/care/contact-log";
import { createFollowUp } from "@/server/care/follow-ups";
import { dismissSuggestion, getOutreachSuggestions, MAX_SUGGESTIONS } from "@/server/care/suggestions";
import { getTodayPrefs, setTodayPrefs } from "@/server/care/today-prefs";
import { InvalidInput } from "@/server/care/validate";
import { careItems, followUps, suggestionDismissals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { purgeOldDismissals } from "@/server/daily/housekeeping";
import { startJourney } from "@/server/journeys/journeys";
import { firstYahrzeit } from "@/server/journeys/plan";
import { addDays } from "@/server/lifecycle/window";
import { addEntry } from "@/server/misheberach/list";
import { CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";
import { words } from "./support/words";

// Tuesday 1 December 2026, noon in St. Louis.
const NOW = new Date("2026-12-01T18:00:00Z");
const TODAY = "2026-12-01";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
});

const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const age = (id: string, days: number) => db.update(careItems).set({ createdAt: ago(days) }).where(eq(careItems.id, id));
const item = (over: Record<string, unknown> = {}, who = t.clergy) => createCareItem(db, who, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness", ...over });
const kinds = async (who = t.clergy, now = NOW) => (await getOutreachSuggestions(db, who, now)).map((s) => s.kind);

describe("you might reach out to", () => {
  it("suggests an open item with no contact in 21 days, with its reason, and not a recent or newly made one", async () => {
    const stale = await item({ displayName: "Stale Contact" });
    await age(stale.id, 60);
    await createContactEntry(db, t.clergy, { careItemId: stale.id, kind: "call", occurredAt: ago(26).toISOString() });
    const never = await item({ sfContactId: CONTACT2, displayName: "Never Contacted" });
    await age(never.id, 40);
    const recent = await item({ sfContactId: "003000000000003AAA", displayName: "Recent Contact" });
    await age(recent.id, 60);
    await createContactEntry(db, t.clergy, { careItemId: recent.id, kind: "call", occurredAt: ago(5).toISOString() });
    await item({ sfContactId: "003000000000004AAA", displayName: "Brand New" });

    const list = await getOutreachSuggestions(db, t.clergy, NOW);
    expect(list.map((s) => s.name)).toEqual(["Never Contacted", "Stale Contact"]);
    expect(list[1].reason).toMatch(/since/i);
    expect(list.every((s) => s.kind === "no_contact" && s.href.startsWith("/people/"))).toBe(true);
    // Reasons are words, never a score.
    expect(words(list)).not.toMatch(/risk|score|priority/i);
  });

  it("suggests a closed bereavement item whose first yahrzeit is within 14 days and nothing is planned", async () => {
    // Find a date of death whose first yahrzeit falls 4 days from today.
    let anchor = "";
    for (let d = 30; d < 390 && !anchor; d++) if (firstYahrzeit(addDays(TODAY, -d)) === addDays(TODAY, 4)) anchor = addDays(TODAY, -d);
    expect(anchor).not.toBe("");
    const planned = await item({ category: "bereavement", displayName: "Planned Family" });
    const unplanned = await item({ sfContactId: CONTACT2, category: "bereavement", displayName: "Unplanned Family" });
    for (const i of [planned, unplanned]) await startJourney(db, t.clergy, i.id, { templateKey: "bereavement_year", anchorDate: anchor }, ago(3));
    await createFollowUp(db, t.clergy, { careItemId: planned.id, title: "Call at the yahrzeit", dueDate: addDays(TODAY, 4) });
    for (const i of [planned, unplanned]) await closeCareItem(db, t.clergy, i.id, ago(1));
    const list = await getOutreachSuggestions(db, t.clergy, NOW);
    expect(list.map((s) => [s.kind, s.name])).toEqual([["first_yahrzeit", "Unplanned Family"]]);
    expect(list[0].reason).toContain("first yahrzeit");
  });

  it("suggests a standing check-in overdue by more than a week", async () => {
    const i = await item({ category: "ongoing" });
    await createContactEntry(db, t.clergy, { careItemId: i.id, kind: "call", occurredAt: ago(2).toISOString() });
    const { followUpIds } = await startJourney(db, t.clergy, i.id, { templateKey: "standing", anchorDate: addDays(TODAY, -30), intervalWeeks: 2 }, ago(30));
    await db.update(followUps).set({ dueDate: addDays(TODAY, -8) }).where(eq(followUps.id, followUpIds[0]));
    expect(await kinds()).toEqual(["standing_overdue"]);
    await db.update(followUps).set({ dueDate: addDays(TODAY, -6) }).where(eq(followUps.id, followUpIds[0]));
    expect(await kinds()).toEqual([]);
  });

  it("suggests a Mi Sheberach name on the list over 60 days with no linked contact in 30", async () => {
    await addEntry(db, t.clergy, { name: "Old Name" }, { now: ago(70) });
    await addEntry(db, t.clergy, { name: "Young Name" }, { now: ago(20) });
    const contacted = await addEntry(db, t.clergy, { name: "Contacted Name", sfContactId: CONTACT }, { now: ago(90) });
    await createContactEntry(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", kind: "call", occurredAt: ago(10).toISOString() });
    const list = await getOutreachSuggestions(db, t.clergy, NOW);
    expect(list.map((s) => s.name)).toEqual(["Old Name"]);
    expect(list[0].href).toBe("/mi-sheberach");
    expect(list.find((s) => s.subjectId === contacted.entry.id)).toBeUndefined();
  });

  it("never offers more than five", async () => {
    for (let n = 0; n < MAX_SUGGESTIONS + 3; n++) {
      const i = await item({ sfContactId: `00300000000010${n}AAA`, displayName: `Person ${n}` });
      await age(i.id, 50 + n);
    }
    expect(await getOutreachSuggestions(db, t.clergy, NOW)).toHaveLength(MAX_SUGGESTIONS);
  });

  it("can be set aside for 30 days, and comes back after", async () => {
    const i = await item();
    await age(i.id, 60);
    const [s] = await getOutreachSuggestions(db, t.clergy, NOW);
    await dismissSuggestion(db, t.clergy, { kind: s.kind, subjectId: s.subjectId }, NOW);
    expect(await kinds()).toEqual([]);
    // Someone else still sees it; the dismissal is the person's own.
    expect(await kinds(t.owner)).toEqual([]); // the owner holds nothing
    expect(await kinds(t.clergy, new Date(NOW.getTime() + 29 * 86_400_000))).toEqual([]);
    expect(await kinds(t.clergy, new Date(NOW.getTime() + 31 * 86_400_000))).toEqual(["no_contact"]);
    await expect(dismissSuggestion(db, t.clergy, { kind: "nonsense", subjectId: s.subjectId })).rejects.toBeInstanceOf(InvalidInput);
  });

  it("accepts a dismissal only for a suggestion the person has, caps what is kept at 200 and purges old ones", async () => {
    const i = await item();
    await age(i.id, 60);
    await expect(dismissSuggestion(db, t.clergy, { kind: "no_contact", subjectId: "11111111-1111-4111-8111-111111111111" }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    await expect(dismissSuggestion(db, t.clergy2, { kind: "no_contact", subjectId: i.id }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    expect(await db.select().from(suggestionDismissals)).toHaveLength(0);
    const filler = Array.from({ length: 205 }, (_, n) => ({ userId: t.clergy.id, kind: "no_contact", subjectId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, dismissedAt: new Date(NOW.getTime() - (300 - n) * 60_000) }));
    await db.insert(suggestionDismissals).values(filler);
    await dismissSuggestion(db, t.clergy, { kind: "no_contact", subjectId: i.id }, NOW);
    expect(await db.select().from(suggestionDismissals)).toHaveLength(200);
    await db.update(suggestionDismissals).set({ dismissedAt: new Date(NOW.getTime() - 61 * 86_400_000) }).where(eq(suggestionDismissals.subjectId, filler[204].subjectId));
    expect(await purgeOldDismissals(db, NOW)).toBe(1);
  });

  it("never lets a restricted item the viewer cannot see produce a suggestion", async () => {
    const hidden = await item({ displayName: "Hidden Person", restricted: true }, t.clergy2);
    await age(hidden.id, 90);
    await addEntry(db, t.clergy2, { name: "Hidden Name", careItemId: hidden.id }, { now: ago(90) }).catch(() => undefined);
    for (const viewer of [t.clergy, t.owner]) {
      const list = await getOutreachSuggestions(db, viewer, NOW);
      expect(JSON.stringify(list)).not.toContain("Hidden Person");
      expect(list.some((s) => s.subjectId === hidden.id)).toBe(false);
    }
    // Its holder, who fully sees it, does get one.
    expect((await getOutreachSuggestions(db, t.clergy2, NOW)).some((s) => s.subjectId === hidden.id)).toBe(true);
  });

  it("is for clergy level only", async () => {
    const r = await reporters(db);
    for (const a of [t.carer, r.staff, r.lead, r.senior]) await expect(getOutreachSuggestions(db, a, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });
});

describe("Today choices are the person's own", () => {
  it("are saved per person, follow them, and refuse anything unknown", async () => {
    expect(await getTodayPrefs(db, t.clergy)).toEqual({ kind: null, hideBirthdays: false });
    await setTodayPrefs(db, t.clergy, { kind: "yahrzeit", hideBirthdays: true });
    expect(await getTodayPrefs(db, t.clergy)).toEqual({ kind: "yahrzeit", hideBirthdays: true });
    expect(await getTodayPrefs(db, t.clergy2)).toEqual({ kind: null, hideBirthdays: false });
    await expect(setTodayPrefs(db, t.clergy, { kind: "x", hideBirthdays: false })).rejects.toBeInstanceOf(InvalidInput);
    await expect(setTodayPrefs(db, t.carer, { kind: null, hideBirthdays: false })).rejects.toBeInstanceOf(AccessDenied);
  });
});
