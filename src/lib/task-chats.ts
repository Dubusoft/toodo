import type { ChatThread, Task, TaskId } from "@/lib/bindings";

/** A task the chat lists, with its thread once it has one. */
export type TaskChat = { task: Task; thread: ChatThread | null };

/** The tasks the chat lists under its default room. */
export type TaskChats = {
  /** Tasks waiting for a person: in review, or with their thread waiting on an answer (a decision or request). */
  needsAnswer: TaskChat[];
  /** In-progress tasks a lane works on, that wait for nobody. */
  inProgress: TaskChat[];
};

/** Whether `thread` waits on a person's answer to a decision or request the agent posted in it. */
export function awaitsAnswer(thread: ChatThread): boolean {
  return thread.awaitingAt !== null && thread.status !== "archived";
}

/** The threads that wait on a person's answer, the longest waiting first. */
export function waitingThreads(threads: readonly ChatThread[]): ChatThread[] {
  return threads.filter(awaitsAnswer).sort((a, b) => (a.awaitingAt ?? 0) - (b.awaitingAt ?? 0) || a.id - b.id);
}

/** The lane a task is worked on in, from its `lane:<key>` ref. */
export function laneOf(task: Task): string | null {
  const ref = task.refs.find((candidate) => candidate.startsWith("lane:") && candidate.length > "lane:".length);
  return ref === undefined ? null : ref.slice("lane:".length);
}

/** When `task` last changed: its latest status change or note. */
function lastUpdateOf(task: Task): number {
  return Math.max(0, ...task.timeline.map((event) => event.at), ...task.notes.map((note) => note.at));
}

/** When a chat was last active: its thread's latest message, else its task's latest update. */
function activityOf(chat: TaskChat): number {
  return chat.thread?.lastMessageAt ?? lastUpdateOf(chat.task);
}

/** The latest activity first, then the newest task. */
function byActivity(a: TaskChat, b: TaskChat): number {
  return activityOf(b) - activityOf(a) || b.task.id - a.task.id;
}

/**
 * The tasks the chat lists with their threads: those that need an answer, and the
 * in-progress ones a lane works on. Finished tasks, and the others (planned, paused,
 * waiting, or in progress without a lane), are left to their details.
 */
export function taskChats(tasks: readonly Task[], threads: readonly ChatThread[]): TaskChats {
  const threadOf = new Map<TaskId, ChatThread>();
  for (const thread of threads) {
    if (thread.taskId !== null) threadOf.set(thread.taskId, thread);
  }
  const chats: TaskChats = { needsAnswer: [], inProgress: [] };
  for (const task of tasks) {
    if (task.status === "done") continue;
    const chat = { task, thread: threadOf.get(task.id) ?? null };
    if (task.status === "in_review" || (chat.thread !== null && awaitsAnswer(chat.thread))) {
      chats.needsAnswer.push(chat);
    } else if (task.status === "in_progress" && laneOf(task) !== null) {
      chats.inProgress.push(chat);
    }
  }
  chats.needsAnswer.sort(byActivity);
  chats.inProgress.sort(byActivity);
  return chats;
}
