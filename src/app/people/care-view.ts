import type { CareView } from "@/components/person-care";
import { isClergyLevel, type Actor } from "@/server/access/policy";
import { listCareItemAccess } from "@/server/care/care-items";
import { getReporterLines } from "@/server/care/reporter";
import type { OutsidePersonPage, PersonPage } from "@/server/care/person-page";
import { getDb } from "@/server/db/client";
import { liveEntriesForCareItems, liveEntriesForPerson } from "@/server/misheberach/list";
import { listJourneyChoices, listJourneys, type JourneyChoice, type JourneyView } from "@/server/journeys/journeys";
import { logFailure } from "@/server/soft";

/** The care half of either kind of person page, plus the clergy named on each restricted item the actor holds (only its holder may know). */
export async function careViewFor(actor: Actor, page: PersonPage | OutsidePersonPage): Promise<CareView> {
  const access: Record<string, string[]> = {};
  const db = getDb();
  for (const item of page.careItems) {
    if (item.restricted && item.ownerUserId === actor.id) {
      try {
        access[item.id] = await listCareItemAccess(db, actor, item.id);
      } catch {
        access[item.id] = [];
      }
    }
  }
  // Journeys are clergy level; a failure leaves them off the page, never the page broken.
  let journeys: JourneyView[] = [];
  let journeyChoices: JourneyChoice[] | undefined;
  if (isClergyLevel(actor)) {
    try {
      [journeys, journeyChoices] = await Promise.all([
        listJourneys(
          db,
          actor,
          page.careItems.map((i) => i.id),
        ),
        listJourneyChoices(db, actor),
      ]);
    } catch (error) {
      logFailure("Person: journeys unavailable", error);
    }
  }
  // The Mi Sheberach list (clergy): whether this person is on it, and which care items' names are. A failure leaves it off the page.
  let miSheberach: CareView["miSheberach"];
  if (isClergyLevel(actor)) {
    try {
      const ref = "contactId" in page ? { sfContactId: page.contactId } : { outsidePersonId: page.outsidePersonId };
      const [person, items] = await Promise.all([liveEntriesForPerson(db, actor, ref), liveEntriesForCareItems(db, actor, page.careItems.map((i) => i.id))]);
      miSheberach = { person, items };
    } catch (error) {
      logFailure("Person: Mi Sheberach unavailable", error);
    }
  }
  // "Told to us by" (clergy): read through the same visibility as the items. A failure (the columns may not exist yet) leaves it off the page.
  let reporters: CareView["reporters"];
  if (isClergyLevel(actor)) {
    try {
      reporters = Object.fromEntries(await getReporterLines(db, actor, page.careItems.map((i) => i.id)));
    } catch (error) {
      logFailure("Person: reporter line unavailable", error);
    }
  }
  return { today: page.today, name: page.name, careItems: page.careItems, restrictedCare: page.restrictedCare, followUps: page.followUps, contacts: page.contacts, team: page.team, access, journeys, journeyChoices, miSheberach, reporters };
}
