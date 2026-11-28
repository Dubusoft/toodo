// Workspaces and their guidelines.

import type * as B from "../../../../src/lib/api.ts";
import { CommandError, rejected } from "../../commands/errors.ts";
import * as guidelines from "../../commands/guidelines.ts";
import { guideline, workspace } from "../../commands/types.ts";
import * as workspaces from "../../commands/workspaces.ts";
import { guidelineId, taskId, workspaceId, type Guideline, type Task, type Workspace } from "../../domain/model.ts";
import { StorageError } from "../../storage/errors.ts";
import type { Storage } from "../../storage/storage.ts";
import type * as R from "./requests.ts";

export function listWorkspaces(storage: Storage): B.Workspace[] {
  return storage.listWorkspaces().map(workspace);
}

/** The reply of archive_workspace, which changes nothing until it is called again with
 * `confirm: true`. */
export type WorkspaceConfirmation = {
  /** Whether the workspace was archived; false for a call without `confirm: true`. */
  confirmed: boolean;
  /** The workspace as it was before it was archived. */
  workspace: B.Workspace;
  /** What archiving does, or did, and what to do next. */
  message: string;
};

/**
 * Archives a workspace with its tasks as the app's Remove does, but only with `confirm`;
 * without it, nothing changes and the reply says what archiving would do. Rejected while a
 * task of the workspace is `in_progress` or `in_review`, since someone is working on it.
 */
export function archiveWorkspace(storage: Storage, request: ReturnType<typeof R.archiveWorkspace>): WorkspaceConfirmation {
  const id = request.id;
  const stored = storage.getWorkspace(workspaceId(id));
  if (stored === null) {
    throw new CommandError(
      "workspaceNotFound",
      `workspace ${id} does not exist or is already archived; take a workspace id from list_workspaces`,
    );
  }
  const shown = workspace(stored);
  const tasks = storage.listTasks(stored.id);
  const active = tasks.filter((task) => task.status === "in_progress" || task.status === "in_review");
  if (active.length > 0) {
    const described = active.map((task) => `#${task.id} (${task.status})`);
    throw rejected(
      `workspace ${id} "${shown.name}" still has task(s) being worked on: ${described.join(", ")}; finish each of them, or call pause_task on each, e.g. {"id": ${active[0].id}, "reason": "..."}, then call archive_workspace again`,
    );
  }
  if (!request.confirm) {
    return {
      confirmed: false,
      workspace: shown,
      message: `Nothing changed yet. Archiving workspace ${id} "${shown.name}" removes it and its ${tasks.length} task(s) from list_workspaces and the task lists, while their history, notes, criteria, and commit records stay in review_report; the user can restore it, or delete it for good, under Settings > Trash in the Toodo app. To archive it, call archive_workspace {"id": ${id}, "confirm": true}.`,
    };
  }
  storage.archiveWorkspace(stored.id);
  return {
    confirmed: true,
    workspace: shown,
    message: `workspace ${id} "${shown.name}" is archived with its ${tasks.length} task(s); they stay in review_report, and the user can restore the workspace in the Toodo app.`,
  };
}

export function createWorkspace(storage: Storage, request: ReturnType<typeof R.createWorkspace>): B.Workspace {
  return workspaces.createWorkspace(storage, request);
}

export function updateWorkspace(storage: Storage, request: ReturnType<typeof R.updateWorkspace>): B.Workspace {
  const stored = storage.getWorkspace(workspaceId(request.id));
  if (stored === null) throw new StorageError({ kind: "workspace_not_found", workspace: request.id });
  const current = workspace(stored);
  return workspaces.updateWorkspace(storage, {
    ...current,
    name: request.name ?? current.name,
    description: request.description === undefined ? current.description : request.description,
    repository: request.repository === undefined ? current.repository : request.repository,
  });
}

/** The reply of get_guidelines. */
export type WorkspaceGuidelines = {
  workspace: { id: number; name: string };
  /** Rules first, then memories, each in the order they were added. */
  guidelines: B.Guideline[];
};

export function liveWorkspace(storage: Storage, id: number): Workspace {
  const found = storage.getWorkspace(workspaceId(id));
  if (found === null) {
    throw new CommandError(
      "workspaceNotFound",
      `workspace ${id} does not exist or is archived; take a workspace id from list_workspaces, or the workspaceId of a task from get_task`,
    );
  }
  return found;
}

function storedGuideline(storage: Storage, id: number): Guideline {
  const found = storage.getGuideline(guidelineId(id));
  if (found === null) {
    throw new CommandError(
      "guidelineNotFound",
      `guideline ${id} does not exist; call get_guidelines with the workspace_id of your task and take the guideline id from its result`,
    );
  }
  return found;
}

/** The guidelines of a task's workspace; none once the workspace is archived. */
export function taskGuidelines(storage: Storage, workspace: number): B.Guideline[] {
  try {
    return storage.listGuidelines(workspaceId(workspace)).map(guideline);
  } catch (error) {
    if (error instanceof StorageError && error.failure.kind === "workspace_not_found") return [];
    throw error;
  }
}

export function getGuidelines(storage: Storage, request: ReturnType<typeof R.getGuidelines>): WorkspaceGuidelines {
  const found = liveWorkspace(storage, request.workspace_id);
  return {
    workspace: { id: found.id, name: found.name },
    guidelines: storage.listGuidelines(found.id).map(guideline),
  };
}

export function addGuideline(storage: Storage, request: ReturnType<typeof R.addGuideline>): B.Guideline {
  liveWorkspace(storage, request.workspace_id);
  return guidelines.addGuideline(storage, {
    workspaceId: request.workspace_id,
    kind: request.kind ?? "memory",
    body: request.body,
  });
}

/** Changes the supplied kind and body of a guideline, keeping omitted values. */
export function updateGuideline(storage: Storage, request: ReturnType<typeof R.updateGuideline>): B.Guideline {
  const current = storedGuideline(storage, request.id);
  return guidelines.updateGuideline(storage, {
    id: request.id,
    kind: request.kind ?? current.kind,
    body: request.body ?? current.body,
  });
}

export function removeGuideline(storage: Storage, request: ReturnType<typeof R.removeGuideline>): B.Guideline {
  storedGuideline(storage, request.id);
  return guidelines.deleteGuideline(storage, request.id);
}

/** Task `id`, or a not-found error. */
export function storedTask(storage: Storage, id: number): Task {
  const found = storage.getTask(taskId(id));
  if (found === null) throw new StorageError({ kind: "task_not_found", task: id });
  return found;
}
