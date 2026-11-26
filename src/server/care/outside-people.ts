/**
 * People cared for who are not in Salesforce (a member's parent in another city,
 * a neighbour). They are stored only here. Clergy level create, search and open
 * them; a caregiver meets one only through a care item they can see, by name.
 * A person whose only care items are restricted away from the actor is not found,
 * searched or usable by them (unless they added the row), so the row cannot say
 * who a hidden item is about.
 */
import { and, asc, eq, ilike } from "drizzle-orm";
import { makeAddress, type Address } from "@/lib/address";
import { canEditOutsidePerson, canManageOutsidePeople, deny, outsidePersonVisibleWhere, type Actor } from "@/server/access/policy";
import { agendaEntries, careItems, contactLog, followUps, outsidePeople } from "@/server/db/schema";
import { writeAudit } from "./audit";
import type { Db } from "@/server/db/types";
import { contactIdField, InvalidInput, isUuid, NotFound, optionalAccountIdField, optionalText, text, uuidOrNotFound } from "./validate";

export type OutsidePerson = typeof outsidePeople.$inferSelect;

/** Who a care record is about: a Salesforce contact or an outside person, never both. */
export type PersonSubject = { sfContactId: string | null; outsidePersonId: string | null; sfAccountId: string | null; displayName: string | null };
export type PersonSubjectInput = { sfContactId?: unknown; sfAccountId?: unknown; displayName?: unknown; outsidePersonId?: unknown };

const blank = (v: unknown) => v === undefined || v === null || v === "";

export async function createOutsidePerson(
  db: Db,
  actor: Actor,
  input: { name: unknown; phone?: unknown; email?: unknown; note?: unknown; addressStreet?: unknown; addressCity?: unknown; addressState?: unknown; addressPostalCode?: unknown; linkedSfAccountId?: unknown; linkedSfContactId?: unknown },
): Promise<OutsidePerson> {
  if (!canManageOutsidePeople(actor)) deny();
  const [row] = await db
    .insert(outsidePeople)
    .values({
      name: text(input.name, "name", 200),
      phone: optionalText(input.phone, "phone", 40),
      email: optionalText(input.email, "email", 254),
      note: optionalText(input.note, "note", 200),
      addressStreet: optionalText(input.addressStreet, "addressStreet", 200),
      addressCity: optionalText(input.addressCity, "addressCity", 100),
      addressState: optionalText(input.addressState, "addressState", 50),
      addressPostalCode: optionalText(input.addressPostalCode, "addressPostalCode", 20),
      linkedSfAccountId: optionalAccountIdField(input.linkedSfAccountId, "linkedSfAccountId"),
      linkedSfContactId: blank(input.linkedSfContactId) ? null : contactIdField(input.linkedSfContactId, "linkedSfContactId"),
      createdBy: actor.id,
    })
    .returning();
  return row;
}

export async function getOutsidePerson(db: Db, actor: Actor, id: unknown): Promise<OutsidePerson> {
  if (!canManageOutsidePeople(actor)) deny();
  const [row] = await db.select().from(outsidePeople).where(and(eq(outsidePeople.id, uuidOrNotFound(id)), outsidePersonVisibleWhere(actor))).limit(1);
  if (!row) throw new NotFound();
  return row;
}

/** A simple name search (2 to 60 characters), up to 25 people. */
export async function searchOutsidePeople(db: Db, actor: Actor, query: unknown): Promise<OutsidePerson[]> {
  if (!canManageOutsidePeople(actor)) deny();
  const q = text(query, "query", 60);
  if (q.length < 2) throw new InvalidInput("query");
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db.select().from(outsidePeople).where(and(ilike(outsidePeople.name, pattern), outsidePersonVisibleWhere(actor))).orderBy(asc(outsidePeople.name)).limit(25);
}

/**
 * The person a new care record is about, from its input: an outside person (by id;
 * the name comes from their row) or a Salesforce contact (the caller has resolved
 * the name). Exactly one must be given.
 */
export async function personSubject(db: Db, actor: Actor, input: PersonSubjectInput, nameRequired: boolean): Promise<PersonSubject> {
  if (!blank(input.outsidePersonId)) {
    if (!blank(input.sfContactId)) throw new InvalidInput("outsidePersonId");
    if (!canManageOutsidePeople(actor)) deny();
    if (!isUuid(input.outsidePersonId)) throw new InvalidInput("outsidePersonId");
    const [person] = await db.select({ id: outsidePeople.id, name: outsidePeople.name }).from(outsidePeople).where(and(eq(outsidePeople.id, input.outsidePersonId), outsidePersonVisibleWhere(actor))).limit(1);
    if (!person) throw new InvalidInput("outsidePersonId");
    return { sfContactId: null, outsidePersonId: person.id, sfAccountId: null, displayName: person.name };
  }
  return {
    sfContactId: contactIdField(input.sfContactId),
    outsidePersonId: null,
    sfAccountId: optionalAccountIdField(input.sfAccountId),
    displayName: nameRequired ? text(input.displayName, "displayName", 200) : optionalText(input.displayName, "displayName", 200),
  };
}

/** The address kept on an outside person, or null when none was given. */
export function outsideAddress(p: Pick<OutsidePerson, "addressStreet" | "addressCity" | "addressState" | "addressPostalCode">): Address | null {
  return makeAddress({ street: p.addressStreet, city: p.addressCity, state: p.addressState, postalCode: p.addressPostalCode }, "app");
}

/**
 * Change an outside person's details (name, phone, email, address, the short note): clergy level who may see the person.
 * The cached name on the records about them follows a rename. Audited with ids only: never a name, a number or the note.
 */
export async function updateOutsidePerson(
  db: Db,
  actor: Actor,
  id: unknown,
  input: { name: unknown; phone?: unknown; email?: unknown; note?: unknown; addressStreet?: unknown; addressCity?: unknown; addressState?: unknown; addressPostalCode?: unknown },
): Promise<OutsidePerson> {
  if (!canEditOutsidePerson(actor)) deny();
  const person = await getOutsidePerson(db, actor, id);
  const name = text(input.name, "name", 200);
  const set = {
    name,
    phone: optionalText(input.phone, "phone", 40),
    email: optionalText(input.email, "email", 254),
    note: optionalText(input.note, "note", 200),
    addressStreet: optionalText(input.addressStreet, "addressStreet", 200),
    addressCity: optionalText(input.addressCity, "addressCity", 100),
    addressState: optionalText(input.addressState, "addressState", 50),
    addressPostalCode: optionalText(input.addressPostalCode, "addressPostalCode", 20),
  };
  return db.transaction(async (tx) => {
    const [row] = await tx.update(outsidePeople).set(set).where(eq(outsidePeople.id, person.id)).returning();
    if (name !== person.name) {
      await tx.update(careItems).set({ displayName: name }).where(eq(careItems.outsidePersonId, person.id));
      await tx.update(followUps).set({ displayName: name }).where(eq(followUps.outsidePersonId, person.id));
      await tx.update(contactLog).set({ displayName: name }).where(eq(contactLog.outsidePersonId, person.id));
      await tx.update(agendaEntries).set({ displayName: name }).where(eq(agendaEntries.outsidePersonId, person.id));
    }
    await writeAudit(tx, actor, "outside_person.update", "outside_person", person.id);
    return row;
  });
}
