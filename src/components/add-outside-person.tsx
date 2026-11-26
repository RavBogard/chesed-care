"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addOutsidePersonAction } from "@/app/inbox-actions";
import { Sheet } from "./sheet";
import { btnLaptopNatural, btnPrimary, btnQuiet, inputClass, labelClass } from "./ui";

/**
 * "Add someone not in the directory": a name, a phone and a short note, kept only in this app.
 * Saving goes straight to their page, where they can be added to the care list.
 */
export function AddOutsidePerson({ purpose }: { purpose?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <Sheet label="Add someone not in the directory" title="Someone not in the directory" triggerClassName={btnQuiet}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          const data = new FormData(e.currentTarget);
          setMessage(null);
          start(async () => {
            const result = await addOutsidePersonAction(data);
            if (result.status === "error") {
              setMessage(result.message);
              return;
            }
            router.push(`/people/outside/${result.data.id}${purpose === "care" ? "?action=care" : ""}`);
          });
        }}
      >
        <p className="text-sm text-rubric">For someone who is not in Salesforce, such as a member&rsquo;s parent in another city. They are kept only in this app, and marked as not in Salesforce.</p>
        <div>
          <label htmlFor="outside-name" className={labelClass}>
            Name
          </label>
          <input id="outside-name" name="name" required maxLength={200} autoComplete="off" className={inputClass} />
        </div>
        <div>
          <label htmlFor="outside-phone" className={labelClass}>
            Phone (optional)
          </label>
          <input id="outside-phone" name="phone" type="tel" maxLength={40} autoComplete="off" className={inputClass} />
        </div>
        <fieldset className="flex flex-col gap-4">
          <legend className={labelClass}>Address (optional)</legend>
          <div>
            <label htmlFor="outside-street" className="sr-only">
              Street
            </label>
            <input id="outside-street" name="addressStreet" maxLength={200} autoComplete="off" placeholder="Street" className={inputClass} />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_5rem] gap-3">
            <div>
              <label htmlFor="outside-city" className="sr-only">
                City
              </label>
              <input id="outside-city" name="addressCity" maxLength={100} autoComplete="off" placeholder="City" className={inputClass} />
            </div>
            <div>
              <label htmlFor="outside-state" className="sr-only">
                State
              </label>
              <input id="outside-state" name="addressState" maxLength={50} autoComplete="off" placeholder="State" className={inputClass} />
            </div>
          </div>
          <div>
            <label htmlFor="outside-zip" className="sr-only">
              ZIP code
            </label>
            <input id="outside-zip" name="addressPostalCode" maxLength={20} autoComplete="off" inputMode="text" placeholder="ZIP code" className={inputClass} />
          </div>
        </fieldset>
        <div>
          <label htmlFor="outside-note" className={labelClass}>
            A short note (optional)
          </label>
          <input id="outside-note" name="note" maxLength={200} className={inputClass} placeholder="Mother of a member, lives in Denver" />
        </div>
        <button type="submit" aria-disabled={pending} className={`${btnPrimary} ${btnLaptopNatural}`}>
          {pending ? "Saving…" : "Add them"}
        </button>
        <p role="status" aria-live="polite" className="text-sm font-medium text-alert empty:hidden">
          {message}
        </p>
      </form>
    </Sheet>
  );
}
