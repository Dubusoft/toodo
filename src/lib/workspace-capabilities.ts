import type { CheckKind, CompletionMode, Workspace } from "@/lib/bindings";

/**
 * What the tasks of a workspace have, from its source, completion, and runner. Task views
 * show only what applies; a GitHub workspace whose pull request merges complete its tasks
 * and whose tasks herdr runs has everything, as every workspace did before the axes.
 */
export type WorkspaceCapabilities = {
  /** The location is a git repository with a base branch. */
  git: boolean;
  /** The repository is on GitHub, so tasks can link its issues. */
  github: boolean;
  /** herdr runs started tasks on a branch in a worktree, so starting a task needs herdr. */
  herdr: boolean;
  /**
   * Toodo itself runs Claude or Codex on the worktree of a started task (runner plain): the
   * runs of the task, started and stopped in its details.
   */
  plainRuns: boolean;
  /** Task branches ship as GitHub pull requests: Open PR, Push to PR, and their state. */
  pullRequests: boolean;
  /** A merge completes tasks: "Done when merged" and the agent merge setting. */
  merge: boolean;
  /** Criterion kinds the criteria editor offers; the merge criterion comes from "Done when merged". */
  criterionKinds: CheckKind[];
};

/** Kinds the server accepts besides the merge criterion, by workspace completion. */
const criterionKinds: Record<CompletionMode, CheckKind[]> = {
  manual: ["manual", "url", "command"],
  local_merge: ["manual", "url", "command"],
  pr_merge: ["manual", "url", "command", "pr_open_ci_green"],
};

/**
 * The capabilities of `workspace`. A workspace that is not loaded (yet) gets them all, so
 * its tasks render as they did before the axes.
 */
export function workspaceCapabilities(
  workspace: Pick<Workspace, "source" | "completion" | "runner"> | undefined,
): WorkspaceCapabilities {
  const { source, completion, runner } = workspace ?? { source: "github", completion: "pr_merge", runner: "herdr" };
  return {
    git: source !== "none",
    github: source === "github",
    herdr: runner === "herdr",
    plainRuns: runner === "plain",
    pullRequests: source === "github" && runner !== "none",
    merge: completion !== "manual",
    criterionKinds: criterionKinds[completion],
  };
}
