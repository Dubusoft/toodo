import { loginCommand, type Provider, startProviderLogin } from "../provider-login.ts";
import type { Runner } from "../run.ts";
import {
  envRunner, installCommand, jobLog, runStreamedJob, type Tool, type ToolJobKind, toolJobsUnsupported, withLocalBin,
} from "../tool-jobs.ts";
import { toolVersions } from "../tool-versions.ts";
import type { CommandResults, ToolJobView } from "./protocol.ts";

/**
 * The runner's tool jobs (`tool.job`, `tool.answer`, `tool.cancel`, `q.tool.job`): Settings > Machines & accounts
 * installs or updates hc and omo, and signs omo's Claude and Codex accounts in, on this host through them, the same way
 * the supervisor does on its own host (tool-jobs.ts, provider-login.ts). The supervisor names each job and reads its
 * state and log while it runs; a replayed `tool.job` for a job this runner already holds answers it again instead of
 * starting a second one. Jobs live in memory only, so a restarted runner no longer knows them and the supervisor ends
 * them failed.
 */

/** As much output as the supervisor keeps of a job (src/lib/machines.ts MACHINE_JOB_LOG_LIMIT; not imported, to keep the web app's types out of the runner bundle). */
export const TOOL_JOB_LOG_LIMIT = 32 * 1024;
const KEPT_JOBS = 10;

type Held = {
  view: ToolJobView; readonly tool: Tool; readonly command: string; readonly kill: () => void;
  readonly answer?: (value: string) => void;
};

export class RunnerToolJobs {
  readonly #env: Record<string, string>;
  readonly #run: Runner;
  readonly #home: string;
  readonly #platform: NodeJS.Platform;
  readonly #jobs = new Map<string, Held>();

  constructor(deps: { readonly env: Readonly<Record<string, string | undefined>>; readonly home: string; readonly platform?: NodeJS.Platform }) {
    this.#env = withLocalBin(deps.env, deps.home);
    this.#run = envRunner(this.#env);
    this.#home = deps.home;
    this.#platform = deps.platform ?? process.platform;
  }

  async start(body: {
    readonly job: string; readonly tool: Tool; readonly kind: ToolJobKind; readonly provider?: Provider;
  }): Promise<{ detail: string; result: CommandResults["tool.job"] }> {
    const held = this.#jobs.get(body.job);
    if (held) return { detail: `already ${held.view.state}`, result: { command: held.command } };
    const unsupported = toolJobsUnsupported(this.#platform);
    if (unsupported) throw new Error(unsupported);
    if (body.kind === "login") {
      if (body.provider === undefined) throw new Error("a sign-in names its provider (claude or codex)");
      this.#refuseBusy(body.tool);
      return this.#login(body.job, body.provider);
    }
    const installed = (await toolVersions(this.#run))[body.tool] !== null;
    // Checked after the version read, so two jobs that arrive together cannot both start.
    this.#refuseBusy(body.tool);
    const { argv, command, timeoutMs } = installCommand(body.tool, installed);
    const job = runStreamedJob({
      argv, env: this.#env, cwd: this.#home, timeoutMs,
      onOutput: (output) => { entry.view = { ...entry.view, log: jobLog(command, output, TOOL_JOB_LOG_LIMIT) }; },
      onEnd: ({ exitCode, output, cancelled }) => {
        void toolVersions(this.#run).catch(() => undefined).then((versions) => {
          entry.view = {
            state: cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed",
            log: jobLog(command, output, TOOL_JOB_LOG_LIMIT), signIn: null, exitCode, version: versions?.[body.tool] ?? null,
          };
        });
      },
    });
    const entry: Held = {
      view: { state: "running", log: jobLog(command, "", TOOL_JOB_LOG_LIMIT), signIn: null, exitCode: null, version: null },
      tool: body.tool, command, kill: job.kill,
    };
    this.#hold(body.job, entry);
    return { detail: `started ${command}`, result: { command } };
  }

  /** Passes the owner's answer to sign-in `job`; the detail never carries it. */
  answer(job: string, value: string): { detail: string; result: CommandResults["tool.answer"] } {
    const held = this.#held(job);
    if (held.answer === undefined || held.view.state !== "running") throw new Error(`tool job ${job} is not a sign-in that waits for an answer`);
    held.answer(value);
    return { detail: "answer passed to omo", result: {} };
  }

  cancel(job: string): { detail: string; result: CommandResults["tool.cancel"] } {
    const held = this.#held(job);
    if (held.view.state === "running") held.kill();
    return { detail: held.view.state, result: {} };
  }

  read(job: string): ToolJobView {
    return this.#held(job).view;
  }

  #login(job: string, provider: Provider): { detail: string; result: CommandResults["tool.job"] } {
    const command = loginCommand(provider);
    const lines: string[] = [];
    const log = (): string => jobLog(command, lines.map((l) => `${l}\n`).join(""), TOOL_JOB_LOG_LIMIT);
    let entry: Held | undefined;
    const set = (patch: Partial<ToolJobView>): void => { if (entry) entry.view = { ...entry.view, ...patch }; };
    const login = startProviderLogin({
      provider, env: this.#env, cwd: this.#home,
      onLog: (line) => { lines.push(line); set({ log: log() }); },
      onSignIn: (signIn) => { set({ signIn }); },
      onEnd: ({ state, error }) => {
        if (error !== null && lines.at(-1) !== error) lines.push(error);
        set({ state, log: log(), signIn: null });
      },
    });
    entry = {
      view: { state: "running", log: log(), signIn: { url: null, ask: null }, exitCode: null, version: null },
      tool: "omo", command, kill: login.cancel, answer: login.answer,
    };
    this.#hold(job, entry);
    return { detail: `started ${command}`, result: { command } };
  }

  #refuseBusy(tool: Tool): void {
    const busy = [...this.#jobs.entries()].find(([, j]) => j.tool === tool && j.view.state === "running");
    if (busy) throw new Error(`a ${tool} job is already running (${busy[0]})`);
  }

  #hold(job: string, entry: Held): void {
    this.#jobs.set(job, entry);
    this.#prune();
  }

  #held(job: string): Held {
    const held = this.#jobs.get(job);
    if (held === undefined) throw new Error(`no tool job ${job} on this runner (it may have restarted)`);
    return held;
  }

  /** Drops the oldest ended jobs past KEPT_JOBS; a running one is never dropped (a Map keeps insertion order). */
  #prune(): void {
    for (const [id, held] of this.#jobs) {
      if (this.#jobs.size <= KEPT_JOBS) return;
      if (held.view.state !== "running") this.#jobs.delete(id);
    }
  }
}
