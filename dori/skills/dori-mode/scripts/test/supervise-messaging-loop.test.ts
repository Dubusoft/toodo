import { afterEach, expect, test } from "bun:test";
import { sdNotify, supervise } from "../src/supervise-loop.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

/** The local runner child supervise() starts: here one that runs nothing and exits when killed. */
const idleRunner = () => {
  let exit = (_code: number) => {};
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  return { pid: 4242, exited, kill: () => { exit(0); } };
};


const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test("the production loop tells systemd READY, then pets the watchdog after a pass", async () => {
  const state = withState();
  cleanups.push(state.done);
  const home = process.env.HOME;
  const socket = process.env.NOTIFY_SOCKET;
  process.env.HOME = state.dir;
  delete process.env.NOTIFY_SOCKET;
  cleanups.push(() => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (socket === undefined) delete process.env.NOTIFY_SOCKET; else process.env.NOTIFY_SOCKET = socket;
  });
  const world = newWorld();
  world.panes.push({ pane_id: "hc:t1", workspace_id: "test", agent: "omo", agent_status: "working" });
  const base = depsFor(world, fakeClock(1_800_000_000_000), state.dir);
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => argv[0] === "df"
      ? { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/x 1 1 209715200", err: "" }
      : base.run(argv),
  };
  const notified: string[] = [];
  const controller = new AbortController();
  await supervise(deps, controller.signal, { spawnRunner: idleRunner }, async (state) => {
    notified.push(state);
    if (state === "WATCHDOG=1") controller.abort();
    return true;
  });
  expect(notified[0]).toBe("READY=1");
  expect(notified).toContain("WATCHDOG=1");
});

test("READY and watchdog notifications retain their bounded systemd transport", async () => {
  // Given an enabled notify socket and an observable runner.
  const calls: { argv: readonly string[]; timeoutMs?: number }[] = [];
  // When both existing service notifications run.
  for (const state of ["READY=1", "WATCHDOG=1"]) {
    expect(await sdNotify(state, { NOTIFY_SOCKET: "/test/notify" }, async (argv, options) => {
      calls.push({ argv, timeoutMs: options?.timeoutMs });
      return { code: 0, out: "", err: "" };
    })).toBe(true);
  }
  // Then they still use the same pid and 5-second subprocess deadline.
  expect(calls).toEqual([
    { argv: ["systemd-notify", `--pid=${process.pid}`, "READY=1"], timeoutMs: 5_000 },
    { argv: ["systemd-notify", `--pid=${process.pid}`, "WATCHDOG=1"], timeoutMs: 5_000 },
  ]);
});
