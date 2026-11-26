import Link from "next/link";
import { SignOutButton } from "@/components/auth-buttons";
import { DemoStrip } from "@/components/demo-strip";
import { isDemo } from "@/lib/demo";
import { Hebrew } from "@/components/hebrew";
import { facingLine } from "@/components/ui";
import { Suspense } from "react";
import { canManageMealPages, canManageMiSheberach, canManageRoster, canPostVolunteerTasks, canSeeLifecycle, canSeeVisitingList, canSeeReports, canSeeTeamView, isCareTeam, isClergyLevel, type Actor } from "@/server/access/policy";
import { ADMIN_TITLE, hasAdmin } from "@/app/settings/admin-rule";
import { BottomBar } from "./bottom-bar";
import { InboxCount } from "./inbox-count";
import { NavDrawer, SideNav, type NavItem } from "./nav-drawer";

const ROLE_LABEL: Record<Actor["role"], string> = { owner: "Owner", clergy: "Clergy", caregiver: "Caregiver", staff: "Staff", lead: "Mitzvah Corps lead", senior_staff: "Senior staff" };

export function navItems(actor: Actor): NavItem[] {
  // Settings is each person's own; Admin (people and roles, journeys, the daily job, the packet) shows only to those with something on it.
  const settings = { href: "/settings", label: "Settings" };
  const admin = hasAdmin(actor) ? [{ href: "/settings/admin", label: ADMIN_TITLE }] : [];
  // Staff, a lead and senior staff report a need and nothing else.
  const meals = canManageMealPages(actor) ? [{ href: "/meals", label: "Mitzvah Meals" }] : [];
  const volunteers = canPostVolunteerTasks(actor) ? [{ href: "/volunteers", label: "Volunteers" }] : [];
  const mi = canManageMiSheberach(actor) ? [{ href: "/mi-sheberach", label: "Mi Sheberach" }] : [];
  const reports = canSeeReports(actor) ? [{ href: "/reports", label: "Numbers" }] : [];
  const roster = [...(canManageRoster(actor) ? [{ href: "/volunteers/roster", label: "Roster" }] : []), ...(canSeeVisitingList(actor) ? [{ href: "/volunteers/visiting", label: "Visiting list" }] : [])];
  // A Mitzvah Corps lead works from Volunteers: their home, Mitzvah Meals, the roster, and Report a need.
  if (actor.role === "lead") return [...volunteers, ...meals, ...roster, { href: "/report", label: "Report a need" }, ...reports, settings, ...admin];
  if (!isCareTeam(actor)) return [{ href: "/report", label: "Report a need" }, ...reports, ...meals, ...volunteers, settings, ...admin];
  // Secondary destinations sit under "More" so the list stays short on a phone.
  const more = [...meals, ...volunteers, ...roster, ...mi, ...reports].map((i) => ({ ...i, more: true }));
  return [
    { href: "/", label: "Today" },
    ...(canSeeLifecycle(actor)
      ? [
          { href: "/inbox", label: "Inbox", badge: (<Suspense fallback={null}><InboxCount actor={actor} /></Suspense>) },
          { href: "/upcoming", label: "Upcoming" },
          { href: "/find", label: "Find a person" },
        ]
      : []),
    { href: "/care", label: "Care list" },
    ...(canSeeTeamView(actor) ? [{ href: "/team", label: "Team" }] : []),
    ...more,
    ...(isClergyLevel(actor) ? [] : [{ href: "/report", label: "Report a need" }]),
    settings,
    ...admin,
  ];
}

const signOutClass = "inline-flex min-h-11 items-center text-base font-medium text-on-shell underline underline-offset-4 hover:text-on-shell-muted";

/**
 * The frame for every signed-in page. Small screens: a navy top bar (menu button and the
 * page's one h1), a left drawer and a bottom bar. Large screens: a permanent navy side rail
 * and a wider column, with the title on the page. `facing` is the Hebrew that faces the
 * title on the same line (the Hebrew date on Today, a person's Hebrew name on their page).
 * `wide` gives a laptop a broader column, for a page set in two (a person's page: the record
 * at the left, the note being written at the right).
 * A caregiver, who cannot search the congregation, gets a link to their care list in the
 * bottom bar instead of search.
 */
export function AppShell({ actor, title, facing, wide = false, children }: { actor: Actor; title: string; facing?: string | null; wide?: boolean; children: React.ReactNode }) {
  const column = wide ? "max-w-xl lg:max-w-5xl" : "max-w-xl lg:max-w-3xl";
  const who = `${actor.name ?? actor.email} · ${ROLE_LABEL[actor.role]}`;
  const items = navItems(actor);
  const search = canSeeLifecycle(actor);
  // The demo has no sign-in to sign out of: the link goes back to the page where a visitor picks who to be.
  const leave = isDemo() ? (
    <Link href="/demo" className={signOutClass}>
      Switch role
    </Link>
  ) : (
    <SignOutButton className={signOutClass} />
  );
  const bottom = search ? { href: "/find", label: "Find a person" } : isCareTeam(actor) ? { href: "/care", label: "Your care list" } : { href: "/report", label: "Report a need" };
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
      <SideNav items={items} who={who}>
        {leave}
      </SideNav>
      <div className="min-w-0">
        {isDemo() ? <DemoStrip who={actor.name ?? ""} /> : null}
        <header className="print:hidden sticky top-0 z-20 bg-shell text-on-shell max-lg:[--focus-ring:var(--color-focus-on-shell)] short:static lg:static lg:bg-transparent lg:text-ink">
          <div className={`mx-auto flex min-h-14 ${column} items-center gap-2 px-4 py-2 lg:px-8 lg:pt-8`}>
            <NavDrawer items={items} who={who}>
              {leave}
            </NavDrawer>
            <div className={`${facingLine} min-w-0 flex-1 lg:border-b lg:border-rule lg:pb-4`}>
              <h1 className="min-w-0 break-words font-serif text-[1.375rem] font-bold leading-tight lg:text-3xl">{title}</h1>
              {facing ? (
                <Hebrew size="text-[1.375rem] lg:text-[2rem]" className="text-on-shell-muted lg:text-action">
                  {facing}
                </Hebrew>
              ) : null}
            </div>
          </div>
        </header>
        <main id="main" className={`mx-auto ${column} px-4 pb-32 pt-5 lg:px-8 lg:pb-16 lg:pt-6`}>
          {children}
          {isDemo() ? (
            <p data-testid="demo-credit" className="print:hidden mt-10 border-t border-rule pt-4 text-sm text-rubric">
              A project of Rabbi Daniel Bogard.{" "}
              <Link href="/demo/own" className="font-medium text-action underline underline-offset-4 hover:text-action-strong">
                Make it your own
              </Link>
            </p>
          ) : null}
        </main>
      </div>
      <BottomBar href={bottom.href} label={bottom.label} search={search} />
    </div>
  );
}
