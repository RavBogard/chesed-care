import { afterEach, describe, expect, it, vi } from "vitest";

const neonCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@neondatabase/serverless", async (importOriginal) => {
  const real = await importOriginal<typeof import("@neondatabase/serverless")>();
  return {
    ...real,
    neon: (...args: Parameters<typeof real.neon>) => {
      neonCalls.count++;
      return real.neon(...args);
    },
  };
});

const { GET } = await import("@/app/api/health/route");

const TOKEN = "health-token-for-tests-0123456789";
const request = (token?: string) => new Request("http://localhost/api/health", token === undefined ? {} : { headers: { "x-health-token": token } });

afterEach(() => {
  vi.unstubAllEnvs();
  neonCalls.count = 0;
});

describe("/api/health", () => {
  it("by default answers 200 without touching the database", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@127.0.0.1:1/none");
    vi.stubEnv("HEALTH_TOKEN", TOKEN);
    for (const req of [request(), request("wrong-token"), request(`${TOKEN}x`), request("")]) {
      const res = await GET(req);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, database: "not_checked" });
    }
    expect(neonCalls.count).toBe(0);
  });

  it("never checks the database when HEALTH_TOKEN is not set, whatever the header", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@127.0.0.1:1/none");
    vi.stubEnv("HEALTH_TOKEN", "");
    expect(await (await GET(request(""))).json()).toMatchObject({ database: "not_checked" });
    expect(await (await GET(request("anything"))).json()).toMatchObject({ database: "not_checked" });
    expect(neonCalls.count).toBe(0);
  });

  it("with the right token, reports reachability and still answers 200 when it fails", async () => {
    vi.stubEnv("HEALTH_TOKEN", TOKEN);
    vi.stubEnv("DATABASE_URL", "");
    expect(await (await GET(request(TOKEN))).json()).toMatchObject({ ok: true, database: "not_configured" });

    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@127.0.0.1:1/none");
    const res = await GET(request(TOKEN));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.database).toBe("unreachable");
    expect(neonCalls.count).toBe(1);
    expect(JSON.stringify(body)).not.toContain("pw");
  });
});
