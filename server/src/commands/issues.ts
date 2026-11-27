// Issue references supplied by callers (`src-tauri/src/commands/issues.rs`).

import { taskId } from "../domain/model.ts";
import { StorageError } from "../storage/errors.ts";
import { command } from "./errors.ts";
import { mergeRefs, task, type Command } from "./types.ts";

/** Appends an issue reference without querying the issue service. */
export const linkIssue: Command<"linkIssue"> = command((storage, id, reference) => {
  const found = storage.getTask(taskId(id));
  if (found === null) throw new StorageError({ kind: "task_not_found", task: id });
  const refs = mergeRefs(found.refs, [reference], []);
  return task(storage.setTaskRefs(found.id, refs));
});
