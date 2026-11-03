import { describe, expect, it } from "vitest";
import { workspaceCapabilities } from "@/lib/workspace-capabilities";

describe("workspaceCapabilities", () => {
  it("gives a GitHub workspace run by herdr everything, as every workspace had before the axes", () => {
    const github = workspaceCapabilities({ source: "github", completion: "pr_merge", runner: "herdr" });
    expect(github).toEqual({
      git: true,
      github: true,
      herdr: true,
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

  it("opens no pull requests without herdr, whose task branches they come from", () => {
    const unrun = workspaceCapabilities({ source: "github", completion: "manual", runner: "none" });
    expect(unrun).toMatchObject({ git: true, github: true, herdr: false, pullRequests: false, merge: false });
    expect(unrun.criterionKinds).toEqual(["manual", "url", "command"]);
  });
});
