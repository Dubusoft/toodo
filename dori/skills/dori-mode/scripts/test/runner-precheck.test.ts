import { describe, expect, test } from "bun:test";

import type { Ran, Runner } from "../src/run.ts";
import { installProblem, PRECHECK_PROBE, precheckRunner } from "../src/runner/precheck.ts";

/** An ssh that answers the shell probes and the pre-check probe as a machine with `system`, `hc` and `bun` would. */
const ssh = (machine: { readonly system?: string; readonly hc?: boolean; readonly bun?: boolean; readonly down?: boolean; readonly noShell?: boolean }): Runner =>
  async (argv, opts = {}): Promise<Ran> => {
    if (machine.down) return { code: 255, out: "", err: "ssh: connect to host 192.168.1.20 port 22: Connection refused" };
    const command = argv.at(-1) ?? "";
    if (machine.noShell) return { code: 127, out: "", err: "not a shell" };
    if (command.includes("DORI_POSIX_")) return { code: 0, out: "DORI_POSIX_42\n", err: "" };
    if (command === "uname -s") return { code: 0, out: `${machine.system ?? "Linux"}\n`, err: "" };
    if (command === "sh -s" && opts.stdin === PRECHECK_PROBE) {
      return { code: 0, out: `DORI_OS=${machine.system ?? "Linux"}\nDORI_HC=${machine.hc ? "yes" : "no"}\nDORI_BUN=${machine.bun ? "yes" : "no"}\n`, err: "" };
    }
    return { code: 1, out: "", err: `unexpected ${command}` };
  };

const deps = (run: Runner, guardMachines: Record<string, string> = {}, address = "192.168.1.20") => ({
  run, stateDir: "/nonexistent-state", guardMachines, resolve: async () => address,
});

describe("precheckRunner", () => {
  test("passes a Linux machine with hc and bun, deriving the label from the host", async () => {
    const result = await precheckRunner(deps(ssh({ hc: true, bun: true })), { target: "me@build-box", label: "" });
    expect(result).toEqual({ target: "me@build-box", label: "build-box", os: "linux", listen: "192.168.1.20:7411", problems: [] });
  });

  test("names what a Linux machine lacks, and does not ask a Mac for bun", async () => {
    const linux = await precheckRunner(deps(ssh({})), { target: "me@linux-box", label: "linux" });
    expect(linux.problems.map((p) => p.code)).toEqual(["no-hc", "no-bun"]);
    const mac = await precheckRunner(deps(ssh({ system: "Darwin", hc: true })), { target: "me@mac-box", label: "mac" });
    expect(mac).toMatchObject({ os: "darwin", problems: [] });
  });

  test("reports an unreachable host, a machine with no shell it knows, and another system", async () => {
    const down = await precheckRunner(deps(ssh({ down: true })), { target: "me@down-box", label: "down" });
    expect(down.problems).toEqual([{ code: "unreachable", detail: "unreachable: ssh: connect to host 192.168.1.20 port 22: Connection refused" }]);
    const odd = await precheckRunner(deps(ssh({ noShell: true })), { target: "me@odd-box", label: "odd" });
    expect(odd.problems.map((p) => p.code)).toEqual(["unsupported"]);
    const bsd = await precheckRunner(deps(ssh({ system: "FreeBSD", hc: true, bun: true })), { target: "me@bsd-box", label: "bsd" });
    expect(bsd.problems.map((p) => p.code)).toEqual(["unsupported"]);
  });

  test("refuses a public address, a malformed target or label, and a label another machine has", async () => {
    const public_ = await precheckRunner(deps(ssh({ hc: true, bun: true }), {}, "8.8.8.8"), { target: "me@far-box", label: "far" });
    expect(public_.problems.map((p) => p.code)).toEqual(["not-private"]);
    expect(public_.listen).toBeNull();
    const run: Runner = async () => { throw new Error("no ssh for a refused input"); };
    expect((await precheckRunner(deps(run), { target: "-oProxyCommand=id", label: "x" })).problems.map((p) => p.code)).toEqual(["target-invalid"]);
    expect((await precheckRunner(deps(run), { target: "me@box", label: "no spaces" })).problems.map((p) => p.code)).toEqual(["label-invalid"]);
    expect((await precheckRunner(deps(run), { target: "me@box", label: "local" })).problems.map((p) => p.code)).toEqual(["label-invalid"]);
    const taken = await precheckRunner(deps(run, { mini: "me@other-box" }), { target: "me@box", label: "mini" });
    expect(taken.problems).toEqual([{ code: "label-taken", detail: "mini is already the machine at me@other-box" }]);
  });
});

test("installProblem reads the failure dori runner install printed last", () => {
  expect(installProblem("RUNNER_STEP runner=x connect start\nRUNNER_INSTALL_NO_HC runner=x no hc on the remote host's login PATH")).toBe("no-hc");
  expect(installProblem("RUNNER_INSTALL_UNREACHABLE runner=x unreachable: timeout")).toBe("unreachable");
  expect(installProblem("RUNNER_LISTEN_REFUSED far resolved to 8.8.8.8, which is not private")).toBe("not-private");
  expect(installProblem("error: something else")).toBe("install-failed");
});
