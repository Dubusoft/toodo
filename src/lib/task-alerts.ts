import { isPermissionGranted, requestPermission, sendNotification } from "@/web/notification";
import type { Task, TaskStatus } from "@/lib/bindings";
import { currentMessages } from "@/lib/i18n";
import type { Messages } from "@/locales/en";

export type TaskAlert = { title: string; body: string };

type Words = Messages["alerts"];

function statusName(task: Task, words: Words): string {
  if (task.status === "done" && task.resolution === "completed") return words.statuses.completed;
  return task.status === "done" && task.resolution === "not_adopted" ? words.statuses.not_adopted : words.statuses[task.status];
}

function statusTitle(was: TaskStatus, task: Task, words: Words): string {
  switch (task.status) {
    case "in_progress":
      return words.started;
    case "in_review":
      return words.awaitingCompletion;
    case "done":
      return task.resolution === "not_adopted" ? words.concluded : words.done;
    case "planned":
      return was === "in_progress" ? words.paused : words.changed;
  }
}

/**
 * One alert per task whose status changed between two snapshots. A task that is new in
 * `next` or gone from it raises none, so loading the list or creating a task is silent. They are
 * in the UI language at the time they are raised.
 */
export function taskStatusAlerts(
  previous: readonly Task[],
  next: readonly Task[],
  words: Words = currentMessages().alerts,
): TaskAlert[] {
  const before = new Map(previous.map((task) => [task.id, task.status]));
  return next.flatMap((task) => {
    const was = before.get(task.id);
    if (was === undefined || was === task.status) {
      return [];
    }
    return [
      {
        title: statusTitle(was, task, words),
        body: `#${task.id} ${task.title}: ${words.statuses[was]} -> ${statusName(task, words)}`,
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