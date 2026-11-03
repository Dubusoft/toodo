import type { AgentStatus, Task, TaskAgentStatus, TaskId, TaskNote, TaskPullRequestStatus } from "@/lib/bindings";
import { prerequisitesResolved } from "@/lib/task-graph";

/**
 * The blocker reported on `task` that still stands: its latest note, if that is a blocker. A
 * later progress note means the work got past it; finishing the task, or starting it again
 * after the blocker (resuming a paused task), ends it too. The blocker a pause by a new
 * prerequisite records ends once the prerequisites no longer block the task. `byId` holds the
 * tasks of every workspace, since a prerequisite may belong to another one.
 */
export function openBlocker(task: Task, byId: ReadonlyMap<TaskId, Task>): TaskNote | null {
  const latest = task.notes.at(-1);
  if (task.status === "done" || latest?.kind !== "blocker") {
    return null;
  }
  const resumed = task.timeline.some((event) => event.status === "in_progress" && event.at > latest.at);
  const unblocked = latest.at === task.milestones.pausedAt && prerequisitesResolved(task, byId);
  return resumed || unblocked ? null : latest;
}

/** Why a task waits on the user, most urgent first. */
export const attentionReasons = ["agent_blocked", "blocker_note", "ci_failed", "changes_requested"] as const;

export type AttentionReason = (typeof attentionReasons)[number];

export type AttentionItem = {
  task: Task;
  reasons: AttentionReason[];
  agentStatus: AgentStatus | null;
};

/**
 * Tasks that wait on the user: an agent asking for input, a blocker an agent reported as its
 * latest note, or a pull request whose CI failed or that got changes requested. The most
 * urgent come first, then by task ID.
 */
export function needsAttention(
  tasks: Task[],
  agentStatuses: TaskAgentStatus[],
  pullRequestStatuses: TaskPullRequestStatus[],
  byId: ReadonlyMap<TaskId, Task> = new Map(tasks.map((task) => [task.id, task])),
): AttentionItem[] {
  const agents = new Map(agentStatuses.map((entry) => [entry.taskId, entry.status]));
  const pullRequests = new Map(pullRequestStatuses.map((entry) => [entry.taskId, entry]));
  const rank = (item: AttentionItem) => attentionReasons.indexOf(item.reasons[0]);
  return tasks
    .flatMap((task) => {
      const active = task.status === "in_progress" || task.status === "in_review";
      const agentStatus = active ? (agents.get(task.id) ?? null) : null;
      // Statuses are only checked while the pull request is open.
      const pullRequest = task.status === "in_review" ? pullRequests.get(task.id) : undefined;
      const reasons = attentionReasons.filter((reason) => {
        switch (reason) {
          case "agent_blocked":
            return agentStatus === "blocked";
          case "blocker_note":
            return openBlocker(task, byId) !== null;
          case "ci_failed":
            return pullRequest?.checks === "failing";
          case "changes_requested":
            return pullRequest?.review === "changes_requested";
        }
      });
      return reasons.length > 0 ? [{ task, reasons, agentStatus }] : [];
    })
    .sort((a, b) => rank(a) - rank(b) || a.task.id - b.task.id);
}
