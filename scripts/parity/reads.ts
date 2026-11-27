// The read scenario: calls that change nothing, built from what a database holds (every
// workspace, task, channel, thread, and saved review), for shadow runs on copies of the live
// database and for checking that a Rust binary still reads a database.

import { data, type Step } from "./steps.ts";
import type { RunningServer } from "./server.ts";

const ids = (value: unknown): number[] =>
  Array.isArray(value) ? value.map((item) => (item as { id?: unknown }).id).filter((id): id is number => typeof id === "number") : [];

const step = (name: string, call: Step["call"]): Step => ({ name, call });

/** Asks `reference` what its database holds and returns the reads to run on it. */
export async function readSteps(reference: RunningServer): Promise<Step[]> {
  const year = new Date().getUTCFullYear();
  const workspaces = ids(data(await reference.rpc("list_workspaces")));
  const tasks = ids(data(await reference.rpc("list_tasks", { filter: null })));
  const channels = ids(data(await reference.rpc("list_chat_channels")));
  const threads = [
    ...ids(data(await reference.rpc("list_chat_threads", { filter: {} }))),
    ...ids(data(await reference.rpc("list_chat_threads", { filter: { archived: true } }))),
  ];
  const snapshots = ids(data(await reference.rpc("list_review_snapshots")));

  const steps: Step[] = [
    step("initialize", () => ({ mcp: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "parity", version: "1" } } })),
    step("tools/list", () => ({ mcp: "tools/list" })),
    step("resources/list", () => ({ mcp: "resources/list" })),
    step("app_info", () => ({ rpc: "app_info" })),
    step("mcp_server_info", () => ({ rpc: "mcp_server_info" })),
    step("list_connected_apps", () => ({ rpc: "list_connected_apps" })),
    step("get_review_time_zone", () => ({ rpc: "get_review_time_zone" })),
    step("get_backup_settings", () => ({ rpc: "get_backup_settings" })),
    step("list_workspaces", () => ({ rpc: "list_workspaces" })),
    step("list_archive", () => ({ rpc: "list_archive" })),
    step("list_task_relations", () => ({ rpc: "list_task_relations" })),
    step("list_tasks", () => ({ rpc: "list_tasks", args: { filter: null } })),
    step("list_chat_channels", () => ({ rpc: "list_chat_channels" })),
    step("list_review_snapshots", () => ({ rpc: "list_review_snapshots" })),
    step("mcp:list_workspaces", () => ({ tool: "list_workspaces" })),
    step("mcp:list_tasks", () => ({ tool: "list_tasks" })),
    step("mcp:list_tasks#ready", () => ({ tool: "list_tasks", args: { ready: true } })),
    step("mcp:list_channels", () => ({ tool: "list_channels" })),
    step("mcp:list_threads", () => ({ tool: "list_threads", args: { include_archived: true } })),
    step("mcp:peek_pending", () => ({ tool: "peek_pending" })),
    step("mcp:read_toodo_skill", () => ({ tool: "read_toodo_skill" })),
  ];
  for (const y of [year - 1, year]) {
    steps.push(
      step(`review_period#${y}`, () => ({ rpc: "review_period", args: { from: `${y}-01-01`, to: `${y}-12-31` } })),
      step(`review_report#${y}`, () => ({ rpc: "review_report", args: { request: { period: "year", date: `${y}-06-01`, format: "markdown" } } })),
      step(`review_report#${y}-csv`, () => ({ rpc: "review_report", args: { request: { period: "year", date: `${y}-06-01`, format: "csv" } } })),
      step(`mcp:review_report#${y}`, () => ({ tool: "review_report", args: { period: "year", date: `${y}-06-01`, format: "markdown" } })),
    );
  }
  for (const id of workspaces) {
    steps.push(
      step(`get_workspace#${id}`, () => ({ rpc: "get_workspace", args: { id } })),
      step(`list_guidelines#${id}`, () => ({ rpc: "list_guidelines", args: { workspaceId: id } })),
      step(`list_tasks#workspace-${id}`, () => ({ rpc: "list_tasks", args: { filter: { workspaceId: id } } })),
      step(`mcp:get_guidelines#${id}`, () => ({ tool: "get_guidelines", args: { workspace_id: id } })),
      step(`mcp:list_tasks#workspace-${id}`, () => ({ tool: "list_tasks", args: { workspace_id: id } })),
    );
  }
  for (const id of tasks) {
    steps.push(
      step(`get_task#${id}`, () => ({ rpc: "get_task", args: { id } })),
      step(`mcp:get_task#${id}`, () => ({ tool: "get_task", args: { id } })),
    );
  }
  for (const id of channels) {
    steps.push(
      step(`list_chat#channel-${id}`, () => ({ rpc: "list_chat", args: { place: { channel: id }, before: null } })),
      step(`list_chat_threads#channel-${id}`, () => ({ rpc: "list_chat_threads", args: { filter: { channelId: id, archived: true } } })),
      step(`mcp:list_chat#channel-${id}`, () => ({ tool: "list_chat", args: { channel_id: id } })),
    );
  }
  for (const id of threads) {
    steps.push(
      step(`list_chat#thread-${id}`, () => ({ rpc: "list_chat", args: { place: { thread: id }, before: null } })),
      step(`mcp:list_chat#thread-${id}`, () => ({ tool: "list_chat", args: { thread_id: id } })),
    );
  }
  for (const id of snapshots) {
    steps.push(step(`get_review_snapshot#${id}`, () => ({ rpc: "get_review_snapshot", args: { id } })));
  }
  return steps;
}
