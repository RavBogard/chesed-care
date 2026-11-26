"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { APP_NAME } from "@/lib/brand";

/**
 * The line across the top of every signed-in page of the demo build: this is a demo, who the
 * visitor is being, and the way back to choose someone else. It also puts the demo's name in
 * the browser tab, where each page's own title names the real app.
 */
export function DemoStrip({ who }: { who: string }) {
  const path = usePathname();
  useEffect(() => {
    document.title = document.title.replace("CRC Care", APP_NAME);
  }, [path]);
  return (
    <aside aria-label="Demo" className="print:hidden border-b border-rule bg-tint px-4 py-2 text-sm text-ink lg:px-8">
      <p className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <strong className="font-semibold">Demo.</strong> Everyone here is invented. You are {who}.
        </span>
        <Link href="/demo" className="inline-flex min-h-11 items-center font-medium text-action underline underline-offset-4 hover:text-action-strong">
          Switch role
        </Link>
      </p>
    </aside>
  );
}
