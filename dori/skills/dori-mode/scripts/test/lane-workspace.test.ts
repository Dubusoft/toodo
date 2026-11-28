import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { laneWorkspace, LaneWorkspaceRefused, linkLaneTask } from "../src/lane-toodo.ts";
import type { Lane } from "../src/registry.ts";

type Workspace = { id: number; name: string; repository: string | null; archivedAt: string | null };

/** A fake toodo MCP endpoint answering `list_workspaces` with `workspaces` and recording every tool called. */
const fakeToodo = (workspaces: Workspace[]) => {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const rpc = await req.json() as { id: unknown; params: { name: string } };
      calls.push(rpc.params.name);
      const value = rpc.params.name === "list_workspaces" ? workspaces : { id: 99 };
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
    },
  });
  return { calls, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
};

let dir: string;
let tokenFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lane-workspace-"));
  tokenFile = join(dir, "mcp-token");
  writeFileSync(tokenFile, "tok\n");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const workspaces: Workspace[] = [
  { id: 1, name: "toodo", repository: null, archivedAt: null },
  { id: 2, name: "old", repository: "dubusoft/site", archivedAt: "2026-01-01T00:00:00Z" },
  { id: 3, name: "site", repository: "https://github.com/dubusoft/site", archivedAt: null },
];

const depsFor = (url: string) => ({
  config: {},
  tunables: { toodoWriter: { url, tokenFile } },
  registry: { patch: async () => { throw new Error("no task may be recorded"); } },
}) as unknown as Pick<FlowDeps, "config" | "tunables" | "registry">;

test("a lane without a task gets the workspace whose repository names a Done repo, or the --workspace it names", async () => {
  const toodo = fakeToodo(workspaces);
  try {
    const deps = depsFor(toodo.url);
    expect(await laneWorkspace(deps, "pr dubusoft/site autopilot/1")).toBe(3);
    expect(await laneWorkspace(deps, "file report.md", 1)).toBe(1);
  } finally { toodo.stop(); }
});

test("no repo match and no --workspace refuses instead of taking the first workspace; an archived or unknown --workspace is refused", async () => {
  const toodo = fakeToodo(workspaces);
  try {
    const deps = depsFor(toodo.url);
    await expect(laneWorkspace(deps, "file report.md")).rejects.toThrow(LaneWorkspaceRefused);
    await expect(laneWorkspace(deps, "pr dubusoft/other autopilot/1")).rejects.toThrow("no unarchived Toodo workspace's repository names a repo of the Done line (dubusoft/other)");
    await expect(laneWorkspace(deps, "file report.md", 2)).rejects.toThrow("--workspace 2 is not an unarchived Toodo workspace (open: 1, 3)");
  } finally { toodo.stop(); }
});

test("linkLaneTask creates no task when no workspace matches and says why", async () => {
  const toodo = fakeToodo(workspaces);
  try {
    const lane = { key: "research-1", title: "Research", done: "file report.md" } as Lane;
    const line = await linkLaneTask(depsFor(toodo.url), lane);
    expect(line).toStartWith("LANE_TASK_LINK_FAILED research-1: ");
    expect(line).toContain("launch with --task ID or --workspace ID");
    expect(toodo.calls).toEqual(["list_workspaces"]);
  } finally { toodo.stop(); }
});
