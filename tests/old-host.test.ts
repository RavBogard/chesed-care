import { describe, expect, it } from "vitest";
import { oldHostRedirect } from "@/server/security/old-host";

const OLD = "crc-care.vercel.app";

describe("the old address", () => {
  it("sends ordinary paths, with their query, to the new address", () => {
    expect(oldHostRedirect(OLD, "/")).toBe("https://care.centralreform.org/");
    expect(oldHostRedirect(OLD, "/v/abc123", "?evening=1")).toBe("https://care.centralreform.org/v/abc123?evening=1");
    expect(oldHostRedirect("CRC-Care.vercel.app:443", "/inbox")).toBe("https://care.centralreform.org/inbox");
    expect(oldHostRedirect(OLD, "/api/health")).toBe("https://care.centralreform.org/api/health");
    expect(oldHostRedirect(OLD, "/api/authorize-not")).not.toBeNull();
  });

  it("keeps sign-in, the connector, discovery files and the schedule on the old address", () => {
    for (const path of ["/api/auth/callback/google", "/api/auth", "/api/mcp", "/api/mcp/sse", "/oauth/consent", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/api/mcp", "/api/cron/daily", "/API/AUTH/callback"]) {
      expect(oldHostRedirect(OLD, path), path).toBeNull();
    }
  });

  it("leaves the new address, preview hosts and a missing host alone", () => {
    for (const host of ["care.centralreform.org", "crc-care-git-v2-some-team.vercel.app", "crc-care-abc123-some-team.vercel.app", "evil-crc-care.vercel.app", "localhost:3000", null, undefined, ""]) {
      expect(oldHostRedirect(host, "/inbox"), String(host)).toBeNull();
    }
  });
});
