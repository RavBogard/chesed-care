import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { SHELL } from "@/lib/brand";
import { frankRuhl, publicSans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "CRC Care",
  description: "Pastoral care for the clergy of Central Reform Congregation",
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: "CRC Care", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: SHELL,
  viewportFit: "cover",
};

// Every page renders per request, so each gets the CSP nonce from src/proxy.ts
// (a page prerendered at build time would carry scripts without one).
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return (
    <html lang="en" className={`${frankRuhl.variable} ${publicSans.variable}`}>
      <body className="min-h-dvh bg-ground font-sans text-ink antialiased">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:border focus:border-control focus:bg-surface focus:px-4 focus:py-3 focus:text-ink">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
