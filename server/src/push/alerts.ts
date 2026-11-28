// What deserves a push notification: the changes between two snapshots of task statuses.
// The first snapshot only sets the baseline, so starting the server is silent, and a newly
// seen task raises nothing.

import type { TaskId, TaskResolution } from "../domain/model.ts";
import type { PushKind } from "../domain/push.ts";
import type { TaskStatus } from "../domain/status.ts";
import type { ChatNotice } from "../storage/chat-channels.ts";

/** The longest notification body, in characters; a message must fit one 4 KB record. */
export const MAX_BODY_CHARS = 300;

/** One notification. */
export type Alert = {
  /** The setting that turns it off; `null` for the test notification, which every
   * subscription gets. */
  readonly kind: PushKind | null;
  /** Whether the user should see it now rather than when the device wakes up. */
  readonly urgent: boolean;
  readonly title: string;
  readonly body: string;
  /** A later notification with the same tag replaces the earlier one. */
  readonly tag: string;
  readonly taskId: number | null;
  /** The channel and thread clicking it opens in the chat. */
  readonly chat: ChatTarget | null;
};

/** A place in the chat a notification opens: a channel, or a thread under it. */
export type ChatTarget = {
  readonly channelId: number;
  readonly threadId: number | null;
};

/** The notification as the service worker receives it: `kind` and `urgent` stay on the
 * server, and the chat place is sent only when set, as `chat: true` beside the ids. */
export function alertPayload(alert: Alert): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    title: alert.title,
    body: alert.body,
    tag: alert.tag,
    taskId: alert.taskId,
  };
  if (alert.chat !== null) {
    payload.chat = true;
    payload.channelId = alert.chat.channelId;
    payload.threadId = alert.chat.threadId;
  }
  return payload;
}

export function testAlert(): Alert {
  return {
    kind: null,
    urgent: true,
    title: "Toodo notifications are on",
    body: "This device will get notifications even while Toodo is closed.",
    tag: "test",
    taskId: null,
    chat: null,
  };
}

/** Where `notice` names, as a notification title: `#channel` or `#channel / thread`. */
function placeName(notice: ChatNotice): string {
  return notice.thread === null ? `#${notice.channel}` : `#${notice.channel} / ${notice.thread}`;
}

/** The agent, named `agent`, posted chat message `id` where `notice` names; each message
 * is its own notification, and clicking it opens that channel or thread. An `important`
 * message waits on the people: it offers choices, or its thread waits on their answer. */
export function agentMessageAlert(
  agent: string,
  notice: ChatNotice,
  id: number,
  body: string,
  important: boolean,
): Alert {
  return {
    kind: important ? "important_message" : "agent_message",
    urgent: true,
    title: `${agent} in ${placeName(notice)}`,
    body: shorten(body),
    tag: `chat-${id}`,
    taskId: null,
    chat: { channelId: notice.channelId, threadId: notice.threadId },
  };
}

/** The agent's latest message in a thread. */
export type LatestMessage = { readonly id: number; readonly body: string };

/** The thread `notice` names started waiting on the people's answer. The notification
 * shows the agent's `latest` message there and replaces that message's own notification,
 * so a device that got the message is not told twice. */
export function awaitingAlert(agent: string, notice: ChatNotice, latest: LatestMessage | null): Alert {
  return {
    kind: "awaiting_answer",
    urgent: true,
    title: `${agent} is waiting for your answer in ${placeName(notice)}`,
    body: shorten(latest?.body ?? notice.thread ?? notice.channel),
    tag: latest === null ? `thread-${notice.threadId}-awaiting` : `chat-${latest.id}`,
    taskId: null,
    chat: { channelId: notice.channelId, threadId: notice.threadId },
  };
}

/** A task's notification. A task's finish replaces its notification of awaiting
 * completion, since both share the `completion` tag. */
function taskAlert(kind: PushKind, title: string, task: TaskId, name: string): Alert {
  const tag = kind === "task_started" ? "status" : "completion";
  return {
    kind,
    urgent: false,
    title,
    body: shorten(`#${task} ${name}`),
    tag: `task-${task}-${tag}`,
    taskId: task,
    chat: null,
  };
}

function shorten(text: string): string {
  const chars = [...text];
  return chars.length > MAX_BODY_CHARS ? `${chars.slice(0, MAX_BODY_CHARS).join("")}...` : text;
}

/** A task as the watch sees it. */
export type WatchedTask = {
  readonly id: TaskId;
  readonly status: TaskStatus;
  readonly resolution: TaskResolution | null;
  readonly title: string;
};

/** The alert for a task now in `task`'s status, `was` before; the titles are those the web
 * app gives the same changes when it raises them itself (`src/lib/task-alerts.ts`). */
function statusAlert(was: TaskStatus, task: WatchedTask): Alert | null {
  if (was === task.status) return null;
  switch (task.status) {
    case "in_progress":
      return taskAlert("task_started", "Task started", task.id, task.title);
    case "in_review":
      return taskAlert("completion", "Task awaiting completion", task.id, task.title);
    case "done": {
      const title = task.resolution === "not_adopted" ? "Task concluded without merging" : "Task done";
      return taskAlert("task_finished", title, task.id, task.title);
    }
    case "planned":
      return null;
  }
}

/** The last statuses seen. */
export class Watch {
  #tasks: Map<TaskId, WatchedTask> | null = null;

  /** A task that moved to `in_progress` started, one that moved to `in_review` is
   * awaiting completion, and one that moved to `done` finished. The first list of tasks
   * only sets the baseline. */
  tasks(tasks: Iterable<WatchedTask>): Alert[] {
    const next = new Map<TaskId, WatchedTask>();
    for (const task of tasks) next.set(task.id, task);
    const before = this.#tasks;
    const alerts: Alert[] = [];
    if (before !== null) {
      for (const task of next.values()) {
        const was = before.get(task.id);
        const alert = was === undefined ? null : statusAlert(was.status, task);
        if (alert !== null) alerts.push(alert);
      }
    }
    alerts.sort((a, b) => (a.taskId ?? 0) - (b.taskId ?? 0));
    this.#tasks = next;
    return alerts;
  }
}
