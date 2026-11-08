import { describe, expect, it } from "vitest";
import { taskStatusAlerts } from "@/lib/task-alerts";
import type { Task } from "@/lib/bindings";

describe("taskStatusAlerts", () => {
  const task = (id: number, title: string, status: Task["status"], extra: Partial<Task> = {}) =>
    ({ id, title, status, dependsOn: [], resolution: null, ...extra }) as unknown as Task;
  const login = task(1, "Add login", "planned");

  it("alerts once for each task whose status changed", () => {
    const logout = task(2, "Add logout", "in_review");
    expect(
      taskStatusAlerts(
        [login, logout, task(3, "Add search", "planned")],
        [{ ...login, status: "in_progress" }, { ...logout, status: "done", resolution: "merged" }, task(3, "Add search", "planned")],
      ),
    ).toEqual([
      { title: "Task started", body: "#1 Add login: Planned -> In progress" },
      { title: "Task done", body: "#2 Add logout: Awaiting completion -> Done" },
    ]);
  });

  it("words the review, not adopted, and pause transitions", () => {
    const started = { ...login, status: "in_progress" } as Task;
    expect(taskStatusAlerts([started], [{ ...started, status: "in_review" }])).toEqual([
      { title: "Task awaiting completion", body: "#1 Add login: In progress -> Awaiting completion" },
    ]);
    expect(taskStatusAlerts([started], [{ ...started, status: "done", resolution: "not_adopted" }])).toEqual([
      { title: "Task concluded without merging", body: "#1 Add login: In progress -> Not adopted" },
    ]);
    expect(taskStatusAlerts([started], [{ ...started, status: "done", resolution: "completed" }])).toEqual([
      { title: "Task done", body: "#1 Add login: In progress -> Completed" },
    ]);
    expect(taskStatusAlerts([started], [login])).toEqual([
      { title: "Task paused", body: "#1 Add login: In progress -> Planned" },
    ]);
  });

  it("stays quiet for unchanged, new, and removed tasks", () => {
    expect(taskStatusAlerts([login], [login])).toEqual([]);
    expect(taskStatusAlerts([], [login])).toEqual([]);
    expect(taskStatusAlerts([login], [])).toEqual([]);
  });
});
