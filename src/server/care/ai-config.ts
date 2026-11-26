/**
 * Whether the app's own AI reading of new reports is on, and which model does it.
 * On only in the production deployment (VERCEL_ENV=production) or where
 * CARE_AI_SORTING=on says so; CARE_AI_SORTING=off always wins. Previews, local work
 * and tests are off.
 *
 * Two ways to reach the model. With ANTHROPIC_API_KEY set, the app calls Anthropic
 * directly with the congregation's own key. Without it, the call goes through Vercel
 * AI Gateway (the deployment's OIDC identity on Vercel, AI_GATEWAY_API_KEY elsewhere),
 * which needs credits on the Vercel account. Daniel, 2026-11-24: zero data retention
 * is not required for these messages.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

/** The one place the model is named. Through the gateway: an exact id from https://ai-gateway.vercel.sh/v1/models. */
export const AI_MODEL = "anthropic/claude-opus-5.5";
/** The same model's id on Anthropic's own API, used with ANTHROPIC_API_KEY. */
export const AI_MODEL_DIRECT = "claude-opus-5-5";

export type AiRoute = "anthropic" | "gateway";

export function aiRoute(env: Record<string, string | undefined> = process.env): AiRoute {
  return env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : "gateway";
}

/** The model to call: Anthropic directly when the congregation's key is set, otherwise the gateway's id. */
export function aiModel(env: Record<string, string | undefined> = process.env): LanguageModel {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? createAnthropic({ apiKey: key })(AI_MODEL_DIRECT) : AI_MODEL;
}

/** Model calls the app may make per clock hour, from everyone. */
export const AI_CALLS_PER_HOUR = 200;
/** Model calls the app may make per day (UTC), from everyone. */
export const AI_CALLS_PER_DAY = 1000;
/** Of those, the most that may be spent on reading public-form (/tell) reports, so a flood of them cannot use up the day for staff reports. */
export const AI_FORM_CALLS_PER_DAY = 600;
/** "Read it again" presses per person per clock hour. */
export const AI_AGAIN_PER_PERSON = 20;

export function aiSortingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.CARE_AI_SORTING?.trim().toLowerCase();
  // The demo build never calls a model: its Inbox shows ready-made readings.
  if (flag === "off" || env.NEXT_PUBLIC_CARE_DEMO === "on") return false;
  return flag === "on" || env.VERCEL_ENV === "production";
}

export function aiSortingStatus(env: Record<string, string | undefined> = process.env): { on: boolean; model: string; route: AiRoute } {
  const route = aiRoute(env);
  return { on: aiSortingEnabled(env), model: route === "anthropic" ? AI_MODEL_DIRECT : AI_MODEL, route };
}
