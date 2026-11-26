import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Hebrew } from "@/components/hebrew";
import {
  btnPrimary,
  btnQuiet,
  facingLine,
  inputClass,
  noticeClass,
} from "@/components/ui";
import { APP_NAME, CONGREGATION_NAME } from "@/lib/brand";
import { DEMO_PERSONAS, isDemo } from "@/lib/demo";
import { hebrewDate } from "@/lib/hebrew-date";
import { chicagoToday } from "@/server/lifecycle/window";
import { DEMO_GATE_COOKIE, demoGateOpen } from "@/server/demo/gate";
import { enterDemo, startDemoOver, unlockDemo } from "./actions";

export const metadata = { title: "Beit Dugma Care · a demo" };
export const dynamic = "force-dynamic";

const TRY = [
  [
    "Send a birthday text",
    "On Today, tap Text on Ruth Friedman's birthday. Your own Messages app opens with a draft; one more tap marks it done for the whole team.",
  ],
  [
    "Accept something from the Inbox",
    "A death, a birth, a call to the office and a note from a worried sister are waiting. Nothing reaches the care list until a rabbi says so.",
  ],
  [
    "Look at a restricted item from outside",
    "As Rabbi Feld, find Aaron Goldberg. You see that he is in Rabbi Adler's care, and nothing more.",
  ],
  [
    "Refer someone to Mitzvah Corps",
    "As a rabbi, open Bella Mendel. Then switch to Ellen and see exactly what she was told: what help is needed, never why.",
  ],
] as const;

const card = "rounded-lg border border-rule bg-surface p-4";
const h2 = "font-serif text-xl font-bold text-ink";

/** The demo's front door: what this is, and a choice of who to be. There is no sign-in. */
export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<{ fresh?: string; code?: string }>;
}) {
  if (!isDemo()) notFound();
  const query = await searchParams;
  const fresh = query.fresh === "1";
  const open = demoGateOpen((await cookies()).get(DEMO_GATE_COOKIE)?.value);
  const today = hebrewDate(chicagoToday(new Date()));
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-shell text-on-shell">
        <div className="mx-auto flex min-h-14 w-full max-w-xl items-center px-4 py-2 lg:max-w-3xl lg:px-8">
          <div className={`${facingLine} min-w-0 flex-1`}>
            <h1 className="min-w-0 break-words font-serif text-[1.375rem] font-bold leading-tight">
              {APP_NAME}
            </h1>
            {today ? (
              <Hebrew size="text-[1.375rem]" className="text-on-shell-muted">
                {today}
              </Hebrew>
            ) : null}
          </div>
        </div>
      </header>
      <main
        id="main"
        className="mx-auto flex w-full max-w-xl flex-col gap-8 px-4 py-6 lg:max-w-3xl lg:px-8 lg:py-10"
      >
        {fresh ? (
          <p
            role="status"
            className="rounded-md border border-rule bg-tint px-4 py-3 text-ink"
          >
            The demo is back to its starting story.
          </p>
        ) : null}

        <section className="flex flex-col gap-3">
          <p className="text-lg text-ink">
            A pastoral care app for clergy, made to be used on a phone between
            other things. It does two jobs: it shows whose yahrzeit, shloshim,
            birthday or anniversary is today so you can text them, and it keeps
            track of who needs care, who has them, and what is due.
          </p>
          <p className="text-rubric">
            This is a demo. {CONGREGATION_NAME} and everyone in it are invented,
            and every phone number is fictional. Nothing you do here sends an
            email, a text or a notification.
          </p>
        </section>

        {open ? null : (
          <section
            aria-labelledby="code"
            className={`${card} flex flex-col gap-3`}
          >
            <h2 id="code" className={h2}>
              Enter the access code
            </h2>
            <p className="text-ink">
              The code came with the link you were sent.
            </p>
            {query.code === "wrong" ? (
              <p role="alert" className={noticeClass}>
                That is not the code. Please check it and try again.
              </p>
            ) : null}
            <form action={unlockDemo} className="flex flex-col gap-3">
              <label
                htmlFor="demo-code"
                className="text-sm font-semibold text-ink"
              >
                Access code
              </label>
              <input
                id="demo-code"
                name="code"
                type="text"
                required
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={200}
                className={inputClass}
              />
              <button type="submit" className={btnPrimary}>
                Continue
              </button>
            </form>
          </section>
        )}

        {open ? (
          <>
            <section aria-labelledby="who" className="flex flex-col gap-3">
              <h2 id="who" className={h2}>
                Choose who to be
              </h2>
              <p className="text-rubric">
                Each person sees a different amount. Come back here to switch.
              </p>
              <ul className="grid gap-3 lg:grid-cols-2">
                {DEMO_PERSONAS.map((p) => (
                  <li key={p.key} className={`${card} flex flex-col gap-3`}>
                    <div>
                      <p className="text-base font-semibold text-ink">
                        {p.name}
                      </p>
                      <p className="text-sm text-rubric">{p.title}</p>
                    </div>
                    <p className="text-sm text-ink">{p.blurb}</p>
                    <form action={enterDemo} className="mt-auto">
                      <input type="hidden" name="persona" value={p.key} />
                      <button
                        type="submit"
                        className={`${p.key === "rabbi" ? btnPrimary : btnQuiet} w-full`}
                      >
                        Enter as {p.name}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="try" className="flex flex-col gap-3">
              <h2 id="try" className={h2}>
                Four things to try
              </h2>
              <ol className="flex flex-col gap-3">
                {TRY.map(([title, body], i) => (
                  <li key={title} className={card}>
                    <p className="font-semibold text-ink">
                      {i + 1}. {title}
                    </p>
                    <p className="mt-1 text-sm text-ink">{body}</p>
                  </li>
                ))}
              </ol>
            </section>

            <section aria-labelledby="public" className="flex flex-col gap-3">
              <h2 id="public" className={h2}>
                What congregants see
              </h2>
              <p className="text-ink">
                Congregants and volunteers have no account. They use plain pages
                like these:
              </p>
              <ul className="flex flex-col gap-1">
                <li>
                  <a
                    href="/tell"
                    className="inline-flex min-h-11 items-center font-medium text-action underline underline-offset-4 hover:text-action-strong"
                  >
                    Let the clergy know about someone
                  </a>
                </li>
                <li>
                  <a
                    href="/join"
                    className="inline-flex min-h-11 items-center font-medium text-action underline underline-offset-4 hover:text-action-strong"
                  >
                    Join Mitzvah Corps
                  </a>
                </li>
              </ul>
              <p className="text-sm text-rubric">
                As Ellen, open the Levy family&apos;s meal page or a volunteer
                task and copy its link to see the page a helper gets.
              </p>
            </section>

            <section aria-labelledby="own" className={`${card} flex flex-col gap-3`}>
              <h2 id="own" className={h2}>
                Want this for your congregation?
              </h2>
              <p className="text-ink">
                The code is free to copy and change. You hand the job to your
                own Claude or ChatGPT, and it walks you through it.
              </p>
              <a href="/demo/own" data-testid="own-link" className={btnQuiet}>
                Make it your own
              </a>
            </section>

            <section aria-labelledby="about" className="flex flex-col gap-3">
              <h2 id="about" className={h2}>
                Good to know
              </h2>
              <ul className="flex list-disc flex-col gap-2 pl-5 text-ink">
                <li>
                  Everyone who has this link shares one sandbox, so you may see
                  what another visitor added. Please do not type the names of
                  real people.
                </li>
                <li>It goes back to its starting story every night.</li>
                <li>
                  The real app reads members, households and dates from the
                  congregation&apos;s own database and never writes to it. Here
                  it reads an invented one.
                </li>
                <li>
                  The real app also connects to Claude, so a rabbi can ask
                  &ldquo;who needs me today?&rdquo; or dictate a note. That is
                  switched off in the demo.
                </li>
              </ul>
              <details className={card}>
                <summary className="flex min-h-11 cursor-pointer items-center font-medium text-ink">
                  Start over now
                </summary>
                <p className="mt-2 text-sm text-ink">
                  This puts the starting story back for every visitor, and
                  removes whatever anyone has added today.
                </p>
                <form action={startDemoOver} className="mt-3">
                  <button type="submit" className={btnQuiet}>
                    Yes, start over
                  </button>
                </form>
              </details>
            </section>
          </>
        ) : null}

        <footer className="border-t border-rule pt-4 text-sm text-rubric">
          A project of Rabbi Daniel Bogard. Built for the clergy of Central
          Reform Congregation in St. Louis, and
          shared so other congregations can see what it does.{" "}
          <a
            href="/demo/own"
            className="font-medium text-action underline underline-offset-4 hover:text-action-strong"
          >
            Make it your own
          </a>
        </footer>
      </main>
    </div>
  );
}
