import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import type { RunnerHealth, Tool, Workspace } from "@/lib/bindings";
import { useHerdrStatus, useRunnerHealth, useWorkspaces } from "@/lib/queries";
import { tonePanel } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { reachability, subscribeReachability } from "@/web/connection";

/** A tool the server needs for one of its workspaces that cannot do its work, with the next step. */
export type ToolProblem = { tool: string; message: string };

const toolNames: Record<Tool, string> = { git: "git", gh: "gh", ssh: "ssh" };

/**
 * The tools of `health` that a workspace needs and that are not ready: git for local
 * repositories, gh for GitHub workspaces, ssh for SSH workspaces, tmux for local tmux
 * workspaces, and an agent CLI for local plain or tmux workspaces. SSH workspaces run git, tmux,
 * and the agent CLIs of their host, which the server does not check.
 */
export function toolProblems(health: RunnerHealth, workspaces: Workspace[]): ToolProblem[] {
  const local = workspaces.filter((workspace) => workspace.location.kind === "local");
  const needs: Record<Tool, boolean> = {
    git: local.some((workspace) => workspace.source !== "none"),
    gh: workspaces.some((workspace) => workspace.source === "github"),
    ssh: workspaces.some((workspace) => workspace.location.kind === "ssh"),
  };
  const problems: ToolProblem[] = health.tools
    .filter((tool) => needs[tool.tool] && !tool.ready)
    .map((tool) => ({ tool: toolNames[tool.tool], message: tool.message ?? `${toolNames[tool.tool]} is not ready.` }));
  if (local.some((workspace) => workspace.runner === "tmux") && !health.tmux.installed) {
    problems.push({ tool: "tmux", message: health.tmux.message ?? "tmux is not installed." });
  }
  const runsAgents = local.some((workspace) => workspace.runner === "plain" || workspace.runner === "tmux");
  if (runsAgents && health.agents.length > 0 && health.agents.every((agent) => !agent.installed)) {
    problems.push({
      tool: "claude / codex",
      message:
        "Neither claude nor codex was found on the server's PATH; install one of them on the PATH of the user that runs toodo-server, or set the workspace runner to herdr or none.",
    });
  }
  return problems;
}

/**
 * Names each tool on the server that a workspace needs and that is not ready, with its next
 * step: herdr for herdr workspaces, then the tools of `toolProblems`.
 */
export function ToolHealthBanner() {
  const herdr = useHerdrStatus();
  const health = useRunnerHealth();
  const workspaces = useWorkspaces().data ?? [];
  // While the Toodo server cannot be reached, its banner says so; the tools may be fine.
  const serverDown = useSyncExternalStore(subscribeReachability, reachability) !== "reachable";
  if (serverDown) {
    return null;
  }

  const problems: ToolProblem[] = [];
  // Tasks of workspaces with another runner start without herdr.
  const needsHerdr = workspaces.some((workspace) => workspace.runner === "herdr");
  if (needsHerdr && !herdr.isPending && !herdr.data?.running) {
    const reason = herdr.isError ? herdr.error.message : "The herdr server is not running.";
    problems.push({
      tool: "herdr",
      message: `${reason} Start herdr, then retry. Tasks of herdr workspaces cannot be started until herdr is running.`,
    });
  }
  if (health.data) {
    problems.push(...toolProblems(health.data, workspaces));
  }
  if (problems.length === 0) {
    return null;
  }

  const checking = herdr.isFetching || health.isFetching;
  return (
    <div
      role="alert"
      className={cn("mb-4 flex items-start justify-between gap-3 rounded-lg px-3 py-2", tonePanel.attention)}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">
          {problems.length === 1
            ? `${problems[0].tool} is not available`
            : `${problems.map((problem) => problem.tool).join(", ")} are not available`}
        </p>
        <ul className="flex flex-col gap-0.5">
          {problems.map((problem) => (
            <li key={problem.tool} className="text-xs break-words">
              {problems.length > 1 && <span className="font-medium">{problem.tool}: </span>}
              {problem.message}
            </li>
          ))}
        </ul>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void herdr.refetch();
          void health.refetch();
        }}
        disabled={checking}
      >
        {checking ? "Checking..." : "Retry"}
      </Button>
    </div>
  );
}
