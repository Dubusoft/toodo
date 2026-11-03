import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..");

/** Ports of the real servers; a scratch server must never bind them. */
const reservedPorts = new Set([47615, 47616, 47617]);

export type ScratchServer = {
  url: string;
  /** The shared web token the sign-in form asks for. */
  webToken: string;
  /** Calls a command over the HTTP API, like the web app does. */
  rpc: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  /** Calls an MCP tool, like a coding agent does. */
  mcp: <T>(tool: string, args?: Record<string, unknown>) => Promise<T>;
  stop: () => Promise<void>;
};

export type ServerOptions = {
  /** More environment for the server, such as `TOODO_PUSH_SUBJECT`. */
  env?: Record<string, string>;
};

/** Workspaces the scratch database starts with; `herdr` is needed to create more. */
export const workspaces = ["alpha", "beta"];

async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    if (!reservedPorts.has(port)) return port;
  }
}

function binary(): string {
  return process.env.TOODO_SERVER_BIN ?? path.join(root, "src-tauri", "target", "debug", "toodo-server");
}

function webDir(): string {
  return process.env.TOODO_E2E_WEB_DIR ?? path.join(root, "dist-web");
}

async function until(label: string, ready: () => Promise<boolean>, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 30_000;
  while (!(await ready())) {
    if (child.exitCode !== null) throw new Error(`toodo-server exited while ${label}:\n${output()}`);
    if (Date.now() > deadline) throw new Error(`toodo-server did not become ready (${label}):\n${output()}`);
    // Waiting for a process to start listening: poll its port, there is no event to subscribe to.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function launch(dataDir: string, port: number, env: Record<string, string> = {}) {
  const child = spawn(binary(), [], {
    env: {
      ...process.env,
      TOODO_LISTEN: `127.0.0.1:${port}`,
      TOODO_DATA_DIR: dataDir,
      TOODO_WEB_DIR: webDir(),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  return { child, output: () => log };
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

async function answers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/rpc/list_workspaces`, { method: "POST" })).status === 401;
  } catch {
    return false;
  }
}

/**
 * Starts `toodo-server` on a free loopback port with a data directory of its own, so a run
 * never touches the data of a real server. The first start creates the database, which is
 * then seeded with workspaces (creating one through the API needs herdr) before the real start.
 */
export async function startServer(options: ServerOptions = {}): Promise<ScratchServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "toodo-e2e-"));
  const port = await freePort();

  const first = launch(dataDir, port);
  await until("creating the database", () => answers(port), first.child, first.output);
  await stopProcess(first.child);

  const db = new DatabaseSync(path.join(dataDir, "toodo.sqlite3"));
  for (const name of workspaces) {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", path.join(dataDir, "repos", name)]);
    db.prepare("INSERT INTO workspaces (name, kind, path, default_base_branch) VALUES (?, 'local', ?, 'main')").run(
      name,
      path.join(dataDir, "repos", name),
    );
  }
  db.close();

  const running = launch(dataDir, port, options.env);
  await until("starting", () => answers(port), running.child, running.output);

  const url = `http://127.0.0.1:${port}`;
  const token = (file: string) => readFileSync(path.join(dataDir, file), "utf8").trim();
  const webToken = token("web-token");
  const mcpToken = token("mcp-token");

  async function post<T>(target: string, bearer: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${url}${target}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${target} answered ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }

  return {
    url,
    webToken,
    rpc<T>(command: string, args: Record<string, unknown> = {}) {
      return post<T>(`/api/rpc/${command}`, webToken, args);
    },
    async mcp<T>(tool: string, args: Record<string, unknown> = {}) {
      const text = await (
        await fetch(`${url}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${mcpToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
        })
      ).text();
      // The reply is JSON, or one server-sent event carrying the JSON.
      const json = JSON.parse(text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))!.slice(5));
      const result = json.result;
      if (json.error || result?.isError) throw new Error(`${tool} failed: ${text}`);
      return (result.structuredContent ?? JSON.parse(result.content[0].text)) as T;
    },
    async stop() {
      await stopProcess(running.child);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export function createTask(server: ScratchServer, task: { workspaceId: number; title: string; taskType?: string }) {
  return server.rpc<{ id: number; title: string }>("create_task", {
    task: { taskType: "feat", description: "", estimate: null, dueDate: null, criteria: [], mergeCriterion: false, ...task },
  });
}
