// Settings > Machines & accounts in the supervisor Worker (src/lib/machines.ts): the host relays each request of the
// Toodo web app here, so every command runs on this thread and none on the core's. It lists the server host and the
// runners the hub knows with hc's and omo's versions, reads and edits a runner's runner-config.json (the local one, or
// a worker's over ssh; the runner's own file watch applies a saved change without a restart), and runs the jobs that
// install or update hc and omo (tool-jobs.ts) and sign omo's Claude and Codex accounts in (provider-login.ts), publishing
// each job's state as it changes: on the host itself, and on a runner's machine through that runner (`tool.job`, whose
// state and log it reads with `q.tool.job`, and `tool.answer` for a sign-in's pasted code). It adds
// another computer as a runner: over ssh, after the checks of runner/precheck.ts, as a job running `dori runner install`;
// or by a pasted command, whose enrollment code, installer download and enrollment exchange runner/paste-enroll.ts answers.

import { join } from "node:path";

import {
  HOST_MACHINE, MACHINE_JOB_LOG_LIMIT, type MachineJob, type MachineJobsUnavailable, type MachineLogins, type MachineProvider, type MachineReply,
  type MachineRequest, type MachineRow, type MachineTool, type RunnerConfigView,
} from "../../../../../src/lib/machines.ts";
import type { DoriConfigEntry } from "../../../../../src/lib/dori-config.ts";
import { ConfigKeyError, formatValue, type Json, parseValue, RUNNER_CONFIG_KEYS } from "./config-keys.ts";
import type { LaneOps } from "./lane-ops.ts";
import { redactSecrets } from "./redact.ts";
import { listGuardMachines, machineKind } from "./remote-guard.ts";
import type { Runner } from "./run.ts";
import { SupervisorAuth } from "./runner/auth.ts";
import { readRunnerRows } from "./runner/hub.ts";
import { buildBundle } from "./runner/install.ts";
import { PLACEMENT_ONLY_KEYS } from "./runner/local-policy.ts";
import { labelFromHost, parseInstallTarget } from "./runner/machines.ts";
import { bootstrapScript, EnrollRefused, PasteEnrollments } from "./runner/paste-enroll.ts";
import { installProblem, precheckRunner } from "./runner/precheck.ts";
import { LABEL_PATTERN } from "./runner/protocol.ts";
import { loginCommand, type ProviderLoginHandle, readProviderLogins, startProviderLogin } from "./provider-login.ts";
import { localRunnerConfigIO, remoteRunnerConfigIO, type RunnerConfigIO, runRunnerSetup } from "./runner/runner-setup.ts";
import { defaultsPrompter } from "./setup-cli.ts";
import { runnerViews } from "./status.ts";
import { envRunner, installCommand, jobLog, runStreamedJob, type ToolJobKind, toolJobsUnsupported, withLocalBin } from "./tool-jobs.ts";
import { toolVersions, type ToolVersions } from "./tool-versions.ts";

/**
 * The runner-config keys the web app may change: only those that declare placement. Every other key either runs a
 * command (agents, sandboxCheck, hostCommands), moves the sandbox boundary (allowedRoots, sandbox, grants, jobs) or
 * kills processes (heavyKill), so it is changed on that machine; and on the host a file holding any other key replaces
 * the policy the local runner derives from config.json (runner/local-policy.ts).
 */
export const EDITABLE_RUNNER_KEYS: ReadonlySet<string> = new Set(PLACEMENT_ONLY_KEYS);

/** `dori runner install`: bundling, then up to three ssh passes of INSTALL_TIMEOUT_MS (Windows: longer) each. */
const RUNNER_INSTALL_TIMEOUT_MS = 30 * 60_000;
/** The `dori` CLI a runner install job runs, with the Worker's own bun. */
const CLI_ENTRY = join(import.meta.dir, "cli.ts");
/** A running job's state is published at most this often; its end is published at once. */
const PUBLISH_EVERY_MS = 250;
const KEPT_JOBS = 10;
/** How often a runner's tool job is read while it runs. */
const FOLLOW_EVERY_MS = 500;
/** A runner's tool job that cannot be read for this long (its runner gone) ends failed. */
const FOLLOW_GIVE_UP_MS = 2 * 60_000;

export type MachineAdminDeps = {
  readonly stateDir: string;
  readonly guardMachines: Readonly<Record<string, string>>;
  readonly runnerDir: string;
  readonly home: string;
  /** The environment the jobs and version reads run in; ~/.local/bin, where hc and omo install, is put on its PATH. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Runs the ssh commands that read and write a worker's runner-config.json and pre-check a new one. */
  readonly run: Runner;
  /** The lead's agent command, for the starter runner-config.json a pasted enrollment writes. */
  readonly agentCommand: readonly string[];
  readonly now: () => number;
  /**
   * A connected worker's runner: hc's and omo's versions, its Claude and Codex sign-ins and whether it runs tool jobs
   * (`q.machine.observe` with `tools`), and its tool jobs (`tool.job`, `q.tool.job`, `tool.answer`, `tool.cancel`).
   */
  readonly runners: Pick<LaneOps, "observeMachine" | "toolJob" | "toolJobState" | "toolAnswer" | "toolCancel">;
  /** Receives each job's latest state while it runs and once it ends. */
  readonly publish: (job: MachineJob) => void;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A job the Worker holds; `answer` passes a running sign-in the owner's pasted answer. */
type Running = { job: MachineJob; readonly kill: () => void | Promise<void>; answer?: (value: string) => void | Promise<void> };
type Update = (patch: Partial<MachineJob>, now?: boolean) => void;

export class MachineAdmin {
  readonly #deps: MachineAdminDeps;
  readonly #env: Record<string, string>;
  readonly #run: Runner;
  readonly #jobs = new Map<string, Running>();
  readonly #enrollments: PasteEnrollments;
  #lastId = 0;
  #auth: SupervisorAuth | undefined;
  #bundle: Promise<string> | undefined;

  constructor(deps: MachineAdminDeps) {
    this.#deps = deps;
    this.#env = withLocalBin(deps.env, deps.home);
    this.#run = envRunner(this.#env);
    this.#enrollments = new PasteEnrollments({
      auth: () => (this.#auth ??= new SupervisorAuth(deps.stateDir, { now: deps.now })),
      bundle: () => this.#runnerBundle(),
      agentCommand: deps.agentCommand,
      stateDir: deps.stateDir,
      now: deps.now,
    });
  }

  /** The runner bundle a pasted enrollment downloads, built once per Worker; a failed build is tried again next time. */
  #runnerBundle(): Promise<string> {
    this.#bundle ??= buildBundle(this.#run, undefined, this.#deps.stateDir)().catch((e: unknown) => {
      this.#bundle = undefined;
      throw e;
    });
    return this.#bundle;
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
        case "install": return { ok: true, job: await this.#install(request.machine, request.tool) };
        case "login": return { ok: true, job: await this.#login(request.machine, request.provider) };
        case "login-answer": return { ok: true, job: await this.#loginAnswer(request.job, request.value) };
        case "cancel": return { ok: true, job: await this.#cancel(request.job) };
        case "precheck": return { ok: true, precheck: await precheckRunner(this.#deps, request) };
        case "add-ssh": return { ok: true, job: this.#addRunner(request.target, request.label) };
        case "enroll-code": return { ok: true, enrollment: this.#enrollments.issue(request.label, request.address) };
        case "enroll-bootstrap": return { ok: true, script: bootstrapScript(request.shell) };
        case "enroll-script": return { ok: true, script: await this.#enrollments.script(request.label, request.shell, request.token) };
        case "enroll-exchange": return { ok: true, enrolled: this.#enrollments.exchange(request.label, request.token, request.request) };
      }
    } catch (e) {
      return e instanceof EnrollRefused ? { ok: false, error: e.message, refused: true } : { ok: false, error: errorText(e) };
    }
  }

  jobs(): MachineJob[] {
    return [...this.#jobs.values()].map((r) => r.job).sort((a, b) => b.startedAt - a.startedAt);
  }

  async #machines(): Promise<MachineRow[]> {
    const ssh = new Set(listGuardMachines(this.#deps.guardMachines, this.#deps.stateDir).map((m) => m.label));
    const views = runnerViews(readRunnerRows(this.#deps.stateDir), this.#deps.now());
    const unavailable = (os: string, runsJobs: boolean): MachineJobsUnavailable | null =>
      toolJobsUnsupported(os as NodeJS.Platform) ? "unsupported-os" : runsJobs ? null : "runner-outdated";
    return Promise.all(views.map(async (view): Promise<MachineRow> => {
      const host = view.label === HOST_MACHINE;
      let os = view.machine?.os ?? (host ? process.platform : null);
      let tools: ToolVersions | null = null;
      let toolsError: string | null = null;
      let jobsUnavailable: MachineJobsUnavailable | null = null;
      let logins: MachineLogins | null = null;
      if (host) {
        [tools, logins] = await Promise.all([toolVersions(this.#run), readProviderLogins(this.#run)]);
        jobsUnavailable = unavailable(process.platform, true);
      } else if (view.state !== "connected") toolsError = `the runner is ${view.state}`;
      else {
        try {
          const seen = await this.#deps.runners.observeMachine(view.label, { tools: true });
          os = seen.os;
          tools = seen.tools ?? null;
          logins = seen.logins ?? null;
          if (tools === null) toolsError = "the runner does not report tool versions yet; update it (dori update)";
          jobsUnavailable = unavailable(seen.os, seen.toolJobs === true);
        } catch (e) {
          toolsError = errorText(e);
        }
      }
      return {
        label: view.label, state: view.state, version: view.version ?? null, os, tools, toolsError, jobsUnavailable, logins,
        config: host || ssh.has(view.label),
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

  #runningFor(machine: string, tool: MachineTool): Running | undefined {
    return [...this.#jobs.values()].find((r) => r.job.machine === machine && r.job.tool === tool && r.job.state === "running");
  }

  /** Installs a runner on `target` over ssh: the same `dori runner install` an operator runs, as a job. */
  #addRunner(target: string, label: string): MachineJob {
    const host = parseInstallTarget(target.trim()).host;
    const name = label.trim() || labelFromHost(host);
    if (!LABEL_PATTERN.test(name) || name === HOST_MACHINE) throw new Error(`${name} is not a label for another computer`);
    const busy = [...this.#jobs.values()].find((r) => r.job.kind === "runner" && r.job.machine === name && r.job.state === "running");
    if (busy) throw new Error(`${name} is already being installed (${busy.job.id})`);
    const args = ["runner", "install", target.trim(), "--label", name, "--yes"];
    return this.#start("runner", null, name, [process.execPath, CLI_ENTRY, ...args], `dori ${args.join(" ")}`, RUNNER_INSTALL_TIMEOUT_MS);
  }

  /** Installs or updates `tool` on the host or on runner `machine`'s host. */
  async #install(machine: string, tool: MachineTool): Promise<MachineJob> {
    if (machine !== HOST_MACHINE) return this.#runnerToolJob(machine, { tool, kind: "install" });
    const installed = (await toolVersions(this.#run))[tool] !== null;
    // Checked after the version read, so two requests that arrive together cannot both start.
    const busy = this.#runningFor(machine, tool);
    if (busy) throw new Error(`a ${tool} job is already running (${busy.job.id})`);
    const { argv, command, timeoutMs } = installCommand(tool, installed);
    return this.#start("install", tool, machine, argv, command, timeoutMs);
  }

  /**
   * Signs `provider`'s account in inside omo on the host or on runner `machine`'s host. It runs in omo, so it waits for
   * no other omo job there; a runner older than provider sign-in (no `logins` in its observation) is refused.
   */
  async #login(machine: string, provider: MachineProvider): Promise<MachineJob> {
    if (machine !== HOST_MACHINE) {
      const seen = await this.#deps.runners.observeMachine(machine, { tools: true });
      if (seen.logins === undefined) throw new Error(`the runner on ${machine} cannot sign Claude and Codex in yet; update it on that machine (dori update)`);
      return this.#runnerToolJob(machine, { tool: "omo", kind: "login", provider });
    }
    const busy = this.#runningFor(machine, "omo");
    if (busy) throw new Error(`an omo job is already running (${busy.job.id})`);
    const command = loginCommand(provider);
    const lines: string[] = [];
    const log = (): string => jobLog(command, lines.map((l) => `${l}\n`).join(""), MACHINE_JOB_LOG_LIMIT);
    let handle: ProviderLoginHandle | undefined;
    const { running, update } = this.#track(this.#newId(), "login", "omo", provider, machine, command, () => { handle?.cancel(); });
    const login = startProviderLogin({
      provider, env: this.#env, cwd: this.#deps.home,
      onLog: (line) => { lines.push(line); update({ log: log() }); },
      onSignIn: (signIn) => { update({ signIn }); },
      onEnd: ({ state, error }) => {
        if (error !== null && lines.at(-1) !== error) lines.push(error);
        update({ state, log: log(), signIn: null, endedAt: this.#deps.now() }, true);
      },
    });
    handle = login;
    running.answer = (value) => { login.answer(value); };
    return running.job;
  }

  /** Passes the owner's answer to sign-in `id` (never kept or logged here). */
  async #loginAnswer(id: string, value: string): Promise<MachineJob> {
    const running = this.#jobs.get(id);
    if (running === undefined) throw new Error(`no job ${id}`);
    if (running.job.state !== "running" || running.answer === undefined) throw new Error(`${id} is not a sign-in that waits for an answer`);
    if (value.trim() === "") throw new Error("the answer is empty");
    await running.answer(value);
    return running.job;
  }

  /**
   * Starts the tool job on runner `machine`, which runs it on its host, then reads its state and log there every
   * FOLLOW_EVERY_MS and publishes them like a host job's, until it ends or cannot be read for FOLLOW_GIVE_UP_MS.
   */
  async #runnerToolJob(
    machine: string, body: { readonly tool: MachineTool; readonly kind: ToolJobKind; readonly provider?: MachineProvider },
  ): Promise<MachineJob> {
    const busy = this.#runningFor(machine, body.tool);
    if (busy) throw new Error(`a ${body.tool} job is already running on ${machine} (${busy.job.id})`);
    const id = this.#newId();
    const { command } = await this.#deps.runners.toolJob(machine, { job: id, ...body });
    const { running, update } = this.#track(
      id, body.kind, body.tool, body.provider ?? null, machine, command, () => this.#deps.runners.toolCancel(machine, id),
    );
    if (body.kind === "login") running.answer = (value) => this.#deps.runners.toolAnswer(machine, id, value);
    let failingSince: number | undefined;
    const follow = async (): Promise<void> => {
      try {
        const view = await this.#deps.runners.toolJobState(machine, id);
        failingSince = undefined;
        if (view.state === "running") {
          update({ log: view.log, signIn: view.signIn });
          setTimeout(follow, FOLLOW_EVERY_MS);
          return;
        }
        update({ state: view.state, log: view.log, signIn: null, exitCode: view.exitCode, version: view.version, endedAt: this.#deps.now() }, true);
      } catch (e) {
        failingSince ??= this.#deps.now();
        // A restarted runner no longer knows the job: it will never end there.
        if (!errorText(e).includes("no tool job") && this.#deps.now() - failingSince < FOLLOW_GIVE_UP_MS) {
          setTimeout(follow, FOLLOW_EVERY_MS);
          return;
        }
        update({ state: "failed", log: `${running.job.log}\n${errorText(e)}\n`, endedAt: this.#deps.now() }, true);
      }
    };
    setTimeout(follow, FOLLOW_EVERY_MS);
    return running.job;
  }

  async #cancel(id: string): Promise<MachineJob> {
    const running = this.#jobs.get(id);
    if (running === undefined) throw new Error(`no job ${id}`);
    if (running.job.state === "running") await running.kill();
    return running.job;
  }

  #newId(): string {
    return `job-${this.#deps.now()}-${++this.#lastId}`;
  }

  /** Runs `argv` on the host as an install or runner job, its masked output published as it arrives. */
  #start(
    kind: "install" | "runner", tool: MachineTool | null, machine: string, argv: readonly string[], command: string, timeoutMs: number,
  ): MachineJob {
    const id = this.#newId();
    let kill = (): void => {};
    const { running, update } = this.#track(id, kind, tool, null, machine, command, () => { kill(); });
    kill = runStreamedJob({
      argv, env: this.#env, cwd: this.#deps.home, timeoutMs,
      onOutput: (output) => { update({ log: jobLog(command, output, MACHINE_JOB_LOG_LIMIT) }); },
      onEnd: ({ exitCode, output, cancelled }) => {
        running.job = { ...running.job, log: jobLog(command, output, MACHINE_JOB_LOG_LIMIT) };
        void (async () => {
          const version = tool === null ? null : (await toolVersions(this.#run).catch(() => undefined))?.[tool] ?? null;
          const state = cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
          const problem = kind === "runner" && state === "failed" ? installProblem(output) : null;
          update({ state, exitCode, version, problem, endedAt: this.#deps.now() }, true);
        })();
      },
    }).kill;
    return running.job;
  }

  /** Holds a new running job and returns the function that changes it and publishes it, at most every PUBLISH_EVERY_MS. */
  #track(
    id: string, kind: MachineJob["kind"], tool: MachineTool | null, provider: MachineProvider | null, machine: string, command: string,
    kill: Running["kill"],
  ): { readonly running: Running; readonly update: Update } {
    const running: Running = {
      job: {
        id, kind, tool, provider, machine, state: "running", command, startedAt: this.#deps.now(), endedAt: null,
        log: `$ ${command}\n`, exitCode: null, version: null, signIn: kind === "login" ? { url: null, ask: null } : null, problem: null,
      },
      kill,
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
    update({}, true);
    return { running, update };
  }

  /** Drops the oldest ended jobs past KEPT_JOBS; a running one is never dropped. */
  #prune(): void {
    const ended = this.jobs().filter((j) => j.state !== "running");
    while (this.#jobs.size > KEPT_JOBS && ended.length > 0) this.#jobs.delete(ended.pop()!.id);
  }
}
