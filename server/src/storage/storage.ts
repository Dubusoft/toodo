import type { Database } from "bun:sqlite";
import * as commits from "./commits.ts";
import * as criteria from "./criteria.ts";
import * as guidelines from "./guidelines.ts";
import * as search from "./search.ts";
import * as archive from "./task-archive.ts";
import * as dependencies from "./task-dependencies.ts";
import * as events from "./task-events.ts";
import * as query from "./task-query.ts";
import * as status from "./task-status.ts";
import * as waits from "./task-waits.ts";
import * as tasks from "./tasks.ts";
import * as workspaces from "./workspaces.ts";

/** Storage operations on one SQLite connection, with no implicit second connection. */
export class Storage {
  #clock: () => number;

  constructor(
    readonly db: Database,
    clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.#clock = clock;
  }

  setClock(clock: () => number): void {
    this.#clock = clock;
  }

  now(): number {
    return this.#clock();
  }

  transaction<T>(operation: () => T, mode: "deferred" | "immediate"): T {
    const transaction = this.db.transaction(operation);
    return mode === "deferred" ? transaction.deferred() : transaction.immediate();
  }

  readonly createWorkspace = workspaces.createWorkspace.bind(null, this);
  readonly getWorkspace = workspaces.getWorkspace.bind(null, this);
  readonly listWorkspaces = workspaces.listWorkspaces.bind(null, this);
  readonly archivedWorkspaces = workspaces.archivedWorkspaces.bind(null, this);
  readonly updateWorkspace = workspaces.updateWorkspace.bind(null, this);
  readonly archiveWorkspace = workspaces.archiveWorkspace.bind(null, this);
  readonly restoreWorkspace = workspaces.restoreWorkspace.bind(null, this);
  readonly purgeWorkspace = workspaces.purgeWorkspace.bind(null, this);

  readonly addGuideline = guidelines.addGuideline.bind(null, this);
  readonly getGuideline = guidelines.getGuideline.bind(null, this);
  readonly listGuidelines = guidelines.listGuidelines.bind(null, this);
  readonly updateGuideline = guidelines.updateGuideline.bind(null, this);
  readonly deleteGuideline = guidelines.deleteGuideline.bind(null, this);

  readonly criterionTask = criteria.criterionTask.bind(null, this);
  readonly setCriteria = criteria.setCriteria.bind(null, this);
  readonly checkCriterion = criteria.checkCriterion.bind(null, this);
  readonly recordCriterionChecks = criteria.recordCriterionChecks.bind(null, this);
  readonly recordCriterionRechecks = criteria.recordCriterionRechecks.bind(null, this);

  readonly searchTasks = search.searchTasks.bind(null, this);
  readonly addRelated = search.addRelated.bind(null, this);
  readonly removeRelated = search.removeRelated.bind(null, this);
  readonly listRelations = search.listRelations.bind(null, this);

  readonly historicalPullRequest = commits.historicalPullRequest.bind(null, this);
  readonly listCommitRecords = commits.listCommitRecords.bind(null, this);
  readonly listCommitRecordsIn = commits.listCommitRecordsIn.bind(null, this);

  readonly createTask = tasks.createTask.bind(null, this);
  readonly createTasks = tasks.createTasks.bind(null, this);
  readonly getTask = query.getTask.bind(null, this);
  readonly listTasks = query.listTasks.bind(null, this);
  readonly listAllTasks = query.listAllTasks.bind(null, this);
  readonly queryTasks = query.queryTasks.bind(null, this);
  readonly updateTask = tasks.updateTask.bind(null, this);
  readonly setTaskLabels = tasks.setTaskLabels.bind(null, this);
  readonly setTaskRefs = tasks.setTaskRefs.bind(null, this);
  readonly addTaskNote = tasks.addTaskNote.bind(null, this);
  readonly setTaskIssue = tasks.setTaskIssue.bind(null, this);

  readonly archiveTask = archive.archiveTask.bind(null, this);
  readonly moveTask = archive.moveTask.bind(null, this);
  readonly archiveDoneTasks = archive.archiveDoneTasks.bind(null, this);
  readonly restoreTask = archive.restoreTask.bind(null, this);
  readonly purgeTask = archive.purgeTask.bind(null, this);
  readonly archivedTasks = archive.archivedTasks.bind(null, this);
  readonly reviewTasks = archive.reviewTasks.bind(null, this);
  readonly deleteTask = archive.deleteTask.bind(null, this);

  readonly ensureReady = query.ensureReady.bind(null, this);
  readonly addDependency = dependencies.addDependency.bind(null, this);
  readonly addDependencies = dependencies.addDependencies.bind(null, this);
  readonly addDependenciesWith = dependencies.addDependenciesWith.bind(null, this);
  readonly removeDependency = dependencies.removeDependency.bind(null, this);

  readonly setLatestEventReason = events.setLatestEventReason.bind(null, this);
  readonly statusCursor = events.statusCursor.bind(null, this);
  readonly statusChangesAfter = events.statusChangesAfter.bind(null, this);
  readonly startTask = status.startTask.bind(null, this);
  readonly completeTask = status.completeTask.bind(null, this);
  readonly concludeTask = status.concludeTask.bind(null, this);
  readonly reopenTask = status.reopenTask.bind(null, this);
  readonly setTaskOutcome = status.setTaskOutcome.bind(null, this);
  readonly setCompletionNote = status.setCompletionNote.bind(null, this);
  readonly setTaskStatus = status.setTaskStatus.bind(null, this);
  readonly pauseTask = status.pauseTask.bind(null, this);
  readonly waitTask = waits.waitTask.bind(null, this);
  readonly endTaskWait = waits.endTaskWait.bind(null, this);
  readonly endDueWaits = waits.endDueWaits.bind(null, this);
}
