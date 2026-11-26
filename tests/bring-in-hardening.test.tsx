import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ generate: vi.fn(), later: [] as (() => Promise<void> | void)[] }));
vi.mock("ai", async (importActual) => ({ ...(await importActual<typeof import("ai")>()), generateText: hoisted.generate }));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void> | void) => void hoisted.later.push(fn) }));

import type { Actor } from "@/server/access/policy";
import { readAgain, readAll } from "@/server/care/ai-reading";
import { acceptQuick, BATCHES_PER_HOUR, createBatch, entryList, quickPerson } from "@/server/care/bring-in";
import { fallbackSplit, hasBadChars, sameNameExactly, touchesSensitiveFloor, validateSplit } from "@/server/care/bring-in-rules";
import { splitList, SPLITS_PER_HOUR } from "@/server/care/bring-in-split";
import { createCareItem } from "@/server/care/care-items";
import { createSalesforceProposal } from "@/server/care/intake";
import { acceptProposal, createProposal, releaseToInbox } from "@/server/care/proposals";
import { matchNames } from "@/server/care/reading-match";
import { InvalidInput, NotFound, TooMany } from "@/server/care/validate";
import { careItems, mealRateLimits, proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { reviewKeyAction } from "@/lib/review-keys";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { ACCOUNT, CONTACT, reporters, team, testDb } from "./support/db";

const NOW = new Date("2026-12-01T18:00:00Z");
let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
let people: { id: string; name: string }[];

const acct: SfRow = { Name: "Cohen Household", cs_Member__c: true };
const row = (id: string, name: string): SfRow => ({ Id: id, Name: name, FirstName: name.split(" ")[0], Hebrew_Name__c: null, MailingCity: "St. Louis", MailingState: "MO", npsp__Deceased__c: false, AccountId: ACCOUNT, Account: acct });
const sf = (): SalesforceClient => ({
  async query(soql): Promise<SfRow[]> {
    const byId = /WHERE Id = '(\w+)/.exec(soql);
    if (byId) return people.filter((p) => p.id.startsWith(byId[1])).map((p) => row(p.id, p.name));
    const words = [...soql.matchAll(/Name LIKE '%([^%]+)%' OR/g)].map((m) => m[1].toLowerCase());
    return people.filter((p) => words.length > 0 && words.every((w) => p.name.toLowerCase().includes(w))).map((p) => row(p.id, p.name));
  },
});
const deps = () => ({ db, sf, now: NOW });
const reading = (over: Record<string, unknown> = {}) => ({ by: "app_ai", names: ["Ruth Cohen"], summary: "Hip surgery", category: "illness", urgency: "week", restrictedSuggested: false, ...over });
async function entry(actor: Actor, over: Record<string, unknown> = {}, text = "Ruth Cohen had a hip operation") {
  const { ids } = await createBatch(db, actor, [text], new Date(NOW.getTime() + ++hour * 3_600_000));
  await db.update(proposals).set({ reading: reading(over) }).where(eq(proposals.id, ids[0]));
  return ids[0];
}
let hour = 0;
const texts = (e: { text: string }[]) => e.map((x) => x.text);
const row1 = async (id: string) => (await db.select().from(proposals).where(eq(proposals.id, id)))[0];

beforeEach(async () => {
  vi.stubEnv("CARE_AI_SORTING", "on");
  vi.stubEnv("VERCEL_ENV", "");
  hoisted.generate.mockReset();
  hoisted.later.length = 0;
  db = await testDb();
  t = await team(db);
  r = await reporters(db);
  people = [{ id: CONTACT, name: "Ruth Cohen" }];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("F1: the paste cannot reach a URL", () => {
  it("the first form posts, its text box has no name, and its button is not a native submit", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    vi.doMock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
    const { BringInForm } = await import("@/components/bring-in-form");
    const html = renderToStaticMarkup(<BringInForm />);
    expect(html).toMatch(/<form[^>]*method="post"/);
    const area = /<textarea[^>]*>/.exec(html)![0];
    expect(area).not.toMatch(/\sname=/);
    expect(html).not.toMatch(/type="submit"/);
    expect(html).toMatch(/<button[^>]*type="button"/);
  });
});

describe("F2: one tap is only for the caller's own list", () => {
  it("refuses a public-form proposal, a staff report, a Salesforce arrival and another clergy member's entry", async () => {
    const make = async (values: Record<string, unknown>) => (await db.insert(proposals).values({ channel: "form", reviewScope: "clergy", rawText: "Ruth Cohen had a hip operation", reading: reading(), ...values } as never).returning())[0].id;
    const form = await make({ submittedBy: null, submitterLabel: "Public form", intake: { kind: "public_form", about: "Ruth Cohen", sender: "x", contact: "y" } });
    const staff = (await createProposal(db, r.staff, { rawText: "Ruth Cohen had a hip operation", channel: "staff", reading: undefined })).id;
    await db.update(proposals).set({ reading: reading() }).where(eq(proposals.id, staff));
    await createSalesforceProposal(db, { externalKey: "k1", rawText: "Ruth Cohen died", intake: { kind: "salesforce", event: "death", subjectId: CONTACT, accountId: null, household: null } });
    const sfp = (await db.select().from(proposals).where(eq(proposals.channel, "salesforce")))[0].id;
    await db.update(proposals).set({ reading: reading() }).where(eq(proposals.id, sfp));
    for (const id of [form, staff, sfp]) {
      await expect(acceptQuick(deps(), t.clergy, id, {})).rejects.toBeInstanceOf(InvalidInput);
      expect(await quickPerson(deps(), t.clergy, await row1(id))).toBeNull();
    }
    // Another clergy member's own entry is not even theirs to see; released to the shared Inbox it is theirs to see, but not to one-tap.
    const mine = await entry(t.clergy);
    await expect(acceptQuick(deps(), t.clergy2, mine, {})).rejects.toBeInstanceOf(NotFound);
    await releaseToInbox(db, t.clergy, mine);
    await expect(acceptQuick(deps(), t.clergy2, mine, {})).rejects.toBeInstanceOf(InvalidInput);
    expect(await db.select().from(careItems)).toHaveLength(0);
  });
});

describe("F3: key guards", () => {
  const base = { key: "Enter", repeat: false, msSinceMount: 5000, modifier: false, inControl: false, dialogOpen: false };
  it("acts on a settled, single, unfocused press only", () => {
    expect(reviewKeyAction(base)).toBe("accept");
    expect(reviewKeyAction({ ...base, key: "S" })).toBe("skip");
    expect(reviewKeyAction({ ...base, key: "x" })).toBeNull();
    expect(reviewKeyAction({ ...base, repeat: true })).toBeNull();
    expect(reviewKeyAction({ ...base, msSinceMount: 699 })).toBeNull();
    expect(reviewKeyAction({ ...base, msSinceMount: 700 })).toBe("accept");
    expect(reviewKeyAction({ ...base, inControl: true })).toBeNull();
    expect(reviewKeyAction({ ...base, dialogOpen: true })).toBeNull();
    expect(reviewKeyAction({ ...base, modifier: true })).toBeNull();
  });
});

describe("F4: the right person", () => {
  it("compares the words of the names, the first name allowed to be a nickname", () => {
    expect(sameNameExactly("Ruth Cohen", "Ruth Cohen")).toBe(true);
    expect(sameNameExactly("Ben Cohen", "Benjamin Cohen")).toBe(true);
    expect(sameNameExactly("Ruth Cohen", "Sarah Ruth Cohen-Levy")).toBe(false);
    expect(sameNameExactly("Ruth Cohen", "Ruth Cohen Levy")).toBe(false);
    expect(sameNameExactly("Cohen Ruth", "Ruth Cohen")).toBe(false);
  });
  it("sends 'Ruth Cohen' matched to 'Sarah Ruth Cohen-Levy' to the sheet", async () => {
    people = [{ id: CONTACT, name: "Sarah Ruth Cohen-Levy" }];
    const id = await entry(t.clergy);
    expect(await quickPerson(deps(), t.clergy, await row1(id))).toBeNull();
  });
  it("a nickname for the first name is still one tap, and the card gets the full name, household and place", async () => {
    people = [{ id: CONTACT, name: "Benjamin Cohen" }];
    const id = await entry(t.clergy, { names: ["Ben Cohen"] });
    expect(await quickPerson(deps(), t.clergy, await row1(id))).toMatchObject({ name: "Benjamin Cohen", household: "Cohen Household", place: "St. Louis, MO", member: true });
  });
  it("a first name with five spellings is never one match, so 'Kate Cohen' goes to the sheet", async () => {
    people = [{ id: CONTACT, name: "Katherine Cohen" }];
    expect((await matchNames({ db, sf }, t.clergy, ["Kate Cohen"]))[0].state).toBe("ambiguous");
    const id = await entry(t.clergy, { names: ["Kate Cohen"] });
    expect(await quickPerson(deps(), t.clergy, await row1(id))).toBeNull();
  });
});

describe("F5: the sensitive-word floor", () => {
  it("matches the fixed words at the start of a word, in any case", () => {
    for (const w of ["He talked about suicide", "after the OVERDOSE", "a history of abuse", "in rehab", "psychiatric ward", "an Affair", "a divorce", "her arrest", "tested HIV positive", "a miscarriage", "dementia", "self-harm", "mental health crisis"]) expect(touchesSensitiveFloor(w), w).toBe(true);
    for (const w of ["Ruth Cohen broke her hip", "archive", "behaviour", "he is in the hospital"]) expect(touchesSensitiveFloor(w), w).toBe(false);
  });
  it("forces the sheet whatever the model said, from the words or the summary", async () => {
    const a = await entry(t.clergy, { restrictedSuggested: false }, "Ruth Cohen is in rehab after an overdose");
    const b = await entry(t.clergy, { summary: "Domestic abuse concern" });
    for (const id of [a, b]) {
      expect(await quickPerson(deps(), t.clergy, await row1(id))).toBeNull();
      await expect(acceptQuick(deps(), t.clergy, id, {})).rejects.toBeInstanceOf(InvalidInput);
    }
  });
});

describe("F6: the split uses each of the paste's words once, in order", () => {
  it("cannot stitch a person's name onto another's news", () => {
    const input = "Ruth Cohen broke her hip. Sam Levine is in chemo";
    const noNews = (s: string) => texts(validateSplit(s, [{ text: "Ruth Cohen is in chemo" }]).entries);
    expect(noNews(input)).not.toContain("Ruth Cohen is in chemo");
    // Not across a sentence end or a line break either, however close.
    expect(noNews("Ruth Cohen fell. Sam Levine is in chemo")).not.toContain("Ruth Cohen is in chemo");
    expect(noNews("Ruth Cohen fell\nSam is in chemo")).not.toContain("Ruth Cohen is in chemo");
    // Within a sentence a short gap is fine.
    expect(noNews("Ruth Cohen, who fell, is in chemo")).toEqual(["Ruth Cohen is in chemo"]);
    expect(texts(validateSplit(input, [{ text: "Ruth Cohen broke her hip" }, { text: "Sam Levine is in chemo" }]).entries)).toEqual(["Ruth Cohen broke her hip", "Sam Levine is in chemo"]);
    // Words out of order are refused too.
    expect(texts(validateSplit(input, [{ text: "hip her broke" }]).entries)).not.toContain("hip her broke");
  });
  it("uses each position once: an entry cannot reuse words another entry took", () => {
    const input = "Ruth Cohen broke her hip. Sam Levine is in chemo";
    expect(texts(validateSplit(input, [{ text: "Sam Levine is in chemo" }, { text: "Sam Levine is in" }]).entries)).toEqual(["Ruth Cohen broke her hip.", "Sam Levine is in chemo"]);
    expect(texts(validateSplit("Ruth Cohen hip", [{ text: "Ruth Cohen" }, { text: "Ruth Cohen hip" }]).entries)).toEqual(["Ruth Cohen"]);
  });
  it("40 copies of one entry cannot be made out of one set of words", () => {
    const out = validateSplit("Ruth Cohen broke her hip.", Array.from({ length: 40 }, () => ({ text: "Ruth Cohen broke her hip" })));
    expect(texts(out.entries)).toEqual(["Ruth Cohen broke her hip"]);
    expect(out.discard).toBe(true);
  });
});

describe("F7: per-person limits and confirm-time checks", () => {
  it("allows two lists an hour", async () => {
    for (let i = 0; i < BATCHES_PER_HOUR; i++) await createBatch(db, t.clergy, ["Ruth Cohen"], NOW);
    await expect(createBatch(db, t.clergy, ["Ruth Cohen"], NOW)).rejects.toBeInstanceOf(TooMany);
    await expect(createBatch(db, t.clergy2, ["Ruth Cohen"], NOW)).resolves.toBeTruthy();
    expect(await db.select().from(proposals)).toHaveLength(BATCHES_PER_HOUR + 1);
  });
  it("allows ten model-assisted splits an hour, then splits plainly", async () => {
    hoisted.generate.mockResolvedValue({ output: { entries: [{ text: "Ruth Cohen hip" }] } });
    for (let i = 0; i < SPLITS_PER_HOUR + 3; i++) await splitList(db, t.clergy, "Ruth Cohen hip", NOW);
    expect(hoisted.generate).toHaveBeenCalledTimes(SPLITS_PER_HOUR);
    expect((await splitList(db, t.clergy, "Ruth Cohen hip\nSam Levine", NOW)).how).toBe("lines");
  });
  it("re-checks the total length and the characters at confirm time", () => {
    expect(() => entryList(Array.from({ length: 9 }, () => "x".repeat(1000)))).toThrow(InvalidInput);
    expect(entryList(Array.from({ length: 8 }, () => "x".repeat(1000)))).toHaveLength(8);
    for (const bad of ["a\u0000b", "a‮b", "a​b", "a\rb"]) {
      expect(hasBadChars(bad)).toBe(true);
      expect(() => entryList([bad])).toThrow(InvalidInput);
    }
    expect(entryList(["line one\nline two\ttab"])).toHaveLength(1);
  });
});

describe("F8: a colleague's restricted care is never hidden by a one-tap", () => {
  it("falls back to the sheet when the person is already in a colleague's care (a stub)", async () => {
    await createCareItem(db, t.clergy2, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", restricted: true, restrictedShowsCarer: true });
    const id = await entry(t.clergy);
    expect(await quickPerson(deps(), t.clergy, await row1(id))).toBeNull();
    await expect(acceptQuick(deps(), t.clergy, id, {})).rejects.toBeInstanceOf(InvalidInput);
  });
});

describe("F9: open only for the one who brought it in and holds it", () => {
  const decision = { target: { kind: "new" }, person: { contactId: CONTACT }, category: "illness", summary: "s" };
  const status = async (id: string) => (await db.select().from(careItems).where(eq(careItems.id, id)))[0].status;
  it("a colleague accepting a released entry gets a new item", async () => {
    const { ids } = await createBatch(db, t.clergy, ["Ruth Cohen"], NOW);
    await releaseToInbox(db, t.clergy, ids[0]);
    expect(await status((await acceptProposal(deps(), t.clergy2, ids[0], decision)).careItemId)).toBe("new");
  });
  it("giving the item to a colleague on accepting leaves it new", async () => {
    const { ids } = await createBatch(db, t.clergy, ["Ruth Cohen"], NOW);
    expect(await status((await acceptProposal(deps(), t.clergy, ids[0], { ...decision, ownerUserId: t.clergy2.id })).careItemId)).toBe("new");
  });
});

describe("F10: claims are released when the loop exits early", () => {
  it("an entry whose reading blew up can be read again at once", async () => {
    const { ids } = await createBatch(db, t.clergy, ["Ruth Cohen had a hip operation"], NOW);
    hoisted.generate.mockResolvedValue({ output: { names: ["Ruth Cohen"], summary: "Ruth Cohen is ill.", category: "illness", urgency: "week", dates: [], sensitive: false, followUp: "", evidence: [] } });
    let broke = false;
    const flaky = new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (prop === "update" && !broke) {
          return () => {
            broke = true;
            throw new Error("db down");
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    await readAll(flaky, ids);
    expect(broke).toBe(true);
    expect(await db.select().from(mealRateLimits).where(eq(mealRateLimits.key, `ai:claim:${ids[0]}`))).toHaveLength(0);
    expect(await readAgain(db, t.clergy, ids[0], NOW)).toBe("read");
  });
});

describe("N1: no words of the paste silently disappear", () => {
  const LINES = ["Ruth Cohen broke her hip last week.", "Sam Levine is in chemo this month.", "Joan Katz lost her husband in March.", "Dan Berger is recovering from surgery.", "Mira Adler has a new baby at home."];
  const paste = LINES.join("\n");
  const left = (v: ReturnType<typeof validateSplit>) => v.entries.filter((e) => e.note === "left_over").map((e) => e.text);

  it("keeps two people who share a name or wording", () => {
    const two = "Ruth Cohen hip surgery Tuesday\nRuth Cohen knee surgery Friday";
    const v = validateSplit(two, [{ text: "Ruth Cohen hip surgery Tuesday" }, { text: "Ruth Cohen knee surgery Friday" }]);
    expect(texts(v.entries)).toEqual(["Ruth Cohen hip surgery Tuesday", "Ruth Cohen knee surgery Friday"]);
    expect(v.discard).toBe(false);
  });
  it("keeps a person the model corrected, as a left-over entry with their own words", () => {
    const typo = LINES.join("\n").replace("Mira Adler", "Mria Adler");
    const v = validateSplit(typo, [...LINES.slice(0, 4), LINES[4]].map((text) => ({ text })));
    expect(left(v)).toEqual(["Mria Adler has a new baby at home."]);
    expect(texts(v.entries)).toHaveLength(5);
    expect(v.leftOver).toBe(true);
    expect(v.discard).toBe(false);
  });
  it("adds a person the model left out, in paste order", () => {
    const v = validateSplit(paste, [LINES[0], LINES[1], LINES[3], LINES[4]].map((text) => ({ text })));
    expect(v.entries.map((e) => [e.text, e.note])).toEqual([[LINES[0], undefined], [LINES[1], undefined], [LINES[2], "left_over"], [LINES[3], undefined], [LINES[4], undefined]]);
    expect(v.discard).toBe(false);
  });
  it("throws the model's split away when it left out a third of the words or lost a quarter of its entries", () => {
    expect(validateSplit(paste, [{ text: LINES[0] }, { text: LINES[1] }]).discard).toBe(true);
    expect(validateSplit(paste, [...LINES.map((text) => ({ text })), { text: "an invented one" }, { text: "another invented" }]).discard).toBe(true);
    expect(validateSplit(paste, [...LINES.map((text) => ({ text })), { text: "an invented one" }]).discard).toBe(false);
  });
  it("splitList uses the plain split and says so when the split is discarded", async () => {
    hoisted.generate.mockResolvedValue({ output: { entries: [{ text: LINES[0] }] } });
    const out = await splitList(db, t.clergy, paste, NOW);
    expect(out).toMatchObject({ how: "lines", discarded: true, leftOver: false });
    expect(texts(out.entries)).toEqual(LINES);
  });
  it("splitList reports left-over entries", async () => {
    hoisted.generate.mockResolvedValue({ output: { entries: [LINES[0], LINES[1], LINES[3], LINES[4]].map((text) => ({ text })) } });
    const out = await splitList(db, t.clergy, paste, NOW);
    expect(out).toMatchObject({ how: "ai", leftOver: true, discarded: false });
  });
  it("the plain split continues an over-long entry in the next one instead of cutting it", () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const out = fallbackSplit(long);
    expect(out.entries.length).toBeGreaterThan(1);
    expect(out.entries[0].note).toBeUndefined();
    expect(out.entries.slice(1).every((e) => e.note === "continued")).toBe(true);
    expect(out.entries.every((e) => e.text.length <= 1000)).toBe(true);
    expect(texts(out.entries).join(" ")).toBe(long);
  });
});

describe("N2: invisible marks are removed, other control characters refused naming the entry", () => {
  it("strips direction marks, joiners, byte-order marks and variation selectors", () => {
    const marked = ["a", "\u200e", "b", "\u200f", "c", "\u200d", "d", "\ufeff", "e", "\ufe0f", "f"].join("");
    expect(entryList([marked])).toEqual(["abcdef"]);
  });
  it("still refuses other control characters, and names which entry", () => {
    expect(() => entryList(["fine", "bad\u0000"])).toThrow("entry 2");
    expect(() => entryList(["bad\u202e"])).toThrow(InvalidInput);
  });
});

describe("F5 follow-up: financial and legal trouble", () => {
  it("is on the floor", () => {
    for (const w of ["struggling with depression", "anxiety", "bipolar", "alcoholic", "drug use", "a rape", "in prison", "in jail", "a DUI", "took her own life", "relapse", "custody fight", "restraining order", "facing eviction", "bankruptcy", "foreclosure", "unemployed", "was laid off", "got fired"]) expect(touchesSensitiveFloor(w), w).toBe(true);
  });
});
