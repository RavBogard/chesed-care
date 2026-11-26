/**
 * The two colours needed where CSS cannot reach: the generated app icon, the web manifest
 * and the browser's theme colour. They repeat --color-shell and --color-ground in
 * src/app/globals.css; change them together.
 */
export const SHELL = "#1e2f55";
export const GROUND = "#f3f5f8";

/** The names on the screen. The demo build (src/lib/demo.ts) is an invented congregation. */
const DEMO = process.env.NEXT_PUBLIC_CARE_DEMO === "on";
export const APP_NAME = DEMO ? "Beit Dugma Care" : "CRC Care";
export const CONGREGATION_NAME = DEMO ? "Congregation Beit Dugma" : "Central Reform Congregation";
export const CONGREGATION_SHORT = DEMO ? "Beit Dugma" : "CRC";
