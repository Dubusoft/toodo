// What deserves a push notification: the changes between two snapshots of task statuses.
// The first snapshot only sets the baseline, so starting the server is silent, and a newly
// seen task raises nothing.

import type { TaskId } from "../domain/model.ts";
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

/** The agent, named `agent`, posted chat message `id` where `notice` names; each message
 * is its own notification, and clicking it opens that channel or thread. */
export function agentMessageAlert(agent: string, notice: ChatNotice, id: number, body: string): Alert {
  const title =
    notice.thread === null ? `${agent} in #${notice.channel}` : `${agent} in #${notice.channel} / ${notice.thread}`;
  return {
    kind: "agent_message",
    urgent: true,
    title,
    body: shorten(body),
    tag: `chat-${id}`,
    taskId: null,
    chat: { channelId: notice.channelId, threadId: notice.threadId },
  };
}

function taskAlert(kind: PushKind, urgent: boolean, title: string, task: TaskId, name: string | null): Alert {
  const tag = kind === "completion" ? "completion" : "message";
  return {
    kind,
    urgent,
    title,
    body: shorten(name === null ? `#${task}` : `#${task} ${name}`),
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
  readonly title: string;
};

/** The last statuses seen. */
export class Watch {
  #tasks: Map<TaskId, WatchedTask> | null = null;

  /** A task that moved to `in_review` is awaiting completion. The first list of tasks
   * only sets the baseline. */
  tasks(tasks: Iterable<WatchedTask>): Alert[] {
    const next = new Map<TaskId, WatchedTask>();
    for (const task of tasks) next.set(task.id, task);
    const before = this.#tasks;
    const alerts: Alert[] = [];
    if (before !== null) {
      for (const task of next.values()) {
        const was = before.get(task.id);
        if (task.status === "in_review" && was !== undefined && was.status !== "in_review") {
          alerts.push(taskAlert("completion", false, "Task awaiting completion", task.id, task.title));
        }
      }
    }
    alerts.sort((a, b) => (a.taskId ?? 0) - (b.taskId ?? 0));
    this.#tasks = next;
    return alerts;
  }
}
