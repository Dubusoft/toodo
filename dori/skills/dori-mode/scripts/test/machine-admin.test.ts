import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MachineJob, MachineReply } from "../../../../../src/lib/machines.ts";
import { MachineAdmin } from "../src/machine-admin.ts";
import { RunnerToolJobs } from "../src/runner/tool-jobs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * omo's RPC mode as a Claude sign-in meets it: the first `login_start` is cancelled because the session was still
 * starting, the next one asks for the account name, the login method, then the code, and only `the-code` signs in.
 * Every answer it gets is noted in `$FAKE_RPC_LOG`.
 */
const FAKE_RPC = `
import { appendFileSync } from "node:fs";
const out = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const provider = "anthropic-subscription";
let starts = 0;
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const f = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (f.type === "get_auth_providers") out({ id: f.id, type: "response", command: f.type, success: true, data: { providers: [] } });
    else if (f.type === "login_start") {
      out({ id: f.id, type: "response", command: f.type, success: true });
      starts += 1;
      if (starts === 1) out({ type: "auth_login_end", provider, success: false, error: "Extension UI request cancelled: session closed" });
      else out({ type: "extension_ui_request", id: "name", method: "input", title: "Name for this account (existing: default; press Enter to add account-2, or type an existing name to refresh it)" });
    } else if (f.type === "login_cancel") out({ type: "auth_login_end", provider, success: false, error: "Login cancelled" });
    else if (f.type === "extension_ui_response") {
      appendFileSync(process.env.FAKE_RPC_LOG, f.id + "=" + f.value + "\\n");
      if (f.id === "name") out({ type: "extension_ui_request", id: "method", method: "select", title: "Select Anthropic login method:", options: ["Browser login (default)", "Copy code login (headless)"] });
      else if (f.id === "method") {
        out({ type: "auth_login_url", provider, url: "https://claude.com/cai/oauth/authorize?code=true" });
        out({ type: "extension_ui_request", id: "code", method: "input", title: "Paste the code Anthropic shows after you sign in:" });
      } else if (f.id === "code") {
        out(f.value === "the-code"
          ? { type: "auth_login_end", provider, success: true, account: { name: "default" }, check: { model: "m", outcome: "ok", at: 1 } }
          : { type: "auth_login_end", provider, success: false, error: "invalid code" });
      }
    }
  }
}
`;

/**
 * A host whose PATH holds fake `hc` and `omo` scripts (`omo update` given as a shell body, `omo auth check` with a
 * signed-in Claude account and no Codex one, `omo --mode rpc` the FAKE_RPC sign-in), and a runner `mac-mini` whose
 * tool jobs run with the same scripts.
 */
const world = (omo: { readonly update?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "machine-admin-"));
  dirs.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script("hc", 'if [ "$1" = "--version" ]; then echo "hc 0.1.22"; else echo "hc $*"; fi');
  writeFileSync(join(root, "rpc.mjs"), FAKE_RPC);
  script("omo", [
    'case "$1" in',
    '  --version) echo "omo 5.1.84 (engine: senpi 2026.11.23; scheme nodef)" ;;',
    `  --mode) exec "${process.execPath}" "${join(root, "rpc.mjs")}" ;;`,
    `  update) ${omo.update ?? "exit 1"} ;;`,
    '  auth) case "$4" in',
    `    anthropic-subscription) echo '{"status":"not_ready","provider":"anthropic-subscription","reason":"provider_not_found","accounts":[{"name":"default","signIn":"signed_in"}]}' ;;`,
    `    *) echo '{"status":"not_ready","provider":"chatgpt-subscription","reason":"credentials_not_configured","accounts":[]}' ;;`,
    "  esac ;;",
    "esac",
  ].join("\n"));
  const runnerDir = join(root, "runner");
  mkdirSync(runnerDir);
  const published: MachineJob[] = [];
  const waiters: { readonly match: (job: MachineJob) => boolean; readonly resolve: (job: MachineJob) => void }[] = [];
  const rpcLog = join(root, "rpc.log");
  const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_RPC_LOG: rpcLog };
  const runnerJobs = new RunnerToolJobs({ env, home: root, platform: "darwin" });
  const admin = new MachineAdmin({
    stateDir: join(root, "state"), guardMachines: {}, runnerDir, home: root, env,
    run: async () => ({ code: 1, out: "", err: "no ssh in this test" }), now: () => Date.now(), agentCommand: [],
    runners: {
      observeMachine: async () => ({
        os: "darwin", sampledAt: 0, sample: {} as never, panes: [], tools: { hc: "0.1.22", omo: "5.1.84" }, toolJobs: true,
        logins: { claude: { signedIn: true, accounts: 1 }, codex: { signedIn: false, accounts: 0 } },
      }),
      toolJob: async (_machine, body) => (await runnerJobs.start(body)).result,
      toolJobState: async (_machine, job) => runnerJobs.read(job),
      toolAnswer: async (_machine, job, value) => { runnerJobs.answer(job, value); },
      toolCancel: async (_machine, job) => { runnerJobs.cancel(job); },
    },
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
  const answers = (): string => { try { return readFileSync(rpcLog, "utf8"); } catch { return ""; } };
  return { admin, runnerDir, root, next, answers };
};

const ok = <T extends MachineReply>(reply: T): Extract<T, { ok: true }> => {
  if (!reply.ok) throw new Error(reply.error);
  return reply as Extract<T, { ok: true }>;
};

test("lists the server host with hc's and omo's versions, its Claude and Codex sign-ins and its runner settings", async () => {
  const { admin } = world();
  const { machines, jobs } = ok(await admin.handle({ op: "list" }));
  expect(jobs).toEqual([]);
  expect(machines).toHaveLength(1);
  expect(machines[0]).toMatchObject({
    label: "local", tools: { hc: "0.1.22", omo: "5.1.84" }, toolsError: null, config: true,
    logins: { claude: { signedIn: true, accounts: 1 }, codex: { signedIn: false, accounts: 0 } },
  });
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
  const started = ok(await admin.handle({ op: "install", machine: "local", tool: "omo" })).job;
  expect(started).toMatchObject({ kind: "install", tool: "omo", machine: "local", state: "running", command: "omo update" });
  const done = await next(started.id, (job) => job.state !== "running");
  expect(done).toMatchObject({ state: "succeeded", exitCode: 0, version: "5.1.84" });
  expect(done.log).toBe("$ omo update\ndownloading omo\nomo updated\n");
  expect(ok(await admin.handle({ op: "list" })).jobs.map((job) => job.id)).toEqual([started.id]);
});

test("signs Claude in inside omo: shows its sign-in page, passes the pasted code to omo alone, and ends signed in", async () => {
  const { admin, next, answers } = world();
  const started = ok(await admin.handle({ op: "login", machine: "local", provider: "claude" })).job;
  expect(started).toMatchObject({
    kind: "login", tool: "omo", provider: "claude", state: "running", command: "omo --mode rpc (sign in anthropic-subscription)",
    signIn: { url: null, ask: null },
  });
  expect((await admin.handle({ op: "login-answer", job: started.id, value: "too-early" })).ok).toBe(false);
  const waiting = await next(started.id, (job) => job.signIn?.ask != null);
  expect(waiting.signIn).toEqual({ url: "https://claude.com/cai/oauth/authorize?code=true", ask: "Paste the code Anthropic shows after you sign in:" });
  // The existing account is signed in again through the copy-code login, after omo's restarted session.
  expect(answers()).toBe("name=default\nmethod=Copy code login (headless)\n");
  expect((await admin.handle({ op: "login", machine: "local", provider: "codex" })).ok).toBe(false);
  ok(await admin.handle({ op: "login-answer", job: started.id, value: " the-code " }));
  const done = await next(started.id, (job) => job.state !== "running");
  expect(done).toMatchObject({ state: "succeeded", signIn: null });
  expect(answers()).toEndWith("code=the-code\n");
  expect(done.log).toContain("Signed in as account default; connection test ok.");
  expect(done.log).not.toContain("the-code");
});

test("runs a runner's sign-in and update through that runner, following its sign-in page, answer and end", async () => {
  const { admin, next, answers } = world({ update: 'echo "downloading omo"; echo "omo updated"' });
  const login = ok(await admin.handle({ op: "login", machine: "mac-mini", provider: "claude" })).job;
  expect(login).toMatchObject({ kind: "login", tool: "omo", provider: "claude", machine: "mac-mini", state: "running" });
  const waiting = await next(login.id, (job) => job.signIn?.ask != null);
  expect(waiting.signIn?.url).toBe("https://claude.com/cai/oauth/authorize?code=true");
  expect((await admin.handle({ op: "install", machine: "mac-mini", tool: "omo" })).ok).toBe(false);
  ok(await admin.handle({ op: "login-answer", job: login.id, value: "wrong" }));
  const failed = await next(login.id, (job) => job.state !== "running");
  expect(failed).toMatchObject({ state: "failed", signIn: null });
  expect(failed.log).toContain("invalid code");
  expect(answers()).toEndWith("code=wrong\n");

  const again = ok(await admin.handle({ op: "login", machine: "mac-mini", provider: "claude" })).job;
  await next(again.id, (job) => job.signIn?.ask != null);
  ok(await admin.handle({ op: "cancel", job: again.id }));
  expect(await next(again.id, (job) => job.state !== "running")).toMatchObject({ state: "cancelled" });

  const update = ok(await admin.handle({ op: "install", machine: "mac-mini", tool: "omo" })).job;
  expect(update.command).toBe("omo update");
  const done = await next(update.id, (job) => job.state !== "running");
  expect(done).toMatchObject({ machine: "mac-mini", state: "succeeded", exitCode: 0, version: "5.1.84" });
  expect(done.log).toBe("$ omo update\ndownloading omo\nomo updated\n");
});
