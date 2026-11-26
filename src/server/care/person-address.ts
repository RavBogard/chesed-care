/**
 * "Use their address": the one-line address of a person, offered to an organiser to prefill a
 * drop-off or place field. It is offered only to those who already see phone numbers and
 * addresses (clergy level) and is never filled in automatically. Any failure is simply no offer.
 */
import { formatAddress } from "@/lib/address";
import { canSeeLifecycle, type Actor } from "@/server/access/policy";
import { chicagoToday } from "@/server/lifecycle/window";
import { cachedPerson, type PersonDeps } from "./person-page";
import { getOutsidePerson, outsideAddress } from "./outside-people";

export async function addressSuggestion(deps: PersonDeps, actor: Actor, who: { sfContactId?: string | null; outsidePersonId?: string | null }): Promise<string | null> {
  if (!canSeeLifecycle(actor)) return null;
  try {
    const address = who.outsidePersonId
      ? outsideAddress(await getOutsidePerson(deps.db, actor, who.outsidePersonId))
      : who.sfContactId
        ? ((await cachedPerson(deps, who.sfContactId, chicagoToday(deps.now)))?.address ?? null)
        : null;
    return address ? formatAddress(address).oneLine || null : null;
  } catch {
    return null;
  }
}
