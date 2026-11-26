import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { updateOutsidePersonAction } from "@/app/outside-actions";
import { ActionForm } from "@/components/action-form";
import { AddressBlock } from "@/components/address-block";
import { AppShell } from "@/components/shell/app-shell";
import { btnPrimary, btnQuiet, cardClass, inputClass, labelClass } from "@/components/ui";
import { OUTSIDE_EDIT_WORDS } from "@/lib/clergy-wording";
import { canEditOutsidePerson } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { getOutsidePerson, outsideAddress, type OutsidePerson } from "@/server/care/outside-people";
import { NotFound } from "@/server/care/validate";
import { getDb } from "@/server/db/client";
import Link from "next/link";
import { LoadNotice } from "@/components/load-notice";
import { logFailure } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Edit details · CRC Care" };

/** Edit a person who is not in Salesforce: name, phone, email, address and the short note. Saved changes are audited (ids only). */
export default async function EditOutsidePersonPage({ params }: { params: Promise<{ outsideId: string }> }) {
  const actor = actorOrRedirect(await getViewer());
  if (!canEditOutsidePerson(actor)) redirect("/care");
  const { outsideId } = await params;
  let person: OutsidePerson | null = null;
  try {
    person = await getOutsidePerson(getDb(), actor, outsideId);
  } catch (error) {
    if (error instanceof NotFound) notFound();
    logFailure("Outside person edit unavailable", error);
  }
  if (!person) {
    return (
      <AppShell actor={actor} title={OUTSIDE_EDIT_WORDS.title}>
        <LoadNotice what="This page" />
      </AppShell>
    );
  }
  const p = person;
  return (
    <AppShell actor={actor} title={OUTSIDE_EDIT_WORDS.title}>
      <p className="mb-4">
        <Link href={`/people/outside/${p.id}`} className={btnQuiet}>
          Back to {p.name}
        </Link>
      </p>
      <AddressBlock address={outsideAddress(p)} />
      <ActionForm action={updateOutsidePersonAction} className={`${cardClass} flex flex-col gap-4`} closeSheetOnOk={false}>
        <input type="hidden" name="outsidePersonId" value={p.id} />
        <div>
          <label htmlFor="op-name" className={labelClass}>
            Name
          </label>
          <input id="op-name" name="name" required maxLength={200} defaultValue={p.name} className={inputClass} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="op-phone" className={labelClass}>
            Phone
          </label>
          <input id="op-phone" name="phone" type="tel" maxLength={40} defaultValue={p.phone ?? ""} className={inputClass} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="op-email" className={labelClass}>
            Email
          </label>
          <input id="op-email" name="email" type="email" maxLength={254} defaultValue={p.email ?? ""} className={inputClass} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="op-street" className={labelClass}>
            Street
          </label>
          <input id="op-street" name="addressStreet" maxLength={200} defaultValue={p.addressStreet ?? ""} className={inputClass} autoComplete="off" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="op-city" className={labelClass}>
              City
            </label>
            <input id="op-city" name="addressCity" maxLength={100} defaultValue={p.addressCity ?? ""} className={inputClass} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="op-state" className={labelClass}>
              State
            </label>
            <input id="op-state" name="addressState" maxLength={50} defaultValue={p.addressState ?? ""} className={inputClass} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="op-zip" className={labelClass}>
              Postal code
            </label>
            <input id="op-zip" name="addressPostalCode" maxLength={20} defaultValue={p.addressPostalCode ?? ""} className={inputClass} autoComplete="off" />
          </div>
        </div>
        <div>
          <label htmlFor="op-note" className={labelClass}>
            Who they are to us (a short note)
          </label>
          <input id="op-note" name="note" maxLength={200} defaultValue={p.note ?? ""} className={inputClass} autoComplete="off" />
        </div>
        <button type="submit" className={`${btnPrimary} self-start`}>
          {OUTSIDE_EDIT_WORDS.save}
        </button>
      </ActionForm>
    </AppShell>
  );
}
