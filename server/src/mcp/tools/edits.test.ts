import { expect, test } from "bun:test";
import { task as taskShape } from "../../commands/types.ts";
import { taskId } from "../../domain/model.ts";
import { finish, stored } from "../../storage/storage-fixtures.ts";
import { ArgumentError } from "../args.ts";
import tools from "../tools.json";
import { createPlan, createTask } from "./create.ts";
import { addCriterion, addNote, checkCriterion, removeCriterion, updateTask } from "./edits.ts";
import { listTasks, searchTasks, taskDetails } from "./queries.ts";
import * as R from "./requests.ts";
import { createTaskIn, storageWithWorkspace, toolFailure } from "./tool-fixtures.ts";

function withCheckedCriterion() {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const task = create("Schema");
  const first = task.criteria[0].id;
  const updated = updateTask(storage, R.updateTask({ id: task.id, criteria: [
    { id: first }, { text: "Docs updated", kind: "manual" },
  ] }));
  const manual = updated.criteria[1].id;
  const checked = checkCriterion(storage, R.checkCriterion({ id: manual, evidence: "docs/guide.md" }));
  return { storage, create, task: checked, first, manual };
}

test("Updating a task changes only the given fields", () => {
  const { storage, ws } = storageWithWorkspace();
  const task = createTaskIn(storage, ws.id)("Schema");
  const updated = updateTask(storage, R.updateTask({ id: task.id, description: "Add tables" }));
  expect([updated.title, updated.taskType, updated.description]).toEqual(["Schema", "feat", "Add tables"]);
});

test("Updating a done task leaves it as it was finished", () => {
  const { storage, ws } = storageWithWorkspace();
  const { id } = createTaskIn(storage, ws.id)("Schema");
  finish(storage, taskId(id));
  const done = taskShape(stored(storage, taskId(id)));
  const request = R.updateTask({ id, title: "Renamed", description: "Other" });
  const error = toolFailure(() => updateTask(storage, request));
  expect(error.kind).toBe("rejected");
  expect(error.message).toContain("add_progress_note");
  expect(taskShape(stored(storage, taskId(id)))).toEqual(done);
});

test("Adding a criterion appends it and keeps existing criteria with their evidence", () => {
  const { storage, task } = withCheckedCriterion();
  const added = addCriterion(storage, R.addCriterion({
    task_id: task.id, text: "Deployed", kind: "url", target: "https://example.com",
  }));
  expect(added.criteria.slice(0, 2)).toEqual(task.criteria);
  expect(added.criteria[2]).toMatchObject({ kind: "url", target: "https://example.com", state: "pending" });
  for (const kind of ["pr_merged", "pr_open_ci_green", "branch_merged_locally", "command"]) {
    expect(() => R.addCriterion({ task_id: task.id, text: "Removed", kind })).toThrow(ArgumentError);
  }
});

test("Removing a criterion deletes only that criterion", () => {
  const { storage, create, task, first, manual } = withCheckedCriterion();
  const other = create("Other");
  const remove = (request: object) => removeCriterion(storage, R.removeCriterion(request));
  expect(toolFailure(() => remove({ task_id: other.id, criterion_id: manual })).message).toContain("belongs to task");
  expect(toolFailure(() => remove({ criterion_id: 999 })).kind).toBe("notFound");
  expect(remove({ id: manual }).criteria).toEqual(task.criteria.slice(0, 1));
  expect(remove({ criterion_id: first }).criteria).toEqual([]);
  expect(stored(storage, taskId(other.id)).criteria).toHaveLength(1);
});

test("Criteria given by ID alone are kept with their evidence", () => {
  const { storage, task, first, manual } = withCheckedCriterion();
  const edit = (criteria: readonly object[]) => updateTask(storage, R.updateTask({ id: task.id, criteria }));
  const kept = edit([{ id: first }, { id: manual }, { text: "Released", kind: "manual" }]);
  expect(kept.criteria.slice(0, 2)).toEqual(task.criteria);
  expect(kept.criteria[2]?.text).toBe("Released");

  const renamed = edit([{ id: first }, { id: manual, text: "Guide updated" }]);
  expect(renamed.criteria[1]).toMatchObject({ text: "Guide updated", state: "met", evidence: "docs/guide.md" });
  const error = toolFailure(() => edit([{ id: first }, { text: "No kind" }]));
  expect(error.kind).toBe("invalidInput");
  expect(error.message).toContain("needs text and kind");
});

test("Criteria with a repeated or foreign ID are rejected", () => {
  const { storage, create, task, first } = withCheckedCriterion();
  const other = create("API");
  const foreign = other.criteria[0].id;
  const edit = (id: number) => updateTask(storage, R.updateTask({ id: task.id, criteria: [{ id: first }, { id }] }));
  const repeated = toolFailure(() => edit(first));
  expect(repeated.kind).toBe("invalidInput");
  expect(repeated.message).toBe(`criterion ${first} appears twice; send each criterion once`);
  const error = toolFailure(() => edit(foreign));
  expect(error.kind).toBe("invalidInput");
  expect(error.message.startsWith(`criterion ${foreign} belongs to task ${other.id}, not task ${task.id}; call get_task`)).toBe(true);
  expect(taskShape(stored(storage, taskId(task.id))).criteria).toEqual(task.criteria);
});

test("Omitting criteria from the replacement list removes them", () => {
  const { storage, task, manual } = withCheckedCriterion();
  const removed = updateTask(storage, R.updateTask({ id: task.id, criteria: [{ id: manual }] }));
  expect(removed.criteria).toEqual(task.criteria.slice(1));
});

test("Checking a criterion finds its owning task", () => {
  const { storage, create, task, manual } = withCheckedCriterion();
  const other = create("API");
  const check = (request: object) => checkCriterion(storage, R.checkCriterion(request));
  expect(task.criteria[1]).toMatchObject({ state: "met", evidence: "docs/guide.md" });

  const wrongOwner = toolFailure(() => check({ task_id: other.id, criterion_id: manual, met: false }));
  expect(wrongOwner.kind).toBe("invalidInput");
  expect(wrongOwner.message.startsWith(`criterion ${manual} belongs to task ${task.id}, not task ${other.id}`)).toBe(true);
  expect(check({ task_id: task.id, criterion_id: manual, met: false }).criteria[1]?.state).toBe("pending");
  expect(toolFailure(() => check({ id: 999, evidence: "x" })).kind).toBe("notFound");
});

test("Estimates and due dates are set, kept when omitted, and cleared by null", () => {
  const { storage, ws } = storageWithWorkspace();
  const planned = { unit: "hours", amount: 2.5 } as const;
  const task = createTask(storage, R.createTask({
    workspace_id: ws.id, task_type: "feat", title: "Schema", estimate: planned, due_date: "2026-10-20",
  }));
  expect([task.estimate, task.dueDate]).toEqual([planned, "2026-10-20"]);
  const edit = (fields: object) => updateTask(storage, R.updateTask({ id: task.id, ...fields }));
  const kept = edit({ title: "Tables" });
  expect([kept.estimate, kept.dueDate]).toEqual([planned, "2026-10-20"]);
  const weeks = edit({ estimate: { unit: "weeks", amount: 3 }, due_date: null });
  expect([weeks.estimate, weeks.dueDate]).toEqual([{ unit: "weeks", amount: 3 }, null]);
  const cleared = edit({ estimate: null });
  expect(cleared.estimate).toBeNull();
  expect(taskShape(stored(storage, taskId(task.id)))).toEqual(cleared);

  for (const invalid of [{ due_date: "2026-02-30" }, { estimate: { unit: "hours", amount: 0 } }]) {
    expect(toolFailure(() => edit(invalid)).kind, JSON.stringify(invalid)).toBe("invalidInput");
  }
  expect(taskShape(stored(storage, taskId(task.id)))).toEqual(cleared);
});

test("Autopilot is set on create, filterable, kept when marked again, and clearable", () => {
  const { storage, ws } = storageWithWorkspace();
  const plain = createTaskIn(storage, ws.id)("Plain");
  expect([plain.autopilot, plain.autopilotAt]).toEqual([false, null]);
  const flagged = createTask(storage, R.createTask({
    workspace_id: ws.id, task_type: "feat", title: "Flagged", autopilot: true,
  }));
  expect(flagged.autopilot).toBe(true);
  const since = flagged.autopilotAt;
  expect(since).not.toBeNull();
  const listed = (autopilot: boolean | null) => listTasks(storage, R.listTasks({ autopilot })).map((task) => task.id);
  expect(listed(true)).toEqual([flagged.id]);
  expect(listed(false)).toEqual([plain.id]);
  expect(listed(null)).toEqual([plain.id, flagged.id]);

  const edit = (id: number, fields: object) => updateTask(storage, R.updateTask({ id, ...fields }));
  expect(edit(flagged.id, { title: "Still" }).autopilotAt).toBe(since);
  expect(edit(flagged.id, { autopilot: true }).autopilotAt).toBe(since);
  const cleared = edit(flagged.id, { autopilot: false });
  expect([cleared.autopilot, cleared.autopilotAt]).toEqual([false, null]);
  const marked = edit(plain.id, { autopilot: true });
  expect(marked.autopilot).toBe(true);
  expect(marked.autopilotAt).not.toBeNull();
  expect(listed(true)).toEqual([plain.id]);

  const fields = { workspace_id: ws.id, task_type: "feat" };
  const created = createPlan(storage, R.createPlan({ tasks: [
    { ...fields, key: "a", title: "A", autopilot: true }, { ...fields, key: "b", title: "B" },
  ] }));
  expect(created.tasks.map((task) => task.autopilot)).toEqual([true, false]);
});

test("Labels are set, kept when omitted, replaced, and cleared", () => {
  const { storage, ws } = storageWithWorkspace();
  const task = createTask(storage, R.createTask({
    workspace_id: ws.id, task_type: "feat", title: "Schema", labels: [" search ", "q4-goal", "search"],
  }));
  expect(task.labels).toEqual(["q4-goal", "search"]);
  const edit = (fields: object) => updateTask(storage, R.updateTask({ id: task.id, ...fields }));
  expect(edit({ title: "Tables" }).labels).toEqual(["q4-goal", "search"]);
  expect(edit({ labels: ["review"] }).labels).toEqual(["review"]);

  const invalid = toolFailure(() => edit({ labels: ["a,b"] }));
  expect(invalid.kind).toBe("invalidInput");
  expect(invalid.message).toContain("own list item");
  expect(toolFailure(() => edit({ title: "Renamed", labels: [""] })).kind).toBe("invalidInput");
  const current = stored(storage, taskId(task.id));
  expect([current.title, current.labels]).toEqual(["Tables", ["review"]]);
  expect(edit({ labels: [] }).labels).toEqual([]);
});

test("Refs are kept in order, appended, removed, and searched", () => {
  const { storage, ws } = storageWithWorkspace();
  const task = createTask(storage, R.createTask({
    workspace_id: ws.id, task_type: "feat", title: "Schema",
    refs: [" lane:schema-lane ", "discord:42", "lane:schema-lane"],
  }));
  expect(task.refs).toEqual(["lane:schema-lane", "discord:42"]);
  const edit = (fields: object) => updateTask(storage, R.updateTask({ id: task.id, ...fields }));
  expect(edit({ title: "Tables" }).refs).toEqual(["lane:schema-lane", "discord:42"]);
  const changed = edit({ refs: ["pr:7", "discord:42"], remove_refs: ["lane:schema-lane"] });
  expect(changed.refs).toEqual(["discord:42", "pr:7"]);
  expect(toolFailure(() => edit({ title: "Renamed", refs: ["a\nb"] })).kind).toBe("invalidInput");
  expect(taskShape(stored(storage, taskId(task.id)))).toEqual(changed);

  const search = () => searchTasks(storage, R.searchTasks({ query: "pr:7" }));
  expect(search().map((hit) => hit.id)).toEqual([task.id]);
  edit({ remove_refs: ["pr:7"] });
  expect(search()).toEqual([]);
});

test("Decision notes are kept apart from progress notes", () => {
  const { storage, ws } = storageWithWorkspace();
  const task = createTaskIn(storage, ws.id)("Schema");
  const note = (fields: object) => {
    const request = R.addProgressNote({ task_id: task.id, ...fields });
    return addNote(storage, request.kind ?? "progress", request);
  };
  note({ note: "Drafted tables" });
  const noted = note({ kind: "decision", note: "Chose SQLite over files" });
  expect(noted.notes.map((entry) => entry.kind)).toEqual(["progress", "decision"]);
  expect(() => R.addProgressNote({ task_id: task.id, kind: "blocker", note: "x" })).toThrow(ArgumentError);
});

test("Notes are trimmed and a blank note or an unknown task adds none", () => {
  const { storage, ws } = storageWithWorkspace();
  const task = createTaskIn(storage, ws.id)("Schema");
  addNote(storage, "progress", R.addNote({ task_id: task.id, note: "  Chose SQLite \n" }));
  const noted = addNote(storage, "blocker", R.addNote({ task_id: task.id, note: "No access" }));
  expect(noted.notes.map((entry) => [entry.kind, entry.body])).toEqual([
    ["progress", "Chose SQLite"], ["blocker", "No access"],
  ]);
  const blank = toolFailure(() => addNote(storage, "blocker", R.addNote({ task_id: task.id, note: " \n" })));
  expect(blank.kind).toBe("invalidInput");
  const missing = toolFailure(() => addNote(storage, "progress", R.addNote({ task_id: 99, note: "x" })));
  expect(missing.kind).toBe("notFound");
  expect(taskDetails(storage, R.getTask({ id: task.id }).id).task.notes).toHaveLength(2);
});

test("Unknown arguments are rejected with the accepted ones", () => {
  expect(() => R.updateTask({ id: 1, dueDate: "2026-11-01" })).toThrow(ArgumentError);
  expect(() => R.updateTask({ id: 1, dueDate: "2026-11-01" })).toThrow(
    new ArgumentError("unknown field `dueDate`, expected one of `id`, `task_type`, `status`, `title`, `description`, `estimate`, `due_date`, `labels`, `refs`, `remove_refs`, `autopilot`, `criteria`"),
  );
  const nested = { id: 1, criteria: [{ idd: 7, text: "Docs updated", kind: "manual" }] };
  expect(() => R.updateTask(nested)).toThrow(ArgumentError);
  expect(() => R.updateTask(nested)).toThrow(
    new ArgumentError("criteria[0]: unknown field `idd`, expected one of `id`, `text`, `kind`, `target`"),
  );
});

test("The update_task patch schema advertises no null defaults", () => {
  const properties = tools.find((tool) => tool.name === "update_task")?.inputSchema.properties;
  if (properties === undefined) throw new Error("Missing update_task schema properties");
  for (const [name, property] of Object.entries(properties)) {
    expect(property, name).not.toHaveProperty("default", null);
  }
});
