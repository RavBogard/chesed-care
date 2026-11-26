"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { subscribeDeviceAction, turnOffThisDeviceAction } from "@/app/notifications-actions";
import { keyToBytes, pushMode, type PushMode } from "@/lib/push-client";
import { btnPrimary, btnQuiet, checkRow, noticeClass } from "@/components/ui";

type Mode = PushMode | "checking" | "on";

/** The three steps iPhone needs before it can show notifications at all. */
const IOS_STEPS = ["Tap the Share button at the bottom of Safari.", "Tap Add to Home Screen, then Add.", "Open CRC Care from its new icon on your Home Screen, and come back to this page."];

const registration = () => navigator.serviceWorker.getRegistration("/");

/**
 * Turn notifications on or off for the device in your hand. Asking the browser needs a tap, so the question is only
 * put when the button is pressed, after one plain line saying what will happen.
 */
export function DeviceControl({ publicKey }: { publicKey: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("checking");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
      const base = pushMode({
        hasServiceWorker: "serviceWorker" in navigator,
        hasPushManager: "PushManager" in window,
        hasNotification: "Notification" in window,
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
        standalone,
        permission: "Notification" in window ? Notification.permission : "none",
      });
      let next: Mode = base;
      if (base === "ready") {
        try {
          const reg = await registration();
          next = (await reg?.pushManager.getSubscription()) ? "on" : "ready";
        } catch {
          next = "ready";
        }
      }
      if (!cancelled) setMode(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function turnOn() {
    setBusy(true);
    setMessage(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMode(permission === "denied" ? "denied" : "ready");
        setMessage({ kind: "error", text: "Notifications were not turned on, because the browser was not allowed to show them." });
        return;
      }
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
      const json = sub.toJSON();
      const saved = await subscribeDeviceAction({ endpoint: sub.endpoint, p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" });
      if (saved.status === "error") {
        await sub.unsubscribe();
        setMessage({ kind: "error", text: saved.message });
        return;
      }
      setMode("on");
      setMessage({ kind: "ok", text: "Notifications are on for this device." });
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "Notifications could not be turned on here. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setMessage(null);
    try {
      const sub = await (await registration())?.pushManager.getSubscription();
      if (sub) {
        await turnOffThisDeviceAction({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setMode("ready");
      setMessage({ kind: "ok", text: "Notifications are off for this device." });
      router.refresh();
    } catch {
      setMessage({ kind: "error", text: "Could not turn them off. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col items-start gap-3" data-testid="device-control" data-mode={mode}>
      {mode === "checking" ? <p className="text-sm text-rubric">Checking this device…</p> : null}
      {mode === "unsupported" ? <p className={noticeClass}>This browser cannot show notifications. Try Chrome, Edge, Firefox or Safari on a recent phone or computer.</p> : null}
      {mode === "ios_install" ? (
        <div className="w-full rounded-md border border-rule bg-surface p-4" data-testid="ios-steps">
          <p className="text-base font-semibold">On iPhone, add CRC Care to your Home Screen first</p>
          <p className="mt-1 text-sm text-rubric">Apple only allows notifications for apps on the Home Screen. Three steps, once:</p>
          <ol className="mt-2 list-decimal ps-5 text-base">
            {IOS_STEPS.map((step) => (
              <li key={step} className="py-1">
                {step}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {mode === "denied" ? <p className={noticeClass}>Notifications are blocked for this site in your browser. Allow them in the browser&apos;s site settings, then come back to this page.</p> : null}
      {mode === "ready" ? (
        <>
          <p className="max-w-prose text-sm text-rubric">Your browser will ask to allow notifications. Choose Allow, and this device will get them.</p>
          <button type="button" className={btnPrimary} disabled={busy} onClick={turnOn}>
            Turn on notifications on this device
          </button>
        </>
      ) : null}
      {mode === "on" ? (
        <>
          <p className={checkRow}>Notifications are on for this device.</p>
          <button type="button" className={btnQuiet} disabled={busy} onClick={turnOff}>
            Turn off on this device
          </button>
        </>
      ) : null}
      <div role="status" aria-live="polite">
        {message?.kind === "ok" ? <p className="text-sm font-medium text-done">{message.text}</p> : null}
      </div>
      {message?.kind === "error" ? (
        <p role="alert" className="text-base font-medium text-alert">
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
