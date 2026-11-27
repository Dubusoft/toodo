// Core domain types: workspaces, tasks, and commit records.

import type { Criterion } from "./criteria.ts";
import type { DueDate, Estimate } from "./plan.ts";
import type { TaskStatus } from "./status.ts";
import type { TaskEvent } from "./timeline.ts";

export type WorkspaceId = number & { readonly __brand: "WorkspaceId" };
export type TaskId = number & { readonly __brand: "TaskId" };
export type GuidelineId = number & { readonly __brand: "GuidelineId" };

export function workspaceId(id: number): WorkspaceId {
  return id as WorkspaceId;
}

export function taskId(id: number): TaskId {
  return id as TaskId;
}

export function guidelineId(id: number): GuidelineId {
  return id as GuidelineId;
}

export type Workspace = {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly description: string | null;
  readonly repository: string | null;
  readonly archivedAt: number | null;
};

/** What a workspace guideline records: a `rule` the workspace's owner sets, which agents
 * working on its tasks follow, or a `memory`, a durable lesson or fact recorded for the
 * workspace, often by an agent. */
export type GuidelineKind = "rule" | "memory";

export const GUIDELINE_KINDS: readonly GuidelineKind[] = ["rule", "memory"];

/** A guideline of a workspace, read before working on one of its tasks. */
export type Guideline = {
  readonly id: GuidelineId;
  readonly workspaceId: WorkspaceId;
  readonly kind: GuidelineKind;
  /** Non-empty Markdown. */
  readonly body: string;
  /** Seconds since the Unix epoch. */
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** Fixed set of task types. `rnd` is research and development: work whose conclusion may
 * be not to adopt it. */
export type TaskType = "feat" | "fix" | "modify" | "refactor" | "docs" | "test" | "chore" | "rnd";

/** How a `done` task ended:
 * - `merged`: its pull request was merged into the base branch.
 * - `completed`: its completion criteria were met without a pull request or a merge.
 * - `not_adopted`: the work was concluded without merging, e.g. research whose result was
 *   not adopted. Its completion note says why; dependents stay blocked. */
export type TaskResolution = "merged" | "completed" | "not_adopted";

/** What a note left on a task records: `progress` made while working on the task, a
 * `blocker` that stops the work until someone acts on it, or a `decision` taken while
 * working on the task, and why. */
export type NoteKind = "progress" | "blocker" | "decision";

export const NOTE_KINDS: readonly NoteKind[] = ["progress", "blocker", "decision"];

/** A note an agent left on a task while working on it. */
export type TaskNote = {
  readonly kind: NoteKind;
  /** Non-empty Markdown. */
  readonly body: string;
  /** Time the note was left, in seconds since the Unix epoch. */
  readonly at: number;
};

export type Task = {
  readonly id: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly taskType: TaskType;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  /** How the task ended; set exactly when it is `done`. */
  readonly resolution: TaskResolution | null;
  readonly dependsOn: ReadonlySet<TaskId>;
  /** The GitHub issue of the workspace repository this task works on; its pull request
   * closes it on merge. */
  readonly issue: LinkedIssue | null;
  /** The expected size of the task, if the user or an agent estimated it. */
  readonly estimate: Estimate | null;
  /** The day the task should be done by, if it has one. */
  readonly dueDate: DueDate | null;
  /** Labels such as a project or goal, sorted and unique (see `labels` in `plan.ts`). */
  readonly labels: readonly string[];
  /** References to where the work is tracked or discussed, e.g. `lane:search-api`,
   * `discord:<thread>`, `pr:<number>`, or a URL, in the order they were added (see
   * `mergeRefs` in `plan.ts`). */
  readonly refs: readonly string[];
  /** What the user wrote about the outcome of a `done` task, for later reviews. */
  readonly completionNote: string | null;
  /** Status history, oldest event first. */
  readonly timeline: readonly TaskEvent[];
  /** Notes left on the task, oldest first. */
  readonly notes: readonly TaskNote[];
  /** What has to hold for the task to be done, in the order its author gave. */
  readonly criteria: readonly Criterion[];
  /** The wait the task is paused for, if it waits. */
  readonly wait: TaskWait | null;
  /** Since when the task is marked for autopilot, in seconds since the Unix epoch: an
   * executor may take it up on its own once it is ready. `null` when it is not marked. */
  readonly autopilotAt: number | null;
};

/** A wait on a task (see `docs/workflow.md`, Waiting): the task is `planned` until `until`,
 * then it returns to `status`, the status it had when the wait began. */
export type TaskWait = {
  /** Seconds since the Unix epoch. */
  readonly until: number;
  /** `planned`, `in_progress`, or `in_review`. */
  readonly status: TaskStatus;
};

/** A GitHub issue linked to a task. */
export type LinkedIssue = {
  readonly number: number;
  readonly url: string;
};

/** A merged pull request as GitHub reported it when it completed its task, kept so reviews
 * do not depend on GitHub later. */
export type PullRequestSnapshot = {
  readonly number: number;
  readonly title: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  /** The commit the merge put on the base branch; with a squash merge the branch commits
   * never reach it. */
  readonly mergeCommitSha: string | null;
  /** Submitted reviews by anyone but the author of the pull request. */
  readonly reviewCount: number;
  /** Distinct reviewers other than the author of the pull request. */
  readonly reviewerCount: number;
  /** Submission time of the first of those reviews, in seconds since the Unix epoch. */
  readonly firstReviewedAt: number | null;
};

export type CommitRecord = {
  readonly taskId: TaskId;
  readonly sha: string;
  readonly message: string;
  readonly author: string;
  /** Commit timestamp in seconds since the Unix epoch. */
  readonly committedAt: number;
};
