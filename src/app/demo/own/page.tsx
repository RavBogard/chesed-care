import { notFound } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { ShulMark } from "@/components/shul-mark";
import { btnPrimary, btnText } from "@/components/ui";
import { APP_NAME } from "@/lib/brand";
import { isDemo } from "@/lib/demo";
import { GUIDE_URL, OWN_PROMPT, PROJECT_NAME, REPO_URL } from "@/lib/make-it-yours";

export const metadata = { title: "Make it your own · Beit Dugma Care" };

const NEED = [
  ["An assistant that can do the work", "Claude or ChatGPT. Claude Code or Cowork is best, because it can set things up itself instead of telling you what to click."],
  ["A few free accounts", "One where the code is kept, one that runs the app, and a database. Your assistant explains each and makes them with you. You do not need any of them yet."],
  ["Your membership list", "The app reads names, phone numbers, birthdays and yahrzeits from the congregation's own database and never changes it. Ours is Salesforce. There is no ready-made connection to ShulCloud or the others yet, so you and your assistant build that part, and we would be glad to have it back to share."],
  ["Someone who can say yes", "Before real people's names go in, your senior rabbi or board should know where the information will live and who can sign in."],
] as const;

const card = "rounded-lg border border-rule bg-surface p-4";
const h2 = "font-serif text-xl font-bold text-ink";

/** The demo's "make it your own" page: what a congregation needs, and one request to paste into their own assistant. */
export default function OwnPage() {
  if (!isDemo()) notFound();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-shell text-on-shell">
        <div className="mx-auto flex min-h-14 w-full max-w-xl items-center px-4 py-2 lg:max-w-3xl lg:px-8">
          <h1 className="flex min-w-0 items-center gap-2 break-words font-serif text-[1.375rem] font-bold leading-tight">
            <ShulMark size={28} />
            {APP_NAME}
          </h1>
        </div>
      </header>
      <main id="main" className="mx-auto flex w-full max-w-xl flex-col gap-8 px-4 py-6 lg:max-w-3xl lg:px-8 lg:py-10">
        <section className="flex flex-col gap-3">
          <h2 className="font-serif text-2xl font-bold text-ink">Make it your own</h2>
          <p className="text-lg text-ink">
            The code behind this demo is called {PROJECT_NAME}, and it is free for any congregation to copy and change. You do not need to be a programmer: you hand the job to your own Claude or
            ChatGPT, and it walks you through it.
          </p>
          <p className="text-rubric">
            It was built for one congregation and is shared as it is. There is no setup wizard and nobody to call. Expect an hour to get your own
            demo running, and real work after that to connect your members.
          </p>
        </section>

        <section aria-labelledby="paste" className={`${card} flex flex-col gap-3`}>
          <h2 id="paste" className={h2}>
            Give this to your assistant
          </h2>
          <p className="text-ink">Copy it, open a new chat, and paste. It points your assistant at a guide written for it.</p>
          <pre data-testid="own-prompt" className="whitespace-pre-wrap break-words rounded-md bg-tint p-3 font-sans text-sm text-ink">
            {OWN_PROMPT}
          </pre>
          <CopyButton text={OWN_PROMPT} label="Copy" className={btnPrimary} failed="Could not copy. Select the text and copy it by hand." />
        </section>

        <section aria-labelledby="need" className="flex flex-col gap-3">
          <h2 id="need" className={h2}>
            What you will need
          </h2>
          <ul className="flex flex-col gap-3">
            {NEED.map(([title, body]) => (
              <li key={title} className={card}>
                <p className="font-semibold text-ink">{title}</p>
                <p className="mt-1 text-sm text-ink">{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="cost" className="flex flex-col gap-3">
          <h2 id="cost" className={h2}>
            What it costs
          </h2>
          <p className="text-ink">
            The code is free. The services that run it have free plans that are enough to try it; a congregation using it every day may pay a
            small monthly fee to them. Your assistant will tell you before anything costs money.
          </p>
        </section>

        <section aria-labelledby="read" className="flex flex-col gap-1">
          <h2 id="read" className={h2}>
            If you would rather read first
          </h2>
          <a href={GUIDE_URL} className={btnText}>
            The guide your assistant will follow
          </a>
          <a href={REPO_URL} className={btnText}>
            The code
          </a>
          <a href="/demo" className={btnText}>
            Back to the demo
          </a>
        </section>

        <footer className="border-t border-rule pt-4 text-sm text-rubric">
          A project of Rabbi Daniel Bogard. Built for the clergy of Central Reform Congregation in St. Louis, and shared so other congregations
          can use it.
        </footer>
      </main>
    </div>
  );
}
