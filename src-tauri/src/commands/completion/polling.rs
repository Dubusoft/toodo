//! The [`GitHub`] one round of the background check reads pull requests through, so a
//! round asks GitHub as little as it can: each pull request is read once with everything
//! the round needs, the open pull requests of a repository with several to read are
//! listed in one call, and nothing is called while GitHub's rate limit backs off.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use crate::adapters::git::GitError;
use crate::adapters::github::{
    GitHub, ListedPullRequest, MergeState, MergedPullRequest, NewPullRequest, PullRequest,
    PullRequestActivity, PullRequestDetails, ViewedPullRequest, pull_request_repository,
};
use crate::domain::model::LinkedIssue;
use crate::domain::remote::GitHubRepository;

/// Why a call was not made: the same text every time, so the failure of each task is
/// logged once per backoff.
const RATE_LIMITED: &str = "GitHub refused an earlier gh call for its API rate limit, so \
     background pull request checks skip gh until it resets and then resume on their own; run \
     `gh api rate_limit` as the user that runs toodo-server to see when it resets";

/// Wraps the [`GitHub`] of one background round; see the module documentation.
pub(super) struct PollingGitHub<'a> {
    inner: &'a dyn GitHub,
    /// Repositories (as `host/owner/name`) with more than one pull request to read this
    /// round, whose open pull requests are listed at once.
    batched: HashSet<String>,
    /// The open pull requests of each batched repository listed this round by URL; `None`
    /// when listing them failed, so each is read on its own.
    listed: Mutex<HashMap<String, Option<HashMap<String, PullRequestDetails>>>>,
    /// Each pull request read on its own this round, failures included.
    read: Mutex<HashMap<String, Result<PullRequestDetails, GitError>>>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<'a> PollingGitHub<'a> {
    /// A round that reads the pull requests at `urls`, and maybe others.
    pub(super) fn new<'u>(inner: &'a dyn GitHub, urls: impl IntoIterator<Item = &'u str>) -> Self {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for url in urls.into_iter().collect::<HashSet<_>>() {
            if let Some(repository) = pull_request_repository(url) {
                *counts.entry(repository.to_string()).or_default() += 1;
            }
        }
        Self {
            inner,
            batched: counts
                .into_iter()
                .filter(|(_, count)| *count > 1)
                .map(|(repository, _)| repository)
                .collect(),
            listed: Mutex::default(),
            read: Mutex::default(),
        }
    }

    /// Fails while GitHub's rate limit backs off.
    fn allowed(&self) -> Result<(), GitError> {
        match self.inner.rate_limit_backoff() {
            Some(_) => Err(GitError::Failed {
                command: "gh".to_owned(),
                stderr: RATE_LIMITED.to_owned(),
            }),
            None => Ok(()),
        }
    }

    fn details(&self, url: &str) -> Result<PullRequestDetails, GitError> {
        if let Some(read) = locked(&self.read).get(url) {
            return read.clone();
        }
        self.allowed()?;
        if let Some(found) = self.listed(url) {
            return Ok(found);
        }
        // Listing may have hit the rate limit.
        self.allowed()?;
        let read = self.inner.pull_request_details(url);
        locked(&self.read).insert(url.to_owned(), read.clone());
        read
    }

    /// The pull request at `url` from the list of open pull requests of its repository,
    /// listed now unless it was this round, when the repository is batched.
    fn listed(&self, url: &str) -> Option<PullRequestDetails> {
        let repository = pull_request_repository(url)?;
        let key = repository.to_string();
        if !self.batched.contains(&key) {
            return None;
        }
        let mut listed = locked(&self.listed);
        let open = listed.entry(key).or_insert_with(|| {
            // A failure is not reported here: each pull request is then read on its own,
            // which reports its own failure.
            self.inner.open_pull_requests(&repository).ok().map(|all| {
                all.into_iter()
                    .map(|details| (details.viewed.pull_request.url.clone(), details))
                    .collect()
            })
        });
        open.as_ref()?.get(url).cloned()
    }
}

impl GitHub for PollingGitHub<'_> {
    fn find_pull_request(
        &self,
        repository: &GitHubRepository,
        head: &str,
        base: &str,
    ) -> Result<Option<PullRequest>, GitError> {
        self.allowed()?;
        self.inner.find_pull_request(repository, head, base)
    }

    fn create_pull_request(&self, pull_request: &NewPullRequest<'_>) -> Result<String, GitError> {
        self.allowed()?;
        self.inner.create_pull_request(pull_request)
    }

    fn pull_request(&self, url: &str) -> Result<ViewedPullRequest, GitError> {
        Ok(self.details(url)?.viewed)
    }

    fn pull_request_activity(&self, url: &str) -> Result<PullRequestActivity, GitError> {
        Ok(self.details(url)?.activity)
    }

    fn close_pull_request(&self, url: &str, comment: &str) -> Result<(), GitError> {
        self.allowed()?;
        self.inner.close_pull_request(url, comment)
    }

    fn pull_request_body(&self, url: &str) -> Result<String, GitError> {
        Ok(self.details(url)?.body)
    }

    fn edit_pull_request_body(&self, url: &str, body: &str) -> Result<(), GitError> {
        self.allowed()?;
        self.inner.edit_pull_request_body(url, body)?;
        // Later reads this round see the new body.
        if let Some(Ok(details)) = locked(&self.read).get_mut(url) {
            details.body = body.to_owned();
        }
        for open in locked(&self.listed).values_mut().flatten() {
            if let Some(details) = open.get_mut(url) {
                details.body = body.to_owned();
            }
        }
        Ok(())
    }

    fn issue(&self, repository: &GitHubRepository, number: i64) -> Result<LinkedIssue, GitError> {
        self.allowed()?;
        self.inner.issue(repository, number)
    }

    fn create_issue(
        &self,
        repository: &GitHubRepository,
        title: &str,
        body: &str,
    ) -> Result<LinkedIssue, GitError> {
        self.allowed()?;
        self.inner.create_issue(repository, title, body)
    }

    fn merged_pull_request(&self, url: &str) -> Result<MergedPullRequest, GitError> {
        self.allowed()?;
        self.inner.merged_pull_request(url)
    }

    fn mergeable(&self, url: &str) -> Result<MergeState, GitError> {
        self.allowed()?;
        self.inner.mergeable(url)
    }

    fn pull_request_details(&self, url: &str) -> Result<PullRequestDetails, GitError> {
        self.details(url)
    }

    fn open_pull_requests(
        &self,
        repository: &GitHubRepository,
    ) -> Result<Vec<PullRequestDetails>, GitError> {
        self.allowed()?;
        self.inner.open_pull_requests(repository)
    }

    fn merged_pull_requests(
        &self,
        repository: &GitHubRepository,
        base: &str,
        since: i64,
        until: i64,
    ) -> Result<Vec<ListedPullRequest>, GitError> {
        self.allowed()?;
        self.inner
            .merged_pull_requests(repository, base, since, until)
    }

    fn rate_limit_backoff(&self) -> Option<Duration> {
        self.inner.rate_limit_backoff()
    }
}
