// `toodo-server` on Bun: serves Toodo on one port, the web app and its API, on the database
// of the Rust server. Port of `main` and `run` in `src-tauri/src/server/mod.rs`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Backups, importFile, startAutomaticBackups } from "./commands/backup.ts";
import { ChatState } from "./commands/chat.ts";
import { storageMessage } from "./commands/errors.ts";
import { AccessVerifier, httpKeySource } from "./http/access.ts";
import { type Config, configFromEnv, type Listen } from "./http/config.ts";
import { EventLog } from "./http/event-log.ts";
import { peerAddress } from "./http/auth.ts";
import { createHandler } from "./http/server.ts";
import { Services } from "./http/services.ts";
import { createPrivateDir, loadToken, MCP_TOKEN_FILE, newInstance, WEB_TOKEN_FILE } from "./http/tokens.ts";
import { programVersion } from "./http/version.ts";
import { Push, PushWorker } from "./push/push.ts";
import { openConnections, openWriter } from "./storage/database.ts";
import { Storage } from "./storage/storage.ts";

export const DATABASE_FILE = "toodo.sqlite3";

const WAIT_CHECK_PERIOD_MS = 5000;

/** How long open requests may finish once shutdown starts. Event streams never end on
 * their own, so without it one open browser tab would keep the server running. */
const SHUTDOWN_DEADLINE_MS = 5000;

/** How long a connection may stay idle, longer than the stall timeout of uploads so that a
 * stalled upload gets its `408` first. */
const IDLE_TIMEOUT_SECONDS = 40;

const USAGE = `Usage: toodo-server [--version]
       toodo-server import FILE

Serves Toodo on one port: the web app and its API.
--version prints the version, which is the version of the Toodo release it came from.
import adds the workspaces and tasks of the Toodo database FILE to the data in
TOODO_DATA_DIR, after a pre-restore backup; stop the running server first.

Environment:
  TOODO_LISTEN    address to listen on (default 127.0.0.1:47616)
  TOODO_DATA_DIR  database, backups, and access tokens
                  (default $XDG_DATA_HOME/toodo-server or ~/.local/share/toodo-server)
  TOODO_WEB_DIR   web build of the frontend (\`npm run build\` writes dist-web);
                  without it only the API is served
  TOODO_PUBLIC_URL
                  public HTTPS origin, e.g. https://toodo.example.com (unset by default)
  TOODO_PUSH_SUBJECT
                  contact for push services in notifications, a mailto: or https: URL
                  (default https://github.com/Dubusoft/toodo)
  TOODO_CF_ACCESS_TEAM_DOMAIN, TOODO_CF_ACCESS_AUD
                  Cloudflare Access team domain (e.g. myteam.cloudflareaccess.com)
                  and application AUD tag; with both set, /api accepts the
                  request's Access JWT instead of a token (unset by default)
  TOODO_CHAT_AGENT_NAME
                  name the chat shows for the agent connected over MCP
                  (default Dori)
  TOODO_CHAT_AGENT_AVATAR
                  avatar of that agent, an https: URL or a path on this
                  server such as /avatar.png (unset by default)
`;

function address(listen: Listen): string {
  return listen.hostname.includes(":") ? `[${listen.hostname}]:${listen.port}` : `${listen.hostname}:${listen.port}`;
}

/** The database of the data directory, which the Rust server created and migrated: this
 * server neither creates nor migrates one. */
function databasePath(config: Config): string {
  const path = join(config.dataDir, DATABASE_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `no database at ${path}; this server neither creates nor migrates one, so start the Rust toodo-server on ${config.dataDir} once first`,
    );
  }
  return path;
}

function runImport(config: Config, source: string): void {
  createPrivateDir(config.dataDir);
  const backups = Backups.load(config.dataDir);
  const db = openWriter(databasePath(config));
  try {
    const { safety, summary } = importFile(new Storage(db), backups, source);
    console.log(`Saved the data before the import as ${safety.path}`);
    console.log(`Imported ${summary.workspaces} workspaces and ${summary.tasks} tasks from ${source}.`);
    if (summary.taskIdOffset > 0) {
      console.log(`Task #N of the imported database is task #(N + ${summary.taskIdOffset}) here.`);
    }
  } finally {
    db.close();
  }
}

async function run(config: Config): Promise<void> {
  createPrivateDir(config.dataDir);
  const connections = openConnections(databasePath(config));
  const storage = new Storage(connections.writer);
  const reader = new Storage(connections.reader);
  const backups = Backups.load(config.dataDir);
  const mcpTokenPath = join(config.dataDir, MCP_TOKEN_FILE);
  const mcpToken = loadToken(mcpTokenPath);
  const webTokenPath = join(config.dataDir, WEB_TOKEN_FILE);
  const webToken = loadToken(webTokenPath);
  const push = await Push.load(config.dataDir, config.pushSubject);
  const pushWorker = new PushWorker(storage.db, push, () => storage.listAllTasks());
  const instance = newInstance();
  const services = new Services({
    storage,
    reader,
    publicUrl: config.publicUrl,
    backups,
    events: new EventLog(),
    mcp: { url: "", token: mcpToken, error: null, instance, lastRejection: null },
    push,
    pushWorker,
    chat: new ChatState(config.chatAgent),
    attachmentDir: join(config.dataDir, "attachments"),
  });
  const stopBackups = startAutomaticBackups(storage, backups);
  const endDueWaits = () => {
    try {
      for (const workspace of storage.endDueWaits()) services.tasksChanged(workspace);
    } catch (error) {
      console.error(`toodo: cannot end due task waits: ${storageMessage(error)}`);
    }
  };
  // Waits that ended while the server was stopped end on start.
  endDueWaits();
  const waitChecks = setInterval(endDueWaits, WAIT_CHECK_PERIOD_MS);

  let access: AccessVerifier | null = null;
  if (config.access !== null) {
    console.log(`toodo-server: /api accepts Cloudflare Access sign-ins from ${config.access.issuer}`);
    access = new AccessVerifier(config.access, httpKeySource());
  }
  const handle = createHandler({ services, webToken, mcpToken, access, webDir: config.webDir });
  const server = Bun.serve({
    hostname: config.listen.hostname,
    port: config.listen.port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    // Uploads are streamed to disk and checked against their own limits.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    fetch(request, server) {
      return handle(request, {
        peer: peerAddress(server.requestIP(request)?.address ?? null),
        keepOpen: () => server.timeout(request, 0),
      });
    },
  });
  services.mcp.url = `http://127.0.0.1:${server.port}/mcp`;
  console.log(
    `${programVersion()}: listening on http://${address(config.listen)} (data in ${config.dataDir}, web access token in ${webTokenPath}, MCP token for agents in ${mcpTokenPath}, instance ${instance})`,
  );
  console.log(
    config.webDir === null
      ? "toodo-server: TOODO_WEB_DIR is not set; serving the API only"
      : `toodo-server: serving the web app from ${config.webDir}`,
  );

  const stop = async () => {
    console.log("toodo-server: stopping");
    clearInterval(waitChecks);
    stopBackups();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      server.stop(false).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), SHUTDOWN_DEADLINE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) {
      console.error(`toodo-server: stopping with connections still open after ${SHUTDOWN_DEADLINE_MS / 1000}s`);
      await server.stop(true);
    }
    await pushWorker.idle();
    connections.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function main(args: string[]): Promise<void> {
  if (args.some((arg) => arg === "-h" || arg === "--help")) {
    console.log(USAGE);
    return;
  }
  if (args.some((arg) => arg === "-V" || arg === "--version")) {
    console.log(programVersion());
    return;
  }
  let source: string | null = null;
  if (args.length === 2 && args[0] === "import") source = args[1]!;
  else if (args.length > 0) {
    console.error(`toodo-server: unexpected arguments ${JSON.stringify(args)}\n\n${USAGE}`);
    process.exit(2);
  }
  let config: Config;
  try {
    config = configFromEnv((name) => process.env[name]);
  } catch (error) {
    console.error(`toodo-server: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exit(2);
  }
  try {
    if (source === null) await run(config);
    else runImport(config, source);
  } catch (error) {
    console.error(`toodo-server: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
