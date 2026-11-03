//! Rules for the task dependency DAG: edge validation (no self or cyclic edges), readiness,
//! and topological order. The DAG spans all workspaces: a task may depend on a task of
//! another workspace, such as a library change that an application change needs first.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;

use super::model::{Task, TaskId, TaskResolution};
use super::status::TaskStatus;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DependencyError {
    UnknownTask(TaskId),
    SelfDependency(TaskId),
    /// The tasks along a dependency loop, starting and ending with the same task. Each
    /// task depends on the one after it.
    Cycle(Vec<TaskId>),
}

impl fmt::Display for DependencyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownTask(id) => write!(f, "unknown task {id}"),
            Self::SelfDependency(id) => write!(f, "task {id} cannot depend on itself"),
            Self::Cycle(path) => {
                let ids: Vec<String> = path.iter().map(TaskId::to_string).collect();
                write!(f, "dependency cycle: {}", ids.join(" -> "))?;
                // Each task depends on the next one, so the last edge is the existing one
                // that closes the loop.
                if let [.., waiting, prerequisite] = path.as_slice() {
                    write!(
                        f,
                        "; task {waiting} already depends on {prerequisite}. task_id is the task that waits, depends_on its prerequisites; did you swap them?"
                    )?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for DependencyError {}

fn index(tasks: &[Task]) -> HashMap<TaskId, &Task> {
    tasks.iter().map(|task| (task.id, task)).collect()
}

pub fn validate_dependency(
    tasks: &[Task],
    task: TaskId,
    depends_on: TaskId,
) -> Result<(), DependencyError> {
    if task == depends_on {
        return Err(DependencyError::SelfDependency(task));
    }
    let by_id = index(tasks);
    for id in [task, depends_on] {
        if !by_id.contains_key(&id) {
            return Err(DependencyError::UnknownTask(id));
        }
    }
    if let Some(path) = dependency_path(&by_id, depends_on, task) {
        let mut cycle = vec![task];
        cycle.extend(path);
        return Err(DependencyError::Cycle(cycle));
    }
    Ok(())
}

/// Path from `from` to `to` following `depends_on` edges, both ends included.
fn dependency_path(
    by_id: &HashMap<TaskId, &Task>,
    from: TaskId,
    to: TaskId,
) -> Option<Vec<TaskId>> {
    let mut parent: HashMap<TaskId, TaskId> = HashMap::new();
    let mut visited = HashSet::from([from]);
    let mut stack = vec![from];
    while let Some(current) = stack.pop() {
        if current == to {
            let mut path = vec![to];
            let mut node = to;
            while let Some(&previous) = parent.get(&node) {
                path.push(previous);
                node = previous;
            }
            path.reverse();
            return Some(path);
        }
        let Some(task) = by_id.get(&current) else {
            continue;
        };
        for &next in &task.depends_on {
            if visited.insert(next) {
                parent.insert(next, current);
                stack.push(next);
            }
        }
    }
    None
}

/// A dependency that keeps a task from starting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockingDependency {
    pub id: TaskId,
    pub status: TaskStatus,
    pub resolution: Option<TaskResolution>,
}

fn blocking(
    by_id: &HashMap<TaskId, &Task>,
    task: &Task,
) -> Result<Vec<BlockingDependency>, DependencyError> {
    let mut blockers = Vec::new();
    for dependency in &task.depends_on {
        let dependency = by_id
            .get(dependency)
            .ok_or(DependencyError::UnknownTask(*dependency))?;
        // Merged and completed work can be built on; work not adopted cannot.
        if dependency.status != TaskStatus::Done
            || dependency.resolution == Some(TaskResolution::NotAdopted)
        {
            blockers.push(BlockingDependency {
                id: dependency.id,
                status: dependency.status,
                resolution: dependency.resolution,
            });
        }
    }
    Ok(blockers)
}

/// The dependencies of `task` that keep it from starting: not done, or done as not
/// adopted. Empty when the task is ready.
pub fn blocking_dependencies(
    tasks: &[Task],
    task: TaskId,
) -> Result<Vec<BlockingDependency>, DependencyError> {
    let by_id = index(tasks);
    let task = by_id.get(&task).ok_or(DependencyError::UnknownTask(task))?;
    blocking(&by_id, task)
}

/// Whether all dependencies of `task` are done and none of them was concluded without
/// being adopted, so it can be started.
pub fn is_ready(tasks: &[Task], task: TaskId) -> Result<bool, DependencyError> {
    let by_id = index(tasks);
    let task = by_id.get(&task).ok_or(DependencyError::UnknownTask(task))?;
    Ok(blocking(&by_id, task)?.is_empty())
}

/// Orders tasks so that every task comes after its dependencies. Ties are broken by
/// task ID, so the order is deterministic.
pub fn topological_order(tasks: &[Task]) -> Result<Vec<TaskId>, DependencyError> {
    let by_id = index(tasks);
    let mut pending: BTreeMap<TaskId, usize> = BTreeMap::new();
    let mut dependents: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    for task in tasks {
        for dependency in &task.depends_on {
            if !by_id.contains_key(dependency) {
                return Err(DependencyError::UnknownTask(*dependency));
            }
            dependents.entry(*dependency).or_default().push(task.id);
        }
        pending.insert(task.id, task.depends_on.len());
    }

    let mut available: BTreeSet<TaskId> = pending
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut order = Vec::with_capacity(tasks.len());
    while let Some(id) = available.pop_first() {
        pending.remove(&id);
        order.push(id);
        for dependent in dependents.get(&id).into_iter().flatten() {
            let count = pending
                .get_mut(dependent)
                .expect("dependent tasks are pending until all dependencies are ordered");
            *count -= 1;
            if *count == 0 {
                available.insert(*dependent);
            }
        }
    }

    if pending.is_empty() {
        Ok(order)
    } else {
        Err(DependencyError::Cycle(find_cycle(&by_id, &pending)))
    }
}

/// Walks unordered tasks along unordered dependencies until a task repeats. Every
/// unordered task has at least one unordered dependency, so the walk always loops.
fn find_cycle(by_id: &HashMap<TaskId, &Task>, unordered: &BTreeMap<TaskId, usize>) -> Vec<TaskId> {
    let mut position: HashMap<TaskId, usize> = HashMap::new();
    let mut walk = Vec::new();
    let mut current = *unordered
        .keys()
        .next()
        .expect("find_cycle is only called with unordered tasks");
    loop {
        if let Some(&start) = position.get(&current) {
            let mut cycle = walk[start..].to_vec();
            cycle.push(current);
            return cycle;
        }
        position.insert(current, walk.len());
        walk.push(current);
        current = *by_id[&current]
            .depends_on
            .iter()
            .find(|dependency| unordered.contains_key(dependency))
            .expect("an unordered task has an unordered dependency");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::{TaskType, WorkspaceId};

    fn task(id: i64, status: TaskStatus, depends_on: &[i64]) -> Task {
        Task {
            id: TaskId(id),
            workspace_id: WorkspaceId(1),
            task_type: TaskType::Feat,
            title: format!("Task {id}"),
            description: String::new(),
            status,
            depends_on: depends_on.iter().copied().map(TaskId).collect(),
            branch: None,
            worktree_path: None,
            herdr_workspace_id: None,
            pull_request_url: None,
            pull_request_merged_at: None,
            pull_request: None,
            resolution: None,
            merged_with: None,
            completion_note: None,
            estimate: None,
            due_date: None,
            issue: None,
            timeline: Vec::new(),
            notes: Vec::new(),
            criteria: Vec::new(),
        }
    }

    fn ids(raw: &[i64]) -> Vec<TaskId> {
        raw.iter().copied().map(TaskId).collect()
    }

    use TaskStatus::*;

    #[test]
    fn valid_dependency_is_accepted() {
        let tasks = [
            task(1, Done, &[]),
            task(2, Planned, &[1]),
            task(3, Planned, &[]),
        ];
        assert_eq!(validate_dependency(&tasks, TaskId(3), TaskId(2)), Ok(()));
        assert_eq!(validate_dependency(&tasks, TaskId(3), TaskId(1)), Ok(()));
    }

    #[test]
    fn self_dependency_is_rejected() {
        let tasks = [task(1, Planned, &[])];
        assert_eq!(
            validate_dependency(&tasks, TaskId(1), TaskId(1)),
            Err(DependencyError::SelfDependency(TaskId(1)))
        );
    }

    #[test]
    fn direct_cycle_is_rejected() {
        let tasks = [task(1, Planned, &[2]), task(2, Planned, &[])];
        assert_eq!(
            validate_dependency(&tasks, TaskId(2), TaskId(1)),
            Err(DependencyError::Cycle(ids(&[2, 1, 2])))
        );
    }

    #[test]
    fn indirect_cycle_is_rejected_with_its_path() {
        let tasks = [
            task(1, Planned, &[2]),
            task(2, Planned, &[3]),
            task(3, Planned, &[]),
            task(4, Planned, &[1]),
        ];
        let error = validate_dependency(&tasks, TaskId(3), TaskId(1)).unwrap_err();
        assert_eq!(error, DependencyError::Cycle(ids(&[3, 1, 2, 3])));
        assert_eq!(
            error.to_string(),
            "dependency cycle: 3 -> 1 -> 2 -> 3; task 2 already depends on 3. task_id is the task that waits, depends_on its prerequisites; did you swap them?"
        );
    }

    #[test]
    fn blocking_dependencies_skip_merged_and_completed_and_list_the_rest() {
        let mut merged = task(1, Done, &[]);
        merged.resolution = Some(TaskResolution::Merged);
        let mut legacy = task(2, Done, &[]);
        legacy.resolution = None;
        let mut not_adopted = task(3, Done, &[]);
        not_adopted.resolution = Some(TaskResolution::NotAdopted);
        let mut completed = task(6, Done, &[]);
        completed.resolution = Some(TaskResolution::Completed);
        let tasks = [
            merged,
            legacy,
            not_adopted,
            task(4, Planned, &[]),
            task(5, Planned, &[1, 2, 3, 4, 6]),
            completed,
            task(7, Planned, &[1, 6]),
        ];
        assert_eq!(
            blocking_dependencies(&tasks, TaskId(5)),
            Ok(vec![
                BlockingDependency {
                    id: TaskId(3),
                    status: Done,
                    resolution: Some(TaskResolution::NotAdopted),
                },
                BlockingDependency {
                    id: TaskId(4),
                    status: Planned,
                    resolution: None,
                },
            ])
        );
        assert_eq!(blocking_dependencies(&tasks, TaskId(4)), Ok(Vec::new()));
        assert!(is_ready(&tasks, TaskId(7)).unwrap());
    }

    #[test]
    fn cross_workspace_dependencies_are_accepted_and_unknown_ones_rejected() {
        let mut other = task(2, Done, &[]);
        other.workspace_id = WorkspaceId(2);
        let tasks = [task(1, Planned, &[]), other];
        assert_eq!(validate_dependency(&tasks, TaskId(1), TaskId(2)), Ok(()));
        assert_eq!(
            validate_dependency(&tasks, TaskId(9), TaskId(1)),
            Err(DependencyError::UnknownTask(TaskId(9)))
        );
        assert_eq!(
            validate_dependency(&tasks, TaskId(1), TaskId(9)),
            Err(DependencyError::UnknownTask(TaskId(9)))
        );
    }

    #[test]
    fn task_is_ready_only_when_all_dependencies_are_done() {
        let tasks = [
            task(1, Done, &[]),
            task(2, InProgress, &[]),
            task(3, InReview, &[]),
            task(4, Planned, &[1]),
            task(5, Planned, &[1, 2]),
            task(6, Planned, &[3]),
            task(7, Planned, &[]),
        ];
        let ready: Vec<bool> = (4..=7)
            .map(|id| is_ready(&tasks, TaskId(id)).unwrap())
            .collect();
        assert_eq!(ready, [true, false, false, true]);
    }

    #[test]
    fn a_dependency_that_was_not_adopted_keeps_its_dependents_waiting() {
        let mut merged = task(1, Done, &[]);
        merged.resolution = Some(TaskResolution::Merged);
        let mut not_adopted = task(2, Done, &[]);
        not_adopted.resolution = Some(TaskResolution::NotAdopted);
        let tasks = [
            merged,
            not_adopted,
            task(3, Planned, &[1]),
            task(4, Planned, &[1, 2]),
        ];
        assert!(is_ready(&tasks, TaskId(3)).unwrap());
        assert!(!is_ready(&tasks, TaskId(4)).unwrap());
    }

    #[test]
    fn topological_order_puts_dependencies_first_and_breaks_ties_by_id() {
        let tasks = [
            task(5, Planned, &[3, 4]),
            task(4, Planned, &[1]),
            task(3, Planned, &[1]),
            task(2, Planned, &[]),
            task(1, Planned, &[]),
        ];
        assert_eq!(topological_order(&tasks).unwrap(), ids(&[1, 2, 3, 4, 5]));
        assert_eq!(topological_order(&[]).unwrap(), ids(&[]));
    }

    #[test]
    fn topological_order_reports_a_stored_cycle() {
        let tasks = [
            task(1, Planned, &[]),
            task(2, Planned, &[1, 4]),
            task(3, Planned, &[2]),
            task(4, Planned, &[3]),
            task(5, Planned, &[4]),
        ];
        assert_eq!(
            topological_order(&tasks),
            Err(DependencyError::Cycle(ids(&[2, 4, 3, 2])))
        );
        assert_eq!(
            topological_order(&[task(1, Planned, &[7])]),
            Err(DependencyError::UnknownTask(TaskId(7)))
        );
    }
}
