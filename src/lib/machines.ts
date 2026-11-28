// Settings > Machines & accounts: the server host and the runner machines Dori knows, each
// runner's runner-config.json, and the jobs that install or update hc and omo on the host or
// sign omo in. The web app calls the core (`GET /api/machines`, `GET
// /api/machines/<label>/config`, `POST /api/machines`, and the job stream `GET
// /api/machines/jobs`); the core hands each request to the host and the host to the supervisor
// Worker, which runs every command. The core runs none and keeps only the latest jobs in memory.
// Types and constants only: the server, the host, the web app, and the supervisor in `dori/`
// all import this file.

import type { DoriConfigEntry } from "./dori-config.ts";
import type { SupervisorMachine } from "./supervisor-status.ts";

/** The tools a job installs, updates, or signs in. */
export const MACHINE_TOOLS = ["hc", "omo"] as const;
export type MachineTool = (typeof MACHINE_TOOLS)[number];

/** The label of the runner on the server host itself. */
export const HOST_MACHINE = "local";

/** A tool's version on a machine; `null` when it is not installed there. */
export type MachineTools = { readonly hc: string | null; readonly omo: string | null };

/** One machine as the section lists it: the server host (`local`) first, then every enrolled runner. */
export type MachineRow = {
  readonly label: string;
  readonly state: SupervisorMachine["state"];
  /** The Dori runner's version (the commit it runs), when it reported one. */
  readonly version: string | null;
  readonly os: string | null;
  /** hc and omo on that machine; `null` when it could not be asked, with `toolsError` saying why. */
  readonly tools: MachineTools | null;
  readonly toolsError: string | null;
  /** Whether the host can read its runner-config.json: the host's own, or a runner it reaches over ssh. */
  readonly config: boolean;
};

/** A runner's runner-config.json, its keys in the shape of the Dori config entries. */
export type RunnerConfigView = {
  readonly machine: string;
  /** Where the file is (a path on the host, `label:~/.dori/runner/...` for another machine). */
  readonly where: string;
  readonly present: boolean;
  readonly entries: readonly DoriConfigEntry[];
};

export type MachineJobState = "running" | "succeeded" | "failed" | "cancelled";

/** The device code `omo login` prints, approved on another device. */
export type DeviceCode = { readonly url: string; readonly userCode: string; readonly matchingCode: string | null };

/** One install, update, or sign-in run by the supervisor on the host. */
export type MachineJob = {
  readonly id: string;
  /** `install` installs a missing tool or updates an installed one; `login` signs omo in. */
  readonly kind: "install" | "login";
  readonly tool: MachineTool;
  readonly machine: string;
  readonly state: MachineJobState;
  /** The command line it runs, for the log's first line. */
  readonly command: string;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** The last MACHINE_JOB_LOG_LIMIT characters of its output, credentials masked. */
  readonly log: string;
  readonly exitCode: number | null;
  /** The tool's version once the job ended; `null` while it runs or when it is not installed. */
  readonly version: string | null;
  readonly device: DeviceCode | null;
};

/** The output a job keeps, in characters. */
export const MACHINE_JOB_LOG_LIMIT = 32 * 1024;

/** The event the job stream sends with each job's latest state. */
export const MACHINE_JOB_EVENT = "job";

export const MACHINE_OPS = ["list", "config", "config-set", "install", "login", "cancel"] as const;

export type MachineRequest =
  | { readonly op: "list" }
  | { readonly op: "config"; readonly machine: string }
  /** One key's new value as text, "" to unset it. */
  | { readonly op: "config-set"; readonly machine: string; readonly key: string; readonly value: string }
  | { readonly op: "install"; readonly tool: MachineTool }
  /** `replace`: replace this computer's earlier OmO device without asking. */
  | { readonly op: "login"; readonly replace: boolean }
  | { readonly op: "cancel"; readonly job: string };

export type MachineOp = MachineRequest["op"];

/** What each request answers with. */
export type MachineResults = {
  readonly list: { readonly machines: readonly MachineRow[]; readonly jobs: readonly MachineJob[] };
  readonly config: { readonly config: RunnerConfigView };
  readonly "config-set": { readonly config: RunnerConfigView };
  readonly install: { readonly job: MachineJob };
  readonly login: { readonly job: MachineJob };
  readonly cancel: { readonly job: MachineJob };
};

/** The answer to a request, or why it was refused. */
export type MachineReply<O extends MachineOp = MachineOp> =
  | ({ readonly ok: true } & MachineResults[O])
  | { readonly ok: false; readonly error: string };
