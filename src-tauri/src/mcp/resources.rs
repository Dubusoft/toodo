//! Tasks and their runs as MCP resources, and what a `subscriptions/listen` stream over
//! them reports.
//!
//! `toodo://tasks/{id}` is a task as get_task returns it, with its links, and
//! `toodo://tasks/{id}/runs` its runs, oldest first. `resources/list` lists the tasks that
//! are not done. A listen stream reads its resources again whenever the app announces a
//! change ([`super::Backend::changes`]) and at least every [`POLL`], since runs change
//! without an announcement, and reports each resource whose content changed, e.g. a task
//! it depends on that was completed.

use std::collections::BTreeMap;
use std::time::Duration;

use rmcp::model::{Resource, ResourceTemplate, SubscriptionFilter};
use tokio::sync::watch;

use super::Backend;
use super::tools::{self, GetTask};
use crate::commands::types;
use crate::commands::{CommandError, CommandErrorCode, CommandResult, lock};
use crate::domain::model;
use crate::domain::status::TaskStatus;
use crate::storage::{Storage, StorageError};

/// How often a listen stream reads its resources again without an announced change.
pub(super) const POLL: Duration = Duration::from_secs(5);

const TASKS: &str = "toodo://tasks/";
const RUNS: &str = "/runs";
const JSON: &str = "application/json";

/// A resource this server serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum Uri {
    Task(model::TaskId),
    Runs(model::TaskId),
}

impl Uri {
    /// Reads `toodo://tasks/{id}` or `toodo://tasks/{id}/runs`.
    pub(super) fn parse(uri: &str) -> Option<Self> {
        let rest = uri.strip_prefix(TASKS)?;
        let (id, runs) = match rest.strip_suffix(RUNS) {
            Some(id) => (id, true),
            None => (rest, false),
        };
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let id = model::TaskId(id.parse().ok()?);
        Some(if runs { Self::Runs(id) } else { Self::Task(id) })
    }

    fn task(id: model::TaskId) -> String {
        format!("{TASKS}{}", id.0)
    }
}

/// The URI templates of [`Uri`].
pub(super) fn templates() -> Vec<ResourceTemplate> {
    vec![
        ResourceTemplate::new(format!("{TASKS}{{task_id}}"), "task")
            .with_title("Toodo task")
            .with_description(
                "A task as get_task returns it: status timeline, notes, pull request, \
                 commits, and the tasks it depends on (ready and blockedBy), that depend on \
                 it, and that are related to it. Subscribe to it to learn when it changes, \
                 e.g. when a task it depends on is done.",
            )
            .with_mime_type(JSON),
        ResourceTemplate::new(format!("{TASKS}{{task_id}}{RUNS}"), "task-runs")
            .with_title("Runs of a Toodo task")
            .with_description(
                "The agent runs of a task, oldest first: state, exit code, activity, and \
                 token usage. Subscribe to it to learn when a run starts, ends, or reports \
                 activity.",
            )
            .with_mime_type(JSON),
    ]
}

/// The tasks that are not done, as resources, by task ID.
pub(super) fn list(storage: &Storage) -> CommandResult<Vec<Resource>> {
    let mut tasks = storage.list_all_tasks()?;
    tasks.retain(|task| task.status != TaskStatus::Done);
    tasks.sort_by_key(|task| task.id.0);
    Ok(tasks
        .into_iter()
        .map(|task| {
            Resource::new(Uri::task(task.id), format!("task-{}", task.id.0))
                .with_title(format!("#{} {}", task.id.0, task.title))
                .with_mime_type(JSON)
        })
        .collect())
}

/// The content of `uri` as JSON text.
pub(super) fn read(storage: &Storage, uri: Uri) -> CommandResult<String> {
    let value = match uri {
        Uri::Task(id) => {
            serde_json::to_value(tools::task_details(storage, GetTask { id: id.into() })?)
        }
        Uri::Runs(id) => {
            storage
                .get_task(id)?
                .ok_or(StorageError::TaskNotFound(id))?;
            let runs: Vec<types::TaskRun> = types::map_all(&storage.list_task_runs(id)?);
            serde_json::to_value(runs)
        }
    };
    let value =
        value.map_err(|error| CommandError::new(CommandErrorCode::Internal, error.to_string()))?;
    Ok(serde_json::to_string_pretty(&value).expect("a JSON value always serializes"))
}

/// Why `uri` names no resource of this server, with the URIs it does serve.
pub(super) fn unknown(uri: &str) -> String {
    format!(
        "{uri} is not a Toodo resource; read toodo://tasks/{{task_id}} or \
         toodo://tasks/{{task_id}}/runs with a task ID that search_tasks or list_tasks finds"
    )
}

/// What one listen stream watches, and what it last saw of it.
pub(super) struct Watch {
    watched: Vec<(String, Uri)>,
    /// Whether the stream watches the list of tasks that are not done.
    list: bool,
    pub(super) changes: watch::Receiver<()>,
    seen: Snapshot,
}

impl Watch {
    /// Starts watching the resources `filter` accepted, as they are now.
    pub(super) fn start(backend: &dyn Backend, filter: &SubscriptionFilter) -> Self {
        let watched: Vec<_> = filter
            .resource_subscriptions
            .iter()
            .flatten()
            .filter_map(|uri| Some((uri.clone(), Uri::parse(uri)?)))
            .collect();
        let list = filter.resources_list_changed == Some(true);
        // Subscribed before the first read, so a change during it is read again.
        let changes = backend.changes();
        let seen = Snapshot::take(&lock(backend.reader()), &watched, list);
        Self {
            watched,
            list,
            changes,
            seen,
        }
    }

    /// Reads the watched resources again: the URIs whose content changed since the last
    /// read, and whether the list of tasks that are not done changed.
    pub(super) fn next(&mut self, backend: &dyn Backend) -> (Vec<String>, bool) {
        let next = Snapshot::take(&lock(backend.reader()), &self.watched, self.list);
        let updated = next
            .contents
            .iter()
            .filter(|(uri, content)| self.seen.contents.get(*uri) != Some(content))
            .map(|(uri, _)| uri.clone())
            .collect();
        let list_changed = self.seen.open != next.open;
        self.seen = next;
        (updated, list_changed)
    }
}

struct Snapshot {
    /// The content of each watched resource; `None` while it cannot be read, e.g. its
    /// task was deleted.
    contents: BTreeMap<String, Option<String>>,
    /// The tasks that are not done, when the stream watches the list.
    open: Option<Vec<Resource>>,
}

impl Snapshot {
    fn take(storage: &Storage, watched: &[(String, Uri)], list: bool) -> Self {
        Self {
            contents: watched
                .iter()
                .map(|(text, uri)| (text.clone(), read(storage, *uri).ok()))
                .collect(),
            open: list.then(|| self::list(storage).unwrap_or_default()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uris_name_a_task_or_its_runs() {
        assert_eq!(
            Uri::parse("toodo://tasks/12"),
            Some(Uri::Task(model::TaskId(12)))
        );
        assert_eq!(
            Uri::parse("toodo://tasks/12/runs"),
            Some(Uri::Runs(model::TaskId(12)))
        );
        for other in [
            "toodo://tasks/",
            "toodo://tasks//runs",
            "toodo://tasks/-1",
            "toodo://tasks/12/commits",
            "toodo://tasks/#12",
            "file:///tasks/12",
        ] {
            assert_eq!(Uri::parse(other), None, "{other}");
        }
    }
}
