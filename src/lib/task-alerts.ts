import { isPermissionGranted, requestPermission, sendNotification } from "@/web/notification";
import type { Task, TaskStatus } from "@/lib/bindings";

export type TaskAlert = { title: string; body: string };

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
 */
export function taskStatusAlerts(previous: readonly Task[], next: readonly Task[]): TaskAlert[] {
  const before = new Map(previous.map((task) => [task.id, task.status]));
  return next.flatMap((task) => {
    const was = before.get(task.id);
    if (was === undefined || was === task.status) {
      return [];
    }
    return [
      {
        title: statusTitle(was, task),
        body: `#${task.id} ${task.title}: ${statusNames[was]} -> ${statusName(task)}`,
      },
    ];
  });
}

/** Shows the alerts as browser notifications, asking for permission if needed. */
export async function notify(alerts: readonly TaskAlert[]): Promise<void> {
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