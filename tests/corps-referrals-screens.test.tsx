import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE } from "@/lib/action-state";
import { CONSENT_LINES, REFER_HELP, REFERRALS_SECTION, TAKE_WAITS, TAKEN_ALREADY } from "@/lib/referral-wording";
import type { Actor } from "@/server/access/policy";
import { createCareItem } from "@/server/care/care-items";
import { createOutsidePerson } from "@/server/care/outside-people";
import { corpsReferrals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { listOpenReferrals } from "@/server/volunteers/referrals";
import { ACCOUNT, addActor, CONTACT, reporters, team, testDb } from "./support/db";
import { NOW } from "./support/meals";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/volunteers" }));

const household: SfRow = { Name: "Cohen Household", npo02__Formal_Greeting__c: "Ruth and Sam Cohen", npo02__Informal_Greeting__c: "Ruth and Sam", cs_Member__c: true };
const ruth: SfRow = { Id: CONTACT, Name: "Ruth Cohen", FirstName: "Ruth", MobilePhone: "(314) 555-0101", AccountId: ACCOUNT, npsp__Deceased__c: false, Account: household };
vi.mock("@/server/salesforce", () => ({
  getSalesforce: (): SalesforceClient => ({
    async query(soql) {
      return soql.includes("WHERE Id = '003000000000001") ? [ruth] : [];
    },
  }),
}));

import OutsideRoute from "@/app/people/outside/[outsideId]/page";
import PersonRoute from "@/app/people/[contactId]/page";
import { closeReferralAction, referToCorpsAction, setReferralConsentAction, takeReferralAction, withdrawReferralAction } from "@/app/referral-actions";
import AdminPage from "@/app/settings/admin/page";
import VolunteersPage from "@/app/volunteers/page";

let db: Db;
let t: Awaited<ReturnType<typeof team>> & Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const p = <T,>(v: T) => Promise.resolve(v);
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const SUMMARY = "Chemotherapy on Tuesdays";
const CONTACT_LINE = "Her mobile, afternoons only";
const referRuth = (over: Record<string, string> = {}) => referToCorpsAction(IDLE, form({ sfContactId: CONTACT, kind: "soup", consent: "yes", contactLine: CONTACT_LINE, mayShareAddress: "on", alreadyInvolved: "Family in town", note: "Side door", ...over }));
const ruthPage = () => html(PersonRoute({ params: p({ contactId: CONTACT }), searchParams: p({}) }));
const onlyReferral = async () => (await db.select().from(corpsReferrals))[0];

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-referral-screens";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());
beforeEach(async () => {
  vi.setSystemTime(NOW);
  db = await testDb();
  state.db = db;
  t = { ...(await team(db)), ...(await reporters(db)) };
});

describe("a person's page, for clergy", () => {
  it("offers the short form , which leaves what to say to the rabbi; once referred it shows the state and Withdraw instead", async () => {
    as(t.clergy);
    const before = await ruthPage();
    expect(before).toContain('data-testid="referral-add"');
    expect(before).toContain("Refer to Mitzvah Corps");
    expect(before).toContain("Tell her what she needs to know. You decide how much.");
    expect(before).not.toContain("Do not say why");
    expect(before).toContain(REFER_HELP);
    for (const field of ['name="kind"', 'name="consent"', 'name="contactLine"', 'name="mayShareAddress"', 'name="alreadyInvolved"', 'name="note"', 'value="rabbi_asks"', 'value="ask"']) expect(before, field).toContain(field);
    // The form never carries the person's name or a care item.
    const block = before.slice(before.indexOf('data-testid="referral-add"')).split("</section>")[0];
    expect(block).toContain(`name="sfContactId" value="${CONTACT}"`);
    for (const absent of ['name="displayName"', 'name="careItemId"', "Ruth"]) expect(block).not.toContain(absent);

    expect(await referRuth()).toEqual({ status: "ok", message: "Sent to Mitzvah Corps." });
    expect(await onlyReferral()).toMatchObject({ sfContactId: CONTACT, displayName: "Ruth Cohen", kind: "soup", consent: "yes", contactLine: CONTACT_LINE, mayShareAddress: true, referredBy: t.clergy.id });
    const after = await ruthPage();
    expect(after).toContain('data-testid="referral-open"');
    expect(after).toMatch(/Referred on [^<]* · waiting/);
    expect(after).toContain("Withdraw");
    expect(after).not.toContain('data-testid="referral-add"');
    // A second press (another tab) is refused calmly.
    expect((await referRuth()).status).toBe("error");
  });

  it("shows who took it, lets a rabbi settle the consent, and keeps the coordinator's closing line", async () => {
    as(t.owner);
    await referRuth({ consent: "rabbi_asks" });
    const { id } = await onlyReferral();
    const waiting = await ruthPage();
    expect(waiting).toContain(CONSENT_LINES.rabbi_asks);
    expect(waiting).toContain("They said yes");
    expect((await setReferralConsentAction(IDLE, form({ referralId: id, consent: "yes" }))).status).toBe("ok");
    as(t.lead);
    expect(await takeReferralAction(IDLE, form({ referralId: id }))).toEqual({ status: "ok", message: "It is yours." });
    as(t.clergy2);
    const taken = await ruthPage();
    expect(taken).toMatch(/Referred on [^<]* · taken by lead/);
    expect(taken).not.toContain("They said yes<");
    as(t.lead);
    expect((await closeReferralAction(IDLE, form({ referralId: id, as: "done", outcome: "Soup delivered on Thursday" }))).status).toBe("ok");
    as(t.clergy);
    const closed = await ruthPage();
    expect(closed).toContain('data-testid="referral-closed"');
    expect(closed).toContain("Soup delivered on Thursday");
    // With nothing open the form is offered again.
    expect(closed).toContain('data-testid="referral-add"');
  });

  it("works the same for a person who is not in Salesforce, and Withdraw closes it", async () => {
    as(t.clergy);
    const person = await createOutsidePerson(db, t.clergy, { name: "Sam Outside" });
    const page = () => html(OutsideRoute({ params: p({ outsideId: person.id }), searchParams: p({}) }));
    expect(await page()).toContain('data-testid="referral-add"');
    expect((await referToCorpsAction(IDLE, form({ outsidePersonId: person.id, kind: "ride", consent: "coordinator_asks" }))).status).toBe("ok");
    const stored = await onlyReferral();
    expect(stored).toMatchObject({ outsidePersonId: person.id, sfContactId: null, displayName: "Sam Outside", mayShareAddress: false, contactLine: null });
    expect(await page()).toContain('data-testid="referral-open"');
    expect(await withdrawReferralAction(IDLE, form({ referralId: stored.id }))).toEqual({ status: "ok", message: "Withdrawn." });
    const out = await page();
    expect(out).toContain('data-testid="referral-add"');
    expect(out).toContain("Withdrawn");
  });

  it("a form with no consent answer, or with a line break in a line, is refused and nothing is made", async () => {
    as(t.clergy);
    const f = form({ sfContactId: CONTACT, kind: "soup" });
    expect((await referToCorpsAction(IDLE, f)).status).toBe("error");
    expect((await referRuth({ note: "one\ntwo" })).status).toBe("error");
    expect(await db.select().from(corpsReferrals)).toHaveLength(0);
  });
});

describe("the coordinator home", () => {
  it("a lead sees 'Referred by the rabbis' with what a volunteer needs, no way into the care record, and the buttons in turn", async () => {
    const item = await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "illness", summary: SUMMARY });
    as(t.clergy);
    await referRuth();
    const { id } = await onlyReferral();
    as(t.lead);
    const out = await html(VolunteersPage());
    expect(out).toContain(REFERRALS_SECTION);
    expect(out).toContain('data-testid="home-referral"');
    for (const shown of ["Ruth Cohen", "Soup", CONSENT_LINES.yes, CONTACT_LINE, "The address may be given to a volunteer.", "Family in town", "Side door", "Referred by clergy", "Nobody yet", "I&#x27;ll take this"]) expect(out, shown).toContain(shown);
    for (const leak of [item.id, SUMMARY, "Chemotherapy", "illness", `/people/${CONTACT}`, CONTACT]) expect(out, leak).not.toContain(leak);
    expect(out).not.toContain("They said no thank you");

    expect((await takeReferralAction(IDLE, form({ referralId: id }))).status).toBe("ok");
    const mine = await html(VolunteersPage());
    for (const shown of ["Taken by lead", "Mark done", "They said no thank you", "How it went, in a line (optional)"]) expect(mine, shown).toContain(shown);
    expect(mine).not.toContain("I&#x27;ll take this");
    // Another lead sees it is taken and gets no buttons; pressing anyway says so.
    as(await addActor(db, "lead2@example.test", "lead"));
    const theirs = await html(VolunteersPage());
    expect(theirs).toContain("Taken by lead");
    expect(theirs).not.toContain("Mark done");
    expect(await takeReferralAction(IDLE, form({ referralId: id }))).toEqual({ status: "error", message: TAKEN_ALREADY });
    expect((await closeReferralAction(IDLE, form({ referralId: id, as: "declined" }))).status).toBe("error");
    as(t.lead);
    expect((await closeReferralAction(IDLE, form({ referralId: id, as: "declined" }))).status).toBe("ok");
    expect(await html(VolunteersPage())).not.toContain(REFERRALS_SECTION);
  });

  it("while a rabbi asks first the lead's page shows nothing of the referral, and its id does nothing for her; a rabbi still sees it", async () => {
    as(t.clergy);
    await referRuth({ consent: "rabbi_asks" });
    const { id } = await onlyReferral();
    as(t.lead);
    const out = await html(VolunteersPage());
    for (const gone of ["Ruth Cohen", CONTACT_LINE, "A rabbi will ask them first"]) expect(out).not.toContain(gone);
    expect((await takeReferralAction(IDLE, form({ referralId: id }))).status).toBe("error");
    // The clergy see it on the same page, with the line they wrote, and are told why it cannot be taken yet.
    as(t.clergy2);
    const forClergy = await html(VolunteersPage());
    expect(forClergy).toContain(CONTACT_LINE);
    expect(forClergy).toContain("A rabbi will ask them first. Please do not contact them yet.");
    expect(await takeReferralAction(IDLE, form({ referralId: id }))).toEqual({ status: "error", message: TAKE_WAITS });
  });

  it("staff, senior staff and a caregiver see nothing of it, on the home or through the actions", async () => {
    as(t.clergy);
    await referRuth();
    const { id } = await onlyReferral();
    for (const a of [t.staff, t.senior, t.carer]) {
      as(a);
      const out = await html(VolunteersPage());
      expect(out).toContain("do not have access");
      for (const leak of ["Ruth Cohen", REFERRALS_SECTION, CONTACT_LINE]) expect(out).not.toContain(leak);
      expect(await referToCorpsAction(IDLE, form({ sfContactId: CONTACT, kind: "call", consent: "yes" }))).toEqual({ status: "error", message: "You do not have access to do that." });
      for (const action of [takeReferralAction, withdrawReferralAction]) expect(await action(IDLE, form({ referralId: id }))).toEqual({ status: "error", message: "You do not have access to do that." });
      expect(await closeReferralAction(IDLE, form({ referralId: id, as: "done" }))).toEqual({ status: "error", message: "You do not have access to do that." });
      expect(await setReferralConsentAction(IDLE, form({ referralId: id, consent: "yes" }))).toEqual({ status: "error", message: "You do not have access to do that." });
    }
    expect(await listOpenReferrals(db, t.lead)).toMatchObject([{ id, takenByName: null }]);
    // A caregiver may open a person's page they have work on; the referral block is not there either way.
    as(t.carer);
    await createCareItem(db, t.clergy, { sfContactId: CONTACT, sfAccountId: ACCOUNT, displayName: "Ruth Cohen", category: "other", visibility: "caregivers", ownerUserId: t.carer.id });
    const page = await ruthPage().catch(() => "");
    for (const leak of ["Refer to Mitzvah Corps", "referral-open", "Referred on"]) expect(page).not.toContain(leak);
  });
});

describe("settings", () => {
  it("the daily job's tasks have plain labels, and none says that notes, agenda entries, referrals or contact details are deleted", async () => {
    as(t.owner);
    const { runDailyJob, DAILY_TASKS } = await import("@/server/daily/run");
    await runDailyJob({ db, now: NOW, owners: new Set(["owner@example.test"]), origin: null }, DAILY_TASKS.filter((x) => x.key !== "helper_reminders"));
    const out = await html(AdminPage());
    expect(out).toContain("Mitzvah Corps referrals nobody took, withdrawn");
    expect(out).toContain("Mitzvah Meals clean-up: notes and old links");
    expect(out).not.toMatch(/Old notes deleted|Old agenda entries|referrals clean-up|note_retention|corps_referral_purge|agenda deleted|Thank-you details cleared|visiting list entries deleted|clergy_upkeep|visiting_purge/i);
  });
});
