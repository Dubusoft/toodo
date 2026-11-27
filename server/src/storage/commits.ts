import { taskId } from "../domain/model.ts";
import type { CommitRecord, PullRequestSnapshot, TaskId } from "../domain/model.ts";
import type { Period } from "../domain/review.ts";
import type { Storage } from "./storage.ts";

export function historicalPullRequest(storage: Storage, task: TaskId): PullRequestSnapshot | null {
  return storage.db.query<PullRequestSnapshot, [TaskId]>(`
    SELECT number, title, additions, deletions, changed_files AS changedFiles,
           merge_commit_sha AS mergeCommitSha, review_count AS reviewCount,
           reviewer_count AS reviewerCount, first_reviewed_at AS firstReviewedAt
    FROM pull_request_snapshots WHERE task_id = ?1
  `).get(task);
}

export function listCommitRecords(storage: Storage, task: TaskId): CommitRecord[] {
  return storage.db.query<Omit<CommitRecord, "taskId">, [TaskId]>(`
    SELECT sha, message, author, committed_at AS committedAt
    FROM commit_records WHERE task_id = ?1 ORDER BY position
  `).all(task).map((record) => ({ taskId: task, ...record }));
}

export function listCommitRecordsIn(storage: Storage, period: Period): CommitRecord[] {
  type Row = Omit<CommitRecord, "taskId"> & { readonly task_id: number };
  return storage.db.query<Row, [number, number]>(`
    SELECT task_id, sha, message, author, committed_at AS committedAt, 0 AS origin, position
    FROM commit_records
    WHERE committed_at >= ?1 AND committed_at < ?2
    UNION ALL
    SELECT task_id, external_ref, title, COALESCE(author, ''), occurred_at, 1, id
    FROM task_activity AS activity
    WHERE kind = 'commit' AND occurred_at >= ?1 AND occurred_at < ?2
      AND NOT EXISTS (
        SELECT 1 FROM commit_records AS record
        WHERE record.task_id = activity.task_id AND record.sha = activity.external_ref
      )
    ORDER BY committedAt, task_id, origin, position
  `).all(period.start, period.end).map(({ task_id, sha, message, author, committedAt }) => ({
    taskId: taskId(task_id), sha, message, author, committedAt,
  }));
}
