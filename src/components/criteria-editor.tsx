import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button, IconButton } from "@/components/button";
import type { CheckKind, Criterion, CriterionId, CriterionInput, TaskId } from "@/lib/bindings";


export const criterionKindLabels: Record<CheckKind, string> = {
  manual: "Manual",
  url: "URL responds",
};

/** The kinds a criterion can have, in the order the editor offers them. */
const criterionKinds: CheckKind[] = ["manual", "url"];

/** Kinds checked against a target their author gives: the URL to fetch. */
export function takesTarget(kind: CheckKind): boolean {
  return kind === "url";
}

/** A row of the criteria editor; `id` is set for an existing criterion of the edited task. */
export type CriterionDraft = { key: number; id: CriterionId | null; text: string; kind: CheckKind; target: string };

/** Tells editor rows apart, so removing one keeps the values and focus of the others. */
let lastCriterionKey = 0;

/** A new, empty row, or a row holding the existing `criterion`. */
export function criterionDraft(criterion?: Criterion): CriterionDraft {
  lastCriterionKey += 1;
  if (criterion === undefined) {
    return { key: lastCriterionKey, id: null, text: "", kind: "manual", target: "" };
  }
  const target = takesTarget(criterion.kind) ? (criterion.target ?? "") : "";
  return { key: lastCriterionKey, id: criterion.id, text: criterion.text, kind: criterion.kind, target };
}

/** The rows with a text, in order, as the backend takes them; blank rows are left out. */
export function criterionInputs(drafts: CriterionDraft[]): CriterionInput[] {
  return drafts
    .filter((draft) => draft.text.trim() !== "")
    .map((draft) => ({
      ...(draft.id === null ? {} : { id: draft.id }),
      text: draft.text.trim(),
      kind: draft.kind,
      target: takesTarget(draft.kind) ? draft.target.trim() : null,
    }));
}

/** Why the backend would reject the target of a row, or null when it takes it. */
export function targetProblem(draft: CriterionDraft): string | null {
  if (draft.text.trim() === "") return null;
  const target = draft.target.trim();
  if (draft.kind === "url" && !/^https?:\/\/\S*$/.test(target)) return "Enter an http:// or https:// URL";
  return null;
}

/**
 * The completion criteria of a new or an edited task: one row per criterion with what has
 * to hold, how it is checked, and the URL a check fetches. In the edit form
 * of a task, `taskId` ends the labels with ` of #id`.
 */
export function CriteriaEditor({
  criteria,
  onChange,
  taskId,
}: {
  criteria: CriterionDraft[];
  onChange: (criteria: CriterionDraft[]) => void;
  taskId?: TaskId;
}) {
  // The row just added gets the focus.
  const [addedKey, setAddedKey] = useState<number | null>(null);
  const of = taskId === undefined ? "" : ` of #${taskId}`;
  const update = (key: number, change: Partial<CriterionDraft>) =>
    onChange(criteria.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)));

  function add() {
    const draft = criterionDraft();
    setAddedKey(draft.key);
    onChange([...criteria, draft]);
  }

  return (
    <div className="flex flex-col gap-1 max-md:gap-2">
      {criteria.length > 0 && (
        <ol className="flex flex-col gap-1 max-md:gap-2">
          {criteria.map((draft, index) => {
            const n = index + 1;
            const problem = targetProblem(draft);
            return (
              // Below md each criterion is a block: its text on the first line, kind and remove on the next.
              <li
                key={draft.key}
                className="flex flex-wrap items-center gap-1 max-md:grid max-md:grid-cols-[1rem_1fr_auto] max-md:gap-2 max-md:rounded-lg max-md:border max-md:p-2"
              >
                <span aria-hidden className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {n}
                </span>
                <TextInput
                  size="sm"
                  containerClassName="flex-1 basis-48 max-md:col-span-2"
                  label={`Criterion ${n} text${of}`}
                  isLabelHidden
                  placeholder="What has to hold, e.g. Docs updated"
                  value={draft.text}
                  onChange={(text) => update(draft.key, { text })}
                  hasAutoFocus={draft.key === addedKey}
                />
                <span className="max-md:col-start-2 max-md:row-start-2" title="How the criterion is checked">
                  <Selector
                    size="sm"
                    label={`Criterion ${n} kind${of}`}
                    isLabelHidden
                    value={draft.kind}
                    options={criterionKinds.map((kind) => ({ value: kind, label: criterionKindLabels[kind] }))}
                    onChange={(kind) => update(draft.key, { kind: kind as CheckKind })}
                  />
                </span>
                {takesTarget(draft.kind) && (
                  <span
                    className="flex-1 basis-40 max-md:col-span-2 max-md:col-start-2 max-md:row-start-3"
                    title={problem ?? "Toodo checks that a GET of this URL succeeds"}
                  >
                    <TextInput
                      size="sm"
                      controlClassName="font-mono"
                      label={`Criterion ${n} target${of}`}
                      isLabelHidden
                      status={problem === null ? undefined : { type: "error", message: problem }}
                      statusVariant="tooltip"
                      placeholder="https://example.com/health"
                      value={draft.target}
                      onChange={(target) => update(draft.key, { target })}
                    />
                  </span>
                )}
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={`Remove criterion ${n}${of}`}
                  tooltip="Remove criterion"
                  icon={<X />}
                  className="max-md:col-start-3 max-md:row-start-2"
                  onClick={() => onChange(criteria.filter((other) => other.key !== draft.key))}
                />
              </li>
            );
          })}
        </ol>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="self-start"
        label="Add criterion"
        icon={<Plus />}
        aria-label={taskId === undefined ? undefined : `Add criterion to #${taskId}`}
        onClick={add}
      />
    </div>
  );
}
