import { afterEach, beforeEach, expect, test } from "bun:test";

import { postSandboxNotice, postSkippedNotices } from "../src/sandbox-notice.ts";
import type { Ran } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

/** deps whose threadReply hook answers `hook` and records its argv; a Toodo default-room post that records or throws. */
const setup = (hook: Ran | undefined, postFails = false) => {
  const hooked: string[][] = [];
  const posts: string[] = [];
  const base = depsFor(newWorld(), fakeClock(T0), state.dir, { hooks: hook ? { threadReply: ["reply", "{thread}", "{text}"] } : {} });
  const deps = { ...base, run: async (argv: readonly string[]): Promise<Ran> => { hooked.push([...argv]); return hook ?? { code: 1, out: "", err: "no hook" }; } };
  const post = async (body: string): Promise<void> => { if (postFails) throw new Error("toodo-server 500"); posts.push(body); };
  return { deps, post, hooked, posts };
};

test("a lane with a thread gets the notice there through hooks.threadReply, marked [sandbox]", async () => {
  const s = setup({ code: 0, out: "", err: "" });
  expect(await postSandboxNotice(s.deps, { key: "k1", thread: "toodo:thread/7" }, "SANDBOX_SKIPPED k1: machine m2 is opted in", s.post)).toEqual([]);
  expect(s.hooked).toEqual([["reply", "toodo:thread/7", "[sandbox] SANDBOX_SKIPPED k1: machine m2 is opted in"]]);
  expect(s.posts).toEqual([]);
});

test("no thread, or a failed thread post, goes to the Toodo chat's default room; a failed post there is a SANDBOX_NOTICE_ERROR line, never a throw", async () => {
  const none = setup({ code: 0, out: "", err: "" });
  expect(await postSandboxNotice(none.deps, { key: "k1", thread: "none" }, "SANDBOX_MISSING k1: x", none.post)).toEqual([]);
  expect(none.hooked).toEqual([]);
  expect(none.posts).toEqual(["[sandbox] SANDBOX_MISSING k1: x"]);
  const failed = setup({ code: 1, out: "", err: "thread gone" });
  expect(await postSandboxNotice(failed.deps, { key: "k1", thread: "discord:1/2" }, "x", failed.post)).toEqual(["SANDBOX_NOTICE_FALLBACK k1 posted to the Toodo chat's default room (thread post failed: thread gone)"]);
  expect(failed.posts).toEqual(["[sandbox] x"]);
  const down = setup(undefined, true);
  expect(await postSandboxNotice(down.deps, { key: "k1" }, "x", down.post)).toEqual(["SANDBOX_NOTICE_ERROR k1 (Toodo chat post failed: toodo-server 500): [sandbox] x"]);
});

test("postSkippedNotices posts only a launch's SANDBOX_SKIPPED notes", async () => {
  const s = setup({ code: 0, out: "", err: "" });
  expect(await postSkippedNotices(s.deps, { key: "k1", thread: "toodo:thread/7" }, ["LANE_WORKSPACE_REGISTERED w1", "SANDBOX_SKIPPED k1: relaunch of a lane recorded without a sandbox"])).toEqual([]);
  expect(s.hooked).toEqual([["reply", "toodo:thread/7", "[sandbox] SANDBOX_SKIPPED k1: relaunch of a lane recorded without a sandbox"]]);
});
