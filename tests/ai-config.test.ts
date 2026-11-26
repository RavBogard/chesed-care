import { describe, expect, it } from "vitest";
import { AI_MODEL, AI_MODEL_DIRECT, aiModel, aiRoute, aiSortingStatus } from "@/server/care/ai-config";

describe("which way the model is reached", () => {
  it("goes through the gateway when the congregation has set no key of its own", () => {
    expect(aiRoute({})).toBe("gateway");
    expect(aiRoute({ ANTHROPIC_API_KEY: "   " })).toBe("gateway");
    expect(aiModel({})).toBe(AI_MODEL);
    expect(aiSortingStatus({ VERCEL_ENV: "production" })).toEqual({ on: true, model: AI_MODEL, route: "gateway" });
  });

  it("calls Anthropic directly when the congregation's own key is set", () => {
    const env = { ANTHROPIC_API_KEY: "test-key-not-real", VERCEL_ENV: "production" };
    expect(aiRoute(env)).toBe("anthropic");
    const model = aiModel(env);
    expect(typeof model).toBe("object");
    expect((model as { modelId: string }).modelId).toBe(AI_MODEL_DIRECT);
    expect(aiSortingStatus(env)).toEqual({ on: true, model: AI_MODEL_DIRECT, route: "anthropic" });
  });

  it("a key does not switch the reading on where it is off", () => {
    expect(aiSortingStatus({ ANTHROPIC_API_KEY: "test-key-not-real" }).on).toBe(false);
    expect(aiSortingStatus({ ANTHROPIC_API_KEY: "test-key-not-real", VERCEL_ENV: "production", CARE_AI_SORTING: "off" }).on).toBe(false);
  });
});
