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
  type BackupSettings,
  type ChatAttachment,
  type ChatAttachmentId,
  type ChatChannelEdit,
  type ChatChannelId,
  type ChatMessage,
  type ChatMessageId,
  type ChatPlace,
  type ChatThreadEdit,
  type ChatThreadFilter,
  type ChatThreadId,
  type ChatView,
  type NewChatThread,
  type CommandError,
  type CriterionId,
  type Guideline,
  type GuidelineId,
  type GuidelineUpdate,
  type NewGuideline,
  type NewTask,
  type NewWorkspace,
  type ReviewSnapshotId,
  type SaveReviewSnapshotRequest,
  type Task,
  type TaskEdit,
  type TaskId,
  type TaskListFilter,
  type TaskResolution,
  type TaskStatus,
  type Timestamp,
  type Workspace,
  type WorkspaceId,
} from "@/lib/bindings";
import { commandErrorMessage, LocalizedError } from "@/lib/error-messages";
import { useMessages } from "@/lib/i18n";
import { downloadBackup, downloadExport, uploadRestore } from "@/web/files";
import { apiRequest } from "@/web/session";
import { notify, taskStatusAlerts } from "@/lib/task-alerts";

type CommandResult<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError };

export class CommandFailure extends LocalizedError {
  readonly kind: CommandError["kind"];
  readonly code: CommandError["code"];

  constructor(error: CommandError) {
    super((m) => commandErrorMessage(error, m));
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
  /** The rules and memory of one workspace, refetched on its guidelines-changed events. */
  guidelines: (workspaceId: WorkspaceId) => ["guidelines", workspaceId] as const,
  /**
   * Tasks of every workspace, loaded in pages (see `useTasks`): dependencies cross workspaces,
   * so they are loaded together. Not `["task-list"]` alone, which held one plain list before.
   */
  tasks: ["task-list", "pages"] as const,
  /** Related links between tasks; under "tasks", so a tasks-changed event refetches them. */
  taskRelations: ["tasks", "relations"] as const,
  /** Deleted workspaces and tasks; under "tasks", so a tasks-changed event refetches them. */
  archive: ["tasks", "archive"] as const,
  backups: ["backups"] as const,
  backupSettings: ["backup-settings"] as const,
  backupStatus: ["backup-status"] as const,
  mcpServerInfo: ["mcp-server-info"] as const,
  review: (from: string, to: string) => ["review", from, to] as const,
  /** Under "review", so changing it refetches every review. */
  reviewTimeZone: ["review", "time-zone"] as const,
  /** Not under "review": saved reviews never change with the tasks. */
  reviewSnapshots: ["review-snapshots"] as const,
  reviewSnapshot: (id: ReviewSnapshotId) => ["review-snapshots", id] as const,
  /** Everything of the chat with the agent: its channels, threads, and messages. */
  chat: ["chat"] as const,
  /** The messages of a channel or thread, loaded in pages back from the latest message. */
  chatMessages: (place: ChatPlace) => ["chat", "messages", place] as const,
  chatChannels: ["chat", "channels"] as const,
  chatThreads: (filter: ChatThreadFilter) => ["chat", "threads", filter] as const,
  /** Messages matching a search; under "chat", so new messages refresh the results. */
  chatSearch: (query: string, place: ChatPlace | null) => ["chat", "search", query, place] as const,
  /** The bytes of an attachment as an object URL; not under "chat": a file never changes. */
  chatAttachment: (id: ChatAttachmentId) => ["chat-attachment", id] as const,
};

/**
 * The messages of a channel or thread of the chat with the agent connected over MCP: pages, the
 * latest first, refetched on chat-changed events (see `useServerEvents`).
 */
export function useChat(place: ChatPlace) {
  return useInfiniteQuery({
    queryKey: queryKeys.chatMessages(place),
    queryFn: ({ pageParam }) => unwrap(commands.listChat(place, pageParam)),
    initialPageParam: null as ChatMessageId | null,
    getNextPageParam: (page) => (page.hasEarlier ? (page.messages[0]?.id ?? null) : null),
  });
}

/** The chat's channels with their unread counts. */
export function useChatChannels() {
  return useQuery({ queryKey: queryKeys.chatChannels, queryFn: () => unwrap(commands.listChatChannels()) });
}

/** The threads `filter` selects, the latest active first. */
export function useChatThreads(filter: ChatThreadFilter) {
  return useQuery({ queryKey: queryKeys.chatThreads(filter), queryFn: () => unwrap(commands.listChatThreads(filter)) });
}

/** Records that a channel or thread was read up to a message, which clears its unread count. */
export function useMarkChatRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ place, upTo }: { place: ChatPlace; upTo: ChatMessageId }) =>
      unwrap(commands.markChatRead(place, upTo)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chatChannels }),
  });
}

export function useCreateChatChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => unwrap(commands.createChatChannel(name)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chatChannels }),
  });
}

/** Renames a channel or turns its notifications on or off. */
export function useUpdateChatChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, edit }: { id: ChatChannelId; edit: ChatChannelEdit }) =>
      unwrap(commands.updateChatChannel(id, edit)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chatChannels }),
  });
}

/** Deletes a channel; its threads and messages move to the default room. */
export function useDeleteChatChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: ChatChannelId) => unwrap(commands.deleteChatChannel(id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chat }),
  });
}

export function useCreateChatThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (thread: NewChatThread) => unwrap(commands.createChatThread(thread)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chat }),
  });
}

/** Retitles a thread, links or unlinks its task, or opens, closes, or archives it. */
export function useUpdateChatThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, edit }: { id: ChatThreadId; edit: ChatThreadEdit }) => unwrap(commands.updateChatThread(id, edit)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chat }),
  });
}

/** The messages the loaded pages of the chat hold, oldest first. */
export function chatMessages(data: InfiniteData<ChatView, unknown>): ChatMessage[] {
  return [...data.pages].reverse().flatMap((page) => page.messages);
}

/**
 * Chooses an action on the agent's message, which the agent receives as the person's message;
 * `clientId` names the click, so a retry stores it once.
 */
export function useChooseChatAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, key, clientId }: { messageId: ChatMessageId; key: string; clientId: string }) =>
      unwrap(commands.chooseChatAction(messageId, key, clientId)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chat }),
  });
}

/** Messages matching `query`, best first; nothing is asked while it is blank. */
export function useSearchChat(query: string, place: ChatPlace | null) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: queryKeys.chatSearch(trimmed, place),
    queryFn: () => unwrap(commands.searchChat(trimmed, place)),
    enabled: trimmed !== "",
  });
}

/** Uploads a file for a message to come; the message takes it by the returned attachment's ID. */
export async function uploadChatAttachment(file: File): Promise<ChatAttachment> {
  const response = await apiRequest(`/api/chat/attachments?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  return (await response.json()) as ChatAttachment;
}

/**
 * An object URL of an attachment's bytes, fetched signed in: an image or link cannot send the
 * token itself. The URL is kept for as long as the app runs, as the file never changes.
 */
export function useChatAttachmentUrl(id: ChatAttachmentId) {
  return useQuery({
    queryKey: queryKeys.chatAttachment(id),
    queryFn: async () => URL.createObjectURL(await (await apiRequest(`/api/chat/attachments/${id}`)).blob()),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/** Where agents reach Toodo's MCP server, and the last request it turned away. */
export function useMcpServerInfo() {
  return useQuery({
    queryKey: queryKeys.mcpServerInfo,
    queryFn: () => commands.mcpServerInfo(),
    refetchInterval: 5000,
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

/** Saves an edited workspace's name, description, or repository. */
export function useUpdateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspace: Workspace) => unwrap(commands.updateWorkspace(workspace)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
  });
}

/** Archives a workspace with its tasks. */
export function useDeleteWorkspace() {
  return useArchiveMutation((id: WorkspaceId) => unwrap(commands.deleteWorkspace(id)));
}

/** The workspaces and tasks deleting archived, to restore or purge. */
export function useArchive() {
  return useQuery({ queryKey: queryKeys.archive, queryFn: () => unwrap(commands.listArchive()) });
}

/**
 * Refetches what a change of tasks can change, whether this app made it or the server reports
 * it (tasks-changed, e.g. after an MCP call): the task pages and what loads under them, the
 * task links and the archive (under "tasks"), and reviews.
 */
function invalidateTasks(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
    queryClient.invalidateQueries({ queryKey: ["tasks"] }),
    queryClient.invalidateQueries({ queryKey: ["review"] }),
  ]);
}

/**
 * Commands that move workspaces or tasks into or out of the archive, which changes the
 * workspaces as well as the tasks.
 */
function useArchiveMutation<T>(mutationFn: (variables: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      Promise.all([
        invalidateTasks(queryClient),
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
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

/** The guidelines of a workspace: its rules, then its memory, each in the order they were added. */
export function useGuidelines(workspaceId: WorkspaceId) {
  return useQuery({
    queryKey: queryKeys.guidelines(workspaceId),
    queryFn: () => unwrap(commands.listGuidelines(workspaceId)),
  });
}

/** Commands that change a guideline; each answers with it, naming the workspace to refetch. */
function useGuidelineMutation<T>(mutationFn: (variables: T) => Promise<Guideline>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (guideline) => queryClient.invalidateQueries({ queryKey: queryKeys.guidelines(guideline.workspaceId) }),
  });
}

export function useAddGuideline() {
  return useGuidelineMutation((guideline: NewGuideline) => unwrap(commands.addGuideline(guideline)));
}

/** Replaces the kind and body of a guideline. */
export function useUpdateGuideline() {
  return useGuidelineMutation((guideline: GuidelineUpdate) => unwrap(commands.updateGuideline(guideline)));
}

/** Deletes a guideline for good. */
export function useDeleteGuideline() {
  return useGuidelineMutation((id: GuidelineId) => unwrap(commands.deleteGuideline(id)));
}

/** How many finished tasks a page of the task list loads, newest first. */
export const finishedTasksPage = 100;

const openStatuses: TaskStatus[] = ["planned", "in_progress", "in_review"];

/** Loaded tasks, and the ID to load older finished tasks below; null when there are none. */
export type TasksPage = { tasks: Task[]; olderBefore: TaskId | null };

export function listTasks(filter: TaskListFilter): Promise<Task[]> {
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
 * Drops the pages of older finished tasks loaded so far, keeping the first page. Every page
 * loaded is refetched on each change and saved for the next start, so pages nobody shows any
 * more would make each of those load the whole history again.
 */
async function forgetOlderTasks(queryClient: QueryClient): Promise<void> {
  const data = queryClient.getQueryData<InfiniteData<TasksPage, TaskId | null>>(queryKeys.tasks);
  if (data === undefined || data.pages.length <= 1) return;
  // A page still loading would land after the first page as if it followed it.
  await queryClient.cancelQueries({ queryKey: queryKeys.tasks, exact: true });
  queryClient.setQueryData<InfiniteData<TasksPage, TaskId | null>>(queryKeys.tasks, (current) =>
    current === undefined
      ? current
      : { pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1) },
  );
}

/**
 * Keeps the older finished tasks loaded only while `shown`: once they are hidden again, or the
 * caller unmounts, the task list goes back to its first page.
 */
export function useOlderTasksWhileShown(shown: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!shown) {
      void forgetOlderTasks(queryClient);
      return;
    }
    return () => void forgetOlderTasks(queryClient);
  }, [shown, queryClient]);
}

/**
 * Tasks of every workspace, as loaded so far: open ones and the newest finished ones first,
 * older finished ones on `fetchNextPage`, while the user scrolls toward them (see
 * `useOlderTasksWhileShown`). A status change may release dependents in other
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

/** Applies the task, workspace, and guideline changes the server reports while the app is mounted. */
export function useServerEvents() {
  const queryClient = useQueryClient();
  const { alerts } = useMessages();
  useEffect(() => {
    const subscriptions = [
      events.tasksChanged.listen(async () => {
        const previous = cachedTasks(queryClient);
        await invalidateTasks(queryClient);
        // The app being in focus means the user already sees the change on the task.
        if (previous === undefined || document.hasFocus()) {
          return;
        }
        const next = cachedTasks(queryClient) ?? [];
        notify(taskStatusAlerts(previous, next, alerts)).catch((error: unknown) =>
          console.error("toodo: failed to show status notifications", error),
        );
      }),
      events.workspacesChanged.listen(() =>
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces, exact: true }),
      ),
      events.guidelinesChanged.listen((event) =>
        queryClient.invalidateQueries({ queryKey: queryKeys.guidelines(event.payload.workspaceId) }),
      ),
      events.chatChanged.listen(() => queryClient.invalidateQueries({ queryKey: queryKeys.chat })),
    ];
    return () => {
      for (const subscription of subscriptions) {
        void subscription.then((unlisten) => unlisten());
      }
    };
  }, [queryClient, alerts]);
}

export function useStartTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: TaskId) => unwrap(commands.startTask(id, null, null)),
    onSuccess: () => invalidateTasks(queryClient),
  });
}

/**
 * Completes an `in_progress` or `in_review` task once its manual criteria are checked; the
 * backend checks its URL criteria first.
 */
export function useCompleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: TaskId) => unwrap(commands.completeTask(id, null, null)),
    onSuccess: () => invalidateTasks(queryClient),
  });
}

/**
 * Concludes a task without completing its own criteria: `not_adopted` (e.g. research that is not
 * adopted) with `note` as its conclusion, or `shipped_with` the completed task `shippedWith`.
 */
export function useConcludeTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      note,
      shippedWith = null,
    }: {
      id: TaskId;
      note: string;
      shippedWith?: TaskId | null;
    }) => unwrap(commands.concludeTask(id, note, shippedWith === null ? "not_adopted" : "shipped_with", shippedWith)),
    onSuccess: () => invalidateTasks(queryClient),
  });
}

/** Saves the completion note of a done task; an empty note clears it. */
export function useSetCompletionNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: TaskId; note: string }) => unwrap(commands.setCompletionNote(id, note)),
    onSuccess: () => invalidateTasks(queryClient),
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
    onSuccess: () => invalidateTasks(queryClient),
  });
}

/** Corrects how a done task ended; `note` becomes its completion note and the change is kept as a progress note. */
export function useSetTaskOutcome() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolution, note }: { id: TaskId; resolution: TaskResolution; note: string }) =>
      unwrap(commands.setTaskOutcome(id, resolution, note)),
    onSuccess: () => invalidateTasks(queryClient),
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (task: TaskEdit) => unwrap(commands.updateTask(task)),
    onSuccess: () => invalidateTasks(queryClient),
  });
}

/** Moves a task into another workspace; reviews group tasks by workspace, so they refetch too. */
export function useMoveTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, workspaceId }: { id: TaskId; workspaceId: WorkspaceId }) =>
      unwrap(commands.moveTask(id, workspaceId)),
    onSuccess: () => invalidateTasks(queryClient),
  });
}

/** Commands that change tasks that other tasks, possibly in other workspaces, may wait on. */
function useTasksMutation<T>(mutationFn: (variables: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => invalidateTasks(queryClient),
  });
}

/** Pauses a started task: it becomes planned again. */
export function usePauseTask() {
  return useTasksMutation((id: TaskId) => unwrap(commands.pauseTask(id)));
}

/**
 * Makes a task wait until `until`: it is paused until then and returns to its status on its own.
 * A waiting task gets the new time.
 */
export function useWaitTask() {
  return useTasksMutation(({ id, until, reason }: { id: TaskId; until: Timestamp; reason: string | null }) =>
    unwrap(commands.waitTask(id, until, reason)),
  );
}

/** Ends the wait of a task now: it returns to the status it had when the wait began. */
export function useEndWait() {
  return useTasksMutation((id: TaskId) => unwrap(commands.endWait(id)));
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

/** Archives a task while keeping its history. */
export function useDeleteTask() {
  return useArchiveMutation((id: TaskId) => unwrap(commands.deleteTask(id)));
}

/** Archives every done task of a workspace while keeping their history. */
export function useDeleteDoneTasks() {
  return useArchiveMutation((workspaceId: WorkspaceId) => unwrap(commands.deleteDoneTasks(workspaceId)));
}

/**
 * How many done tasks a workspace has: what `useDeleteDoneTasks` archives. The server counts
 * them, since the loaded pages may hold only the newest. Nothing loads until `enabled`.
 */
export function useDoneTaskCount(workspaceId: WorkspaceId, enabled: boolean) {
  return useQuery({
    // Under the pages' key, so whatever refreshes the pages counts again.
    queryKey: [...queryKeys.tasks, "done-count", workspaceId],
    queryFn: async () => (await listTasks({ workspaceId, statuses: ["done"] })).length,
    enabled,
  });
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

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (task: NewTask) => unwrap(commands.createTask(task)),
    onSuccess: () => invalidateTasks(queryClient),
  });
}
