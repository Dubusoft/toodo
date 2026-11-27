import { expect, test } from "bun:test";
import { taskId } from "../domain/model.ts";
import { expectFailure, memoryStorage, newTask, workspace } from "./storage-fixtures.ts";
import type { TaskSearch } from "./search.ts";
import type { Storage } from "./storage.ts";

function search(storage: Storage, query: string, filters: Partial<TaskSearch> = {}) {
  return storage.searchTasks({ query, workspace: null, status: null, limit: 20, ...filters });
}

test("Search ranks title matches first and filters by workspace, status, and limit", () => {
  const storage = memoryStorage();
  const primary = workspace(storage);
  const other = workspace(storage, "Other");
  const titled = storage.createTask(newTask(primary, "Deploy the server", { description: "Use systemd" }));
  const described = storage.createTask(newTask(other, "Write docs", { description: "How to deploy it" }));
  storage.createTask(newTask(primary, "Unrelated", { description: "Nothing here" }));
  expect(search(storage, "deploy")).toEqual([titled.id, described.id]);
  expect(search(storage, "DEPLOY server")).toEqual([titled.id]);
  expect(search(storage, "deploy nothing")).toEqual([]);
  expect(search(storage, "   ")).toEqual([]);
  storage.setTaskStatus(described.id, "in_progress");
  expect(search(storage, "deploy", { workspace: other.id })).toEqual([described.id]);
  expect(search(storage, "deploy", { status: "planned" })).toEqual([titled.id]);
  expect(search(storage, "deploy", { limit: 1 })).toEqual([titled.id]);
});

test("Search matches words shorter than three characters with LIKE", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const deploy = storage.createTask(newTask(ws, "\uc11c\ubc84 \ubc30\ud3ec"));
  const dry = storage.createTask(newTask(ws, "Other", { description: "\ube68\ub798 \ub9d0\ub9ac\uae30" }));
  const ci = storage.createTask(newTask(ws, "Speed up CI", { description: "100% cached_build" }));
  expect(search(storage, "\ubc30\ud3ec")).toEqual([deploy.id]);
  expect(search(storage, "\ub9d0\ub9ac")).toEqual([dry.id]);
  expect(search(storage, "\ubc30\ud3ec \uc11c\ubc84")).toEqual([deploy.id]);
  expect(search(storage, "ci")).toEqual([ci.id]);
  expect(search(storage, "CI speed")).toEqual([ci.id]);
  expect(search(storage, "\ub9d0\ub9ac\uae30")).toEqual([dry.id]);
  expect(search(storage, "%")).toEqual([ci.id]);
  expect(search(storage, "d_")).toEqual([ci.id]);
  expect(search(storage, "_x")).toEqual([]);
});

test("Korean short words rank title matches first, and contiguous trigrams match", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const searchWord = "\uac80\uc0c9";
  const improve = "\uac1c\uc120";
  const feature = "\uae30\ub2a5";
  const titled = storage.createTask(newTask(ws, `${searchWord} ${feature} ${improve}`));
  const described = storage.createTask(newTask(ws, "Search documentation", {
    description: `${searchWord} ${feature}${improve} ${feature}\u00c9`,
  }));
  const shortOnly = storage.createTask(newTask(ws, "Search examples", { description: searchWord }));
  expect(search(storage, searchWord)).toEqual([titled.id, shortOnly.id, described.id]);
  expect(search(storage, `${searchWord}\u0085${improve}`)).toEqual([titled.id, described.id]);
  expect(search(storage, `${feature}\uac1c`)).toEqual([described.id]);
  // FTS5 folds the accented letter; SQLite's LIKE only folds ASCII.
  expect(search(storage, `${feature}\u00e9`)).toEqual([described.id]);
});

test("Search takes operators, quotes, and wildcards literally", () => {
  const storage = memoryStorage();
  const ws = workspace(storage);
  const quoted = storage.createTask(newTask(ws, 'Parse "quoted" (NOT* ready)'));
  const plain = storage.createTask(newTask(ws, "Ready to go"));
  for (const query of ['"quoted"', "(NOT*", "ready)", '"quoted" NOT*', "NOT", '"', "*"]) {
    expect(search(storage, query)).toEqual([quoted.id]);
  }
  for (const query of ["AND", "OR", "NEAR(a b)", "title:ready", "^re"]) {
    expect(search(storage, query)).toEqual([]);
  }
  expect(search(storage, "ready").sort((a, b) => a - b)).toEqual([quoted.id, plain.id]);
});

test("The search index follows edits, notes, refs, and deletes", () => {
  const storage = memoryStorage();
  const task = storage.createTask(newTask(workspace(storage), "Add login"));
  expect(search(storage, "login")).toEqual([task.id]);
  storage.updateTask({ ...task, title: "Add sign-in", description: "Replace passwords" });
  expect(search(storage, "login")).toEqual([]);
  storage.addTaskNote(task.id, "decision", "Use OAuth");
  storage.setTaskRefs(task.id, ["pr:42"]);
  expect(search(storage, "oauth")).toEqual([task.id]);
  expect(search(storage, "pr:42")).toEqual([task.id]);
  storage.deleteTask(task.id);
  expect(search(storage, "sign")).toEqual([]);
});

test("Related links go both ways across workspaces and never block", () => {
  const storage = memoryStorage();
  const earlier = storage.createTask(newTask(workspace(storage), "Research search"));
  const later = storage.createTask(newTask(workspace(storage, "Other"), "Add search"));
  storage.addRelated(later.id, earlier.id);
  storage.addRelated(earlier.id, later.id);
  expect(storage.listRelations()).toEqual([[earlier.id, later.id]]);
  storage.ensureReady(later.id);
  expect(storage.setTaskStatus(later.id, "in_progress").status).toBe("in_progress");
  expectFailure(() => storage.addRelated(later.id, later.id), { kind: "self_relation", task: later.id });
  expectFailure(() => storage.addRelated(later.id, taskId(99)), { kind: "task_not_found", task: 99 });
  storage.removeRelated(later.id, earlier.id);
  expect(storage.listRelations()).toEqual([]);
  storage.addRelated(later.id, earlier.id);
  storage.archiveTask(earlier.id);
  expect(storage.listRelations()).toEqual([]);
  storage.restoreTask(earlier.id);
  expect(storage.listRelations()).toEqual([[earlier.id, later.id]]);
  storage.deleteTask(earlier.id);
  expect(storage.listRelations()).toEqual([]);
});
