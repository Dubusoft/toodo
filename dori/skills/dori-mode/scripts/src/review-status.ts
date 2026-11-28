import { join } from "node:path";

import { isRecord, readJsonState } from "./durable-write.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type DecisionContext, type DecisionSpec, openedLine, openOwnerDecision, refIds, taskOfLane } from "./owner-decisions.ts";
import type { Lane } from "./registry.ts";
import type { ReviewExemptions } from "./review-exempt.ts";
import { reviewEnabledFor } from "./review-gate.ts";
import { noteCapDecision, type ReviewCap, type ReviewJobRecord, type ReviewJobs } from "./review-jobs.ts";
import { MAX_REVIEW_ROUNDS } from "./review-response.ts";
import { withStateLockSync } from "./state-lock.ts";
import { saveJsonFile } from "./store.ts";
import { errLine, oneLine } from "./line-text.ts";

/**
 * The review state the supervisor keeps beside the review jobs: the merges it made of reviewed PRs, and the one owner
 * decision a reached review limit needs, opened by its tick.
 */

export const REVIEW_STATUS_FILE = "review-status.json";
const REVIEW_STATUS_LOCK = "review-status.lock.sqlite";

/** A merge the supervisor made of a PR an owner lane claimed. */
export type ReviewMerge = {
  readonly lane: string; readonly repo: string; readonly prNumber: number; readonly headSha: string; readonly mergeSha: string; readonly at: number;
};

type StatusFile = { readonly merges: readonly ReviewMerge[] };
const isStatusFile = (v: unknown): v is StatusFile => isRecord(v) && Array.isArray(v.merges) && v.merges.every(isRecord);

/** `review-status.json`: the merges the supervisor made. */
export class ReviewStatusStore {
  readonly path: string;
  private readonly lock: string;
  constructor(stateDir: string) {
    this.path = join(stateDir, REVIEW_STATUS_FILE);
    this.lock = join(stateDir, REVIEW_STATUS_LOCK);
  }
  /** A corrupt file is moved aside and the store starts empty: earlier merges are forgotten. */
  private read(locked = false): StatusFile {
    return readJsonState(this.path, "REVIEW_STATUS", isStatusFile, "no recorded merges", locked ? undefined : this.lock) ?? { merges: [] };
  }
  private update(act: (f: StatusFile) => StatusFile): void {
    withStateLockSync(this.lock, () => { saveJsonFile(this.path, act(this.read(true))); });
  }
  merges(): readonly ReviewMerge[] { return this.read().merges; }
  recordMerge(m: ReviewMerge): void {
    this.update((f) => (f.merges.some((x) => x.repo === m.repo && x.prNumber === m.prNumber && x.mergeSha === m.mergeSha) ? f : { ...f, merges: [...f.merges, m] }));
  }
}

export type ReviewStores = { readonly jobs: ReviewJobs; readonly exemptions: ReviewExemptions; readonly merges: ReviewStatusStore };

const short = (sha: string): string => sha.slice(0, 7);
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The three owner choices of a reached review limit, in REVIEW_DECISION_OUTCOMES order; none merges without a review. */
export const REVIEW_CAP_OPTIONS = [
  "수정 계속: 작성 레인이 남은 지적을 계속 고치고, 자동 리뷰 한도를 새로 시작",
  "지적 기각 후 재검토: 이 지적들을 기각하고 새 리뷰어가 현재 head를 다시 리뷰",
  "보류: 머지하지 않고 자동 리뷰를 멈춘 채 둠",
] as const;

/** The owner decision a reached review limit opens: one per cap (`sourceRef` names the capped job and the cap time). */
export const reviewCapSpec = (r: ReviewJobRecord, cap: ReviewCap, pr: readonly ReviewJobRecord[], author: Lane | undefined): DecisionSpec => {
  const s = r.job.snapshot;
  const findings = pr.filter((x) => x.receipt?.result.verdict === "findings").length;
  const last = pr.filter((x) => x.receipt).at(-1)?.receipt;
  const task = taskOfLane(r.job.authorLaneKey);
  const origin = author && author.thread !== "none" && refIds(author.thread) ? author.thread : undefined;
  return {
    question: `${s.repo}#${s.prNumber} 자동 리뷰 한도 도달 (${oneLine(cap.reason)}). 어떻게 할까요?`,
    options: [...REVIEW_CAP_OPTIONS],
    recommend: findings >= MAX_REVIEW_ROUNDS ? 1 : 2,
    reason: `리뷰 ${pr.length}회, 지적으로 끝난 라운드 ${findings}회${last ? `, 마지막 receipt ${last.receiptId} (${last.result.verdict})` : ""}, head ${short(s.headSha)}. 리뷰 없이 머지하는 선택지는 없습니다.`,
    waiting: `${s.repo}#${s.prNumber} 머지 (레인 ${r.job.authorLaneKey}는 열린 채 대기)`,
    blocking: true,
    source: "lead",
    sourceRef: `review-cap:${r.job.jobId}:${cap.at}`,
    lane: r.job.authorLaneKey,
    reviewCap: { jobId: r.job.jobId, repo: s.repo, prNumber: s.prNumber },
    ...(task !== undefined ? { task } : {}),
    ...(origin ? { origin } : {}),
  };
};

export type ReviewStatusTickDeps = {
  readonly flow: FlowDeps;
  readonly stores: ReviewStores;
  readonly decisions: DecisionContext;
  readonly home: string;
  readonly emit: (id: string, line: string) => void;
};

/**
 * One pass, run after lane reports are routed: every reached review limit with no owner decision yet opens exactly one
 * (openOwnerDecision dedupes by `sourceRef`, so a crash before the decision id is recorded finds the same decision); the
 * id is recorded on the capped job and a digest OWNER_DECISION_OPENED goes to the lead. A failed open is retried next
 * pass and raised once as urgent REVIEW_DECISION_FAILED.
 * Returns one line per effect; errors are logged, never thrown.
 */
export const reviewStatusTick = async (d: ReviewStatusTickDeps): Promise<string[]> => {
  const out: string[] = [];
  const { flow, stores } = d;
  for (const r of stores.jobs.list()) {
    const cap = r.capReached;
    const s = r.job.snapshot;
    if (!cap || cap.decisionId || cap.ownerDecision || !reviewEnabledFor(flow.config, s.repo)) continue;
    try {
      const author = await flow.registry.read(r.job.authorLaneKey);
      const pr = stores.jobs.list().filter((x) => sameRepo(x.job.snapshot.repo, s.repo) && x.job.snapshot.prNumber === s.prNumber);
      const opened = await openOwnerDecision(d.decisions, reviewCapSpec(r, cap, pr, author ?? undefined));
      noteCapDecision(stores.jobs, flow.clock.now(), r.job.jobId, opened.decision.id);
      d.emit(`owner-decision-opened:${opened.decision.id}`, openedLine(opened.decision, opened.duplicateOf));
      out.push(`REVIEW_DECISION_OPENED ${s.repo}#${s.prNumber} job=${r.job.jobId} decision=${opened.decision.id}`);
    } catch (e) {
      console.error(`REVIEW_DECISION_ERROR ${r.job.jobId} ${errLine(e)}; retried next pass`);
      d.emit(`review-decision-failed:${r.job.jobId}`,
        `REVIEW_DECISION_FAILED ${s.repo}#${s.prNumber} lane=${r.job.authorLaneKey} job=${r.job.jobId} the owner decision for the reached review limit could not be opened: ${errLine(e)}; retried every pass, the PR stays held`);
    }
  }
  return out;
};
