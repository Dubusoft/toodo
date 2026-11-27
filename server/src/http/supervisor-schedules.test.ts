import { afterEach, describe, expect, test } from "bun:test";

import type { ScheduledJob, ScheduleRequest } from "../../../src/lib/supervisor-schedules.ts";
import { AGENT, startTestServer, type TestServer, WEB } from "./http-fixtures.ts";
import type { ScheduleBridge } from "./supervisor-schedules.ts";

let servers: TestServer[] = [];

async function start(schedules?: ScheduleBridge): Promise<TestServer> {
  const server = await startTestServer(schedules ? { schedules } : {});
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

const job: ScheduledJob = {
  name: "gmail-digest", kind: "GMAIL_DIGEST", cron: "0 6 * * *", everySec: null, tz: "Asia/Seoul",
  text: null, command: ["sh", "-c", "digest"], cwd: null, machine: null, heavy: false, catchUp: "once", paused: false,
  nextRunAt: 1, lastRunAt: null, lastResult: null, waiting: null, error: null,
};

describe("scheduled jobs", () => {
  test("hands each request to the supervisor behind the web token and answers with its reply", async () => {
    const seen: ScheduleRequest[] = [];
    const server = await start(async (request) => {
      seen.push(request);
      if (request.op === "edit") return { ok: false, error: 'schedule gmail-digest: cron "0 0 31 2 *" never fires' };
      return { ok: true, jobs: [{ ...job, paused: request.op === "pause" }] };
    });
    expect((await server.fetch("GET", "/api/supervisor/schedules")).status).toBe(401);
    expect((await server.fetch("GET", "/api/supervisor/schedules", { token: AGENT })).status).toBe(401);

    expect(await server.send("GET", "/api/supervisor/schedules", WEB, undefined)).toEqual({ status: 200, body: { ok: true, jobs: [job] } });
    const paused = await server.send("POST", "/api/supervisor/schedules", WEB, { op: "pause", name: "gmail-digest" });
    expect(paused).toEqual({ status: 200, body: { ok: true, jobs: [{ ...job, paused: true }] } });
    const refused = await server.send("POST", "/api/supervisor/schedules", WEB, { op: "edit", name: "gmail-digest", timing: { cron: "0 0 31 2 *" } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("never fires");
    expect(seen).toEqual([
      { op: "list" },
      { op: "pause", name: "gmail-digest" },
      { op: "edit", name: "gmail-digest", timing: { cron: "0 0 31 2 *" } },
    ]);
  });

  test("refuses a body that is no request without asking the supervisor", async () => {
    let asked = 0;
    const server = await start(async () => { asked++; return { ok: true, jobs: [] }; });
    for (const body of [
      { op: "drop", name: "x" },
      { op: "pause" },
      { op: "edit", name: "x", timing: { cron: "0 6 * * *", everySec: 60 } },
      { op: "add", job: { name: "x", kind: "X", cron: "0 6 * * *", catchUp: "sometimes" } },
      { op: "add", job: { name: "x", kind: "X" } },
    ]) {
      const answer = await server.send("POST", "/api/supervisor/schedules", WEB, body);
      expect(answer).toEqual({ status: 400, body: { ok: false, error: "the request is not a scheduled-jobs request" } });
    }
    expect((await server.fetch("POST", "/api/supervisor/schedules", { token: WEB, body: "{" })).status).toBe(400);
    expect(asked).toBe(0);
  });

  test("answers 503 without a supervisor, or when it cannot answer", async () => {
    const alone = await start();
    expect(await alone.send("GET", "/api/supervisor/schedules", WEB, undefined)).toEqual({
      status: 503,
      body: { ok: false, error: "the Dori supervisor does not run in this server" },
    });
    const down = await start(async () => { throw new Error("the supervisor is backoff"); });
    expect(await down.send("POST", "/api/supervisor/schedules", WEB, { op: "run-now", name: "gmail-digest" })).toEqual({
      status: 503,
      body: { ok: false, error: "the supervisor is backoff" },
    });
  });
});
