// Creating tasks, alone or as a plan of linked tasks (`src-tauri/src/mcp/tools/create.rs`).

import type * as B from "../../../../src/lib/bindings.ts";
import { CommandError, commandError, invalidInput, notFound, rejected } from "../../commands/errors.ts";
import { labels, mergeRefs, newTask, task } from "../../commands/types.ts";
import { taskId, workspaceId } from "../../domain/model.ts";
import { trim } from "../../domain/rust.ts";
import type { Storage } from "../../storage/storage.ts";
import type { NewPlanTask, PlanLink } from "../../storage/tasks.ts";
import type * as R from "./requests.ts";
import { storedTask } from "./workspaces.ts";

/** The most tasks one `create_plan` call creates. */
const MAX_PLAN_TASKS = 100;

/** A task `create_plan` created, with the key the plan gave it. */
export type PlannedTask = { key: string } & B.Task;

export type CreatedPlan = {
  /** The created tasks in the order of the plan. */
  tasks: PlannedTask[];
};

/** Creates a `planned` task with its labels, refs, dependencies, and related links in one
 * transaction, as a plan of one task: unknown linked tasks are rejected before anything is
 * written, and any failure writes nothing. */
export function createTask(storage: Storage, request: R.CreateTask): B.Task {
  for (const linked of [...request.depends_on, ...request.related]) storedTask(storage, linked);
  const existing = (ids: readonly number[]): PlanLink[] => ids.map((id) => ({ kind: "existing", id: taskId(id) }));
  const planned: NewPlanTask = {
    ...planTask({ ...request, key: "", depends_on_keys: [], related_keys: [] }),
    dependsOn: existing(request.depends_on),
    related: existing(request.related),
  };
  const [created] = storage.createTasks([planned]);
  return task(storedTask(storage, created.id));
}

/**
 * Creates every task of `request` with its dependencies and related links in one
 * transaction. Keys, links, criteria, and labels are checked before anything is written,
 * and a failure names the task of the plan it is about; any failure creates nothing.
 */
export function createPlan(storage: Storage, request: ReturnType<typeof R.createPlan>): CreatedPlan {
  const count = request.tasks.length;
  if (count === 0 || count > MAX_PLAN_TASKS) {
    throw invalidInput(
      `create_plan takes 1 to ${MAX_PLAN_TASKS} tasks, got ${count}; split a larger plan into several create_plan calls and link a later call's tasks to created ones by id in depends_on`,
    );
  }
  const keys = planKeys(request.tasks);
  const existing = (ids: readonly number[]): PlanLink[] => ids.map((id) => ({ kind: "existing", id: taskId(id) }));
  const dependsOn: PlanLink[][] = [];
  const related: PlanLink[][] = [];
  request.tasks.forEach((item, index) => {
    dependsOn.push([...existing(item.depends_on), ...planLinks(keys, index, item, "depends_on", item.depends_on_keys)]);
    related.push([...existing(item.related), ...planLinks(keys, index, item, "related", item.related_keys)]);
  });
  checkPlanOrder(request.tasks, dependsOn);
  const plan = request.tasks.map((item, index): NewPlanTask => {
    let planned: Omit<NewPlanTask, "dependsOn" | "related">;
    try {
      planned = planTask(item);
    } catch (error) {
      const failure = commandError(error);
      throw new CommandError(failure.code, `task \`${item.key}\` of the plan: ${failure.message}`);
    }
    return { ...planned, dependsOn: dependsOn[index], related: related[index] };
  });
  // The checks and the writes run without yielding, so a workspace or task archived in
  // between cannot slip past the checks.
  for (const item of request.tasks) {
    if (storage.getWorkspace(workspaceId(item.workspace_id)) === null) {
      throw new CommandError(
        "workspaceNotFound",
        `task \`${item.key}\` of the plan is in workspace ${item.workspace_id}, which does not exist; take a workspace id from list_workspaces`,
      );
    }
    for (const id of [...item.depends_on, ...item.related]) {
      if (storage.getTask(taskId(id)) === null) {
        throw notFound(
          `task \`${item.key}\` of the plan links to task ${id}, which does not exist; find the task with search_tasks, or link a task of the plan by its key in depends_on_keys or related_keys`,
        );
      }
    }
  }
  const created = storage.createTasks(plan);
  return {
    tasks: request.tasks.map((item, index) => ({ key: item.key, ...task(storedTask(storage, created[index].id)) })),
  };
}

/** The index of each key of `tasks`, rejecting empty and repeated keys. */
function planKeys(tasks: readonly R.PlanTask[]): Map<string, number> {
  const keys = new Map<string, number>();
  tasks.forEach((item, index) => {
    if (trim(item.key) === "") {
      throw invalidInput(
        `task ${index + 1} of the plan ("${item.title}") has no key; give every task of the plan its own key, e.g. "schema"`,
      );
    }
    if (keys.has(item.key)) {
      throw invalidInput(`more than one task of the plan has the key \`${item.key}\`; give each task its own key`);
    }
    keys.set(item.key, index);
  });
  return keys;
}

/** The links that `names`, the `{field}_keys` of the task at `index`, make to other tasks of
 * the plan. */
function planLinks(
  keys: ReadonlyMap<string, number>,
  index: number,
  item: R.PlanTask,
  field: string,
  names: readonly string[],
): PlanLink[] {
  return names.map((name): PlanLink => {
    const linked = keys.get(name);
    if (linked === index) {
      throw invalidInput(`task \`${name}\` of the plan names itself in ${field}_keys; remove \`${name}\` from them`);
    }
    if (linked === undefined) {
      throw invalidInput(
        `task \`${item.key}\` of the plan names \`${name}\` in ${field}_keys, but no task of the plan has that key; use the key of a task in tasks, or put the id of an existing task in ${field}`,
      );
    }
    return { kind: "new", index: linked };
  });
}

/** Rejects dependencies between tasks of the plan that form a cycle, naming its tasks.
 * Existing tasks cannot depend on new ones, so no other cycle is possible. */
function checkPlanOrder(tasks: readonly R.PlanTask[], dependsOn: readonly PlanLink[][]): void {
  const isNew = (link: PlanLink, index?: number) => link.kind === "new" && (index === undefined || link.index === index);
  const waiting = dependsOn.map((links) => links.filter((link) => isNew(link)).length);
  const done = tasks.map((_, index) => index).filter((index) => waiting[index] === 0);
  for (let next = 0; next < done.length; next++) {
    const finished = done[next];
    dependsOn.forEach((links, index) => {
      const edges = links.filter((link) => isNew(link, finished)).length;
      if (edges > 0) {
        waiting[index] -= edges;
        if (waiting[index] === 0) done.push(index);
      }
    });
  }
  if (done.length === tasks.length) return;
  const cycle = tasks.filter((_, index) => waiting[index] > 0).map((item) => `\`${item.key}\``);
  throw rejected(
    `the depends_on_keys of tasks ${cycle.join(", ")} of the plan form a cycle, so none of them could ever start; remove a key from one of them so every task has prerequisites that finish first`,
  );
}

/** The task `item` of a plan creates, with its labels and without links. */
function planTask(item: R.PlanTask): Omit<NewPlanTask, "dependsOn" | "related"> {
  const planLabels = labels(item.labels);
  const refs = mergeRefs([], item.refs, []);
  const created = newTask({
    workspaceId: item.workspace_id,
    taskType: item.task_type,
    title: item.title,
    description: item.description,
    estimate: item.estimate,
    dueDate: item.due_date,
    labels: [],
    autopilot: item.autopilot,
    criteria: item.criteria,
  });
  return { task: created, labels: planLabels, refs };
}
