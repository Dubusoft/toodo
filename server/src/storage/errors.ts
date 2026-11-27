import type { BlockingDependency, DependencyError } from "../domain/dag.ts";
import type { CheckKind } from "../domain/criteria.ts";
import type { TransitionError } from "../domain/status.ts";

export type StorageFailure =
  | { readonly kind: "workspace_not_found"; readonly workspace: number }
  /** A workspace cannot be deleted while a task of another workspace still waits on
   * one of its tasks: deleting the prerequisite would make the dependent ready. */
  | { readonly kind: "workspace_has_dependents"; readonly workspace: number; readonly task: number; readonly dependsOn: number }
  | { kind: "task_not_found"; task: number }
  /** Only an archived task can be restored or purged. */
  | { readonly kind: "task_not_archived"; readonly task: number }
  /** Only an archived workspace can be restored or purged. */
  | { readonly kind: "workspace_not_archived"; readonly workspace: number }
  /** A task of an archived workspace comes back with its workspace, not on its own. */
  | { readonly kind: "workspace_archived"; readonly workspace: number; readonly task: number }
  /** Restoring would bring back dependencies that close this loop with edges added
   * while the tasks were archived. */
  | { readonly kind: "restore_closes_cycle"; readonly path: readonly number[] }
  | { readonly kind: "dependency"; readonly error: DependencyError }
  /** A task of a plan links to the plan's task at `index`, but the plan has only `tasks` tasks. */
  | { readonly kind: "plan_link_out_of_range"; readonly index: number; readonly tasks: number }
  | { readonly kind: "transition"; readonly error: TransitionError }
  /** A task cannot start while one of its dependencies is not done or was concluded
   * without being adopted. `blockers` lists those dependencies. */
  | { readonly kind: "dependencies_not_done"; readonly task: number; readonly blockers: readonly BlockingDependency[] }
  /** A `done` task cannot wait on new prerequisites. */
  | { readonly kind: "prerequisite_of_done_task"; readonly task: number; readonly dependsOn: readonly number[] }
  /** The dependencies of a `done` task are kept as they were when it finished. */
  | { readonly kind: "dependency_of_done_task"; readonly task: number; readonly dependsOn: number }
  /** The dependency to remove does not exist. */
  | { readonly kind: "dependency_not_found"; readonly task: number; readonly dependsOn: number }
  /** The related link to remove does not exist. */
  | { readonly kind: "relation_not_found"; readonly task: number; readonly related: number }
  /** A task cannot be related to itself. */
  | { readonly kind: "self_relation"; readonly task: number }
  | { readonly kind: "criterion_not_found"; readonly task: number; readonly criterion: number }
  /** The criteria of a done task are its record and cannot change. */
  | { readonly kind: "criteria_of_done_task"; readonly task: number }
  /** Only manual criteria are checked by hand; Toodo checks the others. */
  | { readonly kind: "automatic_criterion"; readonly task: number; readonly criterion: number; readonly checkKind: CheckKind }
  | { readonly kind: "guideline_not_found"; readonly guideline: number }
  /** A stored value cannot be converted back into the domain model. */
  | { kind: "invalid_data"; reason: string };

export class StorageError extends Error {
  readonly failure: StorageFailure;

  constructor(failure: StorageFailure) {
    super(describe(failure));
    this.name = "StorageError";
    this.failure = failure;
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected storage failure: ${String(value)}`);
}

function describe(failure: StorageFailure): string {
  switch (failure.kind) {
    case "workspace_not_found":
      return `workspace ${failure.workspace} does not exist`;
    case "workspace_has_dependents": {
      const { workspace, task, dependsOn } = failure;
      return `workspace ${workspace} cannot be removed: task ${task} of another workspace depends on its task ${dependsOn}; remove that dependency first (in task ${task}'s dependencies, or remove_dependency over MCP), then remove the workspace again`;
    }
    case "task_not_found":
      return `task ${failure.task} does not exist`;
    case "task_not_archived":
      return `task ${failure.task} is not archived; delete it first (deleting archives it), then restore or purge it from the archive`;
    case "workspace_not_archived":
      return `workspace ${failure.workspace} is not archived; remove it first (removing archives it), then restore or purge it from the archive`;
    case "workspace_archived":
      return `task ${failure.task} belongs to archived workspace ${failure.workspace}; restore workspace ${failure.workspace} instead, which brings its tasks back`;
    case "restore_closes_cycle":
      return `restoring would close the dependency cycle ${failure.path.join(" -> ")}; remove one of the dependencies along it among the live tasks (remove_dependency), then restore again`;
    case "dependency":
    case "transition":
      return failure.error.message;
    case "plan_link_out_of_range":
      return `a task of the plan links to plan task ${failure.index}, but the plan has ${failure.tasks} tasks (indexes 0 to ${Math.max(0, failure.tasks - 1)})`;
    case "dependencies_not_done": {
      const { task } = failure;
      const blockers = failure.blockers.map(({ id, resolution, status }) => resolution === "not_adopted"
        ? `#${id} is done as not_adopted (remove_dependency task_id ${task} depends_on ${id} to unblock, or conclude_task id ${id} with outcome shipped_with and shipped_with set to the completed task id)`
        : `#${id} is ${status} (wait for it)`);
      return `task ${task} cannot start yet: ${blockers.join("; ")}; call complete_task for those prerequisite ids first`;
    }
    case "prerequisite_of_done_task":
      return `task ${failure.task} is done, so it cannot wait on new prerequisites; for more work that needs them, create a follow-up task with create_task and depends_on [${failure.dependsOn.join(", ")}]`;
    case "dependency_of_done_task":
      return `task ${failure.task} is done, so its dependency on ${failure.dependsOn} is kept; to change its dependencies, reopen it with reopen_task ${failure.task} first, then call remove_dependency again`;
    case "dependency_not_found":
      return `task ${failure.task} does not depend on ${failure.dependsOn}; get_task ${failure.task} lists the tasks it depends on (dependsOn), and task_id is the task that waits`;
    case "relation_not_found":
      return `tasks ${failure.task} and ${failure.related} are not related; get_task ${failure.task} lists its related tasks`;
    case "self_relation":
      return `task ${failure.task} cannot be related to itself`;
    case "criterion_not_found":
      return `task ${failure.task} has no criterion ${failure.criterion}`;
    case "criteria_of_done_task":
      return `task ${failure.task} is done; its completion criteria cannot change`;
    case "automatic_criterion":
      return `criterion ${failure.criterion} of task ${failure.task} is a ${failure.checkKind} criterion, which Toodo checks on its own; only manual criteria are checked by hand`;
    case "guideline_not_found":
      return `guideline ${failure.guideline} does not exist; call list_guidelines with the workspace id and take the guideline id from its result`;
    case "invalid_data":
      return `stored data is invalid: ${failure.reason}`;
    default:
      return assertNever(failure);
  }
}
