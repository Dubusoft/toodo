import { describe, expect, it } from "vitest";
import type { CompletionMode, Source } from "@/lib/bindings";
import {
  checkAxes,
  choiceOf,
  completionLabels,
  completionProblem,
  completions,
  defaultRunner,
  repositoryKinds,
  repositoryProblem,
  runnerLabels,
  runnerLocationProblem,
  runnerProblem,
  runners,
  sourceLabels,
  sources,
  withPick,
  type Axes,
  type Picks,
} from "@/lib/workspace-axes";

/** The combinations `check_axes` accepts, as `source/completion/runner`. */
const accepted = new Set([
  "none/manual/none",
  "local_git/manual/none",
  "local_git/manual/herdr",
  "local_git/local_merge/herdr",
  "local_git/manual/plain",
  "local_git/local_merge/plain",
  "github/manual/none",
  "github/manual/herdr",
  "github/pr_merge/herdr",
  "github/manual/plain",
  "github/pr_merge/plain",
  "local_git/manual/tmux",
  "local_git/local_merge/tmux",
  "github/manual/tmux",
  "github/pr_merge/tmux",
]);

const everyAxes: Axes[] = sources.flatMap((source) =>
  completions.flatMap((completion) => runners.map((runner) => ({ source, completion, runner }))),
);

const key = ({ source, completion, runner }: Axes) => `${source}/${completion}/${runner}`;

/** Nothing picked yet but the source. */
const only = (source: Source): Picks => ({ source, repository: null, completion: null, runner: null });

describe("workspace axes", () => {
  it("accepts exactly the combinations the server accepts", () => {
    expect(everyAxes).toHaveLength(36);
    for (const axes of everyAxes) {
      expect(checkAxes(axes) === null, key(axes)).toBe(accepted.has(key(axes)));
    }
  });

  it("allows manual completion for every source and each merge only for its own source", () => {
    const allowed = (source: Source) => completions.filter((completion) => completionProblem(source, completion) === null);
    expect(allowed("none")).toEqual(["manual"]);
    expect(allowed("local_git")).toEqual(["manual", "local_merge"]);
    expect(allowed("github")).toEqual(["manual", "pr_merge"]);
  });

  it("names the source a ruled out completion needs", () => {
    expect(completionProblem("none", "local_merge")).toContain(sourceLabels.local_git);
    expect(completionProblem("github", "local_merge")).toContain(sourceLabels.local_git);
    expect(completionProblem("none", "pr_merge")).toContain(sourceLabels.github);
    expect(completionProblem("local_git", "pr_merge")).toContain(sourceLabels.github);
  });

  it("allows no runner only with manual completion and herdr, plain, and tmux only with a git source", () => {
    const allowed = (source: Source, completion: CompletionMode) =>
      runners.filter((runner) => runnerProblem(source, completion, runner) === null);
    expect(allowed("none", "manual")).toEqual(["none"]);
    expect(allowed("local_git", "manual")).toEqual(["herdr", "plain", "tmux", "none"]);
    expect(allowed("local_git", "local_merge")).toEqual(["herdr", "plain", "tmux"]);
    expect(allowed("github", "manual")).toEqual(["herdr", "plain", "tmux", "none"]);
    expect(allowed("github", "pr_merge")).toEqual(["herdr", "plain", "tmux"]);
  });

  it("names the choice a ruled out runner needs", () => {
    for (const runner of ["herdr", "plain", "tmux"] as const) {
      expect(runnerProblem("none", "manual", runner)).toContain(sourceLabels.local_git);
      expect(runnerProblem("none", "manual", runner)).toContain(sourceLabels.github);
    }
    expect(runnerProblem("local_git", "local_merge", "none")).toContain(completionLabels.manual);
    expect(runnerProblem("github", "pr_merge", "none")).toContain(completionLabels.manual);
  });

  it("allows every runner on this server and on a POSIX SSH machine, and rules out only tmux on a Windows one", () => {
    const anyHost = [
      { kind: "local", path: "/home/me/site" },
      // A local workspace runs on this server whatever its path says; only an SSH path tells the host's kind.
      { kind: "local", path: "D:\\dev\\site" },
      { kind: "ssh", path: "/srv/site" },
    ] as const;
    const windows = [
      { kind: "ssh", path: "D:\\dev\\site" },
      { kind: "ssh", path: "c:/dev/site" },
      { kind: "ssh", path: "\\\\fileserver\\share\\site" },
    ] as const;
    for (const runner of runners) {
      for (const location of anyHost) {
        expect(runnerLocationProblem(runner, location), `${runner} at ${location.path}`).toBeNull();
      }
      for (const location of windows) {
        expect(runnerLocationProblem(runner, location) === null, `${runner} at ${location.path}`).toBe(runner !== "tmux");
      }
    }
    const problem = runnerLocationProblem("tmux", windows[0]);
    expect(problem).toContain("POSIX");
    expect(problem).toContain(runnerLabels.plain);
    expect(problem).toContain(runnerLabels.herdr);
  });

  it("offers every repository setup for local git, no new repository for GitHub, and none for a plain folder", () => {
    const allowed = (source: Source) => repositoryKinds.filter((kind) => repositoryProblem(source, kind) === null);
    expect(allowed("none")).toEqual([]);
    expect(allowed("local_git")).toEqual(["open", "init", "clone"]);
    expect(allowed("github")).toEqual(["open", "clone"]);
    expect(repositoryProblem("github", "init")).toContain(sourceLabels.local_git);
  });

  it("defaults a plain folder to manual and no runner, and a git source to its merge with herdr", () => {
    expect(choiceOf(only("none"))).toEqual({ source: "none", repository: null, completion: "manual", runner: "none" });
    expect(choiceOf(only("local_git"))).toEqual({
      source: "local_git",
      repository: "open",
      completion: "local_merge",
      runner: "herdr",
    });
    expect(choiceOf(only("github"))).toEqual({
      source: "github",
      repository: "open",
      completion: "pr_merge",
      runner: "herdr",
    });
  });

  it("defaults a git source to plain without herdr on this server, keeping a runner picked by hand", () => {
    expect(defaultRunner("none", true)).toBe("none");
    expect(defaultRunner("local_git", true)).toBe("plain");
    expect(defaultRunner("github", true)).toBe("plain");
    expect(choiceOf(only("github"), true)).toEqual({
      source: "github",
      repository: "open",
      completion: "pr_merge",
      runner: "plain",
    });
    expect(choiceOf(withPick(only("github"), { runner: "herdr" }, true), true).runner).toBe("herdr");
    // A plain folder has no runner; the git source picked after it follows the default again.
    const folder = withPick(only("github"), { source: "none" }, true);
    expect(choiceOf(folder, true).runner).toBe("none");
    expect(choiceOf(withPick(folder, { source: "local_git" }, true), true).runner).toBe("plain");
    for (const axes of everyAxes) {
      expect(checkAxes(choiceOf({ ...axes, repository: null }, true)), key(axes)).toBeNull();
    }
  });

  it("keeps the picks the earlier ones allow", () => {
    let picks = only("local_git");
    picks = withPick(picks, { repository: "init" });
    picks = withPick(picks, { completion: "manual" });
    picks = withPick(picks, { runner: "none" });
    picks = withPick(picks, { source: "github" });
    expect(choiceOf(picks)).toEqual({ source: "github", repository: "open", completion: "manual", runner: "none" });
  });

  it("resets a pick that an earlier change rules out to its default until it is picked again", () => {
    let picks = withPick(withPick(only("github"), { completion: "manual" }), { runner: "none" });
    picks = withPick(picks, { completion: "pr_merge" });
    expect(choiceOf(picks).runner).toBe("herdr");
    // The dropped runner does not come back once manual completion would allow it again.
    picks = withPick(picks, { completion: "manual" });
    expect(choiceOf(picks).runner).toBe("herdr");

    picks = withPick(withPick(only("local_git"), { repository: "init" }), { source: "github" });
    expect(choiceOf(picks).repository).toBe("open");
    expect(choiceOf(withPick(picks, { source: "local_git" })).repository).toBe("open");
  });

  it("follows the defaults of a new source for what was not picked", () => {
    const folder = withPick(only("github"), { source: "none" });
    expect(choiceOf(folder)).toEqual(choiceOf(only("none")));
    expect(choiceOf(withPick(folder, { source: "github" }))).toEqual(choiceOf(only("github")));
  });

  it("always makes a combination the server accepts, keeping every pick that works", () => {
    for (const axes of everyAxes) {
      for (const repository of [null, ...repositoryKinds]) {
        const choice = choiceOf({ ...axes, repository });
        expect(checkAxes(choice), key(axes)).toBeNull();
        expect(choice.source).toBe(axes.source);
        if (choice.repository === null) expect(axes.source).toBe("none");
        else expect(repositoryProblem(axes.source, choice.repository)).toBeNull();
        if (checkAxes(axes) === null) expect(choice).toMatchObject(axes);
      }
    }
  });
});
