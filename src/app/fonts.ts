import { Frank_Ruhl_Libre, Public_Sans } from "next/font/google";

/**
 * The two faces. next/font downloads them at build time and serves them from this origin,
 * so no page asks Google for anything and the Content-Security-Policy stays at font-src 'self'.
 */

/** Names, titles and all Hebrew. */
export const frankRuhl = Frank_Ruhl_Libre({
  subsets: ["latin", "hebrew"],
  variable: "--font-frank-ruhl",
  display: "swap",
  fallback: ["Times New Roman", "David", "Arial Hebrew", "Georgia", "serif"],
});

/** Everything else. */
export const publicSans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-public-sans",
  display: "swap",
  fallback: ["system-ui", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
});
