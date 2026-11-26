import { AppShell } from "@/components/shell/app-shell";
import { noticeClass } from "@/components/ui";
import { EMPTY_TASK, TaskForm, type TaskValues } from "@/components/volunteers/task-form";
import type { KindKey } from "@/lib/volunteers-wording";
import { canLinkVolunteerTaskToCareItem, canPostVolunteerTasks } from "@/server/access/policy";
import { actorOrRedirect } from "@/server/auth/page-actor";
import { getViewer } from "@/server/auth/session";
import { loadVisibleCareItemAccess } from "@/server/care/care-items";
import { listMySteps } from "@/server/volunteers/home";
import { getDb } from "@/server/db/client";
import { addressSuggestion } from "@/server/care/person-address";
import { getSalesforce } from "@/server/salesforce";
import { chicagoToday } from "@/server/lifecycle/window";

export const dynamic = "force-dynamic";
export const metadata = { title: "Post a task · CRC Care" };

/** The kind a step's title most likely means; the poster changes it if not. */
function kindOf(title: string): KindKey {
  const t = title.toLowerCase();
  if (t.includes("minyan")) return "shiva_minyan";
  if (t.includes("deliver")) return "delivery";
  if (t.includes("dog") || t.includes("pet")) return "pet_care";
  if (t.includes("tech") || t.includes("computer")) return "tech_help";
  if (t.includes("meal")) return "meal";
  // After "meal": a "shiva meal" is a meal.
  if (t.includes("shiva")) return "shiva_help";
  if (t.includes("ride")) return "ride";
  if (t.includes("visit")) return "visit";
  if (t.includes("call")) return "call";
  return "other";
}

/**
 * Post a task. Two ways in with something filled: a lead's "for Mitzvah Corps" step (`step`: the kind its title
 * suggests and its date, nothing public) and a care item (`careItem`: linked, never shown
 * to volunteers). Nothing else of either is copied.
 */
export default async function NewVolunteerTaskPage({ searchParams }: { searchParams: Promise<{ step?: string; careItem?: string }> }) {
  const actor = actorOrRedirect(await getViewer(), { reporter: true });
  if (!canPostVolunteerTasks(actor)) {
    return (
      <AppShell actor={actor} title="Post a task">
        <p className={noticeClass}>You do not have access to post volunteer tasks.</p>
      </AppShell>
    );
  }
  const q = await searchParams;
  const today = chicagoToday(new Date());
  const db = getDb();
  let values: TaskValues = { ...EMPTY_TASK };
  let careItemId: string | undefined;
  let careName: string | null = null;
  let suggestion: string | null = null;
  let problem = false;
  let fromNote = false;
  try {
    if (q.step) {
      const step = (await listMySteps(db, actor)).find((s) => s.id === q.step);
      if (!step) throw new Error("no step");
      // The kind and the date; who it is for is typed by the lead. What is needed starts from the clergy's note (never from the care item).
      // The clergy's logistics-only line, when there is one, is the starting text: the lead reads it, edits it and posts it, so it is theirs to change before anyone else sees it.
      values = { ...values, kind: kindOf(step.title), date: step.dueDate >= today ? step.dueDate : "", needed: step.corpsNote ?? "" };
      fromNote = step.corpsNote !== null;
    }
    if (q.careItem) {
      const { item, access } = await loadVisibleCareItemAccess(db, actor, q.careItem);
      if (!canLinkVolunteerTaskToCareItem(actor, access)) throw new Error("hidden");
      careItemId = item.id;
      careName = item.displayName;
      suggestion = await addressSuggestion({ db, sf: getSalesforce, now: new Date() }, actor, { sfContactId: item.sfContactId, outsidePersonId: item.outsidePersonId });
      values = { ...values, forLabel: values.forLabel || (item.displayName ?? "").split(/\s+/)[0] };
    }
  } catch {
    problem = true;
  }
  return (
    <AppShell actor={actor} title="Post a task">
      {problem ? <p className={`${noticeClass} mb-5`}>That step or person could not be found, so nothing is filled in. You can still post a task below.</p> : null}
      {fromNote ? (
        <p className="mb-5 text-base" data-testid="from-note">
          Started from the clergy&rsquo;s note for Mitzvah Corps. Volunteers will see whatever is in this box.
        </p>
      ) : null}
      {careName ? <p className="mb-5 text-sm text-rubric">Linked to {careName}&rsquo;s care item, so the clergy who see it see this task there. Volunteers never see the link.</p> : null}
      <TaskForm values={values} today={today} careItemId={careItemId} addressSuggestion={suggestion} />
    </AppShell>
  );
}
