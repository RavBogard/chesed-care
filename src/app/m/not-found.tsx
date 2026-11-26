import { publicMetadata } from "@/components/public-meta";
import { PublicNotFound } from "@/components/public-not-found";
import { refusalMessage } from "@/lib/meals-wording";

export const metadata = publicMetadata("Mitzvah Meals");

/** An unknown, mistyped or purged link: it says so kindly, and says nothing about whether a page ever existed. */
export default function MealsNotFound() {
  return <PublicNotFound title="Mitzvah Meals" message={refusalMessage("not_found")} />;
}
