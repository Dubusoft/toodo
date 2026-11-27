import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import { laneOutputDir } from "./lane-files.ts";
import { TOODO_FILES_MAX, toodoChat, toodoErrorText, toodoRef } from "./messenger/toodo-chat.ts";
import type { Lane } from "./registry.ts";
import { doneRepos } from "./signals.ts";
import { type ToodoFile, ToodoMcp, ToodoWriter } from "./toodo-client.ts";

/*
 * A lane on the Toodo chat (config platforms has toodo): every lane works on one task, and its output goes to that task's
 * thread beside its Discord thread (alone with Discord off). Toodo failures never fail a launch: they come back as one line.
 */

type LaneToodoDeps = Pick<FlowDeps, "config" | "tunables" | "registry">;

const toodoOn = (deps: Pick<FlowDeps, "config">): boolean => deps.config.platforms.includes("toodo");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The workspace a lane without a task gets its task in: the unarchived one whose repository names a repo of the lane's
 * Done line, else the first unarchived one.
 */
const laneWorkspace = async (mcp: ToodoMcp, lane: Lane): Promise<number> => {
  const raw = await mcp.call("list_workspaces", {});
  const open = (Array.isArray(raw) ? raw : []).filter((w): w is Record<string, unknown> & { id: number } =>
    isRecord(w) && Number.isSafeInteger(w.id) && (w.archivedAt ?? null) === null).sort((a, b) => a.id - b.id);
  const repos = doneRepos(lane.done).map((r) => r.toLowerCase());
  const named = open.find((w) => typeof w.repository === "string" && repos.some((r) => (w.repository as string).toLowerCase().includes(r)));
  const chosen = named ?? open[0];
  if (!chosen) throw new Error("toodo-server has no unarchived workspace to put the lane's task in");
  return chosen.id;
};

/**
 * Links a freshly launched lane to its task: a lane launched without one gets a new task titled like the lane (recorded
 * on the lane with `taskCreated`, so its close completes it), the task is started with the `lane:<key>` ref (nothing is written when it already is), and its thread is
 * found or opened. Returns the note line for the launch output, or undefined with the Toodo chat off.
 */
export const linkLaneTask = async (deps: LaneToodoDeps, lane: Lane): Promise<string | undefined> => {
  if (!toodoOn(deps)) return undefined;
  try {
    let task = lane.task;
    if (task === undefined) {
      const mcp = new ToodoMcp(deps.tunables.toodoWriter);
      const created = await mcp.call("create_task", {
        workspace_id: await laneWorkspace(mcp, lane), task_type: "rnd", title: lane.title,
        description: `Opened for lane \`${lane.key}\`, launched without a task.`, refs: [`lane:${lane.key}`],
      });
      if (!isRecord(created) || !Number.isSafeInteger(created.id)) throw new Error("toodo-server create_task returned no task id");
      task = created.id as number;
      await deps.registry.patch(lane.key, { task, taskCreated: true });
    }
    await new ToodoWriter(deps.tunables.toodoWriter).startTask(task, { reason: `Lane ${lane.key}`, refs: [`lane:${lane.key}`] });
    const place = await toodoChat(deps.tunables.toodoWriter).taskThread(task, lane.title);
    return `LANE_TASK_LINKED ${lane.key} #${task}${lane.task === undefined ? " (created)" : ""} ${toodoRef(place)}`;
  } catch (e) {
    return `LANE_TASK_LINK_FAILED ${lane.key}: ${toodoErrorText(e)}`;
  }
};

/** Where a lane post landed on the Toodo chat: the message as `toodo:<id>` and its place's ref. */
export type ToodoPosted = { readonly message: string; readonly target: string };

/**
 * Posts `text` from lane `lane` into its task's thread, headed by `label` (the report kind), with `files` attached (at
 * most TOODO_FILES_MAX; the rest, and any whose upload fails, are named under the text instead), and returns where it
 * landed. Undefined with the Toodo chat off, for a lane without a task, and on a failure, which is logged as
 * TOODO_CHAT_POST_FAILED and never thrown.
 */
export const postLaneToodo = async (
  deps: Pick<FlowDeps, "config" | "tunables">, lane: Lane, label: string, text: string, files: readonly ToodoFile[] = [],
): Promise<ToodoPosted | undefined> => {
  if (!toodoOn(deps) || lane.task === undefined) return undefined;
  try {
    const chat = toodoChat(deps.tunables.toodoWriter);
    const ids: number[] = [], unsent: string[] = files.slice(TOODO_FILES_MAX).map((f) => f.name);
    for (const file of files.slice(0, TOODO_FILES_MAX)) {
      try { ids.push((await chat.upload(file)).id); } catch (e) {
        unsent.push(file.name);
        console.error(`TOODO_CHAT_UPLOAD_FAILED ${lane.key} ${label} ${file.name}: ${toodoErrorText(e)}`);
      }
    }
    // The thread is the task's own, so the post names no lane: people never see lane keys in the chat.
    const body = `[${label}]\n${text}${unsent.length ? `\nNot attached: ${unsent.join(", ")}` : ""}`;
    const sent = await chat.reply(await chat.taskThread(lane.task, lane.title), body, [], ids);
    return { message: `toodo:${sent.id}`, target: toodoRef(sent.place) };
  } catch (e) {
    console.error(`TOODO_CHAT_POST_FAILED ${lane.key} ${label}: ${toodoErrorText(e)}`);
    return undefined;
  }
};

/**
 * The files lane `key` left in DORI_LANE_OUT, as installed on the lead (lane-files.ts laneOutputDir), in path order:
 * its report.md or not-adopted.md and any other output, which the task thread shows as attachments.
 */
export const laneOutputFiles = (stateDir: string, key: string): ToodoFile[] => {
  const dir = laneOutputDir(stateDir, key);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()
    .filter((path) => statSync(join(dir, path)).isFile())
    .map((path) => ({ name: basename(path), data: new Uint8Array(readFileSync(join(dir, path))), contentType: Bun.file(join(dir, path)).type }));
};

/** A lane's outcome report (report-post.ts) into its task thread, with the files of its output attached. */
export const postLaneReportToodo = (deps: Pick<FlowDeps, "config" | "tunables">, lane: Lane, text: string): Promise<ToodoPosted | undefined> =>
  postLaneToodo(deps, lane, "report", text, toodoOn(deps) && lane.task !== undefined ? laneOutputFiles(deps.config.stateDir, lane.key) : []);
