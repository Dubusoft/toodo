import { isPermissionGranted, requestPermission, sendNotification } from "@/web/notification";
import type { Task, TaskAgentStatus, TaskPullRequestStatus, TaskStatus } from "@/lib/bindings";

export type AgentAlert = { title: string; body: string };

const statusNames: Record<TaskStatus, string> = {
  planned: "Planned",
  in_progress: "In progress",
  in_review: "Awaiting completion",
  done: "Done",
};

function statusName(task: Task): string {
  if (task.status === "done" && task.resolution === "completed") return "Completed";
  return task.status === "done" && task.resolution === "not_adopted" ? "Not adopted" : statusNames[task.status];
}

function statusTitle(was: TaskStatus, task: Task): string {
  switch (task.status) {
    case "in_progress":
      return "Task started";
    case "in_review":
      return "Task awaiting completion";
    case "done":
      return task.resolution === "not_adopted" ? "Task concluded without merging" : "Task done";
    case "planned":
      return was === "in_progress" ? "Task paused" : "Task status changed";
  }
}

/**
 * One alert per task whose status changed between two snapshots. A task that is new in
 * `next` or gone from it raises none, so loading the list or creating a task is silent.
 * A task paused by a prerequisite that is not done while its herdr workspace is still open
 * gets the prompt to close that workspace instead: an agent added the prerequisite through
 * MCP, and the user decides in the app.
 */
export function taskStatusAlerts(previous: readonly Task[], next: readonly Task[]): AgentAlert[] {
  const before = new Map(previous.map((task) => [task.id, task.status]));
  const byId = new Map(next.map((task) => [task.id, task]));
  return next.flatMap((task) => {
    const was = before.get(task.id);
    if (was === undefined || was === task.status) {
      return [];
    }
    const blocked = task.dependsOn.some((id) => byId.get(id)?.status !== "done");
    if (was === "in_progress" && task.status === "planned" && blocked && task.herdrWorkspaceId !== null) {
      return [{ title: "Task paused by a new prerequisite", body: `#${task.id} ${task.title}: close its herdr workspace?` }];
    }
    return [
      {
        title: statusTitle(was, task),
        body: `#${task.id} ${task.title}: ${statusNames[was]} -> ${statusName(task)}`,
      },
    ];
  });
}

/**
 * Alerts for the agents that started waiting for input. A task that only now got an agent,
 * or one whose agent went away, raises none; finishing is covered by the task status alerts.
 */
export function agentAlerts(
  previous: readonly TaskAgentStatus[],
  next: readonly TaskAgentStatus[],
  tasks: readonly Task[],
): AgentAlert[] {
  const before = new Map(previous.map((entry) => [entry.taskId, entry.status]));
  return next.flatMap(({ taskId, status }) => {
    const was = before.get(taskId);
    if (was === undefined || was === status || status !== "blocked") {
      return [];
    }
    const task = tasks.find((candidate) => candidate.id === taskId);
    return [{ title: "Agent needs input", body: task ? `#${taskId} ${task.title}` : `#${taskId}` }];
  });
}

/**
 * Alerts for the pull requests that started needing the user: CI that started failing,
 * or a reviewer who requested changes. A pull request seen for the first time raises no
 * alert, so nothing fires for every failing pull request at startup.
 */
export function pullRequestAlerts(
  previous: readonly TaskPullRequestStatus[],
  next: readonly TaskPullRequestStatus[],
  tasks: readonly Task[],
): AgentAlert[] {
  const before = new Map(previous.map((entry) => [entry.taskId, entry]));
  return next.flatMap(({ taskId, checks, review }) => {
    const was = before.get(taskId);
    if (was === undefined) {
      return [];
    }
    const task = tasks.find((candidate) => candidate.id === taskId);
    const body = task ? `#${taskId} ${task.title}` : `#${taskId}`;
    const alerts: AgentAlert[] = [];
    if (checks === "failing" && was.checks !== "failing") {
      alerts.push({ title: "CI failed", body });
    }
    if (review === "changes_requested" && was.review !== "changes_requested") {
      alerts.push({ title: "Changes requested", body });
    }
    return alerts;
  });
}

/** Shows the alerts as browser notifications, asking for permission if needed. */
export async function notify(alerts: readonly AgentAlert[]): Promise<void> {
  if (alerts.length === 0) {
    return;
  }
  const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  if (!granted) {
    return;
  }
  for (const alert of alerts) {
    sendNotification(alert);
  }
}
