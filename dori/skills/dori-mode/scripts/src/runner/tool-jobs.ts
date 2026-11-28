import type { Runner } from "../run.ts";
import {
  envRunner, jobLog, parseDeviceCode, runStreamedJob, type Tool, type ToolJobKind, toolJobCommand, toolJobsUnsupported, withLocalBin,
} from "../tool-jobs.ts";
import { toolVersions } from "../tool-versions.ts";
import type { CommandResults, ToolJobView } from "./protocol.ts";

/**
 * The runner's tool jobs (`tool.job`, `tool.cancel`, `q.tool.job`): Settings > Machines & accounts installs, updates or
 * signs in hc and omo on this host through them, with the same commands the supervisor runs on its own host
 * (tool-jobs.ts). The supervisor names each job and reads its state and log while it runs; a replayed `tool.job` for a
 * job this runner already holds answers it again instead of starting a second one. Jobs live in memory only, so a
 * restarted runner no longer knows them and the supervisor ends them failed.
 */

/** As much output as the supervisor keeps of a job (src/lib/machines.ts MACHINE_JOB_LOG_LIMIT; not imported, to keep the web app's types out of the runner bundle). */
export const TOOL_JOB_LOG_LIMIT = 32 * 1024;
const KEPT_JOBS = 10;

type Held = { view: ToolJobView; readonly tool: Tool; readonly command: string; readonly kill: () => void };

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

  async start(body: { readonly job: string; readonly tool: Tool; readonly kind: ToolJobKind; readonly replace?: boolean }): Promise<{ detail: string; result: CommandResults["tool.job"] }> {
    const held = this.#jobs.get(body.job);
    if (held) return { detail: `already ${held.view.state}`, result: { command: held.command } };
    const unsupported = toolJobsUnsupported(this.#platform);
    if (unsupported) throw new Error(unsupported);
    const installed = (await toolVersions(this.#run))[body.tool] !== null;
    // Checked after the version read, so two jobs that arrive together cannot both start.
    const busy = [...this.#jobs.entries()].find(([, j]) => j.tool === body.tool && j.view.state === "running");
    if (busy) throw new Error(`a ${body.tool} job is already running (${busy[0]})`);
    const { argv, command, timeoutMs } = toolJobCommand(body.tool, body.kind, installed, body.replace === true);
    const job = runStreamedJob({
      argv, env: this.#env, cwd: this.#home, timeoutMs,
      onOutput: (output) => { entry.view = { ...entry.view, log: jobLog(command, output, TOOL_JOB_LOG_LIMIT), device: parseDeviceCode(output) }; },
      onEnd: ({ exitCode, output, cancelled }) => {
        void toolVersions(this.#run).catch(() => undefined).then((versions) => {
          entry.view = {
            state: cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed",
            log: jobLog(command, output, TOOL_JOB_LOG_LIMIT), device: null, exitCode, version: versions?.[body.tool] ?? null,
          };
        });
      },
    });
    const entry: Held = {
      view: { state: "running", log: jobLog(command, "", TOOL_JOB_LOG_LIMIT), device: null, exitCode: null, version: null },
      tool: body.tool, command, kill: job.kill,
    };
    this.#jobs.set(body.job, entry);
    this.#prune();
    return { detail: `started ${command}`, result: { command } };
  }

  cancel(job: string): { detail: string; result: CommandResults["tool.cancel"] } {
    const held = this.#held(job);
    if (held.view.state === "running") held.kill();
    return { detail: held.view.state, result: {} };
  }

  read(job: string): ToolJobView {
    return this.#held(job).view;
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
