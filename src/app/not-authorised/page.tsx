import Link from "next/link";
import { SignOutButton } from "@/components/auth-buttons";
import { PlainPage } from "@/components/plain-page";
import { hebrewDate } from "@/lib/hebrew-date";
import { chicagoToday } from "@/server/lifecycle/window";

export const metadata = { title: "Not authorised · CRC Care" };
// The bar carries today's Hebrew date, so the page is made per request, never at build time.
export const dynamic = "force-dynamic";

const link = "inline-flex min-h-11 items-center text-base font-medium text-action underline underline-offset-4 hover:text-action-strong";

export default function NotAuthorisedPage() {
  return (
    <PlainPage title="Not authorised" facing={hebrewDate(chicagoToday(new Date()))}>
      <p className="text-ink">This Google account is not on the CRC Care list. If you think it should be, ask Rabbi Daniel to add you.</p>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Link href="/sign-in" className={link}>
          Use another account
        </Link>
        <SignOutButton className={link} />
      </div>
    </PlainPage>
  );
}
