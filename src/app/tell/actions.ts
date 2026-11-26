"use server";

/**
 * The public "Let the clergy know" action: no account, so no viewer. It builds its own
 * clientMeta on the server from the platform's address and a server-signed render time
 * (never from anything the browser says about itself). It logs nothing: no names,
 * contact details or words.
 */
import { headers } from "next/headers";
import { TELL_REFUSED, type TellReason } from "@/lib/tell-wording";
import { submitTell } from "@/server/care/tell";
import { getDb } from "@/server/db/client";
import { buildClientMeta } from "@/server/meals/client-meta";
import { text } from "@/server/public/form";
import { TELL_STAMP_SCOPE } from "./scope";

export type TellState = { status: "idle" } | { status: "sent" } | { status: "error"; reason: TellReason; message: string; fields: string[] };

const error = (reason: TellReason, fields: string[] = []): TellState => ({ status: "error", reason, message: TELL_REFUSED[reason], fields });

export async function tellAction(_prev: TellState, form: FormData): Promise<TellState> {
  try {
    const meta = buildClientMeta({ headers: await headers(), scope: TELL_STAMP_SCOPE, stamp: text(form, "stamp"), honeypot: text(form, "website") });
    if (!meta) return error("refused");
    const result = await submitTell(
      getDb(),
      { about: text(form, "about"), what: text(form, "what"), sender: text(form, "sender"), contact: text(form, "contact"), mayTellThem: text(form, "mayTellThem"), miSheberach: text(form, "miSheberach"), help: text(form, "help") || undefined },
      meta,
    );
    return result.ok ? { status: "sent" } : error(result.reason, result.fields);
  } catch (e) {
    console.error("Tell form failed", e instanceof Error ? e.name : "unknown");
    return error("unknown");
  }
}
