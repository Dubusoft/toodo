import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { autoReportPoster, writtenIn } from "../src/auto-report.ts";
import { postLaneReportToodo } from "../src/lane-toodo.ts";
import { pendingReported } from "../src/lane-outcomes.ts";
import type { ReportPostDeps } from "../src/report-post.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const done of cleanups.splice(0)) done(); });

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const lane: Lane = { key: "ap-12-1", title: "로그인 버그", thread: "discord:900/901", brief: "/briefs/ap.md", done: "merged acme/app#1", task: 12, openedAt: new Date(T0).toISOString() };
const claim = { at: new Date(T0).toISOString(), evidence: "https://github.com/acme/app/pull/1 abc1234", text: "로그인 버그를 고쳤습니다" };

test("a done text counts as the owner's language by the share of its letters in that script, links and code aside", () => {
  expect(writtenIn("로그인 버그를 고친 PR을 열었고 CI가 통과했습니다 https://github.com/acme/app/pull/1", "Korean")).toBe(true);
  expect(writtenIn("Fixed the login bug; PR https://github.com/acme/app/pull/1 is green", "Korean")).toBe(false);
  expect(writtenIn("https://github.com/acme/app/pull/1 `abc1234`", "Korean")).toBe(false);
  expect(writtenIn("Fixed the login bug", undefined)).toBe(true);
  expect(writtenIn("로그인 버그를 고쳤습니다", "English")).toBe(false);
  expect(writtenIn("ログインのバグを直しました", "Japanese")).toBe(true);
  expect(writtenIn("修复了登录错误", "Japanese")).toBe(false);
  expect(writtenIn("修复了登录错误", "Chinese")).toBe(true);
});

const poster = (stateDir: string, toodo: ReportPostDeps["toodo"]) =>
  autoReportPoster({ config: { stateDir }, toodo, now: () => T0, home: "/home/test", language: () => "Korean" });

const report = "[System] 로그인 버그(ap-12-1) 완료했습니다.\n로그인 버그를 고쳤습니다\n근거: https://github.com/acme/app/pull/1 abc1234";

test("an auto report for a legacy Discord lane lands in the Toodo task thread and records its receipt", async () => {
  const state = withState();
  cleanups.push(state.done);
  const landed: { task: number | undefined; text: string }[] = [];
  const post = poster(state.dir, async (target, text) => {
    landed.push({ task: target.task, text });
    return { message: "toodo:31", target: "toodo:thread/7" };
  });
  expect(await post(lane, claim)).toBe("toodo:31");
  expect(landed).toEqual([{ task: 12, text: report }]);
  expect(pendingReported(state.dir)).toMatchObject([{ lane: "ap-12-1", message: "toodo:31", target: "toodo:thread/7", note: "auto-reported by the supervisor" }]);
});

test("an auto report that cannot reach the task thread records nothing", async () => {
  const state = withState();
  cleanups.push(state.done);
  await expect(poster(state.dir, async () => undefined)(lane, claim)).rejects.toThrow("REPORT_NOT_POSTED ap-12-1: the report did not reach the lane's Toodo task thread");
  expect(pendingReported(state.dir)).toEqual([]);
});

test("the auto report attaches lane review files and names any file the Toodo server rejects", async () => {
  const state = withState();
  cleanups.push(state.done);
  const stateDir = join(state.dir, "state"), out = join(state.dir, "research", lane.key);
  mkdirSync(stateDir);
  mkdirSync(join(out, "shots"), { recursive: true });
  writeFileSync(join(out, "sheet.webp"), "webp");
  writeFileSync(join(out, "shots", "preview.gif"), "gif");
  writeFileSync(join(out, "report.md"), "# report");
  writeFileSync(join(out, "huge.mp4"), "too large");
  const tokenFile = join(state.dir, "mcp-token");
  writeFileSync(tokenFile, "mcp-1\n");
  const uploads: string[] = [];
  const posts: unknown[] = [];
  using server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/mcp/attachments") {
      const name = url.searchParams.get("name") ?? "";
      uploads.push(name);
      if (name === "huge.mp4") return new Response(null, { status: 413 });
      return Response.json({ id: uploads.length, name, contentType: req.headers.get("content-type"), size: (await req.arrayBuffer()).byteLength }, { status: 201 });
    }
    const rpc = await req.json();
    if (typeof rpc !== "object" || rpc === null || !("id" in rpc) || !("params" in rpc)) return new Response(null, { status: 400 });
    const params = rpc.params;
    if (typeof params !== "object" || params === null || !("name" in params) || !("arguments" in params)) return new Response(null, { status: 400 });
    const { name, arguments: args } = params;
    if (typeof args !== "object" || args === null) return new Response(null, { status: 400 });
    let result: unknown;
    if (name === "list_threads" && "task_id" in args && args.task_id === 12) {
      result = [{ id: 7, taskId: 12, status: "open" }];
    } else if (name === "reply_in_chat" && "thread_id" in args && "body" in args) {
      posts.push(args);
      result = { id: 31, channelId: 1, threadId: args.thread_id, author: "agent", body: args.body, attachments: [] };
    } else return new Response(null, { status: 400 });
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
  } });
  const deps = depsFor(newWorld(), fakeClock(T0), stateDir, { toodoWriter: { url: server.url.href, tokenFile } });
  expect(await poster(stateDir, (target, text) => postLaneReportToodo(deps, target, text))(lane, claim)).toBe("toodo:31");
  expect(uploads).toEqual(["huge.mp4", "report.md", "sheet.webp", "preview.gif"]);
  expect(posts).toEqual([{ thread_id: 7, body: `[report]\n${report}\nNot attached: huge.mp4`, handles: [], attachments: [2, 3, 4] }]);
});
