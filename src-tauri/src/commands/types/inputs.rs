use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

use crate::commands::{CommandError, CommandResult};
use crate::domain::{model, path, plan};

pub(super) fn required(field: &str, value: String) -> CommandResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CommandError::invalid_input(format!(
            "{field} must not be empty"
        )));
    }
    Ok(trimmed.to_owned())
}

/// The unit of time an estimate counts, compared with the time the task spends in
/// progress or in review. A day is 24 hours, a week 7 days, and a month 30 days.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EstimateUnit {
    Hours,
    Days,
    Weeks,
    Months,
}

/// The expected size of a task.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    pub unit: EstimateUnit,
    /// Greater than 0 and at most 10000, e.g. 1.5. Exported as `number`: it is never NaN
    /// or infinite, which specta's default `number | null` allows for.
    #[specta(type = Number)]
    pub amount: f64,
}

// JSON cannot carry NaN, and outgoing amounts come from validated domain estimates.
impl Eq for Estimate {}

impl From<plan::Estimate> for Estimate {
    fn from(estimate: plan::Estimate) -> Self {
        Self {
            unit: match estimate.unit() {
                plan::EstimateUnit::Hours => EstimateUnit::Hours,
                plan::EstimateUnit::Days => EstimateUnit::Days,
                plan::EstimateUnit::Weeks => EstimateUnit::Weeks,
                plan::EstimateUnit::Months => EstimateUnit::Months,
            },
            amount: estimate.amount(),
        }
    }
}

impl TryFrom<Estimate> for plan::Estimate {
    type Error = CommandError;

    fn try_from(estimate: Estimate) -> CommandResult<Self> {
        let unit = match estimate.unit {
            EstimateUnit::Hours => plan::EstimateUnit::Hours,
            EstimateUnit::Days => plan::EstimateUnit::Days,
            EstimateUnit::Weeks => plan::EstimateUnit::Weeks,
            EstimateUnit::Months => plan::EstimateUnit::Months,
        };
        plan::Estimate::new(unit, estimate.amount)
            .map_err(|error| CommandError::invalid_input(error.to_string()))
    }
}

pub(crate) fn estimate(estimate: Option<Estimate>) -> CommandResult<Option<plan::Estimate>> {
    estimate.map(plan::Estimate::try_from).transpose()
}

/// Labels of a task, trimmed, sorted, and unique.
pub(crate) fn labels(raw: &[String]) -> CommandResult<Vec<String>> {
    plan::labels(raw).map_err(|error| CommandError::invalid_input(error.to_string()))
}

/// A due date as `YYYY-MM-DD`; blank means none.
pub(crate) fn due_date(raw: Option<&str>) -> CommandResult<Option<plan::DueDate>> {
    match raw.map(str::trim) {
        None | Some("") => Ok(None),
        Some(raw) => plan::DueDate::parse(raw)
            .map(Some)
            .map_err(|error| CommandError::invalid_input(error.to_string())),
    }
}

pub(super) fn machine_label(raw: &str) -> CommandResult<model::MachineLabel> {
    model::MachineLabel::parse(raw).map_err(|error| CommandError::invalid_input(error.to_string()))
}

/// A path on the machine Toodo runs on: a POSIX path on the server.
pub(super) fn local_path(raw: &str) -> CommandResult<model::HostPath> {
    posix_path(raw).map(model::HostPath::Posix)
}

pub(super) fn posix_path(raw: &str) -> CommandResult<path::PosixPath> {
    path::PosixPath::parse(raw).map_err(|error| CommandError::invalid_input(error.to_string()))
}

/// A path on an SSH machine: a POSIX path, or a Windows drive or UNC path on a Windows
/// host.
pub(super) fn remote_path(raw: &str) -> CommandResult<model::HostPath> {
    model::HostPath::parse(raw).map_err(|error| CommandError::invalid_input(error.to_string()))
}
