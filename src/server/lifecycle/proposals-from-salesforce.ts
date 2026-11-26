/**
 * Salesforce tells us of a death or a birth in a member household; this turns each
 * into ONE proposal for clergy ("Start the bereavement year for the X household?").
 * Read-only: Salesforce is only queried. Only the household's name and record ids are
 * used; nothing about giving. Idempotent by an external key per event (see
 * createSalesforceProposal): a re-run, a later sync or a dismissal never makes a second.
 *
 * It runs inside the once-a-day Salesforce read that already finds the shloshim
 * households (occasions.ts); there is no schedule of its own.
 */
import type { Db } from "@/server/db/types";
import type { SalesforceClient } from "@/server/salesforce/client";
import { createSalesforceProposal } from "@/server/care/intake";
import { noticeNewInbox, noticeUrgentByKey } from "@/server/notify/notify";
import { householdOf, obj, sfId, str } from "./fields";
import type { Occasion } from "./types";
import { addDays, assertDateKey, parseDate } from "./window";

/** Births are looked for this far back, like deaths, so a late entry in Salesforce is still noticed. */
const BIRTH_LOOKBACK_DAYS = 45;
const CAP = 200;

/** A phone notice never stops the daily Salesforce read: a failure logs the error's class only. */
async function noticeSafely(send: () => Promise<unknown>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.error("push.notice_failed", error instanceof Error ? error.name : "unknown");
  }
}

/** A death is keyed on the deceased's Contact id whenever there is one (else the Yahrzeit record), so seeing it first as a Contact and later as a Yahrzeit record is the same key. */
export const deathKey = (deceasedContactId: string | null | undefined, subjectId: string) => `sf:death:${deceasedContactId || subjectId}`;
export const birthKey = (contactId: string) => `sf:birth:${contactId}`;

const deathWords = (household: string | null) => `Start the bereavement year for the ${household ?? "member"} household?`;
const birthWords = (household: string | null) => `A baby was born in the ${household ?? "member"} household. Start the new-baby journey?`;

/** One proposal per death that has a current-member household. Returns how many were new. */
export async function proposeBereavementYears(db: Db, shloshim: Occasion[]): Promise<number> {
  const seen = new Set<string>();
  let made = 0;
  for (const o of shloshim) {
    const key = deathKey(o.deceasedContactId, o.subjectId);
    if (o.type !== "shloshim" || !o.accountId || seen.has(key)) continue;
    seen.add(key);
    if (await createSalesforceProposal(db, { externalKey: key, rawText: deathWords(o.household), intake: { kind: "salesforce", event: "death", subjectId: o.subjectId, accountId: o.accountId, household: o.household, deathDate: o.deathDate?.slice(0, 10) ?? null } })) {
      made++;
      // A death is the urgent notice, sent now (the daily job is already off the request path).
      await noticeSafely(() => noticeUrgentByKey(db, key));
    }
  }
  if (made > 0) await noticeSafely(() => noticeNewInbox(db));
  return made;
}

export function newBabyQuery(today: string): string {
  assertDateKey(today);
  const start = addDays(today, -BIRTH_LOOKBACK_DAYS);
  return `SELECT Id, AccountId, Account.Name, Account.npo02__Formal_Greeting__c, Account.npo02__Informal_Greeting__c, Account.cs_Member__c FROM Contact WHERE Birthdate >= ${start} AND Birthdate <= ${today} AND npsp__Deceased__c = false AND Account.cs_Member__c = true LIMIT ${CAP}`;
}

/** One proposal per baby born in a current-member household in the last weeks. Returns how many were new. */
export async function proposeNewBabies(db: Db, sf: SalesforceClient, today: string): Promise<number> {
  let made = 0;
  for (const r of await sf.query(newBabyQuery(today))) {
    const id = sfId(r.Id);
    const h = householdOf(obj(r.Account), r.AccountId);
    if (!id || !h.accountId || !h.isCurrentMember || !parseDate(today)) continue;
    if (await createSalesforceProposal(db, { externalKey: birthKey(id), rawText: birthWords(h.household), intake: { kind: "salesforce", event: "birth", subjectId: id, accountId: h.accountId, household: str(h.household) } })) made++;
  }
  if (made > 0) await noticeSafely(() => noticeNewInbox(db));
  return made;
}
