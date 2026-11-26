import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied, type Actor } from "@/server/access/policy";
import { addAgendaEntry, carryAgendaEntry, discussAgendaEntry, listAgenda, mondayOf, purgeAgenda, removeAgendaEntry } from "@/server/care/agenda";
import { createCareItem } from "@/server/care/care-items";
import { listFollowUps } from "@/server/care/follow-ups";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { purgeOldNotes } from "@/server/daily/retention";
import { agendaEntries, auditLog, careItems } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { TOOLS } from "@/server/mcp/tools";
import { CONTACT, CONTACT2, addActor, reporters, team, testDb } from "./support/db";
import { fakeSf } from "./support/sf";
import { words } from "./support/words";

// Monday 10am Chicago.
const NOW = new Date("2026-11-23T16:00:00Z");
const DAY = 86_400_000;
let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
let third: Actor;
const sf = fakeSf();
const run = (name: string, actor: Actor, input: Record<string, unknown> = {}) => TOOLS.find((x) => x.name === name)!.run({ db, sf: sf.sf, now: NOW, actor }, input as never);

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
  third = await addActor(db, "clergy3@example.test", "clergy");
});

const secretItem = () => createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Hidden Hannah", category: "mental_health", restricted: true, accessUserIds: [] });
const openItem = () => createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Open Olivia", category: "illness" });

describe("agenda: who may use it", () => {
  it("is for clergy and the owner only", async () => {
    const item = await openItem();
    for (const actor of [t.owner, t.clergy2]) await expect(addAgendaEntry(db, actor, { careItemId: item.id }, NOW)).resolves.toMatchObject({ restricted: false });
    for (const actor of [t.carer, r.staff, r.lead, r.senior]) {
      await expect(addAgendaEntry(db, actor, { displayName: "x text" }, NOW)).rejects.toBeInstanceOf(AccessDenied);
      await expect(listAgenda(db, actor, NOW)).rejects.toBeInstanceOf(AccessDenied);
    }
  });

  it("adds a person, a care item the adder fully sees, or free text; and refuses an item they cannot see", async () => {
    const hidden = await secretItem();
    await expect(addAgendaEntry(db, t.clergy2, { careItemId: hidden.id }, NOW)).rejects.toBeInstanceOf(NotFound);
    await addAgendaEntry(db, t.clergy, { sfContactId: CONTACT2, displayName: "Open Olivia", why: "Check on the family" }, NOW);
    await addAgendaEntry(db, t.clergy, { displayName: "Plan the high holiday calls" }, NOW);
    await expect(addAgendaEntry(db, t.clergy, { displayName: "x", why: "y".repeat(201) }, NOW)).rejects.toBeInstanceOf(InvalidInput);
    expect((await listAgenda(db, t.clergy2, NOW)).toDiscuss).toHaveLength(2);
  });
});

describe("agenda: the restricted rule", () => {
  it("an entry on a restricted item does not exist for clergy or the owner who cannot see the item: rows, count, print view", async () => {
    const hidden = await secretItem();
    const added = await addAgendaEntry(db, t.clergy, { careItemId: hidden.id, why: "Secret reason" }, NOW);
    expect(added.restricted).toBe(true);
    await addAgendaEntry(db, t.clergy, { displayName: "Everyone sees this" }, NOW);
    const mine = await listAgenda(db, t.clergy, NOW);
    expect(mine.toDiscuss).toHaveLength(2);
    for (const actor of [t.clergy2, t.owner, third]) {
      const v = await listAgenda(db, actor, NOW);
      expect(v.toDiscuss.map((e) => e.displayName)).toEqual(["Everyone sees this"]);
      expect(v.toDiscuss.length + v.nextWeek.length + v.discussed.length).toBe(1);
      expect(words(v)).not.toMatch(/Hannah|Secret/);
      await expect(discussAgendaEntry(db, actor, added.id, {}, NOW)).rejects.toBeInstanceOf(NotFound);
      await expect(carryAgendaEntry(db, actor, added.id, NOW)).rejects.toBeInstanceOf(NotFound);
      await expect(removeAgendaEntry(db, actor, added.id)).rejects.toBeInstanceOf(NotFound);
    }
  });

  it("a named colleague sees it, and it is the same through the connector", async () => {
    const named = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Hidden Hannah", category: "mental_health", restricted: true, accessUserIds: [t.clergy2.id] });
    await addAgendaEntry(db, t.clergy, { careItemId: named.id }, NOW);
    expect((await listAgenda(db, t.clergy2, NOW)).toDiscuss).toHaveLength(1);
    expect(((await run("care_agenda", third, { action: "list" })) as { toDiscuss: unknown[] }).toDiscuss).toHaveLength(0);
    expect(((await run("care_agenda", t.clergy2, { action: "list" })) as { toDiscuss: unknown[] }).toDiscuss).toHaveLength(1);
  });

  it("when an item becomes restricted later, entries about it vanish for those shut out", async () => {
    const item = await openItem();
    await addAgendaEntry(db, t.clergy2, { careItemId: item.id }, NOW);
    expect((await listAgenda(db, t.clergy, NOW)).toDiscuss).toHaveLength(1);
    await db.update(careItems).set({ restricted: true }).where(eq(careItems.id, item.id));
    expect((await listAgenda(db, t.clergy, NOW)).toDiscuss).toHaveLength(1); // its holder
    expect((await listAgenda(db, t.clergy2, NOW)).toDiscuss).toHaveLength(0);
    expect((await listAgenda(db, t.owner, NOW)).toDiscuss).toHaveLength(0);
  });
});

describe("agenda: discuss, carry, follow-up", () => {
  it("ticks an entry as discussed with an outcome and makes a follow-up for the chosen clergy member", async () => {
    const item = await openItem();
    const { id } = await addAgendaEntry(db, t.clergy, { careItemId: item.id }, NOW);
    const out = await discussAgendaEntry(db, t.clergy, id, { outcome: "Rabbi will call", followUp: { ownerUserId: t.clergy2.id, title: "Call the family" } }, NOW);
    expect(out.followUpId).toBeTruthy();
    const mine = await listFollowUps(db, t.clergy2, { careItemId: item.id });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ ownerUserId: t.clergy2.id, title: "Call the family" });
    const v = await listAgenda(db, t.clergy, NOW);
    expect(v.toDiscuss).toHaveLength(0);
    expect(v.discussed[0]).toMatchObject({ outcome: "Rabbi will call" });
  });

  it("will not give the follow-up on a restricted item to a colleague who cannot see it", async () => {
    const hidden = await secretItem();
    const { id } = await addAgendaEntry(db, t.clergy, { careItemId: hidden.id }, NOW);
    await expect(discussAgendaEntry(db, t.clergy, id, { followUp: { ownerUserId: t.clergy2.id } }, NOW)).rejects.toBeInstanceOf(InvalidInput);
  });

  it("carries an entry to next week, and it comes back then", async () => {
    const { id } = await addAgendaEntry(db, t.clergy, { displayName: "Talk about the youth group" }, NOW);
    await carryAgendaEntry(db, t.clergy, id, NOW);
    const now = await listAgenda(db, t.clergy, NOW);
    expect(now.toDiscuss).toHaveLength(0);
    expect(now.nextWeek).toHaveLength(1);
    expect((await listAgenda(db, t.clergy, new Date(NOW.getTime() + 7 * DAY))).toDiscuss).toHaveLength(1);
  });

  it("only its adder or the owner removes an entry", async () => {
    const { id } = await addAgendaEntry(db, t.clergy, { displayName: "A line to remove" }, NOW);
    await expect(removeAgendaEntry(db, t.clergy2, id)).rejects.toBeInstanceOf(AccessDenied);
    await removeAgendaEntry(db, t.owner, id);
    expect((await listAgenda(db, t.clergy, NOW)).toDiscuss).toHaveLength(0);
  });

  it("computes the Monday of a week", () => {
    expect(mondayOf("2026-11-23")).toBe("2026-11-23");
    expect(mondayOf("2026-11-29")).toBe("2026-11-23");
    expect(mondayOf("2026-11-30")).toBe("2026-11-30");
  });
});

describe("agenda: retention", () => {
  it("drops a discussed entry off the screen after 14 days and deletes it after 90; audit rows hold ids only", async () => {
    const { id } = await addAgendaEntry(db, t.clergy, { displayName: "Old business", why: "private words" }, NOW);
    await discussAgendaEntry(db, t.clergy, id, { outcome: "done" }, NOW);
    expect((await listAgenda(db, t.clergy, new Date(NOW.getTime() + 13 * DAY))).discussed).toHaveLength(1);
    expect((await listAgenda(db, t.clergy, new Date(NOW.getTime() + 15 * DAY))).discussed).toHaveLength(0);
    expect((await purgeAgenda(db, new Date(NOW.getTime() + 89 * DAY))).deleted).toBe(0);
    expect((await purgeAgenda(db, new Date(NOW.getTime() + 91 * DAY))).deleted).toBe(1);
    expect(await db.select().from(agendaEntries)).toHaveLength(0);
    expect(words(JSON.stringify(await db.select().from(auditLog)))).not.toMatch(/private words|Old business/);
  });

  it("clears an entry's words with the care item's notes", async () => {
    const item = await openItem();
    await addAgendaEntry(db, t.clergy, { careItemId: item.id, why: "words about the case" }, NOW);
    await db.update(careItems).set({ status: "closed", closedAt: new Date(NOW.getTime() - 4 * 365 * DAY) }).where(eq(careItems.id, item.id));
    await purgeOldNotes(db, NOW);
    const [row] = await db.select().from(agendaEntries);
    expect(row.why).toBeNull();
  });
});

describe("connector: care_agenda", () => {
  it("lists, adds and marks discussed for clergy and the owner, and refuses every other role", async () => {
    const added = (await run("care_agenda", t.clergy, { action: "add", text: "Budget for pastoral visits", why: "Before the board" })) as { entryId: string };
    expect(((await run("care_agenda", t.owner, { action: "list" })) as { toDiscuss: unknown[] }).toDiscuss).toHaveLength(1);
    await run("care_agenda", t.clergy2, { action: "discuss", entryId: added.entryId, outcome: "Agreed" });
    expect(((await run("care_agenda", t.clergy, { action: "list" })) as { discussedRecently: unknown[] }).discussedRecently).toHaveLength(1);
    for (const actor of [t.carer, r.staff, r.lead, r.senior]) await expect(run("care_agenda", actor, { action: "list" })).rejects.toBeInstanceOf(AccessDenied);
  });
});
