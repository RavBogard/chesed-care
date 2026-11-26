/**
 * Who a care record is about, resolved on the server. The form supplies only a
 * Contact Id; the name and household come from the Salesforce record (read once a
 * day), and a contact Salesforce does not have is refused. Only clergy level reads
 * Salesforce; a caregiver acts through a care item they can see, which already
 * carries the cached name.
 */
import { canSeeLifecycle, deny, type Actor } from "@/server/access/policy";
import { cachedPerson, type PersonDeps } from "./person-page";
import { chicagoToday } from "@/server/lifecycle/window";
import { lookupContactIdField, NotFound } from "./validate";

export type PersonRef = { sfContactId: string; sfAccountId: string | null; displayName: string };

export async function resolvePersonRef(deps: PersonDeps, actor: Actor, contactId: unknown): Promise<PersonRef> {
  if (!canSeeLifecycle(actor)) deny();
  const person = await cachedPerson(deps, lookupContactIdField(contactId), chicagoToday(deps.now));
  if (!person) throw new NotFound();
  return { sfContactId: person.contactId, sfAccountId: person.accountId, displayName: person.name };
}
