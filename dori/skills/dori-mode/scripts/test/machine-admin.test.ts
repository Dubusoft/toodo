import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MachineJob, MachineReply } from "../../../../../src/lib/machines.ts";
import { MachineAdmin } from "../src/machine-admin.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A host whose PATH holds fake `hc` and `omo` scripts, each `omo` sub-command given as a shell body. */
const world = (omo: { readonly login?: string; readonly update?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "machine-admin-"));
  dirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("hc", 'if [ "$1" = "--version" ]; then echo "hc 0.1.22"; else echo "hc $*"; fi');
  script("omo", [
    'case "$1" in',
    '  --version) echo "omo 5.1.84 (engine: senpi 2026.11.23; scheme nodef)" ;;',
    `  login) ${omo.login ?? "exit 1"} ;;`,
    `  update) ${omo.update ?? "exit 1"} ;;`,
    "esac",
  ].join("\n"));
  const runnerDir = join(root, "runner");
  mkdirSync(runnerDir);
  const published: MachineJob[] = [];
  const waiters: { readonly match: (job: MachineJob) => boolean; readonly resolve: (job: MachineJob) => void }[] = [];
  const admin = new MachineAdmin({
    stateDir: join(root, "state"), guardMachines: {}, runnerDir, home: root, env: { PATH: `${bin}:/usr/bin:/bin` },
    run: async () => ({ code: 1, out: "", err: "no ssh in this test" }), now: () => Date.now(),
    observeTools: async () => { throw new Error("no worker in this test"); },
    publish: (job) => {
      published.push(job);
      for (const waiter of waiters.splice(0)) {
        if (waiter.match(job)) waiter.resolve(job);
        else waiters.push(waiter);
      }
    },
  });
  /** Resolves with the first published state of `id` that `match` takes, already published or still to come. */
  const next = (id: string, match: (job: MachineJob) => boolean) => new Promise<MachineJob>((resolve, reject) => {
    const seen = published.find((job) => job.id === id && match(job));
    if (seen) return resolve(seen);
    const timer = setTimeout(() => reject(new Error(`job ${id} never matched`)), 10_000);
    waiters.push({ match: (job) => job.id === id && match(job), resolve: (job) => { clearTimeout(timer); resolve(job); } });
  });
  return { admin, runnerDir, root, next };
};

const ok = <T extends MachineReply>(reply: T): Extract<T, { ok: true }> => {
  if (!reply.ok) throw new Error(reply.error);
  return reply as Extract<T, { ok: true }>;
};

test("lists the server host with hc's and omo's versions and its runner settings", async () => {
  const { admin } = world();
  const { machines, jobs } = ok(await admin.handle({ op: "list" }));
  expect(jobs).toEqual([]);
  expect(machines).toHaveLength(1);
  expect(machines[0]).toMatchObject({ label: "local", tools: { hc: "0.1.22", omo: "5.1.84" }, toolsError: null, config: true });
});

test("edits only the placement keys of the host's runner-config.json, and refuses the rest unwritten", async () => {
  const { admin, runnerDir, root } = world();
  const before = ok(await admin.handle({ op: "config", machine: "local" })).config;
  expect(before.present).toBe(false);
  expect(before.entries.find((e) => e.key === "reposRoot")?.access).toBe("edit");
  expect(before.entries.find((e) => e.key === "agents")?.access).toBe("readOnly");
  expect(before.entries.find((e) => e.key === "guard")?.access).toBe("readOnly");

  const repos = join(root, "repos");
  const after = ok(await admin.handle({ op: "config-set", machine: "local", key: "reposRoot", value: repos })).config;
  expect(after.present).toBe(true);
  expect(after.entries.find((e) => e.key === "reposRoot")?.value).toBe(repos);
  expect(JSON.parse(readFileSync(join(runnerDir, "runner-config.json"), "utf8"))).toEqual({ reposRoot: repos });

  for (const [key, value] of [["agents", '{"default":["sh"]}'], ["guard", '{"panesMax":2}'], ["allowedRoots", "/"], ["nope", "x"]] as const) {
    const refused = await admin.handle({ op: "config-set", machine: "local", key, value });
    expect(refused.ok).toBe(false);
  }
  expect(JSON.parse(readFileSync(join(runnerDir, "runner-config.json"), "utf8"))).toEqual({ reposRoot: repos });
  const remote = await admin.handle({ op: "config", machine: "mac-mini" });
  expect(remote).toEqual({ ok: false, error: "the host has no ssh target for mac-mini, so its runner-config.json is changed on that machine (dori runner setup)" });
});

test("updates an installed omo as a job whose output and new version are published", async () => {
  const { admin, next } = world({ update: 'echo "downloading omo"; echo "omo updated"' });
  const started = ok(await admin.handle({ op: "install", tool: "omo" })).job;
  expect(started).toMatchObject({ kind: "install", tool: "omo", state: "running", command: "omo update" });
  const done = await next(started.id, (job) => job.state !== "running");
  expect(done).toMatchObject({ state: "succeeded", exitCode: 0, version: "5.1.84" });
  expect(done.log).toBe("$ omo update\ndownloading omo\nomo updated\n");
  expect(ok(await admin.handle({ op: "list" })).jobs.map((job) => job.id)).toEqual([started.id]);
});

test("shows omo login's device code while it waits for approval, and stops it on cancel", async () => {
  const { admin, next } = world({
    login: 'echo "Open https://signin.omo.dev/device?code=TWJM-QTWV"; echo "User code: TWJM-QTWV"; echo "Matching code: 932 514"; exec sleep 30',
  });
  const started = ok(await admin.handle({ op: "login", replace: true })).job;
  expect(started.command).toBe("omo login --no-browser --replace");
  const waiting = await next(started.id, (job) => job.device !== null);
  expect(waiting.device).toEqual({ url: "https://signin.omo.dev/device?code=TWJM-QTWV", userCode: "TWJM-QTWV", matchingCode: "932 514" });
  expect((await admin.handle({ op: "login", replace: false })).ok).toBe(false);
  ok(await admin.handle({ op: "cancel", job: started.id }));
  expect(await next(started.id, (job) => job.state !== "running")).toMatchObject({ state: "cancelled" });
});
