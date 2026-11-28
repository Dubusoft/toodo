// Settings > Machines & accounts in the supervisor Worker (src/lib/machines.ts): the host relays each request of the
// Toodo web app here, so every command runs on this thread and none on the core's. It lists the server host and the
// runners the hub knows with hc's and omo's versions, reads and edits a runner's runner-config.json (the local one, or
// a worker's over ssh; the runner's own file watch applies a saved change without a restart), and runs the jobs that
// install or update hc and omo on the host and sign omo in, publishing each job's state as its output arrives.

import { join } from "node:path";

import {
  HOST_MACHINE, MACHINE_JOB_LOG_LIMIT, type DeviceCode, type MachineJob, type MachineReply, type MachineRequest, type MachineRow,
  type MachineTool, type RunnerConfigView,
} from "../../../../../src/lib/machines.ts";
import type { DoriConfigEntry } from "../../../../../src/lib/dori-config.ts";
import { ConfigKeyError, formatValue, type Json, parseValue, RUNNER_CONFIG_KEYS } from "./config-keys.ts";
import { redactSecrets } from "./redact.ts";
import { listGuardMachines, machineKind } from "./remote-guard.ts";
import type { Ran, Runner } from "./run.ts";
import { readRunnerRows } from "./runner/hub.ts";
import { PLACEMENT_ONLY_KEYS } from "./runner/local-policy.ts";
import { localRunnerConfigIO, remoteRunnerConfigIO, type RunnerConfigIO, runRunnerSetup } from "./runner/runner-setup.ts";
import { hcInstallCommand } from "./runtime/hc.ts";
import { defaultsPrompter } from "./setup-cli.ts";
import { runnerViews } from "./status.ts";
import { toolVersions, type ToolVersions } from "./tool-versions.ts";

/** omo's one-line installer (into ~/.local/bin, checked against the release SHA256SUMS). */
export const OMO_INSTALL_URL = "https://get.omo.dev/install.sh";

/**
 * The runner-config keys the web app may change: only those that declare placement. Every other key either runs a
 * command (agents, sandboxCheck, hostCommands), moves the sandbox boundary (allowedRoots, sandbox, grants, jobs) or
 * kills processes (heavyKill), so it is changed on that machine; and on the host a file holding any other key replaces
 * the policy the local runner derives from config.json (runner/local-policy.ts).
 */
export const EDITABLE_RUNNER_KEYS: ReadonlySet<string> = new Set(PLACEMENT_ONLY_KEYS);

const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** A device code is approved within its lifetime (minutes) or the sign-in ends. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const VERSION_TIMEOUT_MS = 10_000;
/** A running job's state is published at most this often; its end is published at once. */
const PUBLISH_EVERY_MS = 250;
const KEPT_JOBS = 10;

export type MachineAdminDeps = {
  readonly stateDir: string;
  readonly guardMachines: Readonly<Record<string, string>>;
  readonly runnerDir: string;
  readonly home: string;
  /** The environment the jobs and version reads run in; ~/.local/bin, where hc and omo install, is put on its PATH. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Runs the ssh commands that read and write a worker's runner-config.json. */
  readonly run: Runner;
  readonly now: () => number;
  /** hc's and omo's versions on a connected worker, through its runner (`q.machine.observe` with `tools`). */
  readonly observeTools: (label: string) => Promise<ToolVersions | undefined>;
  /** Receives each job's latest state while it runs and once it ends. */
  readonly publish: (job: MachineJob) => void;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const withLocalBin = (env: MachineAdminDeps["env"], home: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  const bin = join(home, ".local", "bin");
  const path = out.PATH ?? "";
  if (!path.split(":").includes(bin)) out.PATH = path ? `${bin}:${path}` : bin;
  out.HOME = home;
  return out;
};

/** A Runner over Bun.spawn in `env` (the shared run.ts Runner takes the process's own environment). */
const envRunner = (env: Record<string, string>): Runner => async (argv, opts = {}): Promise<Ran> => {
  const proc = Bun.spawn([...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  const timer = setTimeout(() => { proc.kill(); }, opts.timeoutMs ?? VERSION_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  } finally {
    clearTimeout(timer);
  }
};

/** The device code in `omo login`'s output: `Open <url>`, `User code: <code>`, `Matching code: <digits>`. */
export const parseDeviceCode = (log: string): DeviceCode | null => {
  const url = /^Open (https:\/\/\S+)\s*$/m.exec(log)?.[1];
  const userCode = /^User code: (\S+)\s*$/m.exec(log)?.[1];
  if (url === undefined || userCode === undefined) return null;
  return { url, userCode, matchingCode: /^Matching code: (.+?)\s*$/m.exec(log)?.[1] ?? null };
};

type Running = { job: MachineJob; readonly kill: () => void };

export class MachineAdmin {
  readonly #deps: MachineAdminDeps;
  readonly #env: Record<string, string>;
  readonly #run: Runner;
  readonly #jobs = new Map<string, Running>();
  #lastId = 0;

  constructor(deps: MachineAdminDeps) {
    this.#deps = deps;
    this.#env = withLocalBin(deps.env, deps.home);
    this.#run = envRunner(this.#env);
  }

  async handle<R extends MachineRequest>(request: R): Promise<MachineReply<R["op"]>> {
    return (await this.#answer(request)) as MachineReply<R["op"]>;
  }

  async #answer(request: MachineRequest): Promise<MachineReply> {
    try {
      switch (request.op) {
        case "list": return { ok: true, machines: await this.#machines(), jobs: this.jobs() };
        case "config": return { ok: true, config: await this.#config(request.machine) };
        case "config-set": return { ok: true, config: await this.#configSet(request.machine, request.key, request.value) };
        case "install": return { ok: true, job: await this.#install(request.tool) };
        case "login": return { ok: true, job: this.#login(request.replace) };
        case "cancel": return { ok: true, job: this.#cancel(request.job) };
      }
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }

  jobs(): MachineJob[] {
    return [...this.#jobs.values()].map((r) => r.job).sort((a, b) => b.startedAt - a.startedAt);
  }

  async #machines(): Promise<MachineRow[]> {
    const ssh = new Set(listGuardMachines(this.#deps.guardMachines, this.#deps.stateDir).map((m) => m.label));
    const views = runnerViews(readRunnerRows(this.#deps.stateDir), this.#deps.now());
    return Promise.all(views.map(async (view): Promise<MachineRow> => {
      const host = view.label === HOST_MACHINE;
      let tools: ToolVersions | null = null;
      let toolsError: string | null = null;
      if (host) tools = await toolVersions(this.#run);
      else if (view.state !== "connected") toolsError = `the runner is ${view.state}`;
      else {
        try {
          tools = (await this.#deps.observeTools(view.label)) ?? null;
          if (tools === null) toolsError = "the runner does not report tool versions yet; update it (dori update)";
        } catch (e) {
          toolsError = errorText(e);
        }
      }
      return {
        label: view.label, state: view.state, version: view.version ?? null, os: view.machine?.os ?? (host ? process.platform : null),
        tools, toolsError, config: host || ssh.has(view.label),
      };
    }));
  }

  async #io(label: string): Promise<RunnerConfigIO> {
    if (label === HOST_MACHINE) return localRunnerConfigIO(this.#deps.runnerDir);
    const machine = listGuardMachines(this.#deps.guardMachines, this.#deps.stateDir).find((m) => m.label === label);
    if (machine === undefined) throw new Error(`the host has no ssh target for ${label}, so its runner-config.json is changed on that machine (dori runner setup)`);
    const kind = await machineKind(this.#deps.run, machine);
    if (!kind.ok) throw new Error(`${label} cannot be reached over ssh: ${kind.detail}`);
    return remoteRunnerConfigIO(this.#deps.run, machine, kind.kind);
  }

  async #view(label: string, io: RunnerConfigIO): Promise<RunnerConfigView> {
    const text = await io.read();
    let raw: Json = {};
    if (text !== undefined) {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${io.where} is not a JSON object`);
      raw = parsed as Json;
    }
    const entries = RUNNER_CONFIG_KEYS.map((spec): DoriConfigEntry => {
      const value = formatValue(spec, raw[spec.key]);
      // A value that looks like a credential is never shown, whatever key holds it.
      const redacted = redactSecrets(value);
      const access = redacted !== value ? "masked" : EDITABLE_RUNNER_KEYS.has(spec.key) ? "edit" : "readOnly";
      return {
        key: spec.key, kind: spec.kind, describe: spec.describe, values: spec.values ?? null, required: spec.required,
        value: redacted, access, restart: false,
      };
    });
    return { machine: label, where: io.where, present: text !== undefined, entries };
  }

  async #config(label: string): Promise<RunnerConfigView> {
    return this.#view(label, await this.#io(label));
  }

  async #configSet(label: string, key: string, value: string): Promise<RunnerConfigView> {
    const spec = RUNNER_CONFIG_KEYS.find((s) => s.key === key);
    if (spec === undefined) throw new Error(`${key} is not a runner-config key`);
    if (!EDITABLE_RUNNER_KEYS.has(key)) throw new Error(`${key} is changed only on that machine (dori runner setup)`);
    let patch: Json = {};
    const unset: string[] = [];
    if (value.trim() === "") unset.push(key);
    else {
      try { patch = { [key]: parseValue(spec, value) }; } catch (e) {
        if (e instanceof ConfigKeyError) throw new Error(e.message);
        throw e;
      }
    }
    const io = await this.#io(label);
    const lines: string[] = [];
    const code = await runRunnerSetup({
      io, prompt: defaultsPrompter, interactive: false, log: (line) => { lines.push(line); }, mode: "new",
      seenPath: join(this.#deps.stateDir, "runner-setup-keys", `${label}.json`),
    }, { patch, unset });
    if (code === 1) throw new Error(lines.find((l) => l.startsWith("RUNNER_SETUP_FAILED")) ?? lines.at(-1) ?? "runner setup failed");
    return this.#view(label, io);
  }

  #runningFor(tool: MachineTool): Running | undefined {
    return [...this.#jobs.values()].find((r) => r.job.tool === tool && r.job.state === "running");
  }

  async #install(tool: MachineTool): Promise<MachineJob> {
    const installed = (await toolVersions(this.#run))[tool] !== null;
    // Checked after the version read, so two requests that arrive together cannot both start.
    const busy = this.#runningFor(tool);
    if (busy) throw new Error(`a ${tool} job is already running (${busy.job.id})`);
    const argv = tool === "hc"
      ? hcInstallCommand(installed)
      : installed ? ["omo", "update"] : ["sh", "-c", `curl -fsSL ${OMO_INSTALL_URL} | bash`];
    return this.#start("install", tool, argv, INSTALL_TIMEOUT_MS);
  }

  #login(replace: boolean): MachineJob {
    const busy = this.#runningFor("omo");
    if (busy) throw new Error(`an omo job is already running (${busy.job.id})`);
    return this.#start("login", "omo", ["omo", "login", "--no-browser", ...(replace ? ["--replace"] : [])], LOGIN_TIMEOUT_MS);
  }

  #cancel(id: string): MachineJob {
    const running = this.#jobs.get(id);
    if (running === undefined) throw new Error(`no job ${id}`);
    if (running.job.state === "running") running.kill();
    return running.job;
  }

  #start(kind: MachineJob["kind"], tool: MachineTool, argv: readonly string[], timeoutMs: number): MachineJob {
    const id = `job-${this.#deps.now()}-${++this.#lastId}`;
    const command = argv[0] === "sh" ? argv[2]! : argv.join(" ");
    const proc = Bun.spawn([...argv], { env: this.#env, cwd: this.#deps.home, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let cancelled = false;
    let output = "";
    const running: Running = {
      job: {
        id, kind, tool, machine: HOST_MACHINE, state: "running", command, startedAt: this.#deps.now(), endedAt: null,
        log: `$ ${command}\n`, exitCode: null, version: null, device: null,
      },
      kill: () => { cancelled = true; proc.kill(); },
    };
    this.#jobs.set(id, running);
    this.#prune();
    let publishedAt = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const update = (patch: Partial<MachineJob>, now = false): void => {
      running.job = { ...running.job, ...patch };
      if (pending !== undefined) clearTimeout(pending);
      pending = undefined;
      const wait = PUBLISH_EVERY_MS - (this.#deps.now() - publishedAt);
      if (now || wait <= 0) {
        publishedAt = this.#deps.now();
        this.#deps.publish(running.job);
      } else {
        pending = setTimeout(() => { pending = undefined; publishedAt = this.#deps.now(); this.#deps.publish(running.job); }, wait);
      }
    };
    const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        output += decoder.decode(chunk, { stream: true });
        const log = redactSecrets(`$ ${command}\n${output}`);
        update({ log: log.length > MACHINE_JOB_LOG_LIMIT ? log.slice(-MACHINE_JOB_LOG_LIMIT) : log, device: parseDeviceCode(output) });
      }
    };
    const timer = setTimeout(() => { proc.kill(); }, timeoutMs);
    update({}, true);
    void (async () => {
      // A stream that fails to read still lets the job end, with the failure in its log.
      const reads = await Promise.allSettled([read(proc.stdout), read(proc.stderr)]);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      for (const r of reads) if (r.status === "rejected") output += `\n${errorText(r.reason)}\n`;
      const log = redactSecrets(`$ ${command}\n${output}`);
      running.job = { ...running.job, log: log.length > MACHINE_JOB_LOG_LIMIT ? log.slice(-MACHINE_JOB_LOG_LIMIT) : log };
      const version = (await toolVersions(this.#run).catch(() => undefined))?.[tool] ?? null;
      const state = cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
      update({ state, exitCode, version, endedAt: this.#deps.now() }, true);
    })();
    return running.job;
  }

  /** Drops the oldest ended jobs past KEPT_JOBS; a running one is never dropped. */
  #prune(): void {
    const ended = this.jobs().filter((j) => j.state !== "running");
    while (this.#jobs.size > KEPT_JOBS && ended.length > 0) this.#jobs.delete(ended.pop()!.id);
  }
}
