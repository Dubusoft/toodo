//! Moving tasks through their statuses, and deleting and reopening them.

use serde::Serialize;

use super::get_task;
use super::queries::{Links, TaskLink, describe_links, task_details};
use super::requests::{
    CompleteTask, ConcludeTask, Confirmation, DeleteDoneTasks, DeleteTask, DoneTasksConfirmation,
    EndWait, GetTask, PauseTask, ReopenTask, ResumeTask, StartTask, WaitTask,
};
use super::workspaces::{live_workspace, task_guidelines};
use crate::commands::completion;
use crate::commands::tasks as task_commands;
use crate::commands::types::{self, Task, TaskId, TaskStatus};
use crate::commands::{CommandError, CommandResult, State, StorageState, lock};
use crate::domain::model::{self, NoteKind};
use crate::storage::Storage;

/// Pauses an `in_progress` or `in_review` task as the app's Pause does and records the
/// reason in its status history and as a progress note. References and criteria stay.
pub fn pause_task(storage: &mut Storage, request: PauseTask) -> CommandResult<Task> {
    let reason = request.reason.trim();
    if reason.is_empty() {
        return Err(CommandError::invalid_input(
            "reason must say why the work stops, e.g. {\"id\": 5, \"reason\": \"Waiting for the API design\"}",
        ));
    }
    let task = get_task(storage, request.id)?;
    match task.status {
        TaskStatus::InProgress | TaskStatus::InReview => {}
        TaskStatus::Planned => {
            return Err(CommandError::rejected(format!(
                "task {} is planned, so nobody works on it; call resume_task for a paused task or start_task to start it",
                task.id.0
            )));
        }
        TaskStatus::Done => {
            return Err(CommandError::rejected(format!(
                "task {} is done; create a follow-up task with create_task for more work",
                task.id.0
            )));
        }
    }
    task_commands::pause(storage, request.id, Some(reason))?;
    let task = storage.add_task_note(
        request.id.into(),
        NoteKind::Progress,
        &format!("Paused: {reason}"),
    )?;
    Ok((&task).into())
}

/// Makes a task wait until a time (see [`task_commands::wait_task`]), or moves the time of
/// a task that already waits.
pub fn wait_task(storage: &mut Storage, request: WaitTask) -> CommandResult<Task> {
    let until: jiff::Timestamp = request.until.trim().parse().map_err(|_| {
        CommandError::invalid_input(format!(
            "until {:?} is not an RFC 3339 time with an offset; pass e.g. {{\"id\": {}, \"until\": \"2026-11-10T09:00:00+09:00\"}}",
            request.until, request.id.0
        ))
    })?;
    task_commands::wait(
        storage,
        request.id,
        until.as_second(),
        request.reason.as_deref(),
    )
}

/// Ends the wait of a task now (see [`task_commands::end_wait`]).
pub fn end_wait(storage: &mut Storage, request: EndWait) -> CommandResult<Task> {
    task_commands::end_task_wait(storage, request.id, request.note.as_deref())
}

/// Resumes a previously started, paused task.
pub fn resume_task(storage: &StorageState, request: ResumeTask) -> CommandResult<Task> {
    let task = get_task(&lock(storage), request.id)?;
    if task.status != TaskStatus::Planned || task.milestones.started_at.is_none() {
        return Err(CommandError::rejected(format!(
            "task {} is not paused; call start_task to start a planned task, or pause_task before resuming active work",
            request.id.0
        )));
    }
    let resumed =
        task_commands::start_task(State(storage), request.id, request.note.clone(), None)?;
    if let Some(note) = request
        .note
        .as_deref()
        .map(str::trim)
        .filter(|note| !note.is_empty())
    {
        lock(storage).add_task_note(
            request.id.into(),
            NoteKind::Progress,
            &format!("Resumed: {note}"),
        )?;
        return get_task(&lock(storage), request.id);
    }
    Ok(resumed)
}

/// Deletes (archives) a `planned` or `done` task as the app's Delete does (see
/// [`task_commands::delete_task`]), but only with `confirm`; without it, nothing changes and
/// the reply says what deleting would do. Tasks being worked on (`in_progress` or
/// `in_review`) are rejected.
pub fn delete_task(storage: &StorageState, request: DeleteTask) -> CommandResult<Confirmation> {
    let details = task_details(&lock(storage), GetTask { id: request.id })?;
    let task = details.task;
    let id = task.id.0;
    match task.status {
        TaskStatus::Planned | TaskStatus::Done => {}
        TaskStatus::InProgress | TaskStatus::InReview => {
            let status = if task.status == TaskStatus::InProgress {
                "in_progress"
            } else {
                "in_review"
            };
            return Err(CommandError::rejected(format!(
                "task {id} is {status}, so it is being worked on; call pause_task {{\"id\": {id}, \"reason\": \"...\"}} first if the work should stop, then delete_task"
            )));
        }
    }
    let dependents = describe_links(&details.dependents);
    let wait = if details.dependents.len() == 1 {
        "waits"
    } else {
        "wait"
    };
    if !request.confirm {
        let mut message = format!(
            "Nothing changed yet. Deleting task {id} \"{}\" archives it: it leaves the task lists and no longer holds back its dependents, while its history, notes, criteria, {} recorded commit(s), and {} dependency and related link(s) stay for the reports; the user can restore it, or delete it for good, under Settings > Archive in the Toodo app",
            task.title,
            details.commits.len(),
            details.depends_on.len() + details.dependents.len() + details.related.len(),
        );
        message.push('.');
        if !dependents.is_empty() {
            message.push_str(&format!(" {dependents} no longer {wait} on it."));
        }
        message.push_str(&format!(
            " To delete it, call delete_task {{\"id\": {id}, \"confirm\": true}}."
        ));
        return Ok(Confirmation {
            confirmed: false,
            task,
            message,
        });
    }
    lock(storage).archive_task(request.id.into())?;
    let mut message = format!(
        "task {id} \"{}\" is deleted and kept in the archive, where the user can restore it in the Toodo app.",
        task.title
    );
    if !dependents.is_empty() {
        message.push_str(&format!(" {dependents} no longer {wait} on it."));
    }
    Ok(Confirmation {
        confirmed: true,
        task,
        message,
    })
}

/// Deletes (archives) every `done` task of a workspace as [`delete_task`] does for one (see
/// [`task_commands::delete_done_tasks`]), but only with `confirm`; without it, nothing
/// changes and the reply lists the tasks deleting would archive.
pub fn delete_done_tasks(
    storage: &mut Storage,
    request: DeleteDoneTasks,
) -> CommandResult<DoneTasksConfirmation> {
    let stored = live_workspace(storage, request.workspace_id)?;
    let id = request.workspace_id.0;
    let done: Vec<(TaskId, String)> = storage
        .list_tasks(stored.id)?
        .into_iter()
        .filter(|task| task.status == crate::domain::status::TaskStatus::Done)
        .map(|task| (task.id.into(), task.title))
        .collect();
    if done.is_empty() {
        return Ok(DoneTasksConfirmation {
            confirmed: false,
            workspace_id: request.workspace_id,
            task_ids: Vec::new(),
            message: format!(
                "Nothing changed: workspace {id} \"{}\" has no done task to delete; call list_tasks {{\"workspace_id\": {id}, \"status\": [\"done\"]}} to check.",
                stored.name
            ),
        });
    }
    if !request.confirm {
        let described: Vec<String> = done
            .iter()
            .map(|(task, title)| format!("#{} {title}", task.0))
            .collect();
        return Ok(DoneTasksConfirmation {
            confirmed: false,
            workspace_id: request.workspace_id,
            task_ids: done.iter().map(|(task, _)| *task).collect(),
            message: format!(
                "Nothing changed yet. Deleting the done tasks of workspace {id} \"{}\" archives {} task(s): {}. They leave the task lists, while their history, notes, criteria, and commit records stay in review_report; the user can restore them, or delete them for good, under Settings > Archive in the Toodo app. To delete them, call delete_done_tasks {{\"workspace_id\": {id}, \"confirm\": true}}.",
                stored.name,
                done.len(),
                described.join(", "),
            ),
        });
    }
    let archived: Vec<TaskId> = storage
        .archive_done_tasks(stored.id)?
        .into_iter()
        .map(TaskId::from)
        .collect();
    let listed: Vec<String> = archived.iter().map(|task| format!("#{}", task.0)).collect();
    Ok(DoneTasksConfirmation {
        confirmed: true,
        workspace_id: request.workspace_id,
        message: format!(
            "{} done task(s) of workspace {id} \"{}\" are deleted and kept in the archive, where the user can restore them in the Toodo app: {}.",
            archived.len(),
            stored.name,
            listed.join(", "),
        ),
        task_ids: archived,
    })
}

/// Reopens a `done` task as the app's Reopen does (see [`task_commands::reopen`]), but only
/// with `confirm`; without it, the reopening is checked and the reply says what it would
/// do, and nothing changes.
pub fn reopen_task(storage: &mut Storage, request: ReopenTask) -> CommandResult<Confirmation> {
    let note = task_commands::reopen_note(storage, request.id, &request.reason)?;
    let id = request.id.0;
    if !request.confirm {
        let details = task_details(storage, GetTask { id: request.id })?;
        let task = details.task;
        let paused = if task.milestones.started_at.is_some() {
            " (paused on its branch, since it was started)"
        } else {
            ""
        };
        let mut message = format!(
            "Nothing changed yet. Reopening task {id} \"{}\" makes it planned again{paused}, clears its resolution and completion note, and records this progress note: {note}",
            task.title
        );
        let dependents = describe_links(&details.dependents);
        if !dependents.is_empty() {
            let wait = if details.dependents.len() == 1 {
                "waits"
            } else {
                "wait"
            };
            message.push_str(&format!(
                "\n{dependents} {wait} on it again until it is done."
            ));
        }
        message.push_str(&format!(
            "\nTo reopen it, call reopen_task again with the same reason and \"confirm\": true, e.g. {}.",
            serde_json::json!({"id": id, "reason": request.reason.trim(), "confirm": true})
        ));
        return Ok(Confirmation {
            confirmed: false,
            task,
            message,
        });
    }
    let task = task_commands::reopen(storage, request.id, &request.reason)?;
    let next = if task.milestones.started_at.is_some() {
        "call resume_task to continue it on its branch"
    } else {
        "call start_task to start it"
    };
    let message = format!("task {id} is reopened and planned; {next} once it is ready.");
    Ok(Confirmation {
        confirmed: true,
        task,
        message,
    })
}

/// A started task with the guidelines of its workspace, as start_task returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedTask {
    #[serde(flatten)]
    pub task: Task,
    /// The guidelines of the task's workspace, to read before working on it.
    pub guidelines: Vec<types::Guideline>,
}

/// Records the start of a ready task.
pub fn start_task(storage: &StorageState, request: StartTask) -> CommandResult<StartedTask> {
    let task = task_commands::start_task(
        State(storage),
        request.id,
        request.reason,
        Some(request.refs),
    )?;
    let guidelines = task_guidelines(&lock(storage), task.workspace_id)?;
    Ok(StartedTask { task, guidelines })
}

/// Completes a task after checking its completion criteria.
pub fn complete_task(storage: &StorageState, request: CompleteTask) -> CommandResult<Task> {
    Ok((&completion::complete(
        storage,
        request.id.into(),
        request.note.as_deref(),
        &request.refs,
    )?)
        .into())
}

/// A task concluded without merging, with the tasks that its conclusion leaves blocked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConcludedTask {
    #[serde(flatten)]
    pub task: Task,
    /// Tasks that depend on the concluded task and stay blocked by it, since work that
    /// was not adopted is not there to build on.
    pub blocked_dependents: Vec<TaskLink>,
    /// What the conclusion means for those tasks and what to do next.
    pub message: String,
}

/// Records the outcome and completion note of a task.
pub fn conclude_task(
    storage: &StorageState,
    request: ConcludeTask,
) -> CommandResult<ConcludedTask> {
    let concluded = completion::conclude(
        storage,
        request.id.into(),
        &request.note,
        request.outcome.unwrap_or_default(),
        request.shipped_with.map(Into::into),
    )?;
    let links = Links::load(&lock(storage))?;
    let blocked_dependents = if concluded.resolution == Some(model::TaskResolution::NotAdopted) {
        links.links(links.dependents(concluded.id).filter(|id| {
            links
                .tasks
                .get(id)
                .is_some_and(|task| task.status != crate::domain::status::TaskStatus::Done)
        }))
    } else {
        Vec::new()
    };
    let message = if concluded.resolution == Some(model::TaskResolution::NotAdopted) {
        conclusion_message(concluded.id.0, &blocked_dependents)
    } else {
        format!(
            "task {} is done; call get_task to read its outcome and references",
            concluded.id
        )
    };
    Ok(ConcludedTask {
        task: (&concluded).into(),
        blocked_dependents,
        message,
    })
}

/// What concluding task `id` means for `dependents`, the tasks that depend on it.
fn conclusion_message(id: i64, dependents: &[TaskLink]) -> String {
    let Some(first) = dependents.first() else {
        return format!("task {id} is done as not_adopted; no task depends on it.");
    };
    format!(
        "task {id} is done as not_adopted, which blocks every task that depends on it: {}. For each, call remove_dependency (e.g. {{\"task_id\": {}, \"depends_on\": {id}}}) if it can go ahead without this work, or conclude_task {id} with outcome shipped_with and shipped_with set to the completed task id if another merged pull request shipped it.",
        describe_links(dependents),
        first.id.0
    )
}
