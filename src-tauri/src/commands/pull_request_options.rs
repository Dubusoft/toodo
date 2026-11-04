//! Commands for how the pull requests of a workspace's tasks are opened: as drafts or
//! not, and the reviewers and labels they get.

use super::types::{PullRequestOptions, WorkspaceId};
use super::{CommandResult, State, StorageState, lock};

/// The options pull requests of a workspace's tasks are opened with.
#[specta::specta]
pub fn get_workspace_pull_request_options(
    storage: State<'_, StorageState>,
    workspace_id: WorkspaceId,
) -> CommandResult<PullRequestOptions> {
    Ok((&lock(&storage).workspace_pull_request_options(workspace_id.into())?).into())
}

/// Replaces the options pull requests of a workspace's tasks are opened with; blank
/// reviewers and labels are dropped. Pull requests opened later use them.
#[specta::specta]
pub fn set_workspace_pull_request_options(
    storage: State<'_, StorageState>,
    workspace_id: WorkspaceId,
    options: PullRequestOptions,
) -> CommandResult<PullRequestOptions> {
    let options = options.parse()?;
    let mut storage = lock(&storage);
    storage.set_workspace_pull_request_options(workspace_id.into(), &options)?;
    Ok((&storage.workspace_pull_request_options(workspace_id.into())?).into())
}
