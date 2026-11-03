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
use crate::commands::types::{
    BackupSettings, CriterionId, Machine, MachineSettings, NewSshHost, NewTask, NewWorkspace,
    TaskEdit, TaskId, TaskResolution, Timestamp, Workspace, WorkspaceId, WorkspaceLocation,
};
use crate::commands::{
    CommandError, CommandErrorKind, CommandResult, State, backup, completion, events, freshness,
    herdr, issues, machines, mcp, review, tasks, workspaces,
};

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
            Self::UnknownCommand => (StatusCode::NOT_FOUND, "unknown command").into_response(),
            Self::BadArguments(message) => (
                StatusCode::BAD_REQUEST,
                format!("invalid arguments: {message}"),
            )
                .into_response(),
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

/// Runs a command that blocks (git, gh, herdr, or the database) off the async threads.
async fn blocking(run: impl FnOnce() -> Reply + Send + 'static) -> Reply {
    tokio::task::spawn_blocking(run)
        .await
        .unwrap_or_else(|error| {
            Reply::Failed(CommandError::internal(format!("command panicked: {error}")))
        })
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

commands!(s => {
    "app_info"() => sync Reply::value(crate::commands::app_info());

    "list_workspaces"() => sync Reply::result(workspaces::list_workspaces(State(&s.storage)));
    "get_workspace"(id: WorkspaceId) => sync Reply::result(workspaces::get_workspace(State(&s.storage), id));
    "create_workspace"(workspace: NewWorkspace) => async Reply::result(
        workspaces::create_workspace(State(&s.storage), State(&s.git), State(&s.herdr), workspace).await
    );
    "update_workspace"(workspace: Workspace) => sync Reply::result(
        workspaces::update_workspace(State(&s.storage), workspace)
    );
    "move_workspace"(id: WorkspaceId, location: WorkspaceLocation) => async Reply::result(
        workspaces::move_workspace(State(&s.storage), State(&s.git), State(&s.herdr), id, location).await
    );
    "list_workspace_branches"(id: WorkspaceId) => sync Reply::result(
        workspaces::list_workspace_branches(State(&s.storage), State(&s.git), id)
    );
    "create_workspace_base_branch"(id: WorkspaceId, name: String, from: String) => sync Reply::result(
        workspaces::create_workspace_base_branch(State(&s.storage), State(&s.git), id, name, from)
    );
    "delete_workspace"(id: WorkspaceId) => sync Reply::result(workspaces::delete_workspace(State(&s.storage), id));
    "get_machine_settings"(machine: Machine) => sync Reply::result(
        workspaces::get_machine_settings(State(&s.storage), machine)
    );
    "save_machine_settings"(settings: MachineSettings) => sync Reply::result(
        workspaces::save_machine_settings(State(&s.storage), settings)
    );

    "list_herdr_machines"() => sync Reply::result(machines::list_herdr_machines(State(&s.herdr)));
    "list_ssh_hosts"() => sync Reply::result(machines::list_ssh_hosts(State(&s.ssh_config)));
    "add_ssh_host"(host: NewSshHost) => sync Reply::result(machines::add_ssh_host(State(&s.ssh_config), host));
    "list_remote_directories"(machine: String, path: Option<String>) => async Reply::result(
        machines::list_remote_directories(State(&s.ssh), machine, path).await
    );
    "list_directories"(machine: Machine, path: Option<String>) => async Reply::result(
        machines::list_directories(State(&s.ssh), machine, path).await
    );

    "list_tasks"() => sync Reply::result(tasks::list_tasks(State(&s.storage)));
    "list_task_relations"() => sync Reply::result(tasks::list_task_relations(State(&s.storage)));
    "add_task_relation"(task_id: TaskId, related_id: TaskId) => sync Reply::result(
        tasks::add_task_relation(State(&s.storage), task_id, related_id)
    );
    "remove_task_relation"(task_id: TaskId, related_id: TaskId) => sync Reply::result(
        tasks::remove_task_relation(State(&s.storage), task_id, related_id)
    );
    "get_task"(id: TaskId) => sync Reply::result(tasks::get_task(State(&s.storage), id));
    "create_task"(task: NewTask) => sync Reply::result(
        tasks::create_task(State(&s.storage), State(&s.git), task)
    );
    "check_criterion"(task_id: TaskId, criterion_id: CriterionId, met: bool, evidence: Option<String>) => sync Reply::result(
        tasks::check_criterion(State(&s.storage), task_id, criterion_id, met, evidence)
    );
    "update_task"(task: TaskEdit) => sync Reply::result(
        tasks::update_task(State(&s.storage), State(&s.git), task)
    );
    "pause_task"(id: TaskId) => sync Reply::result(tasks::pause_task(State(&s.storage), id));
    "set_completion_note"(id: TaskId, note: String) => sync Reply::result(
        tasks::set_completion_note(State(&s.storage), id, note)
    );
    "reopen_task"(id: TaskId, reason: String) => sync Reply::result(
        tasks::reopen_task(State(&s.storage), id, reason)
    );
    "set_task_outcome"(id: TaskId, resolution: TaskResolution, note: String) => sync Reply::result(
        tasks::set_task_outcome(State(&s.storage), id, resolution, note)
    );
    "delete_task"(id: TaskId, force: bool) => sync Reply::result(
        tasks::delete_task(State(&s.storage), State(&s.herdr), id, force)
    );
    "add_dependency"(task_id: TaskId, depends_on: TaskId, confirm_pause: bool) => sync Reply::result(
        tasks::add_dependency(State(&s.storage), State(&s.herdr), task_id, depends_on, confirm_pause)
    );
    "remove_dependency"(task_id: TaskId, depends_on: TaskId) => sync Reply::result(
        tasks::remove_dependency(State(&s.storage), task_id, depends_on)
    );
    "list_commit_records"(task_id: TaskId) => sync Reply::result(
        tasks::list_commit_records(State(&s.storage), task_id)
    );

    "herdr_status"() => sync Reply::result(herdr::herdr_status(State(&s.herdr)));
    "start_task"(id: TaskId) => sync Reply::result(herdr::start_task(State(&s.storage), State(&s.git), State(&s.herdr), id));
    "ensure_task_workspace"(id: TaskId) => sync Reply::result(
        herdr::ensure_task_workspace(State(&s.storage), State(&s.herdr), id)
    );
    "open_task_in_herdr"(id: TaskId) => sync Reply::result(
        herdr::open_task_in_herdr(State(&s.storage), State(&s.herdr), id)
    );
    "focus_agent_pane"(id: TaskId) => sync Reply::result(
        herdr::focus_agent_pane(State(&s.storage), State(&s.herdr), id)
    );
    "restore_task_worktree"(id: TaskId) => sync Reply::result(
        herdr::restore_task_worktree(State(&s.storage), State(&s.git), State(&s.herdr), id)
    );
    "close_task_workspace"(id: TaskId) => sync Reply::result(
        herdr::close_task_workspace(State(&s.storage), State(&s.herdr), id)
    );

    "refresh_commit_records"(task_id: TaskId) => sync Reply::result(
        completion::refresh_commit_records(State(&s.storage), State(&s.git), task_id)
    );
    "open_pull_request"(id: TaskId) => sync Reply::result(
        completion::open_pull_request(State(&s.storage), State(&s.git), State(&s.github), id)
    );
    "complete_task"(id: TaskId) => sync Reply::result(
        completion::complete_task(State(&s.storage), State(&s.git), State(&s.github), State(&s.herdr), id)
    );
    "conclude_task"(id: TaskId, note: String) => sync Reply::result(
        completion::conclude_task(State(&s.storage), State(&s.git), State(&s.github), State(&s.herdr), id, note)
    );
    "complete_task_merged_with"(id: TaskId, merged_with_task: Option<TaskId>, pull_request_url: Option<String>) => sync Reply::result(
        completion::complete_task_merged_with(State(&s.storage), State(&s.git), State(&s.github), State(&s.herdr), id, merged_with_task, pull_request_url)
    );
    "list_pull_request_statuses"() => sync Reply::value(
        completion::list_pull_request_statuses(State(&s.pull_request_statuses))
    );
    "branch_freshness"(id: TaskId) => sync Reply::result(
        freshness::branch_freshness(State(&s.storage), State(&s.git), State(&s.github), id)
    );
    "link_issue"(id: TaskId, number: Option<u32>) => sync Reply::result(
        issues::link_issue(State(&s.storage), State(&s.git), State(&s.github), id, number)
    );
    "create_issue"(id: TaskId) => sync Reply::result(
        issues::create_issue(State(&s.storage), State(&s.git), State(&s.github), id)
    );
    "list_agent_statuses"() => sync Reply::value(events::list_agent_statuses(State(&s.agent_statuses)));

    "mcp_server_info"() => sync Reply::value(mcp::mcp_server_info(State(&s.mcp)));
    "list_mcp_tunnels"() => sync Reply::value(mcp::list_mcp_tunnels(State(&s.tunnels)));

    "review_period"(start: Timestamp, end: Timestamp) => sync Reply::result(
        review::review_period(State(&s.storage), start, end)
    );

    "get_backup_settings"() => sync Reply::value(backup::get_backup_settings(State(&s.backups)));
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
