//! Commands for tasks, their dependency DAG, and their commit records.

use super::State;

use super::types::{
    self, CommitRecord, CriterionId, DependencyOutcome, NewTask, Task, TaskActivity, TaskEdit,
    TaskId, TaskRelation,
};
use super::{CommandError, CommandResult, GitState, HerdrState, PlainRunState, StorageState, lock};
use crate::domain::criteria::{self, CheckKind, CheckedBy, NewCriterion};
use crate::domain::model;
use crate::domain::model::{CompletionMode, TaskResolution};
use crate::domain::status::TaskStatus;
use crate::storage::{self, CriterionEdit, Storage, StorageError};

/// Tasks of every workspace ordered by ID, each with its dependencies, which may belong
/// to another workspace.
#[specta::specta]
pub fn list_tasks(storage: State<'_, StorageState>) -> CommandResult<Vec<Task>> {
    Ok(types::map_all(&lock(&storage).list_all_tasks()?))
}

#[specta::specta]
pub fn get_task(storage: State<'_, StorageState>, id: TaskId) -> CommandResult<Task> {
    let task = lock(&storage)
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    Ok((&task).into())
}

/// Creates a `planned` task without dependencies, with its completion criteria. The merge
/// criterion follows the completion mode of the workspace: none for `manual`.
#[specta::specta]
pub fn create_task(storage: State<'_, StorageState>, task: NewTask) -> CommandResult<Task> {
    Ok((&create(&storage, task)?).into())
}

/// Creates a task as [`create_task`] does. Its merge criterion follows the completion of
/// its workspace (see [`merge_criterion`]); git does not run.
pub(crate) fn create(storage: &StorageState, task: NewTask) -> CommandResult<model::Task> {
    let wants_merge = task.merge_criterion;
    let mut new: storage::NewTask = task.try_into()?;
    if let Some(merge) = merge_criterion(storage, new.workspace_id, &new.criteria, wants_merge)? {
        new.criteria.insert(0, merge);
    }
    Ok(lock(storage).create_task(&new)?)
}

/// Checks the `criteria` of a new task of `workspace` against its completion (see
/// [`check_kinds`]) and returns the merge criterion it gets in front of them when
/// `wants_merge` and they have none: its pull request is merged (pr_merge), or its
/// branch is merged locally (local_merge). A workspace completed manually adds none.
pub(crate) fn merge_criterion(
    storage: &StorageState,
    workspace: model::WorkspaceId,
    criteria: &[NewCriterion],
    wants_merge: bool,
) -> CommandResult<Option<NewCriterion>> {
    let kinds: Vec<CheckKind> = criteria.iter().map(|criterion| criterion.kind).collect();
    let completion = completion(storage, workspace)?;
    check_kinds(&kinds, &kinds, Some(completion))?;
    let adds_merge = wants_merge && !kinds.iter().any(|&kind| is_merge(kind));
    Ok(adds_merge.then(|| merge_for(completion)).flatten())
}

/// The completion of `workspace`.
fn completion(
    storage: &StorageState,
    workspace: model::WorkspaceId,
) -> CommandResult<CompletionMode> {
    Ok(lock(storage)
        .get_workspace(workspace)?
        .ok_or(StorageError::WorkspaceNotFound(workspace))?
        .completion)
}

/// The merge criterion a task of a workspace with `completion` gets; none for manual.
fn merge_for(completion: CompletionMode) -> Option<NewCriterion> {
    match completion {
        CompletionMode::PullRequestMerge => Some(NewCriterion::merge(true)),
        CompletionMode::LocalMerge => Some(NewCriterion::merge(false)),
        CompletionMode::Manual => None,
    }
}

/// Rejects criteria a task could never meet: more than one merge criterion among all
/// `kinds`, and among the `added` ones (new or with a changed kind) a kind the workspace
/// `completion` rules out: pull request criteria without pr_merge, a merged-locally one
/// without local_merge. `completion` is `None` when it is not checked.
fn check_kinds(
    kinds: &[CheckKind],
    added: &[CheckKind],
    completion: Option<CompletionMode>,
) -> CommandResult<()> {
    let merges: Vec<String> = kinds
        .iter()
        .filter(|&&kind| is_merge(kind))
        .map(ToString::to_string)
        .collect();
    if merges.len() > 1 {
        return Err(CommandError::invalid_input(format!(
            "a task has one merge criterion, but these criteria have {} ({}); keep only the one of the workspace completion, pr_merged for pr_merge or branch_merged_locally for local_merge, and leave out or remove_criterion the other",
            merges.len(),
            merges.join(", ")
        )));
    }
    match completion {
        Some(CompletionMode::Manual) => match added
            .iter()
            .find(|&&kind| kind.is_pull_request() || kind == CheckKind::BranchMergedLocally)
        {
            Some(kind) => Err(CommandError::invalid_input(format!(
                "the workspace completes its tasks manually, without a branch or pull request, so a {kind} criterion could never be met; use a manual, url, or command criterion instead"
            ))),
            None => Ok(()),
        },
        Some(CompletionMode::LocalMerge) => {
            match added.iter().find(|kind| kind.is_pull_request()) {
                Some(kind) => Err(CommandError::invalid_input(format!(
                    "the workspace completes its tasks by merging their branch locally (local_merge), so they get no pull request and a {kind} criterion could never be met; use branch_merged_locally for the merge or a manual, url, or command criterion instead"
                ))),
                None => Ok(()),
            }
        }
        Some(CompletionMode::PullRequestMerge)
            if added.contains(&CheckKind::BranchMergedLocally) =>
        {
            Err(CommandError::invalid_input(
                "the workspace completes its tasks through a merged pull request (pr_merge); use pr_merged instead of branch_merged_locally",
            ))
        }
        _ => Ok(()),
    }
}

/// The user edits the criteria list row by row in the app, so removing the merge
/// criterion there is deliberate. With `mergeCriterion`, a task without a merge
/// criterion gets the one of its repository back in front of its criteria.
#[specta::specta]
pub fn update_task(storage: State<'_, StorageState>, task: TaskEdit) -> CommandResult<Task> {
    let completion = edit_completion(&storage, task.id)?;
    edit_task(&mut lock(&storage), task, true, completion)
}

/// The completion of the workspace of the task `id`, which [`edit_task`] checks the
/// criteria against and takes the merge criterion from.
pub(crate) fn edit_completion(
    storage: &StorageState,
    id: TaskId,
) -> CommandResult<Option<CompletionMode>> {
    let task = lock(storage)
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    completion(storage, task.workspace_id).map(Some)
}

/// Edits a task. New `criteria` replace the current ones; unless `may_remove_merge`, a
/// list that would delete the task's merge criterion is rejected. With `merge_criterion`,
/// a task left without a merge criterion gets the one of its workspace completion in
/// front (none for manual). `completion` is the completion of its workspace (see
/// [`edit_completion`]), which the criteria are checked against (see [`check_kinds`]);
/// `None` checks no kinds and takes the pull request criterion as the merge.
pub(crate) fn edit_task(
    storage: &mut Storage,
    edit: TaskEdit,
    may_remove_merge: bool,
    completion: Option<CompletionMode>,
) -> CommandResult<Task> {
    let title = edit.title.trim();
    if title.is_empty() {
        return Err(CommandError::invalid_input("task title must not be empty"));
    }
    let mut task = storage
        .get_task(edit.id.into())?
        .ok_or(StorageError::TaskNotFound(edit.id.into()))?;
    task.task_type = edit.task_type.into();
    task.title = title.to_owned();
    task.description = edit.description;
    task.estimate = types::estimate(edit.estimate)?;
    task.due_date = types::due_date(edit.due_date.as_deref())?;
    let kept;
    let criteria = match &edit.criteria {
        Some(criteria) => Some(criteria.as_slice()),
        None if edit.merge_criterion => {
            kept = task
                .criteria
                .iter()
                .map(|known| types::CriterionInput::keep(types::CriterionId(known.id.0)))
                .collect::<Vec<_>>();
            Some(kept.as_slice())
        }
        None => None,
    };
    if let Some(criteria) = criteria {
        if task.status == TaskStatus::Done {
            return Err(StorageError::CriteriaOfDoneTask(task.id).into());
        }
        let mut edits = criterion_edits(storage, &task, criteria, may_remove_merge)?;
        if edit.merge_criterion
            && !edits.iter().any(|edit| is_merge(edit.criterion.kind))
            && let Some(merge) = merge_for(completion.unwrap_or(CompletionMode::PullRequestMerge))
        {
            edits.insert(
                0,
                CriterionEdit {
                    id: None,
                    criterion: merge,
                },
            );
        }
        let kinds: Vec<CheckKind> = edits.iter().map(|edit| edit.criterion.kind).collect();
        let added: Vec<CheckKind> = edits
            .iter()
            .filter(|edit| {
                edit.id
                    .and_then(|id| task.criteria.iter().find(|known| known.id == id))
                    .is_none_or(|known| known.kind != edit.criterion.kind)
            })
            .map(|edit| edit.criterion.kind)
            .collect();
        check_kinds(&kinds, &added, completion)?;
        storage.set_criteria(task.id, &edits)?;
    }
    storage.update_task(&task)?;
    let task = storage
        .get_task(task.id)?
        .ok_or(StorageError::TaskNotFound(task.id))?;
    Ok((&task).into())
}

fn is_merge(kind: CheckKind) -> bool {
    matches!(
        kind,
        CheckKind::PullRequestMerged | CheckKind::BranchMergedLocally
    )
}

/// The criteria `inputs` ask `task` to have, in order. An input with an `id` is an
/// existing criterion of the task whose omitted fields keep their stored values; each
/// one appears once.
fn criterion_edits(
    storage: &Storage,
    task: &model::Task,
    inputs: &[types::CriterionInput],
    may_remove_merge: bool,
) -> CommandResult<Vec<CriterionEdit>> {
    let mut edits: Vec<CriterionEdit> = Vec::with_capacity(inputs.len());
    for input in inputs {
        let Some(id) = input.id else {
            edits.push(CriterionEdit {
                id: None,
                criterion: input.parse()?,
            });
            continue;
        };
        let id: criteria::CriterionId = id.into();
        if edits.iter().any(|edit| edit.id == Some(id)) {
            return Err(CommandError::invalid_input(format!(
                "criterion {id} appears twice; send each criterion once"
            )));
        }
        let Some(known) = task.criteria.iter().find(|known| known.id == id) else {
            let owner = match storage.criterion_task(id)? {
                Some(owner) => format!(
                    "criterion {id} belongs to task {owner}, not task {}",
                    task.id
                ),
                None => format!("criterion {id} does not exist"),
            };
            return Err(CommandError::invalid_input(format!(
                "{owner}; call get_task {} for the ids of its criteria, or leave out id to add a new criterion",
                task.id
            )));
        };
        edits.push(CriterionEdit {
            id: Some(id),
            criterion: input.parse_over(known)?,
        });
    }
    if !may_remove_merge
        && let Some(merge) = task.criteria.iter().find(|known| is_merge(known.kind))
        && !edits.iter().any(|edit| is_merge(edit.criterion.kind))
    {
        return Err(CommandError::rejected(format!(
            "these criteria would delete the merge criterion {} ({}) of task {} with its evidence; keep it by adding {{\"id\": {}}} to criteria, or pass remove_merge_criterion: true to remove it deliberately",
            merge.id, merge.kind, task.id, merge.id
        )));
    }
    Ok(edits)
}

/// Checks (`met`) or unchecks a manual completion criterion of a task that is not done,
/// with what shows it; blank evidence is none. A task in progress whose criteria are then
/// all met awaits completion until it is completed.
#[specta::specta]
pub fn check_criterion(
    storage: State<'_, StorageState>,
    task_id: TaskId,
    criterion_id: CriterionId,
    met: bool,
    evidence: Option<String>,
) -> CommandResult<Task> {
    check(
        &mut lock(&storage),
        Some(task_id),
        criterion_id,
        met,
        evidence.as_deref(),
        CheckedBy::User,
    )
}

/// Checks a manual criterion as [`check_criterion`] does, as `by`. Without `task_id`,
/// the task is the one the criterion belongs to; with one, it must be that task.
pub(crate) fn check(
    storage: &mut Storage,
    task_id: Option<TaskId>,
    criterion_id: CriterionId,
    met: bool,
    evidence: Option<&str>,
    by: CheckedBy,
) -> CommandResult<Task> {
    let evidence = evidence
        .map(str::trim)
        .filter(|evidence| !evidence.is_empty());
    let criterion: criteria::CriterionId = criterion_id.into();
    let owner = criterion_owner(storage, task_id, criterion_id, "check_criterion")?;
    let task = storage.check_criterion(owner, criterion, met, evidence, by)?;
    Ok((&task).into())
}

/// The task `criterion` belongs to, which must be `task_id` when that is given; `tool`
/// names the call to repeat in the rejection.
pub(crate) fn criterion_owner(
    storage: &Storage,
    task_id: Option<TaskId>,
    criterion: CriterionId,
    tool: &str,
) -> CommandResult<model::TaskId> {
    let criterion: criteria::CriterionId = criterion.into();
    let Some(owner) = storage.criterion_task(criterion)? else {
        return Err(CommandError::not_found(format!(
            "criterion {criterion} does not exist; call get_task on your task for the ids of its criteria"
        )));
    };
    if let Some(task_id) = task_id
        && model::TaskId::from(task_id) != owner
    {
        return Err(CommandError::invalid_input(format!(
            "criterion {criterion} belongs to task {owner}, not task {}; call {tool} with task_id {owner}, or without task_id",
            task_id.0
        )));
    }
    Ok(owner)
}

/// Pauses an `in_progress` or `in_review` task: it becomes `planned` again and keeps
/// its branch, worktree, herdr workspace, commit records, and pull request, so starting
/// it again resumes the work.
#[specta::specta]
pub fn pause_task(storage: State<'_, StorageState>, id: TaskId) -> CommandResult<Task> {
    pause(&mut lock(&storage), id)
}

pub(crate) fn pause(storage: &mut Storage, id: TaskId) -> CommandResult<Task> {
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    if task.status == TaskStatus::Planned {
        return Err(CommandError::rejected(format!(
            "task {} is not being worked on",
            task.id
        )));
    }
    Ok((&storage.set_task_status(id.into(), TaskStatus::Planned)?).into())
}

/// Reopens a `done` task that was completed or concluded by mistake: it becomes `planned`
/// again, paused if it was started, so Start (or Resume) continues the work on its branch.
/// Its resolution, completion note, and `merged_with` are cleared; `reason`, required, is
/// kept as a progress note with the earlier outcome, and the timeline records the
/// reopening. Rejected while a task that depends on it has started: it built on the
/// outcome, which Set outcome corrects instead.
#[specta::specta]
pub fn reopen_task(
    storage: State<'_, StorageState>,
    id: TaskId,
    reason: String,
) -> CommandResult<Task> {
    reopen(&mut lock(&storage), id, &reason)
}

pub(crate) fn reopen(storage: &mut Storage, id: TaskId, reason: &str) -> CommandResult<Task> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(CommandError::invalid_input(
            "say why the task is reopened; the reason is kept as a progress note",
        ));
    }
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    if task.status != TaskStatus::Done {
        return Err(CommandError::rejected(format!(
            "task {} is {}; only a done task can be reopened, and this one is still open: continue it, or pause it to stop working on it",
            task.id, task.status
        )));
    }
    let started: Vec<String> = storage
        .list_all_tasks()?
        .into_iter()
        .filter(|other| {
            other.depends_on.contains(&task.id)
                && (other.status != TaskStatus::Planned
                    || crate::domain::timeline::milestones(&other.timeline)
                        .started_at
                        .is_some())
        })
        .map(|other| format!("#{} ({})", other.id, other.status))
        .collect();
    if !started.is_empty() {
        return Err(CommandError::rejected(format!(
            "task {} cannot be reopened: {} already started on its outcome; correct how it ended with Set outcome instead, or remove those dependencies first",
            task.id,
            started.join(", ")
        )));
    }
    let mut note = format!("Reopened: {reason}");
    if let Some(resolution) = task.resolution {
        note.push_str(&format!("\nIt was done as {}", resolution.as_str()));
        if let Some(merged_with) = &task.merged_with {
            match (&merged_with.pull_request_url, merged_with.task_id) {
                (Some(url), _) => note.push_str(&format!(" through {url}")),
                (None, Some(other)) => note.push_str(&format!(" through task {other}")),
                (None, None) => {}
            }
        }
        match &task.completion_note {
            Some(completion) => note.push_str(&format!(": {completion}")),
            None => note.push('.'),
        }
    }
    Ok((&storage.reopen_task(task.id, &note)?).into())
}

/// Corrects how a `done` task ended without reopening it: `resolution` replaces its
/// resolution and `note`, required, its completion note; the earlier outcome is kept as
/// a progress note. Merged needs a recorded merge, its own pull request's or the one it
/// shipped with; for work another task or pull request shipped, use
/// `complete_task_merged_with`. Not adopted keeps its dependents waiting.
#[specta::specta]
pub fn set_task_outcome(
    storage: State<'_, StorageState>,
    id: TaskId,
    resolution: types::TaskResolution,
    note: String,
) -> CommandResult<Task> {
    set_outcome(&mut lock(&storage), id, resolution.into(), &note)
}

pub(crate) fn set_outcome(
    storage: &mut Storage,
    id: TaskId,
    resolution: TaskResolution,
    note: &str,
) -> CommandResult<Task> {
    let note = note.trim();
    if note.is_empty() {
        return Err(CommandError::invalid_input(
            "say why the outcome changes; the note becomes the task's completion note",
        ));
    }
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    let Some(current) = task.resolution.filter(|_| task.status == TaskStatus::Done) else {
        return Err(CommandError::rejected(format!(
            "task {} is {}; only a done task has an outcome to correct: complete or conclude it first",
            task.id, task.status
        )));
    };
    if current == resolution {
        return Err(CommandError::rejected(format!(
            "task {} is already done as {}; edit its completion note to change what it says",
            task.id,
            resolution.as_str()
        )));
    }
    if resolution == TaskResolution::Merged
        && task.pull_request_merged_at.is_none()
        && task.merged_with.is_none()
    {
        return Err(CommandError::rejected(format!(
            "task {} has no recorded merge; if another task or pull request shipped its work, complete it as shipped by that one, otherwise set the outcome to completed",
            task.id
        )));
    }
    let mut record = format!(
        "Outcome changed from {} to {}: {note}",
        current.as_str(),
        resolution.as_str()
    );
    if let Some(earlier) = &task.completion_note {
        record.push_str(&format!("\nEarlier completion note: {earlier}"));
    }
    Ok((&storage.set_task_outcome(task.id, resolution, note, &record)?).into())
}

/// Stores what the user wrote about the outcome of a `done` task, for reviews. The note
/// is trimmed; an empty one clears it, except for a task that was not adopted, whose note
/// is its required conclusion.
#[specta::specta]
pub fn set_completion_note(
    storage: State<'_, StorageState>,
    id: TaskId,
    note: String,
) -> CommandResult<Task> {
    note_completion(&mut lock(&storage), id, &note)
}

fn note_completion(storage: &mut Storage, id: TaskId, note: &str) -> CommandResult<Task> {
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    if task.status != TaskStatus::Done {
        return Err(CommandError::rejected(format!(
            "task {} is {}; only a done task has a completion note",
            task.id, task.status
        )));
    }
    let note = Some(note.trim()).filter(|note| !note.is_empty());
    if note.is_none() && task.resolution == Some(TaskResolution::NotAdopted) {
        return Err(CommandError::invalid_input(
            "the conclusion of work that was not adopted cannot be cleared",
        ));
    }
    Ok((&storage.set_completion_note(id.into(), note)?).into())
}

/// Deletes a task with its dependency edges and commit records. A task that still has a worktree
/// first removes it through herdr, which also closes its herdr workspace; the branch is
/// kept. Without `force`, a worktree with modified or untracked files is rejected and the
/// task is kept. A task of a workspace with runner plain has its worktree removed by git,
/// and its plain runs that are still running are stopped first.
#[specta::specta]
pub fn delete_task(
    storage: State<'_, StorageState>,
    git: State<'_, GitState>,
    herdr: State<'_, HerdrState>,
    runs: State<'_, PlainRunState>,
    id: TaskId,
    force: bool,
) -> CommandResult<()> {
    let id = id.into();
    let task = lock(&storage)
        .get_task(id)?
        .ok_or(StorageError::TaskNotFound(id))?;
    // A task in progress or in review keeps its worktree, so deleting it is rejected
    // below; its agents keep running.
    let keeps_worktree = task.worktree_path.is_some()
        && matches!(task.status, TaskStatus::InProgress | TaskStatus::InReview);
    if !keeps_worktree {
        super::runs::stop_live_runs(&storage, &runs, id)?;
    }
    super::herdr::delete(&storage, &git, &herdr, id, force)
}

/// Makes `task_id` depend on `depends_on`, which may belong to another workspace. Rejects
/// self and cyclic edges and `done` tasks. An `in_progress` task that the new
/// prerequisite blocks is paused and its herdr workspace closed, but only with
/// `confirm_pause`; without it, nothing is added and the outcome asks for confirmation.
/// The server decides whether the task would pause, not the caller's view of it.
#[specta::specta]
pub fn add_dependency(
    storage: State<'_, StorageState>,
    herdr: State<'_, HerdrState>,
    task_id: TaskId,
    depends_on: TaskId,
    confirm_pause: bool,
) -> CommandResult<DependencyOutcome> {
    let (task, depends_on) = (task_id.into(), [depends_on.into()]);
    if !confirm_pause {
        let change =
            lock(&storage).add_dependencies_with(task, &depends_on, storage::PauseRule::Ask)?;
        if change == storage::DependencyChange::NeedsPause {
            return Ok(DependencyOutcome::ConfirmPause);
        }
        return Ok(DependencyOutcome::Added);
    }
    super::herdr::add_dependencies(&storage, &herdr, task, &depends_on)?;
    Ok(DependencyOutcome::Added)
}

#[specta::specta]
pub fn remove_dependency(
    storage: State<'_, StorageState>,
    task_id: TaskId,
    depends_on: TaskId,
) -> CommandResult<()> {
    Ok(lock(&storage).remove_dependency(task_id.into(), depends_on.into())?)
}

/// Every related link between tasks, which neither block nor wait on each other.
#[specta::specta]
pub fn list_task_relations(storage: State<'_, StorageState>) -> CommandResult<Vec<TaskRelation>> {
    Ok(lock(&storage)
        .list_relations()?
        .into_iter()
        .map(|(task, related)| TaskRelation {
            task_id: task.into(),
            related_id: related.into(),
        })
        .collect())
}

/// Links two tasks, from any workspaces, as related; linking twice keeps one link.
#[specta::specta]
pub fn add_task_relation(
    storage: State<'_, StorageState>,
    task_id: TaskId,
    related_id: TaskId,
) -> CommandResult<()> {
    Ok(lock(&storage).add_related(task_id.into(), related_id.into())?)
}

/// Removes the related link between two tasks, given in either order.
#[specta::specta]
pub fn remove_task_relation(
    storage: State<'_, StorageState>,
    task_id: TaskId,
    related_id: TaskId,
) -> CommandResult<()> {
    Ok(lock(&storage).remove_related(task_id.into(), related_id.into())?)
}

#[specta::specta]
pub fn list_commit_records(
    storage: State<'_, StorageState>,
    task_id: TaskId,
) -> CommandResult<Vec<CommitRecord>> {
    Ok(types::map_all(
        &lock(&storage).list_commit_records(task_id.into())?,
    ))
}

/// The git activity of a task (commits, pull request, CI results, merge), oldest first.
/// Empty for a task of a workspace without a git repository or completed by hand.
#[specta::specta]
pub fn list_task_activity(
    storage: State<'_, StorageState>,
    task_id: TaskId,
) -> CommandResult<Vec<TaskActivity>> {
    Ok(types::map_all(
        &lock(&storage).list_activity(task_id.into())?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::CommandErrorKind;
    use crate::domain::model::{self, Runner, Source, WorkspaceLocation};

    use crate::domain::path::WindowsPath;
    use crate::storage::{NewTask, NewWorkspace};

    fn storage_with_task() -> (Storage, model::Task) {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                location: WorkspaceLocation::Local {
                    path: WindowsPath::parse(r"C:\dev\toodo").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
                source: crate::domain::model::Source::GitHub,
                completion: crate::domain::model::CompletionMode::PullRequestMerge,
                runner: crate::domain::model::Runner::Herdr,
                axes_detected: true,
            })
            .unwrap();
        let mut task = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: model::TaskType::Feat,
                title: "Add commands".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap();
        task.branch = Some("feat/add-commands-1".to_owned());
        storage.update_task(&task).unwrap();
        (storage, task)
    }

    fn new_task(workspace_id: model::WorkspaceId) -> types::NewTask {
        types::NewTask {
            workspace_id: workspace_id.into(),
            task_type: types::TaskType::Feat,
            title: "Add login".to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            criteria: Vec::new(),
            merge_criterion: true,
        }
    }

    /// A workspace with `completion` and the source and runner that go with it.
    fn storage_with_workspace(completion: CompletionMode) -> (StorageState, model::WorkspaceId) {
        let (source, runner) = match completion {
            CompletionMode::PullRequestMerge => (Source::GitHub, Runner::Herdr),
            CompletionMode::LocalMerge => (Source::LocalGit, Runner::Herdr),
            CompletionMode::Manual => (Source::None, Runner::None),
        };
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "quest".to_owned(),
                location: WorkspaceLocation::Local {
                    path: WindowsPath::parse(r"D:\dev\quest").unwrap().into(),
                },
                default_base_branch: "main".to_owned(),
                source,
                completion,
                runner,
                axes_detected: true,
            })
            .unwrap();
        (StorageState::new(storage), workspace.id)
    }

    fn criterion(kind: types::CheckKind) -> types::CriterionInput {
        types::CriterionInput {
            id: None,
            text: Some("Done".to_owned()),
            kind: Some(kind),
            target: None,
        }
    }

    #[test]
    fn a_new_task_takes_its_merge_criterion_from_the_workspace_completion() {
        for (completion, merge) in [
            (
                CompletionMode::PullRequestMerge,
                Some(CheckKind::PullRequestMerged),
            ),
            (
                CompletionMode::LocalMerge,
                Some(CheckKind::BranchMergedLocally),
            ),
            (CompletionMode::Manual, None),
        ] {
            let (storage, workspace) = storage_with_workspace(completion);
            let mut task = new_task(workspace);
            task.criteria = vec![criterion(types::CheckKind::Manual)];
            let created = create(&storage, task).unwrap();
            let kinds: Vec<CheckKind> = created.criteria.iter().map(|c| c.kind).collect();
            let expected: Vec<CheckKind> = merge.into_iter().chain([CheckKind::Manual]).collect();
            assert_eq!(kinds, expected, "{completion}");
        }
    }

    #[test]
    fn criteria_the_workspace_completion_rules_out_are_rejected_on_create() {
        use types::CheckKind::{BranchMergedLocally, PrMerged, PrOpenCiGreen};
        for (completion, kind, next) in [
            (
                CompletionMode::PullRequestMerge,
                BranchMergedLocally,
                "use pr_merged",
            ),
            (
                CompletionMode::LocalMerge,
                PrMerged,
                "branch_merged_locally",
            ),
            (
                CompletionMode::LocalMerge,
                PrOpenCiGreen,
                "branch_merged_locally",
            ),
            (CompletionMode::Manual, PrMerged, "manual, url, or command"),
            (
                CompletionMode::Manual,
                PrOpenCiGreen,
                "manual, url, or command",
            ),
            (
                CompletionMode::Manual,
                BranchMergedLocally,
                "manual, url, or command",
            ),
        ] {
            let (storage, workspace) = storage_with_workspace(completion);
            let mut task = new_task(workspace);
            task.criteria = vec![criterion(kind)];
            let error = create(&storage, task).unwrap_err();
            assert_eq!(error.kind, CommandErrorKind::InvalidInput);
            assert!(error.message.contains(next), "{}", error.message);
            assert!(lock(&storage).list_all_tasks().unwrap().is_empty());
        }
    }

    #[test]
    fn edit_task_keeps_workflow_fields() {
        let (mut storage, task) = storage_with_task();
        let edited = edit_task(
            &mut storage,
            TaskEdit {
                id: task.id.into(),
                task_type: types::TaskType::Fix,
                title: "  Fix commands ".to_owned(),
                description: "details".to_owned(),
                estimate: Some(types::Estimate {
                    unit: types::EstimateUnit::Days,
                    amount: 3.0,
                }),
                due_date: Some(" 2026-10-31 ".to_owned()),
                criteria: None,
                merge_criterion: false,
            },
            true,
            None,
        )
        .unwrap();
        assert_eq!(edited.title, "Fix commands");
        assert_eq!(edited.due_date.as_deref(), Some("2026-10-31"));
        assert_eq!(edited.estimate.map(|estimate| estimate.amount), Some(3.0));
        assert_eq!(edited.task_type, types::TaskType::Fix);
        assert_eq!(edited.branch.as_deref(), Some("feat/add-commands-1"));
        let stored = storage.get_task(task.id).unwrap().unwrap();
        assert_eq!(Task::from(&stored), edited);
    }

    #[test]
    fn pausing_moves_a_started_task_back_to_planned_and_keeps_its_branch() {
        let (mut storage, task) = storage_with_task();
        let error = pause(&mut storage, task.id.into()).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);

        for status in [TaskStatus::InProgress, TaskStatus::InReview] {
            storage
                .set_task_status(task.id, TaskStatus::InProgress)
                .unwrap();
            if status == TaskStatus::InReview {
                storage.set_task_status(task.id, status).unwrap();
            }
            let paused = pause(&mut storage, task.id.into()).unwrap();
            assert_eq!(paused.status, types::TaskStatus::Planned);
            assert_eq!(paused.branch.as_deref(), Some("feat/add-commands-1"));
        }
    }

    #[test]
    fn only_a_done_task_gets_a_trimmed_completion_note_and_an_empty_one_clears_it() {
        let (mut storage, task) = storage_with_task();
        let error = note_completion(&mut storage, task.id.into(), "Shipped").unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        let error = note_completion(&mut storage, TaskId(999), "Shipped").unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);

        for status in [
            TaskStatus::InProgress,
            TaskStatus::InReview,
            TaskStatus::Done,
        ] {
            storage.set_task_status(task.id, status).unwrap();
        }
        let noted =
            note_completion(&mut storage, task.id.into(), "  Cut login time in half\n").unwrap();
        assert_eq!(
            noted.completion_note.as_deref(),
            Some("Cut login time in half")
        );
        let stored = storage.get_task(task.id).unwrap().unwrap();
        assert_eq!(Task::from(&stored), noted);

        let cleared = note_completion(&mut storage, task.id.into(), " ").unwrap();
        assert_eq!(cleared.completion_note, None);
        assert_eq!(
            storage.get_task(task.id).unwrap().unwrap().completion_note,
            None
        );
    }

    #[test]
    fn the_conclusion_of_a_task_that_was_not_adopted_can_be_edited_but_not_cleared() {
        let (mut storage, task) = storage_with_task();
        storage
            .set_task_status(task.id, TaskStatus::InProgress)
            .unwrap();
        storage
            .conclude_task(task.id, "Too slow", &[], None)
            .unwrap();

        let error = note_completion(&mut storage, task.id.into(), " ").unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        let edited = note_completion(&mut storage, task.id.into(), "Twice as slow").unwrap();
        assert_eq!(edited.completion_note.as_deref(), Some("Twice as slow"));
        assert_eq!(edited.resolution, Some(types::TaskResolution::NotAdopted));
    }

    #[test]
    fn reopening_a_concluded_task_pauses_it_and_keeps_the_earlier_outcome_as_a_note() {
        let (mut storage, task) = storage_with_task();
        let error = reopen(&mut storage, task.id.into(), "Too early").unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        storage
            .set_task_status(task.id, TaskStatus::InProgress)
            .unwrap();
        storage
            .conclude_task(task.id, "Too slow", &[], None)
            .unwrap();
        let error = reopen(&mut storage, task.id.into(), "  ").unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);

        let reopened = reopen(&mut storage, task.id.into(), " The cache helps after all ").unwrap();

        assert_eq!(reopened.status, types::TaskStatus::Planned);
        assert_eq!(reopened.resolution, None);
        assert_eq!(reopened.completion_note, None);
        assert_eq!(reopened.branch, task.branch);
        assert_eq!(
            reopened.notes.last().map(|note| note.body.as_str()),
            Some("Reopened: The cache helps after all\nIt was done as not_adopted: Too slow")
        );
        let last = reopened.timeline.last().unwrap();
        assert!(last.reopened);
        assert_eq!(last.status, types::TaskStatus::Planned);
        assert_eq!(reopened.milestones.completed_at, None);
        assert_eq!(reopened.milestones.reopened_at, Some(last.at));
        assert_eq!(reopened.milestones.paused_at, Some(last.at));
        assert_eq!(
            Task::from(&storage.get_task(task.id).unwrap().unwrap()),
            reopened
        );
        // A reopened task is started again like a paused one.
        storage
            .set_task_status(task.id, TaskStatus::InProgress)
            .unwrap();
    }

    #[test]
    fn a_task_whose_dependents_started_on_it_is_not_reopened() {
        let (mut storage, task) = storage_with_task();
        let dependent = storage
            .create_task(&NewTask {
                workspace_id: task.workspace_id,
                task_type: model::TaskType::Feat,
                title: "Build on commands".to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap();
        for status in [
            TaskStatus::InProgress,
            TaskStatus::InReview,
            TaskStatus::Done,
        ] {
            storage.set_task_status(task.id, status).unwrap();
        }
        storage.add_dependency(dependent.id, task.id).unwrap();
        storage
            .set_task_status(dependent.id, TaskStatus::InProgress)
            .unwrap();
        // Pausing the dependent does not undo that it started.
        storage
            .set_task_status(dependent.id, TaskStatus::Planned)
            .unwrap();
        let before = storage.get_task(task.id).unwrap().unwrap();

        let error = reopen(&mut storage, task.id.into(), "Missed a case").unwrap_err();

        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(
            error
                .message
                .contains(&format!("#{} (planned)", dependent.id))
                && error.message.contains("Set outcome"),
            "{}",
            error.message
        );
        assert_eq!(storage.get_task(task.id).unwrap().unwrap(), before);
    }

    #[test]
    fn the_outcome_of_a_done_task_is_corrected_with_a_note_and_a_record_of_the_change() {
        let (mut storage, task) = storage_with_task();
        let error = set_outcome(
            &mut storage,
            task.id.into(),
            TaskResolution::NotAdopted,
            "Dropped",
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        for status in [
            TaskStatus::InProgress,
            TaskStatus::InReview,
            TaskStatus::Done,
        ] {
            storage.set_task_status(task.id, status).unwrap();
        }
        storage
            .set_completion_note(task.id, Some("Shipped"))
            .unwrap();
        let timeline = storage.get_task(task.id).unwrap().unwrap().timeline;

        let error = set_outcome(
            &mut storage,
            task.id.into(),
            TaskResolution::NotAdopted,
            " ",
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        let error = set_outcome(
            &mut storage,
            task.id.into(),
            TaskResolution::Merged,
            "Merged",
        )
        .unwrap_err();
        assert!(
            error.message.contains("already done as merged"),
            "{}",
            error.message
        );

        let corrected = set_outcome(
            &mut storage,
            task.id.into(),
            TaskResolution::NotAdopted,
            " Reverted the next day ",
        )
        .unwrap();
        assert_eq!(
            corrected.resolution,
            Some(types::TaskResolution::NotAdopted)
        );
        assert_eq!(
            corrected.completion_note.as_deref(),
            Some("Reverted the next day")
        );
        assert_eq!(
            corrected.notes.last().map(|note| note.body.as_str()),
            Some(
                "Outcome changed from merged to not_adopted: Reverted the next day\nEarlier completion note: Shipped"
            )
        );
        assert_eq!(
            storage.get_task(task.id).unwrap().unwrap().timeline,
            timeline
        );

        // Nothing records a merge, so merged is not an outcome it can claim.
        let error = set_outcome(
            &mut storage,
            task.id.into(),
            TaskResolution::Merged,
            "Merged",
        )
        .unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);
        assert!(error.message.contains("completed"), "{}", error.message);
        let completed = set_outcome(
            &mut storage,
            task.id.into(),
            TaskResolution::Completed,
            "Deployed by hand",
        )
        .unwrap();
        assert_eq!(completed.resolution, Some(types::TaskResolution::Completed));
    }

    #[test]
    fn edit_task_rejects_empty_title_and_unknown_task() {
        let (mut storage, task) = storage_with_task();
        let edit = |id: TaskId, title: &str| TaskEdit {
            id,
            task_type: types::TaskType::Feat,
            title: title.to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            criteria: None,
            merge_criterion: false,
        };
        let error = edit_task(&mut storage, edit(task.id.into(), " "), true, None).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        let error = edit_task(&mut storage, edit(TaskId(999), "Other"), true, None).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
        assert_eq!(storage.get_task(task.id).unwrap().unwrap(), task);
    }

    #[test]
    fn criteria_the_repository_could_never_meet_are_rejected() {
        use CheckKind::{
            BranchMergedLocally, Manual, PullRequestMerged, PullRequestOpenChecksPassed,
        };
        let rejected = |kinds: &[CheckKind], added: &[CheckKind], origin| {
            check_kinds(kinds, added, origin).unwrap_err().message
        };
        use CompletionMode::{LocalMerge, PullRequestMerge};
        let both = [PullRequestMerged, BranchMergedLocally];
        assert!(rejected(&both, &[], None).contains("one merge criterion"));
        let ci = [PullRequestOpenChecksPassed];
        assert!(rejected(&ci, &ci, Some(LocalMerge)).contains("branch_merged_locally"));
        let local = [BranchMergedLocally];
        assert!(rejected(&local, &local, Some(PullRequestMerge)).contains("use pr_merged"));
        for kind in [
            PullRequestMerged,
            PullRequestOpenChecksPassed,
            BranchMergedLocally,
        ] {
            assert!(
                rejected(&[kind], &[kind], Some(CompletionMode::Manual))
                    .contains("use a manual, url, or command criterion")
            );
        }
        // Kept criteria are not checked again, and an unknown completion checks nothing.
        check_kinds(&[PullRequestMerged, Manual], &[Manual], Some(LocalMerge)).unwrap();
        check_kinds(
            &[Manual, CheckKind::Url],
            &[Manual],
            Some(CompletionMode::Manual),
        )
        .unwrap();
        check_kinds(&local, &local, None).unwrap();
        check_kinds(
            &[PullRequestMerged, PullRequestOpenChecksPassed],
            &ci,
            Some(PullRequestMerge),
        )
        .unwrap();
    }

    #[test]
    fn edit_task_puts_the_merge_criterion_of_the_repository_back() {
        let (mut storage, task) = storage_with_task();
        let edit = |merge_criterion| TaskEdit {
            id: task.id.into(),
            task_type: types::TaskType::Feat,
            title: "Add commands".to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            criteria: None,
            merge_criterion,
        };
        let unchanged = edit_task(&mut storage, edit(false), true, None).unwrap();
        assert!(unchanged.criteria.is_empty());
        // A workspace completed manually has no merge criterion to put back.
        let manual =
            edit_task(&mut storage, edit(true), true, Some(CompletionMode::Manual)).unwrap();
        assert!(manual.criteria.is_empty());
        let merged = edit_task(
            &mut storage,
            edit(true),
            true,
            Some(CompletionMode::LocalMerge),
        )
        .unwrap();
        let kinds: Vec<_> = merged.criteria.iter().map(|c| c.kind).collect();
        assert_eq!(kinds, [types::CheckKind::BranchMergedLocally]);
        // A task that has one keeps it.
        let again = edit_task(
            &mut storage,
            edit(true),
            true,
            Some(CompletionMode::PullRequestMerge),
        )
        .unwrap();
        assert_eq!(again.criteria, merged.criteria);
    }
}
