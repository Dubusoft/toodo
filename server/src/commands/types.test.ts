import { expect, test } from "bun:test";
import { guidelineId, workspaceId } from "../domain/model.ts";
import { memoryStorage, workspace } from "../storage/storage-fixtures.ts";
import { commandFailure as failure } from "./command-fixtures.ts";
import { addGuideline } from "./guidelines.ts";
import { GUIDELINE_BODY_LIMIT, guideline, guidelineBody, MAX_TASK_PAGE, taskQuery } from "./types.ts";
import { createWorkspace } from "./workspaces.ts";

test("Workspace metadata is stored without interpreting the repository", () => {
  const storage = memoryStorage();
  const created = createWorkspace(storage, { name: " toodo ", description: "# Planning", repository: "discord:tasks" });
  expect(created).toEqual({ id: created.id, name: "toodo", description: "# Planning", repository: "discord:tasks", archivedAt: null });
  expect(failure(() => createWorkspace(storage, { name: " ", description: null, repository: null })).code).toBe("invalidInput");
});

test("A task list filter bounds the page and the IDs", () => {
  const invalid = (filter: Parameters<typeof taskQuery>[0]) => failure(() => taskQuery(filter)).code === "invalidInput";
  expect(invalid({ limit: 0 })).toBe(true);
  expect(invalid({ limit: MAX_TASK_PAGE + 1 })).toBe(true);
  expect(taskQuery({ limit: 1 }).limit).toBe(1);
  expect(taskQuery({ limit: MAX_TASK_PAGE }).limit).toBe(MAX_TASK_PAGE);
  const ids = (count: number) => ({ ids: Array.from({ length: count }, (_, index) => index + 1) });
  expect(invalid(ids(MAX_TASK_PAGE + 1))).toBe(true);
  expect(taskQuery(ids(MAX_TASK_PAGE)).ids).toHaveLength(MAX_TASK_PAGE);
  expect(taskQuery({ statuses: [] }).statuses).toEqual([]);
});

test("Guideline bodies are trimmed and limited", () => {
  expect(guidelineBody("  Write English \n")).toBe("Write English");
  expect(failure(() => guidelineBody(" \n ")).message).toContain("in body");
  const longest = "é".repeat(GUIDELINE_BODY_LIMIT);
  expect(guidelineBody(longest)).toBe(longest);
  const error = failure(() => guidelineBody(`${longest}x`));
  expect(error.code).toBe("invalidInput");
  expect(error.message).toContain("add_guideline");
});

test("Guidelines use camel case keys and snake case kinds", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const added = addGuideline(storage, { workspaceId: ws.id, kind: "memory", body: " Lesson " });
  expect([added.workspaceId, added.kind, added.body]).toEqual([ws.id, "memory", "Lesson"]);
  const stored = {
    id: guidelineId(7), workspaceId: workspaceId(3), kind: "rule" as const, body: "Rule", createdAt: 1, updatedAt: 2,
  };
  expect(guideline(stored)).toEqual({ id: 7, workspaceId: 3, kind: "rule", body: "Rule", createdAt: 1, updatedAt: 2 });
});
