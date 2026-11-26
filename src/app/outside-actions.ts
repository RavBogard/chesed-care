"use server";

import { updateOutsidePerson } from "@/server/care/outside-people";
import { fields, runAction } from "@/server/auth/action";
import { getViewer } from "@/server/auth/session";
import type { ActionState } from "@/lib/action-state";

/** Save the details of a person who is not in Salesforce. */
export async function updateOutsidePersonAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const f = fields(form);
  return runAction(await getViewer(), async (actor, db) => {
    await updateOutsidePerson(db, actor, f.outsidePersonId, {
      name: f.name,
      phone: f.phone,
      email: f.email,
      note: f.note,
      addressStreet: f.addressStreet,
      addressCity: f.addressCity,
      addressState: f.addressState,
      addressPostalCode: f.addressPostalCode,
    });
    return "Saved.";
  });
}
