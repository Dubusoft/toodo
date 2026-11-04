//! How the pull requests of a workspace's tasks are opened, kept in the
//! `pull_request_*` columns of `workspaces`.

use rusqlite::{OptionalExtension, params};

use super::{Result, Storage, StorageError};
use crate::domain::model::{PullRequestOptions, WorkspaceId};

impl Storage {
    /// The options pull requests of workspace `id` are opened with.
    pub fn workspace_pull_request_options(&self, id: WorkspaceId) -> Result<PullRequestOptions> {
        let row: Option<(bool, String, String)> = self
            .conn
            .query_row(
                "SELECT pull_request_draft, pull_request_reviewers, pull_request_labels
                 FROM workspaces WHERE id = ?1",
                [id.0],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (draft, reviewers, labels) = row.ok_or(StorageError::WorkspaceNotFound(id))?;
        let list = |column: &str, stored: &str| {
            serde_json::from_str::<Vec<String>>(stored).map_err(|_| {
                StorageError::InvalidData(format!(
                    "workspace {} has {column} that are not a JSON array of strings: {stored:?}",
                    id.0
                ))
            })
        };
        Ok(PullRequestOptions {
            draft,
            reviewers: list("pull request reviewers", &reviewers)?,
            labels: list("pull request labels", &labels)?,
        })
    }

    /// Replaces the options pull requests of workspace `id` are opened with.
    pub fn set_workspace_pull_request_options(
        &mut self,
        id: WorkspaceId,
        options: &PullRequestOptions,
    ) -> Result<()> {
        let json = |values: &[String]| {
            serde_json::to_string(values).expect("a list of strings serializes to JSON")
        };
        let changed = self.conn.execute(
            "UPDATE workspaces
             SET pull_request_draft = ?2, pull_request_reviewers = ?3, pull_request_labels = ?4
             WHERE id = ?1",
            params![
                id.0,
                options.draft,
                json(&options.reviewers),
                json(&options.labels)
            ],
        )?;
        if changed == 0 {
            return Err(StorageError::WorkspaceNotFound(id));
        }
        Ok(())
    }
}
