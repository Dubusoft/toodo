import { commandFailure } from "../../commands/command-fixtures.ts";
import { command } from "../../commands/errors.ts";
import { memoryStorage, workspace } from "../../storage/storage-fixtures.ts";
import { createTask } from "./create.ts";
import * as R from "./requests.ts";

export function storageWithWorkspace() {
  const storage = memoryStorage();
  return { storage, ws: workspace(storage, "toodo") };
}

export function createTaskIn(storage: ReturnType<typeof memoryStorage>, workspaceId: number) {
  return (title: string, depends_on: readonly number[] = []) =>
    createTask(storage, R.createTask({
      workspace_id: workspaceId,
      task_type: "feat",
      title,
      depends_on,
      criteria: [{ text: "Reviewed", kind: "manual" }],
    }));
}

export function toolFailure(run: () => unknown) {
  return commandFailure(command(run));
}
