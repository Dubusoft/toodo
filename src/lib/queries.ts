import { useEffect } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import {
  commands,
  events,
  type AgentAdapter,
  type AgentOptions,
  type BackupSettings,
  type CommandError,
  type CriterionId,
  type Machine,
  type MachineSettings,
  type NewTask,
  type NewWorkspace,
  type PullRequestOptions,
  type ReviewSnapshotId,
  type RunId,
  type SaveReviewSnapshotRequest,
  type RunState,
  type Task,
  type TaskEdit,
  type TaskId,
  type TaskListFilter,
  type TaskResolution,
  type TaskStatus,
  type TaskAgentStatus,
  type TaskPullRequestStatus,
  type TaskRun,
  type Workspace,
  type WorkspaceId,
  type WorkspaceLocation,
} from "@/lib/bindings";
import { commandErrorMessage } from "@/lib/error-messages";
import { downloadBackup, downloadExport, uploadRestore } from "@/web/files";
import { agentAlerts, notify, pullRequestAlerts, taskStatusAlerts, type AgentAlert } from "@/lib/agent-alerts";

type CommandResult<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError };

export class CommandFailure extends Error {
  readonly kind: CommandError["kind"];
  readonly code: CommandError["code"];

  constructor(error: CommandError) {
    super(commandErrorMessage(error));
    this.name = "CommandFailure";
    this.kind = error.kind;
    this.code = error.code;
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
  /**
   * Tasks of every workspace, loaded in pages (see `useTasks`): dependencies cross workspaces,
   * so they are loaded together. Not `["task-list"]` alone, which held one plain list before.
   */
  tasks: ["task-list", "pages"] as const,
  /** Related links between tasks; under "tasks", so a tasks-changed event refetches them. */
  taskRelations: ["tasks", "relations"] as const,
  /** Deleted workspaces and tasks; under "tasks", so a tasks-changed event refetches them. */
  archive: ["tasks", "archive"] as const,
  herdrStatus: ["herdr-status"] as const,
  runnerHealth: ["runner-health"] as const,
  agentStatuses: ["agent-statuses"] as const,
  pullRequestStatuses: ["pull-request-statuses"] as const,
  machineSettings: (machine: Machine) => ["machine-settings", machine] as const,
  /** Under "tasks", so a tasks-changed event, e.g. a run that started or ended, refetches it. */
  machineRuns: (machine: Machine) => ["tasks", "machine-runs", machine] as const,
  branches: (workspace: WorkspaceId) => ["branches", workspace] as const,
  commitRecords: (taskId: TaskId) => ["tasks", taskId, "commit-records"] as const,
  taskActivity: (taskId: TaskId) => ["tasks", taskId, "activity"] as const,
  branchFreshness: (taskId: TaskId) => ["tasks", taskId, "branch-freshness"] as const,
  taskRuns: (taskId: TaskId) => ["tasks", taskId, "runs"] as const,
  /** Under "agent-options", so saving a workspace's options refetches the task views that show them. */
  workspaceAgentOptions: (workspace: WorkspaceId) => ["agent-options", "workspace", workspace] as const,
  taskAgentOptions: (taskId: TaskId) => ["agent-options", "task", taskId] as const,
  workspacePullRequestOptions: (workspace: WorkspaceId) => ["pull-request-options", workspace] as const,
  /** Not under "tasks": agent status changes refetch them, task changes do not. */
  agentStatusTransitions: (taskId: TaskId) => ["agent-status-transitions", taskId] as const,
  /** Not under "tasks": a log can be large, so it is refetched only for its run. */
  runLog: (runId: RunId | null) => ["run-log", runId] as const,
  herdrMachines: ["herdr-machines"] as const,
  backups: ["backups"] as const,
  backupSettings: ["backup-settings"] as const,
  backupStatus: ["backup-status"] as const,
  mcpServerInfo: ["mcp-server-info"] as const,
  mcpTunnels: ["mcp-tunnels"] as const,
  review: (from: string, to: string) => ["review", from, to] as const,
  /** Under "review", so changing it refetches every review. */
  reviewTimeZone: ["review", "time-zone"] as const,
  /** Not under "review": saved reviews never change with the tasks. */
  reviewSnapshots: ["review-snapshots"] as const,
  reviewSnapshot: (id: ReviewSnapshotId) => ["review-snapshots", id] as const,
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

/**
 * Whether the latest automatic backup failed. The server checks for a due backup every ten
 * minutes, so this is refetched every minute.
 */
export function useBackupStatus() {
  return useQuery({
    queryKey: queryKeys.backupStatus,
    queryFn: () => commands.getBackupStatus(),
    refetchInterval: 60_000,
  });
}

/** Saving may write an automatic backup right away, so the backup list and status are refetched. */
export function useSaveBackupSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: BackupSettings) => unwrap(commands.saveBackupSettings(settings)),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.backupSettings, settings);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.backups }),
        queryClient.invalidateQueries({ queryKey: queryKeys.backupStatus }),
      ]);
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
 * Subdirectories of `path` on `machine` (the server for `local`); nothing is listed
 * while `path` is `null`.
 */
export function useDirectories(machine: Machine, path: string | null) {
  return useQuery({
    queryKey: queryKeys.directories(machine, path),
    queryFn: () => unwrap(commands.listDirectories(machine, path)),
    enabled: path !== null,
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

/** Archives a workspace with its tasks; the repository and herdr stay untouched. */
export function useDeleteWorkspace() {
  return useArchiveMutation((id: WorkspaceId) => unwrap(commands.deleteWorkspace(id)));
}

/** The workspaces and tasks deleting archived, to restore or purge. */
export function useArchive() {
  return useQuery({ queryKey: queryKeys.archive, queryFn: () => unwrap(commands.listArchive()) });
}

/**
 * Commands that move workspaces or tasks into or out of the archive, which changes the
 * workspaces, the tasks, the archive, and what reviews show.
 */
function useArchiveMutation<T>(mutationFn: (variables: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
        queryClient.invalidateQueries({ queryKey: queryKeys.archive }),
        queryClient.invalidateQueries({ queryKey: ["review"] }),
      ]),
  });
}

export function useRestoreWorkspace() {
  return useArchiveMutation((id: WorkspaceId) => unwrap(commands.restoreWorkspace(id)));
}

/** Deletes an archived workspace for good with its tasks and their history. */
export function usePurgeWorkspace() {
  return useArchiveMutation((id: WorkspaceId) => unwrap(commands.purgeWorkspace(id)));
}

export function useRestoreTask() {
  return useArchiveMutation((id: TaskId) => unwrap(commands.restoreTask(id)));
}

/** Deletes an archived task for good with its history. */
export function usePurgeTask() {
  return useArchiveMutation((id: TaskId) => unwrap(commands.purgeTask(id)));
}

/** How many finished tasks a page of the task list loads, newest first. */
export const finishedTasksPage = 100;

const openStatuses: TaskStatus[] = ["planned", "in_progress", "in_review"];

/** Loaded tasks, and the ID to load older finished tasks below; null when there are none. */
export type TasksPage = { tasks: Task[]; olderBefore: TaskId | null };

function listTasks(filter: TaskListFilter): Promise<Task[]> {
  return unwrap(commands.listTasks(filter));
}

/**
 * A page of the task list. The first holds every open task, the newest finished ones, and the
 * finished tasks the open ones depend on; each later page the next older finished tasks. So the
 * first screen loads a bounded number of tasks however long the history grows.
 */
async function loadTasksPage(before: TaskId | null): Promise<TasksPage> {
  const finished = listTasks({ statuses: ["done"], before, limit: finishedTasksPage });
  const olderBefore = (tasks: Task[]) =>
    tasks.length < finishedTasksPage ? null : Math.min(...tasks.map((task) => task.id));
  if (before !== null) {
    const older = await finished;
    return { tasks: older, olderBefore: olderBefore(older) };
  }
  const [open, newest] = await Promise.all([listTasks({ statuses: openStatuses }), finished]);
  const loaded = new Set([...open, ...newest].map((task) => task.id));
  const missing = [...new Set(open.flatMap((task) => task.dependsOn))].filter((id) => !loaded.has(id));
  const chunks: TaskId[][] = [];
  for (let start = 0; start < missing.length; start += finishedTasksPage) {
    chunks.push(missing.slice(start, start + finishedTasksPage));
  }
  const prerequisites = await Promise.all(chunks.map((ids) => listTasks({ ids })));
  return { tasks: [...open, ...newest, ...prerequisites.flat()], olderBefore: olderBefore(newest) };
}

/** Every task the pages loaded, once each, ordered by ID: a page may repeat a task another holds. */
export function loadedTasks(data: InfiniteData<TasksPage, TaskId | null>): Task[] {
  const byId = new Map<TaskId, Task>();
  for (const page of data.pages) {
    for (const task of page.tasks) byId.set(task.id, task);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** The loaded tasks in the cache of `queryClient`, without loading them. */
export function cachedTasks(queryClient: QueryClient): Task[] | undefined {
  const data = queryClient.getQueryData<InfiniteData<TasksPage, TaskId | null>>(queryKeys.tasks);
  return data === undefined ? undefined : loadedTasks(data);
}

/**
 * Tasks of every workspace, as loaded so far: open ones and the newest finished ones first,
 * older finished ones on `fetchNextPage`. A status change may release dependents in other
 * workspaces, so they load together. The tasks `wanted` names (one a link or a search points at)
 * are loaded too when the pages do not hold them yet.
 */
export function useTasks(wanted: readonly (TaskId | null | undefined)[] = []) {
  const pages = useInfiniteQuery({
    queryKey: queryKeys.tasks,
    queryFn: ({ pageParam }) => loadTasksPage(pageParam),
    initialPageParam: null as TaskId | null,
    getNextPageParam: (page) => page.olderBefore,
    select: loadedTasks,
  });
  const paged = pages.data;
  const pagedIds = new Set(paged?.map((task) => task.id));
  const missing = [
    ...new Set(wanted.filter((id): id is TaskId => id !== null && id !== undefined && !pagedIds.has(id))),
  ].sort((a, b) => a - b);
  // Under the pages' key, so whatever refreshes the pages refreshes these too.
  const extra = useQuery({
    queryKey: [...queryKeys.tasks, "by-id", missing],
    queryFn: () => listTasks({ ids: missing }),
    enabled: paged !== undefined && missing.length > 0,
  });
  const extraTasks = missing.length === 0 ? [] : (extra.data ?? []);
  if (paged === undefined || extraTasks.length === 0) return pages;
  return { ...pages, data: [...paged, ...extraTasks].sort((a, b) => a.id - b.id) };
}

/**
 * Tasks of every workspace with a milestone or commit in the days `from` to `to`, judged in the
 * review time zone of the server, with the period it judged them by.
 */
export function useReview(from: string, to: string) {
  return useQuery({
    queryKey: queryKeys.review(from, to),
    queryFn: () => unwrap(commands.reviewPeriod(from, to)),
  });
}

/** The time zone the server judges reviewed periods in. */
export function useReviewTimeZone() {
  return useQuery({
    queryKey: queryKeys.reviewTimeZone,
    queryFn: () => unwrap(commands.getReviewTimeZone()),
  });
}

/** Sets the review time zone (`null` for the server's own); every review is refetched. */
export function useSetReviewTimeZone() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (timeZone: string | null) => unwrap(commands.setReviewTimeZone(timeZone)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review"] }),
  });
}

/** The saved reviews, the most recently saved first. */
export function useReviewSnapshots() {
  return useQuery({
    queryKey: queryKeys.reviewSnapshots,
    queryFn: () => unwrap(commands.listReviewSnapshots()),
  });
}

/** A saved review as it was saved; nothing is loaded while `id` is null. */
export function useReviewSnapshot(id: ReviewSnapshotId | null) {
  return useQuery({
    queryKey: queryKeys.reviewSnapshot(id ?? 0),
    queryFn: () => unwrap(commands.getReviewSnapshot(id ?? 0)),
    enabled: id !== null,
    staleTime: Infinity,
  });
}

export function useSaveReviewSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: SaveReviewSnapshotRequest) => unwrap(commands.saveReviewSnapshot(request)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.reviewSnapshots }),
  });
}

export function useDeleteReviewSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: ReviewSnapshotId) => unwrap(commands.deleteReviewSnapshot(id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.reviewSnapshots }),
  });
}

/** Records the pull requests the user merged in the days `from` to `to` as done tasks, for reviews of that time. */
export function useBackfillPullRequests() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => unwrap(commands.backfillPullRequests(from, to)),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: ["review"] }),
      ]),
  });
}

export function useHerdrStatus() {
  return useQuery({
    queryKey: queryKeys.herdrStatus,
    queryFn: () => unwrap(commands.herdrStatus()),
  });
}

/**
 * Whether herdr runs on the server and which agent CLIs of plain runs are on its `PATH`.
 * Installing or starting a tool sends no event, so it is checked again every minute, when the
 * window regains focus, and on request.
 */
export function useRunnerHealth() {
  return useQuery({
    queryKey: queryKeys.runnerHealth,
    queryFn: () => unwrap(commands.runnerHealth()),
    refetchInterval: 60_000,
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
      const tasks = cachedTasks(queryClient) ?? [];
      notify(alerts(previous, next, tasks)).catch((error: unknown) =>
        console.error("toodo: failed to show notifications", error),
      );
    }

    const subscriptions = [
      events.tasksChanged.listen(async () => {
        const previous = cachedTasks(queryClient);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
          // A task completed in the background got the commits of its pull request.
          queryClient.invalidateQueries({ queryKey: ["tasks"] }),
        ]);
        if (previous === undefined || document.hasFocus()) {
          return;
        }
        const next = cachedTasks(queryClient) ?? [];
        notify(taskStatusAlerts(previous, next)).catch((error: unknown) =>
          console.error("toodo: failed to show status notifications", error),
        );
      }),
      events.workspacesChanged.listen(() =>
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
      ),
      events.agentStatusesChanged.listen(({ payload }) => {
        update<TaskAgentStatus>(queryKeys.agentStatuses, payload.statuses, agentAlerts);
        // The server stored the transitions before it sent the change.
        void queryClient.invalidateQueries({ queryKey: ["agent-status-transitions"] });
      }),
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

/** How many runs the machine runs at once, and how many run or wait there now. */
export function useMachineRuns(machine: Machine) {
  return useQuery({
    queryKey: queryKeys.machineRuns(machine),
    queryFn: () => unwrap(commands.getMachineRuns(machine)),
    // Runs end without an event, so the counts reload while any run is there.
    refetchInterval: (query) =>
      query.state.data && query.state.data.activeRuns + query.state.data.queuedRuns > 0 ? liveRunInterval : false,
  });
}

export function useSetMachineRunLimit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ machine, limit }: { machine: Machine; limit: number | null }) =>
      unwrap(commands.setMachineRunLimit(machine, limit)),
    // Queued runs that a raised limit starts show on their own: runs reload while queued.
    onSuccess: (runs) => queryClient.setQueryData(queryKeys.machineRuns(runs.machine), runs),
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

/**
 * The git activity of a task, oldest first: commits, its pull request, CI results, and the merge.
 * The background checks record it and send tasks-changed, which refetches it.
 */
export function useTaskActivity(taskId: TaskId, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.taskActivity(taskId),
    queryFn: () => unwrap(commands.listTaskActivity(taskId)),
    enabled,
  });
}

/**
 * When the agent in a task's herdr workspace changed what it was doing, oldest first; agent
 * status changes refetch it.
 */
export function useAgentStatusTransitions(taskId: TaskId, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agentStatusTransitions(taskId),
    queryFn: () => unwrap(commands.listAgentStatusTransitions(taskId)),
    enabled,
  });
}

/** How often the runs of a task and the log of a run reload while a run is starting or running. */
const liveRunInterval = 3_000;

/** Whether a run in `state` still changes on its own: it waits for a run slot, or its agent is starting or working. */
function isLive(state: RunState): boolean {
  return state === "queued" || state === "reserved" || state === "running";
}

/**
 * The runs of a task, oldest first. Runs send no events, so they are refetched on request,
 * when the window regains focus, when the tasks change, and every few seconds while one of
 * them is starting or running.
 */
export function useTaskRuns(taskId: TaskId) {
  return useQuery({
    queryKey: queryKeys.taskRuns(taskId),
    queryFn: () => unwrap(commands.listTaskRuns(taskId)),
    refetchInterval: (query) => (query.state.data?.some((run) => isLive(run.state)) ? liveRunInterval : false),
  });
}

/**
 * A run with its events and the ends of its stdout and stderr; nothing is loaded while `runId`
 * is `null`. While the run is starting or running, it reloads every few seconds, so the output
 * shows as the agent writes it; the log of a run that ended no longer changes.
 */
export function useRunLog(runId: RunId | null) {
  return useQuery({
    queryKey: queryKeys.runLog(runId),
    queryFn: () => unwrap(commands.getRunLog(runId!, null)),
    enabled: runId !== null,
    refetchInterval: (query) => (query.state.data && isLive(query.state.data.run.state) ? liveRunInterval : false),
  });
}

/**
 * Starts Claude or Codex on the worktree of an `in_progress` task of a plain or tmux workspace,
 * with the task as its prompt; with `followUpOf`, an ended run, the agent resumes that run's
 * session with `prompt` instead. A launch that fails is still recorded as a failed run, so the
 * runs are refetched either way.
 */
export function useStartPlainRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      adapter,
      mcp,
      prompt = null,
      followUpOf = null,
    }: {
      taskId: TaskId;
      adapter: AgentAdapter;
      mcp: boolean;
      prompt?: string | null;
      followUpOf?: RunId | null;
    }) => unwrap(commands.startPlainRun(taskId, adapter, prompt, mcp, followUpOf)),
    onSettled: (_run, _error, { taskId }) => queryClient.invalidateQueries({ queryKey: queryKeys.taskRuns(taskId) }),
  });
}

/** The model, permission mode, and time limit a workspace sets for the runs of its tasks. */
export function useWorkspaceAgentOptions(workspace: WorkspaceId) {
  return useQuery({
    queryKey: queryKeys.workspaceAgentOptions(workspace),
    queryFn: () => unwrap(commands.getWorkspaceAgentOptions(workspace)),
  });
}

/** The launch options a task overrides, and the ones its workspace sets for the rest. */
export function useTaskAgentOptions(taskId: TaskId) {
  return useQuery({
    queryKey: queryKeys.taskAgentOptions(taskId),
    queryFn: () => unwrap(commands.getTaskAgentOptions(taskId)),
  });
}

/** Saves the launch options of a workspace; runs started later use them. */
export function useSetWorkspaceAgentOptions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspace, options }: { workspace: WorkspaceId; options: AgentOptions }) =>
      unwrap(commands.setWorkspaceAgentOptions(workspace, options)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent-options"] }),
  });
}

/** Whether a workspace opens pull requests as drafts, and the reviewers and labels they get. */
export function useWorkspacePullRequestOptions(workspace: WorkspaceId) {
  return useQuery({
    queryKey: queryKeys.workspacePullRequestOptions(workspace),
    queryFn: () => unwrap(commands.getWorkspacePullRequestOptions(workspace)),
  });
}

/** Saves the pull request options of a workspace; pull requests opened later use them. */
export function useSetWorkspacePullRequestOptions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspace, options }: { workspace: WorkspaceId; options: PullRequestOptions }) =>
      unwrap(commands.setWorkspacePullRequestOptions(workspace, options)),
    onSuccess: (saved, { workspace }) =>
      queryClient.setQueryData(queryKeys.workspacePullRequestOptions(workspace), saved),
  });
}

/** Saves the launch options a task overrides; runs started later use them. */
export function useSetTaskAgentOptions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, options }: { taskId: TaskId; options: AgentOptions }) =>
      unwrap(commands.setTaskAgentOptions(taskId, options)),
    onSuccess: (saved, { taskId }) => queryClient.setQueryData(queryKeys.taskAgentOptions(taskId), saved),
  });
}

/** Stops a plain or tmux run: it ends as cancelled; a run that already ended stays as it is. */
export function useStopRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (run: TaskRun) => unwrap(commands.stopRun(run.id)),
    onSettled: (_stopped, _error, run) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.taskRuns(run.taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.runLog(run.id) }),
      ]),
  });
}

/**
 * Settles a run whose end was not seen (`unknown`, e.g. after a server restart or a lost SSH
 * connection) from what its host recorded; it never starts the agent again.
 */
export function useReconcileRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (run: TaskRun) => unwrap(commands.reconcileRun(run.id)),
    onSettled: (_reconciled, _error, run) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.taskRuns(run.taskId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.runLog(run.id) }),
      ]),
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
    // Completing records the commits of the merged pull request and its git activity.
    onSuccess: (task) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.commitRecords(task.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.taskActivity(task.id) }),
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
    // Reviews compare a task's estimate and due date with what happened.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: ["review"] }),
      ]),
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

/**
 * Archives a task, first removing its worktree through herdr; `force` discards local changes.
 */
export function useDeleteTask() {
  return useArchiveMutation(({ id, force }: { id: TaskId; force: boolean }) =>
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
