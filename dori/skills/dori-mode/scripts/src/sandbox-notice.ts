import { fillHook } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { errLine, oneLine } from "./line-text.ts";
import { TOODO_DEFAULT_ROOM, toodoChat } from "./messenger/toodo-chat.ts";

/** Marks every sandbox notice so the owner reads it as a warning about the lane's isolation, not as lane output. */
export const SANDBOX_NOTICE_PREFIX = "[sandbox] ";

const failure = (prefix: string, error: unknown): string => `${prefix}: ${errLine(error, 160)}`;

/**
 * Posts a sandbox refusal or an allowed unsandboxed run to the owner and returns the event lines to log. Into the lane's
 * thread through hooks.threadReply (as finishRecovery posts LANE_RECOVERED) when the lane has one; else, or when that
 * post fails, into the Toodo chat's default room through `post`. When that fails too, like a lane report that has no
 * thread, it falls back to the lead's journal: the returned SANDBOX_NOTICE_ERROR line carries the text. Never throws.
 * `post` is for tests; absent it replies in the default room with the supervisor's Toodo writer.
 */
export const postSandboxNotice = async (
  deps: FlowDeps, lane: { readonly key: string; readonly thread?: string }, text: string,
  post: (body: string) => Promise<unknown> = (body) => toodoChat(deps.tunables.toodoWriter).reply(TOODO_DEFAULT_ROOM, body),
): Promise<string[]> => {
  const body = text.startsWith(SANDBOX_NOTICE_PREFIX) ? text : `${SANDBOX_NOTICE_PREFIX}${text}`;
  const failures: string[] = [];
  const hook = deps.config.hooks.threadReply;
  if (hook && lane.thread && lane.thread !== "none") {
    try {
      const posted = await deps.run(fillHook(hook, { thread: lane.thread, key: lane.key, text: body }));
      if (posted.code === 0) return [];
      failures.push(`thread post failed: ${oneLine(posted.err || posted.out || `exit ${posted.code}`, 160)}`);
    } catch (error) { failures.push(failure("thread post failed", error)); }
  }
  try {
    await post(body);
    return failures.length ? [`SANDBOX_NOTICE_FALLBACK ${lane.key} posted to the Toodo chat's default room (${failures.join("; ")})`] : [];
  } catch (error) { failures.push(failure("Toodo chat post failed", error)); }
  return [`SANDBOX_NOTICE_ERROR ${lane.key} (${failures.join("; ")}): ${body}`];
};

/** Posts each SANDBOX_SKIPPED note of a launch (an allowed unsandboxed run) as a sandbox notice; returns the notices' event lines. */
export const postSkippedNotices = async (deps: FlowDeps, lane: { readonly key: string; readonly thread?: string }, notes: readonly string[]): Promise<string[]> => {
  const lines: string[] = [];
  for (const note of notes) if (note.startsWith("SANDBOX_SKIPPED")) lines.push(...await postSandboxNotice(deps, lane, note));
  return lines;
};
