import { expect, test } from "bun:test";
import { criterionId, parseNewCriterion } from "../domain/criteria.ts";
import type { NewCriterion } from "../domain/criteria.ts";
import { expectFailure, memoryStorage, newTask, workspace } from "./storage-fixtures.ts";

const manual = (text: string) => parseNewCriterion(text, "manual", null);
const url = (target = "https://example.com") => parseNewCriterion("URL responds", "url", target);

function fixture(criteria: readonly NewCriterion[]) {
  const storage = memoryStorage();
  const task = storage.createTask(newTask(workspace(storage), "Write docs", { criteria }));
  return { storage, task };
}

test("Criteria are created in order and pending", () => {
  const { task } = fixture([url(), manual("Reviewed")]);
  expect(task.criteria.map(({ kind, state }) => [kind, state])).toEqual([
    ["url", "pending"], ["manual", "pending"],
  ]);
});

test("Checking criteria keeps status until an explicit transition", () => {
  const { storage, task } = fixture([manual("Guide written"), manual("Reviewed")]);
  const [first, second] = task.criteria;
  const planned = storage.checkCriterion(task.id, first.id, true, "docs/guide.md", "user");
  expect(planned.status).toBe("planned");
  expect(planned.criteria[0]).toMatchObject({
    state: "met", evidence: "docs/guide.md", checkedBy: "user", checkedAt: 100,
  });
  storage.startTask(task.id, null, []);
  const checked = storage.checkCriterion(task.id, second.id, true, "approved", "agent");
  expect(checked.status).toBe("in_progress");
  expect(checked.timeline.at(-1)?.status).toBe("in_progress");
  const unchecked = storage.checkCriterion(task.id, second.id, false, null, "user");
  expect(unchecked.status).toBe("in_progress");
  expect(unchecked.criteria[1]).toMatchObject({ state: "pending", checkedBy: null, checkedAt: null });
});

test("Automatic criteria and done tasks cannot be checked by hand", () => {
  const { storage, task } = fixture([url(), manual("Docs")]);
  const [automatic, docs] = task.criteria;
  expectFailure(() => storage.checkCriterion(task.id, automatic.id, true, null, "user"), {
    kind: "automatic_criterion", task: task.id, criterion: automatic.id, checkKind: "url",
  });
  expectFailure(() => storage.checkCriterion(task.id, criterionId(99), true, null, "user"), {
    kind: "criterion_not_found", task: task.id, criterion: 99,
  });
  storage.startTask(task.id, null, []);
  storage.completeTask(task.id, null, []);
  expectFailure(() => storage.checkCriterion(task.id, docs.id, true, null, "user"),
    { kind: "criteria_of_done_task", task: task.id });
  expectFailure(() => storage.setCriteria(task.id, []), { kind: "criteria_of_done_task", task: task.id });
});

test("Automatic checks stay met and keep the URL", () => {
  const target = "https://example.com";
  const { storage, task } = fixture([url(target)]);
  const { id } = task.criteria[0];
  storage.startTask(task.id, null, []);
  const [pending, stale] = storage.recordCriterionChecks(task.id, [
    { id, state: "met", evidence: "GET old: 200 OK", target: `${target}/old` },
  ]);
  expect(stale).toBe(false);
  expect(pending.criteria[0]).toMatchObject({ state: "pending", target });
  expect(storage.recordCriterionChecks(task.id, [{ id, state: "pending", evidence: null, target: null }])[1]).toBe(false);
  const [met, changed] = storage.recordCriterionChecks(task.id, [{ id, state: "met", evidence: "merged", target }]);
  expect(changed).toBe(true);
  expect(met.criteria[0]).toMatchObject({ state: "met", target, checkedBy: "toodo" });
  expect(met.status).toBe("in_progress");
  const [still, failed] = storage.recordCriterionChecks(task.id, [
    { id, state: "failed", evidence: "failure", target: null },
  ]);
  expect(failed).toBe(false);
  expect(still.criteria[0].state).toBe("met");
});

test("Setting criteria keeps unchanged ones and resets changed ones", () => {
  const { storage, task } = fixture([manual("Written"), url("https://a.test")]);
  const [written, live] = task.criteria;
  storage.checkCriterion(task.id, written.id, true, "done", "user");
  storage.recordCriterionChecks(task.id, [{ id: live.id, state: "met", evidence: null, target: null }]);
  const edited = storage.setCriteria(task.id, [
    { id: null, criterion: manual("Announced") },
    { id: live.id, criterion: url("https://b.test") },
    { id: written.id, criterion: manual("Written well") },
  ]);
  expect(edited.criteria.map(({ text, state, target }) => [text, state, target])).toEqual([
    ["Announced", "pending", null], ["URL responds", "pending", "https://b.test"], ["Written well", "met", null],
  ]);
  expect(storage.setCriteria(task.id, [{ id: written.id, criterion: manual("Written well") }])
    .criteria.map(({ id }) => id)).toEqual([written.id]);
  expectFailure(() => storage.setCriteria(task.id, [{ id: criterionId(99), criterion: manual("Missing") }]),
    { kind: "criterion_not_found", task: task.id, criterion: 99 });
});

test("A criterion is found with its task", () => {
  const { storage, task } = fixture([manual("Written")]);
  expect(storage.criterionTask(task.criteria[0].id)).toBe(task.id);
  expect(storage.criterionTask(criterionId(99))).toBeNull();
});

test("Criteria go with their task", () => {
  const { storage, task } = fixture([manual("Written")]);
  storage.deleteTask(task.id);
  expect(storage.criterionTask(task.criteria[0].id)).toBeNull();
});
