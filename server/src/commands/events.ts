// Task, workspace, and chat changes announced to connected clients: the name each event is
// sent under, its payload from `src/lib/api.ts`, and what the server tells about them.

import type * as B from "../../../src/lib/api.ts";
import type { Events } from "../../../src/lib/api.ts";
import type { WorkspaceId } from "../domain/model.ts";
import type { ChatNotice } from "../storage/chat-channels.ts";

export type {
  ChatActionChosen,
  ChatChanged,
  ChatTyping,
  GuidelinesChanged,
  TaskReady,
  TaskStatusChanged,
  TasksChanged,
  WorkspacesChanged,
} from "../../../src/lib/api.ts";

/** The name each event of the bindings is sent under on `/api/events`. */
export const EVENT_NAMES = {
  tasksChanged: "tasks-changed",
  workspacesChanged: "workspaces-changed",
  guidelinesChanged: "guidelines-changed",
  taskStatusChanged: "task-status-changed",
  taskReady: "task-ready",
  chatChanged: "chat-changed",
  chatTyping: "chat-typing",
  chatActionChosen: "chat-action-chosen",
} as const satisfies Record<keyof Events, string>;

export interface Notifier {
  tasksChanged(workspace: WorkspaceId): void;
  workspacesChanged(): void;
  guidelinesChanged(workspace: WorkspaceId): void;
  /** A person's message or a receipt of the agent was stored. */
  chatChanged(): void;
  /** The agent posted `message`, which also ends its writing in that place. `notice` names
   * where it is for a notification; `null` when its channel's notifications are off. */
  agentPosted(message: B.ChatMessage, notice: ChatNotice | null): void;
  /** The agent started or stopped writing in `at`. */
  agentTyping(at: B.ChatPlace, typing: boolean): void;
  /** A person chose an action on the agent's message; the chat changed with it. */
  actionChosen(chosen: B.ChatActionChosen): void;
}
