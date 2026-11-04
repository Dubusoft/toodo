//! Opens GitHub pull requests and reads their state behind the [`GitHub`] trait. Its
//! backend [`GhCli`] runs the `gh` CLI, reusing its authentication. `gh` always
//! runs on this machine and names the repository with `--repo`, so it does not need a
//! local checkout and works for workspaces on SSH machines too.
//!
//! Processes are started through the [`Runner`] of the git adapter, so tests can fake
//! them the same way.

use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::git::{GitError, Invocation, LoggedCommit, Runner, describe};
use crate::domain::backup::civil_from_days;
use crate::domain::model::{LinkedIssue, PullRequestOptions, PullRequestSnapshot};
use crate::domain::remote::GitHubRepository;

/// A pull request to open from `head` into `base`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewPullRequest<'a> {
    pub repository: &'a GitHubRepository,
    pub head: &'a str,
    pub base: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub options: &'a PullRequestOptions,
}

/// Why GitHub refused to open a pull request, read from what `gh pr create` printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestRefusal {
    /// gh has no login, or GitHub rejected its token.
    NotLoggedIn,
    /// The login may not open pull requests in the repository.
    PermissionDenied,
    /// A reviewer is not a user or team that can review in the repository, or is the
    /// author of the pull request.
    InvalidReviewer,
    /// A label does not exist in the repository.
    UnknownLabel,
    /// The repository does not allow draft pull requests.
    DraftUnsupported,
    /// A pull request from the branch into the base is already open.
    AlreadyExists,
    /// The branch on GitHub has no commits that are not on the base.
    NoCommits,
}

impl PullRequestRefusal {
    /// The refusal `error` of `gh pr create` reports; `None` for any other failure.
    pub fn of(error: &GitError) -> Option<Self> {
        let GitError::Failed { stderr, .. } = error else {
            return None;
        };
        let stderr = stderr.to_ascii_lowercase();
        let has = |text: &str| stderr.contains(text);
        Some(if has("could not add label") {
            Self::UnknownLabel
        } else if has("could not request reviewer")
            || has("requestreviews")
            || has("review cannot be requested")
        {
            Self::InvalidReviewer
        } else if has("draft pull requests are not supported") {
            Self::DraftUnsupported
        } else if has("already exists") {
            Self::AlreadyExists
        } else if has("no commits between") {
            Self::NoCommits
        } else if has("gh auth login") || has("http 401") || has("bad credentials") {
            Self::NotLoggedIn
        } else if has("http 403") || has("resource not accessible") || has("must be a collaborator")
        {
            Self::PermissionDenied
        } else {
            return None;
        })
    }
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

/// One CI check of a pull request: a check run (GitHub Actions) or a commit status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRun {
    /// The check run's name or the commit status's context; empty when `gh` reports none.
    pub name: String,
    pub state: ChecksState,
    /// How it ended as GitHub reports it, lowercased (e.g. `failure`, `skipped`); `None`
    /// while a check run has not finished.
    pub conclusion: Option<String>,
    /// The page with its details or log.
    pub url: Option<String>,
}

/// The latest review of one reviewer of a pull request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Review {
    /// The reviewer's login; `None` once their account is deleted.
    pub author: Option<String>,
    /// The review state as GitHub reports it, lowercased (e.g. `approved`,
    /// `changes_requested`, `commented`).
    pub state: String,
}

/// A pull request read with [`GitHub::pull_request`], with its CI and review state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewedPullRequest {
    pub pull_request: PullRequest,
    pub status: PullRequestStatus,
    /// The commit at the head of its branch, which its checks ran on.
    pub head_sha: Option<String>,
    /// Each check that [`PullRequestStatus::checks`] combines, in the order `gh` lists them.
    pub check_runs: Vec<CheckRun>,
    /// The latest review of each reviewer.
    pub reviews: Vec<Review>,
}

/// Fields requested with `--json` for a [`ViewedPullRequest`].
const VIEWED_PULL_REQUEST_FIELDS: &str =
    "url,state,baseRefName,mergedAt,statusCheckRollup,reviewDecision,latestReviews,headRefOid";

fn parse_viewed_pull_request(value: &Value) -> Option<ViewedPullRequest> {
    let check_runs = parse_check_runs(value.get("statusCheckRollup")?.as_array()?)?;
    Some(ViewedPullRequest {
        pull_request: parse_pull_request(value)?,
        status: PullRequestStatus {
            checks: combine_checks(&check_runs),
            review: parse_review(value)?,
        },
        head_sha: value
            .get("headRefOid")
            .and_then(Value::as_str)
            .map(str::to_owned),
        check_runs,
        reviews: parse_latest_reviews(value.get("latestReviews")?.as_array()?)?,
    })
}

fn parse_latest_reviews(latest: &[Value]) -> Option<Vec<Review>> {
    latest
        .iter()
        .map(|review| {
            Some(Review {
                author: review
                    .get("author")
                    .and_then(|author| author.get("login"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                state: review.get("state")?.as_str()?.to_lowercase(),
            })
        })
        .collect()
}

/// What a pull request shows on the git activity timeline of its task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestActivity {
    pub number: i64,
    pub url: String,
    pub title: String,
    /// Creation time in seconds since the Unix epoch.
    pub created_at: i64,
    /// Merge time in seconds since the Unix epoch; `None` until it is merged.
    pub merged_at: Option<i64>,
    /// The commit at the head of its branch, which its checks ran on.
    pub head_sha: Option<String>,
    /// The combined state of its checks with the latest time one of them finished,
    /// if known; `None` when it has no checks.
    pub checks: Option<(ChecksState, Option<i64>)>,
}

/// Fields requested with `--json` for a [`PullRequestActivity`].
const PULL_REQUEST_ACTIVITY_FIELDS: &str =
    "number,title,url,createdAt,state,mergedAt,headRefOid,statusCheckRollup";

fn parse_pull_request_activity(value: &Value) -> Option<PullRequestActivity> {
    let field = |name: &str| value.get(name).and_then(Value::as_str);
    let merged_at = match value.get("mergedAt")? {
        Value::Null => None,
        Value::String(raw) => Some(parse_utc_timestamp(raw)?),
        _ => return None,
    };
    let rollup = value.get("statusCheckRollup")?.as_array()?;
    // `gh` prints the zero time `0001-01-01T00:00:00Z` for a check that has not finished.
    let finished_at = rollup
        .iter()
        .filter_map(|check| {
            let name = match check.get("__typename")?.as_str()? {
                "CheckRun" => "completedAt",
                "StatusContext" => "startedAt",
                _ => return None,
            };
            parse_utc_timestamp(check.get(name)?.as_str()?)
        })
        .filter(|time| *time > 0)
        .max();
    Some(PullRequestActivity {
        number: value.get("number")?.as_i64()?,
        url: field("url")?.to_owned(),
        title: field("title")?.to_owned(),
        created_at: parse_utc_timestamp(field("createdAt")?)?,
        merged_at,
        head_sha: field("headRefOid")
            .filter(|sha| !sha.is_empty())
            .map(str::to_owned),
        checks: parse_checks(rollup)?.map(|state| (state, finished_at)),
    })
}

/// A pull request as [`GitHub::pull_request`], [`GitHub::pull_request_activity`], and
/// [`GitHub::pull_request_body`] read it, from a single `gh` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequestDetails {
    pub viewed: ViewedPullRequest,
    pub activity: PullRequestActivity,
    pub body: String,
}

/// Fields requested with `--json` for [`PullRequestDetails`]: those of a
/// [`ViewedPullRequest`] and a [`PullRequestActivity`], and the body.
const PULL_REQUEST_DETAILS_FIELDS: &str = "url,state,baseRefName,mergedAt,statusCheckRollup,\
     reviewDecision,latestReviews,headRefOid,number,title,createdAt,body";

fn parse_pull_request_details(value: &Value) -> Option<PullRequestDetails> {
    Some(PullRequestDetails {
        viewed: parse_viewed_pull_request(value)?,
        activity: parse_pull_request_activity(value)?,
        body: value.get("body")?.as_str()?.to_owned(),
    })
}

/// The repository of the pull request at `url` (`https://<host>/<owner>/<name>/pull/<n>`).
pub fn pull_request_repository(url: &str) -> Option<GitHubRepository> {
    let (repository, _) = url.split_once("/pull/")?;
    GitHubRepository::from_remote_url(repository)
}

/// The combined state of the checks in `rollup`; see [`combine_checks`].
fn parse_checks(rollup: &[Value]) -> Option<Option<ChecksState>> {
    Some(combine_checks(&parse_check_runs(rollup)?))
}

/// Reads check runs (GitHub Actions) and commit statuses; other kinds are skipped.
fn parse_check_runs(rollup: &[Value]) -> Option<Vec<CheckRun>> {
    let mut runs = Vec::new();
    for check in rollup {
        let field = |name: &str| check.get(name).and_then(Value::as_str);
        let text = |name: &str| {
            field(name)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        let (state, conclusion, name, url) = match field("__typename")? {
            "CheckRun" if field("status")? != "COMPLETED" => {
                (ChecksState::Pending, None, "name", "detailsUrl")
            }
            "CheckRun" => {
                let conclusion = field("conclusion")?;
                let state = match conclusion {
                    "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED"
                    | "STARTUP_FAILURE" => ChecksState::Failing,
                    _ => ChecksState::Passing,
                };
                (state, Some(conclusion), "name", "detailsUrl")
            }
            "StatusContext" => {
                let raw = field("state")?;
                let state = match raw {
                    "FAILURE" | "ERROR" => ChecksState::Failing,
                    "PENDING" | "EXPECTED" => ChecksState::Pending,
                    _ => ChecksState::Passing,
                };
                (state, Some(raw), "context", "targetUrl")
            }
            _ => continue,
        };
        runs.push(CheckRun {
            name: text(name).unwrap_or_default(),
            state,
            conclusion: conclusion
                .filter(|conclusion| !conclusion.is_empty())
                .map(str::to_lowercase),
            url: text(url),
        });
    }
    Some(runs)
}

/// Any failure fails the pull request, otherwise any unfinished check keeps it pending;
/// `None` without checks.
fn combine_checks(runs: &[CheckRun]) -> Option<ChecksState> {
    runs.iter()
        .map(|run| run.state)
        .reduce(|combined, state| match (combined, state) {
            (ChecksState::Failing, _) | (_, ChecksState::Failing) => ChecksState::Failing,
            (ChecksState::Pending, _) | (_, ChecksState::Pending) => ChecksState::Pending,
            _ => ChecksState::Passing,
        })
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

/// A merged pull request as [`GitHub::merged_pull_requests`] lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedPullRequest {
    pub url: String,
    pub number: i64,
    pub title: String,
    /// Branch the pull request was opened from.
    pub head: String,
    pub created_at: i64,
    pub merged_at: i64,
}

/// Fields requested with `--json` for a [`ListedPullRequest`].
const LISTED_PULL_REQUEST_FIELDS: &str = "url,number,title,headRefName,createdAt,mergedAt";

fn parse_listed_pull_request(value: &Value) -> Option<ListedPullRequest> {
    let field = |name: &str| value.get(name).and_then(Value::as_str);
    Some(ListedPullRequest {
        url: field("url")?.to_owned(),
        number: value.get("number")?.as_i64()?,
        title: field("title")?.to_owned(),
        head: field("headRefName")?.to_owned(),
        created_at: parse_utc_timestamp(field("createdAt")?)?,
        merged_at: parse_utc_timestamp(field("mergedAt")?)?,
    })
}

/// The UTC day of `seconds` since the Unix epoch as `YYYY-MM-DD`, as GitHub's search
/// qualifiers take it.
fn utc_date(seconds: i64) -> String {
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
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

/// Pull requests and issues on GitHub. [`GhCli`] implements it with the `gh` CLI;
/// callers depend on the trait so other backends can be added.
pub trait GitHub: Send + Sync {
    /// The pull request from `head` into `base`, preferring merged over open over
    /// closed, then newest first. Read every result, including beyond the first page.
    fn find_pull_request(
        &self,
        repository: &GitHubRepository,
        head: &str,
        base: &str,
    ) -> Result<Option<PullRequest>, GitError>;

    /// Opens a pull request and returns its URL.
    fn create_pull_request(&self, pull_request: &NewPullRequest<'_>) -> Result<String, GitError>;

    /// The pull request at `url`, with its CI and review state.
    fn pull_request(&self, url: &str) -> Result<ViewedPullRequest, GitError>;

    /// The pull request at `url` as its task's git activity timeline shows it.
    fn pull_request_activity(&self, url: &str) -> Result<PullRequestActivity, GitError>;

    /// Closes the pull request at `url` without merging it, leaving `comment` on it. The
    /// branch is kept.
    fn close_pull_request(&self, url: &str, comment: &str) -> Result<(), GitError>;

    /// The body of the pull request at `url`.
    fn pull_request_body(&self, url: &str) -> Result<String, GitError>;

    /// Replaces the body of the pull request at `url`.
    fn edit_pull_request_body(&self, url: &str, body: &str) -> Result<(), GitError>;

    /// Issue `number` of `repository`; fails when it does not exist.
    fn issue(&self, repository: &GitHubRepository, number: i64) -> Result<LinkedIssue, GitError>;

    /// Opens an issue in `repository` and returns it.
    fn create_issue(
        &self,
        repository: &GitHubRepository,
        title: &str,
        body: &str,
    ) -> Result<LinkedIssue, GitError>;

    /// The size, reviews, and commits of the merged pull request at `url`.
    fn merged_pull_request(&self, url: &str) -> Result<MergedPullRequest, GitError>;

    /// Whether the pull request at `url` merges into its base without conflicts.
    fn mergeable(&self, url: &str) -> Result<MergeState, GitError>;

    /// The pull request at `url` with everything [`PullRequestDetails`] holds, in one call.
    fn pull_request_details(&self, url: &str) -> Result<PullRequestDetails, GitError>;

    /// Every open pull request of `repository` with its details, read in one call for up
    /// to 100 of them. Read every result, including beyond the first page.
    fn open_pull_requests(
        &self,
        repository: &GitHubRepository,
    ) -> Result<Vec<PullRequestDetails>, GitError>;

    /// The pull requests the signed-in `gh` user opened in `repository` and merged into
    /// `base` in `[since, until)` (seconds since the Unix epoch), oldest merge first.
    /// Read every result, including beyond the first page.
    fn merged_pull_requests(
        &self,
        repository: &GitHubRepository,
        base: &str,
        since: i64,
        until: i64,
    ) -> Result<Vec<ListedPullRequest>, GitError>;

    /// How much longer callers that poll GitHub should wait because GitHub refused a call
    /// for its API rate limit; `None` when no limit is in effect.
    fn rate_limit_backoff(&self) -> Option<Duration>;
}

/// The first wait after GitHub refuses a call for its rate limit; each refusal in a row
/// doubles it up to [`MAX_RATE_LIMIT_BACKOFF`].
const FIRST_RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(5 * 60);

/// GitHub resets its primary rate limit every hour.
const MAX_RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(60 * 60);

/// Whether GitHub refused a call for its rate limit: its primary limit (`API rate limit
/// exceeded`), a secondary limit, or `429 Too Many Requests`.
fn is_rate_limited(error: &GitError) -> bool {
    match error {
        GitError::Failed { stderr, .. } => {
            stderr.to_ascii_lowercase().contains("rate limit") || stderr.contains("HTTP 429")
        }
        _ => false,
    }
}

/// Since when and for how long GitHub calls back off after a rate limit refusal.
#[derive(Debug, Default)]
struct RateLimit {
    until: Option<Instant>,
    backoff: Duration,
}

impl RateLimit {
    /// Records the result of a call that ended at `now`: a rate limit refusal backs off
    /// for twice as long as the last one, any other failure changes nothing, and a
    /// success ends the backoff.
    fn record(&mut self, now: Instant, result: &Result<String, GitError>) {
        match result {
            Ok(_) => *self = Self::default(),
            Err(error) if is_rate_limited(error) => {
                self.backoff = if self.backoff.is_zero() {
                    FIRST_RATE_LIMIT_BACKOFF
                } else {
                    (self.backoff * 2).min(MAX_RATE_LIMIT_BACKOFF)
                };
                self.until = Some(now + self.backoff);
            }
            Err(_) => {}
        }
    }

    /// How long the backoff still lasts at `now`.
    fn remaining(&self, now: Instant) -> Option<Duration> {
        self.until
            .map(|until| until.saturating_duration_since(now))
            .filter(|remaining| !remaining.is_zero())
    }
}

/// [`GitHub`] through the `gh` CLI.
pub struct GhCli {
    runner: Box<dyn Runner>,
    rate_limit: Mutex<RateLimit>,
}

impl GhCli {
    pub fn new(runner: Box<dyn Runner>) -> Self {
        Self {
            runner,
            rate_limit: Mutex::default(),
        }
    }

    fn run(&self, invocation: &Invocation) -> Result<String, GitError> {
        let result = self.runner.run(invocation);
        self.rate_limit
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .record(Instant::now(), &result);
        result.map_err(diagnose)
    }

    /// Reads `fields` of every pull request `gh pr list` finds with `filters`, raising
    /// the limit until a page is not full, as `gh pr list` has no unlimited flag.
    fn list_pull_requests(
        &self,
        repository: &GitHubRepository,
        filters: &[&str],
        fields: &str,
    ) -> Result<(Invocation, String, Vec<Value>), GitError> {
        let repository = repository.to_string();
        let mut limit = 100_usize;
        loop {
            let limit_text = limit.to_string();
            let mut args = vec!["pr", "list", "--repo", &repository];
            args.extend(filters);
            args.extend(["--json", fields, "--limit", &limit_text]);
            let invocation = invocation(&args);
            let output = self.run(&invocation)?;
            let unexpected = || unexpected(&invocation, &output);
            let values: Value = serde_json::from_str(&output).map_err(|_| unexpected())?;
            let values = values.as_array().ok_or_else(unexpected)?.clone();
            if values.len() < limit {
                return Ok((invocation, output, values));
            }
            limit = limit.checked_mul(2).ok_or_else(unexpected)?;
        }
    }
}

impl GitHub for GhCli {
    fn find_pull_request(
        &self,
        repository: &GitHubRepository,
        head: &str,
        base: &str,
    ) -> Result<Option<PullRequest>, GitError> {
        let (invocation, output, values) = self.list_pull_requests(
            repository,
            &["--head", head, "--base", base, "--state", "all"],
            PULL_REQUEST_FIELDS,
        )?;
        let pull_requests = values
            .iter()
            .map(|value| parse_pull_request(value).ok_or_else(|| unexpected(&invocation, &output)))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(pull_requests
            .into_iter()
            .min_by_key(|pull_request| match pull_request.state {
                PullRequestState::Merged => 0,
                PullRequestState::Open => 1,
                PullRequestState::Closed => 2,
            }))
    }

    fn create_pull_request(&self, pull_request: &NewPullRequest<'_>) -> Result<String, GitError> {
        let repository = pull_request.repository.to_string();
        let options = pull_request.options;
        let mut args = vec![
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
        ];
        if options.draft {
            args.push("--draft");
        }
        for reviewer in &options.reviewers {
            args.extend(["--reviewer", reviewer]);
        }
        for label in &options.labels {
            args.extend(["--label", label]);
        }
        let invocation = invocation(&args);
        let output = self.run(&invocation)?;
        output
            .lines()
            .map(str::trim)
            .rfind(|line| line.starts_with("https://") || line.starts_with("http://"))
            .map(str::to_owned)
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    fn pull_request(&self, url: &str) -> Result<ViewedPullRequest, GitError> {
        let invocation = invocation(&["pr", "view", url, "--json", VIEWED_PULL_REQUEST_FIELDS]);
        let output = self.run(&invocation)?;
        serde_json::from_str::<Value>(&output)
            .ok()
            .as_ref()
            .and_then(parse_viewed_pull_request)
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    fn pull_request_activity(&self, url: &str) -> Result<PullRequestActivity, GitError> {
        let invocation = invocation(&["pr", "view", url, "--json", PULL_REQUEST_ACTIVITY_FIELDS]);
        let output = self.run(&invocation)?;
        serde_json::from_str::<Value>(&output)
            .ok()
            .as_ref()
            .and_then(parse_pull_request_activity)
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    fn close_pull_request(&self, url: &str, comment: &str) -> Result<(), GitError> {
        self.run(&invocation(&["pr", "close", url, "--comment", comment]))?;
        Ok(())
    }

    fn pull_request_body(&self, url: &str) -> Result<String, GitError> {
        let invocation = invocation(&["pr", "view", url, "--json", "body"]);
        let output = self.run(&invocation)?;
        serde_json::from_str::<Value>(&output)
            .ok()
            .and_then(|value| value.get("body")?.as_str().map(str::to_owned))
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    fn edit_pull_request_body(&self, url: &str, body: &str) -> Result<(), GitError> {
        self.run(&invocation(&["pr", "edit", url, "--body", body]))?;
        Ok(())
    }

    fn issue(&self, repository: &GitHubRepository, number: i64) -> Result<LinkedIssue, GitError> {
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
        let output = self.run(&invocation)?;
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

    fn create_issue(
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
        let output = self.run(&invocation)?;
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

    fn merged_pull_request(&self, url: &str) -> Result<MergedPullRequest, GitError> {
        let invocation = invocation(&["pr", "view", url, "--json", MERGED_PULL_REQUEST_FIELDS]);
        let output = self.run(&invocation)?;
        serde_json::from_str::<Value>(&output)
            .ok()
            .as_ref()
            .and_then(parse_merged_pull_request)
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    fn mergeable(&self, url: &str) -> Result<MergeState, GitError> {
        let invocation = invocation(&["pr", "view", url, "--json", "mergeable"]);
        let output = self.run(&invocation)?;
        let value: Option<Value> = serde_json::from_str(&output).ok();
        match value.as_ref().and_then(|value| value["mergeable"].as_str()) {
            Some("MERGEABLE") => Ok(MergeState::Mergeable),
            Some("CONFLICTING") => Ok(MergeState::Conflicting),
            Some("UNKNOWN") => Ok(MergeState::Unknown),
            _ => Err(unexpected(&invocation, &output)),
        }
    }

    fn pull_request_details(&self, url: &str) -> Result<PullRequestDetails, GitError> {
        let invocation = invocation(&["pr", "view", url, "--json", PULL_REQUEST_DETAILS_FIELDS]);
        let output = self.run(&invocation)?;
        serde_json::from_str::<Value>(&output)
            .ok()
            .as_ref()
            .and_then(parse_pull_request_details)
            .ok_or_else(|| unexpected(&invocation, &output))
    }

    fn open_pull_requests(
        &self,
        repository: &GitHubRepository,
    ) -> Result<Vec<PullRequestDetails>, GitError> {
        let (invocation, output, values) = self.list_pull_requests(
            repository,
            &["--state", "open"],
            PULL_REQUEST_DETAILS_FIELDS,
        )?;
        values
            .iter()
            .map(|value| {
                parse_pull_request_details(value).ok_or_else(|| unexpected(&invocation, &output))
            })
            .collect()
    }

    fn merged_pull_requests(
        &self,
        repository: &GitHubRepository,
        base: &str,
        since: i64,
        until: i64,
    ) -> Result<Vec<ListedPullRequest>, GitError> {
        if until <= since {
            return Ok(Vec::new());
        }
        // Search takes whole UTC days; the times are checked below.
        let search = format!("merged:{}..{}", utc_date(since), utc_date(until - 1));
        let (invocation, output, values) = self.list_pull_requests(
            repository,
            &[
                "--state", "merged", "--base", base, "--author", "@me", "--search", &search,
            ],
            LISTED_PULL_REQUEST_FIELDS,
        )?;
        let mut merged = values
            .iter()
            .map(|value| {
                parse_listed_pull_request(value).ok_or_else(|| unexpected(&invocation, &output))
            })
            .collect::<Result<Vec<_>, _>>()?;
        merged.retain(|pull_request| (since..until).contains(&pull_request.merged_at));
        merged.sort_by_key(|pull_request| (pull_request.merged_at, pull_request.number));
        Ok(merged)
    }

    fn rate_limit_backoff(&self) -> Option<Duration> {
        self.rate_limit
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remaining(Instant::now())
    }
}

fn invocation(args: &[&str]) -> Invocation {
    Invocation {
        program: "gh",
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
    }
}

/// The next step when `gh` cannot be started.
const GH_MISSING: &str = "install the GitHub CLI (https://cli.github.com) on the PATH of the \
     user that runs toodo-server and run `gh auth login` as that user, then retry; or add the \
     repository as a workspace with source `local_git`, which does not need gh";

/// The next step when `gh` runs but has no valid login.
const GH_LOGGED_OUT: &str = "gh is not logged in: run `gh auth login` as the user that runs \
     toodo-server (`gh auth login --hostname <host>` for a GitHub Enterprise host, or set \
     `GH_TOKEN` or `GH_ENTERPRISE_TOKEN` in its environment), then retry; or add the repository \
     as a workspace with source `local_git`, which does not need gh";

/// The next step when GitHub refuses a call for its API rate limit.
const GH_RATE_LIMITED: &str = "GitHub refused the call for its API rate limit: Toodo's \
     background pull request checks pause and resume on their own once it resets; run `gh api \
     rate_limit` as the user that runs toodo-server to see when it resets, then retry";

/// Adds the next step to an error that shows `gh` is missing, not logged in, or rate
/// limited. `gh` prints `gh auth login` both when it has no login and when its token is
/// rejected.
fn diagnose(error: GitError) -> GitError {
    if is_rate_limited(&error)
        && let GitError::Failed { command, stderr } = error
    {
        return GitError::Failed {
            command,
            stderr: format!("{stderr}\n{GH_RATE_LIMITED}"),
        };
    }
    match error {
        GitError::Spawn { program, message } => GitError::Spawn {
            program,
            message: format!("{message}; {GH_MISSING}"),
        },
        GitError::Failed { command, stderr } if stderr.contains("gh auth login") => {
            GitError::Failed {
                command,
                stderr: format!("{stderr}\n{GH_LOGGED_OUT}"),
            }
        }
        error => error,
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

    fn github(results: Vec<Result<String, GitError>>) -> (GhCli, Arc<FakeRunner>) {
        let runner = Arc::new(FakeRunner::new(results));
        (GhCli::new(Box::new(runner.clone())), runner)
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
    fn github_enterprise_repositories_are_passed_to_gh_with_their_host() {
        let (github, runner) = github(vec![Ok("[]\n".to_owned())]);
        let repository =
            GitHubRepository::from_remote_url("git@ghe.example.com:team/toodo.git").unwrap();
        assert_eq!(
            github
                .find_pull_request(&repository, "feat/x-1", "main")
                .unwrap(),
            None
        );
        let invocations = runner.invocations.lock().unwrap();
        let args = &invocations[0].args;
        let repo = args.iter().position(|arg| arg == "--repo").unwrap() + 1;
        assert_eq!(args[repo], "ghe.example.com/team/toodo");
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
                    check_runs: Vec::new(),
                    reviews: Vec::new(),
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

    #[test]
    fn pull_request_keeps_each_check_and_latest_review() {
        let view = r#"{"baseRefName":"main","headRefOid":"abc1234","latestReviews":[{"author":{"login":"octo"},"state":"CHANGES_REQUESTED"},{"author":null,"state":"COMMENTED"}],"mergedAt":null,"reviewDecision":"","state":"OPEN","statusCheckRollup":[{"__typename":"CheckRun","name":"rust","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/acme/toodo/actions/runs/1"},{"__typename":"CheckRun","name":"web","status":"IN_PROGRESS","conclusion":"","detailsUrl":""},{"__typename":"StatusContext","context":"deploy","state":"SUCCESS","targetUrl":"https://example.com/deploy"}],"url":"https://github.com/acme/toodo/pull/7"}"#;
        let (github, _) = github(vec![Ok(view.to_owned())]);
        let viewed = github.pull_request(URL).unwrap();
        assert_eq!(
            viewed.check_runs,
            [
                CheckRun {
                    name: "rust".to_owned(),
                    state: ChecksState::Failing,
                    conclusion: Some("failure".to_owned()),
                    url: Some("https://github.com/acme/toodo/actions/runs/1".to_owned()),
                },
                CheckRun {
                    name: "web".to_owned(),
                    state: ChecksState::Pending,
                    conclusion: None,
                    url: None,
                },
                CheckRun {
                    name: "deploy".to_owned(),
                    state: ChecksState::Passing,
                    conclusion: Some("success".to_owned()),
                    url: Some("https://example.com/deploy".to_owned()),
                },
            ]
        );
        assert_eq!(
            viewed.reviews,
            [
                Review {
                    author: Some("octo".to_owned()),
                    state: "changes_requested".to_owned(),
                },
                Review {
                    author: None,
                    state: "commented".to_owned(),
                },
            ]
        );
        assert_eq!(
            viewed.status,
            PullRequestStatus {
                checks: Some(ChecksState::Failing),
                review: ReviewState::ChangesRequested,
            }
        );
    }

    #[test]
    fn pull_request_activity_reads_creation_merge_head_and_checks() {
        let view = |merged_at: &str, checks: &str| {
            Ok(format!(
                r#"{{"createdAt":"2026-10-08T10:00:00Z","headRefOid":"abc1234def","mergedAt":{merged_at},"number":7,"state":"OPEN","statusCheckRollup":[{checks}],"title":"Add login","url":"{URL}"}}"#
            ))
        };
        let run = |status: &str, conclusion: &str, completed_at: &str| {
            format!(
                r#"{{"__typename":"CheckRun","status":"{status}","conclusion":"{conclusion}","completedAt":"{completed_at}"}}"#
            )
        };
        let context = |state: &str, started_at: &str| {
            format!(
                r#"{{"__typename":"StatusContext","state":"{state}","startedAt":"{started_at}"}}"#
            )
        };
        let passed = run("COMPLETED", "SUCCESS", "2026-10-08T11:00:00Z");
        let failed = run("COMPLETED", "FAILURE", "2026-10-08T10:30:00Z");
        let running = run("IN_PROGRESS", "", "0001-01-01T00:00:00Z");
        let (github, runner) = github(vec![
            view(
                &format!("\"{MERGED_AT}\""),
                &format!("{passed},{}", context("SUCCESS", "2026-10-08T12:00:00Z")),
            ),
            view("null", &format!("{passed},{failed}")),
            view("null", &running),
            view("null", ""),
            Ok(r#"{"number":7,"url":"x"}"#.to_owned()),
        ]);
        let created_at = 1_791_453_600;

        let merged = github.pull_request_activity(URL).unwrap();
        assert_eq!(
            merged,
            PullRequestActivity {
                number: 7,
                url: URL.to_owned(),
                title: "Add login".to_owned(),
                created_at,
                merged_at: Some(MERGED_AT_SECONDS),
                head_sha: Some("abc1234def".to_owned()),
                checks: Some((ChecksState::Passing, Some(created_at + 7_200))),
            }
        );
        assert_eq!(
            github.pull_request_activity(URL).unwrap().checks,
            Some((ChecksState::Failing, Some(created_at + 3_600)))
        );
        assert_eq!(
            github.pull_request_activity(URL).unwrap().checks,
            Some((ChecksState::Pending, None))
        );
        let unchecked = github.pull_request_activity(URL).unwrap();
        assert_eq!((unchecked.checks, unchecked.merged_at), (None, None));
        assert!(matches!(
            github.pull_request_activity(URL),
            Err(GitError::UnexpectedOutput { .. })
        ));
        assert_eq!(
            runner.invocations.lock().unwrap()[0],
            invocation(&[
                "pr",
                "view",
                URL,
                "--json",
                "number,title,url,createdAt,state,mergedAt,headRefOid,statusCheckRollup"
            ])
        );
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
            options: &PullRequestOptions::default(),
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

    #[test]
    fn create_pull_request_passes_the_workspace_options() {
        let (github, runner) = github(vec![
            Ok("https://github.com/acme/toodo/pull/8\n".to_owned()),
        ]);
        let repository = repository();
        let options = PullRequestOptions {
            draft: true,
            reviewers: vec!["octocat".to_owned(), "acme/core".to_owned()],
            labels: vec!["needs review".to_owned()],
        };
        github
            .create_pull_request(&NewPullRequest {
                repository: &repository,
                head: "feat/x-1",
                base: "main",
                title: "Add x",
                body: "",
                options: &options,
            })
            .unwrap();
        assert_eq!(
            runner.invocations.lock().unwrap()[0].args[12..],
            [
                "--draft",
                "--reviewer",
                "octocat",
                "--reviewer",
                "acme/core",
                "--label",
                "needs review",
            ]
            .map(str::to_owned)
        );
    }

    #[test]
    fn pull_request_refusals_are_read_from_what_gh_printed() {
        let failed = |stderr: &str| GitError::Failed {
            command: "gh pr create".to_owned(),
            stderr: stderr.to_owned(),
        };
        for (stderr, refusal) in [
            (
                "could not add label: 'needs review' not found",
                PullRequestRefusal::UnknownLabel,
            ),
            (
                "could not request reviewer: 'nobody' not found",
                PullRequestRefusal::InvalidReviewer,
            ),
            (
                "GraphQL: Could not resolve to a User with the login of 'nobody'. (requestReviewsByLogin)",
                PullRequestRefusal::InvalidReviewer,
            ),
            (
                "GraphQL: Review cannot be requested from pull request author. (requestReviews)",
                PullRequestRefusal::InvalidReviewer,
            ),
            (
                "GraphQL: Draft pull requests are not supported in this repository. (createPullRequest)",
                PullRequestRefusal::DraftUnsupported,
            ),
            (
                "a pull request for branch \"feat/x-1\" into branch \"main\" already exists:\nhttps://github.com/acme/toodo/pull/8",
                PullRequestRefusal::AlreadyExists,
            ),
            (
                "pull request create failed: GraphQL: No commits between main and feat/x-1 (createPullRequest)",
                PullRequestRefusal::NoCommits,
            ),
            (
                "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login",
                PullRequestRefusal::NotLoggedIn,
            ),
            (
                "GraphQL: Resource not accessible by integration (createPullRequest)",
                PullRequestRefusal::PermissionDenied,
            ),
        ] {
            assert_eq!(
                PullRequestRefusal::of(&failed(stderr)),
                Some(refusal),
                "{stderr}"
            );
        }
        assert_eq!(
            PullRequestRefusal::of(&failed("HTTP 502: Bad Gateway")),
            None
        );
        assert_eq!(
            PullRequestRefusal::of(&GitError::Spawn {
                program: "gh".to_owned(),
                message: "not found".to_owned(),
            }),
            None
        );
    }

    #[test]
    fn a_missing_gh_names_the_next_step() {
        let (github, _) = github(vec![Err(GitError::Spawn {
            program: "gh".to_owned(),
            message: "No such file or directory (os error 2)".to_owned(),
        })]);
        let error = github.pull_request(URL).unwrap_err().to_string();
        assert!(error.starts_with("failed to run gh: No such file or directory"));
        assert!(error.contains("install the GitHub CLI"));
        assert!(error.contains("`local_git`"));
    }

    #[test]
    fn a_logged_out_gh_names_the_next_step() {
        // What gh prints with no login and with a rejected token.
        for stderr in [
            "To get started with GitHub CLI, please run:  gh auth login\n\
             Alternatively, populate the GH_TOKEN environment variable with a GitHub API \
             authentication token.",
            "HTTP 401: Bad credentials (https://api.github.com/graphql)\n\
             Try authenticating with:  gh auth login -h github.com",
        ] {
            let (github, _) = github(vec![Err(GitError::Failed {
                command: format!("gh pr view {URL} --json mergeable"),
                stderr: stderr.to_owned(),
            })]);
            let error = github.mergeable(URL).unwrap_err().to_string();
            assert!(
                error.contains("gh is not logged in: run `gh auth login`"),
                "{error}"
            );
        }
    }

    #[test]
    fn other_gh_failures_are_left_as_they_are() {
        let failed = GitError::Failed {
            command: format!("gh pr view {URL} --json mergeable"),
            stderr: "GraphQL: Could not resolve to a PullRequest".to_owned(),
        };
        let (github, _) = github(vec![Err(failed.clone())]);
        assert_eq!(github.mergeable(URL), Err(failed));
    }

    fn rate_limited() -> GitError {
        GitError::Failed {
            command: "gh pr view".to_owned(),
            stderr: "GraphQL: API rate limit exceeded for user ID 1.".to_owned(),
        }
    }

    #[test]
    fn rate_limit_refusals_back_off_longer_each_time_until_a_call_succeeds() {
        let start = Instant::now();
        let minutes = |count: u64| Duration::from_secs(count * 60);
        let mut limit = RateLimit::default();
        assert_eq!(limit.remaining(start), None);

        limit.record(start, &Err(rate_limited()));
        assert_eq!(limit.remaining(start), Some(minutes(5)));
        assert_eq!(limit.remaining(start + minutes(5)), None);

        let later = start + minutes(5);
        limit.record(later, &Err(rate_limited()));
        assert_eq!(limit.remaining(later), Some(minutes(10)));
        for _ in 0..5 {
            limit.record(later, &Err(rate_limited()));
        }
        assert_eq!(limit.remaining(later), Some(minutes(60)));

        // Other failures leave the backoff as it is; a success ends it.
        limit.record(
            later,
            &Err(GitError::Failed {
                command: "gh pr view".to_owned(),
                stderr: "HTTP 502: Bad Gateway".to_owned(),
            }),
        );
        assert_eq!(limit.remaining(later), Some(minutes(60)));
        limit.record(later, &Ok(String::new()));
        assert_eq!(limit.remaining(later), None);
        limit.record(later, &Err(rate_limited()));
        assert_eq!(limit.remaining(later), Some(minutes(5)));
    }

    #[test]
    fn a_rate_limited_gh_reports_the_backoff_and_the_next_step() {
        let (github, _) = github(vec![
            Err(rate_limited()),
            Err(GitError::Failed {
                command: "gh pr view".to_owned(),
                stderr: "HTTP 429: Too Many Requests".to_owned(),
            }),
            Ok(r#"{"mergeable":"MERGEABLE"}"#.to_owned()),
        ]);
        assert_eq!(github.rate_limit_backoff(), None);

        let error = github.mergeable(URL).unwrap_err().to_string();
        assert!(error.contains("gh api rate_limit"), "{error}");
        let first = github.rate_limit_backoff().unwrap();
        assert!(first > Duration::from_secs(4 * 60), "{first:?}");

        github.mergeable(URL).unwrap_err();
        assert!(github.rate_limit_backoff().unwrap() > first);

        github.mergeable(URL).unwrap();
        assert_eq!(github.rate_limit_backoff(), None);
    }

    #[test]
    fn open_pull_requests_read_every_open_pull_request_with_its_details() {
        let details = |number: i64| {
            serde_json::json!({
                "url": format!("https://github.com/acme/toodo/pull/{number}"),
                "state": "OPEN",
                "baseRefName": "main",
                "mergedAt": null,
                "statusCheckRollup": [],
                "reviewDecision": "APPROVED",
                "latestReviews": [],
                "headRefOid": "abc",
                "number": number,
                "title": format!("Change {number}"),
                "createdAt": MERGED_AT,
                "body": "Closes #1",
            })
        };
        let full: Vec<_> = (1..=100).map(details).collect();
        let (github, runner) = github(vec![
            Ok(Value::Array(full).to_string()),
            Ok(Value::Array((1..=101).map(details).collect()).to_string()),
        ]);

        let open = github.open_pull_requests(&repository()).unwrap();

        assert_eq!(open.len(), 101);
        let last = &open[100];
        assert_eq!(
            last.viewed.pull_request.url,
            "https://github.com/acme/toodo/pull/101"
        );
        assert_eq!(last.viewed.status.review, ReviewState::Approved);
        assert_eq!(last.activity.title, "Change 101");
        assert_eq!(last.body, "Closes #1");
        let invocations = runner.invocations.lock().unwrap();
        assert_eq!(
            invocations[0].args,
            [
                "pr",
                "list",
                "--repo",
                "github.com/acme/toodo",
                "--state",
                "open",
                "--json",
                PULL_REQUEST_DETAILS_FIELDS,
                "--limit",
                "100"
            ]
            .map(str::to_owned)
        );
        assert_eq!(invocations[1].args.last().unwrap(), "200");
    }

    #[test]
    fn merged_pull_requests_search_the_days_of_the_period_and_keep_its_merges() {
        let listed = |number: i64, merged_at: &str| {
            serde_json::json!({
                "url": format!("https://github.com/acme/toodo/pull/{number}"),
                "number": number,
                "title": format!("Change {number}"),
                "headRefName": format!("feat/change-{number}"),
                "createdAt": "2026-10-08T09:00:00Z",
                "mergedAt": merged_at,
            })
        };
        let (github, runner) = github(vec![Ok(serde_json::json!([
            listed(3, "2026-10-10T08:00:00Z"),
            listed(2, MERGED_AT),
            // Merged on the last searched day, after the period.
            listed(4, "2026-10-11T20:00:00Z"),
        ])
        .to_string())]);
        let since = MERGED_AT_SECONDS - 3_600;
        let until = since + 2 * 86_400;

        let merged = github
            .merged_pull_requests(&repository(), "main", since, until)
            .unwrap();

        let numbers: Vec<_> = merged
            .iter()
            .map(|pull_request| pull_request.number)
            .collect();
        assert_eq!(numbers, [2, 3]);
        assert_eq!(merged[0].head, "feat/change-2");
        assert_eq!(merged[0].merged_at, MERGED_AT_SECONDS);
        let invocations = runner.invocations.lock().unwrap();
        assert_eq!(
            invocations[0].args,
            [
                "pr",
                "list",
                "--repo",
                "github.com/acme/toodo",
                "--state",
                "merged",
                "--base",
                "main",
                "--author",
                "@me",
                "--search",
                "merged:2026-10-09..2026-10-11",
                "--json",
                LISTED_PULL_REQUEST_FIELDS,
                "--limit",
                "100"
            ]
            .map(str::to_owned)
        );
    }

    #[test]
    fn pull_request_urls_name_their_repository() {
        assert_eq!(
            pull_request_repository(URL).map(|repository| repository.to_string()),
            Some("github.com/acme/toodo".to_owned())
        );
        assert_eq!(
            pull_request_repository("https://ghe.example.com/team/toodo/pull/3")
                .map(|repository| repository.to_string()),
            Some("ghe.example.com/team/toodo".to_owned())
        );
        assert_eq!(
            pull_request_repository("https://github.com/acme/toodo"),
            None
        );
    }
}
