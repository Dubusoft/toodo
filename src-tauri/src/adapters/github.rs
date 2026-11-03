//! Opens GitHub pull requests and reads their state with the `gh` CLI, reusing its authentication. `gh` always
//! runs on this machine and names the repository with `--repo`, so it does not need a
//! local checkout and works for workspaces on SSH machines too.
//!
//! Processes are started through the [`Runner`] of the git adapter, so tests can fake
//! them the same way.

use serde_json::Value;

use super::git::{GitError, Invocation, LoggedCommit, Runner, describe};
use crate::domain::model::{LinkedIssue, PullRequestSnapshot};
use crate::domain::remote::GitHubRepository;

/// A pull request to open from `head` into `base`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewPullRequest<'a> {
    pub repository: &'a GitHubRepository,
    pub head: &'a str,
    pub base: &'a str,
    pub title: &'a str,
    pub body: &'a str,
}

/// Lifecycle state of a pull request as reported by `gh`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestState {
    Open,
    Closed,
    Merged,
}

/// A pull request as reported by `gh`, whoever opened it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequest {
    pub url: String,
    pub state: PullRequestState,
    /// Branch the pull request merges into.
    pub base: String,
    /// Merge time in seconds since the Unix epoch; `None` until it is merged.
    pub merged_at: Option<i64>,
}

/// Whether GitHub can merge a pull request into its base without conflicts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeState {
    Mergeable,
    Conflicting,
    /// GitHub has not computed it yet, or the pull request is no longer open.
    Unknown,
}

/// Fields requested with `--json` for a [`PullRequest`].
const PULL_REQUEST_FIELDS: &str = "url,state,baseRefName,mergedAt";

/// Combined result of the CI checks of a pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChecksState {
    Passing,
    Failing,
    /// At least one check is queued or running and none failed.
    Pending,
}

/// Where the reviews of a pull request stand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    /// Nobody approved or requested changes yet.
    Pending,
}

/// CI and review state of an open pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PullRequestStatus {
    /// `None` when the pull request has no checks.
    pub checks: Option<ChecksState>,
    pub review: ReviewState,
}

/// A pull request read with [`GitHub::pull_request`], with its CI and review state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewedPullRequest {
    pub pull_request: PullRequest,
    pub status: PullRequestStatus,
    /// The commit at the head of its branch, which its checks ran on.
    pub head_sha: Option<String>,
}

/// Fields requested with `--json` for a [`ViewedPullRequest`].
const VIEWED_PULL_REQUEST_FIELDS: &str =
    "url,state,baseRefName,mergedAt,statusCheckRollup,reviewDecision,latestReviews,headRefOid";

fn parse_viewed_pull_request(value: &Value) -> Option<ViewedPullRequest> {
    Some(ViewedPullRequest {
        pull_request: parse_pull_request(value)?,
        status: PullRequestStatus {
            checks: parse_checks(value.get("statusCheckRollup")?.as_array()?)?,
            review: parse_review(value)?,
        },
        head_sha: value
            .get("headRefOid")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// Combines check runs (GitHub Actions) and commit statuses: any failure fails the
/// pull request, otherwise any unfinished check keeps it pending.
fn parse_checks(rollup: &[Value]) -> Option<Option<ChecksState>> {
    let mut combined = None;
    for check in rollup {
        let field = |name: &str| check.get(name).and_then(Value::as_str);
        let state = match field("__typename")? {
            "CheckRun" if field("status")? != "COMPLETED" => ChecksState::Pending,
            "CheckRun" => match field("conclusion")? {
                "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => {
                    ChecksState::Failing
                }
                _ => ChecksState::Passing,
            },
            "StatusContext" => match field("state")? {
                "FAILURE" | "ERROR" => ChecksState::Failing,
                "PENDING" | "EXPECTED" => ChecksState::Pending,
                _ => ChecksState::Passing,
            },
            _ => continue,
        };
        combined = Some(match (combined, state) {
            (Some(ChecksState::Failing), _) | (_, ChecksState::Failing) => ChecksState::Failing,
            (Some(ChecksState::Pending), _) | (_, ChecksState::Pending) => ChecksState::Pending,
            _ => ChecksState::Passing,
        });
    }
    Some(combined)
}

/// The review decision GitHub computes from required reviews. Without required reviews
/// it is empty, so the latest review of each reviewer decides instead.
fn parse_review(value: &Value) -> Option<ReviewState> {
    let decision = match value.get("reviewDecision")? {
        Value::Null => "",
        Value::String(decision) => decision.as_str(),
        _ => return None,
    };
    match decision {
        "APPROVED" => return Some(ReviewState::Approved),
        "CHANGES_REQUESTED" => return Some(ReviewState::ChangesRequested),
        "REVIEW_REQUIRED" => return Some(ReviewState::Pending),
        _ => {}
    }
    let mut review = ReviewState::Pending;
    for latest in value.get("latestReviews")?.as_array()? {
        match latest.get("state")?.as_str()? {
            "CHANGES_REQUESTED" => return Some(ReviewState::ChangesRequested),
            "APPROVED" => review = ReviewState::Approved,
            _ => {}
        }
    }
    Some(review)
}

fn parse_pull_request(value: &Value) -> Option<PullRequest> {
    let field = |name: &str| value.get(name).and_then(Value::as_str);
    let state = match field("state")? {
        "OPEN" => PullRequestState::Open,
        "CLOSED" => PullRequestState::Closed,
        "MERGED" => PullRequestState::Merged,
        _ => return None,
    };
    // `gh` reports `"mergedAt": null` for a pull request that is not merged.
    let merged_at = match value.get("mergedAt")? {
        Value::Null => None,
        Value::String(raw) => Some(parse_utc_timestamp(raw)?),
        _ => return None,
    };
    Some(PullRequest {
        url: field("url")?.to_owned(),
        state,
        base: field("baseRefName")?.to_owned(),
        merged_at,
    })
}

/// What a merged pull request contained, read when it completes its task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedPullRequest {
    pub snapshot: PullRequestSnapshot,
    /// Commits of the pull request, oldest first.
    pub commits: Vec<LoggedCommit>,
}

/// Fields requested with `--json` for a [`MergedPullRequest`].
const MERGED_PULL_REQUEST_FIELDS: &str =
    "number,title,additions,deletions,changedFiles,mergeCommit,author,reviews,commits";

fn parse_merged_pull_request(value: &Value) -> Option<MergedPullRequest> {
    let integer = |name: &str| value.get(name).and_then(Value::as_i64);
    let login = |value: &Value| {
        value
            .get("login")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    // The author of the pull request is `null` once their account is deleted.
    let author = login(value.get("author")?);
    let merge_commit_sha = match value.get("mergeCommit")? {
        Value::Null => None,
        commit => Some(commit.get("oid")?.as_str()?.to_owned()),
    };

    let mut review_count = 0;
    let mut reviewers = Vec::new();
    let mut first_reviewed_at: Option<i64> = None;
    for review in value.get("reviews")?.as_array()? {
        // A pending review has no submission time and is visible to its author only.
        let Some(submitted_at) = review.get("submittedAt").and_then(Value::as_str) else {
            continue;
        };
        let reviewer = review.get("author").and_then(login);
        if reviewer.is_some() && reviewer == author {
            continue;
        }
        let submitted_at = parse_utc_timestamp(submitted_at)?;
        review_count += 1;
        first_reviewed_at =
            Some(first_reviewed_at.map_or(submitted_at, |first| first.min(submitted_at)));
        if let Some(reviewer) = reviewer
            && !reviewers.contains(&reviewer)
        {
            reviewers.push(reviewer);
        }
    }

    let commits = value
        .get("commits")?
        .as_array()?
        .iter()
        .map(parse_commit)
        .collect::<Option<Vec<_>>>()?;
    Some(MergedPullRequest {
        snapshot: PullRequestSnapshot {
            number: integer("number")?,
            title: value.get("title")?.as_str()?.to_owned(),
            additions: integer("additions")?,
            deletions: integer("deletions")?,
            changed_files: integer("changedFiles")?,
            merge_commit_sha,
            review_count,
            reviewer_count: reviewers.len() as i64,
            first_reviewed_at,
        },
        commits,
    })
}

/// A commit of a pull request, with its message and first author shaped like the
/// commits git reports (`Name <email>`).
fn parse_commit(value: &Value) -> Option<LoggedCommit> {
    let text =
        |value: &Value, name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
    let headline = text(value, "messageHeadline")?;
    let body = text(value, "messageBody")?;
    let message = if body.trim().is_empty() {
        headline
    } else {
        format!("{headline}\n\n{}", body.trim_end())
    };
    let first_author = value.get("authors")?.as_array()?.first()?;
    let name = text(first_author, "name")?;
    let author = match text(first_author, "email") {
        Some(email) if !email.is_empty() => format!("{name} <{email}>"),
        _ => name,
    };
    Some(LoggedCommit {
        sha: text(value, "oid")?,
        message,
        author,
        committed_at: parse_utc_timestamp(value.get("committedDate")?.as_str()?)?,
    })
}

/// Seconds since the Unix epoch of a UTC timestamp as printed by `gh`, e.g.
/// `2026-10-09T14:47:45Z`.
fn parse_utc_timestamp(raw: &str) -> Option<i64> {
    let bytes = raw.as_bytes();
    let separators_match = bytes.len() == 20
        && [
            (4, b'-'),
            (7, b'-'),
            (10, b'T'),
            (13, b':'),
            (16, b':'),
            (19, b'Z'),
        ]
        .iter()
        .all(|&(index, separator)| bytes[index] == separator);
    if !separators_match {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let digits = &raw[range];
        digits
            .bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| digits.parse().ok())
            .flatten()
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => return None,
    };
    if !(1..=days_in_month).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Days from 1970-01-01 to the given proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil` algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

pub struct GitHub {
    runner: Box<dyn Runner>,
}

impl GitHub {
    pub fn new(runner: Box<dyn Runner>) -> Self {
        Self { runner }
    }

    /// The pull request from `head` into `base`, preferring merged over open over
    /// closed, then newest first. Read every result, including beyond the first page.
    pub fn find_pull_request(
        &self,
        repository: &GitHubRepository,
        head: &str,
        base: &str,
    ) -> Result<Option<PullRequest>, GitError> {
        let repository = repository.to_string();
        let mut limit = 100_usize;
        loop {
            // `gh pr list` paginates up to its limit, but has no unlimited flag.
            let invocation = invocation(&[
                "pr",
                "list",
                "--repo",
                &repository,
                "--head",
                head,
                "--base",
                base,
                "--state",
                "all",
                "--json",
                PULL_REQUEST_FIELDS,
                "--limit",
                &limit.to_string(),
            ]);
            let output = self.runner.run(&invocation)?;
            let unexpected = || unexpected(&invocation, &output);
            let values: Value = serde_json::from_str(&output).map_err(|_| unexpected())?;
            let values = values.as_array().ok_or_else(unexpected)?;
            let pull_requests = values
                .iter()
                .map(|value| parse_pull_request(value).ok_or_else(unexpected))
                .collect::<Result<Vec<_>, _>>()?;
            if values.len() < limit {
                return Ok(pull_requests
                    .into_iter()
                    .min_by_key(|pull_request| match pull_request.state {
                        PullRequestState::Merged => 0,
                        PullRequestState::Open => 1,
                        PullRequestState::Closed => 2,
                    }));
            }
            limit = limit.checked_mul(2).ok_or_else(unexpected)?;
        }
    }

    /// Opens a pull request and returns its URL.
    pub fn create_pull_request(
        &self,
        pull_request: &NewPullRequest<'_>,
    ) -> Result<String, GitError> {
        let repository = pull_request.repository.to_string();
        let invocation = invocation(&[
            "pr",
            "create",
            "--repo",
            &repository,
            "--head",
            pull_request.head,
            "--base",
            pull_request.base,
            "--title",
            pull_request.title,
            "--body",
            pull_request.body,
        ]);
        let output = self.runner.run(&invocation)?;
        output
            .lines()
            .map(str::trim)
            .rfind(|line| line.starts_with("https://") || line.starts_with("http://"))
            .map(str::to_owned)
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    /// The pull request at `url`, with its CI and review state.
    pub fn pull_request(&self, url: &str) -> Result<ViewedPullRequest, GitError> {
        let invocation = invocation(&["pr", "view", url, "--json", VIEWED_PULL_REQUEST_FIELDS]);
        let output = self.runner.run(&invocation)?;
        serde_json::from_str::<Value>(&output)
            .ok()
            .as_ref()
            .and_then(parse_viewed_pull_request)
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    /// Closes the pull request at `url` without merging it, leaving `comment` on it. The
    /// branch is kept.
    pub fn close_pull_request(&self, url: &str, comment: &str) -> Result<(), GitError> {
        self.runner
            .run(&invocation(&["pr", "close", url, "--comment", comment]))?;
        Ok(())
    }

    /// The body of the pull request at `url`.
    pub fn pull_request_body(&self, url: &str) -> Result<String, GitError> {
        let invocation = invocation(&["pr", "view", url, "--json", "body"]);
        let output = self.runner.run(&invocation)?;
        serde_json::from_str::<Value>(&output)
            .ok()
            .and_then(|value| value.get("body")?.as_str().map(str::to_owned))
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    /// Replaces the body of the pull request at `url`.
    pub fn edit_pull_request_body(&self, url: &str, body: &str) -> Result<(), GitError> {
        self.runner
            .run(&invocation(&["pr", "edit", url, "--body", body]))?;
        Ok(())
    }

    /// Issue `number` of `repository`; fails when it does not exist.
    pub fn issue(
        &self,
        repository: &GitHubRepository,
        number: i64,
    ) -> Result<LinkedIssue, GitError> {
        let repository = repository.to_string();
        let number = number.to_string();
        let invocation = invocation(&[
            "issue",
            "view",
            &number,
            "--repo",
            &repository,
            "--json",
            "number,url",
        ]);
        let output = self.runner.run(&invocation)?;
        serde_json::from_str::<Value>(&output)
            .ok()
            .and_then(|value| {
                Some(LinkedIssue {
                    number: value.get("number")?.as_i64()?,
                    url: value.get("url")?.as_str()?.to_owned(),
                })
            })
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    /// Opens an issue in `repository` and returns it.
    pub fn create_issue(
        &self,
        repository: &GitHubRepository,
        title: &str,
        body: &str,
    ) -> Result<LinkedIssue, GitError> {
        let repository = repository.to_string();
        let invocation = invocation(&[
            "issue",
            "create",
            "--repo",
            &repository,
            "--title",
            title,
            "--body",
            body,
        ]);
        let output = self.runner.run(&invocation)?;
        output
            .lines()
            .map(str::trim)
            .rfind(|line| line.starts_with("https://") || line.starts_with("http://"))
            .and_then(|url| {
                let (_, number) = url.rsplit_once("/issues/")?;
                Some(LinkedIssue {
                    number: number.parse().ok().filter(|number| *number > 0)?,
                    url: url.to_owned(),
                })
            })
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    /// The size, reviews, and commits of the merged pull request at `url`.
    pub fn merged_pull_request(&self, url: &str) -> Result<MergedPullRequest, GitError> {
        let invocation = invocation(&["pr", "view", url, "--json", MERGED_PULL_REQUEST_FIELDS]);
        let output = self.runner.run(&invocation)?;
        serde_json::from_str::<Value>(&output)
            .ok()
            .as_ref()
            .and_then(parse_merged_pull_request)
            .ok_or_else(|| unexpected(&invocation, &output))
    }
}

impl GitHub {
    /// Whether the pull request at `url` merges into its base without conflicts.
    pub fn mergeable(&self, url: &str) -> Result<MergeState, GitError> {
        let invocation = invocation(&["pr", "view", url, "--json", "mergeable"]);
        let output = self.runner.run(&invocation)?;
        let value: Option<Value> = serde_json::from_str(&output).ok();
        match value.as_ref().and_then(|value| value["mergeable"].as_str()) {
            Some("MERGEABLE") => Ok(MergeState::Mergeable),
            Some("CONFLICTING") => Ok(MergeState::Conflicting),
            Some("UNKNOWN") => Ok(MergeState::Unknown),
            _ => Err(unexpected(&invocation, &output)),
        }
    }
}

fn invocation(args: &[&str]) -> Invocation {
    Invocation {
        program: "gh",
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
    }
}

fn unexpected(invocation: &Invocation, output: &str) -> GitError {
    GitError::UnexpectedOutput {
        command: describe(invocation),
        output: output.trim().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::adapters::git::fake::FakeRunner;

    fn github(results: Vec<Result<String, GitError>>) -> (GitHub, Arc<FakeRunner>) {
        let runner = Arc::new(FakeRunner::new(results));
        (GitHub::new(Box::new(runner.clone())), runner)
    }

    fn repository() -> GitHubRepository {
        GitHubRepository::from_remote_url("git@github.com:acme/toodo.git").unwrap()
    }

    const URL: &str = "https://github.com/acme/toodo/pull/7";

    const MERGED_AT: &str = "2026-10-09T14:47:45Z";
    const MERGED_AT_SECONDS: i64 = 1_791_557_265;

    fn pull_request(state: PullRequestState, base: &str) -> PullRequest {
        PullRequest {
            url: URL.to_owned(),
            state,
            base: base.to_owned(),
            merged_at: (state == PullRequestState::Merged).then_some(MERGED_AT_SECONDS),
        }
    }

    #[test]
    fn mergeable_reads_whether_the_pull_request_conflicts() {
        let (github, runner) = github(vec![
            Ok(r#"{"mergeable":"MERGEABLE"}"#.to_owned()),
            Ok(r#"{"mergeable":"CONFLICTING"}"#.to_owned()),
            Ok(r#"{"mergeable":"UNKNOWN"}"#.to_owned()),
            Ok(r#"{"mergeable":null}"#.to_owned()),
        ]);
        assert_eq!(github.mergeable(URL).unwrap(), MergeState::Mergeable);
        assert_eq!(github.mergeable(URL).unwrap(), MergeState::Conflicting);
        assert_eq!(github.mergeable(URL).unwrap(), MergeState::Unknown);
        assert!(matches!(
            github.mergeable(URL),
            Err(GitError::UnexpectedOutput { .. })
        ));
        assert_eq!(
            runner.invocations.lock().unwrap()[0].args,
            ["pr", "view", URL, "--json", "mergeable"].map(str::to_owned)
        );
    }

    #[test]
    fn utc_timestamps_are_converted_to_unix_seconds() {
        assert_eq!(parse_utc_timestamp("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc_timestamp(MERGED_AT), Some(MERGED_AT_SECONDS));
        assert_eq!(
            parse_utc_timestamp("2024-02-29T23:59:59Z"),
            Some(1_709_251_199)
        );
        for malformed in [
            "",
            "2026-10-09",
            "2026-10-09 14:47:45Z",
            "2026-10-09T14:47:45+09:00",
            "2026-13-09T14:47:45Z",
            "2023-02-29T00:00:00Z",
            "2026-10-09T24:00:00Z",
            "2026-1a-09T14:47:45Z",
            "+026-10-09T14:47:45Z",
        ] {
            assert_eq!(parse_utc_timestamp(malformed), None, "{malformed}");
        }
    }

    #[test]
    fn find_pull_request_reads_the_pull_request_into_the_base() {
        let (github, runner) = github(vec![
            Ok(format!(
                r#"[{{"baseRefName":"main","mergedAt":"{MERGED_AT}","state":"MERGED","url":"{URL}"}}]"#
            )),
            Ok("[]\n".to_owned()),
        ]);
        assert_eq!(
            github
                .find_pull_request(&repository(), "feat/x-1", "main")
                .unwrap(),
            Some(pull_request(PullRequestState::Merged, "main"))
        );
        assert_eq!(
            github
                .find_pull_request(&repository(), "feat/x-1", "main")
                .unwrap(),
            None
        );
        assert_eq!(
            runner.invocations.lock().unwrap()[0],
            invocation(&[
                "pr",
                "list",
                "--repo",
                "github.com/acme/toodo",
                "--head",
                "feat/x-1",
                "--base",
                "main",
                "--state",
                "all",
                "--json",
                "url,state,baseRefName,mergedAt",
                "--limit",
                "100",
            ])
        );
    }

    #[test]
    fn find_pull_request_prefers_merged_then_open_then_closed() {
        let closed = r#"{"baseRefName":"main","mergedAt":null,"state":"CLOSED","url":"https://github.com/acme/toodo/pull/12"}"#;
        let open = r#"{"baseRefName":"main","mergedAt":null,"state":"OPEN","url":"https://github.com/acme/toodo/pull/13"}"#;
        let merged = format!(
            r#"{{"baseRefName":"main","mergedAt":"{MERGED_AT}","state":"MERGED","url":"https://github.com/acme/toodo/pull/11"}}"#
        );
        let (github, _) = github(vec![
            Ok(format!("[{closed},{open},{merged}]")),
            Ok(format!("[{closed},{open}]")),
            Ok(format!("[{closed}]")),
        ]);
        for (number, state) in [
            (11, PullRequestState::Merged),
            (13, PullRequestState::Open),
            (12, PullRequestState::Closed),
        ] {
            let found = github
                .find_pull_request(&repository(), "feat/x-1", "main")
                .unwrap()
                .unwrap();
            assert_eq!(
                found.url,
                format!("https://github.com/acme/toodo/pull/{number}")
            );
            assert_eq!(found.state, state);
        }
    }

    #[test]
    fn find_pull_request_reads_beyond_the_first_page() {
        let closed =
            format!(r#"{{"baseRefName":"main","mergedAt":null,"state":"CLOSED","url":"{URL}"}}"#);
        let page = std::iter::repeat_n(closed.as_str(), 100)
            .collect::<Vec<_>>()
            .join(",");
        let (github, runner) = github(vec![
            Ok(format!("[{page}]")),
            Ok(format!(
                r#"[{page},{{"baseRefName":"main","mergedAt":"{MERGED_AT}","state":"MERGED","url":"{URL}"}}]"#
            )),
        ]);
        assert_eq!(
            github
                .find_pull_request(&repository(), "feat/x-1", "main")
                .unwrap(),
            Some(pull_request(PullRequestState::Merged, "main"))
        );
        assert_eq!(
            runner.invocations.lock().unwrap()[1].args.last().unwrap(),
            "200"
        );
    }

    #[test]
    fn find_pull_request_rejects_unexpected_output() {
        let (github, _) = github(vec![
            Ok("no pull requests\n".to_owned()),
            Ok(format!(r#"[{{"url":"{URL}","state":"OPEN"}}]"#)),
            Ok(format!(
                r#"[{{"baseRefName":"main","mergedAt":"yesterday","state":"MERGED","url":"{URL}"}}]"#
            )),
        ]);
        for _ in 0..3 {
            assert!(matches!(
                github.find_pull_request(&repository(), "feat/x-1", "main"),
                Err(GitError::UnexpectedOutput { .. })
            ));
        }
    }

    #[test]
    fn pull_request_reads_state_base_and_merge_time() {
        let view = |state: &str| {
            let merged_at = if state == "MERGED" {
                format!("\"{MERGED_AT}\"")
            } else {
                "null".to_owned()
            };
            Ok(format!(
                r#"{{"baseRefName":"develop","latestReviews":[],"mergedAt":{merged_at},"reviewDecision":"","state":"{state}","statusCheckRollup":[],"url":"{URL}"}}"#
            ))
        };
        let (github, runner) = github(vec![
            view("MERGED"),
            view("OPEN"),
            view("CLOSED"),
            view("DRAFT"),
        ]);
        for state in [
            PullRequestState::Merged,
            PullRequestState::Open,
            PullRequestState::Closed,
        ] {
            assert_eq!(
                github.pull_request(URL).unwrap(),
                ViewedPullRequest {
                    pull_request: pull_request(state, "develop"),
                    status: PullRequestStatus {
                        checks: None,
                        review: ReviewState::Pending,
                    },
                    head_sha: None,
                }
            );
        }
        assert!(matches!(
            github.pull_request(URL),
            Err(GitError::UnexpectedOutput { .. })
        ));
        assert_eq!(
            runner.invocations.lock().unwrap()[0],
            invocation(&[
                "pr",
                "view",
                URL,
                "--json",
                "url,state,baseRefName,mergedAt,statusCheckRollup,reviewDecision,latestReviews,headRefOid"
            ])
        );
    }

    #[test]
    fn pull_request_combines_checks_and_reviews() {
        let run = |status: &str, conclusion: &str| {
            format!(
                r#"{{"__typename":"CheckRun","status":"{status}","conclusion":"{conclusion}"}}"#
            )
        };
        let context =
            |state: &str| format!(r#"{{"__typename":"StatusContext","state":"{state}"}}"#);
        let review = |state: &str| format!(r#"{{"state":"{state}"}}"#);
        let view = |checks: &[String], decision: &str, reviews: &[String]| {
            Ok(format!(
                r#"{{"baseRefName":"main","latestReviews":[{}],"mergedAt":null,"reviewDecision":{decision},"state":"OPEN","statusCheckRollup":[{}],"url":"{URL}"}}"#,
                reviews.join(","),
                checks.join(","),
            ))
        };
        let passed = run("COMPLETED", "SUCCESS");
        let skipped = run("COMPLETED", "SKIPPED");
        let running = run("IN_PROGRESS", "");
        let failed = run("COMPLETED", "FAILURE");
        let cases = [
            // Required reviews decide on their own.
            (
                view(&[passed.clone(), skipped.clone()], r#""APPROVED""#, &[]),
                Some(ChecksState::Passing),
                ReviewState::Approved,
            ),
            (
                view(
                    &[passed.clone(), running.clone()],
                    r#""CHANGES_REQUESTED""#,
                    &[],
                ),
                Some(ChecksState::Pending),
                ReviewState::ChangesRequested,
            ),
            (
                view(
                    &[running.clone(), failed.clone()],
                    r#""REVIEW_REQUIRED""#,
                    &[review("APPROVED")],
                ),
                Some(ChecksState::Failing),
                ReviewState::Pending,
            ),
            // Without required reviews, the latest reviews decide.
            (
                view(
                    &[context("SUCCESS")],
                    r#""""#,
                    &[review("COMMENTED"), review("APPROVED")],
                ),
                Some(ChecksState::Passing),
                ReviewState::Approved,
            ),
            (
                view(
                    &[context("PENDING")],
                    "null",
                    &[review("APPROVED"), review("CHANGES_REQUESTED")],
                ),
                Some(ChecksState::Pending),
                ReviewState::ChangesRequested,
            ),
            (
                view(
                    &[passed.clone(), context("ERROR")],
                    r#""""#,
                    &[review("COMMENTED")],
                ),
                Some(ChecksState::Failing),
                ReviewState::Pending,
            ),
        ];
        let (github, _) = github(cases.iter().map(|(view, ..)| view.clone()).collect());
        for (index, (_, checks, review)) in cases.into_iter().enumerate() {
            assert_eq!(
                github.pull_request(URL).unwrap().status,
                PullRequestStatus { checks, review },
                "case {index}"
            );
        }
    }

    /// `gh pr view --json` output of a merged pull request by `ada`.
    fn merged_view(reviews: &str, commits: &str) -> String {
        format!(
            r#"{{"additions":120,"author":{{"login":"ada"}},"changedFiles":4,"commits":[{commits}],"deletions":30,"mergeCommit":{{"oid":"abc123"}},"number":7,"reviews":[{reviews}],"title":"Add login"}}"#
        )
    }

    fn review(login: &str, submitted_at: &str) -> String {
        format!(
            r#"{{"author":{{"login":"{login}"}},"state":"COMMENTED","submittedAt":"{submitted_at}"}}"#
        )
    }

    fn pr_commit(sha: &str, headline: &str, body: &str) -> String {
        format!(
            r#"{{"authors":[{{"email":"ada@example.com","login":"ada","name":"Ada"}}],"committedDate":"{MERGED_AT}","messageBody":"{body}","messageHeadline":"{headline}","oid":"{sha}"}}"#
        )
    }

    #[test]
    fn merged_pull_request_reads_size_reviews_by_others_and_commits() {
        let reviews = [
            review("bob", "2026-10-10T10:00:00Z"),
            review("ada", "2026-10-08T10:00:00Z"),
            review("bob", "2026-10-11T10:00:00Z"),
            review("cy", "2026-10-09T10:00:00Z"),
            r#"{"author":{"login":"dan"},"state":"PENDING","submittedAt":null}"#.to_owned(),
        ]
        .join(",");
        let commits = [
            pr_commit("aaa", "Add login", ""),
            pr_commit("bbb", "Fix login", "With a body\\n"),
        ]
        .join(",");
        let (github, runner) = github(vec![
            Ok(merged_view(&reviews, &commits)),
            Ok(merged_view("", "").replace(r#"{"oid":"abc123"}"#, "null")),
            Ok(merged_view(&review("bob", "soon"), "")),
        ]);

        let merged = github.merged_pull_request(URL).unwrap();
        assert_eq!(
            merged.snapshot,
            PullRequestSnapshot {
                number: 7,
                title: "Add login".to_owned(),
                additions: 120,
                deletions: 30,
                changed_files: 4,
                merge_commit_sha: Some("abc123".to_owned()),
                review_count: 3,
                reviewer_count: 2,
                first_reviewed_at: parse_utc_timestamp("2026-10-09T10:00:00Z"),
            }
        );
        assert_eq!(
            merged.commits,
            [
                LoggedCommit {
                    sha: "aaa".to_owned(),
                    message: "Add login".to_owned(),
                    author: "Ada <ada@example.com>".to_owned(),
                    committed_at: MERGED_AT_SECONDS,
                },
                LoggedCommit {
                    sha: "bbb".to_owned(),
                    message: "Fix login\n\nWith a body".to_owned(),
                    author: "Ada <ada@example.com>".to_owned(),
                    committed_at: MERGED_AT_SECONDS,
                },
            ]
        );
        assert_eq!(
            runner.invocations.lock().unwrap()[0],
            invocation(&[
                "pr",
                "view",
                URL,
                "--json",
                "number,title,additions,deletions,changedFiles,mergeCommit,author,reviews,commits"
            ])
        );

        let without_reviews = github.merged_pull_request(URL).unwrap();
        assert_eq!(without_reviews.snapshot.merge_commit_sha, None);
        assert_eq!(without_reviews.snapshot.review_count, 0);
        assert_eq!(without_reviews.snapshot.first_reviewed_at, None);
        assert!(without_reviews.commits.is_empty());
        assert!(matches!(
            github.merged_pull_request(URL),
            Err(GitError::UnexpectedOutput { .. })
        ));
    }

    const ISSUE: &str = "https://github.com/acme/toodo/issues/12";

    #[test]
    fn issue_reads_the_number_and_url_of_an_existing_issue() {
        let (github, runner) = github(vec![
            Ok(format!(r#"{{"number":12,"url":"{ISSUE}"}}"#)),
            Ok("{}".to_owned()),
        ]);
        assert_eq!(
            github.issue(&repository(), 12).unwrap(),
            LinkedIssue {
                number: 12,
                url: ISSUE.to_owned()
            }
        );
        assert!(matches!(
            github.issue(&repository(), 12),
            Err(GitError::UnexpectedOutput { .. })
        ));
        assert_eq!(
            runner.invocations.lock().unwrap()[0],
            invocation(&[
                "issue",
                "view",
                "12",
                "--repo",
                "github.com/acme/toodo",
                "--json",
                "number,url"
            ])
        );
    }

    #[test]
    fn create_issue_reads_the_number_from_the_printed_url() {
        let (github, runner) = github(vec![
            Ok(format!("\nCreating issue in acme/toodo\n\n{ISSUE}\n")),
            Ok("https://github.com/acme/toodo/pull/3\n".to_owned()),
        ]);
        assert_eq!(
            github
                .create_issue(&repository(), "Fix login", "Steps")
                .unwrap(),
            LinkedIssue {
                number: 12,
                url: ISSUE.to_owned()
            }
        );
        assert!(matches!(
            github.create_issue(&repository(), "Fix login", ""),
            Err(GitError::UnexpectedOutput { .. })
        ));
        assert_eq!(
            runner.invocations.lock().unwrap()[0].args,
            [
                "issue",
                "create",
                "--repo",
                "github.com/acme/toodo",
                "--title",
                "Fix login",
                "--body",
                "Steps",
            ]
            .map(str::to_owned)
        );
    }

    #[test]
    fn the_body_of_a_pull_request_is_read_and_replaced() {
        let (github, runner) = github(vec![
            Ok(r#"{"body":"Adds login.\n"}"#.to_owned()),
            Ok(String::new()),
        ]);
        assert_eq!(github.pull_request_body(URL).unwrap(), "Adds login.\n");
        github
            .edit_pull_request_body(URL, "Adds login.\n\nCloses #12")
            .unwrap();
        assert_eq!(
            runner.invocations.lock().unwrap()[1].args,
            ["pr", "edit", URL, "--body", "Adds login.\n\nCloses #12"].map(str::to_owned)
        );
    }

    #[test]
    fn create_pull_request_returns_the_printed_url() {
        let (github, runner) = github(vec![
            Ok("\nhttps://github.com/acme/toodo/pull/8\n".to_owned()),
            Ok("Creating pull request\n".to_owned()),
        ]);
        let repository = repository();
        let new = NewPullRequest {
            repository: &repository,
            head: "feat/x-1",
            base: "main",
            title: "Add x",
            body: "",
        };
        assert_eq!(
            github.create_pull_request(&new).unwrap(),
            "https://github.com/acme/toodo/pull/8"
        );
        assert_eq!(
            runner.invocations.lock().unwrap()[0].args,
            [
                "pr",
                "create",
                "--repo",
                "github.com/acme/toodo",
                "--head",
                "feat/x-1",
                "--base",
                "main",
                "--title",
                "Add x",
                "--body",
                "",
            ]
            .map(str::to_owned)
        );
        assert!(matches!(
            github.create_pull_request(&new),
            Err(GitError::UnexpectedOutput { .. })
        ));
    }
}
