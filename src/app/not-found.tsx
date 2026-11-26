import Link from "next/link";
import { PlainPage } from "@/components/plain-page";
import { btnPrimary } from "@/components/ui";

export default function NotFoundPage() {
  return (
    <PlainPage title="Not found">
      <p className="text-ink">We could not find that page, or it is not one you can see.</p>
      <Link href="/" className={btnPrimary}>
        Back to Today
      </Link>
    </PlainPage>
  );
}
