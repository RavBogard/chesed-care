/**
 * Shloshim: recent deaths whose thirty days of mourning have not ended, one row per
 * current-member mourning household (following MavenAI's bereaved-families list).
 *
 * Deaths are read from Yahrzeit__c (English_Date_of_Death__c / Eng_Death_Date__c) and,
 * when no yahrzeit record exists yet, from Contact.Date_of_Death__c. Mourners are the
 * yahrzeit observances, the deceased's own household (Contact.Deceased_Account__c) and,
 * for deaths with no mourner yet, enrollments in the yahrzeit-notification program
 * (pmdm__ServiceParticipant__c) matched on the deceased's first and last name and
 * enrolled on or after the death. Every mourner household must be a current member
 * (cs_Member__c = true). A deceased member with no mourner on file is still listed,
 * without anyone to text.
 *
 * Shloshim ends 30 days after burial when a burial date is recorded, else after death.
 */
import type { SalesforceClient, SfRow } from "@/server/salesforce/client";
import { hebrewDateOfDeath } from "@/lib/hebrew-date";
import { deathDateOf, deceasedHebrewName, deceasedName, hebrewDeathDateOf, hebrewDeathFields, householdFields, householdOf, obj, pickReach, reachFields, reachOf, sfId, str, type Household, type Reach } from "./fields";
import type { Occasion } from "./types";
import { addDays, assertDateKey, parseDate } from "./window";

/** Deaths are read this far back so a late burial still counts; rows are kept while shloshim lasts. */
const LOOKBACK_DAYS = 45;
const CAP = 2000;
const NAME_BATCH = 100;

type Death = {
  subjectId: string;
  deceasedContactId: string | null;
  name: string;
  firstName: string | null;
  surname: string | null;
  hebrewName: string | null;
  hebrewDeathDate: string | null;
  deathDate: string;
  shloshimEnd: string;
  wasMember: boolean;
  mourners: Mourner[];
};
type Mourner = { household: Household; reach: Reach; relationship: string | null };

function died(prefix: string, start: string, end: string): string {
  return (
    `((${prefix}English_Date_of_Death__c >= ${start} AND ${prefix}English_Date_of_Death__c <= ${end}) OR ` +
    `(${prefix}Eng_Death_Date__c >= ${start} AND ${prefix}Eng_Death_Date__c <= ${end}))`
  );
}

export function shloshimQueries(today: string): { deaths: string; contactDeaths: string; observances: string } {
  assertDateKey(today);
  const start = addDays(today, -LOOKBACK_DAYS);
  return {
    deaths:
      `SELECT Id, Name, Deceased_Name__c, Deceased_First_Name__c, Deceased_Last_Name__c, English_Date_of_Death__c, Eng_Death_Date__c, ` +
      `Burial_Date__c, Was_Member__c, Deceased_Hebrew_Name__c, Hebrew_Name__c, ${hebrewDeathFields("")}, Deceased_Contact__c, Deceased_Contact__r.Deceased_Account__c, ` +
      `${householdFields("Deceased_Contact__r.Deceased_Account__r.")} FROM Yahrzeit__c WHERE ${died("", start, today)} ` +
      `ORDER BY English_Date_of_Death__c DESC LIMIT ${CAP}`,
    contactDeaths:
      `SELECT Id, Name, FirstName, LastName, Date_of_Death__c, Hebrew_Name__c, Deceased_Account__c, ${householdFields("Deceased_Account__r.")} ` +
      `FROM Contact WHERE Date_of_Death__c >= ${start} AND Date_of_Death__c <= ${today} ` +
      `AND Id NOT IN (SELECT Deceased_Contact__c FROM Yahrzeit__c WHERE Deceased_Contact__c != null) ORDER BY Date_of_Death__c DESC LIMIT ${CAP}`,
    observances:
      `SELECT Yahrzeit__c, Relationship__c, Observer_Account__c, ${householdFields("Observer_Account__r.")}, ` +
      `Contact__c, ${reachFields("Contact__r.")} FROM Yahrzeit_Observance__c ` +
      `WHERE ${died("Yahrzeit__r.", start, today)} AND Observer_Account__r.cs_Member__c = true LIMIT ${CAP * 2}`,
  };
}

/** The deceased's own household, when it is a current-member household (not the DECEASED catch-all). */
function deceasedHousehold(acct: SfRow | null, accountId: unknown): Mourner[] {
  const h = householdOf(acct, accountId);
  if (!h.accountId || !h.isCurrentMember || /^deceased$/i.test(str(acct?.Name) ?? "")) return [];
  return [{ household: h, reach: h.primary, relationship: "the deceased's household" }];
}

function shloshimEnd(deathDate: string, burial: string | null): string {
  const from = burial && parseDate(burial) && burial >= deathDate ? burial : deathDate;
  return addDays(from, 30);
}

export function collectDeaths(rows: { deaths: SfRow[]; contactDeaths: SfRow[]; observances: SfRow[] }, today: string): Death[] {
  const byYahrzeit = new Map<string, Mourner[]>();
  for (const o of rows.observances) {
    const id = sfId(o.Yahrzeit__c);
    const h = householdOf(obj(o.Observer_Account__r), o.Observer_Account__c);
    if (!id || !h.accountId || !h.isCurrentMember) continue;
    byYahrzeit.set(id, [...(byYahrzeit.get(id) ?? []), { household: h, reach: pickReach(reachOf(o.Contact__c, obj(o.Contact__r)), h.primary), relationship: str(o.Relationship__c) }]);
  }
  const deaths: Death[] = [];
  for (const r of rows.deaths) {
    const id = sfId(r.Id);
    const deathDate = deathDateOf(r)?.slice(0, 10) ?? null;
    if (!id || !deathDate || !parseDate(deathDate) || deathDate > today) continue;
    const dc = obj(r.Deceased_Contact__r);
    const name = deceasedName(r);
    deaths.push({
      subjectId: id,
      deceasedContactId: sfId(r.Deceased_Contact__c),
      name,
      firstName: str(r.Deceased_First_Name__c),
      surname: str(r.Deceased_Last_Name__c) ?? name.split(/\s+/).pop() ?? null,
      hebrewName: deceasedHebrewName(r),
      hebrewDeathDate: hebrewDeathDateOf(r),
      deathDate,
      shloshimEnd: shloshimEnd(deathDate, str(r.Burial_Date__c)),
      wasMember: r.Was_Member__c === true,
      mourners: [...(byYahrzeit.get(id) ?? []), ...deceasedHousehold(obj(dc?.Deceased_Account__r), dc?.Deceased_Account__c)],
    });
  }
  for (const r of rows.contactDeaths) {
    const id = sfId(r.Id);
    const deathDate = str(r.Date_of_Death__c)?.slice(0, 10) ?? null;
    if (!id || !deathDate || !parseDate(deathDate) || deathDate > today) continue;
    deaths.push({
      subjectId: id,
      deceasedContactId: id,
      name: str(r.Name) ?? "(unnamed)",
      firstName: str(r.FirstName),
      surname: str(r.LastName),
      hebrewName: str(r.Hebrew_Name__c),
      hebrewDeathDate: hebrewDateOfDeath({}, deathDate),
      deathDate,
      shloshimEnd: shloshimEnd(deathDate, null),
      wasMember: false,
      mourners: deceasedHousehold(obj(r.Deceased_Account__r), r.Deceased_Account__c),
    });
  }
  return deaths.filter((d) => d.shloshimEnd >= today);
}

/** "Judith Ann Marlowe" and "Judith Marlowe" agree: first and last word, lower-cased, suffixes dropped. */
export function personNameKey(name: string | null | undefined): string | null {
  const words = (name ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\s'-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length > 1 && !/^(jr|sr|ii|iii|iv|md|phd)$/.test(w));
  return words.length >= 2 ? `${words[0]}|${words[words.length - 1]}` : null;
}

/** Surname words safe to place inside a SOQL LIKE: letters only, three or more. */
export function surnameWords(surname: string | null): string[] {
  return [...new Set((surname ?? "").split(/[\s'-]+/).filter((w) => /^\p{L}{3,}$/u.test(w)))];
}

export function enrollmentQueries(deaths: Death[]): string[] {
  const unlinked = deaths.filter((d) => d.mourners.length === 0);
  const words = [...new Set(unlinked.flatMap((d) => surnameWords(d.surname)))];
  if (!words.length) return [];
  const earliest = assertDateKey(unlinked.map((d) => d.deathDate).sort()[0]);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += NAME_BATCH) {
    const like = words
      .slice(i, i + NAME_BATCH)
      .map((w) => `Deceased_Name__c LIKE '%${w}%'`)
      .join(" OR ");
    out.push(
      `SELECT Deceased_Name__c, CreatedDate, Service_Participant_Account__c, ${householdFields("Service_Participant_Account__r.")}, ` +
        `pmdm__Contact__c, ${reachFields("pmdm__Contact__r.")} ` +
        `FROM pmdm__ServiceParticipant__c WHERE pmdm__Status__c != 'Withdrawn' AND CreatedDate >= ${earliest}T00:00:00Z ` +
        `AND Service_Participant_Account__r.cs_Member__c = true AND (${like}) LIMIT ${CAP}`,
    );
  }
  return out;
}

/** Attach enrollment households to deaths that have no mourner yet, in place. */
export function attachEnrollments(deaths: Death[], rows: SfRow[]): void {
  for (const d of deaths) {
    if (d.mourners.length) continue;
    const key = personNameKey(d.name);
    if (!key) continue;
    for (const r of rows) {
      const created = str(r.CreatedDate)?.slice(0, 10) ?? null;
      const h = householdOf(obj(r.Service_Participant_Account__r), r.Service_Participant_Account__c);
      if (personNameKey(str(r.Deceased_Name__c)) !== key || !h.accountId || !h.isCurrentMember) continue;
      if (created && created < d.deathDate) continue;
      d.mourners.push({ household: h, reach: pickReach(reachOf(r.pmdm__Contact__c, obj(r.pmdm__Contact__r)), h.primary), relationship: null });
    }
  }
}

export function deathsToOccasions(deaths: Death[]): Occasion[] {
  return deaths.flatMap((d): Occasion[] => {
    const base = {
      type: "shloshim" as const,
      date: d.shloshimEnd,
      subjectId: d.subjectId,
      deceasedContactId: d.deceasedContactId,
      personName: d.name,
      personFirstName: d.firstName,
      hebrewName: d.hebrewName,
      hebrewDeathDate: d.hebrewDeathDate,
      years: null,
      deathDate: d.deathDate,
    };
    const seen = new Set<string>();
    const rows = d.mourners
      .filter((m) => (seen.has(m.household.accountId!) ? false : (seen.add(m.household.accountId!), true)))
      .map((m) => ({
        ...base,
        household: m.household.household,
        informalGreeting: m.household.informalGreeting,
        accountId: m.household.accountId,
        ...m.reach,
        relationship: m.relationship,
      }));
    if (rows.length || !d.wasMember) return rows;
    return [{ ...base, household: null, informalGreeting: null, accountId: null, contactId: null, contactName: null, contactFirstName: null, contactHebrewName: null, mobile: null, phone: null, relationship: null }];
  });
}

export async function fetchShloshim(sf: SalesforceClient, today: string): Promise<Occasion[]> {
  const q = shloshimQueries(today);
  const [deaths, contactDeaths, observances] = await Promise.all([sf.query(q.deaths), sf.query(q.contactDeaths), sf.query(q.observances)]);
  const collected = collectDeaths({ deaths, contactDeaths, observances }, today);
  for (const soql of enrollmentQueries(collected)) attachEnrollments(collected, await sf.query(soql));
  return deathsToOccasions(collected).sort((a, b) => (b.deathDate ?? "").localeCompare(a.deathDate ?? ""));
}
