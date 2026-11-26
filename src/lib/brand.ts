/**
 * The two colours needed where CSS cannot reach: the generated app icon, the web manifest
 * and the browser's theme colour. They repeat --color-shell and --color-ground in
 * src/app/globals.css; change them together.
 */
/** The names on the screen. The demo build (src/lib/demo.ts) is an invented congregation with a look of its own. */
const DEMO = process.env.NEXT_PUBLIC_CARE_DEMO === "on";
/** The demo's plum shell and the gold of its logo. They repeat the html[data-demo] block in globals.css; change them together. */
export const DEMO_SHELL = "#3d2a5c";
export const DEMO_GOLD = "#e9b949";
export const SHELL = DEMO ? DEMO_SHELL : "#1e2f55";
export const GROUND = "#f3f5f8";
export const APP_NAME = DEMO ? "Beit Dugma Care" : "CRC Care";
export const CONGREGATION_NAME = DEMO ? "Congregation Beit Dugma" : "Central Reform Congregation";
export const CONGREGATION_SHORT = DEMO ? "Beit Dugma" : "CRC";
/** Under the invented congregation's name on the demo's front page. Dugma means example; 5786 is the year the demo was made. */
export const DEMO_TAGLINE = "Riverton, Missouri · A house of example since 5786";
