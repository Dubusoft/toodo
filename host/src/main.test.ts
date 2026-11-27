import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Host, type HostOptions, type HostStatus, parseListen, parseSupervisorSwitch, startHost } from "./main.ts";

const fixture = (name: string) => new URL(`./fixtures/${name}.ts`, import.meta.url);

const FAST = {
  heartbeatIntervalMs: 50, heartbeatTimeoutMs: 300, backoffBaseMs: 20, backoffMaxMs: 100,
  stableAfterMs: 60_000, breakerThreshold: 100, breakerWindowMs: 60_000, breakerCooldownMs: 60_000, stopDeadlineMs: 1_000,
};

let running: Host | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** Starts a host on a free loopback port; `next(pattern)` resolves on the first log line from now on that matches. */
const launch = (supervisor: HostOptions["supervisor"]) => {
  const lines: string[] = [];
  const waiters: { pattern: RegExp; resolve: (line: string) => void }[] = [];
  const log = (line: string) => {
    lines.push(line);
    for (const waiter of waiters.filter((w) => w.pattern.test(line))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(line);
    }
  };
  const next = (pattern: RegExp, timeoutMs = 5_000) => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`no log line matching ${pattern} in ${timeoutMs} ms; got:\n${lines.join("\n")}`)); }, timeoutMs);
    waiters.push({ pattern, resolve: (line) => { clearTimeout(timer); resolve(line); } });
  });
  const firstReady = next(/^HOST_SUPERVISOR_READY start=1$/);
  const firstFailure = next(/^HOST_SUPERVISOR_FAILED start=1 /);
  const restarted = next(/^HOST_SUPERVISOR_STARTED start=2$/);
  running = startHost({ listen: { hostname: "127.0.0.1", port: 0 }, core: () => new Response("core"), supervisor, tunables: FAST, log });
  return { host: running, lines, next, firstReady, firstFailure, restarted };
};

const coreStatus = async (host: Host) => (await fetch(new URL("/api/rpc", host.url))).status;

const hostReply = async (host: Host) => {
  const reply = await fetch(new URL("/api/host", host.url));
  return { status: reply.status, body: (await reply.json()) as HostStatus };
};

describe("startHost", () => {
  test("safe mode serves the core and starts no Worker", async () => {
    const { host, lines } = launch("off");
    expect(await hostReply(host)).toEqual({ status: 200, body: { supervisor: { state: "off" } } });
    expect(await coreStatus(host)).toBe(200);
    expect(lines.some((line) => line.startsWith("HOST_SAFE_MODE"))).toBe(true);
  });

  for (const fault of ["throw", "reject", "loop", "exit"]) {
    test(`the core keeps answering while the Worker fails by ${fault} and the Worker is restarted`, async () => {
      const { host, firstReady, firstFailure, restarted } = launch(fixture(`worker-${fault}`));
      await firstReady;
      expect(await coreStatus(host)).toBe(200);
      const failure = await firstFailure;
      expect(await coreStatus(host)).toBe(200);
      await restarted;
      expect(await coreStatus(host)).toBe(200);
      if (fault === "loop") expect(failure).toContain("no heartbeat for");
      if (fault === "exit") expect(failure).toContain("exited with code 7");
    });
  }

  test("the core keeps answering while the Worker crashes at start", async () => {
    const { host, firstFailure, restarted } = launch(fixture("worker-start-crash"));
    expect(await coreStatus(host)).toBe(200);
    expect(await firstFailure).toContain("injected crash at start");
    await restarted;
    expect(await coreStatus(host)).toBe(200);
  });

  test("reload replaces only the Worker, with the code on disk now", async () => {
    const dir = await mkdtemp(join(tmpdir(), "toodo-host-"));
    try {
      const entry = join(dir, "worker.ts");
      const helper = fixture("fault-worker").pathname;
      await writeFile(entry, `import { runFaultWorker } from ${JSON.stringify(helper)};\nrunFaultWorker("none");\n`);
      const { host, next, firstReady } = launch(entry);
      await firstReady;
      expect(await hostReply(host)).toMatchObject({ status: 200, body: { supervisor: { state: "running", starts: 1 } } });
      const server = host.url.href;
      await writeFile(entry, `throw new Error("version 2 loaded");\n`);
      const stopped = next(/^HOST_SUPERVISOR_STOPPED start=1$/);
      const failed = next(/^HOST_SUPERVISOR_FAILED start=2 /);
      await host.reloadSupervisor();
      await stopped;
      expect(await failed).toContain("version 2 loaded");
      const after = await hostReply(host);
      expect(after.status).toBe(200);
      expect("starts" in after.body.supervisor && after.body.supervisor.starts).toBeGreaterThanOrEqual(2);
      expect(host.url.href).toBe(server);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("environment", () => {
  test("TOODO_LISTEN takes HOST:PORT with IPv6 hosts in brackets", () => {
    expect(parseListen("127.0.0.1:47616")).toEqual({ hostname: "127.0.0.1", port: 47616 });
    expect(parseListen("[::1]:8080")).toEqual({ hostname: "::1", port: 8080 });
    expect(() => parseListen("47616")).toThrow("TOODO_LISTEN must be HOST:PORT");
    expect(() => parseListen("localhost:70000")).toThrow("TOODO_LISTEN must be HOST:PORT");
  });

  test("TOODO_SUPERVISOR is on unless set to off", () => {
    expect(parseSupervisorSwitch(undefined)).toBe("on");
    expect(parseSupervisorSwitch("on")).toBe("on");
    expect(parseSupervisorSwitch("off")).toBe("off");
    expect(() => parseSupervisorSwitch("0")).toThrow("TOODO_SUPERVISOR must be on or off");
  });
});
