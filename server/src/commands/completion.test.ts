import { expect, onTestFinished, test } from "bun:test";
import { parseNewCriterion } from "../domain/criteria.ts";
import type { CriterionId } from "../domain/criteria.ts";
import type { Task, TaskId } from "../domain/model.ts";
import { outbound } from "../net.ts";
import type { Storage } from "../storage/storage.ts";
import { memoryStorage, newTask, stored, workspace } from "../storage/storage-fixtures.ts";
import { complete, conclude } from "./completion.ts";
import { commandFailure, commandRejection } from "./command-fixtures.ts";

const local = outbound(5_000, true);

function fixture(): [Storage, TaskId] {
  const storage = memoryStorage();
  const task = storage.createTask(newTask(workspace(storage, "Tasks"), "Record work"));
  storage.startTask(task.id, "Ready to work", ["lane:test"]);
  return [storage, task.id];
}

/** Sets the task's only criterion to a URL one with `target`, keeping `criterion` if given. */
function setUrl(storage: Storage, id: TaskId, criterion: CriterionId | null, target: string): Task {
  return storage.setCriteria(id, [{ id: criterion, criterion: parseNewCriterion("Deployed", "url", target) }]);
}

/** A local server that answers each GET of `/ready` with the next of `answers`, after
 * running what goes with it; `requests` counts the requests it got. */
function serve(answers: Array<{ status: number; headers?: Record<string, string>; during?: () => void }>) {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/ready");
      const answer = answers[requests];
      requests += 1;
      if (answer === undefined) return new Response(null, { status: 500 });
      answer.during?.();
      return new Response(null, { status: answer.status, headers: answer.headers });
    },
  });
  onTestFinished(() => server.stop(true));
  return { target: `http://127.0.0.1:${server.port}/ready`, requests: () => requests };
}

test("complete records reason refs and releases dependents", async () => {
  const [storage, id] = fixture();
  const done = await complete(storage, id, "Finished", ["pr:123"]);
  expect(done.status).toBe("done");
  expect(done.resolution).toBe("completed");
  expect(done.refs).toEqual(["lane:test", "pr:123"]);
  expect(done.timeline.at(-1)?.reason).toBe("Finished");
  expect(storage.listCommitRecords(id)).toEqual([]);
});

test("a blank note is refused before anything is recorded", async () => {
  const [storage, id] = fixture();
  const error = await commandRejection(() => complete(storage, id, "  ", []));
  expect(error.code).toBe("invalidInput");
  expect(stored(storage, id).status).toBe("in_progress");
});

test("conclusion can record work shipped with a completed task", async () => {
  const [storage, id] = fixture();
  const own = commandFailure(() => conclude(storage, id, "Own work", "shipped_with", id));
  expect(own.code).toBe("invalidInput");
  expect(own.message).toContain(`complete_task with id ${id}`);
  const other = storage.createTask(newTask(workspace(storage, "Other"), "Ship work")).id;
  storage.startTask(other, null, []);
  const unshipped = commandFailure(() => conclude(storage, id, "Shipped together", "shipped_with", other));
  expect(unshipped.code).toBe("rejected");
  await complete(storage, other, null, []);
  const done = conclude(storage, id, "Shipped together", "shipped_with", other);
  expect(done.refs).toContain(`task:${other}`);
  expect(done.resolution).toBe("completed");
});

test("manual criteria must be checked before completion", async () => {
  const [storage, id] = fixture();
  storage.setCriteria(id, [{ id: null, criterion: parseNewCriterion("Reviewed", "manual", null) }]);
  const error = await commandRejection(() => complete(storage, id, "Finished", ["lane:done"]));
  expect(error.message).toContain("check_criterion");
  const task = stored(storage, id);
  expect(task.status).toBe("in_progress");
  expect(task.refs).toEqual(["lane:test"]);
  const [criterion] = task.criteria;
  if (criterion === undefined) throw new Error("Missing criterion");
  storage.checkCriterion(id, criterion.id, true, "Reviewed", "agent");
  expect(stored(storage, id).status).toBe("in_progress");
  expect((await complete(storage, id, "Finished", [])).status).toBe("done");
});

test("URL criteria are rechecked with HTTP and do not require execution tools", async () => {
  const server = serve([{ status: 503 }, { status: 200 }]);
  const [storage, id] = fixture();
  const [criterion] = setUrl(storage, id, null, server.target).criteria;
  if (criterion === undefined) throw new Error("Missing criterion");
  storage.recordCriterionChecks(id, [{ id: criterion.id, state: "met", evidence: "Earlier response", target: null }]);
  const error = await commandRejection(() => complete(storage, id, null, [], local));
  expect(error.message).toContain("complete_task");
  expect(stored(storage, id).criteria[0]?.state).toBe("failed");
  expect(stored(storage, id).criteria[0]?.evidence).toBe(
    `GET ${server.target}: 503 Service Unavailable (redirects are not followed); fix the URL target with update_task, then call complete_task again`,
  );
  const done = await complete(storage, id, null, [], local);
  expect(done.status).toBe("done");
  expect(done.criteria[0]?.state).toBe("met");
  expect(done.criteria[0]?.evidence).toBe(`GET ${server.target}: 200 OK`);
  expect(server.requests()).toBe(2);
});

test("a URL check does not count for a target changed during it", async () => {
  let id = 0 as TaskId;
  let storage: Storage | undefined;
  let criterion: CriterionId | null = null;
  const server = serve([
    {
      status: 200,
      during: () => {
        if (storage !== undefined) setUrl(storage, id, criterion, "https://example.com/new");
      },
    },
  ]);
  [storage, id] = fixture();
  criterion = setUrl(storage, id, null, server.target).criteria[0]?.id ?? null;
  const error = await commandRejection(() => complete(storage, id, null, [], local));
  expect(error.message).toContain("fix its URL");
  const task = stored(storage, id);
  expect(task.status).toBe("in_progress");
  expect(task.criteria[0]?.target).toBe("https://example.com/new");
  expect(task.criteria[0]?.state).toBe("pending");
  expect(task.criteria[0]?.evidence).toBeNull();
});

test("completion keeps refs added during the URL check", async () => {
  let id = 0 as TaskId;
  let storage: Storage | undefined;
  const server = serve([{ status: 200, during: () => storage?.setTaskRefs(id, ["lane:test", "lane:added"]) }]);
  [storage, id] = fixture();
  setUrl(storage, id, null, server.target);
  const done = await complete(storage, id, null, ["pr:1"], local);
  expect(done.status).toBe("done");
  expect(done.refs).toEqual(["lane:test", "lane:added", "pr:1"]);
});

test("URL checks do not reach private addresses", async () => {
  const server = serve([{ status: 200 }]);
  const [storage, id] = fixture();
  setUrl(storage, id, null, server.target);
  await commandRejection(() => complete(storage, id, null, []));
  const [criterion] = stored(storage, id).criteria;
  expect(criterion?.state).toBe("failed");
  expect(criterion?.evidence).toContain("not public");
  expect(server.requests()).toBe(0);
});

test("URL checks do not follow redirects", async () => {
  const server = serve([{ status: 302, headers: { location: "http://169.254.169.254/" } }]);
  const [storage, id] = fixture();
  setUrl(storage, id, null, server.target);
  await commandRejection(() => complete(storage, id, null, [], local));
  const task = stored(storage, id);
  expect(task.status).toBe("in_progress");
  expect(task.criteria[0]?.state).toBe("failed");
  expect(task.criteria[0]?.evidence).toContain("302 Found");
  expect(server.requests()).toBe(1);
});
