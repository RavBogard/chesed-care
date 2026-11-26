import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refusalMessage, type PublicReason } from "@/lib/meals-wording";
import { auditLog, mealPages, mealSignups } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { buildClientMeta, elapsedSinceStamp, networkOf, platformAddress, signRenderStamp, STAMP_MAX_AGE_MS } from "@/server/meals/client-meta";
import { deliveryIcs } from "@/server/meals/ics";
import { endMealPage } from "@/server/meals/pages";
import { cancelMySignup, changeMySignup, getMySignup, mealSignupIcs, signUpForMeal } from "@/server/meals/public";
import { purgeMealData } from "@/server/meals/purge";
import { team, testDb } from "./support/db";
import { helper, livePage, meta, NOW, type LivePage } from "./support/meals";

const SECRET = "test-secret-for-meal-forms";
const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

describe("clientMeta is built from what the client cannot choose", () => {
  it("a server-signed render time gives the elapsed time; a missing, forged, moved or future stamp gives nothing", () => {
    const rendered = new Date("2026-12-01T18:00:00Z");
    const stamp = signRenderStamp("tok", rendered, SECRET);
    const later = new Date(rendered.getTime() + 7_000);
    expect(elapsedSinceStamp(stamp, "tok", later, SECRET)).toBe(7_000);

    const [at, mac] = stamp.split(".");
    expect(elapsedSinceStamp(undefined, "tok", later, SECRET)).toBeNull();
    expect(elapsedSinceStamp("", "tok", later, SECRET)).toBeNull();
    // A client picking its own render time (an old one, to look slow) fails the signature.
    expect(elapsedSinceStamp(`${rendered.getTime() - 60_000}.${mac}`, "tok", later, SECRET)).toBeNull();
    expect(elapsedSinceStamp(`${at}.${mac.slice(1)}x`, "tok", later, SECRET)).toBeNull();
    expect(elapsedSinceStamp(`${at}.${mac}.extra`, "tok", later, SECRET)).toBeNull();
    // Signed for another page, or with another secret.
    expect(elapsedSinceStamp(stamp, "other", later, SECRET)).toBeNull();
    expect(elapsedSinceStamp(stamp, "tok", later, "another-secret")).toBeNull();
    // From the future (a forged clock) and from yesterday-and-more.
    expect(elapsedSinceStamp(signRenderStamp("tok", new Date(later.getTime() + 60_000), SECRET), "tok", later, SECRET)).toBeNull();
    expect(elapsedSinceStamp(stamp, "tok", new Date(rendered.getTime() + STAMP_MAX_AGE_MS + 1), SECRET)).toBeNull();
  });

  it("the client key comes from the platform's address, never from x-forwarded-for, and an IPv6 address is its /64", () => {
    expect(networkOf("203.0.113.9")).toBe("v4:203.0.113.9");
    expect(networkOf("::ffff:203.0.113.9")).toBe("v4:203.0.113.9");
    const a = networkOf("2001:db8:aaaa:bbbb:1:2:3:4");
    const b = networkOf("2001:0db8:aaaa:bbbb:ffff::1");
    expect(a).toBe(b);
    expect(a).toBe("v6:2001:db8:aaaa:bbbb::/64");
    expect(networkOf("2001:db8:aaaa:bbbc::1")).not.toBe(a);
    expect(networkOf("[2001:db8:aaaa:bbbb::1]")).toBe(a);
    expect(networkOf("not an address")).toBeNull();
    expect(networkOf("")).toBeNull();

    // The platform header decides; a header the client can write is ignored.
    expect(platformAddress(headers({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }))).toBe("v4:203.0.113.9");
    expect(platformAddress(headers({ "x-real-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.1" }))).toBe("v4:203.0.113.10");
    vi.stubEnv("NODE_ENV", "production");
    expect(platformAddress(headers({ "x-forwarded-for": "198.51.100.1" }))).toBeNull();
    vi.unstubAllEnvs();
  });

  it("buildClientMeta keys two phones in one /64 together, hashes the address and carries the honeypot and the server's elapsed time", () => {
    const stamp = signRenderStamp("tok", NOW, SECRET);
    const at = new Date(NOW.getTime() + 9_000);
    const one = buildClientMeta({ headers: headers({ "x-vercel-forwarded-for": "2001:db8:1:2:aaaa::1" }), stamp, scope: "tok", honeypot: "", now: at, secret: SECRET })!;
    const two = buildClientMeta({ headers: headers({ "x-vercel-forwarded-for": "2001:db8:1:2:bbbb::9" }), stamp, scope: "tok", honeypot: "x", now: at, secret: SECRET })!;
    const other = buildClientMeta({ headers: headers({ "x-vercel-forwarded-for": "2001:db8:1:3::1" }), stamp, scope: "tok", now: at, secret: SECRET })!;
    expect(one.clientKey).toBe(two.clientKey);
    expect(other.clientKey).not.toBe(one.clientKey);
    expect(one.clientKey).not.toContain("2001");
    expect(one.elapsedMs).toBe(9_000);
    expect(two.honeypot).toBe("x");
    // A forged stamp leaves no elapsed time at all.
    expect(buildClientMeta({ headers: headers({ "x-real-ip": "203.0.113.9" }), stamp: "1.2", scope: "tok", now: at, secret: SECRET })!.elapsedMs).toBeNull();
    // A request with no address the platform vouches for gets nothing.
    vi.stubEnv("NODE_ENV", "production");
    expect(buildClientMeta({ headers: headers({}), stamp, scope: "tok", now: at, secret: SECRET })).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("what a refused sign-up or change is told", () => {
  const reasons: PublicReason[] = ["taken", "closed", "rate_limited", "invalid", "unavailable", "refused", "not_found", "stale", "unknown"];
  it("every reason has its own plain sentence, and none shows a value", () => {
    const sentences = reasons.map((r) => refusalMessage(r));
    expect(new Set(sentences).size).toBe(reasons.length);
    for (const s of sentences) expect(s.length).toBeGreaterThan(10);
    expect(refusalMessage("invalid", ["email"])).toMatch(/email/);
    expect(refusalMessage("invalid", ["firstName", "lastName"])).toMatch(/first name and your last name/);
    expect(refusalMessage("invalid", ["clientMeta"])).toMatch(/reload/);
    // Nothing in a message is a price.
    for (const s of sentences) expect(s).not.toMatch(/\$|dollar|pay|donat/i);
  });
});

let db: Db;
let page: LivePage;
const audit = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);

async function signUp(slot: number, over: Record<string, unknown> = {}) {
  const result = await signUpForMeal(db, page.publicToken, page.slots[slot].id, helper(over), meta(), NOW);
  if (!result.ok) throw new Error(`sign-up refused: ${result.reason}`);
  return result;
}

describe("the four gaps from the security re-review", () => {
  beforeEach(async () => {
    db = await testDb();
    const t = await team(db);
    page = await livePage(db, t.clergy);
  });

  it("(a) the purge also clears the page's dietary needs", async () => {
    await endMealPage(db, (await team(db).catch(() => null)) as never, page.id).catch(() => undefined);
    await db.update(mealPages).set({ status: "ended", endedAt: new Date(NOW.getTime() - 40 * 86_400_000) }).where(eq(mealPages.id, page.id));
    const [before] = await db.select().from(mealPages).where(eq(mealPages.id, page.id));
    expect(before.dietary).toEqual(["nut free"]);
    await purgeMealData(db, NOW);
    const [after] = await db.select().from(mealPages).where(eq(mealPages.id, page.id));
    expect(after.dietary).toEqual([]);
    expect(after.allergies).toBeNull();
  });

  it("(b) a manage link stops resolving after the purge, and nothing acts on a cancelled sign-up or an ended page", async () => {
    const first = await signUp(0);
    const second = await signUp(1);
    // A cancelled sign-up: viewing says so, changing is refused, cancelling again changes and audits nothing.
    expect(await cancelMySignup(db, first.manageToken, meta(), NOW)).toEqual({ ok: true });
    expect(await changeMySignup(db, first.manageToken, { bringing: "Soup" }, meta(), NOW)).toMatchObject({ ok: false, reason: "closed" });
    expect(await cancelMySignup(db, first.manageToken, meta(), NOW)).toEqual({ ok: true });
    expect(await audit("meal_signup.cancel")).toHaveLength(1);

    // An ended page takes neither a change nor a cancellation, but the link still shows the state until the purge.
    await db.update(mealPages).set({ status: "ended", endedAt: new Date(NOW.getTime() - 5 * 86_400_000) }).where(eq(mealPages.id, page.id));
    expect(await cancelMySignup(db, second.manageToken, meta(), NOW)).toMatchObject({ ok: false, reason: "closed" });
    expect(await changeMySignup(db, second.manageToken, { bringing: "Soup" }, meta(), NOW)).toMatchObject({ ok: false, reason: "closed" });
    expect(await getMySignup(db, second.manageToken, NOW)).toMatchObject({ state: "ended" });
    const [still] = await db.select().from(mealSignups).where(eq(mealSignups.id, second.signupId));
    expect(still.cancelledAt).toBeNull();

    // After the purge the link is simply not found, for every way in.
    await db.update(mealPages).set({ endedAt: new Date(NOW.getTime() - 40 * 86_400_000) }).where(eq(mealPages.id, page.id));
    await purgeMealData(db, NOW);
    expect(await getMySignup(db, second.manageToken, NOW)).toBeNull();
    expect(await mealSignupIcs(db, second.manageToken, NOW)).toBeNull();
    expect(await cancelMySignup(db, second.manageToken, meta(), NOW)).toMatchObject({ ok: false, reason: "not_found" });
    expect(await changeMySignup(db, second.manageToken, { bringing: "x" }, meta(), NOW)).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("(c) moving to another night writes an audit row, and a move that cannot be recorded does not happen", async () => {
    const mine = await signUp(0);
    const target = page.slots[2].id;
    const moved = await changeMySignup(db, mine.manageToken, { moveToSlotId: target }, meta(), NOW);
    expect(moved).toMatchObject({ ok: true });
    const rows = await audit("meal_signup.move");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: null, subjectType: "meal_signup", subjectId: mine.signupId });
    expect(rows[0].detail).toMatchObject({ by: "helper", slotId: target, fromSlotId: page.slots[0].id, mealPageId: page.id });
    // Changing only the words is not a move.
    await changeMySignup(db, mine.manageToken, { bringing: "Soup" }, meta(), NOW);
    expect(await audit("meal_signup.move")).toHaveLength(1);

    // If the audit row cannot be written, the date does not change.
    await db.execute(sql`create function refuse_move() returns trigger language plpgsql as $$ begin if new.action = 'meal_signup.move' then raise exception 'audit down'; end if; return new; end $$`);
    await db.execute(sql`create trigger refuse_move before insert on audit_log for each row execute function refuse_move()`);
    await expect(changeMySignup(db, mine.manageToken, { moveToSlotId: page.slots[1].id }, meta(), NOW)).rejects.toThrow();
    const [row] = await db.select().from(mealSignups).where(eq(mealSignups.id, mine.signupId));
    expect(row.slotId).toBe(target);
  });

  it("(c) a sign-up is kept only together with its audit row", async () => {
    await db.execute(sql`create function refuse_create() returns trigger language plpgsql as $$ begin if new.action = 'meal_signup.create' then raise exception 'audit down'; end if; return new; end $$`);
    await db.execute(sql`create trigger refuse_create before insert on audit_log for each row execute function refuse_create()`);
    await expect(signUpForMeal(db, page.publicToken, page.slots[0].id, helper(), meta(), NOW)).rejects.toThrow();
    expect(await db.select().from(mealSignups)).toHaveLength(0);
  });

  it("(d) U+0085, U+2028 and U+2029 are refused wherever a line break is, and cannot reach a calendar file", async () => {
    for (const ch of ["\u0085", "\u2028", "\u2029", "\r", "\n"]) {
      const first = await signUpForMeal(db, page.publicToken, page.slots[0].id, helper({ firstName: `Da${ch}na` }), meta(), NOW);
      expect(first).toMatchObject({ ok: false, reason: "invalid", fields: ["firstName"] });
      const bringing = await signUpForMeal(db, page.publicToken, page.slots[0].id, helper({ bringing: `Lasa${ch}gne` }), meta(), NOW);
      expect(bringing).toMatchObject({ ok: false, reason: "invalid", fields: ["bringing"] });
    }
    // A multi-line field still takes a real line break (\n), but not the others.
    expect(await signUpForMeal(db, page.publicToken, page.slots[0].id, helper({ note: "one\ntwo" }), meta(), NOW)).toMatchObject({ ok: true });
    for (const ch of ["\u0085", "\u2028", "\u2029"]) expect(await signUpForMeal(db, page.publicToken, page.slots[1].id, helper({ note: `a${ch}b` }), meta(), NOW)).toMatchObject({ ok: false, reason: "invalid", fields: ["note"] });
    // And if one ever reached the calendar writer, it would be an escaped line break, never a raw one.
    const ics = deliveryIcs({ uid: "u", date: "2026-12-01", nextDay: "2026-12-02", summary: "Dinner", address: "12 Maple\u2028Lane\u0085Apt\u20293", window: "5 to 6", stamp: NOW });
    expect(ics).not.toMatch(/[\u0085\u2028\u2029]/);
    expect(ics).toContain("LOCATION:12 Maple\\nLane\\nApt\\n3");
  });
});
