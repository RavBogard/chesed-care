import type { ActionState } from "@/lib/action-state";
import { ActionForm } from "@/components/action-form";
import { btnQuiet, inputClass, labelClass } from "@/components/ui";

/** "Give to" a chosen person: one select and one button, wired to a server action that takes `idField` and `ownerUserId`. */
export function ReassignForm({
  action,
  idField,
  id,
  holders,
  label,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  idField: "careItemId" | "followUpId";
  id: string;
  holders: { id: string; name: string }[];
  label: string;
}) {
  const field = `give-${id}`;
  return (
    <ActionForm action={action} className="mt-2 flex flex-wrap items-end gap-2" closeSheetOnOk={false}>
      <input type="hidden" name={idField} value={id} />
      <div className="min-w-0 flex-1 basis-48">
        <label htmlFor={field} className={labelClass}>
          {label}
        </label>
        <select id={field} name="ownerUserId" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            Choose someone
          </option>
          {holders.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className={btnQuiet}>
        Give
      </button>
    </ActionForm>
  );
}
