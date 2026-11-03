import type { CompletionMode, RepositorySetup, Runner, Source, WorkspaceLocation } from "@/lib/bindings";
import { isWindowsPath } from "@/lib/paths";

/**
 * What a workspace location holds (source), when its tasks count as done (completion), and
 * what starting a task does (runner), all fixed when the workspace is created. The rules
 * mirror `check_axes`, `check_runner_location`, `default_completion`, and `default_runner` in
 * `src-tauri/src/domain/model.rs`; the server checks them again on creation.
 */
export type Axes = { source: Source; completion: CompletionMode; runner: Runner };

/** How the repository of a git source gets to the workspace location. */
export type RepositoryKind = RepositorySetup["kind"];

/** The axes of a new workspace and how its repository gets to the location; a plain folder has none. */
export type WorkspaceChoice = Axes & { repository: RepositoryKind | null };

/**
 * What was picked for a new workspace, in step order. `null` is not picked yet, or dropped
 * because an earlier pick ruled it out; it follows the default of the earlier picks.
 */
export type Picks = {
  source: Source;
  repository: RepositoryKind | null;
  completion: CompletionMode | null;
  runner: Runner | null;
};

export const sources: readonly Source[] = ["none", "local_git", "github"];
export const completions: readonly CompletionMode[] = ["manual", "local_merge", "pr_merge"];
export const runners: readonly Runner[] = ["herdr", "plain", "tmux", "none"];
export const repositoryKinds: readonly RepositoryKind[] = ["open", "init", "clone"];

export const sourceLabels: Record<Source, string> = {
  none: "Plain folder",
  local_git: "Local git",
  github: "GitHub",
};

export const completionLabels: Record<CompletionMode, string> = {
  manual: "Manual",
  local_merge: "Local merge",
  pr_merge: "PR merge",
};

export const runnerLabels: Record<Runner, string> = {
  none: "No runner",
  herdr: "herdr",
  plain: "Plain",
  tmux: "tmux",
};

export const repositoryLabels: Record<RepositoryKind, string> = {
  open: "Open existing",
  init: "New repository",
  clone: "Clone URL",
};

/** The completion of a new workspace with `source` until another one is picked. */
export function defaultCompletion(source: Source): CompletionMode {
  return source === "none" ? "manual" : source === "local_git" ? "local_merge" : "pr_merge";
}

/** The runner of a new workspace with `source` until another one is picked. */
export function defaultRunner(source: Source): Runner {
  return source === "none" ? "none" : "herdr";
}

/** How the repository of a new workspace with `source` gets to its location until another way is picked. */
export function defaultRepository(source: Source): RepositoryKind | null {
  return source === "none" ? null : "open";
}

/** Why `completion` does not work with `source`, naming the choice that does; `null` when it works. */
export function completionProblem(source: Source, completion: CompletionMode): string | null {
  switch (completion) {
    case "manual":
      return null;
    case "local_merge":
      if (source === "local_git") return null;
      return source === "none"
        ? "Needs a git repository; choose source Local git"
        : "GitHub tasks merge through pull requests; choose source Local git";
    case "pr_merge":
      if (source === "github") return null;
      return source === "none"
        ? "Needs a git repository; choose source GitHub"
        : "Needs a GitHub origin remote; choose source GitHub";
  }
}

/**
 * Why `runner` does not work with `source` and `completion`, naming the choice that does;
 * `null` when it works. A merge needs the task branch that only a runner creates.
 */
export function runnerProblem(source: Source, completion: CompletionMode, runner: Runner): string | null {
  if (runner !== "none" && source === "none") {
    return "Needs a git repository for task worktrees; choose source Local git or GitHub";
  }
  if (runner === "none" && completion !== "manual") {
    return `${completionLabels[completion]} needs the task branch that herdr, ${runnerLabels.plain}, or ${runnerLabels.tmux} creates; choose completion Manual`;
  }
  return null;
}

/**
 * Mirrors `check_runner_location`: why `runner` cannot run the tasks of a workspace at
 * `location`, naming the choice that can; `null` when it can. Runner tmux needs a POSIX host,
 * so an SSH machine whose path is a Windows drive or UNC path rules it out; the other runners
 * work on either kind of host.
 */
export function runnerLocationProblem(
  runner: Runner,
  location: Pick<WorkspaceLocation, "kind" | "path">,
): string | null {
  if (runner === "tmux" && location.kind === "ssh" && isWindowsPath(location.path)) {
    return `Needs a POSIX host; choose ${runnerLabels.plain} or ${runnerLabels.herdr} for a Windows SSH workspace, or choose a POSIX path for ${runnerLabels.tmux}`;
  }
  return null;
}

/** Why the repository `kind` does not work with `source`, naming the choice that does; `null` when it works. */
export function repositoryProblem(source: Source, kind: RepositoryKind): string | null {
  if (source === "none") return "A plain folder has no repository; choose source Local git or GitHub";
  if (source === "github" && kind === "init") return "A new repository has no GitHub origin; choose source Local git";
  return null;
}

/** Mirrors `check_axes`: why the three do not work together, or `null` when they do. */
export function checkAxes({ source, completion, runner }: Axes): string | null {
  return completionProblem(source, completion) ?? runnerProblem(source, completion, runner);
}

/** What `picks` make: each pick that is unset or that an earlier one rules out is the default. */
export function choiceOf(picks: Picks): WorkspaceChoice {
  const { source } = picks;
  const repository =
    picks.repository !== null && repositoryProblem(source, picks.repository) === null
      ? picks.repository
      : defaultRepository(source);
  const completion =
    picks.completion !== null && completionProblem(source, picks.completion) === null
      ? picks.completion
      : defaultCompletion(source);
  const runner =
    picks.runner !== null && runnerProblem(source, completion, picks.runner) === null ? picks.runner : defaultRunner(source);
  return { source, repository, completion, runner };
}

/**
 * `picks` with `change` applied. A later pick that the change rules out is dropped, so it
 * resets to its default and stays there until it is picked again; a later pick that was
 * never made follows the defaults of the new earlier picks.
 */
export function withPick(picks: Picks, change: Partial<Picks>): Picks {
  const next = { ...picks, ...change };
  const choice = choiceOf(next);
  return {
    source: next.source,
    repository: next.repository === choice.repository ? next.repository : null,
    completion: next.completion === choice.completion ? next.completion : null,
    runner: next.runner === choice.runner ? next.runner : null,
  };
}
