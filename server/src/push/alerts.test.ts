import { describe, expect, test } from "bun:test";

import { chatChannelId, chatThreadId } from "../domain/chat.ts";
import { taskId } from "../domain/model.ts";
import type { TaskStatus } from "../domain/status.ts";
import { MAX_BODY_CHARS, type Alert, Watch, agentMessageAlert, alertPayload } from "./alerts.ts";

function seen(watch: Watch, list: [number, TaskStatus][]): Alert[] {
  return watch.tasks(list.map(([id, status]) => ({ id: taskId(id), status, title: `Task ${id}` })));
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
    expect(seen(watch, [[2, "done"]])).toEqual([]);
  });

  test("long titles are shortened and payloads have the service worker shape", () => {
    const watch = new Watch();
    const long = "x".repeat(1000);
    watch.tasks([{ id: taskId(1), status: "in_progress", title: long }]);
    const alert = watch.tasks([{ id: taskId(1), status: "in_review", title: long }])[0]!;
    expect([...alert.body].length).toBe(MAX_BODY_CHARS + 3);
    expect(Object.keys(alertPayload(alert)).sort()).toEqual(["body", "tag", "taskId", "title"]);
  });

  test("agent messages are urgent, shortened, and open their thread", () => {
    const notice = { channelId: chatChannelId(2), channel: "work", threadId: chatThreadId(5), thread: "Deploy" };
    const alert = agentMessageAlert("Helper", notice, 7, "가".repeat(1000));
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
    const inChannel = agentMessageAlert("Helper", { ...notice, threadId: null, thread: null }, 8, "hi");
    expect(inChannel.title).toBe("Helper in #work");
    expect(alertPayload(inChannel)).toMatchObject({ chat: true, channelId: 2, threadId: null });
  });
});
