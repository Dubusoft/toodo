//! Completion records and criterion checks, without execution side effects.
mod conclude;
#[cfg(test)]
mod tests;

use super::types::{self, Task, TaskId};
use super::{CommandError, CommandResult, State, StorageState, lock};
use crate::domain::criteria::{CheckKind, CriterionState};
use crate::domain::model;
use crate::storage::{CriterionCheck, StorageError};

pub use conclude::ConcludeOutcome;
pub(crate) use conclude::conclude;

/// Completes a task after its manual criteria and URL checks succeed.
#[specta::specta]
pub fn complete_task(
    storage: State<'_, StorageState>,
    id: TaskId,
    note: Option<String>,
    refs: Option<Vec<String>>,
) -> CommandResult<Task> {
    Ok((&complete(
        &storage,
        id.into(),
        note.as_deref(),
        refs.as_deref().unwrap_or_default(),
    )?)
        .into())
}

pub(crate) fn complete(
    storage: &StorageState,
    id: model::TaskId,
    note: Option<&str>,
    refs: &[String],
) -> CommandResult<model::Task> {
    let note = note.map(str::trim);
    if note == Some("") {
        return Err(CommandError::invalid_input(
            "note is blank; call complete_task with a non-empty note or omit note",
        ));
    }
    let task = lock(storage)
        .get_task(id)?
        .ok_or(StorageError::TaskNotFound(id))?;
    task.status.complete().map_err(StorageError::from)?;
    let refs = types::merge_refs(&task.refs, refs, &[])?;
    let mut checks = Vec::new();
    for criterion in &task.criteria {
        if criterion.kind != CheckKind::Url {
            continue;
        }
        let target = criterion
            .target
            .as_deref()
            .expect("URL criteria have a target");
        drop(rustls::crypto::ring::default_provider().install_default());
        let result = tokio::runtime::Builder::new_current_thread().enable_all().build()
            .map_err(|error| CommandError::internal(format!("cannot check URL ({error}); call complete_task again after fixing the server runtime")))?
            .block_on(async {
                reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build()?.get(target).send().await?.error_for_status()
            });
        let (state, evidence) = match result {
            Ok(response) => (
                CriterionState::Met,
                format!("GET {target}: {}", response.status()),
            ),
            Err(error) => (
                CriterionState::Failed,
                format!(
                    "GET {target}: {error}; fix the URL target with update_task, then call complete_task again"
                ),
            ),
        };
        checks.push(CriterionCheck {
            id: criterion.id,
            state,
            evidence: Some(evidence),
            target: None,
        });
    }
    let mut storage = lock(storage);
    storage.record_criterion_rechecks(id, &checks)?;
    let (task, _) = storage.record_criterion_checks(id, &checks)?;
    let pending: Vec<String> = task
        .criteria
        .iter()
        .filter(|criterion| !criterion.is_met())
        .map(|criterion| match criterion.kind {
            CheckKind::Manual => format!(
                "criterion {}: {}; call check_criterion with criterion_id {} and met true",
                criterion.id, criterion.text, criterion.id
            ),
            CheckKind::Url => format!(
                "criterion {}: {}; fix its URL with update_task, then call complete_task again",
                criterion.id,
                criterion.evidence.as_deref().unwrap_or("URL check failed")
            ),
        })
        .collect();
    if !pending.is_empty() {
        return Err(CommandError::rejected(pending.join("; ")));
    }
    Ok(storage.complete_task(id, note, &refs)?)
}

/// Records the conclusion of work or identifies the completed task that shipped it.
#[specta::specta]
pub fn conclude_task(
    storage: State<'_, StorageState>,
    id: TaskId,
    note: String,
    outcome: Option<ConcludeOutcome>,
    shipped_with: Option<TaskId>,
) -> CommandResult<Task> {
    Ok((&conclude(
        &storage,
        id.into(),
        &note,
        outcome.unwrap_or_default(),
        shipped_with.map(Into::into),
    )?)
        .into())
}
