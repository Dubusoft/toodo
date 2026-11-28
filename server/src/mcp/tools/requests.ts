// The arguments of the tools, read as the `serde` derives of the Rust server read them;
// their JSON schemas are those of `tools.json`.

import type * as B from "../../../../src/lib/api.ts";
import {
  aliased,
  bool,
  defaulted,
  f64,
  i64,
  optional,
  present,
  required,
  string,
  struct,
  u32,
  untagged,
  usize,
  variants,
  vec,
  type Decoder,
} from "../args.ts";

const taskStatus = variants("planned", "in_progress", "in_review", "done");
const taskType = variants("feat", "fix", "modify", "refactor", "docs", "test", "chore", "rnd");
const guidelineKind = variants("rule", "memory");
const checkKind = variants("manual", "url");
const concludeOutcome = variants("not_adopted", "shipped_with");
const reviewPeriodKind = variants("week", "month", "quarter", "year", "custom");
const reportFormat = variants("markdown", "csv");
const progressNoteKind = variants("progress", "decision");
const threadStatus = variants("open", "closed", "archived");

const estimate: Decoder<B.Estimate> = struct(
  "Estimate",
  { unit: required(variants("hours", "days", "weeks", "months")), amount: required(f64) },
  false,
);

const criterionInput: Decoder<B.CriterionInput> = struct("CriterionInput", {
  id: optional(i64),
  text: optional(string),
  kind: optional(checkKind),
  target: optional(string),
});

const chatActionFields = struct("ChatAction", {
  key: required(string),
  label: required(string),
  style: optional(variants("default", "primary", "danger")),
});

const chatAction: Decoder<B.ChatAction> = (value) => {
  const { key, label, style } = chatActionFields(value);
  return style === null ? { key, label } : { key, label, style };
};

/** One task ID or several, as `depends_on` of the dependency tools takes them. */
const taskIds: Decoder<number[]> = untagged<number[]>(
  "a task id or an array of task ids, e.g. 3 or [3, 4]",
  (value) => [i64(value)],
  vec(i64),
);

const list = <T>(item: Decoder<T>) => defaulted(vec(item), () => [] as T[]);
const flag = defaulted(bool, () => false);

export const listTasks = struct("ListTasks", {
  workspace_id: optional(i64),
  status: optional(vec(taskStatus)),
  ready: optional(bool),
  limit: optional(u32),
  before_id: optional(i64),
  autopilot: optional(bool),
});

export const createWorkspace = struct("CreateWorkspace", {
  name: required(string),
  description: optional(string),
  repository: optional(string),
});

export const updateWorkspace = struct("UpdateWorkspace", {
  id: required(i64),
  name: optional(string),
  description: present(string),
  repository: present(string),
});

export const archiveWorkspace = struct("ArchiveWorkspace", { id: required(i64), confirm: flag });

export const currentTask = struct("CurrentTask", { ref: optional(string) });

const taskFields = {
  workspace_id: required(i64),
  task_type: required(taskType),
  title: required(string),
  description: defaulted(string, () => ""),
};

export const createTask = struct("CreateTask", {
  ...taskFields,
  depends_on: list(i64),
  related: list(i64),
  estimate: optional(estimate),
  due_date: optional(string),
  labels: list(string),
  refs: list(string),
  autopilot: flag,
  criteria: list(criterionInput),
  request_id: optional(string),
});

export type CreateTask = ReturnType<typeof createTask>;

export const planTask = struct("PlanTask", {
  key: required(string),
  ...taskFields,
  depends_on: list(i64),
  depends_on_keys: list(string),
  related: list(i64),
  related_keys: list(string),
  estimate: optional(estimate),
  due_date: optional(string),
  labels: list(string),
  refs: list(string),
  autopilot: flag,
  criteria: list(criterionInput),
});

export type PlanTask = ReturnType<typeof planTask>;

export const createPlan = struct("CreatePlan", { tasks: required(vec(planTask)) });

export const updateTask = struct("UpdateTask", {
  id: required(i64),
  task_type: optional(taskType),
  status: optional(taskStatus),
  title: optional(string),
  description: optional(string),
  estimate: present(estimate),
  due_date: present(string),
  labels: optional(vec(string)),
  refs: optional(vec(string)),
  remove_refs: optional(vec(string)),
  autopilot: optional(bool),
  criteria: optional(vec(criterionInput)),
});

export type UpdateTask = ReturnType<typeof updateTask>;

export const checkCriterion = struct("CheckCriterion", {
  task_id: optional(i64),
  criterion_id: aliased(required(i64), "id"),
  met: optional(bool),
  evidence: optional(string),
});

export const addCriterion = struct("AddCriterion", {
  task_id: required(i64),
  text: required(string),
  kind: required(checkKind),
  target: optional(string),
});

export const removeCriterion = struct("RemoveCriterion", {
  task_id: optional(i64),
  criterion_id: aliased(required(i64), "id"),
});

export const addDependencies = struct("AddDependencies", { task_id: required(i64), depends_on: required(taskIds) });

export const dependency = struct("Dependency", { task_id: required(i64), depends_on: required(taskIds) });

export const addNote = struct("AddNote", { task_id: required(i64), note: required(string) });

export type AddNote = ReturnType<typeof addNote>;

export const addProgressNote = struct("AddProgressNote", {
  task_id: required(i64),
  note: required(string),
  kind: optional(progressNoteKind),
});

export const pauseTask = struct("PauseTask", { id: required(i64), reason: required(string) });

export const moveTask = struct("MoveTask", { id: required(i64), workspace_id: required(i64) });

export const waitTask = struct("WaitTask", { id: required(i64), until: required(string), reason: optional(string) });

export const endWait = struct("EndWait", { id: required(i64), note: optional(string) });

export const resumeTask = struct("ResumeTask", { id: required(i64), note: optional(string) });

export const deleteTask = struct("DeleteTask", { id: required(i64), confirm: flag });

export const deleteDoneTasks = struct("DeleteDoneTasks", { workspace_id: required(i64), confirm: flag });

export const reopenTask = struct("ReopenTask", { id: required(i64), reason: required(string), confirm: flag });

export const startTask = struct("StartTask", {
  id: required(i64),
  reason: optional(string),
  refs: list(string),
  request_id: optional(string),
});

export const completeTask = struct("CompleteTask", { id: required(i64), note: optional(string), refs: list(string) });

export const searchTasks = struct("SearchTasks", {
  query: required(string),
  workspace_id: optional(i64),
  status: optional(taskStatus),
  limit: optional(u32),
});

export const reviewReport = struct("ReviewReportRequest", {
  period: required(reviewPeriodKind),
  date: optional(string),
  from: optional(string),
  to: optional(string),
  format: optional(reportFormat),
  time_zone: optional(string),
  workspace_id: optional(i64),
  label: optional(string),
});

export const getTask = struct("GetTask", { id: required(i64) });

export const getGuidelines = struct("GetGuidelines", { workspace_id: required(i64) });

export const addGuideline = struct("AddGuideline", {
  workspace_id: required(i64),
  kind: optional(guidelineKind),
  body: required(string),
});

export const updateGuideline = struct("UpdateGuideline", {
  id: required(i64),
  kind: optional(guidelineKind),
  body: optional(string),
});

export const removeGuideline = struct("RemoveGuideline", { id: required(i64) });

export const related = struct("Related", { task_id: required(i64), related_id: required(i64) });

export const concludeTask = struct("ConcludeTask", {
  id: required(i64),
  note: required(string),
  outcome: optional(concludeOutcome),
  shipped_with: optional(i64),
});

export const replyInChat = struct("ReplyInChat", {
  body: defaulted(string, () => ""),
  handles: list(i64),
  channel_id: optional(i64),
  thread_id: optional(i64),
  actions: list(chatAction),
  attachments: list(i64),
});

export const searchChat = struct("SearchChat", {
  query: required(string),
  channel_id: optional(i64),
  thread_id: optional(i64),
  limit: optional(u32),
});

export const ackChat = struct("AckChat", { ids: required(vec(i64)) });

export const markChatHandled = struct("MarkChatHandled", {
  id: required(i64),
  reply_id: optional(i64),
  task_id: optional(i64),
});

export const listChat = struct("ListChat", {
  channel_id: optional(i64),
  thread_id: optional(i64),
  before: optional(i64),
  limit: optional(usize),
});

export const setTyping = struct("SetTyping", {
  typing: required(bool),
  channel_id: optional(i64),
  thread_id: optional(i64),
});

export const createChannel = struct("CreateChannel", { name: required(string) });

export const listThreads = struct("ListThreads", {
  channel_id: optional(i64),
  task_id: optional(i64),
  include_archived: flag,
});

export const createThread = struct("CreateThread", {
  channel_id: optional(i64),
  title: required(string),
  task_id: optional(i64),
});

export const updateThread = struct("UpdateThread", {
  id: required(i64),
  title: optional(string),
  status: optional(threadStatus),
  task_id: optional(i64),
  unlink_task: flag,
  awaiting: defaulted<boolean | undefined>(bool, () => undefined),
});
