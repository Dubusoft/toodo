import { expect, test } from "bun:test";
import { taskId } from "../../domain/model.ts";
import { memoryStorage } from "../../storage/storage-fixtures.ts";
import { taskDetails } from "./queries.ts";
import * as R from "./requests.ts";
import { createTaskIn, storageWithWorkspace, toolFailure } from "./tool-fixtures.ts";
import {
  addGuideline, archiveWorkspace, createWorkspace, getGuidelines, listWorkspaces,
  removeGuideline, updateGuideline, updateWorkspace,
} from "./workspaces.ts";

test("Workspace metadata updates keep omitted fields and clear nulls", () => {
  const storage = memoryStorage();
  const created = createWorkspace(storage, R.createWorkspace({
    name: "Planning", description: "# Notes", repository: "discord:tasks", machine: "mac-mini",
  }));
  expect(created.machine).toBe("mac-mini");
  const updated = updateWorkspace(storage, R.updateWorkspace({ id: created.id, name: "Renamed" }));
  expect(updated.description).toBe("# Notes");
  expect(updated.repository).toBe("discord:tasks");
  expect(updated.machine).toBe("mac-mini");
  expect(updateWorkspace(storage, R.updateWorkspace({ id: created.id, machine: "local" })).machine).toBe("local");
  expect(listWorkspaces(storage)[0]!.machine).toBe("local");

  const cleared = updateWorkspace(storage, R.updateWorkspace({
    id: created.id, description: null, repository: null, machine: null,
  }));
  expect(cleared.name).toBe("Renamed");
  expect(cleared.description).toBeNull();
  expect(cleared.repository).toBeNull();
  expect(cleared.machine).toBeNull();
  expect(Object.keys(cleared).sort()).toEqual(["archivedAt", "description", "id", "machine", "name", "repository"]);
});

test("Archiving a workspace requires confirmation and no active work", () => {
  const { storage, ws } = storageWithWorkspace();
  const task = createTaskIn(storage, ws.id)("Add login");
  storage.setTaskStatus(taskId(task.id), "in_progress");
  const archive = (confirm: boolean) => archiveWorkspace(storage, R.archiveWorkspace({ id: ws.id, confirm }));

  const active = toolFailure(() => archive(true));
  expect(active.kind).toBe("rejected");
  expect(active.message).toContain("#1 (in_progress)");
  expect(active.message).toContain("pause_task");
  expect(listWorkspaces(storage)).toHaveLength(1);

  storage.concludeTask(taskId(task.id), "Not needed", null);
  const preview = archive(false);
  expect(preview.confirmed).toBe(false);
  expect(preview.message).toContain('"confirm": true');
  expect(listWorkspaces(storage)).toHaveLength(1);

  const archived = archive(true);
  expect(archived.confirmed).toBe(true);
  expect(archived.workspace.id).toBe(ws.id);
  expect(listWorkspaces(storage)).toEqual([]);
  expect(storage.archivedWorkspaces()).toHaveLength(1);
  expect(storage.reviewTasks().filter((stored) => stored.id === task.id)).toHaveLength(1);

  const again = toolFailure(() => archive(true));
  expect(again.code).toBe("workspaceNotFound");
  expect(again.message).toContain("list_workspaces");
});

test("Guidelines round trip and get_task includes them", () => {
  const { storage, ws } = storageWithWorkspace();
  const task = createTaskIn(storage, ws.id)("Add login");
  const added = addGuideline(storage, R.addGuideline({ workspace_id: ws.id, body: "  Ask before migrating " }));
  expect(added.kind).toBe("memory");
  expect(added.body).toBe("Ask before migrating");
  const rule = addGuideline(storage, R.addGuideline({ workspace_id: ws.id, kind: "rule", body: "Write English" }));
  const updated = updateGuideline(storage, R.updateGuideline({ id: added.id, kind: "rule" }));
  expect([updated.kind, updated.body]).toEqual(["rule", "Ask before migrating"]);

  const listed = getGuidelines(storage, R.getGuidelines({ workspace_id: ws.id }));
  expect(listed.workspace.name).toBe("toodo");
  expect(listed.guidelines).toEqual([updated, rule]);
  expect(taskDetails(storage, R.getTask({ id: task.id }).id).guidelines).toEqual(listed.guidelines);
  expect(removeGuideline(storage, R.removeGuideline({ id: rule.id }))).toEqual(rule);

  for (const run of [
    () => updateGuideline(storage, R.updateGuideline({ id: 999, body: "x" })),
    () => removeGuideline(storage, R.removeGuideline({ id: 999 })),
  ]) {
    const error = toolFailure(run);
    expect(error.code).toBe("guidelineNotFound");
    expect(error.message).toContain("get_guidelines");
  }
  for (const run of [
    () => getGuidelines(storage, R.getGuidelines({ workspace_id: 999 })),
    () => addGuideline(storage, R.addGuideline({ workspace_id: 999, body: "x" })),
  ]) {
    const error = toolFailure(run);
    expect(error.code).toBe("workspaceNotFound");
    expect(error.message).toContain("list_workspaces");
  }
});
