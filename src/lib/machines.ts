// Settings > Machines & accounts: the server host and the runner machines Dori knows, each
// runner's runner-config.json, the jobs that install or update hc and omo on the host or a
// runner or sign omo in there, and adding another computer as a runner: over ssh from the host, or by a
// one-line command pasted on the new computer (`/runner-enroll/...`). The web app calls the core (`GET /api/machines`, `GET
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

/**
 * Why hc and omo cannot be installed, updated or signed in on a machine from the web app:
 * its runner predates the tool jobs (`dori update` updates it), or its OS has no installer
 * the jobs can run (Windows).
 */
export const MACHINE_JOBS_UNAVAILABLE = ["runner-outdated", "unsupported-os"] as const;
export type MachineJobsUnavailable = (typeof MACHINE_JOBS_UNAVAILABLE)[number];

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
  /** Why its tools cannot be installed or updated from here; `null` when they can (once `tools` is known). */
  readonly jobsUnavailable: MachineJobsUnavailable | null;
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

/**
 * Why a computer cannot be added as a runner, as the pre-check or a failed install found it;
 * the web app explains each in plain words.
 */
export const RUNNER_PROBLEMS = [
  "target-invalid",
  "label-invalid",
  "label-taken",
  "unreachable",
  "unsupported",
  "no-bun",
  "no-hc",
  "not-private",
  "enroll-failed",
  "install-failed",
] as const;
export type RunnerProblemCode = (typeof RUNNER_PROBLEMS)[number];
export type RunnerProblem = { readonly code: RunnerProblemCode; readonly detail: string };

/** What the host found out about an ssh target before installing a runner there. */
export type RunnerPrecheck = {
  readonly target: string;
  /** The runner's label: the one asked for, or one derived from the host name. */
  readonly label: string;
  /** `linux`, `darwin` or `windows` once the host reached it. */
  readonly os: string | null;
  /** The private host:port the supervisor dials the runner on, once the target resolved to one. */
  readonly listen: string | null;
  /** Empty when the install can start. */
  readonly problems: readonly RunnerProblem[];
};

/** The shells a pasted enrollment command is written for. */
export const ENROLL_SHELLS = ["posix", "windows"] as const;
export type EnrollShell = (typeof ENROLL_SHELLS)[number];

/** A one-time enrollment code for a computer without ssh access, valid until `expiresAt`. */
export type Enrollment = {
  readonly label: string;
  readonly code: string;
  /** The supervisor key's fingerprint, which the new computer checks the installer against. */
  readonly fingerprint: string;
  /** The private host:port the supervisor will dial the runner on. */
  readonly listen: string;
  readonly expiresAt: number;
};

/** The header that carries a pasted enrollment's download token (`/runner-enroll/script`, `/exchange`). */
export const ENROLL_TOKEN_HEADER = "x-dori-enroll";

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The one-line commands that enroll the new computer: the code and the fingerprint go in its
 * environment (not an argv), and the script it downloads from `server` does the rest.
 */
export function enrollCommands(server: string, enrollment: Enrollment): Record<EnrollShell, string> {
  const base = server.replace(/\/+$/, "");
  const vars = { DORI_SERVER: base, DORI_LABEL: enrollment.label, DORI_CODE: enrollment.code, DORI_FINGERPRINT: enrollment.fingerprint };
  const entries = Object.entries(vars);
  return {
    posix: `curl -fsSL ${shellQuote(`${base}/runner-enroll/install.sh`)} | ${entries.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")} sh`,
    windows: `${entries.map(([k, v]) => `$env:${k}=${psQuote(v)}`).join("; ")}; irm ${psQuote(`${base}/runner-enroll/install.ps1`)} | iex`,
  };
}

/** One install, update, sign-in, or runner install, run by the supervisor on the host or through a runner on its machine. */
export type MachineJob = {
  readonly id: string;
  /** `install` installs a missing tool or updates an installed one; `login` signs omo in; `runner` adds a computer over ssh. */
  readonly kind: "install" | "login" | "runner";
  /** The tool an install or sign-in is for; `null` for a runner install. */
  readonly tool: MachineTool | null;
  /** Where it runs: the host, a runner's machine, or the computer a runner install adds. */
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
  /** Why a failed runner install failed, read from its output. */
  readonly problem: RunnerProblemCode | null;
};

/** The output a job keeps, in characters. */
export const MACHINE_JOB_LOG_LIMIT = 32 * 1024;

/** The event the job stream sends with each job's latest state. */
export const MACHINE_JOB_EVENT = "job";

/** The requests the web app makes (`POST /api/machines`). */
export const MACHINE_OPS = ["list", "config", "config-set", "install", "login", "cancel", "precheck", "add-ssh", "enroll-code"] as const;

/**
 * The requests a computer being enrolled makes through the core's `/runner-enroll/` routes:
 * the bootstrap script, the installer (its download token proves it holds the code), and
 * the enrollment exchange. They never come from `POST /api/machines`.
 */
export type EnrollRequest =
  | { readonly op: "enroll-bootstrap"; readonly shell: EnrollShell }
  | { readonly op: "enroll-script"; readonly label: string; readonly shell: EnrollShell; readonly token: string }
  /** `request`: the `RUNNER_ENROLL_REQUEST` frame the installer's first pass printed. */
  | { readonly op: "enroll-exchange"; readonly label: string; readonly token: string; readonly request: string };

export type MachineRequest =
  | EnrollRequest
  | { readonly op: "list" }
  | { readonly op: "config"; readonly machine: string }
  /** One key's new value as text, "" to unset it. */
  | { readonly op: "config-set"; readonly machine: string; readonly key: string; readonly value: string }
  /** `machine`: the host (`HOST_MACHINE`) or a runner's label. */
  | { readonly op: "install"; readonly machine: string; readonly tool: MachineTool }
  /** `replace`: replace that computer's earlier OmO device without asking. */
  | { readonly op: "login"; readonly machine: string; readonly replace: boolean }
  | { readonly op: "cancel"; readonly job: string }
  /** `label` "" derives one from the host name. */
  | { readonly op: "precheck"; readonly target: string; readonly label: string }
  | { readonly op: "add-ssh"; readonly target: string; readonly label: string }
  /** `address`: the new computer's private IP address on the LAN or Tailscale. */
  | { readonly op: "enroll-code"; readonly label: string; readonly address: string };

export type MachineOp = MachineRequest["op"];

/** What each request answers with. */
export type MachineResults = {
  readonly list: { readonly machines: readonly MachineRow[]; readonly jobs: readonly MachineJob[] };
  readonly config: { readonly config: RunnerConfigView };
  readonly "config-set": { readonly config: RunnerConfigView };
  readonly install: { readonly job: MachineJob };
  readonly login: { readonly job: MachineJob };
  readonly cancel: { readonly job: MachineJob };
  readonly precheck: { readonly precheck: RunnerPrecheck };
  readonly "add-ssh": { readonly job: MachineJob };
  readonly "enroll-code": { readonly enrollment: Enrollment };
  readonly "enroll-bootstrap": { readonly script: string };
  readonly "enroll-script": { readonly script: string };
  readonly "enroll-exchange": { readonly enrolled: string };
};

/** The answer to a request, or why it was refused; `refused` when a download token or code did not match. */
export type MachineReply<O extends MachineOp = MachineOp> =
  | ({ readonly ok: true } & MachineResults[O])
  | { readonly ok: false; readonly error: string; readonly refused?: boolean };
