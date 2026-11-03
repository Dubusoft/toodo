import type { ChecksStatus, ReviewStatus, TaskId, TaskPullRequestStatus } from "@/lib/bindings";
import { toneChip } from "@/lib/status-styles";
import { cn } from "@/lib/utils";

const checksLabels: Record<ChecksStatus, string> = {
  passing: "CI passed",
  failing: "CI failed",
  pending: "CI running",
};

const checksStyles: Record<ChecksStatus, string> = {
  passing: toneChip.success,
  failing: toneChip.danger,
  pending: toneChip.info,
};

const reviewLabels: Record<ReviewStatus, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  pending: "Review pending",
};

const reviewStyles: Record<ReviewStatus, string> = {
  approved: toneChip.success,
  changes_requested: toneChip.attention,
  pending: toneChip.neutral,
};

const pillClass = "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium";

/** CI and review state of the pull request of task `taskId`; no CI badge when it has no checks. */
export function PullRequestBadges({ taskId, status }: { taskId: TaskId; status: TaskPullRequestStatus }) {
  return (
    <>
      {status.checks && (
        <span aria-label={`CI of #${taskId}`} className={cn(pillClass, checksStyles[status.checks])}>
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full bg-current", status.checks === "pending" && "motion-safe:animate-pulse")}
          />
          {checksLabels[status.checks]}
        </span>
      )}
      <span aria-label={`Review of #${taskId}`} className={cn(pillClass, reviewStyles[status.review])}>
        {reviewLabels[status.review]}
      </span>
    </>
  );
}
