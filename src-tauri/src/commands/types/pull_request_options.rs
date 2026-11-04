use serde::{Deserialize, Serialize};
use specta::Type;

use crate::commands::{CommandError, CommandResult};
use crate::domain::model;

/// The most reviewers or labels a workspace may set.
const MAX_ENTRIES: usize = 20;
/// GitHub's longest login is 39 characters; an `org/team` slug may be longer.
const MAX_REVIEWER_LEN: usize = 100;
/// GitHub refuses label names longer than 50 characters.
const MAX_LABEL_LEN: usize = 50;

/// How Toodo opens the pull requests of a workspace's tasks with `gh pr create`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestOptions {
    /// Open pull requests as drafts (`--draft`).
    pub draft: bool,
    /// Users (`login`) or teams (`org/team`) asked to review (`--reviewer`).
    pub reviewers: Vec<String>,
    /// Labels added (`--label`); each must exist in the repository.
    pub labels: Vec<String>,
}

impl From<&model::PullRequestOptions> for PullRequestOptions {
    fn from(options: &model::PullRequestOptions) -> Self {
        Self {
            draft: options.draft,
            reviewers: options.reviewers.clone(),
            labels: options.labels.clone(),
        }
    }
}

impl PullRequestOptions {
    /// The options checked, with blank entries dropped and the rest trimmed: at most 20
    /// distinct reviewers, each a GitHub login or `org/team`, and at most 20 distinct
    /// labels of up to 50 characters without commas.
    pub(crate) fn parse(self) -> CommandResult<model::PullRequestOptions> {
        let reviewers = entries("reviewers", self.reviewers)?;
        for reviewer in &reviewers {
            if !is_reviewer(reviewer) {
                return Err(CommandError::invalid_input(format!(
                    "reviewer {reviewer:?} is not a GitHub login or team; give a login such as \
                     \"octocat\" or a team as \"org/team\", of at most {MAX_REVIEWER_LEN} \
                     letters, digits, and -_."
                )));
            }
        }
        let labels = entries("labels", self.labels)?;
        for label in &labels {
            if label.chars().count() > MAX_LABEL_LEN || label.contains(',') {
                return Err(CommandError::invalid_input(format!(
                    "label {label:?} cannot be added; give a label name of the repository of \
                     at most {MAX_LABEL_LEN} characters without commas"
                )));
            }
        }
        Ok(model::PullRequestOptions {
            draft: self.draft,
            reviewers,
            labels,
        })
    }
}

/// `values` trimmed, without blank ones; rejected when too many or repeated.
fn entries(name: &str, values: Vec<String>) -> CommandResult<Vec<String>> {
    let mut kept: Vec<String> = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if kept.iter().any(|seen| seen.eq_ignore_ascii_case(value)) {
            return Err(CommandError::invalid_input(format!(
                "{value:?} is listed twice in the {name}; list each of them once"
            )));
        }
        kept.push(value.to_owned());
    }
    if kept.len() > MAX_ENTRIES {
        return Err(CommandError::invalid_input(format!(
            "{} {name} are too many; give at most {MAX_ENTRIES}",
            kept.len()
        )));
    }
    Ok(kept)
}

/// Whether `value` names a GitHub user (`login`) or team (`org/team`).
fn is_reviewer(value: &str) -> bool {
    let part = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    };
    value.len() <= MAX_REVIEWER_LEN
        && match value.split_once('/') {
            Some((org, team)) => part(org) && part(team),
            None => part(value),
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(reviewers: &[&str], labels: &[&str]) -> PullRequestOptions {
        PullRequestOptions {
            draft: true,
            reviewers: reviewers.iter().map(|s| (*s).to_owned()).collect(),
            labels: labels.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn parse_trims_entries_and_drops_blank_ones() {
        let parsed = options(
            &[" octocat ", "", "acme/core-team"],
            &["needs review", "  "],
        )
        .parse()
        .unwrap();
        assert_eq!(
            parsed,
            model::PullRequestOptions {
                draft: true,
                reviewers: vec!["octocat".to_owned(), "acme/core-team".to_owned()],
                labels: vec!["needs review".to_owned()],
            }
        );
    }

    #[test]
    fn parse_rejects_what_gh_would_split_or_github_refuses() {
        for bad in [
            options(&["octo cat"], &[]),
            options(&["a,b"], &[]),
            options(&["acme/core/team"], &[]),
            options(&["octocat", "OctoCat"], &[]),
            options(&[], &["bug,urgent"]),
            options(&[], &[&"x".repeat(MAX_LABEL_LEN + 1)]),
        ] {
            let error = bad.clone().parse().unwrap_err();
            assert_eq!(
                error.code,
                crate::commands::CommandErrorCode::InvalidInput,
                "{bad:?}"
            );
        }
        let many: Vec<String> = (0..=MAX_ENTRIES).map(|n| format!("label-{n}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(options(&[], &many).parse().is_err());
    }
}
