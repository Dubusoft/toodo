import type { ChatThread, Task, TaskId } from "@/lib/bindings";

/** A task the chat lists, with its thread once it has one. */
export type TaskChat = { task: Task; thread: ChatThread | null };

/** The tasks the chat lists under its default room. */
export type TaskChats = {
  /** Tasks waiting for a person: in review, or with a question in their thread nobody answered. */
  needsAnswer: TaskChat[];
  /** In-progress tasks a lane works on, that wait for nobody. */
  inProgress: TaskChat[];
};

/** The lane a task is worked on in, from its `lane:<key>` ref. */
export function laneOf(task: Task): string | null {
  const ref = task.refs.find((candidate) => candidate.startsWith("lane:") && candidate.length > "lane:".length);
  return ref === undefined ? null : ref.slice("lane:".length);
}

/** The latest activity first: the thread's latest message, else the newest task. */
function byActivity(a: TaskChat, b: TaskChat): number {
  return (b.thread?.lastMessageAt ?? 0) - (a.thread?.lastMessageAt ?? 0) || b.task.id - a.task.id;
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
    if (task.status === "in_review" || chat.thread?.awaitingChoice === true) {
      chats.needsAnswer.push(chat);
    } else if (task.status === "in_progress" && laneOf(task) !== null) {
      chats.inProgress.push(chat);
    }
  }
  chats.needsAnswer.sort(byActivity);
  chats.inProgress.sort(byActivity);
  return chats;
}
