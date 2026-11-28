// The jobs that install or update the tools a Dori host needs (hc, omo), as Settings > Machines & accounts starts
// them: the command each one runs, and the process that runs it with its output masked and kept as it arrives (the
// sign-in of omo's agent accounts is provider-login.ts). The supervisor runs them on its own host (machine-admin.ts) and a runner on its host (runner/tool-jobs.ts,
// `tool.job`), so both run the same commands the same way. omo is updated only by its own `omo update`.
import { join } from "node:path";

import { redactSecrets } from "./redact.ts";
import type { Ran, Runner } from "./run.ts";
import { hcInstallCommand } from "./runtime/hc.ts";

export type Tool = "hc" | "omo";
/** `install` installs a missing tool or updates an installed one; `login` signs an agent account in inside omo (provider-login.ts). */
export type ToolJobKind = "install" | "login";
export type ToolJobState = "running" | "succeeded" | "failed" | "cancelled";

/** omo's one-line installer (into ~/.local/bin, checked against the release SHA256SUMS). */
export const OMO_INSTALL_URL = "https://get.omo.dev/install.sh";

export const TOOL_INSTALL_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 10_000;

/** `env` with ~/.local/bin, where hc and omo install, on its PATH and HOME set to `home`. */
export const withLocalBin = (env: Readonly<Record<string, string | undefined>>, home: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  const bin = join(home, ".local", "bin");
  const path = out.PATH ?? "";
  if (!path.split(":").includes(bin)) out.PATH = path ? `${bin}:${path}` : bin;
  out.HOME = home;
  return out;
};

/** A Runner over Bun.spawn in `env` (the shared run.ts Runner takes the process's own environment). */
export const envRunner = (env: Record<string, string>): Runner => async (argv, opts = {}): Promise<Ran> => {
  const proc = Bun.spawn([...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  const timer = setTimeout(() => { proc.kill(); }, opts.timeoutMs ?? VERSION_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  } finally {
    clearTimeout(timer);
  }
};

/** What an install job runs: its argv, the command line its log opens with, and how long it may take. */
export type ToolCommand = { readonly argv: readonly string[]; readonly command: string; readonly timeoutMs: number };

/** The command of an install job: hc's installer or `hc update`, omo's installer or `omo update`. */
export const installCommand = (tool: Tool, installed: boolean): ToolCommand => {
  const argv = tool === "hc"
    ? hcInstallCommand(installed)
    : installed ? ["omo", "update"] : ["sh", "-c", `curl -fsSL ${OMO_INSTALL_URL} | bash`];
  return { argv, command: argv[0] === "sh" ? argv[2]! : argv.join(" "), timeoutMs: TOOL_INSTALL_TIMEOUT_MS };
};

/** Why a host cannot run tool jobs, or undefined when it can: the installers are POSIX shell scripts. */
export const toolJobsUnsupported = (platform: NodeJS.Platform): string | undefined =>
  platform === "win32" ? "hc and omo are installed and updated on a Windows computer itself, not from Toodo" : undefined;

/** A job's log so far: its command line and its output, credentials masked, cut to its last `limit` characters. */
export const jobLog = (command: string, output: string, limit: number): string => {
  const log = redactSecrets(`$ ${command}\n${output}`);
  return log.length > limit ? log.slice(-limit) : log;
};

export type StreamedJobEnd = { readonly exitCode: number; readonly output: string; readonly cancelled: boolean };

/**
 * Starts `argv` in `cwd` and `env`, killed after `timeoutMs` or by the returned `kill` (then it ends `cancelled`). Each
 * chunk of its stdout or stderr calls `onOutput` with all the output so far; `onEnd` runs once when it exits, after
 * both streams are read. A stream that fails to read still lets the job end, with the failure in its output.
 */
export const runStreamedJob = (opts: {
  readonly argv: readonly string[]; readonly env: Record<string, string>; readonly cwd: string; readonly timeoutMs: number;
  readonly onOutput: (output: string) => void; readonly onEnd: (end: StreamedJobEnd) => void;
}): { readonly kill: () => void } => {
  const proc = Bun.spawn([...opts.argv], { env: opts.env, cwd: opts.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let cancelled = false;
  let output = "";
  const read = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      opts.onOutput(output);
    }
  };
  const timer = setTimeout(() => { proc.kill(); }, opts.timeoutMs);
  void (async () => {
    const reads = await Promise.allSettled([read(proc.stdout), read(proc.stderr)]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    for (const r of reads) if (r.status === "rejected") output += `\n${r.reason instanceof Error ? r.reason.message : String(r.reason)}\n`;
    opts.onEnd({ exitCode, output, cancelled });
  })();
  return { kill: () => { cancelled = true; proc.kill(); } };
};
