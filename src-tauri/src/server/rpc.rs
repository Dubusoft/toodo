//! `POST /api/rpc/<command>`: runs one of the commands of the frontend's generated
//! bindings (see `bindings.rs`), with their JSON arguments (camelCase keys) and JSON
//! result.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::Services;
use crate::commands::events::Notifier as _;
use crate::commands::types::{
    BackupSettings, CriterionId, Guideline, GuidelineId, GuidelineUpdate, NewGuideline, NewTask,
    NewWorkspace, OAuthGrantId, ReviewReportRequest, ReviewSnapshotId, SaveReviewSnapshotRequest,
    TaskEdit, TaskId, TaskListFilter, TaskResolution, Timestamp, Workspace, WorkspaceId,
};
use crate::commands::{
    CommandError, CommandErrorCode, CommandErrorKind, CommandResult, State, backup, completion,
    guidelines, issues, mcp, review, tasks, workspaces,
};
use crate::mcp::Backend as _;

/// What running a command gave.
#[derive(Debug)]
pub enum Reply {
    /// The command's result, as JSON.
    Done(serde_json::Value),
    /// The command failed; the frontend gets the command's error.
    Failed(CommandError),
    /// No command has this name.
    UnknownCommand,
    /// The arguments do not match the command's parameters.
    BadArguments(String),
}

impl Reply {
    pub(super) fn value(value: impl Serialize) -> Self {
        match serde_json::to_value(value) {
            Ok(value) => Self::Done(value),
            Err(error) => Self::Failed(CommandError::internal(format!(
                "could not encode the result: {error}"
            ))),
        }
    }

    pub(super) fn result(result: CommandResult<impl Serialize>) -> Self {
        match result {
            Ok(value) => Self::value(value),
            Err(error) => Self::Failed(error),
        }
    }
}

impl IntoResponse for Reply {
    fn into_response(self) -> Response {
        match self {
            Self::Done(value) => json(StatusCode::OK, &value),
            Self::Failed(error) => {
                let status = match error.kind {
                    CommandErrorKind::InvalidInput => StatusCode::UNPROCESSABLE_ENTITY,
                    CommandErrorKind::NotFound => StatusCode::NOT_FOUND,
                    CommandErrorKind::Rejected => StatusCode::CONFLICT,
                    CommandErrorKind::External => StatusCode::BAD_GATEWAY,
                    CommandErrorKind::Internal => StatusCode::INTERNAL_SERVER_ERROR,
                };
                json(status, &error)
            }
            Self::UnknownCommand => json(
                StatusCode::NOT_FOUND,
                &CommandError::new(
                    CommandErrorCode::UnknownCommand,
                    "unknown command; reload the web app so that it matches the server's \
                     version",
                ),
            ),
            Self::BadArguments(message) => json(
                StatusCode::BAD_REQUEST,
                &CommandError::new(
                    CommandErrorCode::InvalidArguments,
                    format!(
                        "invalid arguments: {message}; reload the web app so that it matches \
                         the server's version"
                    ),
                ),
            ),
        }
    }
}

pub(super) fn json(status: StatusCode, body: &impl Serialize) -> Response {
    match serde_json::to_vec(body) {
        Ok(body) => (status, [(header::CONTENT_TYPE, "application/json")], body).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

pub async fn handle(
    axum::extract::State(services): axum::extract::State<Arc<Services>>,
    Path(command): Path<String>,
    body: Bytes,
) -> Reply {
    let args = if body.is_empty() {
        serde_json::Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_slice(&body) {
            Ok(args) => args,
            Err(error) => return Reply::BadArguments(error.to_string()),
        }
    };
    let reply = dispatch(services.clone(), &command, args).await;
    if !READ_COMMANDS.contains(&command.as_str()) {
        services.announce_status_changes();
    }
    // Changes the user makes in the app are not news to them: notifications only report
    // what changed on its own (agents, pull requests, background checks).
    services.push.tasks_seen();
    reply
}

fn parse<T: DeserializeOwned>(args: serde_json::Value) -> Result<T, Reply> {
    let args = match args {
        serde_json::Value::Null => serde_json::Value::Object(serde_json::Map::new()),
        args => args,
    };
    serde_json::from_value(args).map_err(|error| Reply::BadArguments(error.to_string()))
}

/// Announces a change of a guideline to connected clients, with its workspace.
fn guidelines_changed(
    services: &Services,
    result: CommandResult<Guideline>,
) -> CommandResult<Guideline> {
    if let Ok(guideline) = &result {
        services.guidelines_changed(guideline.workspace_id.into());
    }
    result
}

/// Runs a command that blocks (git, gh, herdr, or the database) off the async threads.
async fn blocking(run: impl FnOnce() -> Reply + Send + 'static) -> Reply {
    tokio::task::spawn_blocking(run)
        .await
        .unwrap_or_else(|error| Reply::Failed(CommandError::panicked(error)))
}

/// Declares the commands: each has a name, its parameters (the JSON arguments), and how it
/// runs, `sync` on a blocking thread or `async` on the runtime. `$s` names the services in
/// the calls. Also lists the names in `COMMANDS`.
macro_rules! commands {
    ($s:ident => { $( $name:literal ( $($field:ident : $ty:ty),* ) => $mode:ident $call:expr ; )* }) => {
        #[cfg(test)]
        pub const COMMANDS: &[&str] = &[$($name),*];

        pub async fn dispatch(
            services: Arc<Services>,
            command: &str,
            args: serde_json::Value,
        ) -> Reply {
            match command {
                $( $name => {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args { $($field: $ty),* }
                    let Args { $($field),* } = match parse::<Args>(args) {
                        Ok(args) => args,
                        Err(reply) => return reply,
                    };
                    commands!(@$mode services, $s, $call)
                } )*
                _ => Reply::UnknownCommand,
            }
        }
    };
    (@sync $services:ident, $s:ident, $call:expr) => {
        blocking(move || {
            #[allow(unused_variables)]
            let $s: &Services = &$services;
            $call
        })
        .await
    };
    (@async $services:ident, $s:ident, $call:expr) => {{
        #[allow(unused_variables)]
        let $s: &Services = &$services;
        $call
    }};
}

/// The commands a read-only device may run: they only read. `mcp_server_info` is left out
/// because it shows the MCP token, which can change data.
pub const READ_COMMANDS: &[&str] = &[
    "app_info",
    "check_update",
    "list_connected_apps",
    "list_workspaces",
    "get_workspace",
    "list_tasks",
    "list_task_relations",
    "get_task",
    "review_period",
    "list_archive",
    "list_guidelines",
    "review_report",
    "get_review_time_zone",
    "list_review_snapshots",
    "get_review_snapshot",
    "get_backup_settings",
    "list_backups",
];

commands!(s => {
    "app_info"() => sync Reply::value(crate::commands::app_info());
    "check_update"() => async Reply::value(crate::commands::updates::check_update().await);
    "list_connected_apps"() => sync Reply::result(
        mcp::list_connected_apps(State(s.reader()), State(&s.public_url))
    );
    "revoke_connected_app"(grant_id: OAuthGrantId) => sync Reply::result(
        mcp::revoke_connected_app(State(&s.storage), grant_id)
    );

    "list_workspaces"() => sync Reply::result(workspaces::list_workspaces(State(s.reader())));
    "get_workspace"(id: WorkspaceId) => sync Reply::result(workspaces::get_workspace(State(s.reader()), id));
    "create_workspace"(workspace: NewWorkspace) => sync Reply::result(
        workspaces::create_workspace(State(&s.storage), workspace)
    );
    "update_workspace"(workspace: Workspace) => sync Reply::result(
        workspaces::update_workspace(State(&s.storage), workspace)
    );
    "delete_workspace"(id: WorkspaceId) => sync Reply::result(workspaces::delete_workspace(State(&s.storage), id));
    "restore_workspace"(id: WorkspaceId) => sync Reply::result(workspaces::restore_workspace(State(&s.storage), id));
    "purge_workspace"(id: WorkspaceId) => sync Reply::result(workspaces::purge_workspace(State(&s.storage), id));
    "list_archive"() => sync Reply::result(workspaces::list_archive(State(s.reader())));
    "list_guidelines"(workspace_id: WorkspaceId) => sync Reply::result(
        guidelines::list_guidelines(State(s.reader()), workspace_id)
    );
    "add_guideline"(guideline: NewGuideline) => sync Reply::result(guidelines_changed(
        s,
        guidelines::add_guideline(State(&s.storage), guideline),
    ));
    "update_guideline"(guideline: GuidelineUpdate) => sync Reply::result(guidelines_changed(
        s,
        guidelines::update_guideline(State(&s.storage), guideline),
    ));
    "delete_guideline"(id: GuidelineId) => sync Reply::result(guidelines_changed(
        s,
        guidelines::delete_guideline(State(&s.storage), id),
    ));
    "list_tasks"(filter: Option<TaskListFilter>) => sync Reply::result(
        tasks::list_tasks(State(s.reader()), filter)
    );
    "list_task_relations"() => sync Reply::result(tasks::list_task_relations(State(s.reader())));
    "add_task_relation"(task_id: TaskId, related_id: TaskId) => sync Reply::result(
        tasks::add_task_relation(State(&s.storage), task_id, related_id)
    );
    "remove_task_relation"(task_id: TaskId, related_id: TaskId) => sync Reply::result(
        tasks::remove_task_relation(State(&s.storage), task_id, related_id)
    );
    "get_task"(id: TaskId) => sync Reply::result(tasks::get_task(State(s.reader()), id));
    "create_task"(task: NewTask) => sync Reply::result(
        tasks::create_task(State(&s.storage), task)
    );
    "check_criterion"(task_id: TaskId, criterion_id: CriterionId, met: bool, evidence: Option<String>) => sync Reply::result(
        tasks::check_criterion(State(&s.storage), task_id, criterion_id, met, evidence)
    );
    "update_task"(task: TaskEdit) => sync Reply::result(
        tasks::update_task(State(&s.storage), task)
    );
    "move_task"(id: TaskId, workspace_id: WorkspaceId) => sync Reply::result(
        tasks::move_task(State(&s.storage), id, workspace_id)
    );
    "pause_task"(id: TaskId) => sync Reply::result(tasks::pause_task(State(&s.storage), id));
    "wait_task"(id: TaskId, until: Timestamp, reason: Option<String>) => sync Reply::result(
        tasks::wait_task(State(&s.storage), id, until, reason)
    );
    "end_wait"(id: TaskId) => sync Reply::result(tasks::end_wait(State(&s.storage), id));
    "set_completion_note"(id: TaskId, note: String) => sync Reply::result(
        tasks::set_completion_note(State(&s.storage), id, note)
    );
    "reopen_task"(id: TaskId, reason: String) => sync Reply::result(
        tasks::reopen_task(State(&s.storage), id, reason)
    );
    "set_task_outcome"(id: TaskId, resolution: TaskResolution, note: String) => sync Reply::result(
        tasks::set_task_outcome(State(&s.storage), id, resolution, note)
    );
    "delete_task"(id: TaskId) => sync Reply::result(
        tasks::delete_task(State(&s.storage), id)
    );
    "delete_done_tasks"(workspace_id: WorkspaceId) => sync Reply::result(
        tasks::delete_done_tasks(State(&s.storage), workspace_id)
    );
    "restore_task"(id: TaskId) => sync Reply::result(tasks::restore_task(State(&s.storage), id));
    "purge_task"(id: TaskId) => sync Reply::result(tasks::purge_task(State(&s.storage), id));
    "add_dependency"(task_id: TaskId, depends_on: TaskId, confirm_pause: bool) => sync Reply::result(
        tasks::add_dependency(State(&s.storage), task_id, depends_on, confirm_pause)
    );
    "remove_dependency"(task_id: TaskId, depends_on: TaskId) => sync Reply::result(
        tasks::remove_dependency(State(&s.storage), task_id, depends_on)
    );
    "start_task"(id: TaskId, reason: Option<String>, refs: Option<Vec<String>>) => sync Reply::result(tasks::start_task(State(&s.storage), id, reason, refs));
    "complete_task"(id: TaskId, note: Option<String>, refs: Option<Vec<String>>) => sync Reply::result(completion::complete_task(State(&s.storage), id, note, refs));
    "conclude_task"(id: TaskId, note: String, outcome: Option<completion::ConcludeOutcome>, shipped_with: Option<TaskId>) => sync Reply::result(completion::conclude_task(State(&s.storage), id, note, outcome, shipped_with));
    "link_issue"(id: TaskId, reference: String) => sync Reply::result(issues::link_issue(State(&s.storage), id, reference));

    "mcp_server_info"() => sync Reply::value(mcp::mcp_server_info(State(&s.mcp)));
    "review_period"(from: String, to: String) => sync Reply::result(
        review::review_period(State(s.reader()), from, to)
    );
    "review_report"(request: ReviewReportRequest) => sync Reply::result(
        review::review_report(State(s.reader()), request)
    );
    "get_review_time_zone"() => sync Reply::result(review::get_review_time_zone(State(s.reader())));
    "set_review_time_zone"(time_zone: Option<String>) => sync Reply::result(
        review::set_review_time_zone(State(&s.storage), time_zone)
    );
    "save_review_snapshot"(request: SaveReviewSnapshotRequest) => sync Reply::result(
        review::save_review_snapshot(State(&s.storage), request)
    );
    "list_review_snapshots"() => sync Reply::result(review::list_review_snapshots(State(s.reader())));
    "get_review_snapshot"(id: ReviewSnapshotId) => sync Reply::result(
        review::get_review_snapshot(State(s.reader()), id)
    );
    "delete_review_snapshot"(id: ReviewSnapshotId) => sync Reply::result(
        review::delete_review_snapshot(State(&s.storage), id)
    );

    "get_backup_settings"() => sync Reply::value(backup::get_backup_settings(State(&s.backups)));
    "get_backup_status"() => sync Reply::value(backup::get_backup_status(State(&s.backups)));
    "save_backup_settings"(settings: BackupSettings) => sync Reply::result(
        backup::save_backup_settings(State(&s.storage), State(&s.backups), settings)
    );
    "list_backups"() => sync Reply::result(backup::list_backups(State(&s.backups)));
    "restore_backup"(name: String) => sync Reply::result(
        backup::restore_backup(State(&s.storage), State(&s.backups), name)
    );
});

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn every_command_of_the_bindings_is_served() {
        let bound: BTreeSet<String> = crate::bindings::commands()
            .iter()
            .map(|command| command.name().to_owned())
            .collect();
        assert!(
            bound.contains("list_tasks") && bound.contains("app_info"),
            "{bound:?}"
        );
        let served: BTreeSet<String> = COMMANDS.iter().map(|name| (*name).to_owned()).collect();
        assert_eq!(served, bound);
    }

    #[test]
    fn read_commands_are_served_and_leave_out_the_mcp_token() {
        for command in READ_COMMANDS {
            assert!(COMMANDS.contains(command), "{command}");
        }
        assert!(!READ_COMMANDS.contains(&"mcp_server_info"));
    }

    #[test]
    fn arguments_use_the_camel_case_keys_of_the_bindings() {
        let args = serde_json::json!({ "taskId": 3, "dependsOn": 4 });
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            task_id: TaskId,
            depends_on: TaskId,
        }
        let Args {
            task_id,
            depends_on,
        } = parse::<Args>(args).unwrap();
        assert_eq!((task_id.0, depends_on.0), (3, 4));
        assert!(matches!(
            parse::<Args>(serde_json::json!({ "task_id": 3 })),
            Err(Reply::BadArguments(_))
        ));
    }
}
