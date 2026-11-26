import { redirect } from "next/navigation";
import { isDemo } from "@/lib/demo";
import { GoogleSignInButton } from "@/components/auth-buttons";
import { PlainPage } from "@/components/plain-page";
import { hebrewDate } from "@/lib/hebrew-date";
import { chicagoToday } from "@/server/lifecycle/window";

export const metadata = { title: "Sign in · CRC Care" };
// The bar carries today's Hebrew date, so the page is made per request, never at build time.
export const dynamic = "force-dynamic";

export default function SignInPage() {
  if (isDemo()) redirect("/demo");
  return (
    <PlainPage title="CRC Care" facing={hebrewDate(chicagoToday(new Date()))}>
      <p className="text-ink">Sign in with your CRC Google account.</p>
      <GoogleSignInButton />
    </PlainPage>
  );
}
