// The tools of the MCP server: each reads its arguments, runs on the storage the Rust tool
// runs on (reads on the read-only connection, changes on the writer), and announces the
// change to connected clients when it succeeds. What the tools do is in the modules beside
// this one, over the same storage and commands as the web app, so agents follow the rules
// the app follows.

import type { Notifier } from "../../commands/events.ts";
import { workspaceId } from "../../domain/model.ts";
import type { Storage } from "../../storage/storage.ts";
import type { Decoder } from "../args.ts";
import { SKILL } from "../instructions.ts";
import * as chat from "./chat.ts";
import * as create from "./create.ts";
import * as edits from "./edits.ts";
import * as lifecycle from "./lifecycle.ts";
import * as queries from "./queries.ts";
import * as R from "./requests.ts";
import * as workspaces from "./workspaces.ts";

/** What the tools run on. */
export interface ToolContext {
  /** The writer connection. */
  storage: Storage;
  /** The read-only connection. */
  reader: Storage;
  notifier: Notifier;
}

/** A reply that is text as it is, rather than a value written as JSON. */
export class Text {
  constructor(readonly text: string) {}
}

/** A tool: it reads its arguments and returns what it replies, or throws. */
export type Tool = (context: ToolContext, args: Record<string, unknown>) => unknown;

/** A tool that reads its arguments with `decode`; one without arguments ignores them. */
function tool<A>(decode: Decoder<A>, run: (context: ToolContext, args: A) => unknown): Tool {
  return (context, args) => run(context, decode(args));
}

function plain(run: (context: ToolContext) => unknown): Tool {
  return (context) => run(context);
}

/** Announces that the tasks of `task`'s workspace changed, and returns `value`. */
function changed<T>(context: ToolContext, task: { workspaceId: number }, value: T): T {
  context.notifier.tasksChanged(workspaceId(task.workspaceId));
  return value;
}

function guidelineChanged<T extends { workspaceId: number }>(context: ToolContext, guideline: T): T {
  context.notifier.guidelinesChanged(workspaceId(guideline.workspaceId));
  return guideline;
}

function chatChanged<T>(context: ToolContext, value: T): T {
  context.notifier.chatChanged();
  return value;
}

function workspacesChanged<T>(context: ToolContext, value: T): T {
  context.notifier.workspacesChanged();
  return value;
}

/** Every tool by name, the names of the Rust server's `tools/list`. */
export const TOOLS: Readonly<Record<string, Tool>> = {
  read_toodo_skill: plain(() => new Text(SKILL)),
  list_workspaces: plain(({ reader }) => workspaces.listWorkspaces(reader)),
  create_workspace: tool(R.createWorkspace, (context, args) =>
    workspacesChanged(context, workspaces.createWorkspace(context.storage, args))),
  update_workspace: tool(R.updateWorkspace, (context, args) =>
    workspacesChanged(context, workspaces.updateWorkspace(context.storage, args))),
  archive_workspace: tool(R.archiveWorkspace, (context, args) => {
    const change = workspaces.archiveWorkspace(context.storage, args);
    return change.confirmed ? workspacesChanged(context, change) : change;
  }),
  list_tasks: tool(R.listTasks, ({ reader }, args) => queries.listTasks(reader, args)),
  search_tasks: tool(R.searchTasks, ({ reader }, args) => queries.searchTasks(reader, args)),
  get_task: tool(R.getTask, ({ reader }, args) => queries.taskDetails(reader, args.id)),
  get_guidelines: tool(R.getGuidelines, ({ reader }, args) => workspaces.getGuidelines(reader, args)),
  add_guideline: tool(R.addGuideline, (context, args) =>
    guidelineChanged(context, workspaces.addGuideline(context.storage, args))),
  update_guideline: tool(R.updateGuideline, (context, args) =>
    guidelineChanged(context, workspaces.updateGuideline(context.storage, args))),
  remove_guideline: tool(R.removeGuideline, (context, args) =>
    guidelineChanged(context, workspaces.removeGuideline(context.storage, args))),
  add_related: tool(R.related, (context, args) => {
    const details = queries.addRelated(context.storage, args);
    return changed(context, details.task, details);
  }),
  remove_related: tool(R.related, (context, args) => {
    const details = queries.removeRelated(context.storage, args);
    return changed(context, details.task, details);
  }),
  current_task: tool(R.currentTask, ({ reader }, args) => queries.currentTask(reader, args)),
  create_task: tool(R.createTask, (context, args) => {
    const created = create.createTask(context.storage, args);
    return changed(context, created, created);
  }),
  create_plan: tool(R.createPlan, (context, args) => {
    const plan = create.createPlan(context.storage, args);
    const touched = [...new Set(plan.tasks.map((planned) => planned.workspaceId))].sort((a, b) => a - b);
    for (const workspace of touched) context.notifier.tasksChanged(workspaceId(workspace));
    return plan;
  }),
  check_criterion: tool(R.checkCriterion, (context, args) => {
    const task = edits.checkCriterion(context.storage, args);
    return changed(context, task, task);
  }),
  add_criterion: tool(R.addCriterion, (context, args) => {
    const task = edits.addCriterion(context.storage, args);
    return changed(context, task, task);
  }),
  remove_criterion: tool(R.removeCriterion, (context, args) => {
    const task = edits.removeCriterion(context.storage, args);
    return changed(context, task, task);
  }),
  update_task: tool(R.updateTask, (context, args) => {
    const task = edits.updateTask(context.storage, args);
    return changed(context, task, task);
  }),
  move_task: tool(R.moveTask, (context, args) => {
    const moved = edits.moveTask(context.storage, args);
    context.notifier.tasksChanged(workspaceId(moved.fromWorkspaceId));
    return changed(context, moved.task, moved);
  }),
  add_dependency: tool(R.addDependencies, (context, args) => {
    const reply = edits.addDependencies(context.storage, args);
    return changed(context, reply.task.task, reply);
  }),
  add_progress_note: tool(R.addProgressNote, (context, args) => {
    const task = edits.addNote(context.storage, args.kind === "decision" ? "decision" : "progress", args);
    return changed(context, task, task);
  }),
  report_blocker: tool(R.addNote, (context, args) => {
    const task = edits.addNote(context.storage, "blocker", args);
    return changed(context, task, task);
  }),
  pause_task: tool(R.pauseTask, (context, args) => {
    const task = lifecycle.pauseTask(context.storage, args);
    return changed(context, task, task);
  }),
  wait_task: tool(R.waitTask, (context, args) => {
    const task = lifecycle.waitTask(context.storage, args);
    return changed(context, task, task);
  }),
  end_wait: tool(R.endWait, (context, args) => {
    const task = lifecycle.endWait(context.storage, args);
    return changed(context, task, task);
  }),
  resume_task: tool(R.resumeTask, (context, args) => {
    const task = lifecycle.resumeTask(context.storage, args);
    return changed(context, task, task);
  }),
  delete_task: tool(R.deleteTask, (context, args) => {
    const change = lifecycle.deleteTask(context.storage, args);
    return change.confirmed ? changed(context, change.task, change) : change;
  }),
  delete_done_tasks: tool(R.deleteDoneTasks, (context, args) => {
    const change = lifecycle.deleteDoneTasks(context.storage, args);
    if (change.confirmed) context.notifier.tasksChanged(workspaceId(change.workspaceId));
    return change;
  }),
  reopen_task: tool(R.reopenTask, (context, args) => {
    const change = lifecycle.reopenTask(context.storage, args);
    return change.confirmed ? changed(context, change.task, change) : change;
  }),
  start_task: tool(R.startTask, (context, args) => {
    const started = lifecycle.startTask(context.storage, args);
    return changed(context, started, started);
  }),
  complete_task: tool(R.completeTask, async (context, args) => {
    const task = await lifecycle.completeTask(context.storage, args);
    return changed(context, task, task);
  }),
  conclude_task: tool(R.concludeTask, (context, args) => {
    const concluded = lifecycle.concludeTask(context.storage, args);
    return changed(context, concluded, concluded);
  }),
  remove_dependency: tool(R.dependency, (context, args) => {
    const reply = edits.removeDependency(context.storage, args);
    return changed(context, reply.task.task, reply);
  }),
  review_report: tool(R.reviewReport, ({ reader }, args) => queries.reviewReport(reader, args)),
  peek_pending: plain(({ storage }) => chat.pendingChat(storage, false)),
  take_pending: plain((context) => {
    const taken = chat.pendingChat(context.storage, true);
    return taken.length > 0 ? chatChanged(context, taken) : taken;
  }),
  reply_in_chat: tool(R.replyInChat, (context, args) => {
    const { message, notice } = chat.replyInChat(context.storage, args);
    context.notifier.agentPosted(message, notice);
    return message;
  }),
  ack_chat: tool(R.ackChat, (context, args) => chatChanged(context, chat.ackChat(context.storage, args))),
  mark_chat_handled: tool(R.markChatHandled, (context, args) =>
    chatChanged(context, chat.markChatHandled(context.storage, args))),
  list_chat: tool(R.listChat, ({ reader }, args) => chat.listChat(reader, args)),
  search_chat: tool(R.searchChat, ({ reader }, args) => chat.searchChat(reader, args)),
  set_typing: tool(R.setTyping, (context, args) => {
    context.notifier.agentTyping(args.typing);
    return { typing: args.typing };
  }),
  list_channels: plain(({ reader }) => chat.listChannels(reader)),
  create_channel: tool(R.createChannel, (context, args) =>
    chatChanged(context, chat.createChannel(context.storage, args))),
  list_threads: tool(R.listThreads, ({ reader }, args) => chat.listThreads(reader, args)),
  create_thread: tool(R.createThread, (context, args) =>
    chatChanged(context, chat.createThread(context.storage, args))),
  update_thread: tool(R.updateThread, (context, args) =>
    chatChanged(context, chat.updateThread(context.storage, args))),
};
