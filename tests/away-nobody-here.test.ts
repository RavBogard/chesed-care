import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { firstDayNobodyIsHere, setAway } from "@/server/team/away";
import { team, testDb } from "./support/db";

const NOW = new Date("2026-12-01T15:00:00Z");

describe("a day with nobody on the clergy team here", () => {
  it("is the first day every person is away, and none when someone is here throughout", () => {
    const a = { awayFrom: "2026-12-04", awayUntil: "2026-12-10" };
    const b = { awayFrom: "2026-12-08", awayUntil: "2026-12-12" };
    expect(firstDayNobodyIsHere([a, b], "2026-12-04", "2026-12-10")).toBe("2026-12-08");
    expect(firstDayNobodyIsHere([a, { awayFrom: null, awayUntil: null }], "2026-12-04", "2026-12-10")).toBeNull();
    expect(firstDayNobodyIsHere([a, { awayFrom: "2026-12-11", awayUntil: "2026-12-12" }], "2026-12-04", "2026-12-10")).toBeNull();
    // Nobody to ask about is not a gap.
    expect(firstDayNobodyIsHere([], "2026-12-04", "2026-12-10")).toBeNull();
  });

  describe("when away is set", () => {
    let db: Db;
    let t: Awaited<ReturnType<typeof team>>;
    beforeEach(async () => {
      db = await testDb();
      t = await team(db);
    });

    it("says nothing while a colleague is here", async () => {
      expect(await setAway(db, t.clergy, t.clergy.id, { from: "2026-12-04", until: "2026-12-10" }, NOW)).toEqual({ nobodyHereFrom: null });
    });

    it("names the first day once the last person here is marked away too", async () => {
      // The standard team has an owner and two clergy; mark the other two away first.
      await db.update(users).set({ awayFrom: "2026-12-01", awayUntil: "2026-12-31" }).where(eq(users.id, t.owner.id));
      await setAway(db, t.clergy2, t.clergy2.id, { from: "2026-12-06", until: "2026-12-09" }, NOW);
      expect(await setAway(db, t.clergy, t.clergy.id, { from: "2026-12-04", until: "2026-12-10" }, NOW)).toEqual({ nobodyHereFrom: "2026-12-06" });
    });

    it("does not count a caregiver as someone who would be told", async () => {
      await db.update(users).set({ awayFrom: "2026-12-01", awayUntil: "2026-12-31" }).where(eq(users.id, t.owner.id));
      await db.update(users).set({ awayFrom: "2026-12-01", awayUntil: "2026-12-31" }).where(eq(users.id, t.clergy2.id));
      // The caregivers are here, but urgent reports do not go to them.
      expect(await setAway(db, t.clergy, t.clergy.id, { from: "2026-12-04", until: "2026-12-05" }, NOW)).toEqual({ nobodyHereFrom: "2026-12-04" });
    });
  });
});
