// Starts a Toodo server on a data directory of its own and talks to it the way its clients
// do: commands over `/api/rpc`, MCP over `/mcp`, and events over `/api/events`.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

/** A server to run: the program and its arguments, and more environment for it. */
export type ServerSpec = {
  label: string;
  command: string[];
  env?: Record<string, string>;
};

/** What a call answered: the HTTP status and the JSON body (or the text when it is not JSON). */
export type Reply = { status: number; body: unknown };

/** One server-sent event as it arrived. */
export type SseEvent = { id: string | null; event: string; data: string };

export type RunningServer = {
  spec: ServerSpec;
  url: string;
  dataDir: string;
  rpc: (command: string, args?: Record<string, unknown>) => Promise<Reply>;
  /** Sends one MCP JSON-RPC request; the reply is the JSON-RPC response. */
  mcp: (method: string, params?: Record<string, unknown>) => Promise<Reply>;
  /** Sends a request to any path with the web token, e.g. a chat attachment upload. */
  http: (method: string, path: string, body?: string, headers?: Record<string, string>) => Promise<Reply>;
  /** Opens `/api/events` and records every event from now on. */
  openEvents: () => Promise<EventRecorder>;
  output: () => string;
  stop: () => Promise<void>;
};

/** Ports of the real servers; a scratch server never binds them. */
const reservedPorts = new Set([47615, 47616, 47617]);

export async function freePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (address === null || typeof address === "string") throw new Error("no port");
        probe.close(() => resolve(address.port));
      });
    });
    if (!reservedPorts.has(port)) return port;
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/rpc/list_workspaces`, { method: "POST" })).status === 401;
  } catch {
    return false;
  }
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

async function readReply(response: Response): Promise<Reply> {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

/** An MCP reply is JSON, or a server-sent event stream whose `data:` line carries the JSON. */
function mcpBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line !== "");
  return data.length === 1 ? JSON.parse(data[0]) : data.map((line) => JSON.parse(line));
}

/**
 * Starts `spec` on `dataDir` (which must hold the database to serve, or nothing for a new
 * one) on a free loopback port and waits until it answers.
 */
export async function startServer(spec: ServerSpec, dataDir: string, env: Record<string, string> = {}): Promise<RunningServer> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const [program, ...args] = spec.command;
  const child = spawn(program, args, {
    env: { ...process.env, ...env, ...spec.env, TOODO_LISTEN: `127.0.0.1:${port}`, TOODO_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (chunk) => (log += chunk));
  child.stderr?.on("data", (chunk) => (log += chunk));
  const spawnFailed = new Promise<never>((_, reject) => child.once("error", reject));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (await Promise.race([answers(url), spawnFailed])) break;
    if (child.exitCode !== null) throw new Error(`${spec.label} exited with ${child.exitCode} while starting:\n${log}`);
    if (Date.now() > deadline) {
      await stopProcess(child);
      throw new Error(`${spec.label} did not answer within 60 s:\n${log}`);
    }
    // Waiting for a process to start listening: there is no event to subscribe to, so poll its port.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const token = (file: string) => readFileSync(`${dataDir}/${file}`, "utf8").trim();
  const webToken = token("web-token");
  const mcpToken = token("mcp-token");
  const recorders: EventRecorder[] = [];
  let mcpId = 0;

  return {
    spec,
    url,
    dataDir,
    async rpc(command, args = {}) {
      const response = await fetch(`${url}/api/rpc/${command}`, {
        method: "POST",
        headers: { authorization: `Bearer ${webToken}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      return readReply(response);
    },
    async mcp(method, params) {
      mcpId += 1;
      const request: Record<string, unknown> = { jsonrpc: "2.0", id: mcpId, method };
      if (params !== undefined) request.params = params;
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${mcpToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(request),
      });
      return { status: response.status, body: mcpBody(await response.text()) };
    },
    async http(method, path, body, headers = {}) {
      const bearer = path.startsWith("/mcp") ? mcpToken : webToken;
      const response = await fetch(`${url}${path}`, { method, body, headers: { authorization: `Bearer ${bearer}`, ...headers } });
      return readReply(response);
    },
    async openEvents() {
      const recorder = await EventRecorder.open(`${url}/api/events`, webToken);
      recorders.push(recorder);
      return recorder;
    },
    output: () => log,
    async stop() {
      for (const recorder of recorders) recorder.close();
      await stopProcess(child);
    },
  };
}

/** Records the events of one `/api/events` stream and lets a caller wait for one. */
export class EventRecorder {
  readonly events: SseEvent[] = [];
  private readonly waiters: Array<{ match: (event: SseEvent) => boolean; resolve: () => void }> = [];
  private readonly abort = new AbortController();

  private constructor() {}

  static async open(url: string, token: string): Promise<EventRecorder> {
    const recorder = new EventRecorder();
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: recorder.abort.signal,
    });
    if (!response.ok || response.body === null) throw new Error(`GET ${url} answered ${response.status}`);
    const ready = recorder.waitFor((event) => event.event === "ready", 10_000);
    void recorder.pump(response.body);
    await ready;
    return recorder;
  }

  private async pump(body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          this.accept(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    } catch (error) {
      if (!this.abort.signal.aborted) throw error;
    }
  }

  private accept(block: string) {
    const event: SseEvent = { id: null, event: "message", data: "" };
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "id") event.id = value;
      else if (field === "event") event.event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0 && event.id === null && event.event === "message") return;
    event.data = data.join("\n");
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (waiter.match(event)) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  }

  /** Resolves once an event matching `match` arrives (or has arrived), or rejects after `timeoutMs`. */
  waitFor(match: (event: SseEvent) => boolean, timeoutMs: number): Promise<void> {
    if (this.events.some(match)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`no matching event within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter = {
        match,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    this.abort.abort();
  }
}
