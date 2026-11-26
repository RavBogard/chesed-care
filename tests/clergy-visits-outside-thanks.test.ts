import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { thankYouMailto, THANK_BODY } from "@/lib/thank-you";
import { AccessDenied, type Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { listContactEntries } from "@/server/care/contact-log";
import { createFollowUp } from "@/server/care/follow-ups";
import { createPublicProposal } from "@/server/care/intake";
import { createOutsidePerson, getOutsidePerson, updateOutsidePerson } from "@/server/care/outside-people";
import { acceptProposal } from "@/server/care/proposals";
import { getReporterLines, purgeReporters, reporterToKeep } from "@/server/care/reporter";
import { NotFound } from "@/server/care/validate";
import { listVisits, markVisited, placeKey, setVisitLocation } from "@/server/care/visits";
import { auditLog, careItems, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { CONTACT, CONTACT2, addActor, reporters, team, testDb } from "./support/db";
import { fakeSf } from "./support/sf";
import { words } from "./support/words";

const NOW = new Date("2026-11-23T16:00:00Z");
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

const ill = (who: Actor, contact: string, name: string, location: string | null, extra: Record<string, unknown> = {}) =>
  createCareItem(db, who, { sfContactId: contact, displayName: name, category: "illness", ...(location === null ? {} : { location }), ...extra });

describe("hospital visits", () => {
  it("groups open illness items by place (case and spacing normalised), with unplaced ones last", async () => {
    await ill(t.clergy, CONTACT, "Ann A", "Barnes-Jewish, Room 4");
    await ill(t.clergy2, CONTACT2, "Bob B", "  barnes-jewish,   room 4 ");
    await ill(t.clergy, "003000000000003AAA", "Cy C", "Mercy");
    await ill(t.clergy, "003000000000004AAA", "Di D", null);
    await createCareItem(db, t.clergy, { sfContactId: "003000000000005AAA", displayName: "Ed E", category: "bereavement", location: "Home" });
    const v = await listVisits(db, t.owner, NOW);
    expect(v.groups.map((g) => [g.label, g.rows.length])).toEqual([["Barnes-Jewish, Room 4", 2], ["Mercy", 1]]);
    expect(v.groups[0].mapsHref).toContain("google.com/maps");
    expect(v.unplaced.map((u) => u.name)).toEqual(["Di D"]);
    expect(placeKey("  Ward  5 ")).toBe("ward 5");
  });

  it("shows only restricted items the viewer fully sees", async () => {
    await ill(t.clergy, CONTACT, "Hidden Hannah", "Ward 9", { restricted: true });
    expect((await listVisits(db, t.clergy, NOW)).groups).toHaveLength(1);
    for (const actor of [t.clergy2, t.owner, third]) {
      const v = await listVisits(db, actor, NOW);
      expect(v).toEqual({ groups: [], unplaced: [] });
    }
  });

  it("is for clergy and the owner only", async () => {
    for (const actor of [t.carer, r.staff, r.lead, r.senior]) await expect(listVisits(db, actor, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("shows since, last contact and next follow-up, and Visited logs a visit and moves the person down the list", async () => {
    const a = await ill(t.clergy, CONTACT, "Ann A", "Ward 1");
    await ill(t.clergy, CONTACT2, "Bob B", "Ward 1");
    await createFollowUp(db, t.clergy, { careItemId: a.id, title: "Call", dueDate: "2026-11-26" });
    await markVisited(db, t.clergy2, a.id, NOW);
    const [ward] = (await listVisits(db, t.clergy, NOW)).groups;
    expect(ward.rows.map((x) => x.name)).toEqual(["Bob B", "Ann A"]);
    expect(ward.rows[1]).toMatchObject({ visitedToday: true, lastContact: "2026-11-23", nextFollowUp: "2026-11-26" });
    const [entry] = await listContactEntries(db, t.clergy, { careItemId: a.id });
    expect(entry).toMatchObject({ kind: "visit", outcome: "visited", authorUserId: t.clergy2.id });
  });

  it("Visited cannot be used on an item the person cannot see", async () => {
    const secret = await ill(t.clergy, CONTACT, "Hidden Hannah", "Ward 9", { restricted: true });
    await expect(markVisited(db, t.clergy2, secret.id, NOW)).rejects.toBeInstanceOf(NotFound);
    await expect(setVisitLocation(db, t.clergy2, secret.id, "Elsewhere")).rejects.toBeInstanceOf(NotFound);
    for (const actor of [t.carer, r.staff]) await expect(markVisited(db, actor, secret.id, NOW)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("sets a missing place from the list", async () => {
    const x = await ill(t.clergy, CONTACT, "Ann A", null);
    await setVisitLocation(db, t.clergy, x.id, "Mercy, 5th floor");
    const v = await listVisits(db, t.clergy, NOW);
    expect(v.unplaced).toHaveLength(0);
    expect(v.groups[0].label).toBe("Mercy, 5th floor");
  });
});

describe("outside people: edit", () => {
  it("is for clergy level who may see the person, and is audited with ids only", async () => {
    const p = await createOutsidePerson(db, t.clergy, { name: "Old Name", phone: "314-555-0100", note: "mother of a member" });
    const item = await createCareItem(db, t.clergy, { outsidePersonId: p.id, displayName: "Old Name", category: "illness" });
    const saved = await updateOutsidePerson(db, t.clergy2, p.id, { name: "New Name", phone: "314-555-0199", email: "n@x.test", note: "lives in Chicago", addressStreet: "1 Main St", addressCity: "Chicago", addressState: "IL", addressPostalCode: "60601" });
    expect(saved).toMatchObject({ name: "New Name", addressCity: "Chicago" });
    expect((await db.select().from(careItems).where(eq(careItems.id, item.id)))[0].displayName).toBe("New Name");
    for (const actor of [t.carer, r.staff, r.lead, r.senior]) await expect(updateOutsidePerson(db, actor, p.id, { name: "X" })).rejects.toBeInstanceOf(AccessDenied);
    const rows = (await db.select().from(auditLog)).filter((a) => a.action === "outside_person.update");
    expect(rows).toHaveLength(1);
    expect(words(rows)).not.toMatch(/New Name|555|Chicago|Main/);
  });

  it("cannot edit a person whose only care is restricted away from the editor", async () => {
    const p = await createOutsidePerson(db, t.clergy, { name: "Quiet Person" });
    await createCareItem(db, t.clergy, { outsidePersonId: p.id, displayName: "Quiet Person", category: "mental_health", restricted: true });
    await expect(updateOutsidePerson(db, t.clergy2, p.id, { name: "Changed" })).rejects.toBeInstanceOf(NotFound);
    expect((await getOutsidePerson(db, t.clergy, p.id)).name).toBe("Quiet Person");
  });
});

describe("thank the person who told us", () => {
  const deps = () => ({ db, sf: fakeSf().sf, now: NOW });
  const publicAccepted = async (mayTell: "yes" | "no", contact = "dana@x.test", restricted = false) => {
    const id = await createPublicProposal(db, { rawText: "words about the case", intake: { kind: "public_form", about: "Gil Amir", sender: "Dana Sender", contact }, mayTellThem: mayTell, miSheberach: "no" });
    const done = await acceptProposal(deps(), t.clergy, id, { target: { kind: "new" }, person: { newOutsidePerson: { name: "Gil Amir" } }, category: "illness", summary: "s", restricted });
    return { id, itemId: done.careItemId };
  };

  it("keeps the sender only for a yes with an email, and shows the line only to those who see the item", async () => {
    const yes = await publicAccepted("yes");
    const no = await publicAccepted("no");
    const phone = await publicAccepted("yes", "314-555-0100");
    const lines = await getReporterLines(db, t.clergy2, [yes.itemId, no.itemId, phone.itemId]);
    expect([...lines.keys()]).toEqual([yes.itemId]);
    expect(lines.get(yes.itemId)).toEqual({ name: "Dana Sender", email: "dana@x.test" });
    expect((await getReporterLines(db, t.carer, [yes.itemId])).size).toBe(0);
    expect((await getReporterLines(db, r.staff, [yes.itemId])).size).toBe(0);
  });

  it("a restricted item's line exists only for those with full access", async () => {
    const secret = await publicAccepted("yes", "dana@x.test", true);
    expect((await getReporterLines(db, t.clergy, [secret.itemId])).size).toBe(1);
    for (const actor of [t.clergy2, t.owner, third]) expect((await getReporterLines(db, actor, [secret.itemId])).size).toBe(0);
  });

  it("the mail link carries no detail about the person in care", async () => {
    const link = thankYouMailto("dana@x.test");
    expect(link.startsWith("mailto:dana@x.test?")).toBe(true);
    expect(decodeURIComponent(link)).toContain(THANK_BODY);
    expect(words(decodeURIComponent(link))).not.toMatch(/Gil|Amir|illness|hospital/i);
    expect(thankYouMailto("a+b@x.test")).not.toMatch(/\s/);
  });

  it("forgets the sender 30 days after the decision, and keeps nothing for a no", async () => {
    const yes = await publicAccepted("yes");
    expect((await purgeReporters(db, new Date(NOW.getTime() + 29 * 86_400_000))).cleared).toBe(0);
    expect((await purgeReporters(db, new Date(NOW.getTime() + 31 * 86_400_000))).cleared).toBe(1);
    expect((await getReporterLines(db, t.clergy, [yes.itemId])).size).toBe(0);
    const rows = await db.select().from(proposals);
    expect(rows.every((p) => p.reporterEmail === null)).toBe(true);
    expect(reporterToKeep({ channel: "form", mayTellThem: "no", intake: { kind: "public_form", about: "a", sender: "b", contact: "c@d.test" } })).toBeNull();
  });
});
