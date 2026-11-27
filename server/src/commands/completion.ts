// Completion records and criterion checks, without execution side effects
// (`src-tauri/src/commands/completion/`).

import type { Criterion } from "../domain/criteria.ts";
import { isMet } from "../domain/criteria.ts";
import { taskId } from "../domain/model.ts";
import type { Task, TaskId } from "../domain/model.ts";
import { trim } from "../domain/rust.ts";
import { complete as completeStatus, TransitionError } from "../domain/status.ts";
import { outbound } from "../net.ts";
import type { Outbound } from "../net.ts";
import type { CriterionCheck } from "../storage/criteria.ts";
import { StorageError } from "../storage/errors.ts";
import type { Storage } from "../storage/storage.ts";
import { asyncCommand, command, invalidInput, rejected } from "./errors.ts";
import { mergeRefs, task, type AsyncCommand, type Command } from "./types.ts";

/** How work ends without completing its own criteria. */
export type ConcludeOutcome = "not_adopted" | "shipped_with";

function storedTask(storage: Storage, id: TaskId): Task {
  const found = storage.getTask(id);
  if (found === null) throw new StorageError({ kind: "task_not_found", task: id });
  return found;
}

/** GETs the target of each URL criterion. Each check names the target it examined, so its
 * result is dropped if the target changes meanwhile. */
async function checkUrls(criteria: readonly Criterion[], get: Outbound): Promise<CriterionCheck[]> {
  const checks: CriterionCheck[] = [];
  for (const criterion of criteria) {
    if (criterion.kind !== "url" || criterion.target === null) continue;
    const target = criterion.target;
    let check: Pick<CriterionCheck, "state" | "evidence">;
    try {
      const response = await get(target);
      check = response.ok
        ? { state: "met", evidence: `GET ${target}: ${response.status}` }
        : {
            state: "failed",
            evidence: `GET ${target}: ${response.status} (redirects are not followed); fix the URL target with update_task, then call complete_task again`,
          };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      check = {
        state: "failed",
        evidence: `GET ${target}: ${reason}; fix the URL target with update_task, then call complete_task again`,
      };
    }
    checks.push({ id: criterion.id, ...check, target });
  }
  return checks;
}

function pendingCriterion(criterion: Criterion): string {
  return criterion.kind === "manual"
    ? `criterion ${criterion.id}: ${criterion.text}; call check_criterion with criterion_id ${criterion.id} and met true`
    : `criterion ${criterion.id}: ${criterion.evidence ?? "URL check failed"}; fix its URL with update_task, then call complete_task again`;
}

/** Completes a task after its manual criteria and URL checks succeed, checking its URL
 * criteria with `get`. */
export const complete = asyncCommand(
  async (storage: Storage, id: TaskId, rawNote: string | null, refs: readonly string[], get: Outbound = outbound(15_000)) => {
    const note = rawNote === null ? null : trim(rawNote);
    if (note === "") throw invalidInput("note is blank; call complete_task with a non-empty note or omit note");
    const found = storedTask(storage, id);
    try {
      completeStatus(found.status);
    } catch (error) {
      throw error instanceof TransitionError ? new StorageError({ kind: "transition", error }) : error;
    }
    // Rejects malformed refs before the checks; they are merged with the refs current at
    // completion.
    mergeRefs(found.refs, refs, []);
    const checks = await checkUrls(found.criteria, get);
    storage.recordCriterionRechecks(id, checks);
    const [checked] = storage.recordCriterionChecks(id, checks);
    const pending = checked.criteria.filter((criterion) => !isMet(criterion)).map(pendingCriterion);
    if (pending.length > 0) throw rejected(pending.join("; "));
    return storage.completeTask(id, note, mergeRefs(checked.refs, refs, []));
  },
);

/** Records the conclusion of work, or the completed task `shippedWith` that shipped it. */
export const conclude = command(
  (storage: Storage, id: TaskId, rawNote: string, outcome: ConcludeOutcome, shippedWith: TaskId | null): Task => {
    const note = trim(rawNote);
    if (note === "") throw invalidInput("note is blank; call conclude_task with a note explaining the outcome");
    if ((outcome === "shipped_with") !== (shippedWith !== null)) {
      throw invalidInput(
        "call conclude_task with outcome shipped_with and shipped_with set to the completed task id, or with outcome not_adopted and no shipped_with",
      );
    }
    if (shippedWith !== null) {
      if (shippedWith === id) {
        throw invalidInput(
          `task ${id} cannot ship itself; call complete_task with id ${id} for its own work, or conclude_task with outcome not_adopted and a note`,
        );
      }
      const target = storedTask(storage, shippedWith);
      if (target.status !== "done" || target.resolution === "not_adopted") {
        throw rejected(
          `task ${shippedWith} has not shipped this work; call complete_task for that task first, then conclude_task with outcome shipped_with and shipped_with ${shippedWith}`,
        );
      }
    }
    return storage.concludeTask(id, note, shippedWith);
  },
);

/** Completes a task after its manual criteria and URL checks succeed. */
export const completeTask: AsyncCommand<"completeTask"> = async (storage, id, note, refs) =>
  task(await complete(storage, taskId(id), note, refs ?? []));

/** Records the conclusion of work or identifies the completed task that shipped it. */
export const concludeTask: Command<"concludeTask"> = (storage, id, note, outcome, shippedWith) =>
  task(conclude(storage, taskId(id), note, outcome ?? "not_adopted", shippedWith === null ? null : taskId(shippedWith)));
