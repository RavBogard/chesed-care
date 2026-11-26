import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";

const nav = vi.hoisted(() => ({ path: "/" }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), push: vi.fn() }), usePathname: () => nav.path }));
vi.mock("@/app/care-actions", () => ({ logContactAction: async () => ({ status: "idle" }), addToCareListAction: async () => ({ status: "idle" }), addFollowUpAction: async () => ({ status: "idle" }) }));

import { LogContactForm, PersonActions } from "@/components/person-actions";
import { AppShell, navItems } from "@/components/shell/app-shell";
import type { PersonPage } from "@/server/care/person-page";

const clergy: Actor = { id: "u1", email: "c@example.test", name: "Clergy", role: "clergy" };
const carer: Actor = { id: "u2", email: "k@example.test", name: "Carer", role: "caregiver" };
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("app shell", () => {
  it("has exactly one h1, the page title, and a labelled bottom landmark", () => {
    nav.path = "/care";
    const html = renderToStaticMarkup(<AppShell actor={clergy} title="Care list">x</AppShell>);
    expect(count(html, /<h1[ >]/g)).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Care list<\/h1>/);
    expect(html).toMatch(/<nav aria-label="Quick link"/);
    expect(html).toContain('aria-label="Sidebar"');
  });

  it("puts Find a person in the navigation for clergy, not caregivers", () => {
    expect(navItems(clergy).map((i) => i.href)).toContain("/find");
    expect(navItems(carer).map((i) => i.href)).not.toContain("/find");
  });

  it("does not link to Find from the bottom bar while on Find", () => {
    nav.path = "/find";
    const html = renderToStaticMarkup(<AppShell actor={clergy} title="Find a person">x</AppShell>);
    expect(html).not.toContain('aria-label="Quick link"');
    nav.path = "/";
    expect(renderToStaticMarkup(<AppShell actor={clergy} title="Today">x</AppShell>)).toContain('aria-label="Quick link"');
  });
});

describe("log a contact sheet", () => {
  const page = { contactId: "003000000000001AAA", today: "2026-11-23", name: "Ruth Cohen", careItems: [], team: [], followUps: [], contacts: [] } as unknown as PersonPage;
  it("names the person, offers a date that cannot be in the future, and a roomy note", () => {
    const html = renderToStaticMarkup(<PersonActions page={page} actor={clergy} open={undefined} />);
    expect(html).toContain("Log a contact with Ruth Cohen");
    const when = html.match(/<input[^>]*id="log-when"[^>]*>/)?.[0] ?? "";
    expect(when).toContain('name="when"');
    expect(when).toContain('max="2026-11-23"');
    expect(html).toMatch(/<textarea[^>]*rows="8"/);
  });

  it("the same form set on the page for a laptop keeps its fields, with ids of its own", () => {
    const html = renderToStaticMarkup(<LogContactForm page={page} actor={clergy} idPrefix="log-inline" />);
    const when = html.match(/<input[^>]*id="log-inline-when"[^>]*>/)?.[0] ?? "";
    expect(when).toContain('name="when"');
    expect(when).toContain('max="2026-11-23"');
    expect(html).toContain('for="log-inline-note"');
    expect(html).not.toContain('id="log-when"');
    expect(html).toContain('data-testid="outcome-button"');
  });
});
