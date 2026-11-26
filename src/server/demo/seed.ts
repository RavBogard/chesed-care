/**
 * The demo's starting story: a week in the life of Congregation Beit Dugma, written through
 * the app's own functions so every rule (who may see what, what a volunteer is told) holds
 * exactly as it does in the real app. Dates are counted from today. Each scene stands alone:
 * one that fails is named in the result and the rest still run.
 */
import { eq } from "drizzle-orm";
import { DEMO_PERSONAS, demoEmail } from "@/lib/demo";
import type { Actor } from "@/server/access/policy";
import { addAgendaEntry } from "@/server/care/agenda";
import { createCareItem, setCorpsNote } from "@/server/care/care-items";
import { createContactEntry } from "@/server/care/contact-log";
import { createFollowUp } from "@/server/care/follow-ups";
import { createPublicProposal } from "@/server/care/intake";
import { markOccasion } from "@/server/care/occasion-marks";
import { createOutsidePerson } from "@/server/care/outside-people";
import { createProposal, dismissProposal } from "@/server/care/proposals";
import { proposals, users } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { startJourney } from "@/server/journeys/journeys";
import { deathKey, proposeBereavementYears, proposeNewBabies } from "@/server/lifecycle/proposals-from-salesforce";
import { fetchShloshim } from "@/server/lifecycle/shloshim";
import { addDays, chicagoToday, DAY_MS, parseDate } from "@/server/lifecycle/window";
import { createMealPage, goLive, markFamilyAgreed } from "@/server/meals/pages";
import { signUpForMeal } from "@/server/meals/public";
import { addEntry, addRequestedName } from "@/server/misheberach/list";
import type { SalesforceClient } from "@/server/salesforce/client";
import { setAway } from "@/server/team/away";
import { createVolunteerSheet, createVolunteerTask } from "@/server/volunteers/organiser";
import { claimOnSheet, claimTask } from "@/server/volunteers/public";
import { createReferral } from "@/server/volunteers/referrals";
import { addMember } from "@/server/volunteers/roster";
import { addToVisitingList, logVisit, setVisitor } from "@/server/volunteers/visiting";
import { accountId, contactId, contactOf, fullName, yahrzeitId } from "./congregation";

type Team = { rabbi: Actor; rabbi2: Actor; lead: Actor; office: Actor; director: Actor };

/** The five demo accounts. The caller has already emptied the users table. */
export async function insertDemoTeam(db: Db): Promise<Team> {
  const rows = await db
    .insert(users)
    .values(DEMO_PERSONAS.map((p) => ({ email: demoEmail(p.key), name: p.name, role: p.role, active: true, summaryPref: "none" as const })))
    .returning();
  const actor = (key: string): Actor => {
    const row = rows.find((r) => r.email === demoEmail(key as (typeof DEMO_PERSONAS)[number]["key"]))!;
    return { id: row.id, email: row.email, name: row.name, role: row.role };
  };
  return { rabbi: actor("rabbi"), rabbi2: actor("rabbi2"), lead: actor("lead"), office: actor("office"), director: actor("director") };
}

/** Write the story. Returns the names of any scenes that failed (none, when all is well). */
export async function seedDemoStory(db: Db, sf: SalesforceClient, team: Team, now: Date): Promise<string[]> {
  const today = chicagoToday(now);
  const day = (n: number) => addDays(today, n);
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const deps = { sf: () => sf, now };
  const person = (n: number) => {
    const c = contactOf(n);
    return { sfContactId: contactId(n), sfAccountId: accountId(c.household), displayName: fullName(c) };
  };
  let client = 0;
  const meta = () => ({ clientKey: `demo-seed-${++client}`, honeypot: "", elapsedMs: 9_000 });
  const { rabbi, rabbi2, lead, office } = team;

  const failed: string[] = [];
  const scene = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      // The scene's fixed name and the error's class only: a message could quote what was being written.
      console.error("demo.seed_failed", name, error instanceof Error ? error.name : "unknown");
      failed.push(name);
    }
  };

  await scene("harold in hospital", async () => {
    const item = await createCareItem(db, rabbi, { ...person(1), category: "illness", summary: "Hip replacement on Monday. Recovering well but low; Judith is with him most afternoons.", location: "Mercy General, room 412", learnedFrom: "Judith, after services" });
    await createContactEntry(db, rabbi, { careItemId: item.id, kind: "call", outcome: "spoke", occurredAt: ago(5), note: "Spoke with Judith the night before surgery. She is more frightened than he is." });
    await createContactEntry(db, rabbi, { careItemId: item.id, kind: "visit", outcome: "visited", occurredAt: ago(2), note: "Sat with Harold for half an hour. He asked for the Mi Sheberach and wants his name read on Shabbat." });
    await createFollowUp(db, rabbi, { careItemId: item.id, title: "Visit Harold before he moves to rehab", dueDate: day(0) });
    await createFollowUp(db, rabbi, { careItemId: item.id, title: "Call Judith: how is she holding up?", dueDate: day(-1) });
    await addEntry(db, rabbi, { name: "Harold Rosen, Tzvi ben Avraham", sfContactId: contactId(1), careItemId: item.id, consent: "confirmed" }, { now });
    await addAgendaEntry(db, rabbi, { careItemId: item.id, why: "Who visits once he is at Cedar Grove?" }, now);
    await addToVisitingList(db, rabbi, { sfContactId: contactId(1), place: "Mercy General, room 412 (rehab at Cedar Grove from next week)", contactLine: "His wife Judith, (555) 555-0102", visitorNote: "Afternoons are best. Likes baseball talk." }, deps);
  });

  await scene("ruth at home", async () => {
    const item = await createCareItem(db, rabbi, { ...person(11), category: "ongoing", summary: "92 and at home alone since the spring. Sharp, lonely, hard of hearing. Her son Paul lives in Denver.", location: "18 Alder Court" });
    await startJourney(db, rabbi, item.id, { templateKey: "standing", anchorDate: day(-14), intervalWeeks: 4 }, now);
    await createContactEntry(db, rabbi, { careItemId: item.id, kind: "visit", outcome: "visited", occurredAt: ago(14), note: "Brought challah. She told the story of her classroom in 1961 again, and it was better this time." });
    await setCorpsNote(db, rabbi, item.id, "A weekly visitor would mean a great deal. Sit close: she hears better on her left.");
    const visiting = await addToVisitingList(db, rabbi, { sfContactId: contactId(11), place: "At home, 18 Alder Court", contactLine: "Her son Paul, (555) 555-0142", visitorNote: "Loves to talk about her years teaching. Sit on her left side." }, deps);
    return visiting;
  });

  await scene("aaron, restricted", async () => {
    const item = await createCareItem(db, rabbi, { ...person(12), category: "mental_health", restricted: true, summary: "Came to see me after a very hard month. Seeing a therapist weekly now. Asked that nobody else know." });
    await createContactEntry(db, rabbi, { careItemId: item.id, kind: "call", outcome: "spoke", occurredAt: ago(6), note: "A better week. He is sleeping again." });
    await createFollowUp(db, rabbi, { careItemId: item.id, title: "Check in with Aaron", dueDate: day(1) });
  });

  await scene("bella, caregiver", async () => {
    const item = await createCareItem(db, rabbi, { ...person(20), category: "caregiver", summary: "Caring for Isaac at home as his memory fails. Worn out and will not say so." });
    await createContactEntry(db, rabbi, { careItemId: item.id, kind: "call", outcome: "spoke", occurredAt: ago(3), note: "She agreed to let someone sit with Isaac one afternoon a week." });
    await createFollowUp(db, rabbi, { careItemId: item.id, title: "Ask Bella how the first afternoon went", dueDate: day(6) });
    await createReferral(db, rabbi, { sfContactId: contactId(20), kind: "visit", consent: "yes", contactLine: "Bella's mobile, (555) 555-0117", mayShareAddress: true, alreadyInvolved: "Their neighbor brings dinner on Fridays", note: "Two hours on a weekday afternoon so she can get out of the house." }, deps);
  });

  await scene("sara, a quiet matter", async () => {
    const item = await createCareItem(db, rabbi2, { ...person(13), category: "life_change", summary: "Lost her job in October. Luis knows; her parents do not. Wants it kept quiet." });
    await createContactEntry(db, rabbi2, { careItemId: item.id, kind: "text", outcome: "texted", occurredAt: ago(10), note: "Offered coffee. She said yes, after the holidays.", private: true });
    await createFollowUp(db, rabbi2, { careItemId: item.id, title: "Coffee with Sara", dueDate: day(-3) });
  });

  await scene("deborah, surgery ahead", async () => {
    const item = await createCareItem(db, rabbi2, { ...person(21), category: "illness", summary: "Surgery next week. Lives alone; her mother Gloria in Cleveland is unwell too.", source: "staff", learnedFrom: "The front office" });
    await createFollowUp(db, rabbi2, { careItemId: item.id, title: "Call Deborah the night before surgery", dueDate: day(5) });
    const gloria = await createOutsidePerson(db, rabbi2, { name: "Gloria Abrams", phone: "(555) 555-0131", note: "Deborah's mother, in Cleveland. Not a member.", addressCity: "Cleveland", addressState: "OH", linkedSfAccountId: accountId(11), linkedSfContactId: contactId(21) });
    await createCareItem(db, rabbi2, { outsidePersonId: gloria.id, category: "illness", summary: "In and out of hospital this autumn. Deborah asked us to keep her in mind." });
    await addAgendaEntry(db, rabbi2, { careItemId: item.id, why: "Meals after she is home?" }, now);
  });

  await scene("sylvia, in the first month", async () => {
    const item = await createCareItem(db, rabbi2, { ...person(25), category: "bereavement", summary: "Morris died three weeks ago after a long illness. Married 51 years. Her children have gone home." });
    await startJourney(db, rabbi2, item.id, { templateKey: "bereavement_year", anchorDate: day(-20), stepIds: ["shloshim", "plan_unveiling", "note_high_holidays", "note_pesach", "call_first_yahrzeit", "check_in_month_3", "check_in_month_6"] }, now);
    await createContactEntry(db, rabbi2, { careItemId: item.id, kind: "visit", outcome: "visited", occurredAt: ago(15), note: "Shiva. The house was full. She kept asking who would say kaddish with her." });
    await createContactEntry(db, rabbi2, { careItemId: item.id, kind: "call", outcome: "left_message", occurredAt: ago(4) });
  });

  await scene("what salesforce noticed", async () => {
    // As on the first visit to Today each day: a death and a birth in member households become proposals.
    await proposeBereavementYears(db, await fetchShloshim(sf, today));
    await proposeNewBabies(db, sf, today);
    // Sylvia is already in care, so the rabbis have set that one aside. The Kaplan and Levy ones wait in the Inbox.
    const [blum] = await db.select({ id: proposals.id }).from(proposals).where(eq(proposals.externalKey, deathKey(null, yahrzeitId(8)))).limit(1);
    if (blum) await dismissProposal(db, rabbi2, blum.id, now);
  });

  await scene("the inbox", async () => {
    await createProposal(db, office, {
      channel: "staff",
      rawText: "Judith Rosen phoned the office this morning. Harold moves to rehab at Cedar Grove on Thursday for about three weeks. She sounded exhausted and asked if one of the rabbis could call her.",
      reading: {
        person: { name: "Judith Rosen", candidates: [{ contactId: contactId(2), name: "Judith Rosen", household: "Harold and Judith Rosen" }] },
        category: "illness",
        urgency: "today",
        summary: "Harold moves to rehab at Cedar Grove on Thursday for about three weeks. Judith is exhausted and asked for a call.",
        location: "Cedar Grove",
        followUp: { title: "Call Judith Rosen", dueDate: day(0) },
      },
    });
    await createPublicProposal(db, {
      rawText: "My brother Joel was laid off last week and is not telling anyone. He would be embarrassed if he knew I wrote. Could one of the rabbis find a reason to check in with him?",
      intake: { kind: "public_form", about: "Joel Katz", sender: "Mira Katz, his sister", contact: "(555) 555-0150" },
      mayTellThem: "no",
      miSheberach: "no",
    });
    await createPublicProposal(db, {
      rawText: "Ed Shapiro next door has dialysis on Tuesdays and Thursdays now and should not be driving himself. Is there anyone who could give him a ride?",
      intake: { kind: "public_form", about: "Ed Shapiro", sender: "Carol Finch, a neighbor", contact: "carol.finch@example.org" },
      mayTellThem: "yes",
      miSheberach: "not_sure",
      practical: true,
      leadVisible: true,
    });
    // A rabbi's own quick capture: hers alone until she confirms it.
    await createProposal(db, rabbi, { channel: "capture", rawText: "Hannah Weiss at kiddush: Tamar's wedding is in March. She wants to talk about an aufruf and is worried about Ken's mother travelling." });
  });

  await scene("mi sheberach", async () => {
    await addEntry(db, rabbi, { name: "Ruth Friedman, Rut bat Chana", kind: "standing", sfContactId: contactId(11), consent: "confirmed" }, { now });
    await addEntry(db, rabbi2, { name: "Gloria Abrams", askedBy: "Her daughter Deborah" }, { now });
    await addRequestedName(db, office, { name: "Peter Lang", askedBy: "His sister, who phoned the office" }, now);
  });

  await scene("mitzvah corps", async () => {
    const members = [
      { firstName: "Nate", lastName: "Gold", email: "nate.gold@example.org", mobile: "(555) 555-0160", canDo: ["rides", "errands"], area: "North side", availability: "Weekday afternoons" },
      { firstName: "Priya", lastName: "Mendelsohn", email: "priya.m@example.org", mobile: null, canDo: ["meals", "baking", "soup"], area: "Downtown", availability: "Weekends" },
      { firstName: "Walter", lastName: "Fein", email: null, mobile: "(555) 555-0161", canDo: ["visits", "calls", "shiva_minyan"], area: "North side", availability: "Most mornings" },
      { firstName: "Abby", lastName: "Stern", email: "abby.stern@example.org", mobile: "(555) 555-0162", canDo: ["visits", "meals", "care_packages"], area: "West end", availability: "Evenings" },
      { firstName: "Gil", lastName: "Baron", email: "gil.baron@example.org", mobile: null, canDo: ["shiva_minyan", "rides"], area: "West end", availability: "Evenings and Sundays" },
      { firstName: "Renee", lastName: "Adler-Hoff", email: "renee.ah@example.org", mobile: "(555) 555-0163", canDo: ["calls", "errands", "house_sitting"], area: "Downtown", availability: "Flexible" },
    ];
    const added = [];
    for (const m of members) added.push(await addMember(db, lead, m, now));

    const ride = await createVolunteerTask(db, lead, { kind: "ride", forLabel: "Judith", needed: "Drive Judith to Mercy General and home again", date: day(2), timeWindow: "1 to 4 pm", place: "Pick up near Elm Court; the address comes when you say yes", contactLine: "Ellen Brody, (555) 555-0170" }, now);
    if (ride.publicToken) await claimTask(db, ride.publicToken, { firstName: "Nate", lastName: "Gold", contact: "nate.gold@example.org", note: "Happy to. I'll bring the big car.", mayAskAgain: true }, meta(), now);
    await createVolunteerTask(db, lead, { kind: "errand", forLabel: "Ruth", needed: "Pick up a prescription and a few groceries", date: day(3), timeWindow: "Any time before 5", contactLine: "Ellen Brody, (555) 555-0170" }, now);
    await createVolunteerTask(db, lead, { kind: "call", forLabel: "Ed", needed: "A friendly phone call, ten minutes or so", date: day(1), timeWindow: "After lunch" }, now);

    const sheet = await createVolunteerSheet(db, lead, { title: "the Kaplan family", needed: "Help make the minyan so the family can say kaddish", place: "22 Linden Way, Riverton", contactLine: "Ellen Brody, (555) 555-0170", evenings: [0, 1, 2, 3].map((n) => ({ date: day(n), timeWindow: "7 pm" })) }, now);
    const tonight = sheet.evenings[0];
    if (sheet.publicToken && tonight) {
      for (const [firstName, lastName, contact] of [["Walter", "Fein", "(555) 555-0161"], ["Gil", "Baron", "gil.baron@example.org"], ["Abby", "Stern", "abby.stern@example.org"], ["Marcus", "Green", "(555) 555-0123"]]) {
        await claimOnSheet(db, sheet.publicToken, tonight.id, { firstName, lastName, contact, mayAskAgain: false }, meta(), now);
      }
    }

    // Ruth has a regular visitor, who was there last week.
    const [ruth] = await db.query.visitingList.findMany({ where: (v, { eq: is }) => is(v.sfContactId, contactId(11)), limit: 1 });
    const walter = added.find((m) => m.firstName === "Walter");
    if (ruth && walter) {
      await setVisitor(db, lead, ruth.id, walter.id, now);
      await logVisit(db, lead, ruth.id, day(-6), now);
    }
  });

  await scene("meals for the levys", async () => {
    const dates = [1, 2, 4, 6, 8, 10, 12].map((n) => ({ date: day(n) }));
    const page = await createMealPage(db, lead, { title: "the Levy family", note: "Noa arrived last week and everyone is well. Thank you for feeding us while we find our feet.", foodFor: "2 adults (and one very small person who is not eating yet)", kashrut: "kosher_style", dietary: ["no shellfish"], allergies: "Talia is allergic to tree nuts", dropOffWindow: "5 to 6:30 pm", dropOffInstructions: "Cooler on the porch. Please do not ring the bell: the baby may be asleep.", dropOffAddress: "117 Sycamore Street, Riverton", dropOffIsHome: true, sfContactId: contactId(9), sfAccountId: accountId(4), dates }, now);
    await markFamilyAgreed(db, lead, page.id, now);
    const live = await goLive(db, lead, page.id, now);
    const helpers = [
      { firstName: "Priya", lastName: "Mendelsohn", email: "priya.m@example.org", kind: "cook", bringing: "Vegetable lasagne and a salad", foodType: "dairy", mayContactAgain: true },
      { firstName: "Leah", lastName: "Green", email: "leah.green@example.org", kind: "cook", bringing: "Roast chicken, rice, green beans", foodType: "meat", mayContactAgain: false },
      { firstName: "Hannah", lastName: "Weiss", email: "hannah.weiss@example.org", kind: "delivery", bringing: "Ordering from Noodle House", foodType: "not_sure", note: "Tell me if 6 is too late", mayContactAgain: true },
    ];
    for (const [i, helper] of helpers.entries()) {
      const slot = live.slots[i];
      if (live.publicToken && slot) await signUpForMeal(db, live.publicToken, slot.id, helper, meta(), now);
    }
  });

  await scene("already texted today", async () => {
    // Marcus's birthday: someone on the team has sent his text, so it shows as done for everyone.
    await markOccasion(db, rabbi2, { occasionType: "birthday", subjectId: contactId(26), sfAccountId: accountId(14), sfContactId: contactId(26), year: parseDate(today)!.year });
  });

  await scene("a rabbi away next week", async () => {
    await setAway(db, rabbi2, rabbi2.id, { from: day(8), until: day(12), coverUserId: rabbi.id }, now);
    await addAgendaEntry(db, rabbi, { displayName: "Who covers funerals while Jonah is away?" }, now);
  });

  return failed;
}
