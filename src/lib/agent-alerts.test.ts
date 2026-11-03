import { describe, expect, it } from "vitest";
import { agentAlerts, pullRequestAlerts, taskStatusAlerts } from "@/lib/agent-alerts";
import type { AgentStatus, Task, TaskAgentStatus, TaskPullRequestStatus } from "@/lib/bindings";

const tasks = [{ id: 1, title: "Add login" }, { id: 2, title: "Add logout" }] as Task[];

describe("taskStatusAlerts", () => {
  const task = (id: number, title: string, status: Task["status"], extra: Partial<Task> = {}) =>
    ({ id, title, status, dependsOn: [], herdrWorkspaceId: null, resolution: null, ...extra }) as unknown as Task;
  const login = task(1, "Add login", "planned");

  it("alerts once for each task whose status changed", () => {
    const logout = task(2, "Add logout", "in_review");
    expect(
      taskStatusAlerts(
        [login, logout, task(3, "Add search", "planned")],
        [{ ...login, status: "in_progress" }, { ...logout, status: "done", resolution: "merged" }, task(3, "Add search", "planned")],
      ),
    ).toEqual([
      { title: "Task started", body: "#1 Add login: Planned -> In progress" },
      { title: "Task done", body: "#2 Add logout: Awaiting completion -> Done" },
    ]);
  });

  it("words the review, not adopted, and pause transitions", () => {
    const started = { ...login, status: "in_progress" } as Task;
    expect(taskStatusAlerts([started], [{ ...started, status: "in_review" }])).toEqual([
      { title: "Task awaiting completion", body: "#1 Add login: In progress -> Awaiting completion" },
    ]);
    expect(taskStatusAlerts([started], [{ ...started, status: "done", resolution: "not_adopted" }])).toEqual([
      { title: "Task concluded without merging", body: "#1 Add login: In progress -> Not adopted" },
    ]);
    expect(taskStatusAlerts([started], [{ ...started, status: "done", resolution: "completed" }])).toEqual([
      { title: "Task done", body: "#1 Add login: In progress -> Completed" },
    ]);
    expect(taskStatusAlerts([started], [login])).toEqual([
      { title: "Task paused", body: "#1 Add login: In progress -> Planned" },
    ]);
  });

  it("asks about the open workspace when a prerequisite pauses a started task", () => {
    const fix = task(1, "Fix login", "planned");
    const started = task(2, "Verify login", "in_progress", { herdrWorkspaceId: "w27" });
    const paused = { ...started, status: "planned", dependsOn: [1] } as Task;
    expect(taskStatusAlerts([fix, started], [fix, paused])).toEqual([
      { title: "Task paused by a new prerequisite", body: "#2 Verify login: close its herdr workspace?" },
    ]);
    expect(taskStatusAlerts([fix, started], [fix, { ...paused, herdrWorkspaceId: null }])).toEqual([
      { title: "Task paused", body: "#2 Verify login: In progress -> Planned" },
    ]);
  });

  it("stays quiet for unchanged, new, and removed tasks", () => {
    expect(taskStatusAlerts([login], [login])).toEqual([]);
    expect(taskStatusAlerts([], [login])).toEqual([]);
    expect(taskStatusAlerts([login], [])).toEqual([]);
  });
});

describe("pullRequestAlerts", () => {
  const status = (
    taskId: number,
    checks: TaskPullRequestStatus["checks"],
    review: TaskPullRequestStatus["review"],
  ): TaskPullRequestStatus => ({ taskId, checks, review });

  it("alerts when CI starts failing or a reviewer requests changes", () => {
    expect(
      pullRequestAlerts(
        [status(1, "pending", "pending"), status(2, null, "approved")],
        [status(1, "failing", "changes_requested"), status(2, null, "changes_requested")],
        tasks,
      ),
    ).toEqual([
      { title: "CI failed", body: "#1 Add login" },
      { title: "Changes requested", body: "#1 Add login" },
      { title: "Changes requested", body: "#2 Add logout" },
    ]);
  });

  it("stays quiet for unchanged, recovering, or newly seen pull requests", () => {
    expect(
      pullRequestAlerts(
        [status(1, "failing", "changes_requested"), status(2, "failing", "pending")],
        [
          status(1, "failing", "changes_requested"),
          status(2, "passing", "approved"),
          status(3, "failing", "changes_requested"),
        ],
        tasks,
      ),
    ).toEqual([]);
  });
});

describe("agentAlerts", () => {
  const agent = (taskId: number, status: AgentStatus): TaskAgentStatus => ({ taskId, status });

  it("alerts once when an agent starts waiting for input", () => {
    expect(agentAlerts([agent(1, "working"), agent(2, "idle")], [agent(1, "blocked"), agent(2, "idle")], tasks)).toEqual([
      { title: "Agent needs input", body: "#1 Add login" },
    ]);
  });

  it("stays quiet when an agent finishes", () => {
    expect(agentAlerts([agent(1, "working"), agent(2, "working")], [agent(1, "idle"), agent(2, "done")], tasks)).toEqual([]);
  });

  it("stays quiet for a newly seen or vanished agent", () => {
    expect(agentAlerts([], [agent(1, "blocked")], tasks)).toEqual([]);
    expect(agentAlerts([agent(1, "blocked")], [], tasks)).toEqual([]);
  });

  it("stays quiet when an agent remains blocked", () => {
    expect(agentAlerts([agent(1, "blocked")], [agent(1, "blocked")], tasks)).toEqual([]);
  });
});
