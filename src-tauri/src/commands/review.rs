//! Commands for reviewing the work done in a period, such as a week or a year.

use super::State;

use super::types::{ReviewEntry, Task, Timestamp};
use super::{CommandError, CommandResult, StorageState, lock};
use crate::domain::review::{self, Period};
use crate::storage::Storage;

/// Tasks of every workspace that reached a milestone or got a commit in `[start, end)`,
/// ordered by outcome, then by time. The caller picks the period, such as a week, a
/// month, or a year in the local time zone.
#[specta::specta]
pub fn review_period(
    storage: State<'_, StorageState>,
    start: Timestamp,
    end: Timestamp,
) -> CommandResult<Vec<ReviewEntry>> {
    review_entries(&lock(&storage), start, end)
}

fn review_entries(
    storage: &Storage,
    start: Timestamp,
    end: Timestamp,
) -> CommandResult<Vec<ReviewEntry>> {
    let period = Period::new(start.0, end.0)
        .map_err(|error| CommandError::invalid_input(error.to_string()))?;
    let mut tasks = Vec::new();
    for workspace in storage.list_workspaces()? {
        tasks.extend(storage.list_tasks(workspace.id)?);
    }
    let commits = storage.list_commit_records_in(period)?;
    Ok(review::review(period, &tasks, &commits)
        .into_iter()
        .map(|reviewed| {
            let task = tasks
                .iter()
                .find(|task| task.id == reviewed.task_id)
                .expect("a review entry belongs to a reviewed task");
            ReviewEntry {
                task: Task::from(task),
                outcome: reviewed.outcome.into(),
                at: Timestamp(reviewed.at),
                commits: reviewed.commits.iter().map(Into::into).collect(),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::CommandErrorKind;
    use crate::commands::types::ReviewOutcome;
    use crate::domain::model::{CommitRecord, TaskType, WorkspaceLocation};
    use crate::domain::path::WindowsPath;
    use crate::domain::status::TaskStatus;
    use crate::storage::{NewTask, NewWorkspace};

    #[test]
    fn reviews_tasks_of_every_workspace_and_rejects_an_empty_period() {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(|| 500);
        let mut add_task = |name: &str| {
            let workspace = storage
                .create_workspace(&NewWorkspace {
                    name: name.to_owned(),
                    location: WorkspaceLocation::Local {
                        path: WindowsPath::parse(&format!(r"C:\dev\{name}"))
                            .unwrap()
                            .into(),
                    },
                    default_base_branch: "main".to_owned(),
                })
                .unwrap();
            storage
                .create_task(&NewTask {
                    workspace_id: workspace.id,
                    task_type: TaskType::Feat,
                    title: format!("Work on {name}"),
                    description: String::new(),
                    estimate: None,
                    due_date: None,
                    criteria: Vec::new(),
                })
                .unwrap()
        };
        let started = add_task("toodo");
        let committed = add_task("herdr");
        storage
            .set_task_status(started.id, TaskStatus::InProgress)
            .unwrap();
        let record = CommitRecord {
            task_id: committed.id,
            sha: "abc".to_owned(),
            message: "Add herdr".to_owned(),
            author: "Dev <dev@example.com>".to_owned(),
            committed_at: 1500,
        };
        storage
            .replace_commit_records(committed.id, std::slice::from_ref(&record))
            .unwrap();

        let entries = review_entries(&storage, Timestamp(1000), Timestamp(2000)).unwrap();
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.task.title.as_str(), entry.outcome, entry.at.0))
            .collect();
        assert_eq!(summary, [("Work on herdr", ReviewOutcome::WorkedOn, 1500)]);
        assert_eq!(entries[0].commits, [(&record).into()]);

        let entries = review_entries(&storage, Timestamp(0), Timestamp(1000)).unwrap();
        let summary: Vec<_> = entries
            .iter()
            .map(|entry| (entry.task.title.as_str(), entry.outcome))
            .collect();
        assert_eq!(
            summary,
            [
                ("Work on toodo", ReviewOutcome::Started),
                ("Work on herdr", ReviewOutcome::Planned),
            ]
        );

        let error = review_entries(&storage, Timestamp(10), Timestamp(10)).unwrap_err();
        assert_eq!(error.kind, CommandErrorKind::InvalidInput);
    }
}
