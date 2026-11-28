// Everything the HTTP routes and the background work of the server share: the database
// connections, backups, the event log, Web Push, and the chat state, and the announcements
// of changes to connected clients.

import type * as B from "../../../src/lib/api.ts";
import type { Backups } from "../commands/backup.ts";
import type { ChatState } from "../commands/chat.ts";
import { EVENT_NAMES, type Notifier } from "../commands/events.ts";
import type { WorkspaceId } from "../domain/model.ts";
import { type LatestMessage, agentMessageAlert, awaitingAlert } from "../push/alerts.ts";
import type { Push, PushWorker } from "../push/push.ts";
import type { ChatNotice } from "../storage/chat-channels.ts";
import type { Storage } from "../storage/storage.ts";
import type { StatusCursor } from "../storage/task-events.ts";
import type { EventLog } from "./event-log.ts";

/** The largest database file `POST /api/backups/restore` accepts, in bytes. */
export const RESTORE_LIMIT = 256 * 1024 * 1024;

/** The largest file a chat attachment upload accepts, in bytes. */
export const ATTACHMENT_LIMIT = 25 * 1024 * 1024;

export type ServicesInit = {
  storage: Storage;
  /** A read-only connection to the same file for commands that only read, so they do not
   * wait for writes. */
  reader: Storage;
  /** The public HTTPS origin of public mode (`TOODO_PUBLIC_URL`), without a trailing slash. */
  publicUrl: string | null;
  backups: Backups;
  events: EventLog;
  /** How agents reach the server, as `mcp_server_info` reports it. */
  mcp: B.McpServerInfo;
  push: Push;
  /** Turns announced changes into notifications; `null` where nothing is sent. */
  pushWorker: PushWorker | null;
  chat: ChatState;
  attachmentDir: string;
  restoreLimit?: number;
  attachmentLimit?: number;
};

export class Services implements Notifier {
  readonly storage: Storage;
  readonly reader: Storage;
  readonly publicUrl: string | null;
  readonly backups: Backups;
  readonly events: EventLog;
  readonly mcp: B.McpServerInfo;
  readonly push: Push;
  readonly pushWorker: PushWorker | null;
  readonly chat: ChatState;
  readonly attachmentDir: string;
  readonly restoreLimit: number;
  readonly attachmentLimit: number;
  /** How far the status history records and adoptions are announced as
   * `task-status-changed` and `task-ready` events. */
  #announced: StatusCursor;
  /** Called on every announcement, such as the MCP listen streams that read their
   * resources again then. */
  readonly #listeners = new Set<() => void>();

  constructor(init: ServicesInit) {
    this.storage = init.storage;
    this.reader = init.reader;
    this.publicUrl = init.publicUrl;
    this.backups = init.backups;
    this.events = init.events;
    this.mcp = init.mcp;
    this.push = init.push;
    this.pushWorker = init.pushWorker;
    this.chat = init.chat;
    this.attachmentDir = init.attachmentDir;
    this.restoreLimit = init.restoreLimit ?? RESTORE_LIMIT;
    this.attachmentLimit = init.attachmentLimit ?? ATTACHMENT_LIMIT;
    this.#announced = this.reader.statusCursor();
  }

  emit(name: string, payload: unknown): void {
    this.events.send(name, JSON.stringify(payload));
    for (const listener of this.#listeners) listener();
  }

  /** Calls `listener` on every change announced to clients, until the returned function is
   * called. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Announces the status changes recorded since the last call, and the tasks they made
   * ready. Called after every change, so it covers each surface without each command
   * reporting its own transitions.
   */
  announceStatusChanges(): void {
    let found;
    try {
      found = this.reader.statusChangesAfter(this.#announced);
    } catch (error) {
      console.error(`toodo-server: cannot read task status changes: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const change of found.changes) {
      const event: B.TaskStatusChanged = {
        taskId: change.task,
        workspaceId: change.workspace,
        from: change.from,
        to: change.to,
        at: change.at,
      };
      this.emit(EVENT_NAMES.taskStatusChanged, event);
    }
    // The latest record, not the last change: a restored backup can have fewer records
    // than were announced.
    this.#announced = found.cursor;
    for (const task of found.ready) {
      const event: B.TaskReady = {
        taskId: task.task,
        workspaceId: task.workspace,
        unblockedBy: task.unblockedBy,
        at: task.at,
      };
      this.emit(EVENT_NAMES.taskReady, event);
    }
  }

  tasksChanged(workspace: WorkspaceId): void {
    this.emit(EVENT_NAMES.tasksChanged, { workspaceId: workspace } satisfies B.TasksChanged);
    this.announceStatusChanges();
    this.pushWorker?.tasksChanged();
  }

  workspacesChanged(): void {
    this.emit(EVENT_NAMES.workspacesChanged, null satisfies B.WorkspacesChanged);
  }

  guidelinesChanged(workspace: WorkspaceId): void {
    this.emit(EVENT_NAMES.guidelinesChanged, { workspaceId: workspace } satisfies B.GuidelinesChanged);
  }

  chatChanged(): void {
    this.emit(EVENT_NAMES.chatChanged, null satisfies B.ChatChanged);
  }

  /** Tells every open app the App language now set, so its screens switch without a reload. */
  appLanguageChanged(language: B.AppLanguage | null): void {
    this.emit(EVENT_NAMES.appLanguageChanged, language satisfies B.AppLanguageChanged);
  }

  agentPosted(message: B.ChatMessage, notice: ChatNotice | null): void {
    this.agentTyping(message.threadId !== null ? { thread: message.threadId } : { channel: message.channelId }, false);
    this.chatChanged();
    if (notice !== null) {
      const important = message.actions.length > 0 || notice.awaiting;
      this.pushWorker?.alert(agentMessageAlert(this.chat.agent.name, notice, message.id, message.body, important));
    }
  }

  agentAwaiting(notice: ChatNotice, latest: LatestMessage | null): void {
    this.pushWorker?.alert(awaitingAlert(this.chat.agent.name, notice, latest));
  }

  agentTyping(at: B.ChatPlace, typing: boolean): void {
    const until = this.chat.setTyping(at, typing, this.storage.now());
    this.emit(EVENT_NAMES.chatTyping, { place: at, until } satisfies B.ChatTyping);
  }

  actionChosen(chosen: B.ChatActionChosen): void {
    this.emit(EVENT_NAMES.chatActionChosen, chosen);
    this.chatChanged();
  }
}
