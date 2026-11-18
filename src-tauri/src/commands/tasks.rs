//! Commands for tasks, their dependency DAG, and their commit records.

use super::State;

use super::types::{
    self, CriterionId, DependencyOutcome, NewTask, Task, TaskEdit, TaskId, TaskRelation,
};
use super::{CommandError, CommandResult, StorageState, lock};
use crate::domain::criteria::{self, CheckedBy};
use crate::domain::model;
use crate::domain::model::TaskResolution;
use crate::domain::status::TaskStatus;
use crate::storage::{self, CriterionEdit, Storage, StorageError};

/// Tasks ordered by ID, each with its dependencies, which may belong to another
/// workspace: every task without a filter, else those the filter selects. With a limit,
/// the matching tasks with the highest IDs; pass the lowest ID of a full page as `before`
/// to read the next.
#[specta::specta]
pub fn list_tasks(
    storage: State<'_, StorageState>,
    filter: Option<types::TaskListFilter>,
) -> CommandResult<Vec<Task>> {
    let query: storage::TaskQuery = filter.unwrap_or_default().try_into()?;
    Ok(types::map_all(&lock(&storage).query_tasks(&query)?))
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
    let labels = types::labels(&task.labels)?;
    let new: storage::NewTask = task.try_into()?;
    let mut storage = lock(storage);
    let task = storage.create_task(&new)?;
    if labels.is_empty() {
        return Ok(task);
    }
    Ok(storage.set_task_labels(task.id, &labels)?)
}

#[specta::specta]
pub fn update_task(storage: State<'_, StorageState>, task: TaskEdit) -> CommandResult<Task> {
    edit_task(&mut lock(&storage), task)
}

pub(crate) fn edit_task(storage: &mut Storage, edit: TaskEdit) -> CommandResult<Task> {
    if let Some(status) = edit.status {
        if status != types::TaskStatus::InReview {
            return Err(CommandError::rejected(
                "call update_task with status in_review; use start_task, pause_task, complete_task, or conclude_task for other status changes",
            ));
        }
        let task = storage
            .get_task(edit.id.into())?
            .ok_or(StorageError::TaskNotFound(edit.id.into()))?;
        task.status
            .transition_to(TaskStatus::InReview)
            .map_err(StorageError::from)?;
    }
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
    task.autopilot_at = match edit.autopilot {
        None => task.autopilot_at,
        Some(false) => None,
        Some(true) => task.autopilot_at.or_else(|| Some(storage.now())),
    };
    let labels = edit.labels.as_deref().map(types::labels).transpose()?;
    if let Some(criteria) = &edit.criteria {
        if task.status == TaskStatus::Done {
            return Err(StorageError::CriteriaOfDoneTask(task.id).into());
        }
        let edits = criterion_edits(storage, &task, criteria)?;
        storage.set_criteria(task.id, &edits)?;
    }
    storage.update_task(&task)?;
    if let Some(status) = edit.status {
        storage.set_task_status(task.id, status.into())?;
    }
    if let Some(labels) = labels {
        storage.set_task_labels(task.id, &labels)?;
    }
    let task = storage
        .get_task(task.id)?
        .ok_or(StorageError::TaskNotFound(task.id))?;
    Ok((&task).into())
}

/// The criteria `inputs` ask `task` to have, in order. An input with an `id` is an
/// existing criterion of the task whose omitted fields keep their stored values; each
/// one appears once.
fn criterion_edits(
    storage: &Storage,
    task: &model::Task,
    inputs: &[types::CriterionInput],
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

/// Pauses an `in_progress` or `in_review` task by returning it to `planned`.
#[specta::specta]
pub fn pause_task(storage: State<'_, StorageState>, id: TaskId) -> CommandResult<Task> {
    pause(&mut lock(&storage), id, None)
}

/// [`pause_task`], recording `reason`, why the work stops, in the task's status history.
pub(crate) fn pause(
    storage: &mut Storage,
    id: TaskId,
    reason: Option<&str>,
) -> CommandResult<Task> {
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    if task.status == TaskStatus::Planned {
        return Err(CommandError::rejected(format!(
            "task {} is not being worked on",
            task.id
        )));
    }
    Ok((&storage.pause_task(id.into(), reason)?).into())
}

/// Makes a `planned`, `in_progress`, or `in_review` task wait until `until`: it is paused
/// (`planned`) until then and returns on its own to the status it had, also after a
/// restart of the server. A task that already waits gets the new time. `reason`, if given,
/// is kept with the progress note the wait records.
#[specta::specta]
pub fn wait_task(
    storage: State<'_, StorageState>,
    id: TaskId,
    until: types::Timestamp,
    reason: Option<String>,
) -> CommandResult<Task> {
    wait(&mut lock(&storage), id, until.0, reason.as_deref())
}

/// [`wait_task`] for the commands and the MCP server.
pub(crate) fn wait(
    storage: &mut Storage,
    id: TaskId,
    until: i64,
    reason: Option<&str>,
) -> CommandResult<Task> {
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    if task.status == TaskStatus::Done {
        return Err(CommandError::rejected(format!(
            "task {} is done, so it cannot wait; reopen it first if more work on it has to wait",
            task.id
        )));
    }
    let now = storage.now();
    let valid = jiff::Timestamp::from_second(until).is_ok();
    if !valid || until <= now {
        let now =
            jiff::Timestamp::from_second(now).map_or_else(|_| now.to_string(), |at| at.to_string());
        return Err(CommandError::invalid_input(format!(
            "the wait must end in the future, after {now}; choose a later time"
        )));
    }
    let reason = reason.map(str::trim).filter(|reason| !reason.is_empty());
    Ok((&storage.wait_task(id.into(), until, reason)?).into())
}

/// Ends the wait of a task now: it returns to the status it had when the wait began, as
/// when the time passes.
#[specta::specta]
pub fn end_wait(storage: State<'_, StorageState>, id: TaskId) -> CommandResult<Task> {
    end_task_wait(&mut lock(&storage), id, None)
}

/// [`end_wait`] with `note`, why the wait ends early, kept with its progress note.
pub(crate) fn end_task_wait(
    storage: &mut Storage,
    id: TaskId,
    note: Option<&str>,
) -> CommandResult<Task> {
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    if task.wait.is_none() {
        return Err(CommandError::rejected(format!(
            "task {} does not wait; call wait_task to make it wait until a time",
            task.id
        )));
    }
    let note = note.map(str::trim).filter(|note| !note.is_empty());
    Ok((&storage.end_task_wait(id.into(), note)?).into())
}

/// How often the server looks for waits whose time has come.
const WAIT_CHECK_PERIOD: std::time::Duration = std::time::Duration::from_secs(5);

/// Starts the thread that ends waits once their time has come, announcing each change.
/// It checks right away, so waits that ended while the server was stopped end on start.
pub fn spawn_wait_checks(app: std::sync::Arc<dyn super::Runtime>) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("task-waits".to_owned())
        .spawn(move || {
            loop {
                let ended = lock(app.storage()).end_due_waits();
                match ended {
                    Ok(workspaces) => {
                        for workspace in workspaces {
                            app.tasks_changed(workspace);
                        }
                    }
                    Err(error) => eprintln!("toodo: cannot end due task waits: {error}"),
                }
                std::thread::sleep(WAIT_CHECK_PERIOD);
            }
        })?;
    Ok(())
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
    let note = reopen_note(storage, id, reason)?;
    Ok((&storage.reopen_task(id.into(), reason.trim(), &note)?).into())
}

/// Checks that [`reopen`] would reopen task `id` without changing anything, and returns
/// the progress note it would record.
pub(crate) fn reopen_note(storage: &Storage, id: TaskId, reason: &str) -> CommandResult<String> {
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
        match &task.completion_note {
            Some(completion) => note.push_str(&format!(": {completion}")),
            None => note.push('.'),
        }
    }
    Ok(note)
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
    if resolution == TaskResolution::Merged {
        return Err(CommandError::rejected(
            "call set_task_outcome with resolution completed or not_adopted; new outcomes do not record merges",
        ));
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

/// Archives the task while preserving its history.
#[specta::specta]
pub fn delete_task(storage: State<'_, StorageState>, id: TaskId) -> CommandResult<()> {
    Ok(lock(&storage).archive_task(id.into())?)
}

/// Moves a task, in any status, into another live workspace, keeping its ID, history,
/// notes, criteria, refs, and links.
#[specta::specta]
pub fn move_task(
    storage: State<'_, StorageState>,
    id: TaskId,
    workspace_id: types::WorkspaceId,
) -> CommandResult<Task> {
    Ok((&lock(&storage).move_task(id.into(), workspace_id.into())?).into())
}

/// Archives every `done` (completed or concluded) task of a live workspace in one go, as
/// [`delete_task`] does for one task, keeping their history; returns how many were
/// archived.
#[specta::specta]
pub fn delete_done_tasks(
    storage: State<'_, StorageState>,
    workspace_id: types::WorkspaceId,
) -> CommandResult<u32> {
    let archived = lock(&storage).archive_done_tasks(workspace_id.into())?;
    Ok(u32::try_from(archived.len()).unwrap_or(u32::MAX))
}

/// Brings an archived task of a live workspace back with its dependencies; its worktree,
/// removed when it was deleted, is not recreated.
#[specta::specta]
pub fn restore_task(storage: State<'_, StorageState>, id: TaskId) -> CommandResult<Task> {
    Ok((&lock(&storage).restore_task(id.into())?).into())
}

/// Deletes an archived task for good with its history, commit records, and links; a task
/// that is not archived is rejected.
#[specta::specta]
pub fn purge_task(storage: State<'_, StorageState>, id: TaskId) -> CommandResult<()> {
    Ok(lock(&storage).purge_task(id.into())?)
}

/// Adds a prerequisite, pausing a blocked active task when confirmed.
#[specta::specta]
pub fn add_dependency(
    storage: State<'_, StorageState>,
    task_id: TaskId,
    depends_on: TaskId,
    confirm_pause: bool,
) -> CommandResult<DependencyOutcome> {
    let rule = if confirm_pause {
        storage::PauseRule::Pause
    } else {
        storage::PauseRule::Ask
    };
    let change =
        lock(&storage).add_dependencies_with(task_id.into(), &[depends_on.into()], rule)?;
    Ok(if change == storage::DependencyChange::NeedsPause {
        DependencyOutcome::ConfirmPause
    } else {
        DependencyOutcome::Added
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::CommandErrorKind;
    use crate::domain::model::{self};
    use crate::storage::{NewTask, NewWorkspace};

    fn storage_with_task() -> (Storage, model::Task) {
        let mut storage = Storage::open_in_memory().unwrap();
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: "toodo".to_owned(),
                description: None,
                repository: None,
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
                autopilot: false,
                criteria: Vec::new(),
            })
            .unwrap();
        task.refs = vec!["branch:feat/add-commands-1".to_owned()];
        storage.set_task_refs(task.id, &task.refs).unwrap();
        storage.update_task(&task).unwrap();
        (storage, task)
    }

    #[test]
    fn edit_task_keeps_workflow_fields() {
        let (mut storage, task) = storage_with_task();
        let edited = edit_task(
            &mut storage,
            TaskEdit {
                status: None,
                id: task.id.into(),
                task_type: types::TaskType::Fix,
                title: "  Fix commands ".to_owned(),
                description: "details".to_owned(),
                estimate: Some(types::Estimate {
                    unit: types::EstimateUnit::Days,
                    amount: 3.0,
                }),
                due_date: Some(" 2026-10-31 ".to_owned()),
                labels: None,
                autopilot: None,
                criteria: None,
            },
        )
        .unwrap();
        assert_eq!(edited.title, "Fix commands");
        assert_eq!(edited.due_date.as_deref(), Some("2026-10-31"));
        assert_eq!(edited.estimate.map(|estimate| estimate.amount), Some(3.0));
        assert_eq!(edited.task_type, types::TaskType::Fix);
        assert_eq!(edited.refs, ["branch:feat/add-commands-1"]);
        let stored = storage.get_task(task.id).unwrap().unwrap();
        assert_eq!(Task::from(&stored), edited);
    }

    #[test]
    fn pausing_moves_a_started_task_back_to_planned_and_keeps_its_branch() {
        let (mut storage, task) = storage_with_task();
        let error = pause(&mut storage, task.id.into(), None).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::Rejected);

        for status in [TaskStatus::InProgress, TaskStatus::InReview] {
            storage
                .set_task_status(task.id, TaskStatus::InProgress)
                .unwrap();
            if status == TaskStatus::InReview {
                storage.set_task_status(task.id, status).unwrap();
            }
            let paused = pause(&mut storage, task.id.into(), None).unwrap();
            assert_eq!(paused.status, types::TaskStatus::Planned);
            assert_eq!(paused.refs, ["branch:feat/add-commands-1"]);
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
    fn a_planned_task_is_concluded_without_starting_it() {
        let (mut storage, task) = storage_with_task();
        let error = storage.complete_task(task.id, None, &[]).unwrap_err();
        assert!(error.to_string().contains("planned"), "{error}");

        let concluded = Task::from(
            &storage
                .conclude_task(task.id, "Not worth it", None)
                .unwrap(),
        );

        assert_eq!(concluded.status, types::TaskStatus::Done);
        assert_eq!(
            concluded.resolution,
            Some(types::TaskResolution::NotAdopted)
        );
        assert_eq!(concluded.completion_note.as_deref(), Some("Not worth it"));
        assert!(
            concluded
                .timeline
                .iter()
                .all(|event| event.status != types::TaskStatus::InProgress),
            "{:?}",
            concluded.timeline
        );
        assert_eq!(
            concluded.timeline.last().map(|event| event.status),
            Some(types::TaskStatus::Done)
        );
    }

    #[test]
    fn the_conclusion_of_a_task_that_was_not_adopted_can_be_edited_but_not_cleared() {
        let (mut storage, task) = storage_with_task();
        storage
            .set_task_status(task.id, TaskStatus::InProgress)
            .unwrap();
        storage.conclude_task(task.id, "Too slow", None).unwrap();

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
        storage.conclude_task(task.id, "Too slow", None).unwrap();
        let error = reopen(&mut storage, task.id.into(), "  ").unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);

        let reopened = reopen(&mut storage, task.id.into(), " The cache helps after all ").unwrap();

        assert_eq!(reopened.status, types::TaskStatus::Planned);
        assert_eq!(reopened.resolution, None);
        assert_eq!(reopened.completion_note, None);
        assert_eq!(reopened.refs, task.refs);
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
                autopilot: false,
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
            status: None,
            id,
            task_type: types::TaskType::Feat,
            title: title.to_owned(),
            description: String::new(),
            estimate: None,
            due_date: None,
            labels: None,
            autopilot: None,
            criteria: None,
        };
        let error = edit_task(&mut storage, edit(task.id.into(), " ")).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
        let error = edit_task(&mut storage, edit(TaskId(999), "Other")).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::NotFound);
        assert_eq!(storage.get_task(task.id).unwrap().unwrap(), task);
    }
}

/// Starts a ready task and records the supplied reason and references.
#[specta::specta]
pub fn start_task(
    storage: State<'_, StorageState>,
    id: TaskId,
    reason: Option<String>,
    refs: Option<Vec<String>>,
) -> CommandResult<Task> {
    let reason = reason.as_deref().map(str::trim);
    if reason == Some("") {
        return Err(CommandError::invalid_input(
            "reason is blank; call start_task with a non-empty reason or omit reason",
        ));
    }
    let mut storage = lock(&storage);
    let task = storage
        .get_task(id.into())?
        .ok_or(StorageError::TaskNotFound(id.into()))?;
    let refs = types::merge_refs(&task.refs, refs.as_deref().unwrap_or_default(), &[])?;
    Ok((&storage.start_task(task.id, reason, &refs)?).into())
}
