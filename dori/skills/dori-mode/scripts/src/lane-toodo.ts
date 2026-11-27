import type { FlowDeps } from "./done-flow.ts";
import { toodoChat, toodoErrorText, toodoRef } from "./messenger/toodo-chat.ts";
import type { Lane } from "./registry.ts";
import { doneRepos } from "./signals.ts";
import { ToodoMcp, ToodoWriter } from "./toodo-client.ts";

/*
 * A lane on the Toodo chat (config platforms has toodo): every lane works on one task, and its output goes to that task's
 * thread beside its Discord thread. Toodo failures never fail a launch or a report: they come back as one line.
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
 * on the lane), the task is started with the `lane:<key>` ref (nothing is written when it already is), and its thread is
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
      await deps.registry.patch(lane.key, { task });
    }
    await new ToodoWriter(deps.tunables.toodoWriter).startTask(task, { reason: `Lane ${lane.key}`, refs: [`lane:${lane.key}`] });
    const place = await toodoChat(deps.tunables.toodoWriter).taskThread(task, lane.title);
    return `LANE_TASK_LINKED ${lane.key} #${task}${lane.task === undefined ? " (created)" : ""} ${toodoRef(place)}`;
  } catch (e) {
    return `LANE_TASK_LINK_FAILED ${lane.key}: ${toodoErrorText(e)}`;
  }
};

/**
 * Posts `text` from lane `lane` into its task's thread, headed by `label` (the report kind). Nothing with the Toodo chat
 * off or a lane without a task; a failure is logged as TOODO_CHAT_POST_FAILED and never thrown.
 */
export const postLaneToodo = async (deps: Pick<FlowDeps, "config" | "tunables">, lane: Lane, label: string, text: string): Promise<void> => {
  if (!toodoOn(deps) || lane.task === undefined) return;
  try {
    const chat = toodoChat(deps.tunables.toodoWriter);
    await chat.reply(await chat.taskThread(lane.task, lane.title), `[${label}] ${lane.key}\n${text}`);
  } catch (e) {
    console.error(`TOODO_CHAT_POST_FAILED ${lane.key} ${label}: ${toodoErrorText(e)}`);
  }
};
