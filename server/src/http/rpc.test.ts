import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { changesData, COMMANDS, READ_COMMANDS } from "./rpc.ts";
import { startTestServer, type TestServer, WEB } from "./http-fixtures.ts";

/** Each command the bindings invoke, with the argument keys it passes in order. */
function boundCommands(): Map<string, string[]> {
  const source = readFileSync(new URL("../../../src/lib/api.ts", import.meta.url), "utf8");
  const bound = new Map<string, string[]>();
  for (const [, name, args] of source.matchAll(/invoke(?:<[^>]*>)?\("([a-z_]+)"(?:, \{ ([^}]*) \})?\)/g)) {
    bound.set(name!, args === undefined ? [] : args.split(",").map((key) => key.trim()));
  }
  return bound;
}

describe("commands", () => {
  test("every command of the bindings is served with the arguments they pass", () => {
    const bound = boundCommands();
    expect(bound.has("list_tasks") && bound.has("app_info")).toBe(true);
    const served = new Map([...COMMANDS].map(([name, entry]) => [name, entry.params.map((p) => p.key)]));
    expect(Object.fromEntries(served)).toEqual(Object.fromEntries(bound));
  });

  test("read commands are served and leave out the MCP token", () => {
    for (const command of READ_COMMANDS) expect(COMMANDS.has(command)).toBe(true);
    expect(READ_COMMANDS.has("mcp_server_info")).toBe(false);
    expect(changesData("list_tasks")).toBe(false);
    expect(changesData("mcp_server_info")).toBe(false);
    expect(changesData("get_backup_status")).toBe(false);
    expect(changesData("create_task")).toBe(true);
    expect(changesData("no_such_command")).toBe(true);
  });
});

describe("arguments", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer();
  });
  afterAll(() => server.close());

  const rpc = (command: string, args: unknown) => server.send("POST", `/api/rpc/${command}`, WEB, args);

  test("arguments use the camelCase keys of the bindings", async () => {
    const workspace = (await rpc("create_workspace", { workspace: { name: "toodo", description: null, repository: null } })).body;
    const task = (await rpc("create_task", {
      task: { workspaceId: workspace.id, taskType: "feat", title: "One", description: "", estimate: null, dueDate: null, criteria: [] },
    })).body;
    expect((await rpc("get_task", { id: task.id })).body.title).toBe("One");
    const refused = await rpc("add_dependency", { task_id: task.id, depends_on: task.id, confirm_pause: false });
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({
      kind: "invalidInput",
      code: "invalidArguments",
      message: "invalid arguments: missing field `taskId`; reload the web app so that it matches the server's version",
    });
  });

  test("arguments of the wrong type are refused as serde words it", async () => {
    const message = async (command: string, args: unknown) => (await rpc(command, args)).body.message as string;
    expect(await message("get_task", { id: "1" })).toContain('invalid type: string "1", expected i64');
    expect(await message("get_task", { id: 1.5 })).toContain("invalid type: floating point `1.5`, expected i64");
    expect(await message("add_dependency", { taskId: 1, dependsOn: 2, confirmPause: "no" })).toContain(
      'invalid type: string "no", expected a boolean',
    );
    expect(await message("set_task_outcome", { id: 1, resolution: "won", note: "x" })).toContain(
      "unknown variant `won`, expected one of `merged`, `completed`, `not_adopted`",
    );
    expect(await message("create_task", { task: [] })).toContain("invalid type: sequence, expected struct NewTask");
    expect(await message("get_task", [])).toContain("invalid type: sequence, expected struct Args");
  });

  test("missing options are null and a null body is no arguments", async () => {
    expect((await rpc("list_tasks", {})).status).toBe(200);
    expect((await rpc("list_workspaces", null)).status).toBe(200);
    const empty = await server.fetch("POST", "/api/rpc/list_workspaces", { token: WEB });
    expect(empty.status).toBe(200);
  });

  test("a failed command answers with the status of its kind", async () => {
    const missing = await rpc("get_task", { id: 999999 });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("taskNotFound");
    const unknown = await rpc("save_report", {});
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("unknownCommand");
  });
});
