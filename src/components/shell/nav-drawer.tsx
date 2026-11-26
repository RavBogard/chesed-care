"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";
import { ShulMark } from "@/components/shul-mark";
import { APP_NAME } from "@/lib/brand";
import { isDemo } from "@/lib/demo";
import { btnOnShell } from "../ui";

/** `more`: a secondary destination, grouped under "More" so the list stays short on a phone. */
export type NavItem = { href: string; label: string; badge?: React.ReactNode; more?: boolean };

const brand = "flex items-center gap-2 font-serif text-xl font-bold";
/** In the demo build the invented congregation's logo sits before the name. */
const mark = isDemo() ? <ShulMark size={26} /> : null;

const isCurrent = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

/** The page links, with the current page marked. Used by the drawer (small screens) and the side rail (large); both are on the shell. */
function NavLinks({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const path = usePathname() ?? "";
  const link = (item: NavItem) => {
    const current = isCurrent(path, item.href);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          onClick={onNavigate}
          aria-current={current ? "page" : undefined}
          className={`flex min-h-12 items-center gap-2 rounded-md px-3 py-2 text-base transition-colors ${current ? "bg-shell-raised font-bold text-on-shell" : "text-on-shell-muted hover:bg-shell-raised hover:text-on-shell"}`}
        >
          {item.label}
          {item.badge}
        </Link>
      </li>
    );
  };
  const main = items.filter((i) => !i.more);
  const more = items.filter((i) => i.more);
  // The group is open when the current page is in it, so the current page is never hidden.
  const moreOpen = more.some((i) => isCurrent(path, i.href));
  return (
    <nav aria-label="Main">
      <ul className="flex flex-col gap-1">
        {main.map(link)}
        {more.length > 0 ? (
          <li>
            <details open={moreOpen} className="group">
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2 text-base text-on-shell-muted transition-colors hover:bg-shell-raised hover:text-on-shell [&::-webkit-details-marker]:hidden">
                More
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="transition-transform group-open:rotate-180">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </summary>
              <ul className="mt-1 flex flex-col gap-1 pl-3">{more.map(link)}</ul>
            </details>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}

/** The permanent navy rail beside the content on large screens (it replaces the menu button). */
export function SideNav({ items, who, children }: { items: NavItem[]; who: string; children: React.ReactNode }) {
  return (
    <aside aria-label="Sidebar" className="hidden print:hidden bg-shell text-on-shell [--focus-ring:var(--color-focus-on-shell)] lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:overflow-y-auto lg:p-5">
      <p className={brand}>
        {mark}
        {APP_NAME}
      </p>
      <p className="mt-1 text-sm text-on-shell-muted [overflow-wrap:anywhere]">{who}</p>
      <div className="mt-6">
        <NavLinks items={items} />
      </div>
      <div className="mt-6 border-t border-shell-raised pt-4">{children}</div>
    </aside>
  );
}

/** The left drawer for small screens: a menu button for the top bar and a native modal dialog holding the navigation. */
export function NavDrawer({ items, who, children }: { items: NavItem[]; who: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = () => ref.current?.close();
  return (
    <div className="lg:hidden">
      <button type="button" aria-label="Open menu" aria-haspopup="dialog" className="-ml-2 inline-flex size-11 items-center justify-center rounded-md text-on-shell transition-colors hover:bg-shell-raised" onClick={() => ref.current?.showModal()}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <dialog
        ref={ref}
        aria-label="Menu"
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(20rem,85vw)] max-w-none overflow-y-auto bg-shell p-5 text-on-shell"
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className={brand}>
            {mark}
            {APP_NAME}
          </p>
          <button type="button" className={btnOnShell} onClick={close}>
            Close
          </button>
        </div>
        <p className="mt-1 text-sm text-on-shell-muted [overflow-wrap:anywhere]">{who}</p>
        <div className="mt-6">
          <NavLinks items={items} onNavigate={close} />
        </div>
        <div className="mt-6 border-t border-shell-raised pt-4">{children}</div>
      </dialog>
    </div>
  );
}
