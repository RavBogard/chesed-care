import { renderToStaticMarkup } from "react-dom/server";
import AdminPage from "@/app/settings/admin/page";
import SettingsPage from "@/app/settings/page";

/**
 * Settings and, for those who have one, Admin: the markup of both pages together, so a check of "who is shown what"
 * covers everything Settings held before it was split. Someone with nothing on Admin is sent back to Settings, which
 * reads here as no Admin markup at all.
 */
export async function settingsAndAdmin(): Promise<string> {
  const mine = renderToStaticMarkup(await SettingsPage());
  try {
    return mine + renderToStaticMarkup(await AdminPage());
  } catch (error) {
    // The real redirect carries a NEXT_REDIRECT digest; some files mock next/navigation to throw "redirect:<path>".
    const e = error as { digest?: unknown; message?: unknown };
    if (String(e.digest).includes("NEXT_REDIRECT") || String(e.message).startsWith("redirect:")) return mine;
    throw error;
  }
}
