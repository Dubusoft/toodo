import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { compactSelectClass, inputClass } from "@/components/workspace-list";
import type { CheckKind, Criterion, CriterionId, CriterionInput, TaskId } from "@/lib/bindings";
import { cn } from "@/lib/utils";
import { type WorkspaceCapabilities } from "@/lib/workspace-capabilities";


export const criterionKindLabels: Record<CheckKind, string> = {
  manual: "Manual",
  url: "URL responds",
  command: "Command succeeds",
  pr_open_ci_green: "PR open with green CI",
  pr_merged: "PR merged",
  branch_merged_locally: "Merged locally",
};

/** Kinds of the merge criterion, of which a task has at most one. */
export function isMergeKind(kind: CheckKind): boolean {
  return kind === "pr_merged" || kind === "branch_merged_locally";
}

/** Kinds checked against a target their author gives: the URL to fetch or the command to run. */
export function takesTarget(kind: CheckKind): boolean {
  return kind === "url" || kind === "command";
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
  // The target of a merged-locally criterion is the commit Toodo found, not one to edit.
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
  if (draft.kind === "command" && target === "") return "Enter the command to run";
  return null;
}

/**
 * The completion criteria of a new or an edited task: one row per criterion with what has
 * to hold, how it is checked, and the URL or command a check runs against. In the edit form
 * of a task, `taskId` ends the labels with ` of #id`.
 */
export function CriteriaEditor({
  criteria,
  capabilities,
  onChange,
  taskId,
}: {
  criteria: CriterionDraft[];
  /**
   * What the task's workspace has, which decides the kinds offered. The merge criterion
   * comes from "Done when merged" in the new and edit forms and keeps its kind when the
   * task is edited.
   */
  capabilities: WorkspaceCapabilities;
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
            const fixedKind = !capabilities.criterionKinds.includes(draft.kind);
            return (
              // Below md each criterion is a block: its text on the first line, kind and remove on the next.
              <li
                key={draft.key}
                className="flex flex-wrap items-center gap-1 max-md:grid max-md:grid-cols-[1rem_1fr_auto] max-md:gap-2 max-md:rounded-lg max-md:border max-md:p-2"
              >
                <span aria-hidden className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {n}
                </span>
                <input
                  className={cn(inputClass, "h-7 flex-1 basis-48 max-md:col-span-2")}
                  aria-label={`Criterion ${n} text${of}`}
                  placeholder="What has to hold, e.g. Docs updated"
                  value={draft.text}
                  onChange={(e) => update(draft.key, { text: e.target.value })}
                  autoFocus={draft.key === addedKey}
                />
                <select
                  aria-label={`Criterion ${n} kind${of}`}
                  className={cn(compactSelectClass, "h-7 max-md:col-start-2 max-md:row-start-2")}
                  value={draft.kind}
                  disabled={fixedKind}
                  title={fixedKind ? "The merge criterion keeps its kind" : "How the criterion is checked"}
                  onChange={(e) => update(draft.key, { kind: e.target.value as CheckKind })}
                >
                  {(fixedKind ? [draft.kind] : capabilities.criterionKinds).map((kind) => (
                    <option key={kind} value={kind}>
                      {criterionKindLabels[kind]}
                    </option>
                  ))}
                </select>
                {takesTarget(draft.kind) && (
                  <input
                    className={cn(
                      inputClass,
                      "h-7 flex-1 basis-40 font-mono max-md:col-span-2 max-md:col-start-2 max-md:row-start-3 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
                    )}
                    aria-label={`Criterion ${n} target${of}`}
                    aria-invalid={problem !== null}
                    title={
                      problem ??
                      (draft.kind === "url"
                        ? "Toodo checks that a GET of this URL succeeds"
                        : capabilities.herdr
                          ? "Toodo checks that this command exits with 0 in the task worktree"
                          : "Toodo checks that this command exits with 0 in the workspace directory")
                    }
                    placeholder={draft.kind === "url" ? "https://example.com/health" : "npm test"}
                    value={draft.target}
                    onChange={(e) => update(draft.key, { target: e.target.value })}
                  />
                )}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove criterion ${n}${of}`}
                  title="Remove criterion"
                  className="max-md:col-start-3 max-md:row-start-2"
                  onClick={() => onChange(criteria.filter((other) => other.key !== draft.key))}
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="self-start"
        aria-label={taskId === undefined ? undefined : `Add criterion to #${taskId}`}
        onClick={add}
      >
        <Plus />
        Add criterion
      </Button>
    </div>
  );
}
