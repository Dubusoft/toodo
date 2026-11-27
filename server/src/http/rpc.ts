// `POST /api/rpc/<command>`: runs one of the commands of the shared API (`src/lib/api.ts`),
// with their JSON arguments (camelCase keys) and JSON result.

import type * as B from "../../../src/lib/api.ts";
import type { Commands } from "../../../src/lib/api.ts";
import * as backup from "../commands/backup.ts";
import * as chat from "../commands/chat.ts";
import * as completion from "../commands/completion.ts";
import { CommandError, commandError, panicked } from "../commands/errors.ts";
import * as guidelines from "../commands/guidelines.ts";
import * as issues from "../commands/issues.ts";
import * as review from "../commands/review.ts";
import * as snapshots from "../commands/snapshots.ts";
import * as tasks from "../commands/tasks.ts";
import type { Args, Reply } from "../commands/types.ts";
import { checkUpdate } from "../commands/updates.ts";
import * as workspaces from "../commands/workspaces.ts";
import { workspaceId } from "../domain/model.ts";
import { formatScopes } from "../oauth/scopes.ts";
import { oauthListGrants, oauthRevokeGrant } from "../storage/oauth.ts";
import { failed, json } from "./auth.ts";
import type { Services } from "./services.ts";
import { VERSION } from "./version.ts";

type Name = keyof Commands;

/** What a parameter takes, as the Rust command's `Deserialize` reads it: `int` (an i64
 * newtype or number), `bool`, `string`, `ints` and `strings` (sequences), `object:<Type>` (a
 * struct the command validates), or `enum:<a>|<b>`; `?` after it makes it an `Option`. */
type Param = { readonly key: string; readonly kind: string; readonly detail: string; readonly optional: boolean };

type Entry = {
  readonly name: string;
  readonly params: readonly Param[];
  readonly run: (s: Services, args: unknown[]) => unknown;
};

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function param(spec: string): Param {
  const colon = spec.indexOf(":");
  const type = spec.slice(colon + 1);
  const optional = type.endsWith("?");
  const [kind = "", detail = ""] = (optional ? type.slice(0, -1) : type).split(":");
  return { key: spec.slice(0, colon), kind, detail, optional };
}

/** Declares the command `name` of the bindings: one parameter spec (`<key>:<kind>`) per
 * argument, in the order the bindings pass them, and how it runs. */
type Specs<T extends readonly unknown[]> = { readonly [K in keyof T]: string };

function def<N extends Name>(
  name: N,
  params: Specs<Args<N>>,
  run: (s: Services, ...args: Args<N>) => Reply<N> | Promise<Reply<N>>,
): Entry {
  return {
    name: snakeCase(name),
    params: (params as readonly string[]).map(param),
    run: (s, args) => run(s, ...(args as Args<N>)),
  };
}

/** The commands a read-only device may run: they only read. `mcp_server_info` is left out
 * because it shows the MCP token, which can change data. */
export const READ_COMMANDS: ReadonlySet<string> = new Set([
  "app_info",
  "check_update",
  "list_connected_apps",
  "list_workspaces",
  "get_workspace",
  "list_tasks",
  "list_task_relations",
  "get_task",
  "review_period",
  "list_archive",
  "list_guidelines",
  "review_report",
  "get_review_time_zone",
  "list_review_snapshots",
  "get_review_snapshot",
  "get_backup_settings",
  "list_backups",
  "list_chat",
  "list_chat_channels",
  "list_chat_threads",
  "search_chat",
]);

/** Whether `command` may change data. Commands that only read leave the notifications'
 * baseline alone: the app polls some of them, and moving the baseline on each poll would
 * swallow a change an agent just made. */
export function changesData(command: string): boolean {
  return !READ_COMMANDS.has(command) && command !== "mcp_server_info" && command !== "get_backup_status";
}

/** Announces a change of a guideline to connected clients, with its workspace. */
function guidelineChanged(s: Services, guideline: B.Guideline): B.Guideline {
  s.guidelinesChanged(workspaceId(guideline.workspaceId));
  return guideline;
}

/** Announces a change of the chat (a person's message, a channel, a thread, or what people
 * read) to connected clients and the agent. */
function chatChanged<T>(s: Services, result: T): T {
  s.chatChanged();
  return result;
}

export function appInfo(): B.AppInfo {
  return { name: "toodo", version: VERSION };
}

const ENTRIES: readonly Entry[] = [
  def("appInfo", [], () => appInfo()),
  def("checkUpdate", [], () => checkUpdate(VERSION)),
  def("listConnectedApps", [], (s) => ({
    publicMcpUrl: s.publicUrl === null ? null : `${s.publicUrl}/mcp`,
    apps: oauthListGrants(s.reader.db, s.reader.now()).map((grant) => ({
      grantId: grant.id,
      clientName: grant.clientName,
      clientId: grant.clientId,
      scopes: formatScopes(grant.scopes),
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
    })),
  })),
  def("revokeConnectedApp", ["grantId:int"], (s, grant) => {
    oauthRevokeGrant(s.storage.db, grant, s.storage.now());
    return null;
  }),

  def("listWorkspaces", [], (s) => workspaces.listWorkspaces(s.reader)),
  def("getWorkspace", ["id:int"], (s, id) => workspaces.getWorkspace(s.reader, id)),
  def("createWorkspace", ["workspace:object:NewWorkspace"], (s, w) => workspaces.createWorkspace(s.storage, w)),
  def("updateWorkspace", ["workspace:object:Workspace"], (s, w) => workspaces.updateWorkspace(s.storage, w)),
  def("deleteWorkspace", ["id:int"], (s, id) => workspaces.deleteWorkspace(s.storage, id)),
  def("restoreWorkspace", ["id:int"], (s, id) => workspaces.restoreWorkspace(s.storage, id)),
  def("purgeWorkspace", ["id:int"], (s, id) => workspaces.purgeWorkspace(s.storage, id)),
  def("listArchive", [], (s) => workspaces.listArchive(s.reader)),
  def("listGuidelines", ["workspaceId:int"], (s, id) => guidelines.listGuidelines(s.reader, id)),
  def("addGuideline", ["guideline:object:NewGuideline"], (s, g) =>
    guidelineChanged(s, guidelines.addGuideline(s.storage, g))),
  def("updateGuideline", ["guideline:object:GuidelineUpdate"], (s, g) =>
    guidelineChanged(s, guidelines.updateGuideline(s.storage, g))),
  def("deleteGuideline", ["id:int"], (s, id) => guidelineChanged(s, guidelines.deleteGuideline(s.storage, id))),
  def("listTasks", ["filter:object:TaskListFilter?"], (s, filter) => tasks.listTasks(s.reader, filter)),
  def("listTaskRelations", [], (s) => tasks.listTaskRelations(s.reader)),
  def("addTaskRelation", ["taskId:int", "relatedId:int"], (s, task, related) =>
    tasks.addTaskRelation(s.storage, task, related)),
  def("removeTaskRelation", ["taskId:int", "relatedId:int"], (s, task, related) =>
    tasks.removeTaskRelation(s.storage, task, related)),
  def("getTask", ["id:int"], (s, id) => tasks.getTask(s.reader, id)),
  def("createTask", ["task:object:NewTask"], (s, task) => tasks.createTask(s.storage, task)),
  def("checkCriterion", ["taskId:int", "criterionId:int", "met:bool", "evidence:string?"], (s, task, criterion, met, evidence) =>
    tasks.checkCriterion(s.storage, task, criterion, met, evidence)),
  def("updateTask", ["task:object:TaskEdit"], (s, edit) => tasks.updateTask(s.storage, edit)),
  def("moveTask", ["id:int", "workspaceId:int"], (s, id, workspace) => tasks.moveTask(s.storage, id, workspace)),
  def("pauseTask", ["id:int"], (s, id) => tasks.pauseTask(s.storage, id)),
  def("waitTask", ["id:int", "until:int", "reason:string?"], (s, id, until, reason) =>
    tasks.waitTask(s.storage, id, until, reason)),
  def("endWait", ["id:int"], (s, id) => tasks.endWait(s.storage, id)),
  def("setCompletionNote", ["id:int", "note:string"], (s, id, note) => tasks.setCompletionNote(s.storage, id, note)),
  def("reopenTask", ["id:int", "reason:string"], (s, id, reason) => tasks.reopenTask(s.storage, id, reason)),
  def("setTaskOutcome", ["id:int", "resolution:enum:merged|completed|not_adopted", "note:string"], (s, id, resolution, note) =>
    tasks.setTaskOutcome(s.storage, id, resolution, note)),
  def("deleteTask", ["id:int"], (s, id) => tasks.deleteTask(s.storage, id)),
  def("deleteDoneTasks", ["workspaceId:int"], (s, id) => tasks.deleteDoneTasks(s.storage, id)),
  def("restoreTask", ["id:int"], (s, id) => tasks.restoreTask(s.storage, id)),
  def("purgeTask", ["id:int"], (s, id) => tasks.purgeTask(s.storage, id)),
  def("addDependency", ["taskId:int", "dependsOn:int", "confirmPause:bool"], (s, task, dependsOn, confirm) =>
    tasks.addDependency(s.storage, task, dependsOn, confirm)),
  def("removeDependency", ["taskId:int", "dependsOn:int"], (s, task, dependsOn) =>
    tasks.removeDependency(s.storage, task, dependsOn)),
  def("startTask", ["id:int", "reason:string?", "refs:strings?"], (s, id, reason, refs) =>
    tasks.startTask(s.storage, id, reason, refs)),
  def("completeTask", ["id:int", "note:string?", "refs:strings?"], (s, id, note, refs) =>
    completion.completeTask(s.storage, id, note, refs)),
  def("concludeTask", ["id:int", "note:string", "outcome:enum:not_adopted|shipped_with?", "shippedWith:int?"], (s, id, note, outcome, shippedWith) =>
    completion.concludeTask(s.storage, id, note, outcome, shippedWith)),
  def("linkIssue", ["id:int", "reference:string"], (s, id, reference) => issues.linkIssue(s.storage, id, reference)),

  def("mcpServerInfo", [], (s) => s.mcp),
  def("reviewPeriod", ["from:string", "to:string"], (s, from, to) => review.reviewPeriod(s.reader, from, to)),
  def("reviewReport", ["request:object:ReviewReportRequest"], (s, request) => review.reviewReport(s.reader, request)),
  def("getReviewTimeZone", [], (s) => review.getReviewTimeZone(s.reader)),
  def("setReviewTimeZone", ["timeZone:string?"], (s, zone) => review.setReviewTimeZone(s.storage, zone)),
  def("saveReviewSnapshot", ["request:object:SaveReviewSnapshotRequest"], (s, request) =>
    snapshots.saveReviewSnapshot(s.storage, request)),
  def("listReviewSnapshots", [], (s) => snapshots.listReviewSnapshots(s.reader)),
  def("getReviewSnapshot", ["id:int"], (s, id) => snapshots.getReviewSnapshot(s.reader, id)),
  def("deleteReviewSnapshot", ["id:int"], (s, id) => snapshots.deleteReviewSnapshot(s.storage, id)),

  def("listChat", ["place:object:ChatPlace", "before:int?"], (s, place, before) => chat.listChat(s.reader, s.chat, place, before)),
  def("sendChatMessage", ["place:object:ChatPlace", "body:string", "clientId:string", "attachments:ints"], (s, place, body, client, files) =>
    chatChanged(s, chat.sendChatMessage(s.storage, place, body, client, files))),
  def("chooseChatAction", ["messageId:int", "key:string", "clientId:string"], (s, message, key, client) => {
    const choice = chat.chooseChatAction(s.storage, message, key, client);
    const chosen = chat.chosenEvent(choice);
    if (chosen !== null) s.actionChosen(chosen);
    return choice;
  }),
  def("searchChat", ["query:string", "place:object:ChatPlace?"], (s, query, place) => chat.searchChat(s.reader, query, place)),
  def("markChatRead", ["place:object:ChatPlace", "upTo:int"], (s, place, upTo) =>
    chatChanged(s, chat.markChatRead(s.storage, place, upTo))),
  def("listChatChannels", [], (s) => chat.listChatChannels(s.reader)),
  def("createChatChannel", ["name:string"], (s, name) => chatChanged(s, chat.createChatChannel(s.storage, name))),
  def("updateChatChannel", ["id:int", "edit:object:ChatChannelEdit"], (s, id, edit) =>
    chatChanged(s, chat.updateChatChannel(s.storage, id, edit))),
  def("deleteChatChannel", ["id:int"], (s, id) => chatChanged(s, chat.deleteChatChannel(s.storage, id))),
  def("listChatThreads", ["filter:object:ChatThreadFilter"], (s, filter) => chat.listChatThreads(s.reader, filter)),
  def("createChatThread", ["thread:object:NewChatThread"], (s, thread) =>
    chatChanged(s, chat.createChatThread(s.storage, thread))),
  def("updateChatThread", ["id:int", "edit:object:ChatThreadEdit"], (s, id, edit) =>
    chatChanged(s, chat.updateChatThread(s.storage, id, edit))),

  def("getBackupSettings", [], (s) => backup.getBackupSettings(s.backups)),
  def("getBackupStatus", [], (s) => backup.getBackupStatus(s.backups)),
  def("saveBackupSettings", ["settings:object:BackupSettings"], (s, settings) =>
    backup.saveBackupSettings(s.storage, s.backups, settings)),
  def("listBackups", [], (s) => backup.listBackups(s.backups)),
  def("restoreBackup", ["name:string"], (s, name) => backup.restoreBackup(s.storage, s.backups, name)),
];

/** Every command `/api/rpc` serves, by its name in the bindings. */
export const COMMANDS: ReadonlyMap<string, Entry> = new Map(ENTRIES.map((entry) => [entry.name, entry]));

/** The arguments do not match the command's parameters; the message is serde's. */
class BadArguments extends Error {}

/** A JSON value as serde names what it found. */
function unexpected(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  return Array.isArray(value) ? "sequence" : "map";
}

function invalidType(value: unknown, expected: string): BadArguments {
  return new BadArguments(`invalid type: ${unexpected(value)}, expected ${expected}`);
}

function checkInt(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw invalidType(value, "i64");
}

function checkString(value: unknown): void {
  if (typeof value !== "string") throw invalidType(value, "a string");
}

function checkValue(p: Param, value: unknown): void {
  switch (p.kind) {
    case "int":
      return checkInt(value);
    case "bool":
      if (typeof value !== "boolean") throw invalidType(value, "a boolean");
      return;
    case "string":
      return checkString(value);
    case "ints":
    case "strings":
      if (!Array.isArray(value)) throw invalidType(value, "a sequence");
      for (const item of value) (p.kind === "ints" ? checkInt : checkString)(item);
      return;
    case "object":
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw invalidType(value, p.detail === "ChatPlace" ? "enum ChatPlace" : `struct ${p.detail}`);
      }
      return;
    case "enum": {
      const variants = p.detail.split("|");
      if (typeof value !== "string") throw invalidType(value, `enum ${p.key}`);
      if (!variants.includes(value)) {
        const quoted = variants.map((variant) => `\`${variant}\``);
        const expected = quoted.length === 2 ? `${quoted[0]} or ${quoted[1]}` : `one of ${quoted.join(", ")}`;
        throw new BadArguments(`unknown variant \`${value}\`, expected ${expected}`);
      }
      return;
    }
    default:
      throw new Error(`unknown parameter kind ${p.kind}`);
  }
}

/** The arguments of `entry` from the JSON object `args`, in the order it takes them. Keys it
 * does not know are ignored; a missing `Option` is `null`. */
function parseArgs(entry: Entry, args: unknown): unknown[] {
  const object = args === null ? {} : args;
  if (typeof object !== "object" || Array.isArray(object)) throw invalidType(args, "struct Args");
  const given = object as Record<string, unknown>;
  return entry.params.map((p) => {
    const value = Object.hasOwn(given, p.key) ? given[p.key] : undefined;
    if (value === undefined || (value === null && p.optional)) {
      if (p.optional) return null;
      throw new BadArguments(`missing field \`${p.key}\``);
    }
    checkValue(p, value);
    return value;
  });
}

/** `400` for a request body that does not match what the route takes. */
export function badArguments(message: string): Response {
  return json(
    400,
    new CommandError(
      "invalidArguments",
      `invalid arguments: ${message}; reload the web app so that it matches the server's version`,
    ),
  );
}

/** Runs `command` with the JSON `args`, answering with its result or its error. */
export async function dispatch(s: Services, command: string, args: unknown): Promise<Response> {
  const entry = COMMANDS.get(command);
  if (entry === undefined) {
    return json(
      404,
      new CommandError(
        "unknownCommand",
        "unknown command; reload the web app so that it matches the server's version",
      ),
    );
  }
  let parsed: unknown[];
  try {
    parsed = parseArgs(entry, args);
  } catch (error) {
    if (error instanceof BadArguments) return badArguments(error.message);
    throw error;
  }
  try {
    return json(200, (await entry.run(s, parsed)) ?? null);
  } catch (error) {
    let reported: CommandError;
    try {
      reported = commandError(error);
    } catch {
      reported = panicked(error);
    }
    return failed(reported);
  }
}

/** `POST /api/rpc/<command>` with the request body `body`. A command that may change data
 * then announces the status changes it made, and moves the notifications' baseline: changes
 * the user makes in the app are not news to them. */
export async function handle(s: Services, command: string, body: string): Promise<Response> {
  let args: unknown = {};
  if (body !== "") {
    try {
      args = JSON.parse(body);
    } catch (error) {
      return badArguments(error instanceof Error ? error.message : String(error));
    }
  }
  const reply = await dispatch(s, command, args);
  if (changesData(command)) {
    s.announceStatusChanges();
    s.pushWorker?.tasksSeen();
  }
  return reply;
}
