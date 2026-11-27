// A step is one call a client makes. Each server runs the same steps; a step may build its
// arguments from what the same server answered earlier (`own`), such as the ID of a task it
// created, so a server that numbers differently still gets valid calls and its difference
// shows in the answers.

import type { Reply, RunningServer } from "./server.ts";

export type Call =
  | { rpc: string; args?: Record<string, unknown> }
  | { tool: string; args?: Record<string, unknown> }
  | { mcp: string; params?: Record<string, unknown> }
  | { http: { method: string; path: string; body?: string; headers?: Record<string, string> } };

export type Results = Map<string, Reply>;

export type Step = { name: string; call: (own: Results) => Call };

export function run(server: RunningServer, call: Call): Promise<Reply> {
  if ("rpc" in call) return server.rpc(call.rpc, call.args ?? {});
  if ("tool" in call) return server.mcp("tools/call", { name: call.tool, arguments: call.args ?? {} });
  if ("mcp" in call) return server.mcp(call.mcp, call.params);
  return server.http(call.http.method, call.http.path, call.http.body, call.http.headers);
}

/** The data of a reply: an RPC result, or what an MCP tool call returned. */
export function data(reply: Reply | undefined): unknown {
  if (reply === undefined) return undefined;
  const body = reply.body as { result?: { structuredContent?: unknown; content?: Array<{ text?: string }> } } | null;
  const result = body?.result;
  if (result === undefined) return reply.body;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.[0]?.text;
  if (text === undefined) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Follows `path` (keys and array indexes) into the data of the reply of step `name`. */
export function pick(own: Results, name: string, ...path: Array<string | number>): unknown {
  let value: unknown = data(own.get(name));
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

export function id(own: Results, name: string, ...path: Array<string | number>): number {
  const value = pick(own, name, ...path, "id");
  return typeof value === "number" ? value : -1;
}
