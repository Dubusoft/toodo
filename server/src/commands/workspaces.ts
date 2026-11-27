// Commands for workspace records.

import { workspaceId } from "../domain/model.ts";
import { StorageError } from "../storage/errors.ts";
import { command } from "./errors.ts";
import { required, task, workspace, type Command } from "./types.ts";

export const listWorkspaces: Command<"listWorkspaces"> = command((storage) =>
  storage.listWorkspaces().map(workspace));

export const getWorkspace: Command<"getWorkspace"> = command((storage, id) => {
  const found = storage.getWorkspace(workspaceId(id));
  if (found === null) throw new StorageError({ kind: "workspace_not_found", workspace: id });
  return workspace(found);
});

/** Removes a workspace from Toodo by archiving it with its tasks: they leave the lists but
 * stay in reviews, and `restoreWorkspace` brings them back. `purgeWorkspace` deletes them
 * for good. */
export const deleteWorkspace: Command<"deleteWorkspace"> = command((storage, id) => {
  storage.archiveWorkspace(workspaceId(id));
  return null;
});

/** Brings an archived workspace back with its tasks. */
export const restoreWorkspace: Command<"restoreWorkspace"> = command((storage, id) =>
  workspace(storage.restoreWorkspace(workspaceId(id))));

/** Deletes an archived workspace for good with its tasks, their history, and commit
 * records; a workspace that is not archived is rejected. */
export const purgeWorkspace: Command<"purgeWorkspace"> = command((storage, id) => {
  storage.purgeWorkspace(workspaceId(id));
  return null;
});

/** The workspaces and tasks deleting archived, to restore or purge. */
export const listArchive: Command<"listArchive"> = command((storage) => ({
  workspaces: storage.archivedWorkspaces().map(workspace),
  tasks: storage.archivedTasks().map(task),
}));

/** Stores a workspace without inspecting its external location. */
export const createWorkspace: Command<"createWorkspace"> = command((storage, input) =>
  workspace(storage.createWorkspace({
    name: required("workspace name", input.name),
    description: input.description,
    repository: input.repository,
  })));

export const updateWorkspace: Command<"updateWorkspace"> = command((storage, input) => {
  const id = workspaceId(input.id);
  const stored = storage.getWorkspace(id);
  if (stored === null) throw new StorageError({ kind: "workspace_not_found", workspace: id });
  const updated = {
    id,
    name: required("workspace name", input.name),
    description: input.description,
    repository: input.repository,
    archivedAt: stored.archivedAt,
  };
  storage.updateWorkspace(updated);
  return workspace(updated);
});
