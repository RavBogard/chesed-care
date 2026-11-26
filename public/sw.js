/*
 * CRC Care: the service worker for phone notifications, and nothing else.
 * No caching, no fetch handling, no offline behaviour. It holds no secret and calls no server.
 *
 * It shows a notification from the payload's KIND and COUNT only, using its own copy of the
 * sentences below (src/lib/notice.ts holds the server's; tests/push-service-worker.test.ts fails
 * if the two differ). Words in a payload are never shown. A tap focuses an open CRC Care window
 * or opens the link path, and only a same-origin path is ever opened.
 */
"use strict";

var TITLE = "CRC Care";
var FALLBACK_BODY = "There is something new in CRC Care.";

function plural(n, one, many) {
  return n === 1 ? one : many;
}

var TEMPLATES = {
  urgent_inbox: { tag: "urgent_inbox", counted: false, body: function () { return "Something needs you today."; } },
  new_inbox: { tag: "new_inbox", counted: true, body: function (n) { return n + " new in your Inbox."; } },
  morning_summary: { tag: "morning_summary", counted: true, body: function (n) { return n + " " + plural(n, "thing", "things") + " for you this morning."; } },
  urgent_digest: { tag: "urgent_inbox", counted: true, body: function (n) { return n + " " + plural(n, "thing needs", "things need") + " you today."; } },
  urgent_overnight: { tag: "urgent_inbox", counted: false, body: function () { return "Something needed you overnight."; } },
  assigned_many: { tag: "assigned", counted: true, body: function (n) { return n + " " + plural(n, "thing was", "things were") + " passed to you."; } },
  covering_tomorrow: { tag: "covering", counted: false, body: function () { return "You are covering for a colleague from tomorrow."; } },
  practical_request: { tag: "practical_request", counted: false, body: function () { return "Someone asked Mitzvah Corps for help."; } },
  test: { tag: "test", counted: false, body: function () { return "This is a test from CRC Care."; } },
  assigned: { tag: "assigned", counted: false, body: function () { return "Something was passed to you."; } },
  volunteer_opened: { tag: "volunteer", counted: false, body: function () { return "A volunteer place opened up."; } },
  volunteer_asks: { tag: "volunteer", counted: true, body: function (n) { return n + " " + plural(n, "ask", "asks") + " still " + plural(n, "needs", "need") + " someone."; } }
};

/** What to show for a payload: from the kind and count only. An unknown or missing kind gets the plain fallback. */
function noticeFor(payload) {
  var kind = payload && typeof payload.kind === "string" ? payload.kind : "";
  var t = Object.prototype.hasOwnProperty.call(TEMPLATES, kind) ? TEMPLATES[kind] : null;
  if (!t) return { title: TITLE, body: FALLBACK_BODY, tag: "crc-care" };
  var n = t.counted && typeof payload.count === "number" && isFinite(payload.count) && Math.floor(payload.count) === payload.count ? Math.min(Math.max(payload.count, 0), 999) : 0;
  return { title: TITLE, body: t.body(n), tag: t.tag };
}

/** The page a tap opens: a same-origin path, else the home page. */
function safeTarget(path, origin) {
  if (typeof path !== "string" || path.charAt(0) !== "/" || path.charAt(1) === "/" || path.indexOf("\\") !== -1) return "/";
  try {
    var url = new URL(path, origin);
    if (url.origin !== new URL(origin).origin || url.pathname.indexOf("//") === 0 || url.pathname.indexOf("\\") !== -1) return "/";
    return url.pathname + url.search;
  } catch {
    return "/";
  }
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  var shown = noticeFor(payload);
  event.waitUntil(
    self.registration.showNotification(shown.title, {
      body: shown.body,
      tag: shown.tag,
      icon: "/icon",
      data: { path: safeTarget(payload && payload.path, self.location.origin) }
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = safeTarget(event.notification.data && event.notification.data.path, self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          return w.focus().then(function (focused) {
            return focused && "navigate" in focused ? focused.navigate(target) : undefined;
          });
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

if (typeof module !== "undefined" && module.exports) {
  module.exports = { noticeFor: noticeFor, safeTarget: safeTarget, TEMPLATES: TEMPLATES };
}
