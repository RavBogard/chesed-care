import Link from "next/link";
import { ADMIN_TITLE, hasAdmin } from "./admin-rule";
import { revokeCaptureTokenAction, disconnectConnectorAction, saveTextDraftAction } from "@/app/settings-actions";
import { ActionForm } from "@/components/action-form";
import { CaptureTokenMaker } from "@/components/capture-token-maker";
import { ActionButton, ConfirmAction } from "@/components/confirm-sheet";
import { CopyButton } from "@/components/copy-button";
import { Section } from "@/components/section";
import { AppShell } from "@/components/shell/app-shell";
import { btnLaptopNatural, btnPrimary, btnQuiet, cardClass, checkBox, fieldsetClass, inputClass, labelClass, legendClass, titleClass } from "@/components/ui";
import { setSummaryPrefAction } from "@/app/journey-actions";
import { checkRow } from "@/components/ui";
import { getSummaryPref, type SummaryPref } from "@/server/daily/summary";
import { instantDate } from "@/lib/format";
import * as W from "@/lib/shortcut-wording";
import { canManageUsers, canSeeLifecycle, canUseCaptureTokens } from "@/server/access/policy";
import { listOwnConnections } from "@/server/auth/connections";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { listCaptureTokens, MAX_TOKENS_PER_PERSON } from "@/server/care/capture-tokens";
import { DRAFT_MAX, getTextDrafts, OCCASION_TYPES, type OwnDrafts } from "@/server/care/text-drafts";
import { NotificationsSection, type NotificationsView } from "@/components/notifications/section";
import { AwaySection } from "@/components/team/away-section";
import { getAwaySettings } from "@/server/team/away";
import { chicagoToday } from "@/server/lifecycle/window";
import { emailStatus } from "@/server/email/config";
import { pushStatus, publicVapidKey } from "@/server/notify/config";
import { effectiveKinds, loadPrefs } from "@/server/notify/prefs";
import { listDevices } from "@/server/notify/subscriptions";
import { getDb } from "@/server/db/client";
import { MCP_PATH } from "@/server/mcp/oauth-policy";
import { defaultDraft, DRAFT_PLACEHOLDERS } from "@/server/lifecycle/sms";
import type { Occasion } from "@/server/lifecycle/types";
import { LoadNotice } from "@/components/load-notice";
import { appOriginOrNull, logFailure, soft } from "@/server/soft";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings · CRC Care" };

const TYPE_LABEL = { yahrzeit: "Yahrzeit", shloshim: "Shloshim", birthday: "Birthday", anniversary: "Anniversary" } as const;
const PLACEHOLDER_HELP: Record<(typeof DRAFT_PLACEHOLDERS)[number], string> = {
  "{first_name}": "the person you are texting",
  "{name}": "whom the date is about",
  "{household}": "the household's informal name",
  "{when}": "today or this week",
};

/** A made-up occasion, only to show each type's standard message as an example in its box. */
const SAMPLE: Omit<Occasion, "type"> = {
  date: "2000-01-01",
  subjectId: "sample",
  personName: "Ruth Cohen",
  personFirstName: "Ruth",
  hebrewName: null,
  hebrewDeathDate: null,
  contactHebrewName: null,
  household: null,
  informalGreeting: "Ruth and Ben",
  accountId: null,
  contactId: null,
  contactName: "Sam Cohen",
  contactFirstName: "Sam",
  mobile: null,
  phone: null,
  years: null,
  relationship: null,
  deathDate: null,
};
const SUMMARY_OPTIONS: { value: SummaryPref; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "push", label: "Phone notification" },
  { value: "both", label: "Both" },
  { value: "none", label: "None" },
];

const standardMessage = (type: Occasion["type"]) => defaultDraft({ ...SAMPLE, type }, SAMPLE.date);

export default async function SettingsPage() {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  const db = getDb();
  let notifications: NotificationsView | null = null;
  try {
    // Read on its own: before migration 0013 has run these tables are missing, and only this block is left out.
    const prefs = await loadPrefs(db, actor.id);
    notifications = { publicKey: publicVapidKey(), missing: canManageUsers(actor) ? pushStatus().missing : null, devices: await listDevices(db, actor), prefs, kinds: effectiveKinds(actor, prefs) };
  } catch (error) {
    logFailure("Settings: notifications unavailable", error);
  }
  const awaySettings = await soft("Settings: away unavailable", null, () => getAwaySettings(db, actor));
  const summaryPref = await soft("Settings: summary unavailable", null, () => getSummaryPref(db, actor));
  // Not configured (local work without an origin): the sections still show their state and their steps.
  const origin = appOriginOrNull();
  const connectorAddress = origin ? `${origin}${MCP_PATH}` : null;
  const captureAddress = origin ? `${origin}/api/capture` : null;
  const tokens = canUseCaptureTokens(actor) ? await soft("Settings: capture keys unavailable", null, () => listCaptureTokens(db, actor)) : null;
  const connections = await soft("Settings: connector state unavailable", null, () => listOwnConnections(db, actor));
  const drafts = await soft<OwnDrafts | null>("Settings unavailable", null, () => getTextDrafts(db, actor));

  return (
    <AppShell actor={actor} title="Settings">
      <p className="mb-5 text-sm text-rubric [overflow-wrap:anywhere]">
        Signed in as {actor.name ?? actor.email} ({actor.email}).
      </p>
      {drafts === null ? <LoadNotice what="Settings" /> : null}
      {hasAdmin(actor) ? (
        <p className="mb-5">
          <Link href="/settings/admin" className={btnQuiet} data-testid="admin-link">
            {ADMIN_TITLE}
          </Link>
        </p>
      ) : null}

      {drafts && canSeeLifecycle(actor) ? (
        <Section title="My text drafts">
          <p className="mt-2 text-sm text-rubric">
            The message that fills in when you tap Text on a date. Leave a box blank to use the standard message, shown in grey as an example. You can use these words, and they fill in by themselves:
          </p>
          <ul className="mt-2 text-sm text-rubric">
            {DRAFT_PLACEHOLDERS.map((p) => (
              <li key={p}>
                <code className="rounded-sm bg-tint px-1 text-ink">{p}</code> is {PLACEHOLDER_HELP[p]}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-col gap-4">
            {OCCASION_TYPES.map((type) => (
              <ActionForm key={type} action={saveTextDraftAction} className={cardClass} closeSheetOnOk={false}>
                <input type="hidden" name="occasionType" value={type} />
                <label htmlFor={`draft-${type}`} className={labelClass}>
                  {TYPE_LABEL[type]}
                </label>
                <textarea id={`draft-${type}`} name="body" rows={3} maxLength={DRAFT_MAX} defaultValue={drafts[type] ?? ""} placeholder={standardMessage(type)} className={`${inputClass} py-2`} />
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="submit" name="intent" value="save" className={btnPrimary}>
                    Save
                  </button>
                  <button type="submit" name="intent" value="reset" formNoValidate className={btnQuiet}>
                    Reset to default
                  </button>
                </div>
              </ActionForm>
            ))}
          </div>
        </Section>
      ) : null}

      {summaryPref ? (
        <Section title="Morning summary">
          <p className="mt-2 max-w-prose text-sm text-rubric">
            Each morning, how many follow-ups are overdue or due, and anything new for you: numbers and a link, never names or notes. Nothing comes on a day with nothing to do. Phone notifications are set up under Notifications below. The numbers also show at the top of the page you open first.
          </p>
          {canManageUsers(actor) ? (
            <p className="mt-2 max-w-prose text-sm text-rubric" data-testid="email-config">
              {emailStatus().configured ? "Email is on" : "Email is not set up"}
            </p>
          ) : null}
          <ActionForm action={setSummaryPrefAction} className="mt-3 flex flex-col gap-3" closeSheetOnOk={false}>
            <fieldset className={fieldsetClass} data-testid="summary-pref">
              <legend className={legendClass}>Send it by</legend>
              {SUMMARY_OPTIONS.map((o) => (
                <label key={o.value} className={checkRow}>
                  <input type="radio" name="summaryPref" value={o.value} defaultChecked={summaryPref.pref === o.value} className={checkBox} />
                  {o.label}
                </label>
              ))}
            </fieldset>
            <button type="submit" className={`${btnPrimary} ${btnLaptopNatural}`}>
              Save
            </button>
          </ActionForm>
        </Section>
      ) : null}

      {notifications ? <NotificationsSection view={notifications} /> : null}

      {awaySettings && awaySettings.people.length > 0 ? <AwaySection people={awaySettings.people} coverChoices={awaySettings.coverChoices} today={chicagoToday(new Date())} /> : null}

      {connections ? (
        <Section title="Claude connector">
          {connections.length === 0 ? (
            <p className="mt-2 text-sm text-rubric" data-testid="connector-none">
              Claude is not connected to your account.{connectorAddress ? " To connect, add this address in Claude as a custom connector:" : ""}
            </p>
          ) : (
            <>
              <ul className="mt-2 flex flex-col gap-3">
                {connections.map((c, i) => (
                  <li key={i} className={cardClass} data-testid="connector-connection">
                    <p className={`${titleClass} [overflow-wrap:anywhere]`}>{c.clientName}</p>
                    <p className="text-sm text-rubric [overflow-wrap:anywhere]">
                      {c.connectedAt ? `Connected ${instantDate(c.connectedAt)} · ` : ""}Last active {instantDate(c.lastActiveAt)}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-rubric">Claude can read and add care records as you. Disconnecting ends that everywhere; you can connect again at any time.</p>
              <ActionButton action={disconnectConnectorAction} fields={{}} label="Disconnect" className={btnQuiet} formClassName="mt-3" closeSheetOnOk={false} />
            </>
          )}
          {connectorAddress && connections.length === 0 ? (
            <div className="mt-2 flex flex-col items-start gap-2">
              <code className="block w-full break-all rounded-md border border-rule bg-surface px-3 py-2 text-sm">{connectorAddress}</code>
              <CopyButton text={connectorAddress} label="Copy address" />
            </div>
          ) : null}
        </Section>
      ) : null}

      {tokens ? (
        <Section title={W.SHORTCUT_TITLE}>
          <p className="mt-2 max-w-prose text-sm text-rubric">{W.SHORTCUT_INTRO}</p>
          {tokens.length === 0 ? (
            <p className="mt-3 text-sm text-rubric" data-testid="capture-none">
              {W.SHORTCUT_NONE}
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-3">
              {tokens.map((k) => (
                <li key={k.id} className={cardClass} data-testid="capture-token">
                  <p className={`${titleClass} font-mono text-base`}>{k.prefix}…</p>
                  <p className="text-sm text-rubric">
                    Made {instantDate(k.createdAt)} · {k.lastUsedAt ? `Last used ${instantDate(k.lastUsedAt)}` : "Not used yet"}
                  </p>
                  <div className="mt-3">
                    <ConfirmAction action={revokeCaptureTokenAction} fields={{ tokenId: k.id }} label="End this key" title={W.SHORTCUT_REVOKE_TITLE} explain={W.SHORTCUT_REVOKE_EXPLAIN} confirmLabel="End key" ariaLabel={`End key ${k.prefix}`} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {tokens.length >= MAX_TOKENS_PER_PERSON ? <p className="mt-3 text-sm text-rubric">{W.SHORTCUT_FULL}</p> : null}
          <CaptureTokenMaker full={tokens.length >= MAX_TOKENS_PER_PERSON} />
          <h3 className={`${titleClass} mt-6`}>{W.SHORTCUT_STEPS_TITLE}</h3>
          <ol className="mt-2 flex max-w-prose list-decimal flex-col gap-2 pl-6 text-base">
            {W.SHORTCUT_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {captureAddress ? (
            <div className="mt-3 flex flex-col items-start gap-2">
              <code className="block w-full break-all rounded-md border border-rule bg-surface px-3 py-2 text-sm">{captureAddress}</code>
              <CopyButton text={captureAddress} label="Copy address" />
            </div>
          ) : null}
          <p className="mt-3 max-w-prose text-sm text-rubric">{W.SHORTCUT_AFTER}</p>
        </Section>
      ) : null}

    </AppShell>
  );
}
