"use server";

/**
 * The public Mitzvah Corps actions: no account, so no viewer. Each builds its own clientMeta on the server from the
 * platform's address and a server-signed render time (never from anything the browser says about itself), and
 * logs nothing: no names, contact details or words. Exactly two actions are exported; a new export fails
 * tests/guard-app-auth.test.ts.
 */
import { headers } from "next/headers";
import { JOIN_REFUSED, STOP_FAILED, type JoinReason } from "@/lib/roster-wording";
import { joinMail } from "@/lib/email-wording";
import { getDb } from "@/server/db/client";
import { appOrigin } from "@/server/env";
import { afterEmail, sendEmail } from "@/server/email/send";
import { buildClientMeta } from "@/server/meals/client-meta";
import { text } from "@/server/public/form";
import { stopAsking, submitJoin } from "@/server/volunteers/join";
import { CAN_DO, HOW_OFTEN, PREFER_CONTACT } from "@/lib/can-do";
import { JOIN_STAMP_SCOPE } from "./scope";

export type JoinState = { status: "idle" } | { status: "sent" } | { status: "error"; reason: JoinReason; message: string; fields: string[] };
export type StopState = { status: "idle" } | { status: "stopped" } | { status: "error"; message: string };

/** An optional choice: the value if it is one of the allowed, otherwise nothing. */
const choice = (form: FormData, name: string, allowed: readonly string[]) => {
  const v = text(form, name);
  return allowed.includes(v) ? v : null;
};
const error = (reason: JoinReason, fields: string[] = []): JoinState => ({ status: "error", reason, message: JOIN_REFUSED[reason], fields });

export async function joinAction(_prev: JoinState, form: FormData): Promise<JoinState> {
  try {
    const meta = buildClientMeta({ headers: await headers(), scope: JOIN_STAMP_SCOPE, stamp: text(form, "stamp"), honeypot: text(form, "website") });
    if (!meta) return error("refused");
    const db = getDb();
    const result = await submitJoin(
      db,
      {
        firstName: text(form, "firstName"),
        lastName: text(form, "lastName"),
        contact: text(form, "contact"),
        canDo: form.getAll("canDo").filter((v): v is string => typeof v === "string" && (CAN_DO as readonly string[]).includes(v)),
        availability: text(form, "availability") || null,
        howOften: choice(form, "howOften", HOW_OFTEN),
        preferContact: choice(form, "preferContact", PREFER_CONTACT),
        consent: text(form, "consent") === "on",
      },
      meta,
      new Date(),
      {
        // The welcome email carries the member's own stop link: the one place the plain token is ever used.
        onNew: ({ memberId, email, stopToken }) =>
          afterEmail(async () => {
            const mail = joinMail({ stopUrl: `${appOrigin()}/join/stop/${stopToken}` });
            await sendEmail(db, { to: email, ...mail, kind: "join_welcome", ref: memberId });
          }),
      },
    );
    return result.ok ? { status: "sent" } : error(result.reason, result.fields);
  } catch (e) {
    console.error("Join form failed", e instanceof Error ? e.name : "unknown");
    return error("unknown");
  }
}

/** The confirm button on the stop page: a POST, so a link scanner that only opens the page changes nothing. */
export async function stopAction(_prev: StopState, form: FormData): Promise<StopState> {
  try {
    const meta = buildClientMeta({ headers: await headers(), scope: "join-stop", honeypot: text(form, "website") });
    if (!meta) return { status: "error", message: STOP_FAILED };
    const result = await stopAsking(getDb(), text(form, "token"), meta);
    return result.ok ? { status: "stopped" } : { status: "error", message: STOP_FAILED };
  } catch (e) {
    console.error("Stop link failed", e instanceof Error ? e.name : "unknown");
    return { status: "error", message: STOP_FAILED };
  }
}
