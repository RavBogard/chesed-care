import Link from "next/link";
import { redirect } from "next/navigation";
import { BringInForm } from "@/components/bring-in-form";
import { AppShell } from "@/components/shell/app-shell";
import { btnText } from "@/components/ui";
import { isClergyLevel } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bring in your list · CRC Care" };

/** Clergy and owner: bring in the people you are already caring for, in one sitting. */
export default async function BringInPage() {
  const actor = actorOrRedirect(await getViewer());
  if (!isClergyLevel(actor)) redirect("/");
  return (
    <AppShell actor={actor} title="Bring in your list">
      <BringInForm />
      <p className="mt-6">
        <Link href="/inbox/bring-in/review" className={btnText}>
          Already brought in a list? Go on checking it
        </Link>
      </p>
    </AppShell>
  );
}
