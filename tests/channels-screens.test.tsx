import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/server/access/policy";
import { createCaptureToken } from "@/server/care/capture-tokens";
import { createProposal } from "@/server/care/proposals";
import { submitTell } from "@/server/care/tell";
import { proposals } from "@/server/db/schema";
import type { Db } from "@/server/db/types";
import { signRenderStamp } from "@/server/meals/client-meta";
import { reporters, team, testDb } from "./support/db";
import { meta } from "./support/meals";

const state = vi.hoisted(() => ({ viewer: { kind: "signed-out" } as { kind: string; actor?: unknown }, db: null as unknown }));
vi.mock("@/server/auth/session", () => ({ getViewer: async () => state.viewer }));
vi.mock("@/server/db/client", () => ({ getDb: () => state.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "198.51.100.5" }) }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn(), back: vi.fn() }), usePathname: () => "/" }));
vi.mock("@/server/salesforce", () => ({ getSalesforce: () => ({ query: async () => [] }) }));

import InboxPage from "@/app/inbox/page";
import { settingsAndAdmin } from "./support/settings";
import TellSignPage from "@/app/settings/tell-sign/page";
import { createCaptureTokenAction } from "@/app/settings-actions";
import { tellAction } from "@/app/tell/actions";
import TellPage, { metadata as tellMetadata } from "@/app/tell/page";

let db: Db;
let t: Awaited<ReturnType<typeof team>>;
let r: Awaited<ReturnType<typeof reporters>>;
const as = (actor: Actor) => (state.viewer = { kind: "ok", actor });
const html = async (page: Promise<React.ReactElement> | React.ReactElement) => renderToStaticMarkup(await page);
const search = (channel?: string) => Promise.resolve(channel ? { channel } : {});
const count = (s: string, needle: string) => s.split(needle).length - 1;
const formData = (values: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.append(k, v);
  return f;
};

beforeAll(async () => {
  db = await testDb();
  state.db = db;
  process.env.OWNER_EMAILS = "owner@example.test";
  process.env.BETTER_AUTH_SECRET = "test-secret-for-channel-screens";
  process.env.BETTER_AUTH_URL = "https://care.example.test";
  t = await team(db);
  r = await reporters(db);
});

describe("the public form page", () => {
  it("renders for nobody signed in: congregation at the head, no shell or nav, a signed stamp, a honeypot, never indexed", async () => {
    state.viewer = { kind: "signed-out" };
    const out = await html(TellPage());
    expect(out).toContain("Central Reform Congregation");
    expect(out).toContain('data-testid="tell-form"');
    expect(out).toMatch(/name="stamp" value="\d+\.[\w-]+"/);
    expect(out).toContain('name="website"');
    expect(out).not.toMatch(/<nav|<script src|https?:\/\/(?!care\.example)[^"]*\.(js|css)/);
    expect(tellMetadata.robots).toMatchObject({ index: false, follow: false });
  });

  it("the action makes one proposal and answers the same for any person; a stale stamp asks for a reload", async () => {
    const stamp = signRenderStamp("tell", new Date(Date.now() - 10_000));
    const fields = { about: "Ruth Cohen", what: "In hospital", sender: "A friend", contact: "a@example.test", mayTellThem: "no", miSheberach: "not_sure", website: "", stamp };
    const sent = await tellAction({ status: "idle" }, formData(fields));
    const other = await tellAction({ status: "idle" }, formData({ ...fields, about: "Nobody Known" }));
    expect(sent).toEqual({ status: "sent" });
    expect(other).toEqual(sent);
    expect((await db.select().from(proposals)).filter((p) => p.channel === "form")).toHaveLength(2);
    const stale = await tellAction({ status: "idle" }, formData({ ...fields, stamp: "1.2" }));
    expect(stale).toMatchObject({ status: "error", reason: "stale" });
  });
});

describe("the sign", () => {
  it("clergy and the owner get the QR code and the link; no other role does", async () => {
    for (const who of [t.clergy, t.owner]) {
      as(who);
      const out = await html(TellSignPage());
      expect(out).toContain("https://care.example.test/tell");
      expect(out).toContain("<svg");
    }
    for (const who of [t.carer, r.staff, r.lead, r.senior]) {
      as(who);
      const out = await html(TellSignPage());
      expect(out).not.toContain("<svg");
      expect(out).not.toContain("/tell");
    }
  });
});

describe("Settings: capture keys", () => {
  it("every role sees its own keys and the steps, never a key's secret; only clergy level sees the sign link", async () => {
    for (const who of [t.clergy, t.carer, r.staff, r.lead, r.senior]) {
      as(who);
      const made = await createCaptureToken(db, who);
      const out = await settingsAndAdmin();
      expect(out).toContain('data-testid="capture-token"');
      expect(out).toContain(made.prefix);
      expect(out).not.toContain(made.token);
      expect(out).toContain("https://care.example.test/api/capture");
      expect(out.includes("/settings/tell-sign")).toBe(who === t.clergy);
    }
  });

  it("the make action returns the secret once, to the screen that asked, and refuses a fourth", async () => {
    as(t.clergy2);
    const shown: string[] = [];
    for (let i = 0; i < 3; i++) {
      const made = await createCaptureTokenAction();
      if (made.status !== "ok") throw new Error("not made");
      shown.push(made.token);
    }
    expect(new Set(shown).size).toBe(3);
    expect(await createCaptureTokenAction()).toMatchObject({ status: "error" });
    state.viewer = { kind: "signed-out" };
    expect(await createCaptureTokenAction()).toMatchObject({ status: "error" });
    as(t.clergy2);
    const out = await settingsAndAdmin();
    for (const token of shown) expect(out).not.toContain(token);
    expect(out).not.toContain("Make a new key");
  });
});

describe("Inbox: channels", () => {
  it("labels each proposal by where it came from, shows a public form's sender and answers as not verified, and filters by channel", async () => {
    await submitTell(db, { about: "Dana Levy", what: "Surgery on Monday", sender: "Her neighbour", contact: "555-0100", mayTellThem: "yes", miSheberach: "no" }, meta(), new Date());
    await createProposal(db, r.staff, { rawText: "Someone fell", channel: "staff" });
    await createProposal(db, r.lead, { rawText: "Dictated note", channel: "shortcut" });
    as(t.clergy);
    const all = await html(InboxPage({ searchParams: search() }));
    expect(all).toContain('data-testid="inbox-channels"');
    expect(all).toContain('data-testid="inbox-public"');
    expect(all).toMatch(/Unverified: <\/span>/);
    for (const word of ["Dana Levy", "Her neighbour", "555-0100", "Unverified", "iPhone Shortcut", "Staff report"]) expect(all).toContain(word);
    expect(count(all, 'data-testid="inbox-card"')).toBeGreaterThanOrEqual(3);

    const onlyForm = await html(InboxPage({ searchParams: search("form") }));
    const forms = (await db.select().from(proposals)).filter((p) => p.channel === "form" && p.status === "pending").length;
    expect(count(onlyForm, 'data-testid="inbox-card"')).toBe(forms);
    expect(onlyForm).toContain("Dana Levy");
    expect(onlyForm).not.toContain("Dictated note");
    // An unknown channel is ignored, not an error.
    for (const odd of ["nonsense", "constructor", "__proto__", "toString"]) expect(count(await html(InboxPage({ searchParams: search(odd) })), 'data-testid="inbox-card"')).toBe(count(all, 'data-testid="inbox-card"'));
  });
});
