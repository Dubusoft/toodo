import { describe, expect, test } from "bun:test";

import { chatChannelId, chatThreadId } from "../domain/chat.ts";
import { taskId } from "../domain/model.ts";
import type { TaskStatus } from "../domain/status.ts";
import type { TaskResolution } from "../domain/model.ts";
import { MAX_BODY_CHARS, type Alert, Watch, agentMessageAlert, alertPayload, awaitingAlert } from "./alerts.ts";

function seen(watch: Watch, list: [number, TaskStatus, TaskResolution?][]): Alert[] {
  return watch.tasks(
    list.map(([id, status, resolution]) => ({ id: taskId(id), status, resolution: resolution ?? null, title: `Task ${id}` })),
  );
}

describe("push alerts", () => {
  test("tasks awaiting completion after the baseline raise one alert", () => {
    const watch = new Watch();
    expect(seen(watch, [[1, "in_review"], [2, "in_progress"]])).toEqual([]);
    const alerts = seen(watch, [[1, "in_review"], [2, "in_review"], [3, "in_review"]]);
    expect(alerts.map((alert) => [alert.title, alert.body])).toEqual([["Task awaiting completion", "#2 Task 2"]]);
    expect(alerts[0]!.kind).toBe("completion");
    expect(alerts[0]!.taskId).toBe(2);
    expect(alerts[0]!.tag).toBe("task-2-completion");
  });

  test("tasks that start or finish after the baseline raise their own kinds", () => {
    const watch = new Watch();
    expect(seen(watch, [[1, "planned"], [2, "in_review"], [3, "in_progress"]])).toEqual([]);
    const alerts = seen(watch, [[1, "in_progress"], [2, "done", "completed"], [3, "done", "not_adopted"], [4, "in_progress"]]);
    expect(alerts.map((alert) => [alert.kind, alert.title, alert.tag])).toEqual([
      ["task_started", "Task started", "task-1-status"],
      ["task_finished", "Task done", "task-2-completion"],
      ["task_finished", "Task concluded without merging", "task-3-completion"],
    ]);
    expect(alerts.every((alert) => !alert.urgent)).toBe(true);
    expect(seen(watch, [[1, "planned"], [2, "done", "completed"]])).toEqual([]);
  });

  test("long titles are shortened and payloads have the service worker shape", () => {
    const watch = new Watch();
    const long = "x".repeat(1000);
    watch.tasks([{ id: taskId(1), status: "in_progress", resolution: null, title: long }]);
    const alert = watch.tasks([{ id: taskId(1), status: "in_review", resolution: null, title: long }])[0]!;
    expect([...alert.body].length).toBe(MAX_BODY_CHARS + 3);
    expect(Object.keys(alertPayload(alert)).sort()).toEqual(["body", "tag", "taskId", "title"]);
  });

  test("agent messages are urgent, shortened, and open their thread", () => {
    const notice = { channelId: chatChannelId(2), channel: "work", threadId: chatThreadId(5), thread: "Deploy", awaiting: false };
    const alert = agentMessageAlert("Helper", notice, 7, "가".repeat(1000), false);
    expect(alert.kind).toBe("agent_message");
    expect(alert.urgent).toBe(true);
    expect([...alert.body].length).toBe(MAX_BODY_CHARS + 3);
    expect(alertPayload(alert)).toEqual({
      title: "Helper in #work / Deploy",
      body: alert.body,
      tag: "chat-7",
      taskId: null,
      chat: true,
      channelId: 2,
      threadId: 5,
    });
    const inChannel = agentMessageAlert("Helper", { ...notice, threadId: null, thread: null }, 8, "hi", false);
    expect(inChannel.title).toBe("Helper in #work");
    expect(alertPayload(inChannel)).toMatchObject({ chat: true, channelId: 2, threadId: null });
    expect(agentMessageAlert("Helper", notice, 9, "Pick one", true).kind).toBe("important_message");
  });

  test("a thread waiting on an answer replaces the notification of its latest message", () => {
    const notice = { channelId: chatChannelId(2), channel: "work", threadId: chatThreadId(5), thread: "Deploy", awaiting: true };
    const alert = awaitingAlert("Helper", notice, { id: 7, body: "Which region?" });
    expect([alert.kind, alert.title, alert.body, alert.tag]).toEqual([
      "awaiting_answer",
      "Helper is waiting for your answer in #work / Deploy",
      "Which region?",
      "chat-7",
    ]);
    expect(alertPayload(alert)).toMatchObject({ chat: true, channelId: 2, threadId: 5 });
    expect([awaitingAlert("Helper", notice, null).body, awaitingAlert("Helper", notice, null).tag]).toEqual([
      "Deploy",
      "thread-5-awaiting",
    ]);
  });
});
