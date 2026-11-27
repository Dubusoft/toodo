import { expect, test } from "bun:test";
import type { Task as ModelTask, Workspace } from "../domain/model.ts";
import type { Storage } from "../storage/storage.ts";
import { finish, memoryStorage, newTask, stored, workspace } from "../storage/storage-fixtures.ts";
import { commandFailure } from "./command-fixtures.ts";
import { reopenTask, setCompletionNote, setTaskOutcome, pauseTask, updateTask } from "./tasks.ts";
import { task } from "./types.ts";

function storageWithTask(): [Storage, ModelTask, Workspace] {
  const storage = memoryStorage();
  const ws = workspace(storage, "toodo");
  const created = storage.createTask(newTask(ws, "Add commands"));
  return [storage, storage.setTaskRefs(created.id, ["branch:feat/add-commands-1"]), ws];
}

function edit(id: number, title: string): Parameters<typeof updateTask>[1] {
  return {
    status: null, id, taskType: "feat", title, description: "",
    estimate: null, dueDate: null, labels: null, autopilot: null, criteria: null,
  };
}

test("Editing a task keeps its workflow fields", () => {
  const [storage, original] = storageWithTask();
  const edited = updateTask(storage, {
    ...edit(original.id, "  Fix commands "),
    taskType: "fix",
    description: "details",
    estimate: { unit: "days", amount: 3 },
    dueDate: " 2026-10-31 ",
  });
  expect(edited.title).toBe("Fix commands");
  expect(edited.dueDate).toBe("2026-10-31");
  expect(edited.estimate?.amount).toBe(3);
  expect(edited.taskType).toBe("fix");
  expect(edited.refs).toEqual(["branch:feat/add-commands-1"]);
  expect(task(stored(storage, original.id))).toEqual(edited);
});

test("Pausing moves a started task back to planned and keeps its branch", () => {
  const [storage, original] = storageWithTask();
  expect(commandFailure(() => pauseTask(storage, original.id)).kind).toBe("rejected");
  for (const status of ["in_progress", "in_review"] as const) {
    storage.setTaskStatus(original.id, "in_progress");
    if (status === "in_review") storage.setTaskStatus(original.id, status);
    const paused = pauseTask(storage, original.id);
    expect(paused.status).toBe("planned");
    expect(paused.refs).toEqual(["branch:feat/add-commands-1"]);
  }
});

test("Only a done task gets a trimmed completion note, and an empty one clears it", () => {
  const [storage, original] = storageWithTask();
  expect(commandFailure(() => setCompletionNote(storage, original.id, "Shipped")).kind).toBe("rejected");
  expect(commandFailure(() => setCompletionNote(storage, 999, "Shipped")).kind).toBe("notFound");
  finish(storage, original.id);
  const noted = setCompletionNote(storage, original.id, "  Cut login time in half\n");
  expect(noted.completionNote).toBe("Cut login time in half");
  expect(task(stored(storage, original.id))).toEqual(noted);
  expect(setCompletionNote(storage, original.id, " ").completionNote).toBeNull();
  expect(stored(storage, original.id).completionNote).toBeNull();
});

test("A planned task is concluded without starting it", () => {
  const [storage, original] = storageWithTask();
  expect(() => storage.completeTask(original.id, null, [])).toThrow("planned");
  const concluded = task(storage.concludeTask(original.id, "Not worth it", null));
  expect(concluded.status).toBe("done");
  expect(concluded.resolution).toBe("not_adopted");
  expect(concluded.completionNote).toBe("Not worth it");
  expect(concluded.timeline.every((event) => event.status !== "in_progress")).toBe(true);
  expect(concluded.timeline.at(-1)?.status).toBe("done");
});

test("The conclusion of a task that was not adopted can be edited but not cleared", () => {
  const [storage, original] = storageWithTask();
  storage.setTaskStatus(original.id, "in_progress");
  storage.concludeTask(original.id, "Too slow", null);
  expect(commandFailure(() => setCompletionNote(storage, original.id, " ")).kind).toBe("invalidInput");
  const edited = setCompletionNote(storage, original.id, "Twice as slow");
  expect(edited.completionNote).toBe("Twice as slow");
  expect(edited.resolution).toBe("not_adopted");
});

test("Reopening a concluded task pauses it and keeps the earlier outcome as a note", () => {
  const [storage, original] = storageWithTask();
  expect(commandFailure(() => reopenTask(storage, original.id, "Too early")).kind).toBe("rejected");
  storage.setTaskStatus(original.id, "in_progress");
  storage.concludeTask(original.id, "Too slow", null);
  expect(commandFailure(() => reopenTask(storage, original.id, "  ")).kind).toBe("invalidInput");

  const reopened = reopenTask(storage, original.id, " The cache helps after all ");

  expect(reopened.status).toBe("planned");
  expect(reopened.resolution).toBeNull();
  expect(reopened.completionNote).toBeNull();
  expect(reopened.refs).toEqual([...original.refs]);
  expect(reopened.notes.at(-1)?.body).toBe("Reopened: The cache helps after all\nIt was done as not_adopted: Too slow");
  const last = reopened.timeline.at(-1);
  expect(last?.reopened).toBe(true);
  expect(last?.status).toBe("planned");
  expect(reopened.milestones.completedAt).toBeNull();
  expect(reopened.milestones.reopenedAt).toBe(last?.at ?? -1);
  expect(reopened.milestones.pausedAt).toBe(last?.at ?? -1);
  expect(task(stored(storage, original.id))).toEqual(reopened);
  // A reopened task is started again like a paused one.
  storage.setTaskStatus(original.id, "in_progress");
});

test("A task whose dependents started on it is not reopened", () => {
  const [storage, original, ws] = storageWithTask();
  const dependent = storage.createTask(newTask(ws, "Build on commands"));
  finish(storage, original.id);
  storage.addDependency(dependent.id, original.id);
  storage.setTaskStatus(dependent.id, "in_progress");
  // Pausing the dependent does not undo that it started.
  storage.setTaskStatus(dependent.id, "planned");
  const before = stored(storage, original.id);

  const error = commandFailure(() => reopenTask(storage, original.id, "Missed a case"));

  expect(error.kind).toBe("rejected");
  expect(error.message).toContain(`#${dependent.id} (planned)`);
  expect(error.message).toContain("Set outcome");
  expect(stored(storage, original.id)).toEqual(before);
});

test("The outcome of a done task is corrected with a note and a record of the change", () => {
  const [storage, original] = storageWithTask();
  expect(commandFailure(() => setTaskOutcome(storage, original.id, "not_adopted", "Dropped")).kind).toBe("rejected");
  finish(storage, original.id);
  storage.setCompletionNote(original.id, "Shipped");
  const timeline = stored(storage, original.id).timeline;

  expect(commandFailure(() => setTaskOutcome(storage, original.id, "not_adopted", " ")).kind).toBe("invalidInput");
  expect(commandFailure(() => setTaskOutcome(storage, original.id, "merged", "Merged")).message).toContain("already done as merged");

  const corrected = setTaskOutcome(storage, original.id, "not_adopted", " Reverted the next day ");
  expect(corrected.resolution).toBe("not_adopted");
  expect(corrected.completionNote).toBe("Reverted the next day");
  expect(corrected.notes.at(-1)?.body).toBe(
    "Outcome changed from merged to not_adopted: Reverted the next day\nEarlier completion note: Shipped",
  );
  expect(stored(storage, original.id).timeline).toEqual(timeline);

  // Nothing records a merge, so merged is not an outcome it can claim.
  const merged = commandFailure(() => setTaskOutcome(storage, original.id, "merged", "Merged"));
  expect(merged.kind).toBe("rejected");
  expect(merged.message).toContain("completed");
  expect(setTaskOutcome(storage, original.id, "completed", "Deployed by hand").resolution).toBe("completed");
});

test("Editing a task rejects an empty title and an unknown task", () => {
  const [storage, original] = storageWithTask();
  expect(commandFailure(() => updateTask(storage, edit(original.id, " "))).kind).toBe("invalidInput");
  expect(commandFailure(() => updateTask(storage, edit(999, "Other"))).kind).toBe("notFound");
  expect(stored(storage, original.id)).toEqual(original);
});
