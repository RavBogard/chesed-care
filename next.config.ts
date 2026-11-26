import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Request URLs can carry auth state; keep them out of framework request logs.
  logging: { incomingRequests: false },
  // The Content-Security-Policy needs a fresh nonce per request, so it is set in
  // src/proxy.ts (src/server/security/csp.ts), not here.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
      {
        // The notification worker: served from the root so its scope is the whole app, never cached by the
        // browser or a CDN so an update reaches every device, and held to a policy of its own (it needs nothing
        // but itself). The proxy skips this path, so these are the only headers it carries.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
