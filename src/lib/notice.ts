/**
 * The closed set of phone notifications, and the ONLY words any of them may carry.
 *
 * A notice is a kind and (for some kinds) a count. The title, the sentence and the link are
 * fixed per kind in the table below; no name, no note and no free text can be passed in, and
 * the payload built for the push service holds exactly kind, count and path (`noticePayload`).
 * public/sw.js keeps its own copy of this table so the worker never trusts words in a payload;
 * tests/push-service-worker.test.ts fails if the two ever differ.
 *
 * Pure: no database, no environment, no network.
 */

export const NOTICE_KINDS = ["urgent_inbox", "new_inbox", "morning_summary", "assigned", "volunteer_opened", "volunteer_asks", "test", "urgent_digest", "urgent_overnight", "assigned_many", "covering_tomorrow", "practical_request"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** A notice carries a kind and, for the counting kinds, a whole number. There is no field for words. */
export type Notice = { kind: "urgent_inbox" | "assigned" | "volunteer_opened" | "test" | "urgent_overnight" | "covering_tomorrow" | "practical_request" } | { kind: "new_inbox" | "morning_summary" | "volunteer_asks" | "urgent_digest" | "assigned_many"; count: number };

/** What a person switches on or off in Settings. The morning summary follows the summary choice instead; the two volunteer kinds are one switch. */
export const PREF_KINDS = ["urgent_inbox", "new_inbox", "assigned", "coordinator"] as const;
export type PrefKind = (typeof PREF_KINDS)[number];

/** The switch a kind belongs to; null for the kinds with none (the summary follows the summary choice, the test is asked for). */
export function prefOf(kind: NoticeKind): PrefKind | null {
  switch (kind) {
    case "volunteer_opened":
    case "volunteer_asks":
    case "practical_request":
      return "coordinator";
    case "urgent_digest":
    case "urgent_overnight":
      return "urgent_inbox";
    case "assigned_many":
    case "covering_tomorrow":
      return "assigned";
    case "morning_summary":
    case "test":
      return null;
    default:
      return kind;
  }
}

export type NoticeTemplate = { title: string; body: (count: number) => string; path: string; ttl: number; urgency: "high" | "normal" | "low"; tag: string };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
export const NOTICE_TITLE = "CRC Care";

export const NOTICE_TEMPLATES: Record<NoticeKind, NoticeTemplate> = {
  urgent_inbox: { title: NOTICE_TITLE, body: () => "Something needs you today.", path: "/inbox", ttl: 4 * 3600, urgency: "high", tag: "urgent_inbox" },
  new_inbox: { title: NOTICE_TITLE, body: (n) => `${n} new in your Inbox.`, path: "/inbox", ttl: 6 * 3600, urgency: "normal", tag: "new_inbox" },
  morning_summary: { title: NOTICE_TITLE, body: (n) => `${n} ${plural(n, "thing", "things")} for you this morning.`, path: "/", ttl: 12 * 3600, urgency: "low", tag: "morning_summary" },
  assigned: { title: NOTICE_TITLE, body: () => "Something was passed to you.", path: "/", ttl: 24 * 3600, urgency: "normal", tag: "assigned" },
  volunteer_opened: { title: NOTICE_TITLE, body: () => "A volunteer place opened up.", path: "/volunteers", ttl: 12 * 3600, urgency: "normal", tag: "volunteer" },
  urgent_digest: { title: NOTICE_TITLE, body: (n) => `${n} ${plural(n, "thing needs", "things need")} you today.`, path: "/inbox", ttl: 4 * 3600, urgency: "normal", tag: "urgent_inbox" },
  urgent_overnight: { title: NOTICE_TITLE, body: () => "Something needed you overnight.", path: "/inbox", ttl: 12 * 3600, urgency: "normal", tag: "urgent_inbox" },
  assigned_many: { title: NOTICE_TITLE, body: (n) => `${n} ${plural(n, "thing was", "things were")} passed to you.`, path: "/", ttl: 24 * 3600, urgency: "normal", tag: "assigned" },
  covering_tomorrow: { title: NOTICE_TITLE, body: () => "You are covering for a colleague from tomorrow.", path: "/", ttl: 24 * 3600, urgency: "normal", tag: "covering" },
  practical_request: { title: NOTICE_TITLE, body: () => "Someone asked Mitzvah Corps for help.", path: "/volunteers", ttl: 12 * 3600, urgency: "normal", tag: "practical_request" },
  test: { title: NOTICE_TITLE, body: () => "This is a test from CRC Care.", path: "/settings", ttl: 5 * 60, urgency: "normal", tag: "test" },
  volunteer_asks: { title: NOTICE_TITLE, body: (n) => `${n} ${plural(n, "ask", "asks")} still ${plural(n, "needs", "need")} someone.`, path: "/volunteers", ttl: 12 * 3600, urgency: "normal", tag: "volunteer" },
};

const COUNTED: ReadonlySet<NoticeKind> = new Set(["new_inbox", "morning_summary", "volunteer_asks", "urgent_digest", "assigned_many"]);
export const MAX_COUNT = 999;

export type NoticePayload = { kind: NoticeKind; count?: number; path: string };

export function isNoticeKind(value: unknown): value is NoticeKind {
  return typeof value === "string" && (NOTICE_KINDS as readonly string[]).includes(value);
}

/** The payload that goes to the push service: ONLY kind, count and path, whatever else the caller's object held. Throws on an unknown kind. */
export function noticePayload(notice: Notice): NoticePayload {
  const kind: unknown = notice.kind;
  if (!isNoticeKind(kind)) throw new TypeError("unknown notice kind");
  const path = NOTICE_TEMPLATES[kind].path;
  if (!COUNTED.has(kind)) return { kind, path };
  const raw: unknown = (notice as { count?: unknown }).count;
  const count = typeof raw === "number" && Number.isInteger(raw) ? Math.min(Math.max(raw, 0), MAX_COUNT) : 0;
  return { kind, count, path };
}

/** The words shown for a payload (what the worker shows too, from its own copy). */
export function renderNotice(payload: Pick<NoticePayload, "kind" | "count">): { title: string; body: string; tag: string } {
  const t = NOTICE_TEMPLATES[payload.kind];
  return { title: t.title, body: t.body(payload.count ?? 0), tag: t.tag };
}

/**
 * The page a tap opens: a same-origin path only. Anything else (another site, a protocol-relative
 * address, a backslash trick, a path with no leading slash) becomes the home page. Pure.
 */
export function safeTarget(path: unknown, origin: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
  try {
    const url = new URL(path, origin);
    // Judged AFTER the browser has normalised dot segments and escapes: "/.//evil.com" and "/%2e//evil.com" become "//evil.com", which a window would take as another site.
    if (url.origin !== new URL(origin).origin || url.pathname.startsWith("//") || url.pathname.includes("\\")) return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}
