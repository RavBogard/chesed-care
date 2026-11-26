import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { getBrief } from "@/server/care/brief";
import { createCareItem } from "@/server/care/care-items";
import { createContactEntry } from "@/server/care/contact-log";
import { createFollowUp } from "@/server/care/follow-ups";
import type { Db } from "@/server/db/types";
import { TOOLS } from "@/server/mcp/tools";
import { CONTACT, reporters, team, testDb } from "./support/db";
import { fakeSf } from "./support/sf";

const NOW = new Date("2026-12-01T18:00:00Z");
const SECRET_SUMMARY = "Admitted after a crisis";
const SECRET_NOTE = "Asked that no one be told";
const PRIVATE_NOTE = "Private to the author";
const OPEN_NOTE = "Sat with her an hour";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
const sf = fakeSf();
const deps = () => ({ db, sf: sf.sf, now: NOW });

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
});

async function seed() {
  const plain = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness", summary: "Knee surgery" });
  const secret = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "mental_health", summary: SECRET_SUMMARY, restricted: true, restrictedShowsCarer: true });
  await createContactEntry(db, t.clergy, { careItemId: plain.id, kind: "visit", occurredAt: "2026-11-25T15:00:00Z", note: PRIVATE_NOTE, private: true });
  await createContactEntry(db, t.clergy, { careItemId: plain.id, kind: "call", outcome: "spoke", occurredAt: "2026-11-26T15:00:00Z", note: OPEN_NOTE });
  await createContactEntry(db, t.clergy, { careItemId: secret.id, kind: "visit", occurredAt: "2026-11-27T15:00:00Z", note: SECRET_NOTE });
  await createContactEntry(db, t.clergy2, { careItemId: plain.id, kind: "text", occurredAt: "2026-11-24T15:00:00Z", note: "Mine to read" });
  await createFollowUp(db, t.clergy, { careItemId: plain.id, title: "Call the ward", dueDate: "2026-12-03" });
  await createFollowUp(db, t.clergy, { careItemId: secret.id, title: "Secret call", dueDate: "2026-12-03" });
  return { plain, secret };
}

describe("Brief me", () => {
  it("shows a viewer exactly what they may already see: a fully seen item, a stub only for a restricted one, no private notes of another clergy", async () => {
    await seed();
    const brief = await getBrief(deps(), t.clergy2, { contactId: CONTACT });
    // The fully seen item is there; the restricted one is only a stub saying whose care it is in.
    expect(brief.open.map((o) => o.category)).toEqual(["Illness"]);
    expect(brief.restrictedElsewhere).toEqual([{ heldBy: "clergy" }]);
    // Notes: another clergy's private note is hidden, their open note and one's own are readable.
    const notes = brief.contacts.map((c) => ({ note: c.note, hidden: c.noteHidden }));
    expect(notes).toContainEqual({ note: OPEN_NOTE, hidden: false });
    expect(notes).not.toContainEqual(expect.objectContaining({ note: PRIVATE_NOTE }));
    const text = JSON.stringify(brief);
    for (const secret of [SECRET_SUMMARY, SECRET_NOTE, "Secret call", PRIVATE_NOTE, "Mental health"]) expect(text).not.toContain(secret);
    expect(brief.upcoming.map((f) => f.title)).toEqual(["Call the ward"]);
  });

  it("shows the holder everything on it, their own private note included", async () => {
    await seed();
    const brief = await getBrief(deps(), t.clergy, { contactId: CONTACT });
    expect(brief.open.map((o) => o.category).sort()).toEqual(["Illness", "Mental health"]);
    expect(brief.restrictedElsewhere).toEqual([]);
    expect(brief.contacts).toHaveLength(3);
    expect(brief.contacts.map((c) => c.note)).toContain(SECRET_NOTE);
  });

  it("says what is not known, honestly", async () => {
    const plain = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Ruth Cohen", category: "illness" });
    await createContactEntry(db, t.clergy, { careItemId: plain.id, kind: "call", occurredAt: "2026-08-01T15:00:00Z" });
    const brief = await getBrief(deps(), t.clergy, { contactId: CONTACT });
    expect(brief.notKnown.join(" ")).toMatch(/90 days/);
    expect(brief.notKnown.join(" ")).toMatch(/no follow-up/i);
  });

  it("is for clergy level only, and the connector tool returns the same brief through the same path", async () => {
    await seed();
    const r = await reporters(db);
    for (const a of [t.carer, r.staff, r.lead, r.senior]) await expect(getBrief(deps(), a, { contactId: CONTACT })).rejects.toBeInstanceOf(AccessDenied);
    const tool = TOOLS.find((x) => x.name === "care_brief_person")!;
    for (const actor of [t.clergy, t.clergy2, t.owner]) {
      const viaTool = await tool.run({ db, sf: sf.sf, now: NOW, actor }, { contactId: CONTACT } as never);
      expect(viaTool).toEqual({ brief: await getBrief(deps(), actor, { contactId: CONTACT }) });
    }
    await expect(tool.run({ db, sf: sf.sf, now: NOW, actor: t.carer }, { contactId: CONTACT } as never)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("asks for exactly one person", async () => {
    await expect(getBrief(deps(), t.clergy, {})).rejects.toThrow();
    await expect(getBrief(deps(), t.clergy, { contactId: CONTACT, outsidePersonId: "x" })).rejects.toThrow();
  });
});
