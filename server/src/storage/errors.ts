import type { BlockingDependency, DependencyError } from "../domain/dag.ts";
import type { CheckKind } from "../domain/criteria.ts";
import type { TransitionError } from "../domain/status.ts";
import { debugString } from "../domain/rust.ts";

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
  | { readonly kind: "chat_message_not_found"; readonly message: number }
  /** Only a person's message gets receipts. */
  | { readonly kind: "not_a_persons_message"; readonly message: number }
  /** Only the agent's message can be the reply that handled a person's message. */
  | { readonly kind: "not_an_agents_message"; readonly message: number }
  | { readonly kind: "chat_channel_not_found"; readonly channel: number }
  /** Another channel has the name, in some case. */
  | { readonly kind: "chat_channel_name_taken"; readonly name: string }
  /** The default room (channel 1) stays: it cannot be deleted. */
  | { readonly kind: "chat_channel_permanent"; readonly channel: number }
  | { readonly kind: "chat_thread_not_found"; readonly thread: number }
  /** Messages go only to open threads. */
  | { readonly kind: "chat_thread_not_open"; readonly thread: number; readonly status: "closed" | "archived" }
  /** The agent's message offers no action with the key. */
  /** A task has one chat thread; linking it to another is refused. */
  | { readonly kind: "chat_thread_task_taken"; readonly task: number; readonly thread: number }
  | { readonly kind: "chat_action_not_found"; readonly message: number; readonly key: string }
  /** A person chose an action on the message already, the one with `key`. */
  | { readonly kind: "chat_action_chosen"; readonly message: number; readonly key: string }
  | { readonly kind: "chat_attachment_not_found"; readonly attachment: number }
  /** The upload is on a message already, or was uploaded by the other side of the chat. */
  | { readonly kind: "chat_attachment_not_free"; readonly attachment: number }
  | { readonly kind: "device_not_found"; readonly device: number }
  /** The device has not subscribed to push notifications. */
  | { readonly kind: "push_subscription_not_found"; readonly device: number }
  /** A stored value cannot be converted back into the domain model. */
  | { kind: "invalid_data"; reason: string }
  /** A file to restore from is not a readable Toodo database. */
  | { readonly kind: "invalid_backup"; readonly reason: string }
  /** A backup Toodo just wrote failed `PRAGMA integrity_check`; it was deleted. */
  | { readonly kind: "backup_check_failed"; readonly reason: string };

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
    case "chat_message_not_found":
      return `chat message ${failure.message} does not exist; take message ids from peek_pending, take_pending or list_chat`;
    case "not_a_persons_message":
      return `chat message ${failure.message} was not written by a person; only people's messages are acknowledged and handled`;
    case "not_an_agents_message":
      return `chat message ${failure.message} is not a reply of the agent; pass the id reply_in_chat returned as reply_id`;
    case "chat_channel_not_found":
      return `chat channel ${failure.channel} does not exist; take channel ids from list_channels`;
    case "chat_channel_name_taken":
      return `a chat channel named ${debugString(failure.name)} already exists; choose another name`;
    case "chat_channel_permanent":
      return `chat channel ${failure.channel} is the default room, which cannot be deleted`;
    case "chat_thread_not_found":
      return `chat thread ${failure.thread} does not exist; take thread ids from list_threads or create_thread`;
    case "chat_thread_not_open":
      return `chat thread ${failure.thread} is ${failure.status}; reopen it with update_thread status open before posting to it`;
    case "chat_thread_task_taken":
      return `task ${failure.task} already has chat thread ${failure.thread}, and a task has one thread; post in thread ${failure.thread} (list_threads with task_id ${failure.task}), reopening it with update_thread status open if it is closed`;
    case "chat_action_not_found":
      return `chat message ${failure.message} offers no action ${debugString(failure.key)}; list_chat shows a message's actions and their keys`;
    case "chat_action_chosen":
      return `action ${debugString(failure.key)} was chosen on chat message ${failure.message} already; a message takes one choice`;
    case "chat_attachment_not_found":
      return `chat attachment ${failure.attachment} does not exist; upload the file first and pass the id it returns`;
    case "chat_attachment_not_free":
      return `chat attachment ${failure.attachment} is attached to a message already or was uploaded by the other side of the chat; upload the file again`;
    case "device_not_found":
      return `device ${failure.device} does not exist`;
    case "push_subscription_not_found":
      return `device ${failure.device} has not subscribed to push notifications`;
    case "invalid_data":
      return `stored data is invalid: ${failure.reason}`;
    case "invalid_backup":
      return `invalid backup ${failure.reason}`;
    case "backup_check_failed":
      return `the backup failed its integrity check and was deleted (${failure.reason}); check the disk of the backup directory and back up again`;
    default:
      return assertNever(failure);
  }
}
