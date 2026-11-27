// A server for the HTTP tests: the routes of `server.ts` on a free loopback port, over a new
// database in a data directory of its own, signed in with the web token `web` and the MCP
// token `agent`, and push messages going to a `FakeTransport`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoriConfigStore } from "../../../src/lib/dori-config.ts";
import { Backups } from "../commands/backup.ts";
import { ChatState } from "../commands/chat.ts";
import type { ClientMetadataFetcher } from "../oauth/clients.ts";
import { FakeTransport, testPush } from "../push/testing.ts";
import { openConnections } from "../storage/database.ts";
import { Storage } from "../storage/storage.ts";
import { createDatabase } from "../storage/testing.ts";
import type { AccessVerifier } from "./access.ts";
import { peerAddress } from "./auth.ts";
import { EventLog } from "./event-log.ts";
import { createHandler } from "./server.ts";
import { Services } from "./services.ts";
import type { ScheduleBridge } from "./supervisor-schedules.ts";

export const WEB = "web";
export const AGENT = "agent";

export type TestServer = {
  readonly url: string;
  readonly dir: string;
  readonly services: Services;
  readonly transport: FakeTransport;
  /** Sends a request with `token` as the bearer token, if any. */
  fetch(method: string, path: string, init?: { token?: string; body?: RequestInit["body"]; headers?: Record<string, string> }): Promise<Response>;
  /** Sends a JSON body; the answer's body is its JSON, else its text. */
  send(method: string, path: string, token: string, body: unknown): Promise<{ status: number; body: any }>;
  close(): void;
};

export type TestServerOptions = {
  access?: AccessVerifier;
  webDir?: string;
  restoreLimit?: number;
  attachmentLimit?: number;
  /** Public mode's origin, which mounts the OAuth server. */
  publicUrl?: string;
  clientMetadata?: ClientMetadataFetcher;
  /** The supervisor's scheduled jobs, as the host hands them over. */
  schedules?: ScheduleBridge;
  doriConfig?: DoriConfigStore;
};

const noClientMetadata: ClientMetadataFetcher = async (url) => {
  throw new Error(`the test server fetches no client metadata, such as ${url}`);
};

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "toodo-http-"));
  const database = join(dir, "toodo.sqlite3");
  createDatabase(database);
  const connections = openConnections(database);
  const transport = new FakeTransport();
  const services = new Services({
    storage: new Storage(connections.writer),
    reader: new Storage(connections.reader),
    publicUrl: options.publicUrl ?? null,
    backups: Backups.load(dir),
    events: new EventLog("ab12"),
    mcp: { url: "http://127.0.0.1:0/mcp", token: null, error: null, instance: "0123456789ab", lastRejection: null },
    push: await testPush(transport),
    pushWorker: null,
    chat: new ChatState({ name: "Agent", avatarUrl: null }),
    attachmentDir: join(dir, "attachments"),
    restoreLimit: options.restoreLimit,
    attachmentLimit: options.attachmentLimit,
  });
  const handle = createHandler({
    services,
    webToken: WEB,
    mcpToken: AGENT,
    access: options.access ?? null,
    webDir: options.webDir ?? null,
    clientMetadata: options.clientMetadata ?? noClientMetadata,
    ...(options.schedules ? { schedules: options.schedules } : {}),
    ...(options.doriConfig ? { doriConfig: options.doriConfig } : {}),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) =>
      handle(request, {
        peer: peerAddress(server.requestIP(request)?.address ?? null),
        keepOpen: () => server.timeout(request, 0),
      }),
  });
  const url = `http://127.0.0.1:${server.port}`;
  const fetchFrom: TestServer["fetch"] = (method, path, init = {}) =>
    fetch(`${url}${path}`, {
      method,
      body: init.body,
      headers: { ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }), ...init.headers },
    });
  return {
    url,
    dir,
    services,
    transport,
    fetch: fetchFrom,
    async send(method, path, token, body) {
      const response = await fetchFrom(method, path, {
        token,
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed };
    },
    close() {
      server.stop(true);
      connections.close();
    },
  };
}
