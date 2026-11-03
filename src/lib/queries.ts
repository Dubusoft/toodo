import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  commands,
  events,
  type BackupSettings,
  type CommandError,
  type CriterionId,
  type Machine,
  type MachineSettings,
  type NewTask,
  type NewWorkspace,
  type Task,
  type TaskEdit,
  type TaskId,
  type TaskResolution,
  type TaskAgentStatus,
  type TaskPullRequestStatus,
  type Timestamp,
  type Workspace,
  type WorkspaceId,
  type WorkspaceLocation,
} from "@/lib/bindings";
import { downloadBackup, downloadExport, uploadRestore } from "@/web/files";
import { agentAlerts, notify, pullRequestAlerts, taskStatusAlerts, type AgentAlert } from "@/lib/agent-alerts";

type CommandResult<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError };

export class CommandFailure extends Error {
  readonly kind: CommandError["kind"];

  constructor(error: CommandError) {
    super(error.message);
    this.name = "CommandFailure";
    this.kind = error.kind;
  }
}

export async function unwrap<T>(result: Promise<CommandResult<T>>): Promise<T> {
  const outcome = await result;
  if (outcome.status === "error") {
    throw new CommandFailure(outcome.error);
  }
  return outcome.data;
}

export const queryKeys = {
  workspaces: ["workspaces"] as const,
  /** Tasks of every workspace: dependencies cross workspaces, so they are loaded together. */
  tasks: ["task-list"] as const,
  /** Related links between tasks; under "tasks", so a tasks-changed event refetches them. */
  taskRelations: ["tasks", "relations"] as const,
  herdrStatus: ["herdr-status"] as const,
  agentStatuses: ["agent-statuses"] as const,
  pullRequestStatuses: ["pull-request-statuses"] as const,
  machineSettings: (machine: Machine) => ["machine-settings", machine] as const,
  branches: (workspace: WorkspaceId) => ["branches", workspace] as const,
  commitRecords: (taskId: TaskId) => ["tasks", taskId, "commit-records"] as const,
  branchFreshness: (taskId: TaskId) => ["tasks", taskId, "branch-freshness"] as const,
  herdrMachines: ["herdr-machines"] as const,
  backups: ["backups"] as const,
  backupSettings: ["backup-settings"] as const,
  mcpServerInfo: ["mcp-server-info"] as const,
  mcpTunnels: ["mcp-tunnels"] as const,
  review: (start: Timestamp, end: Timestamp) => ["review", start, end] as const,
  directories: (machine: Machine, path: string | null) => ["directories", machine, path] as const,
};

/** Where agents reach Toodo's MCP server, and the last request it turned away. */
export function useMcpServerInfo() {
  return useQuery({
    queryKey: queryKeys.mcpServerInfo,
    queryFn: () => commands.mcpServerInfo(),
    refetchInterval: 5000,
  });
}

/** Reverse tunnels that let agents on SSH machines reach the MCP server. */
export function useMcpTunnels() {
  return useQuery({
    queryKey: queryKeys.mcpTunnels,
    queryFn: () => commands.listMcpTunnels(),
    refetchInterval: 3000,
  });
}

/** Backups in Toodo's backup directory, newest first. */
export function useBackups() {
  return useQuery({
    queryKey: queryKeys.backups,
    queryFn: () => unwrap(commands.listBackups()),
  });
}

export function useBackupSettings() {
  return useQuery({
    queryKey: queryKeys.backupSettings,
    queryFn: () => commands.getBackupSettings(),
  });
}

/** Saving may write an automatic backup right away, so the backup list is refetched. */
export function useSaveBackupSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: BackupSettings) => unwrap(commands.saveBackupSettings(settings)),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.backupSettings, settings);
      return queryClient.invalidateQueries({ queryKey: queryKeys.backups });
    },
  });
}

/** Replaces all data with a backup from Toodo's backup directory, by its file name. */
export function useRestoreBackup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => unwrap(commands.restoreBackup(name)),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

/** Downloads a snapshot of the server's database; resolves with its file name. */
export function useDownloadExport() {
  return useMutation({ mutationFn: downloadExport });
}

/** Downloads a backup from the server's backup directory. */
export function useDownloadBackup() {
  return useMutation({ mutationFn: downloadBackup });
}

/** Replaces all data on the server with an uploaded database file. */
export function useUploadRestore() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: uploadRestore,
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

/** Machines saved in herdr; refetched when the window regains focus. */
export function useHerdrMachines() {
  return useQuery({
    queryKey: queryKeys.herdrMachines,
    queryFn: () => unwrap(commands.listHerdrMachines()),
  });
}

/**
 * Subdirectories of `path` on `machine` (the server for `local`); `null`
 * lists the home directory.
 */
export function useDirectories(machine: Machine, path: string | null) {
  return useQuery({
    queryKey: queryKeys.directories(machine, path),
    queryFn: () => unwrap(commands.listDirectories(machine, path)),
    retry: false,
  });
}

/** The home directory of `machine`, listed through the server or over SSH. */
export function useHomeDirectory(machine: Machine) {
  return useQuery({
    queryKey: ["home-directory", machine] as const,
    queryFn: async () => (await unwrap(commands.listDirectories(machine, null))).path,
    staleTime: Infinity,
    retry: false,
  });
}

export function machineOf(location: WorkspaceLocation): Machine {
  return location.kind === "local" ? { kind: "local" } : { kind: "ssh", label: location.machine };
}

export function useWorkspaces() {
  return useQuery({
    queryKey: queryKeys.workspaces,
    queryFn: () => unwrap(commands.listWorkspaces()),
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspace: NewWorkspace) => unwrap(commands.createWorkspace(workspace)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.workspaces }),
  });
}

/** Saves an edited workspace, such as a new default base branch. */
export function useUpdateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspace: Workspace) => unwrap(commands.updateWorkspace(workspace)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
  });
}

/**
 * Moves a workspace to the repository at another location, e.g. to the Windows host it lives on;
 * its tasks stay. Everything is refetched since the tasks may have forgotten their herdr workspaces.
 */
export function useMoveWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, location }: { id: WorkspaceId; location: WorkspaceLocation }) =>
      unwrap(commands.moveWorkspace(id, location)),
    // Not awaited: refetching everything (some queries run over SSH) would keep the move pending.
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
}

/**
 * Branches of the workspace repository, fetched from `origin` each time the base branch
 * picker opens so the list matches the remote.
 */
export function useWorkspaceBranches(workspace: WorkspaceId, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.branches(workspace),
    queryFn: () => unwrap(commands.listWorkspaceBranches(workspace)),
    enabled,
    staleTime: 0,
  });
}

/**
 * How far a started task's branch is behind its base and whether its pull request conflicts.
 * Each check fetches the base from origin, so it runs every few minutes rather than on every render.
 * `null` when the workspace repository has no origin to fall behind.
 */
export function useBranchFreshness(taskId: TaskId, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.branchFreshness(taskId),
    queryFn: () => unwrap(commands.branchFreshness(taskId)),
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}

/** Creates a branch from an existing one, pushes it, and makes it the workspace base. */
export function useCreateBaseBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspace, name, from }: { workspace: WorkspaceId; name: string; from: string }) =>
      unwrap(commands.createWorkspaceBaseBranch(workspace, name, from)),
    onSuccess: (workspace) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.branches(workspace.id) }),
      ]),
  });
}

/** Removes a workspace from Toodo with its tasks; the repository and herdr stay untouched. */
export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: WorkspaceId) => unwrap(commands.deleteWorkspace(id)),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
      ]),
  });
}

/** Tasks of every workspace; a status change may release dependents in other workspaces. */
export function useTasks() {
  return useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => unwrap(commands.listTasks()),
  });
}

/** Tasks of every workspace with a milestone or commit in `[start, end)`. */
export function useReview(start: Timestamp, end: Timestamp) {
  return useQuery({
    queryKey: queryKeys.review(start, end),
    queryFn: () => unwrap(commands.reviewPeriod(start, end)),
  });
}

export function useHerdrStatus() {
  return useQuery({
    queryKey: queryKeys.herdrStatus,
    queryFn: () => unwrap(commands.herdrStatus()),
  });
}

/** Agent status of each task whose herdr workspace runs an agent; kept current by `useHerdrEvents`. */
export function useAgentStatuses() {
  return useQuery({
    queryKey: queryKeys.agentStatuses,
    queryFn: () => commands.listAgentStatuses(),
  });
}

/** CI and review state of the pull request of each `in_review` task; kept current by `useHerdrEvents`. */
export function usePullRequestStatuses() {
  return useQuery({
    queryKey: queryKeys.pullRequestStatuses,
    queryFn: () => commands.listPullRequestStatuses(),
  });
}

/** Applies the changes the backend reports from herdr events and pull request checks while the app is mounted. */
export function useHerdrEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    /**
     * Stores `next` under `key` and notifies the alerts `alerts` finds against the previous
     * snapshot. Without a previous snapshot nothing is known to have changed. The app being
     * in focus means the user already sees the change on the task.
     */
    function update<T>(
      key: readonly string[],
      next: T[],
      alerts: (previous: T[], next: T[], tasks: Task[]) => AgentAlert[],
    ) {
      const previous = queryClient.getQueryData<T[]>(key);
      queryClient.setQueryData(key, next);
      if (previous === undefined || document.hasFocus()) {
        return;
      }
      const tasks = queryClient.getQueryData<Task[]>(queryKeys.tasks) ?? [];
      notify(alerts(previous, next, tasks)).catch((error: unknown) =>
        console.error("toodo: failed to show notifications", error),
      );
    }

    const subscriptions = [
      events.tasksChanged.listen(async () => {
        const previous = queryClient.getQueryData<Task[]>(queryKeys.tasks);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
          // A task completed in the background got the commits of its pull request.
          queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        ]);
        if (previous === undefined || document.hasFocus()) {
          return;
        }
        const next = queryClient.getQueryData<Task[]>(queryKeys.tasks) ?? [];
        notify(taskStatusAlerts(previous, next)).catch((error: unknown) =>
          console.error("toodo: failed to show status notifications", error),
        );
      }),
      events.workspacesChanged.listen(() =>
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
      ),
      events.agentStatusesChanged.listen(({ payload }) =>
        update<TaskAgentStatus>(queryKeys.agentStatuses, payload.statuses, agentAlerts),
      ),
      events.pullRequestStatusesChanged.listen(({ payload }) =>
        update<TaskPullRequestStatus>(queryKeys.pullRequestStatuses, payload.statuses, pullRequestAlerts),
      ),
    ];
    return () => {
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, [queryClient]);
}

export function useMachineSettings(machine: Machine) {
  return useQuery({
    queryKey: queryKeys.machineSettings(machine),
    queryFn: () => unwrap(commands.getMachineSettings(machine)),
  });
}

export function useSaveMachineSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: MachineSettings) => unwrap(commands.saveMachineSettings(settings)),
    onSuccess: (settings) =>
      queryClient.setQueryData(queryKeys.machineSettings(settings.machine), settings),
  });
}

export function useStartTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: TaskId) => unwrap(commands.startTask(id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
  });
}

export function useOpenTaskInHerdr() {
  return useMutation({
    mutationFn: (id: TaskId) => unwrap(commands.openTaskInHerdr(id)),
  });
}

/** Focuses the pane of the agent working on a task, or its herdr workspace when no agent is recognized. */
export function useFocusAgentPane() {
  return useMutation({
    mutationFn: (id: TaskId) => unwrap(commands.focusAgentPane(id)),
  });
}

export function useCommitRecords(taskId: TaskId, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.commitRecords(taskId),
    queryFn: () => unwrap(commands.listCommitRecords(taskId)),
    enabled,
  });
}

export function useRefreshCommitRecords() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: TaskId) => unwrap(commands.refreshCommitRecords(taskId)),
    onSuccess: (records, taskId) => queryClient.setQueryData(queryKeys.commitRecords(taskId), records),
  });
}

/** Pushes the task branch and opens (or reuses) its pull request; the task moves to `in_review`. */
export function useOpenPullRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: TaskId) => unwrap(commands.openPullRequest(id)),
    onSuccess: (task) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.commitRecords(task.id) }),
      ]),
  });
}

/**
 * Completes an `in_progress` or `in_review` task once all its criteria are met; the backend
 * checks the automatic ones again first. For a task with a manual criterion this is the
 * confirmation that it is done.
 */
export function useCompleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: TaskId) => unwrap(commands.completeTask(id)),
    // Completing records the commits of the merged pull request.
    onSuccess: (task) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.commitRecords(task.id) }),
      ]),
  });
}

/**
 * Concludes an active task without merging it, e.g. research that is not adopted: it becomes
 * `done` as `not_adopted` with `note` as its conclusion, and its open pull request is closed.
 */
export function useConcludeTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: TaskId; note: string }) => unwrap(commands.concludeTask(id, note)),
    // Concluding records the commits of the branch.
    onSuccess: (task) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.commitRecords(task.id) }),
        queryClient.invalidateQueries({ queryKey: ["review"] }),
      ]),
  });
}

/** Saves the completion note of a done task; an empty note clears it. */
export function useSetCompletionNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: TaskId; note: string }) => unwrap(commands.setCompletionNote(id, note)),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: ["review"] }),
      ]),
  });
}

/**
 * Reopens a done task completed or concluded by mistake: it becomes `planned` again, paused if it
 * was started, and `reason` is kept as a progress note with the earlier outcome.
 */
export function useReopenTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: TaskId; reason: string }) => unwrap(commands.reopenTask(id, reason)),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: ["review"] }),
      ]),
  });
}

/** Corrects how a done task ended; `note` becomes its completion note and the change is kept as a progress note. */
export function useSetTaskOutcome() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolution, note }: { id: TaskId; resolution: TaskResolution; note: string }) =>
      unwrap(commands.setTaskOutcome(id, resolution, note)),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: ["review"] }),
      ]),
  });
}

/**
 * Completes a task whose work shipped through another task or a merged pull request: exactly one of
 * `mergedWithTask` and `pullRequestUrl`. An active task, or one concluded as not adopted, becomes done.
 */
export function useCompleteTaskMergedWith() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      mergedWithTask,
      pullRequestUrl,
    }: {
      id: TaskId;
      mergedWithTask: TaskId | null;
      pullRequestUrl: string | null;
    }) => unwrap(commands.completeTaskMergedWith(id, mergedWithTask, pullRequestUrl)),
    // Completing records the commits of the branch.
    onSuccess: (task) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.commitRecords(task.id) }),
        queryClient.invalidateQueries({ queryKey: ["review"] }),
      ]),
  });
}

/** Checks out the branch of an active task that lost its worktree into a new herdr worktree. */
export function useRestoreTaskWorktree() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: TaskId) => unwrap(commands.restoreTaskWorktree(id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (task: TaskEdit) => unwrap(commands.updateTask(task)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
  });
}

/** Commands that change tasks that other tasks, possibly in other workspaces, may wait on. */
function useTasksMutation<T>(mutationFn: (variables: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
  });
}

/** Pauses a started task: it becomes planned again and keeps its branch and worktree. */
export function usePauseTask() {
  return useTasksMutation((id: TaskId) => unwrap(commands.pauseTask(id)));
}

/** Closes the herdr workspace of a paused task; its worktree is kept for resuming. */
export function useCloseTaskWorkspace() {
  return useTasksMutation((id: TaskId) => unwrap(commands.closeTaskWorkspace(id)));
}

type CriterionCheck = { taskId: TaskId; criterionId: CriterionId; met: boolean; evidence: string | null };

/**
 * Checks or unchecks a manual criterion of a task that is not done. Checking the last one
 * moves a started task to awaiting completion.
 */
export function useCheckCriterion() {
  return useTasksMutation(({ taskId, criterionId, met, evidence }: CriterionCheck) =>
    unwrap(commands.checkCriterion(taskId, criterionId, met, evidence)),
  );
}

/** Deletes a task, first removing its worktree through herdr; `force` discards local changes. */
export function useDeleteTask() {
  return useTasksMutation(({ id, force }: { id: TaskId; force: boolean }) =>
    unwrap(commands.deleteTask(id, force)),
  );
}

/** The edge `id -> dependsOn`; `dependsOn` may be a task of another workspace. */
type Dependency = { id: TaskId; dependsOn: TaskId };

/**
 * Adds the edge `id -> dependsOn`. Without `confirmPause`, a prerequisite that would pause the
 * started task is not added and the outcome is `confirm_pause`: the server decides, so the
 * user is asked before the pause even when the cached tasks are stale.
 */
export function useAddDependency() {
  return useTasksMutation(({ id, dependsOn, confirmPause }: Dependency & { confirmPause: boolean }) =>
    unwrap(commands.addDependency(id, dependsOn, confirmPause)),
  );
}

export function useRemoveDependency() {
  return useTasksMutation(({ id, dependsOn }: Dependency) => unwrap(commands.removeDependency(id, dependsOn)));
}

/** Every related link between tasks of any workspaces. */
export function useTaskRelations() {
  return useQuery({
    queryKey: queryKeys.taskRelations,
    queryFn: () => unwrap(commands.listTaskRelations()),
  });
}

/** The link between `taskId` and `relatedId`, which may belong to another workspace. */
type Relation = { taskId: TaskId; relatedId: TaskId };

function useRelationMutation(mutationFn: (relation: Relation) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.taskRelations }),
  });
}

export function useAddRelation() {
  return useRelationMutation(({ taskId, relatedId }) => unwrap(commands.addTaskRelation(taskId, relatedId)));
}

export function useRemoveRelation() {
  return useRelationMutation(({ taskId, relatedId }) => unwrap(commands.removeTaskRelation(taskId, relatedId)));
}

/** Links GitHub issue `number` of the workspace repository to a task; `null` unlinks it. */
export function useLinkIssue() {
  return useTasksMutation(({ id, number }: { id: TaskId; number: number | null }) =>
    unwrap(commands.linkIssue(id, number)),
  );
}

/** Opens a GitHub issue from the title and description of a task and links it. */
export function useCreateIssue() {
  return useTasksMutation((id: TaskId) => unwrap(commands.createIssue(id)));
}

/** The task was created, but its issue could not be linked. */
export class IssueLinkFailure extends Error {
  constructor(taskId: TaskId, issue: number, reason: string) {
    super(`Task #${taskId} was added, but issue #${issue} could not be linked: ${reason}`);
    this.name = "IssueLinkFailure";
  }
}

/** Creates a task, then links issue `issue` to it when one is given. */
export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ issue, ...task }: NewTask & { issue: number | null }) => {
      const created = await unwrap(commands.createTask(task));
      if (issue === null) {
        return created;
      }
      try {
        return await unwrap(commands.linkIssue(created.id, issue));
      } catch (error) {
        throw new IssueLinkFailure(created.id, issue, error instanceof Error ? error.message : String(error));
      }
    },
    // A task whose issue could not be linked was still created.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
  });
}
