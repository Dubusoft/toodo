import { afterEach, describe, expect, test } from "bun:test";

import type { MachineJob, MachineReply, MachineRequest } from "../../../src/lib/machines.ts";
import { AGENT, startTestServer, type TestServer, WEB } from "./http-fixtures.ts";
import { type MachineBridge, MachineJobFeed } from "./machines.ts";

let servers: TestServer[] = [];

async function start(options: { machines?: MachineBridge; machineJobs?: MachineJobFeed } = {}): Promise<TestServer> {
  const server = await startTestServer(options);
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

const job: MachineJob = {
  id: "job-1", kind: "install", tool: "hc", provider: null, machine: "local", state: "running", command: "hc update", startedAt: 1, endedAt: null,
  log: "$ hc update\n", exitCode: null, version: null, signIn: null, problem: null,
};

describe("machines", () => {
  test("hands each request to the supervisor behind the web token and answers with its reply", async () => {
    const seen: MachineRequest[] = [];
    const server = await start({
      machines: async (request): Promise<MachineReply> => {
        seen.push(request);
        if (request.op === "config-set" && request.key === "agents") return { ok: false, error: "agents is changed only on that machine (dori runner setup)" };
        if (request.op === "install") return { ok: true, job };
        return { ok: true, machines: [], jobs: [] };
      },
    });
    expect((await server.fetch("GET", "/api/machines")).status).toBe(401);
    expect((await server.fetch("GET", "/api/machines", { token: AGENT })).status).toBe(401);

    expect(await server.send("GET", "/api/machines", WEB, undefined)).toEqual({ status: 200, body: { ok: true, machines: [], jobs: [] } });
    expect((await server.send("GET", "/api/machines/mac-mini/config", WEB, undefined)).status).toBe(200);
    expect(await server.send("POST", "/api/machines", WEB, { op: "install", machine: "local", tool: "hc" })).toEqual({ status: 200, body: { ok: true, job } });
    const refused = await server.send("POST", "/api/machines", WEB, { op: "config-set", machine: "local", key: "agents", value: "{}" });
    expect(refused).toEqual({ status: 400, body: { ok: false, error: "agents is changed only on that machine (dori runner setup)" } });
    expect((await server.send("POST", "/api/machines", WEB, { op: "login", machine: "mac-mini", provider: "codex" })).status).toBe(200);
    expect((await server.send("POST", "/api/machines", WEB, { op: "login-answer", job: "job-1", value: "code" })).status).toBe(200);
    expect(seen).toEqual([
      { op: "list" },
      { op: "config", machine: "mac-mini" },
      { op: "install", machine: "local", tool: "hc" },
      { op: "config-set", machine: "local", key: "agents", value: "{}" },
      { op: "login", machine: "mac-mini", provider: "codex" },
      { op: "login-answer", job: "job-1", value: "code" },
    ]);
  });

  test("refuses a body that is no request without asking the supervisor", async () => {
    let asked = 0;
    const server = await start({ machines: async () => { asked++; return { ok: true, machines: [], jobs: [] }; } });
    for (const body of [
      { op: "run", argv: ["sh", "-c", "id"] },
      { op: "install", tool: "bun" },
      { op: "install" },
      { op: "config-set", machine: "local", key: "reposRoot" },
      { op: "config", machine: "" },
      { op: "login", machine: "local" },
      { op: "login", machine: "local", provider: "gemini" },
      { op: "login-answer", job: "job-1", value: " " },
      { op: "login-answer", job: "job-1", value: "x".repeat(4097) },
      { op: "cancel" },
      { op: "precheck", target: "" },
      { op: "enroll-code", label: "studio" },
      { op: "enroll-script", label: "studio", shell: "posix", token: "a".repeat(64) },
      [],
    ]) {
      const answer = await server.send("POST", "/api/machines", WEB, body);
      expect(answer).toEqual({ status: 400, body: { ok: false, error: "the request is not a machines request" } });
    }
    expect(asked).toBe(0);
  });

  test("serves a pasted enrollment's scripts and exchange outside the web token, behind the download token", async () => {
    const seen: MachineRequest[] = [];
    const token = "c".repeat(64);
    const server = await start({
      machines: async (request): Promise<MachineReply> => {
        seen.push(request);
        if (request.op === "enroll-bootstrap") return { ok: true, script: `#!/bin/sh\necho ${request.shell}\n` };
        if ("token" in request && request.token !== token) return { ok: false, error: "no live enrollment code of studio matches", refused: true };
        if (request.op === "enroll-script") return { ok: true, script: "F='sha256:ab'\n" };
        return { ok: true, enrolled: "studio" };
      },
    });
    const bootstrap = await server.fetch("GET", "/runner-enroll/install.sh");
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.text()).toBe("#!/bin/sh\necho posix\n");
    expect((await server.fetch("GET", "/runner-enroll/script?label=studio&shell=posix")).status).toBe(401);
    const wrong = await fetch(`${server.url}/runner-enroll/script?label=studio&shell=posix`, { headers: { "x-dori-enroll": "d".repeat(64) } });
    expect(wrong.status).toBe(403);
    const script = await fetch(`${server.url}/runner-enroll/script?label=studio&shell=posix`, { headers: { "x-dori-enroll": token } });
    expect(script.status).toBe(200);
    expect(await script.text()).toBe("F='sha256:ab'\n");
    const exchange = await fetch(`${server.url}/runner-enroll/exchange?label=studio`, { method: "POST", headers: { "x-dori-enroll": token }, body: "FRAME" });
    expect(await exchange.json()).toEqual({ ok: true, enrolled: "studio" });
    expect((await fetch(`${server.url}/runner-enroll/exchange?label=studio`, { headers: { "x-dori-enroll": token } })).status).toBe(405);
    expect(seen).toEqual([
      { op: "enroll-bootstrap", shell: "posix" },
      { op: "enroll-script", label: "studio", shell: "posix", token: "d".repeat(64) },
      { op: "enroll-script", label: "studio", shell: "posix", token },
      { op: "enroll-exchange", label: "studio", token, request: "FRAME" },
    ]);
  });

  test("answers 503 without the supervisor, or when it cannot answer", async () => {
    const without = await start();
    expect((await without.send("GET", "/api/machines", WEB, undefined)).status).toBe(503);
    expect((await without.send("POST", "/api/machines", WEB, { op: "install", machine: "local", tool: "omo" })).status).toBe(503);
    const down = await start({ machines: async () => { throw new Error("the supervisor is backoff"); } });
    expect(await down.send("GET", "/api/machines", WEB, undefined)).toEqual({ status: 503, body: { ok: false, error: "the supervisor is backoff" } });
  });

  test("streams the jobs' states the supervisor sends, the earlier ones first", async () => {
    const feed = new MachineJobFeed();
    const server = await start({ machines: async () => ({ ok: true, machines: [], jobs: [] }), machineJobs: feed });
    feed.push(job);
    const response = await server.fetch("GET", "/api/machines/jobs", { token: WEB });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`the stream ended before ${needle}`);
        text += value;
      }
    };
    await until('"state":"running"');
    feed.push({ ...job, state: "succeeded", exitCode: 0, version: "0.1.23", endedAt: 2 });
    await until('"state":"succeeded"');
    expect(text).toContain("event: job");
    await reader.cancel();
  });
});
