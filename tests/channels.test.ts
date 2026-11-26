import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { canPrintTellSign, canUseCaptureTokens, ROLES, type Actor } from "@/server/access/policy";
import { createCaptureToken, listCaptureTokens, MAX_TOKENS_PER_PERSON, resolveCaptureToken, revokeCaptureToken } from "@/server/care/capture-tokens";
import { dismissProposal, listInbox } from "@/server/care/proposals";
import { CAPTURE_LIMITS, handleCapture } from "@/server/care/shortcut";
import { updateUser } from "@/server/care/users";
import { proposalRow } from "@/server/mcp/shapes";
import { TOOLS } from "@/server/mcp/tools";
import { submitTell, TELL_LIMITS } from "@/server/care/tell";
import { InvalidInput, NotFound } from "@/server/care/validate";
import { captureTokens, proposals, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { getOccasions } from "@/server/lifecycle/occasions";
import { newBabyQuery, proposeBereavementYears, proposeNewBabies } from "@/server/lifecycle/proposals-from-salesforce";
import type { Occasion } from "@/server/lifecycle/types";
import { buildClientMeta, signRenderStamp } from "@/server/meals/client-meta";
import { tokenHash } from "@/server/meals/tokens";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { assertReadOnlySoql } from "@/server/salesforce/soql-guard";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";
import { meta } from "./support/meals";

const NOW = new Date("2026-12-01T18:00:00Z");
const SECRET = "test-secret-for-stamps";
let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;

beforeEach(async () => {
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
});

const all = () => db.select().from(proposals);
const form = (over: Record<string, unknown> = {}) => ({ about: "Ruth Cohen", what: "She is in the hospital", sender: "A friend", contact: "friend@example.test", mayTellThem: "yes", miSheberach: "yes", ...over });

describe("the public form", () => {
  it("makes exactly one clergy-scope proposal with the answers in structured columns, and says nothing else", async () => {
    expect(await submitTell(db, form(), meta(), NOW)).toEqual({ ok: true });
    const rows = await all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "form", reviewScope: "clergy", submittedBy: null, status: "pending", mayTellThem: "yes", miSheberachAnswer: "yes", rawText: "She is in the hospital" });
    expect(rows[0].intake).toEqual({ kind: "public_form", about: "Ruth Cohen", sender: "A friend", contact: "friend@example.test" });
    // The shared Inbox shows it to clergy and to no one else.
    expect((await listInbox(db, t.clergy)).map((p) => p.id)).toEqual([rows[0].id]);
    expect(await listInbox(db, t.carer)).toEqual([]);
    expect(await listInbox(db, r.staff)).toEqual([]);
  });

  it("answers the same for a member, a stranger and a robot: it never says whether anyone is known", async () => {
    const known = await submitTell(db, form({ about: "Ruth Cohen" }), meta(), NOW);
    const unknown = await submitTell(db, form({ about: "Zzyzx Nobody" }), meta(), NOW);
    const robot = await submitTell(db, form(), { ...meta(), honeypot: "http://spam.example" }, NOW);
    expect(known).toEqual(unknown);
    expect(known).toEqual(robot);
    // The robot's message was dropped without a trace; the two real ones are there.
    expect(await all()).toHaveLength(2);
  });

  it("a form returned too fast is treated as a robot; a missing or forged stamp asks for a reload", async () => {
    expect(await submitTell(db, form(), { ...meta(), elapsedMs: 300 }, NOW)).toEqual({ ok: true });
    expect(await all()).toHaveLength(0);
    for (const elapsedMs of [null, undefined]) expect(await submitTell(db, form(), { clientKey: "198.51.100.99", elapsedMs }, NOW)).toMatchObject({ ok: false, reason: "stale" });
    expect(await all()).toHaveLength(0);
  });

  it("the render stamp is signed, tied to the form, and expires", () => {
    const headers = new Headers({ "x-real-ip": "198.51.100.7" });
    const stamp = signRenderStamp("tell", NOW, SECRET);
    const later = new Date(NOW.getTime() + 10_000);
    expect(buildClientMeta({ headers, stamp, scope: "tell", now: later, secret: SECRET })?.elapsedMs).toBe(10_000);
    expect(buildClientMeta({ headers, stamp, scope: "other", now: later, secret: SECRET })?.elapsedMs).toBeNull();
    expect(buildClientMeta({ headers, stamp: `${stamp}x`, scope: "tell", now: later, secret: SECRET })?.elapsedMs).toBeNull();
    expect(buildClientMeta({ headers, stamp, scope: "tell", now: new Date(NOW.getTime() + 5 * 3_600_000), secret: SECRET })?.elapsedMs).toBeNull();
  });

  it("refuses missing fields, bad answers and control characters, and makes nothing", async () => {
    for (const bad of [{ about: "" }, { what: "" }, { sender: "" }, { contact: "" }, { mayTellThem: "maybe" }, { miSheberach: "perhaps" }, { what: "x".repeat(1001) }, { about: "Ruth\u2028Cohen" }, { about: "Ruth\u202eCohen" }, { sender: "A\u200bfriend" }, { what: "text\ufeff" }, { contact: "a\u2066@example.test" }, { extra: "x" }]) {
      expect(await submitTell(db, form(bad), meta(), NOW)).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(await all()).toHaveLength(0);
  });

  it("limits each client per hour", async () => {
    const same = meta("198.51.100.50");
    for (let i = 0; i < TELL_LIMITS.perClient; i++) expect(await submitTell(db, form(), same, NOW)).toEqual({ ok: true });
    expect(await submitTell(db, form(), same, NOW)).toMatchObject({ ok: false, reason: "limited" });
    // Another client, or the next hour, is fine.
    expect(await submitTell(db, form(), meta(), NOW)).toEqual({ ok: true });
    expect(await submitTell(db, form(), same, new Date(NOW.getTime() + 3_600_000))).toEqual({ ok: true });
  });

  it("typos do not use up a client's tries: only a valid submission is charged", async () => {
    const same = meta("198.51.100.60");
    for (let i = 0; i < TELL_LIMITS.perClient + 5; i++) expect(await submitTell(db, form({ about: "" }), same, NOW)).toMatchObject({ reason: "invalid" });
    expect(await submitTell(db, form(), same, NOW)).toEqual({ ok: true });
  });

  it("caps the whole form per hour", async () => {
    for (let i = 0; i < TELL_LIMITS.perHour; i++) expect(await submitTell(db, form(), meta(), NOW)).toEqual({ ok: true });
    expect(await submitTell(db, form(), meta(), NOW)).toMatchObject({ ok: false, reason: "limited" });
    expect(await all()).toHaveLength(TELL_LIMITS.perHour);
  });

  it("deciding it keeps the words, still erases the sender's details, and keeps the Mi Sheberach answer", async () => {
    await submitTell(db, form(), meta(), NOW);
    const [p] = await all();
    await dismissProposal(db, t.clergy, p.id, NOW);
    const [after] = await all();
    expect(after).toMatchObject({ status: "dismissed", rawText: "She is in the hospital", intake: null, miSheberachAnswer: "yes" });
  });
});

describe("capture tokens", () => {
  it("shows the token once, stores only its hash and a short prefix", async () => {
    const made = await createCaptureToken(db, t.clergy);
    expect(made.token).toMatch(/^ccap_[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(captureTokens);
    expect(row.tokenHash).toBe(tokenHash(made.token));
    expect(JSON.stringify(row)).not.toContain(made.token);
    expect(row.prefix).toBe(made.token.slice(0, row.prefix.length));
    expect(row.prefix.length).toBeLessThan(12);
    const listed = await listCaptureTokens(db, t.clergy);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(made.token);
  });

  it("allows three live tokens per person, and a revoked one frees a place", async () => {
    const made = [];
    for (let i = 0; i < MAX_TOKENS_PER_PERSON; i++) made.push(await createCaptureToken(db, t.clergy));
    await expect(createCaptureToken(db, t.clergy)).rejects.toBeInstanceOf(InvalidInput);
    // Someone else has their own three.
    await createCaptureToken(db, t.carer);
    await revokeCaptureToken(db, t.clergy, made[0].id, NOW);
    await createCaptureToken(db, t.clergy);
    expect(await listCaptureTokens(db, t.clergy)).toHaveLength(3);
  });

  it("lists and revokes only one's own", async () => {
    const mine = await createCaptureToken(db, t.clergy);
    const theirs = await createCaptureToken(db, t.carer);
    expect((await listCaptureTokens(db, t.clergy)).map((k) => k.id)).toEqual([mine.id]);
    await expect(revokeCaptureToken(db, t.clergy, theirs.id)).rejects.toBeInstanceOf(NotFound);
    await expect(revokeCaptureToken(db, t.clergy, "nope")).rejects.toBeInstanceOf(NotFound);
    await revokeCaptureToken(db, t.clergy, mine.id, NOW);
    await expect(revokeCaptureToken(db, t.clergy, mine.id)).rejects.toBeInstanceOf(NotFound);
    expect(await resolveCaptureToken(db, mine.token)).toBeNull();
  });

  it("every role that may report a need may hold tokens, and only clergy level prints the sign", () => {
    for (const role of ROLES) expect(canUseCaptureTokens({ role })).toBe(true);
    const asRole = (role: Actor["role"]): Actor => ({ id: "x", email: "x@example.test", name: null, role });
    expect(ROLES.filter((role) => canPrintTellSign(asRole(role)))).toEqual(["owner", "clergy"]);
  });
});

describe("POST /api/capture", () => {
  const owners = new Set<string>();
  const call = (over: Partial<Parameters<typeof handleCapture>[0]> & { token?: string; text?: string } = {}) => {
    const { token, text, ...rest } = over;
    return handleCapture({ db, authorization: token ? `Bearer ${token}` : null, contentType: "application/json", raw: JSON.stringify({ text: text ?? "Ruth fell today" }), clientKey: "198.51.100.1", owners, now: NOW, ...rest });
  };

  it("makes a proposal as the token's owner, with the scope of their own capture, and returns nothing about people", async () => {
    const mine = await createCaptureToken(db, t.clergy);
    const theirs = await createCaptureToken(db, r.staff);
    expect(await call({ token: mine.token })).toEqual({ status: 200, body: { ok: true } });
    expect(await call({ token: theirs.token, contentType: "text/plain", raw: "Plain text note" })).toEqual({ status: 200, body: { ok: true } });
    const rows = await all();
    const clergyRow = rows.find((p) => p.submittedBy === t.clergy.id)!;
    const staffRow = rows.find((p) => p.submittedBy === r.staff.id)!;
    expect(clergyRow).toMatchObject({ channel: "shortcut", reviewScope: "submitter", rawText: "Ruth fell today" });
    expect(staffRow).toMatchObject({ channel: "shortcut", reviewScope: "clergy", rawText: "Plain text note" });
    // A clergy member's capture is theirs alone until they send it on.
    expect((await listInbox(db, t.clergy2)).map((p) => p.id)).toEqual([staffRow.id]);
    const [k] = await listCaptureTokens(db, t.clergy);
    expect(k.lastUsedAt).toEqual(NOW);
  });

  it("gives one constant 401 for every kind of bad token", async () => {
    const live = await createCaptureToken(db, t.clergy);
    const revoked = await createCaptureToken(db, t.clergy);
    await revokeCaptureToken(db, t.clergy, revoked.id, NOW);
    const gone = await createCaptureToken(db, t.carer);
    await db.update(users).set({ active: false }).where(eq(users.id, t.carer.id));
    const replies = [
      await call({}),
      await call({ authorization: "Bearer" }),
      await call({ authorization: "Basic abc" }),
      await call({ token: "short" }),
      await call({ token: `ccap_${"A".repeat(43)}` }),
      await call({ token: `${live.token}x` }),
      await call({ token: revoked.token }),
      await call({ token: gone.token }),
    ];
    for (const reply of replies) expect(reply).toEqual({ status: 401, body: { ok: false } });
    expect(await all()).toHaveLength(0);
    // The live one still works.
    expect((await call({ token: live.token })).status).toBe(200);
  });

  it("stops a token whose person was removed from the allowlist", async () => {
    const k = await createCaptureToken(db, r.staff);
    await db.update(users).set({ active: false }).where(eq(users.id, r.staff.id));
    expect((await call({ token: k.token })).status).toBe(401);
    await db.update(users).set({ active: true }).where(eq(users.id, r.staff.id));
    expect((await call({ token: k.token })).status).toBe(200);
  });

  it("notes a use only after the owner passes the allowlist check", async () => {
    const k = await createCaptureToken(db, r.staff);
    await db.update(users).set({ active: false }).where(eq(users.id, r.staff.id));
    expect((await call({ token: k.token })).status).toBe(401);
    const [row] = await db.select().from(captureTokens);
    expect(row.lastUsedAt).toBeNull();
  });

  it("deactivating a person ends all their capture keys for good, even if they come back", async () => {
    const a = await createCaptureToken(db, r.staff);
    const b = await createCaptureToken(db, r.staff);
    const mine = await createCaptureToken(db, t.clergy);
    await updateUser(db, t.owner, r.staff.id, { active: false }, new Set(["owner@example.test"]));
    await updateUser(db, t.owner, r.staff.id, { active: true }, new Set(["owner@example.test"]));
    expect(await listCaptureTokens(db, r.staff)).toEqual([]);
    for (const k of [a, b]) expect((await call({ token: k.token })).status).toBe(401);
    expect((await call({ token: mine.token })).status).toBe(200);
  });

  it("rejects empty or malformed bodies and an unknown address", async () => {
    const k = await createCaptureToken(db, t.clergy);
    expect((await call({ token: k.token, raw: "{}" })).status).toBe(400);
    expect((await call({ token: k.token, raw: "not json" })).status).toBe(400);
    expect((await call({ token: k.token, text: "   " })).status).toBe(400);
    expect((await call({ token: k.token, contentType: "application/xml" })).status).toBe(400);
    expect((await call({ token: k.token, text: "x".repeat(5001) })).status).toBe(400);
    expect((await call({ token: k.token, clientKey: null })).status).toBe(403);
    expect(await all()).toHaveLength(0);
  });

  it("limits each token and each client, and counts bad tokens apart", async () => {
    const k = await createCaptureToken(db, t.clergy);
    for (let i = 0; i < CAPTURE_LIMITS.perToken; i++) expect((await call({ token: k.token })).status).toBe(200);
    expect((await call({ token: k.token })).status).toBe(429);
    // Bad tokens from one address run out of tries of their own; a valid token from the same address still works.
    const other = await createCaptureToken(db, t.carer);
    for (let i = 0; i < CAPTURE_LIMITS.badPerClient; i++) expect((await call({ token: `ccap_${"B".repeat(43)}`, clientKey: "198.51.100.2" })).status).toBe(401);
    expect((await call({ token: `ccap_${"B".repeat(43)}`, clientKey: "198.51.100.2" })).status).toBe(429);
    expect((await call({ token: other.token, clientKey: "198.51.100.2" })).status).toBe(200);
  });
});

describe("Salesforce deaths and births become proposals", () => {
  const shloshim = (over: Partial<Occasion> = {}): Occasion => ({
    type: "shloshim", date: "2026-12-20", subjectId: "a0X000000000001AAA", personName: "Sam Cohen", personFirstName: "Sam", hebrewName: null, hebrewDeathDate: null, household: "Ruth and Ben Levy", informalGreeting: null, accountId: ACCOUNT, contactId: null,
    contactName: null, contactFirstName: null, contactHebrewName: null, mobile: null, phone: null, years: null, relationship: null, deathDate: "2026-11-20", ...over,
  });

  it("one proposal per death, once: a re-run, another mourner household and a dismissal never make a second", async () => {
    const rows = [shloshim(), shloshim({ accountId: "001000000000009AAA", household: "Other" })];
    expect(await proposeBereavementYears(db, rows)).toBe(1);
    expect(await proposeBereavementYears(db, rows)).toBe(0);
    const [p] = await all();
    expect(p).toMatchObject({ channel: "salesforce", reviewScope: "clergy", submittedBy: null, externalKey: "sf:death:a0X000000000001AAA", status: "pending" });
    expect(p.rawText).toBe("Start the bereavement year for the Ruth and Ben Levy household?");
    await dismissProposal(db, t.clergy, p.id, NOW);
    expect(await proposeBereavementYears(db, rows)).toBe(0);
    expect(await all()).toHaveLength(1);
    // A different death is a different proposal; a death with no member household makes none.
    expect(await proposeBereavementYears(db, [...rows, shloshim({ subjectId: "a0X000000000002AAA" }), shloshim({ subjectId: "a0X000000000003AAA", accountId: null })])).toBe(1);
  });

  const baby = (): SfRow => ({ Id: CONTACT, AccountId: ACCOUNT, Account: { Name: "Levy Household", npo02__Formal_Greeting__c: "Ruth and Ben Levy", cs_Member__c: true } });
  const sfWith = (rows: SfRow[]) => {
    const queries: string[] = [];
    const client: SalesforceClient = { async query(soql) { queries.push(assertReadOnlySoql(soql)); return soql.includes("Birthdate >=") ? rows : []; } };
    return { sf: client, queries };
  };

  it("a new baby in a member household is one proposal, once, by a read-only query with no giving fields", async () => {
    const { sf, queries } = sfWith([baby(), { ...baby(), Account: { Name: "Not a member", cs_Member__c: false } }]);
    expect(await proposeNewBabies(db, sf, "2026-12-01")).toBe(1);
    expect(await proposeNewBabies(db, sf, "2026-12-01")).toBe(0);
    const [p] = await all();
    expect(p).toMatchObject({ channel: "salesforce", externalKey: `sf:birth:${CONTACT}`, reviewScope: "clergy" });
    expect(queries[0]).toBe(newBabyQuery("2026-12-01"));
    expect(queries[0]).not.toMatch(/Opportunity|Amount|npe01__Payment|Donation|Giving/i);
    await dismissProposal(db, t.clergy, p.id, NOW);
    expect(await proposeNewBabies(db, sf, "2026-12-01")).toBe(0);
  });

  it("a death seen first as a Contact and later as a Yahrzeit record is the same proposal, even after a dismissal", async () => {
    // First seen as a Contact with a date of death: the subject is the Contact.
    const asContact = shloshim({ subjectId: CONTACT, deceasedContactId: CONTACT });
    expect(await proposeBereavementYears(db, [asContact])).toBe(1);
    const [p] = await all();
    expect(p.externalKey).toBe(`sf:death:${CONTACT}`);
    await dismissProposal(db, t.clergy, p.id, NOW);
    // Later a Yahrzeit record exists for the same person: its own id, the same deceased Contact.
    const asYahrzeit = shloshim({ subjectId: "a0X000000000009AAA", deceasedContactId: CONTACT });
    expect(await proposeBereavementYears(db, [asYahrzeit])).toBe(0);
    expect(await all()).toHaveLength(1);
  });

  it("the connector marks public-form proposals unverified and tells Claude never to follow them", async () => {
    await submitTell(db, form(), meta(), NOW);
    await proposeBereavementYears(db, [shloshim()]);
    const rows = await listInbox(db, t.clergy);
    const byChannel = Object.fromEntries(rows.map((p) => [p.channel, proposalRow(p)]));
    expect(byChannel.form).toMatchObject({ unverified: true, channel: "form" });
    expect(byChannel.salesforce).toMatchObject({ unverified: false });
    const description = TOOLS.find((x) => x.name === "care_inbox")!.description;
    expect(description).toMatch(/unverified: true/);
    expect(description).toMatch(/anonymous member of the public/);
    expect(description).toMatch(/untrusted/);
    expect(description).toMatch(/never follow/i);
  });

  it("runs from the daily shloshim read that already exists, with no schedule of its own", async () => {
    const ids = { yahrzeit: "a0X000000000001AAA" };
    const client: SalesforceClient = {
      async query(soql) {
        assertReadOnlySoql(soql);
        if (soql.includes("FROM Yahrzeit__c WHERE")) return [{ Id: ids.yahrzeit, Name: "Sam Cohen", Deceased_Name__c: "Sam Cohen", English_Date_of_Death__c: "2026-11-25", Was_Member__c: true }];
        if (soql.includes("FROM Yahrzeit_Observance__c")) {
          return [{ Yahrzeit__c: ids.yahrzeit, Relationship__c: "Spouse", Observer_Account__c: ACCOUNT, Observer_Account__r: { Name: "Cohen Household", npo02__Formal_Greeting__c: "Ruth Cohen", cs_Member__c: true } }];
        }
        return [];
      },
    };
    const deps = { db, sf: () => client, now: NOW };
    await getOccasions(deps, t.clergy);
    await getOccasions(deps, t.clergy);
    const rows = await all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalKey: `sf:death:${ids.yahrzeit}`, channel: "salesforce" });
    expect(rows[0].rawText).toContain("Ruth Cohen");
  });
});
