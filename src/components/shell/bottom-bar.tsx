"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { btnPrimary } from "../ui";

/**
 * The fixed bar at the bottom of small screens: one big thumb target to the page most often
 * wanted next. It is a labelled landmark, it is not shown on the page it links to, and it
 * scrolls with the page when the screen is short (large text, landscape).
 */
export function BottomBar({ href, label, search }: { href: string; label: string; search: boolean }) {
  const path = usePathname() ?? "";
  if (path === href || path.startsWith(`${href}/`)) return null;
  return (
    <nav aria-label="Quick link" className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-ground pb-[env(safe-area-inset-bottom)] lg:hidden short:static print:hidden">
      <div className="mx-auto max-w-xl px-4 py-3">
        {search ? (
          <Link href={href} className="flex min-h-12 items-center gap-3 rounded-md border border-control bg-surface px-4 py-2 text-base leading-tight text-ink transition-colors hover:bg-tint">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="shrink-0 text-rubric">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            {label}
          </Link>
        ) : (
          <Link href={href} className={`${btnPrimary} min-h-12 w-full leading-tight`}>
            {label}
          </Link>
        )}
      </div>
    </nav>
  );
}
