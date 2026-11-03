import { describe, expect, it } from "vitest";
import { workspaceCapabilities } from "@/lib/workspace-capabilities";

describe("workspaceCapabilities", () => {
  it("gives a GitHub workspace run by herdr everything, as every workspace had before the axes", () => {
    const github = workspaceCapabilities({ source: "github", completion: "pr_merge", runner: "herdr" });
    expect(github).toEqual({
      git: true,
      github: true,
      herdr: true,
      plainRuns: false,
      pullRequests: true,
      merge: true,
      criterionKinds: ["manual", "url", "command", "pr_open_ci_green"],
    });
    expect(workspaceCapabilities(undefined)).toEqual(github);
  });

  it("gives a plain directory no git, pull requests, merge, or herdr, and only manual, url, and command criteria", () => {
    expect(workspaceCapabilities({ source: "none", completion: "manual", runner: "none" })).toEqual({
      git: false,
      github: false,
      herdr: false,
      plainRuns: false,
      pullRequests: false,
      merge: false,
      criterionKinds: ["manual", "url", "command"],
    });
  });

  it("merges a local repository's branches without pull request criteria", () => {
    const local = workspaceCapabilities({ source: "local_git", completion: "local_merge", runner: "herdr" });
    expect(local).toMatchObject({ git: true, github: false, herdr: true, pullRequests: false, merge: true });
    expect(local.criterionKinds).toEqual(["manual", "url", "command"]);
  });

  it("runs the agents of a plain runner's tasks itself, without herdr", () => {
    const plain = workspaceCapabilities({ source: "local_git", completion: "local_merge", runner: "plain" });
    expect(plain).toMatchObject({ git: true, herdr: false, plainRuns: true, merge: true });
  });

  it("opens pull requests from the task branches of a GitHub workspace with runner plain", () => {
    const plain = workspaceCapabilities({ source: "github", completion: "pr_merge", runner: "plain" });
    expect(plain).toMatchObject({ github: true, herdr: false, plainRuns: true, pullRequests: true, merge: true });
  });

  it("opens no pull requests without a runner, whose task branches they come from", () => {
    const unrun = workspaceCapabilities({ source: "github", completion: "manual", runner: "none" });
    expect(unrun).toMatchObject({ git: true, github: true, herdr: false, pullRequests: false, merge: false });
    expect(unrun.criterionKinds).toEqual(["manual", "url", "command"]);
  });
});
