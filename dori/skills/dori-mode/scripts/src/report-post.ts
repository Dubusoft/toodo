import type { DoriConfig } from "./config.ts";
import type { ToodoPosted } from "./lane-toodo.ts";
import { recordReported } from "./lane-outcomes.ts";
import { oneLine } from "./line-text.ts";
import type { Lane } from "./registry.ts";

/**
 * A lane's outcome report to the owner, posted and recorded the one way both `dori reported <key> --text` (the lead) and
 * the supervisor's auto report of a clean done claim (done-flow.ts) do it: into the lane's Toodo task thread with the
 * files the lane left in DORI_LANE_OUT attached (lane-toodo.ts postLaneReportToodo), then the receipt that closes the
 * lane's report obligation (lane-outcomes.ts recordReported). A failed post records nothing, so the obligation stays open.
 */

export class ReportPostError extends Error {}

export type ReportPostDeps = {
  readonly config: Pick<DoriConfig, "stateDir">;
  readonly now: () => number;
  /** Posts the report into the lane's Toodo task thread and returns where it landed, undefined when it did not; it never throws. */
  readonly toodo: (lane: Lane, text: string) => Promise<ToodoPosted | undefined>;
};

export type ReportPosted = { readonly kind: "posted"; readonly message: string };

/** Posts `text` as lane `lane`'s report. Throws ReportPostError, recording nothing, when it does not reach the task thread. */
export const postLaneReport = async (deps: ReportPostDeps, lane: Lane, text: string, opts: { readonly note?: string } = {}): Promise<ReportPosted> => {
  const posted = await deps.toodo(lane, text);
  if (!posted) throw new ReportPostError(`REPORT_NOT_POSTED ${lane.key}: the report did not reach the lane's Toodo task thread${lane.task === undefined ? " (the lane has no task)" : ""}; nothing recorded`);
  recordReported(deps.config.stateDir, lane.key, deps.now(), opts.note ? oneLine(opts.note) : undefined, posted);
  return { kind: "posted", message: posted.message };
};
