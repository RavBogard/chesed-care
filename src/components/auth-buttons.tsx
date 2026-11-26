"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { btnPrimary, btnText } from "./ui";

// The plugin carries a connector's signed authorization request (in this page's URL) through sign-in,
// so signing in from Claude continues to the consent page.
const authClient = createAuthClient({ plugins: [oauthProviderClient()] });

export function GoogleSignInButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await authClient.signIn.social({ provider: "google", callbackURL: "/", errorCallbackURL: "/not-authorised" });
        setBusy(false);
      }}
      className={`${btnPrimary} w-full text-base`}
    >
      {busy ? "Opening Google…" : "Sign in with Google"}
    </button>
  );
}

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await authClient.signOut();
        router.replace("/sign-in");
        router.refresh();
      }}
      className={className ?? btnText}
    >
      Sign out
    </button>
  );
}
