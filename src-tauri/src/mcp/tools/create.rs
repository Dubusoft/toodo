//! Creating tasks, alone or as a plan of linked tasks.

use std::collections::HashMap;

use super::get_task;
use super::requests::{CreatePlan, CreateTask, CreatedPlan, MAX_PLAN_TASKS, PlanTask, PlannedTask};
use crate::commands::types::{self, Task, TaskId};
use crate::commands::{CommandError, CommandErrorCode, CommandResult, StorageState, lock};
use crate::storage::{self, Storage, StorageError};

/// Creates a `planned` task with its dependencies. Unknown prerequisites are rejected
/// before anything is written; a new task has no dependents, so its edges cannot close
/// a cycle.
pub fn create_task(storage: &StorageState, request: CreateTask) -> CommandResult<Task> {
    insert_task(&mut lock(storage), request)
}

/// Creates every task of `request` with its dependencies and related links in one
/// transaction. Keys, links, criteria, and labels are checked before anything is
/// written, and a failure names the task of the plan it is about; any failure creates
/// nothing.
pub fn create_plan(storage: &StorageState, request: CreatePlan) -> CommandResult<CreatedPlan> {
    let count = request.tasks.len();
    if count == 0 || count > MAX_PLAN_TASKS {
        return Err(CommandError::invalid_input(format!(
            "create_plan takes 1 to {MAX_PLAN_TASKS} tasks, got {count}; split a larger plan into several create_plan calls and link a later call's tasks to created ones by id in depends_on"
        )));
    }
    let keys = plan_keys(&request.tasks)?;
    let mut depends_on = Vec::with_capacity(count);
    let mut related = Vec::with_capacity(count);
    for (index, item) in request.tasks.iter().enumerate() {
        let existing = |ids: &[TaskId]| {
            ids.iter()
                .map(|&id| storage::PlanLink::Existing(id.into()))
                .collect::<Vec<_>>()
        };
        let mut links = existing(&item.depends_on);
        links.extend(plan_links(
            &keys,
            index,
            item,
            "depends_on",
            &item.depends_on_keys,
        )?);
        depends_on.push(links);
        let mut links = existing(&item.related);
        links.extend(plan_links(
            &keys,
            index,
            item,
            "related",
            &item.related_keys,
        )?);
        related.push(links);
    }
    check_plan_order(&request.tasks, &depends_on)?;
    let mut plan = Vec::with_capacity(count);
    for ((item, depends_on), related) in request.tasks.iter().zip(depends_on).zip(related) {
        let in_item = |mut error: CommandError| {
            error.message = format!("task `{}` of the plan: {}", item.key, error.message);
            error
        };
        let mut task = plan_task(item).map_err(in_item)?;
        task.depends_on = depends_on;
        task.related = related;
        plan.push(task);
    }
    // The checks and the writes share one lock, so a workspace or task archived in
    // between cannot slip past the checks.
    let mut storage = lock(storage);
    for item in &request.tasks {
        if storage.get_workspace(item.workspace_id.into())?.is_none() {
            return Err(CommandError::new(
                CommandErrorCode::WorkspaceNotFound,
                format!(
                    "task `{}` of the plan is in workspace {}, which does not exist; take a workspace id from list_workspaces",
                    item.key, item.workspace_id.0
                ),
            ));
        }
        for &id in item.depends_on.iter().chain(&item.related) {
            if storage.get_task(id.into())?.is_none() {
                return Err(CommandError::not_found(format!(
                    "task `{}` of the plan links to task {}, which does not exist; find the task with search_tasks, or link a task of the plan by its key in depends_on_keys or related_keys",
                    item.key, id.0
                )));
            }
        }
    }
    let created = storage.create_tasks(&plan)?;
    let tasks = request
        .tasks
        .into_iter()
        .zip(created)
        .map(|(item, task)| {
            Ok(PlannedTask {
                key: item.key,
                task: get_task(&storage, task.id.into())?,
            })
        })
        .collect::<CommandResult<_>>()?;
    Ok(CreatedPlan { tasks })
}

/// The index of each key of `tasks`, rejecting empty and repeated keys.
fn plan_keys(tasks: &[PlanTask]) -> CommandResult<HashMap<&str, usize>> {
    let mut keys = HashMap::with_capacity(tasks.len());
    for (index, item) in tasks.iter().enumerate() {
        if item.key.trim().is_empty() {
            return Err(CommandError::invalid_input(format!(
                "task {} of the plan (\"{}\") has no key; give every task of the plan its own key, e.g. \"schema\"",
                index + 1,
                item.title
            )));
        }
        if keys.insert(item.key.as_str(), index).is_some() {
            return Err(CommandError::invalid_input(format!(
                "more than one task of the plan has the key `{}`; give each task its own key",
                item.key
            )));
        }
    }
    Ok(keys)
}

/// The links that `names`, the `{field}_keys` of the task at `index`, make to other tasks
/// of the plan.
fn plan_links(
    keys: &HashMap<&str, usize>,
    index: usize,
    item: &PlanTask,
    field: &str,
    names: &[String],
) -> CommandResult<Vec<storage::PlanLink>> {
    names
        .iter()
        .map(|name| match keys.get(name.as_str()) {
            Some(&linked) if linked == index => Err(CommandError::invalid_input(format!(
                "task `{name}` of the plan names itself in {field}_keys; remove `{name}` from them"
            ))),
            Some(&linked) => Ok(storage::PlanLink::New(linked)),
            None => Err(CommandError::invalid_input(format!(
                "task `{}` of the plan names `{name}` in {field}_keys, but no task of the plan has that key; use the key of a task in tasks, or put the id of an existing task in {field}",
                item.key
            ))),
        })
        .collect()
}

/// Rejects dependencies between tasks of the plan that form a cycle, naming its tasks.
/// Existing tasks cannot depend on new ones, so no other cycle is possible.
fn check_plan_order(
    tasks: &[PlanTask],
    depends_on: &[Vec<storage::PlanLink>],
) -> CommandResult<()> {
    let mut waiting: Vec<usize> = depends_on
        .iter()
        .map(|links| {
            links
                .iter()
                .filter(|link| matches!(link, storage::PlanLink::New(_)))
                .count()
        })
        .collect();
    let mut done: Vec<usize> = (0..tasks.len()).filter(|&i| waiting[i] == 0).collect();
    let mut next = 0;
    while let Some(&finished) = done.get(next) {
        next += 1;
        for (index, links) in depends_on.iter().enumerate() {
            let edges = links
                .iter()
                .filter(|&&link| link == storage::PlanLink::New(finished))
                .count();
            if edges > 0 {
                waiting[index] -= edges;
                if waiting[index] == 0 {
                    done.push(index);
                }
            }
        }
    }
    if done.len() == tasks.len() {
        return Ok(());
    }
    let cycle: Vec<String> = (0..tasks.len())
        .filter(|&index| waiting[index] > 0)
        .map(|index| format!("`{}`", tasks[index].key))
        .collect();
    Err(CommandError::rejected(format!(
        "the depends_on_keys of tasks {} of the plan form a cycle, so none of them could ever start; remove a key from one of them so every task has prerequisites that finish first",
        cycle.join(", ")
    )))
}

/// The task `item` of a plan creates, with its labels and without links.
fn plan_task(item: &PlanTask) -> CommandResult<storage::NewPlanTask> {
    let labels = types::labels(&item.labels)?;
    let refs = types::merge_refs(&[], &item.refs, &[])?;
    let task: storage::NewTask = types::NewTask {
        workspace_id: item.workspace_id,
        task_type: item.task_type,
        title: item.title.clone(),
        description: item.description.clone(),
        estimate: item.estimate,
        due_date: item.due_date.clone(),
        labels: Vec::new(),
        autopilot: item.autopilot,
        criteria: item.criteria.clone(),
    }
    .try_into()?;
    Ok(storage::NewPlanTask {
        task,
        labels,
        refs,
        depends_on: Vec::new(),
        related: Vec::new(),
    })
}

/// Creates the task of `request` with its labels, refs, dependencies, and related links
/// in one transaction, as a plan of one task: any failure writes nothing.
pub(super) fn insert_task(storage: &mut Storage, request: CreateTask) -> CommandResult<Task> {
    for &linked in request.depends_on.iter().chain(&request.related) {
        storage
            .get_task(linked.into())?
            .ok_or(StorageError::TaskNotFound(linked.into()))?;
    }
    let existing = |ids: &[TaskId]| {
        ids.iter()
            .map(|&id| storage::PlanLink::Existing(id.into()))
            .collect::<Vec<_>>()
    };
    let depends_on = existing(&request.depends_on);
    let related = existing(&request.related);
    let mut task = plan_task(&PlanTask {
        key: String::new(),
        workspace_id: request.workspace_id,
        task_type: request.task_type,
        title: request.title,
        description: request.description,
        depends_on: Vec::new(),
        depends_on_keys: Vec::new(),
        related: Vec::new(),
        related_keys: Vec::new(),
        estimate: request.estimate,
        due_date: request.due_date,
        labels: request.labels,
        refs: request.refs,
        autopilot: request.autopilot,
        criteria: request.criteria,
    })?;
    task.depends_on = depends_on;
    task.related = related;
    let created = storage.create_tasks(&[task])?;
    get_task(storage, created[0].id.into())
}
