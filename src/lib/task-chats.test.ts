import { describe, expect, it } from "vitest";
import type { ChatThread, Task, TaskStatus } from "@/lib/bindings";
import { laneOf, taskChats } from "@/lib/task-chats";

function task(id: number, status: TaskStatus, refs: string[] = []): Task {
  return { id, title: `Task ${id}`, status, refs } as unknown as Task;
}

function thread(id: number, taskId: number | null, overrides: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    channelId: 1,
    title: `Thread ${id}`,
    taskId,
    status: "open",
    createdAt: 1,
    closedAt: null,
    archivedAt: null,
    awaitingAt: null,
    unread: 0,
    lastMessageAt: null,
    lastMessage: null,
    ...overrides,
  };
}

const ids = (chats: ReturnType<typeof taskChats>) => ({
  needsAnswer: chats.needsAnswer.map((chat) => [chat.task.id, chat.thread?.id ?? null]),
  inProgress: chats.inProgress.map((chat) => [chat.task.id, chat.thread?.id ?? null]),
});

describe("taskChats", () => {
  it("lists tasks waiting for an answer and in-progress tasks with a lane, latest activity first", () => {
    const tasks = [
      task(1, "in_progress", ["lane:a-1"]),
      task(2, "in_progress", ["lane:b-1"]),
      task(3, "in_review"),
      task(4, "in_progress", ["lane:c-1"]),
    ];
    const threads = [
      thread(10, 1, { lastMessageAt: 100 }),
      thread(11, 2, { lastMessageAt: 300 }),
      thread(12, 4, { lastMessageAt: 200, awaitingAt: 150 }),
    ];
    expect(ids(taskChats(tasks, threads))).toEqual({
      needsAnswer: [[4, 12], [3, null]],
      inProgress: [[2, 11], [1, 10]],
    });
  });

  it("leaves out finished tasks, tasks without a lane, and paused or waiting ones that need no answer", () => {
    const tasks = [
      task(1, "in_progress"),
      task(2, "planned", ["lane:paused-1"]),
      task(3, "done", ["lane:done-1"]),
      task(4, "planned", ["pr:7"]),
    ];
    const threads = [thread(10, 1), thread(11, 2), thread(12, 3, { awaitingAt: 5 })];
    expect(ids(taskChats(tasks, threads))).toEqual({ needsAnswer: [], inProgress: [] });
  });

  it("lists a paused task with an unanswered question", () => {
    const tasks = [task(1, "planned")];
    const threads = [thread(5, 1, { awaitingAt: 5 }), thread(6, null)];
    expect(ids(taskChats(tasks, threads))).toEqual({ needsAnswer: [[1, 5]], inProgress: [] });
  });
});

describe("laneOf", () => {
  it("reads the lane key of a lane ref", () => {
    expect(laneOf(task(1, "in_progress", ["pr:3", "lane:ap-1730-1"]))).toBe("ap-1730-1");
    expect(laneOf(task(1, "in_progress", ["lane:"]))).toBeNull();
    expect(laneOf(task(1, "in_progress", ["plane:x"]))).toBeNull();
  });
});
