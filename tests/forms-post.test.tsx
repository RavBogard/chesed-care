import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/find-actions", () => ({ findPeopleAction: async () => ({ status: "idle" }) }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/" }));

import { ActionForm } from "@/components/action-form";
import { FindForm } from "@/components/find-form";

/**
 * A form without an action is a GET to the current URL until the page hydrates, which
 * would put a searched name or a pastoral note in the address bar and request logs.
 * The server-rendered markup must always carry an action.
 */
describe("forms never fall back to a GET before hydration", () => {
  it("the search form carries an action", () => {
    const html = renderToStaticMarkup(<FindForm />);
    expect(html).toContain("<form");
    expect(html).toContain("action=");
  });

  it("an action form carries an action", () => {
    const html = renderToStaticMarkup(
      <ActionForm action={async () => ({ status: "idle" }) as never}>
        <textarea name="note" />
      </ActionForm>,
    );
    expect(html).toContain("action=");
  });
});
