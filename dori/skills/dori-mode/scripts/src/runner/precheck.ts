// The checks Settings > Machines & accounts runs before it installs a runner over ssh (machine-admin.ts): that the target
// and label are well formed, that the label is not another machine's, that the target resolves to a private address the
// supervisor can dial, that ssh reaches it and which system it runs, and that what `dori runner install` needs there is
// present: hc on the login PATH (Linux and macOS), bun on the ssh PATH (Linux; macOS downloads it, Windows gets a pinned
// build). Each failure is a RunnerProblem the web app explains in plain words.

import { HOST_MACHINE, type RunnerPrecheck, type RunnerProblem, type RunnerProblemCode } from "../../../../../../src/lib/machines.ts";
import { listGuardMachines, machineKind, sshArgv } from "../remote-guard.ts";
import { RUN_TIMEOUT_CODE, type Runner } from "../run.ts";
import { runnerListenAddress } from "./endpoints.ts";
import { labelFromHost, parseInstallTarget } from "./machines.ts";
import { LABEL_PATTERN } from "./protocol.ts";

const PROBE_TIMEOUT_MS = 20_000;

/**
 * What the POSIX probe prints: the system, and whether hc is on the login shell's PATH (read the way the install script
 * reads it) and bun on the ssh command's own PATH.
 */
export const PRECHECK_PROBE = [
  "printf 'DORI_OS=%s\\n' \"$(uname -s)\"",
  "SH=${SHELL:-/bin/sh}",
  String.raw`LP=$("$SH" -lc 'printf "\nDORI_LOGIN_PATH=%s\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^DORI_LOGIN_PATH=//p' | tail -n 1)`,
  '[ -n "$LP" ] || LP=$PATH',
  'if (PATH="$LP:$PATH"; command -v hc) >/dev/null 2>&1; then echo DORI_HC=yes; else echo DORI_HC=no; fi',
  "if command -v bun >/dev/null 2>&1; then echo DORI_BUN=yes; else echo DORI_BUN=no; fi",
  "",
].join("\n");

export type PrecheckDeps = {
  readonly run: Runner;
  readonly stateDir: string;
  readonly guardMachines: Readonly<Record<string, string>>;
  /** Resolves a host name to an address (default: the system resolver). */
  readonly resolve?: (host: string) => Promise<string>;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const precheckRunner = async (deps: PrecheckDeps, input: { readonly target: string; readonly label: string }): Promise<RunnerPrecheck> => {
  const target = input.target.trim();
  const problems: RunnerProblem[] = [];
  const problem = (code: RunnerProblemCode, detail: string): void => { problems.push({ code, detail }); };
  const answer = (label: string, os: string | null, listen: string | null): RunnerPrecheck => ({ target, label, os, listen, problems });

  let host: string;
  try {
    host = parseInstallTarget(target).host;
  } catch (e) {
    problem("target-invalid", errorText(e));
    return answer(input.label.trim(), null, null);
  }
  let label = input.label.trim();
  if (label === "") {
    try { label = labelFromHost(host); } catch (e) { problem("label-invalid", errorText(e)); }
  } else if (!LABEL_PATTERN.test(label)) problem("label-invalid", `${label} is not a label: letters, digits, dot, dash and underscore`);
  if (label === HOST_MACHINE) problem("label-invalid", `${HOST_MACHINE} is the server host's own runner`);
  const other = listGuardMachines(deps.guardMachines, deps.stateDir).find((m) => m.label === label && m.target !== target);
  if (other) problem("label-taken", `${label} is already the machine at ${other.target}`);
  if (problems.length) return answer(label, null, null);

  let listen: string | null = null;
  try {
    listen = await runnerListenAddress(target, deps.resolve);
  } catch (e) {
    problem("not-private", errorText(e));
  }

  const kind = await machineKind(deps.run, { label, target }, PROBE_TIMEOUT_MS);
  if (!kind.ok) {
    problem(kind.unsupported ? "unsupported" : "unreachable", kind.detail);
    return answer(label, null, listen);
  }
  if (kind.kind === "windows") return answer(label, "windows", listen);

  const probe = await deps.run(sshArgv(target, "sh -s"), { stdin: PRECHECK_PROBE, timeoutMs: PROBE_TIMEOUT_MS });
  if (probe.timedOut || probe.code === RUN_TIMEOUT_CODE || probe.code === 255) {
    problem("unreachable", probe.err.trim().split("\n").at(-1) || `ssh exit ${probe.code}`);
    return answer(label, null, listen);
  }
  const value = (key: string): string | undefined => new RegExp(`^${key}=(.*)$`, "m").exec(probe.out)?.[1]?.trim();
  const system = value("DORI_OS") ?? "";
  const os = system === "Linux" ? "linux" : system === "Darwin" ? "darwin" : null;
  if (os === null) {
    problem("unsupported", `the machine runs ${system || "an unknown system"}; a runner takes Linux, macOS or Windows`);
    return answer(label, system || null, listen);
  }
  if (value("DORI_HC") !== "yes") problem("no-hc", "hc is not on the login PATH there");
  if (os === "linux" && value("DORI_BUN") !== "yes") problem("no-bun", "bun is not on the PATH there");
  return answer(label, os, listen);
};

/** The problem a failed `dori runner install` names in its output (its last `RUNNER_INSTALL_*` or listen failure), or `install-failed`. */
export const installProblem = (output: string): RunnerProblemCode => {
  const codes = [...output.matchAll(/\b(RUNNER_INSTALL_[A-Z_]+|RUNNER_LISTEN_[A-Z_]+|RUNNER_TARGET_INVALID|RUNNER_LABEL_INVALID)\b/g)].map((m) => m[1]);
  switch (codes.at(-1)) {
    case "RUNNER_INSTALL_UNREACHABLE": return "unreachable";
    case "RUNNER_INSTALL_UNSUPPORTED": return "unsupported";
    case "RUNNER_INSTALL_NO_BUN": return "no-bun";
    case "RUNNER_INSTALL_NO_HC": return "no-hc";
    case "RUNNER_INSTALL_ENROLL_FAILED": return "enroll-failed";
    case "RUNNER_LISTEN_REFUSED":
    case "RUNNER_LISTEN_RESOLVE_FAILED": return "not-private";
    case "RUNNER_TARGET_INVALID": return "target-invalid";
    case "RUNNER_LABEL_INVALID": return "label-invalid";
    default: return "install-failed";
  }
};
