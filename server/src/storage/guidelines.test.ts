import { expect, test } from "bun:test";
import { guidelineId, workspaceId } from "../domain/model.ts";
import { expectFailure, memoryStorage, workspace } from "./storage-fixtures.ts";

test("Guidelines list rules before memories in the order they were added", () => {
  const storage = memoryStorage();
  const toodo = workspace(storage).id;
  const other = workspace(storage, "Other").id;
  const lesson = storage.addGuideline({ workspaceId: toodo, kind: "memory", body: "CI runs no tests" });
  storage.addGuideline({ workspaceId: toodo, kind: "rule", body: "Write English" });
  storage.addGuideline({ workspaceId: other, kind: "rule", body: "Elsewhere" });
  storage.addGuideline({ workspaceId: toodo, kind: "memory", body: "Bindings are generated" });
  storage.addGuideline({ workspaceId: toodo, kind: "rule", body: "Never commit" });
  expect(storage.listGuidelines(toodo).map(({ body }) => body)).toEqual([
    "Write English", "Never commit", "CI runs no tests", "Bindings are generated",
  ]);
  expect(lesson).toMatchObject({
    workspaceId: toodo, kind: "memory", body: "CI runs no tests", createdAt: 100, updatedAt: 100,
  });
  expectFailure(() => storage.listGuidelines(workspaceId(99)), { kind: "workspace_not_found", workspace: 99 });
});

test("Updating a guideline keeps its creation time", () => {
  const storage = memoryStorage();
  const toodo = workspace(storage).id;
  const lesson = storage.addGuideline({ workspaceId: toodo, kind: "memory", body: "Draft" });
  storage.setClock(() => 200);
  const updated = storage.updateGuideline(lesson.id, "rule", "Run clippy");
  expect(updated).toMatchObject({ kind: "rule", body: "Run clippy", createdAt: 100, updatedAt: 200 });
  expect(storage.getGuideline(lesson.id)).toEqual(updated);
});

test("Missing guidelines and workspaces are reported", () => {
  const storage = memoryStorage();
  const toodo = workspace(storage).id;
  const missing = guidelineId(42);
  expect(storage.getGuideline(missing)).toBeNull();
  expectFailure(() => storage.updateGuideline(missing, "rule", "Missing"), { kind: "guideline_not_found", guideline: 42 });
  expectFailure(() => storage.deleteGuideline(missing), { kind: "guideline_not_found", guideline: 42 });
  storage.archiveWorkspace(toodo);
  expectFailure(() => storage.addGuideline({ workspaceId: toodo, kind: "rule", body: "Orphan" }),
    { kind: "workspace_not_found", workspace: toodo });
});

test("Deleting returns the guideline and purging the workspace deletes the rest", () => {
  const storage = memoryStorage();
  const toodo = workspace(storage).id;
  const rule = storage.addGuideline({ workspaceId: toodo, kind: "rule", body: "Write English" });
  const memory = storage.addGuideline({ workspaceId: toodo, kind: "memory", body: "CI runs no tests" });
  expect(storage.deleteGuideline(rule.id)).toEqual(rule);
  expect(storage.listGuidelines(toodo)).toEqual([memory]);
  storage.archiveWorkspace(toodo);
  storage.purgeWorkspace(toodo);
  expect(storage.getGuideline(memory.id)).toBeNull();
});
