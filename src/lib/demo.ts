/**
 * The demo build: the same app with invented people, for showing to other congregations.
 * It is switched on by NEXT_PUBLIC_CARE_DEMO=on, which Next.js fixes into the build, so a
 * deployment is a demo or it is not; nothing at run time turns one into the other.
 * Plain data, safe for server and browser code alike. See docs/DEMO.md.
 */
export const isDemo = () => process.env.NEXT_PUBLIC_CARE_DEMO === "on";

/** Every demo account's address ends with this. `.invalid` can never receive mail or sign in anywhere. */
export const DEMO_EMAIL_DOMAIN = "@beitdugma.invalid";

/** The cookie that says who the visitor is being. It holds a persona key and nothing else. */
export const DEMO_COOKIE = "demo_persona";

export const DEMO_PERSONAS = [
  { key: "rabbi", name: "Rabbi Miriam Adler", role: "owner", title: "Senior rabbi", blurb: "Everything: today's dates, the care list, the Inbox, the team, and her own restricted items." },
  { key: "rabbi2", name: "Rabbi Jonah Feld", role: "clergy", title: "Associate rabbi", blurb: "The same tools, his own care list. See what a colleague's restricted item looks like from outside." },
  { key: "lead", name: "Ellen Brody", role: "lead", title: "Mitzvah Corps lead", blurb: "Volunteers, meals, the visiting list and what the rabbis referred. Never a diagnosis or a note." },
  { key: "office", name: "Sam Ortiz", role: "staff", title: "Front office", blurb: "Reports a need in ten seconds and sees that it was picked up. Nothing else." },
  { key: "director", name: "Dana Weiss", role: "senior_staff", title: "Executive director", blurb: "The numbers without the names: how much care is happening, never for whom." },
] as const;

export type DemoPersona = (typeof DEMO_PERSONAS)[number];
export type DemoPersonaKey = DemoPersona["key"];

export const demoEmail = (key: DemoPersonaKey) => `${key}${DEMO_EMAIL_DOMAIN}`;

export function demoPersona(key: unknown): DemoPersona | null {
  return DEMO_PERSONAS.find((p) => p.key === key) ?? null;
}
