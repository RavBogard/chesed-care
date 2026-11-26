import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { AccessDenied } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { createFollowUp } from "@/server/care/follow-ups";
import { NotFound } from "@/server/care/validate";
import type { Db } from "@/server/db/types";
import { INSTRUCTIONS } from "@/server/mcp/instructions";
import { TOOLS } from "@/server/mcp/tools";
import { startJourney } from "@/server/journeys/journeys";
import { CONTACT, CONTACT2, reporters, team, testDb } from "./support/db";
import { fakeSf } from "./support/sf";
import { words } from "./support/words";

const NOW = new Date("2026-12-01T18:00:00Z");
let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const sf = fakeSf();
const run = (name: string, actor: Parameters<(typeof TOOLS)[number]["run"]>[0]["actor"], input: Record<string, unknown> = {}) => TOOLS.find((x) => x.name === name)!.run({ db, sf: sf.sf, now: NOW, actor }, input as never);

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
});

describe("connector: team and brief tools", () => {
  it("team_overview is for clergy and the owner, and says the same neutral thing about every other clergy", async () => {
    const hidden = await createCareItem(db, t.clergy2, { sfContactId: CONTACT, displayName: "Hidden Person", category: "mental_health", restricted: true });
    await createFollowUp(db, t.clergy2, { careItemId: hidden.id, title: "Secret call", dueDate: "2026-11-20" });
    for (const actor of [t.clergy, t.owner]) {
      const out = (await run("care_team_overview", actor)) as { people: { name: string; you: boolean; openItems: number; followUpsOverdue: number; mayHoldRestrictedItemsNotShown?: boolean }[] };
      expect(words(out)).not.toMatch(/Hidden|Secret/);
      const c2 = out.people.find((p) => p.name === "clergy2")!;
      expect(c2).toMatchObject({ openItems: 0, followUpsOverdue: 0, mayHoldRestrictedItemsNotShown: true });
      expect(out.people.find((p) => p.you)!.mayHoldRestrictedItemsNotShown).toBeUndefined();
    }
    const mine = (await run("care_team_overview", t.clergy2)) as { people: { you: boolean; openItems: number }[] };
    expect(mine.people.find((p) => p.you)!.openItems).toBe(1);
    for (const actor of [t.carer, r.staff, r.lead, r.senior]) await expect(run("care_team_overview", actor)).rejects.toBeInstanceOf(AccessDenied);
  });

  it("care_brief_person refuses every role below clergy level", async () => {
    for (const actor of [t.carer, r.staff, r.lead, r.senior]) await expect(run("care_brief_person", actor, { contactId: CONTACT })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("care_list_journeys lists a journey on an item the caller fully sees, and an item they cannot see is simply not found", async () => {
    const plain = await createCareItem(db, t.clergy, { sfContactId: CONTACT2, displayName: "Plain Person", category: "illness" });
    await startJourney(db, t.clergy, plain.id, { templateKey: "illness", anchorDate: "2026-11-28" }, NOW);
    const out = (await run("care_list_journeys", t.clergy2, { careItemId: plain.id })) as { journeys: { name: string; steps: unknown[] }[] };
    expect(out.journeys).toHaveLength(1);
    expect(out.journeys[0].steps.length).toBeGreaterThan(0);
    const hidden = await createCareItem(db, t.clergy, { sfContactId: CONTACT, displayName: "Hidden Person", category: "mental_health", restricted: true });
    await expect(run("care_list_journeys", t.clergy2, { careItemId: hidden.id })).rejects.toBeInstanceOf(NotFound);
    await expect(run("care_list_journeys", t.owner, { careItemId: hidden.id })).rejects.toBeInstanceOf(NotFound);
  });

  it("describes the morning routine in the instructions, because the server has no prompts to offer", () => {
    expect(INSTRUCTIONS).toMatch(/Morning routine/);
    const transport = readFileSync("src/server/mcp/transport.ts", "utf8");
    expect(transport).not.toMatch(/prompts\/list|registerPrompt|prompts:/);
  });

  it("new tools carry the read-only annotation", () => {
    for (const name of ["care_team_overview", "care_brief_person", "care_list_journeys"]) expect(TOOLS.find((x) => x.name === name)!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });
});
