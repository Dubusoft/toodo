#!/usr/bin/env bun
// `toodo`: the owner's command on the host for the one-process host (toodo.service) and the core's database, on the
// TypeScript storage and commands. `bun link` in the checkout puts it on PATH beside `dori`, which stays the internal CLI
// of the lead, lanes, and runners; the commands a person runs that dori implements are handed to dori's CLI here.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parseEnvFile } from "../../dori/skills/dori-mode/scripts/src/credentials.ts";
import type * as B from "../../src/lib/api.ts";
import { CommandError } from "../../server/src/commands/errors.ts";
import { reviewReport } from "../../server/src/commands/review.ts";
import { type Config, configFromEnv } from "../../server/src/http/config.ts";
import { MCP_TOKEN_FILE, WEB_TOKEN_FILE } from "../../server/src/http/tokens.ts";
import { VERSION } from "../../server/src/http/version.ts";
import { DATABASE_FILE } from "../../server/src/main.ts";
import { openReader, schemaVersion } from "../../server/src/storage/database.ts";
import { Storage } from "../../server/src/storage/storage.ts";
import { healthcheckPaths, parsePingFile } from "./healthcheck.ts";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const UNIT = "toodo.service";
/** The units toodo.service replaces: the Rust server and the standalone Dori supervisor. */
export const LEGACY_UNITS = ["toodo-server.service", "dori-supervisor.service"] as const;

/** dori's CLI in this checkout: the commands toodo hands over run it, so they behave exactly as `dori <command>`. */
export const DORI_CLI = join(ROOT, "dori", "skills", "dori-mode", "scripts", "src", "cli.ts");

const USAGE = `Usage: toodo update [--dev | --main] [--force]
       toodo status [--json | --page N]
       toodo quota [--json]
       toodo doctor [--data-dir DIR]
       toodo logs [--follow] [--lines N]
       toodo restart
       toodo review [--period week|month|quarter|year|custom] [--date DAY] [--from DAY] [--to DAY]
                    [--format markdown|csv] [--workspace ID] [--label LABEL] [--time-zone ZONE]
                    [--data-dir DIR]
       toodo service install
       toodo --version | --help

Runs Toodo and Dori on this host as the one systemd user service ${UNIT}, from the
checkout ${ROOT}.

toodo is the command for people on this host. dori is the internal command of the Dori
lead, its lanes, and runners; update, status, quota, and doctor run dori's own code.

Commands:
  update           update this checkout and the host as dori update does: fast-forward to
                   origin/dev (--dev) or origin/main (--main), install dependencies, build
                   the web app, restart or reload ${UNIT}, and roll out to the runners;
                   without either it stays on the checkout's channel (main when the checkout
                   is on main, else dev); --force restarts even when nothing moved
  status           Dori's one-screen state: services, lead, lanes, waits, repos, gateway
  quota            Claude 5h/7d usage of every account with reset times
  doctor           check ${UNIT}, the units it replaces, the server's answer, the
                   database, and the healthchecks.io ping file, then run dori doctor;
                   exits 1 on a problem in either
  logs             print the journal of ${UNIT}; --follow keeps printing new lines,
                   --lines N starts N lines back (default 100)
  restart          restart ${UNIT} (the core and the supervisor)
  review           print the review of a period as Markdown or CSV, read from the
                   database with the TypeScript storage (the running service may keep
                   serving)
  service install  write ~/.config/systemd/user/${UNIT} for this checkout and reload
                   systemd, carrying the TOODO_* settings of toodo-server.service and
                   DORI_CONFIG of dori-supervisor.service; it enables and starts nothing
                   (see docs/host.md for the switch)

The data directory is --data-dir, else $TOODO_DATA_DIR, else the one ${UNIT} sets, else
the one toodo init recorded in ~/.config/toodo/data-dir, else ~/.local/share/toodo-server.`;

export type Env = Readonly<Record<string, string | undefined>>;
export type Ran = { readonly code: number; readonly out: string };
export type Run = (argv: readonly string[]) => Promise<Ran>;

export const unitDir = (env: Env): string =>
  join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "systemd", "user");

const readText = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** A unit file's text followed by its drop-ins (`<unit>.d/*.conf`) in name order, the order systemd applies them in. */
const unitWithDropIns = (dir: string, unit: string): string => {
  const dropIns = join(dir, `${unit}.d`);
  const confs = existsSync(dropIns) ? readdirSync(dropIns).filter((name) => name.endsWith(".conf")).sort() : [];
  return [readText(join(dir, unit)), ...confs.map((name) => readText(join(dropIns, name)))].join("\n");
};

/** The `Environment=` assignments of unit file text, quotes removed; a later one wins. */
export const unitEnvironment = (text: string): Map<string, string> => {
  const env = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*Environment=(.*)$/.exec(line);
    for (const word of match?.[1]?.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
      const assignment = /^["']/.test(word) ? word.slice(1, -1) : word;
      const eq = assignment.indexOf("=");
      if (eq > 0) env.set(assignment.slice(0, eq), assignment.slice(eq + 1));
    }
  }
  return env;
};

/**
 * The core's configuration as toodo.service runs it: each `TOODO_*` from the environment, else from the unit; the data
 * directory from `dataDir`, else the environment, the unit, or the directory toodo init recorded.
 */
export const hostConfig = (env: Env, dataDir: string | undefined): Config => {
  const unit = unitEnvironment(readText(join(unitDir(env), UNIT)));
  const recorded = readText(join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "toodo", "data-dir")).trim();
  const dir = dataDir ?? env.TOODO_DATA_DIR ?? unit.get("TOODO_DATA_DIR") ?? (recorded || undefined);
  return configFromEnv((name) => (name === "TOODO_DATA_DIR" ? dir : env[name] ?? unit.get(name)));
};

export type UnitInputs = {
  readonly src: string;
  readonly bun: string;
  readonly path: string;
  readonly server: string;
  readonly supervisor: string;
};

/**
 * toodo.service for the checkout `src`: the core's `TOODO_*` settings of toodo-server.service (its drop-ins included), its web app from the
 * checkout's `dist-web`, and `DORI_CONFIG` and `PATH` of dori-supervisor.service. Nothing else is carried, so neither an
 * `EnvironmentFile` nor a secret of the old units reaches the new one.
 */
export const renderUnit = (template: string, inputs: UnitInputs): string => {
  const env = new Map<string, string>();
  for (const [name, value] of unitEnvironment(inputs.server)) {
    if (name.startsWith("TOODO_") && name !== "TOODO_WEB_DIR") env.set(name, value);
  }
  env.set("TOODO_WEB_DIR", join(inputs.src, "dist-web"));
  const supervisor = unitEnvironment(inputs.supervisor);
  const config = supervisor.get("DORI_CONFIG");
  if (config) env.set("DORI_CONFIG", config);
  env.set("PATH", supervisor.get("PATH") || inputs.path);
  env.set("LANG", "C.UTF-8");
  const lines = [...env].map(([name, value]) => (/[\s"\\]/.test(value) ? `Environment="${name}=${value.replace(/["\\]/g, "\\$&")}"` : `Environment=${name}=${value}`));
  return template.replaceAll("{{SRC}}", inputs.src).replaceAll("{{BUN}}", inputs.bun).replace("{{ENVIRONMENT}}", lines.join("\n"));
};

export type InstallDeps = { readonly env: Env; readonly run: Run; readonly platform: string; readonly bun: string; readonly log: (line: string) => void };

export const serviceInstall = async (d: InstallDeps): Promise<number> => {
  if (d.platform !== "linux") {
    d.log(`toodo: service install writes a systemd user unit; ${UNIT} runs on a Linux host`);
    return 1;
  }
  const dir = unitDir(d.env);
  const target = join(dir, UNIT);
  const text = renderUnit(readFileSync(join(ROOT, "host", UNIT), "utf8"), {
    src: ROOT, bun: d.bun, path: d.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    server: unitWithDropIns(dir, LEGACY_UNITS[0]), supervisor: unitWithDropIns(dir, LEGACY_UNITS[1]),
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${target}.tmp`, text, { mode: 0o644 });
  renameSync(`${target}.tmp`, target);
  d.log(`Wrote ${target} for ${ROOT}.`);
  const reload = await d.run(["systemctl", "--user", "daemon-reload"]);
  if (reload.code !== 0) {
    d.log(`toodo: systemctl --user daemon-reload failed: ${reload.out}`);
    return 1;
  }
  if (!existsSync(join(ROOT, "dist-web", "index.html"))) {
    d.log(`The web app is not built: run npm ci && npx vite build in ${ROOT} before starting ${UNIT}.`);
  }
  d.log(`${UNIT} is not enabled or started; switch to it as docs/host.md describes.`);
  return 0;
};

type Level = "OK" | "WARN" | "FAIL";
export type Check = { readonly level: Level; readonly name: string; readonly detail: string; readonly fix?: string };
const ok = (name: string, detail: string): Check => ({ level: "OK", name, detail });
const warn = (name: string, detail: string, fix?: string): Check => ({ level: "WARN", name, detail, ...(fix ? { fix } : {}) });
const fail = (name: string, detail: string, fix: string): Check => ({ level: "FAIL", name, detail, fix });

export type DoctorDeps = {
  readonly env: Env;
  readonly run: Run;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly config: Config;
};

const units = async (d: DoctorDeps): Promise<{ checks: Check[]; active: boolean }> => {
  const systemctl = (...args: string[]) => d.run(["systemctl", "--user", ...args]);
  const state = await systemctl("is-active", UNIT);
  if (state.code === 127) return { checks: [warn("systemd", "systemctl is not available here; toodo.service runs on a Linux host")], active: false };
  const installed = existsSync(join(unitDir(d.env), UNIT));
  const active = state.out === "active";
  const checks: Check[] = [];
  if (active) checks.push(ok(`unit ${UNIT}`, "active"));
  else checks.push(fail(`unit ${UNIT}`, installed ? state.out || "inactive" : "not installed", installed ? `systemctl --user enable --now ${UNIT}` : "toodo service install"));
  if (installed) {
    const dir = (await systemctl("show", UNIT, "--property=WorkingDirectory", "--value")).out;
    checks.push(dir === ROOT ? ok("unit checkout", dir)
      : fail("unit checkout", `${UNIT} runs ${dir || "no checkout"}, not ${ROOT}`, `toodo service install from the checkout to run, then systemctl --user restart ${UNIT}`));
    const assigned = (await systemctl("show", UNIT, "--property=Environment", "--value")).out.split(/\s+/);
    const files = (await systemctl("show", UNIT, "--property=EnvironmentFiles", "--value")).out;
    const secrets = parseEnvFile(readText(join(d.env.HOME || homedir(), ".dori", "env"))).map(([name]) => name);
    const leaked = secrets.filter((name) => assigned.some((a) => a.startsWith(`${name}=`)));
    if (files.includes(".dori/env")) checks.push(fail("unit secrets", `${UNIT} loads ~/.dori/env with EnvironmentFile`, "toodo service install"));
    else if (leaked.length) checks.push(fail("unit secrets", `${UNIT} sets ${leaked.join(", ")} in its environment`, "toodo service install"));
    else checks.push(ok("unit secrets", "none in the unit's environment; the supervisor Worker reads ~/.dori/env"));
  }
  for (const legacy of LEGACY_UNITS) {
    if ((await systemctl("is-active", legacy)).out !== "active") continue;
    checks.push(active
      ? fail(`unit ${legacy}`, `active beside ${UNIT}, which replaces it`, `systemctl --user disable --now ${legacy}`)
      : warn(`unit ${legacy}`, `active: ${UNIT} has not replaced it yet`, "docs/host.md"));
  }
  return { checks, active };
};

const server = async (d: DoctorDeps): Promise<Check[]> => {
  const { hostname, port } = d.config.listen;
  const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname === "::" ? "[::1]" : hostname.includes(":") ? `[${hostname}]` : hostname;
  const base = `http://${host}:${port}`;
  let state: string;
  try {
    const reply = await d.fetch(`${base}/api/host`, { signal: AbortSignal.timeout(5_000) });
    state = ((await reply.json()) as { supervisor?: { state?: string } }).supervisor?.state ?? `HTTP ${reply.status}`;
  } catch (e) {
    return [fail("server", `no answer on ${base}: ${e instanceof Error ? e.message : String(e)}`, `journalctl --user -u ${UNIT}`)];
  }
  const checks = [state === "running" ? ok("supervisor", "running in the host's Worker")
    : state === "off" ? warn("supervisor", "off: safe mode (TOODO_SUPERVISOR=off)")
    : fail("supervisor", `${state} (GET ${base}/api/host)`, `journalctl --user -u ${UNIT}`)];
  try {
    const token = readFileSync(join(d.config.dataDir, WEB_TOKEN_FILE), "utf8").trim();
    const reply = await d.fetch(`${base}/api/rpc/app_info`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5_000) });
    const version = ((await reply.json()) as { version?: string }).version;
    checks.push(version === VERSION ? ok("server version", version)
      : warn("server version", `the server runs ${version ?? `nothing it names (HTTP ${reply.status})`}, the checkout has ${VERSION}`, `systemctl --user restart ${UNIT}`));
  } catch (e) {
    checks.push(warn("server version", `cannot ask: ${e instanceof Error ? e.message : String(e)}`));
  }
  return checks;
};

const data = (d: DoctorDeps): Check[] => {
  const dir = d.config.dataDir;
  const checks: Check[] = [];
  const path = join(dir, DATABASE_FILE);
  if (!existsSync(path)) checks.push(fail("database", `missing: ${path}`, "start toodo.service once, which creates it, or pass --data-dir"));
  else {
    try {
      const db = openReader(path);
      try {
        const result = db.query<{ quick_check: string }, []>("PRAGMA quick_check").all().map((row) => row.quick_check);
        checks.push(result.join() === "ok" ? ok("database", `${path}, schema v${schemaVersion(db)}, quick_check ok`)
          : fail("database", `quick_check: ${result.slice(0, 3).join("; ")}`, "restore a backup (docs/server.md, Backups)"));
      } finally {
        db.close();
      }
    } catch (e) {
      checks.push(fail("database", e instanceof Error ? e.message : String(e), "docs/server.md"));
    }
  }
  for (const [name, file] of [["web token", WEB_TOKEN_FILE], ["MCP token", MCP_TOKEN_FILE]] as const) {
    const token = join(dir, file);
    checks.push(existsSync(token) ? ok(name, token) : fail(name, `missing: ${token}`, `systemctl --user restart ${UNIT} (the server creates it)`));
  }
  const { pingFile } = healthcheckPaths(d.env);
  const urls = parsePingFile(readText(pingFile));
  const set = [urls.toodo && "HC_TOODO_URL", urls.dori && "HC_DORI_URL"].filter(Boolean);
  checks.push(set.length === 2 ? ok("healthcheck", `${set.join(" and ")} in ${pingFile} (values hidden)`)
    : warn("healthcheck", `${set.length ? `only ${set.join("")}` : "no ping URL"} in ${pingFile}; the host pings only what is set`, `write HC_TOODO_URL and HC_DORI_URL to ${pingFile} (mode 600)`));
  return checks;
};

export const runDoctor = async (d: DoctorDeps): Promise<Check[]> => {
  const { checks, active } = await units(d);
  return [...checks, ...(active || checks.some((c) => c.name === "systemd") ? await server(d) : []), ...data(d)];
};

export const renderChecks = (checks: readonly Check[]): string =>
  checks.map((c) => `${c.level.padEnd(4)} ${c.name}: ${c.detail}${c.fix ? `\n     fix: ${c.fix}` : ""}`).join("\n");

const REVIEW_OPTIONS = {
  period: { type: "string" }, date: { type: "string" }, from: { type: "string" }, to: { type: "string" },
  format: { type: "string" }, workspace: { type: "string" }, label: { type: "string" }, "time-zone": { type: "string" },
  "data-dir": { type: "string" },
} as const;

export const reviewRequest = (args: readonly string[]): { request: B.ReviewReportRequest; dataDir: string | undefined } => {
  const { values, positionals } = parseArgs({ args: [...args], options: REVIEW_OPTIONS, strict: true, allowPositionals: true });
  if (positionals.length) throw new Error(`unexpected argument ${JSON.stringify(positionals[0])}`);
  const period = values.period ?? "week";
  if (!["week", "month", "quarter", "year", "custom"].includes(period)) throw new Error(`--period takes week, month, quarter, year, or custom, got ${JSON.stringify(period)}`);
  const format = values.format ?? "markdown";
  if (format !== "markdown" && format !== "csv") throw new Error(`--format takes markdown or csv, got ${JSON.stringify(format)}`);
  const workspace = values.workspace === undefined ? null : Number(values.workspace);
  if (workspace !== null && !(Number.isInteger(workspace) && workspace > 0)) throw new Error(`--workspace takes a workspace ID, e.g. 1, got ${JSON.stringify(values.workspace)}`);
  return {
    request: {
      period: period as B.ReviewReportRequest["period"], date: values.date ?? null, from: values.from ?? null, to: values.to ?? null,
      format, timeZone: values["time-zone"] ?? null, workspaceId: workspace, label: values.label ?? null,
    },
    dataDir: values["data-dir"],
  };
};

export const review = (config: Config, request: B.ReviewReportRequest): string => {
  const db = openReader(join(config.dataDir, DATABASE_FILE));
  try {
    return reviewReport(new Storage(db), request).contents;
  } finally {
    db.close();
  }
};

/**
 * dori's arguments for `toodo update`: the channel is `--dev` or `--main` when given, else the checkout's `branch` (main
 * stays on main; any other branch follows dev, the branch the owner host's checkout and the supervisor's automatic update
 * track). `dori update` alone would switch a dev checkout to main.
 */
export const updateArgs = (args: readonly string[], branch: string): string[] => {
  const { values } = parseArgs({ args: [...args], options: { dev: { type: "boolean" }, main: { type: "boolean" }, force: { type: "boolean" } }, strict: true });
  if (values.dev && values.main) throw new Error("--dev and --main pick opposite channels; give one");
  const dev = values.dev === true || (values.main !== true && branch !== "main");
  return ["update", ...(dev ? ["--dev"] : []), ...(values.force ? ["--force"] : [])];
};

/** `journalctl` arguments for `toodo logs`. */
export const logsArgs = (args: readonly string[]): string[] => {
  const { values } = parseArgs({ args: [...args], options: { follow: { type: "boolean", short: "f" }, lines: { type: "string", short: "n" } }, strict: true });
  const lines = values.lines ?? "100";
  if (!/^\d+$/.test(lines)) throw new Error(`--lines takes a number of lines, got ${JSON.stringify(lines)}`);
  return ["journalctl", "--user", "-u", UNIT, "-n", lines, ...(values.follow ? ["-f"] : [])];
};

/** Runs `argv` on this terminal (stdin, stdout, and stderr passed through) and returns its exit code. */
const attached = async (argv: readonly string[]): Promise<number> => {
  try {
    return await Bun.spawn([...argv], { env: process.env, stdio: ["inherit", "inherit", "inherit"] }).exited;
  } catch {
    console.error(`toodo: ${argv[0]} not found`);
    return 127;
  }
};

const dori = (args: readonly string[]): Promise<number> => attached([process.execPath, DORI_CLI, ...args]);

const systemdOnly = (command: string): boolean => {
  if (process.platform === "linux") return true;
  console.error(`toodo: ${command} works on ${UNIT}, a systemd user service on a Linux host`);
  return false;
};

const realRun: Run = async (argv) => {
  try {
    const child = Bun.spawn([...argv], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: (out || err).trim() };
  } catch {
    return { code: 127, out: `${argv[0]} not found` };
  }
};

const main = async (args: string[]): Promise<number> => {
  const [command, ...rest] = args;
  if (command === undefined || command === "-h" || command === "--help" || rest.includes("--help")) {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  if (command === "-V" || command === "--version") {
    console.log(`toodo ${VERSION}`);
    return 0;
  }
  try {
    if (command === "review") {
      const { request, dataDir } = reviewRequest(rest);
      process.stdout.write(review(hostConfig(process.env, dataDir), request));
      return 0;
    }
    if (command === "update") {
      const args = updateArgs(rest, (await realRun(["git", "-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"])).out);
      console.log(`toodo: dori ${args.join(" ")} (checkout ${ROOT})`);
      return await dori(args);
    }
    if (command === "status" || command === "quota") return await dori([command, ...rest]);
    if (command === "doctor") {
      const { values } = parseArgs({ args: rest, options: { "data-dir": { type: "string" } }, strict: true });
      console.log(`toodo ${VERSION} (checkout ${ROOT})`);
      const checks = await runDoctor({ env: process.env, run: realRun, fetch: (input, init) => fetch(input, init), config: hostConfig(process.env, values["data-dir"]) });
      console.log(renderChecks(checks));
      console.log("\ndori doctor:");
      const doriCode = await dori(["doctor"]);
      return checks.some((c) => c.level === "FAIL") || doriCode !== 0 ? 1 : 0;
    }
    if (command === "logs") {
      const argv = logsArgs(rest);
      return systemdOnly(command) ? await attached(argv) : 1;
    }
    if (command === "restart" && rest.length === 0) {
      return systemdOnly(command) ? await attached(["systemctl", "--user", "restart", UNIT]) : 1;
    }
    if (command === "service" && rest.length === 1 && rest[0] === "install") {
      return await serviceInstall({ env: process.env, run: realRun, platform: process.platform, bun: process.execPath, log: (line) => { console.log(line); } });
    }
  } catch (e) {
    console.error(`toodo: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof CommandError ? 1 : 2;
  }
  console.error(`toodo: unknown command ${JSON.stringify(args.join(" "))}\n\n${USAGE}`);
  return 2;
};

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
