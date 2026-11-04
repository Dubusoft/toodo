use serde::{Deserialize, Serialize};
use specta::Type;

use crate::commands::{CommandError, CommandResult};
use crate::domain::model;

const MAX_MODEL_LEN: usize = 100;

/// How much the agent of a plain or tmux run may do without asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Read and plan only: Claude `--permission-mode plan`, Codex `--sandbox read-only`.
    ReadOnly,
    /// Edit files in the worktree: Claude `--permission-mode acceptEdits`, Codex
    /// `--full-auto`.
    Edit,
    /// Anything, without permission checks or a sandbox: Claude `--permission-mode
    /// bypassPermissions`, Codex `--dangerously-bypass-approvals-and-sandbox`.
    Bypass,
}

impl From<model::PermissionMode> for PermissionMode {
    fn from(mode: model::PermissionMode) -> Self {
        match mode {
            model::PermissionMode::ReadOnly => Self::ReadOnly,
            model::PermissionMode::Edit => Self::Edit,
            model::PermissionMode::Bypass => Self::Bypass,
        }
    }
}

impl From<PermissionMode> for model::PermissionMode {
    fn from(mode: PermissionMode) -> Self {
        match mode {
            PermissionMode::ReadOnly => Self::ReadOnly,
            PermissionMode::Edit => Self::Edit,
            PermissionMode::Bypass => Self::Bypass,
        }
    }
}

/// How agents of runs are launched. On a workspace, `null` keeps the agent CLI's default
/// model, the agent's default permission mode (Claude `bypass`, Codex `edit`), and a
/// time limit of 240 minutes; on a task, `null` takes the workspace's value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentOptions {
    /// The model passed to the agent CLI with `--model`, e.g. `sonnet` or `gpt-5-codex`;
    /// blank for none.
    pub model: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    /// How long a plain run may take before it is stopped and fails, from 1 to 10080
    /// minutes (a week). tmux runs have no time limit.
    pub time_limit_minutes: Option<u32>,
}

impl From<&model::AgentOptions> for AgentOptions {
    fn from(options: &model::AgentOptions) -> Self {
        Self {
            model: options.model.clone(),
            permission_mode: options.permission_mode.map(PermissionMode::from),
            time_limit_minutes: options.time_limit_minutes,
        }
    }
}

impl AgentOptions {
    /// The options checked: a model of at most 100 letters, digits, and `-._:/@[]`, and a
    /// time limit from 1 minute to a week.
    pub(crate) fn parse(self) -> CommandResult<model::AgentOptions> {
        let model = self
            .model
            .map(|model| model.trim().to_owned())
            .filter(|model| !model.is_empty());
        if let Some(model) = &model {
            let allowed = |c: char| c.is_ascii_alphanumeric() || "-._:/@[]".contains(c);
            if model.len() > MAX_MODEL_LEN || !model.chars().all(allowed) {
                return Err(CommandError::invalid_input(format!(
                    "model {model:?} is not a model name; give at most {MAX_MODEL_LEN} letters, \
                     digits, and -._:/@[] such as \"sonnet\" or \"gpt-5-codex\", or leave it \
                     blank for the agent's default"
                )));
            }
        }
        if let Some(minutes) = self.time_limit_minutes
            && !(1..=model::MAX_RUN_TIME_LIMIT_MINUTES).contains(&minutes)
        {
            return Err(CommandError::invalid_input(format!(
                "time limit {minutes} is out of range; give from 1 to {} minutes, or leave it \
                 blank for the default of {} minutes",
                model::MAX_RUN_TIME_LIMIT_MINUTES,
                model::DEFAULT_RUN_TIME_LIMIT_MINUTES
            )));
        }
        Ok(model::AgentOptions {
            model,
            permission_mode: self.permission_mode.map(model::PermissionMode::from),
            time_limit_minutes: self.time_limit_minutes,
        })
    }
}

/// The launch options of a task's runs: what the task overrides and what its workspace
/// sets for the rest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskAgentOptions {
    pub task: AgentOptions,
    pub workspace: AgentOptions,
}
