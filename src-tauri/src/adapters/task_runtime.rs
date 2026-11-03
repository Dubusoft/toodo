//! The workspace operations Toodo needs from the tool that hosts task worktrees: opening,
//! closing, and removing the workspace of a task, and opening a repository when a Toodo
//! workspace is created or moved.
//!
//! herdr is the only implementation. The signatures still use herdr's types
//! ([`NewWorktree`], [`HerdrError`]) until another implementation needs its own.

use crate::adapters::herdr::{HerdrError, NewWorktree};
use crate::domain::model::Machine;

pub trait TaskWorkspaceRuntime {
    /// Creates the worktree and opens it as a workspace without focusing it; returns the
    /// workspace ID.
    fn create_worktree(
        &self,
        machine: &Machine,
        worktree: &NewWorktree<'_>,
    ) -> Result<String, HerdrError>;

    /// Opens an existing worktree as a workspace without focusing it; returns the
    /// workspace ID.
    fn open_worktree(
        &self,
        machine: &Machine,
        repository: &str,
        path: &str,
    ) -> Result<String, HerdrError>;

    /// Removes the worktree checkout of a workspace and closes the workspace; the branch is
    /// kept. Without `force`, a checkout with modified or untracked files is refused.
    fn remove_worktree(
        &self,
        machine: &Machine,
        workspace_id: &str,
        force: bool,
    ) -> Result<(), HerdrError>;

    /// Closes a workspace; the worktree checkout it was bound to stays on disk.
    fn close_workspace(&self, machine: &Machine, workspace_id: &str) -> Result<(), HerdrError>;

    /// Opens the repository checkout at `path` as a workspace labelled `label` without
    /// focusing it, unless a workspace already has it open; returns the workspace ID.
    fn open_repository(
        &self,
        machine: &Machine,
        path: &str,
        label: &str,
    ) -> Result<String, HerdrError>;
}
