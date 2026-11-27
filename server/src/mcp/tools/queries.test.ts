import { expect, test } from "bun:test";
import { taskId } from "../../domain/model.ts";
import { workspace } from "../../storage/storage-fixtures.ts";
import { addNote } from "./edits.ts";
import { addRelated, listTasks, removeRelated, searchTasks, taskDetails } from "./queries.ts";
import * as R from "./requests.ts";
import { createTaskIn, storageWithWorkspace, toolFailure } from "./tool-fixtures.ts";

test("Search hits and task details carry history and links", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const research = create("Research search engines");
  const schema = create("Search schema");
  const tool = create("Search tool", [schema.id]);
  addRelated(storage, R.related({ task_id: tool.id, related_id: research.id }));
  addNote(storage, "progress", R.addNote({ task_id: research.id, note: "Chose FTS5 over tantivy" }));
  storage.setTaskStatus(taskId(research.id), "in_progress");
  storage.concludeTask(taskId(research.id), "Too heavy for a desktop app", null);
  const search = (query: string) => searchTasks(storage, R.searchTasks({ query }));
  const get = (id: number) => taskDetails(storage, R.getTask({ id }).id);

  const hits = search("search");
  expect(hits.map((hit) => hit.id)).toHaveLength(3);
  const schemaHit = hits.find((hit) => hit.id === schema.id);
  expect([schemaHit?.workspace, schemaHit?.dependents, schemaHit?.related]).toEqual(["toodo", [tool.id], []]);
  const [hit] = search("tantivy");
  expect(hit?.id).toBe(research.id);
  expect(hit?.related).toEqual([tool.id]);
  expect(hit?.resolution).toBe("not_adopted");
  expect(toolFailure(() => search(" ")).kind).toBe("invalidInput");

  const details = get(research.id);
  expect(details.task.completionNote).toBe("Too heavy for a desktop app");
  expect(details.task.notes[0]?.body).toBe("Chose FTS5 over tantivy");
  expect(details.task.timeline.map((event) => event.status)).toEqual(["planned", "in_progress", "done"]);
  expect(details.related).toEqual([
    { id: tool.id, workspaceId: ws.id, title: "Search tool", status: "planned", resolution: null },
  ]);
  const toolDetails = get(tool.id);
  expect(toolDetails.dependsOn.map((link) => link.title)).toEqual(["Search schema"]);
  expect(toolDetails.dependents).toEqual([]);
  expect(toolDetails.related.map((link) => link.title)).toEqual(["Research search engines"]);
  expect(toolDetails.dependsOn[0]?.status).toBe("planned");
  expect(toolDetails.task.id).toBe(tool.id);

  const unlink = () => removeRelated(storage, R.related({ task_id: research.id, related_id: tool.id }));
  expect(unlink().related).toEqual([]);
  const missing = toolFailure(unlink);
  expect(missing.kind).toBe("notFound");
  expect(missing.message.endsWith(`get_task ${research.id} lists its related tasks`)).toBe(true);
  expect(toolFailure(() => get(99)).kind).toBe("notFound");
  const self = toolFailure(() => addRelated(storage, R.related({ task_id: tool.id, related_id: tool.id })));
  expect(self.kind).toBe("invalidInput");
});

test("Tasks are listed across workspaces or for a requested workspace", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const schema = create("Schema");
  create("API", [schema.id]);

  const all = listTasks(storage, R.listTasks({}));
  expect(all).toHaveLength(2);
  expect(all[0]?.ready).toBe(true);
  expect(all[0]?.blockedBy).toEqual([]);
  expect(all[1]?.ready).toBe(false);
  expect(all[1]?.blockedBy[0]?.id).toBe(schema.id);
  expect(all[1]?.title).toBe("API");
  expect(all[1]?.blockedBy[0]?.title).toBe("Schema");
  expect(toolFailure(() => listTasks(storage, R.listTasks({ workspace_id: 99 }))).kind).toBe("notFound");
});

test("Task lists narrow by status and readiness and paginate before an ID", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const schema = create("Schema");
  const api = create("API", [schema.id]);
  const docs = create("Docs");
  const list = (request: object) => listTasks(storage, R.listTasks(request));
  const ids = (request: object) => list(request).map((task) => task.id);

  expect(ids({ ready: true })).toEqual([schema.id, docs.id]);
  expect(ids({ ready: true, limit: 1 })).toEqual([docs.id]);
  expect(ids({ ready: false })).toEqual([api.id]);
  expect(ids({ limit: 2 })).toEqual([api.id, docs.id]);
  expect(ids({ limit: 2, before_id: api.id })).toEqual([schema.id]);
  expect(ids({ status: ["in_progress"] })).toEqual([]);
  expect(ids({ status: ["in_progress"], ready: true })).toEqual([]);
  const [listed] = list({ limit: 1, before_id: docs.id });
  expect(listed?.id).toBe(api.id);
  expect(listed?.blockedBy[0]?.id).toBe(schema.id);
  expect(listed?.ready).toBe(false);
  expect(toolFailure(() => list({ limit: 0 })).kind).toBe("invalidInput");
});

test("A task waiting until a time is ready only once the wait ends", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const schema = create("Schema");
  const docs = create("Docs");
  storage.waitTask(taskId(docs.id), Number.MAX_SAFE_INTEGER, null);
  const ids = (ready: boolean) => listTasks(storage, R.listTasks({ ready })).map((task) => task.id);
  const details = () => taskDetails(storage, R.getTask({ id: docs.id }).id);

  expect(ids(true)).toEqual([schema.id]);
  expect(ids(false)).toEqual([docs.id]);
  const waiting = details();
  expect(waiting.ready).toBe(false);
  expect(waiting.blockedBy).toEqual([]);
  storage.endTaskWait(taskId(docs.id), null);
  expect(ids(true)).toEqual([schema.id, docs.id]);
  expect(details().ready).toBe(true);
});

test("A task number finds that task first in any workspace", () => {
  const { storage, ws } = storageWithWorkspace();
  const other = workspace(storage, "server");
  const numbered = createTaskIn(storage, other.id)("Deploy server");
  const number = String(numbered.id);
  const mention = createTaskIn(storage, ws.id)(`Follow up on ${number}`);
  const ids = (request: object) => searchTasks(storage, R.searchTasks(request)).map((hit) => hit.id);

  expect(ids({ query: number })).toEqual([numbered.id, mention.id]);
  expect(ids({ query: ` #${number} `, workspace_id: ws.id })).toEqual([numbered.id]);
  expect(ids({ query: number, workspace_id: ws.id })).toEqual([numbered.id, mention.id]);
  expect(ids({ query: number, status: "done" })).toEqual([]);
  expect(ids({ query: "999" })).toEqual([]);
});

test("A search limit of zero returns no tasks", () => {
  const { storage, ws } = storageWithWorkspace();
  createTaskIn(storage, ws.id)("Search schema");
  const limited = (limit: number | null) => searchTasks(storage, R.searchTasks({ query: "schema", limit }));

  expect(limited(0)).toHaveLength(0);
  expect(limited(null)).toHaveLength(1);
});

test("Search leaves out archived tasks and tasks of archived workspaces", () => {
  const { storage, ws } = storageWithWorkspace();
  const create = createTaskIn(storage, ws.id);
  const live = create("Avatar upload");
  const archived = create("Avatar crop");
  storage.addRelated(taskId(live.id), taskId(archived.id));
  storage.archiveTask(taskId(archived.id));
  const other = workspace(storage, "Other");
  createTaskIn(storage, other.id)("Avatar resize");
  storage.archiveWorkspace(other.id);

  const hits = searchTasks(storage, R.searchTasks({ query: "avatar" }));
  expect(hits.map((hit) => hit.id)).toEqual([live.id]);
  expect(hits[0]?.related).toEqual([]);
});
