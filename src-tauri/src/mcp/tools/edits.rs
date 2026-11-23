//! Editing tasks: fields, criteria, workspace, dependencies, and notes.

use serde::Serialize;

use super::get_task;
use super::queries::{TaskDetails, dependency_message, task_details};
use super::requests::{
    AddCriterion, AddDependencies, AddNote, CheckCriterion, Dependency, GetTask, MoveTask,
    MovedTask, RemoveCriterion, UpdateTask,
};
use super::workspaces::live_workspace;
use crate::commands::tasks::{self as task_commands, edit_task};
use crate::commands::types::{self, Task, TaskEdit};
use crate::commands::{CommandError, CommandResult};
use crate::domain::criteria::CheckedBy;
use crate::domain::model::NoteKind;
use crate::storage::{Storage, StorageError};

/// Edits a task as `update_task` does; `completion` is the completion of its workspace
/// (see [`task_commands::edit_completion`]).
pub fn update_task(storage: &mut Storage, request: UpdateTask) -> CommandResult<Task> {
    let current = get_task(storage, request.id)?;
    // A done task is part of the record reviews are built on; agents add to it instead.
    if current.status == types::TaskStatus::Done {
        return Err(CommandError::rejected(format!(
            "task {} is done, so update_task leaves its record as it was finished; record a correction with add_progress_note task_id {}, or call reopen_task to work on it again",
            request.id.0, request.id.0
        )));
    }
    let id = request.id;
    let refs = match (&request.refs, &request.remove_refs) {
        (None, None) => None,
        (add, remove) => Some(types::merge_refs(
            &current.refs,
            add.as_deref().unwrap_or_default(),
            remove.as_deref().unwrap_or_default(),
        )?),
    };
    let edited = edit_task(
        storage,
        TaskEdit {
            status: request.status,
            id: request.id,
            task_type: request.task_type.unwrap_or(current.task_type),
            title: request.title.unwrap_or(current.title),
            description: request.description.unwrap_or(current.description),
            estimate: request.estimate.unwrap_or(current.estimate),
            due_date: request.due_date.unwrap_or(current.due_date),
            labels: request.labels,
            autopilot: request.autopilot,
            criteria: request.criteria,
        },
    )?;
    if let Some(refs) = refs {
        storage.set_task_refs(id.into(), &refs)?;
    } else {
        return Ok(edited);
    }
    get_task(storage, id)
}

/// The criterion `request` adds to the end of its task's criteria, as an edit input.
pub fn new_criterion(request: &AddCriterion) -> types::CriterionInput {
    types::CriterionInput {
        id: None,
        text: Some(request.text.clone()),
        kind: Some(request.kind),
        target: request.target.clone(),
    }
}

/// Moves a task, in any status, into another live workspace. Only its workspace changes:
/// refs (branches, lanes, pull requests) stay as recorded, since Toodo does not interpret
/// them, and the task follows the guidelines of its new workspace from then on.
pub fn move_task(storage: &mut Storage, request: MoveTask) -> CommandResult<MovedTask> {
    let current = get_task(storage, request.id)?;
    let from = live_workspace(storage, current.workspace_id)?;
    let to = live_workspace(storage, request.workspace_id)?;
    let id = request.id.0;
    if from.id == to.id {
        return Ok(MovedTask {
            task: current,
            from_workspace_id: request.workspace_id,
            message: format!(
                "Nothing changed: task {id} is already in workspace {} \"{}\".",
                to.id.0, to.name
            ),
        });
    }
    let moved = storage.move_task(request.id.into(), request.workspace_id.into())?;
    Ok(MovedTask {
        task: (&moved).into(),
        from_workspace_id: from.id.into(),
        message: format!(
            "Moved task {id} from workspace {} \"{}\" to workspace {} \"{}\". Its id, status and history, notes, criteria, refs, and dependency and related links are unchanged; refs such as branch: or lane: still name what they named before, so update them with update_task refs and remove_refs if the executor moves that work. Read get_guidelines {{\"workspace_id\": {}}} before working on it again.",
            from.id.0, from.name, to.id.0, to.name, to.id.0
        ),
    })
}

/// Adds one criterion, pending, after the task's criteria, which stay as they are;
/// `completion` as for [`update_task`].
pub fn add_criterion(storage: &mut Storage, request: AddCriterion) -> CommandResult<Task> {
    let current = get_task(storage, request.task_id)?;
    let mut criteria: Vec<types::CriterionInput> = current
        .criteria
        .iter()
        .map(|criterion| types::CriterionInput::keep(criterion.id))
        .collect();
    criteria.push(new_criterion(&request));
    update_task(
        storage,
        UpdateTask {
            status: None,
            refs: None,
            remove_refs: None,
            id: request.task_id,
            task_type: None,
            title: None,
            description: None,
            estimate: None,
            due_date: None,
            labels: None,
            autopilot: None,
            criteria: Some(criteria),
        },
    )
}

/// Deletes one criterion of a task that is not done with its evidence, the merge
/// criterion too; the others stay as they are.
pub fn remove_criterion(storage: &mut Storage, request: RemoveCriterion) -> CommandResult<Task> {
    let owner = task_commands::criterion_owner(
        storage,
        request.task_id,
        request.criterion_id,
        "remove_criterion",
    )?;
    let current = get_task(storage, owner.into())?;
    let criteria = current
        .criteria
        .iter()
        .filter(|criterion| criterion.id != request.criterion_id)
        .map(|criterion| types::CriterionInput::keep(criterion.id))
        .collect();
    update_task(
        storage,
        UpdateTask {
            status: None,
            refs: None,
            remove_refs: None,
            id: owner.into(),
            task_type: None,
            title: None,
            description: None,
            estimate: None,
            due_date: None,
            labels: None,
            autopilot: None,
            criteria: Some(criteria),
        },
    )
}

/// Checks or unchecks a manual criterion as the agent; checking needs evidence.
pub fn check_criterion(storage: &mut Storage, request: CheckCriterion) -> CommandResult<Task> {
    let met = request.met.unwrap_or(true);
    let evidence = request.evidence.as_deref().map(str::trim).unwrap_or("");
    if met && evidence.is_empty() {
        return Err(CommandError::invalid_input(
            "evidence must say what shows the criterion holds",
        ));
    }
    task_commands::check(
        storage,
        request.task_id,
        request.criterion_id,
        met,
        Some(evidence),
        CheckedBy::Agent,
    )
}

/// The dependent task after add_dependency or remove_dependency, with what the change
/// means for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReply {
    /// The dependent task with its links; `dependsOn` names each prerequisite's
    /// workspace, title, and status.
    pub task: TaskDetails,
    /// Whether this change paused the task.
    pub paused: bool,
    /// What the change means for the task and what to do next.
    pub message: String,
}

/// Adds the edges in one step and returns the dependent task. Self and cyclic edges and
/// `done` dependent tasks are rejected, and one rejected edge adds none. An `in_progress`
/// task that a prerequisite blocks is paused until the prerequisites are complete.
pub fn add_dependencies(
    storage: &mut Storage,
    request: AddDependencies,
) -> CommandResult<DependencyReply> {
    if request.depends_on.is_empty() {
        return Err(CommandError::invalid_input(
            "depends_on must name at least one task",
        ));
    }
    let depends_on: Vec<_> = request.depends_on.iter().map(|&id| id.into()).collect();
    let added = storage.add_dependencies(request.task_id.into(), &depends_on)?;
    let task = task_details(
        storage,
        GetTask {
            id: request.task_id,
        },
    )?;
    Ok(DependencyReply {
        message: dependency_message(&task, added.paused),
        paused: added.paused,
        task,
    })
}

/// Removes the edges to every task of `depends_on` and returns the dependent task. An
/// edge that does not exist is rejected, and then none is removed.
pub fn remove_dependency(
    storage: &mut Storage,
    request: Dependency,
) -> CommandResult<DependencyReply> {
    if request.depends_on.is_empty() {
        return Err(CommandError::invalid_input(
            "depends_on must name at least one task, e.g. {\"task_id\": 5, \"depends_on\": 3}",
        ));
    }
    let current = get_task(storage, request.task_id)?;
    if let Some(&missing) = request
        .depends_on
        .iter()
        .find(|id| !current.depends_on.contains(id))
    {
        return Err(StorageError::DependencyNotFound {
            task: request.task_id.into(),
            depends_on: missing.into(),
        }
        .into());
    }
    for &prerequisite in &request.depends_on {
        storage.remove_dependency(request.task_id.into(), prerequisite.into())?;
    }
    let task = task_details(
        storage,
        GetTask {
            id: request.task_id,
        },
    )?;
    Ok(DependencyReply {
        message: dependency_message(&task, false),
        paused: false,
        task,
    })
}

/// Appends a note of `kind` to the task's history and returns the task with its notes.
pub fn add_note(storage: &mut Storage, kind: NoteKind, request: AddNote) -> CommandResult<Task> {
    let note = request.note.trim();
    if note.is_empty() {
        return Err(CommandError::invalid_input("note must not be empty"));
    }
    let task = storage.add_task_note(request.task_id.into(), kind, note)?;
    Ok((&task).into())
}
