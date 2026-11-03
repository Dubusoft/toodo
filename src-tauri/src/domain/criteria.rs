//! Completion criteria: what has to hold for a task to be done (see `docs/workflow.md`,
//! Completion Criteria).
//!
//! Each criterion is checked by hand (`manual`) or by Toodo (every other kind). Once
//! every criterion of a task is met, the task awaits completion; a task whose criteria are
//! all automatic is done right away, while one with a manual criterion waits for the user
//! (or an agent acting for them) to confirm.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CriterionId(pub i64);

impl fmt::Display for CriterionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// How a criterion is checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CheckKind {
    /// Checked by the user in the app or by an agent through MCP, with evidence.
    Manual,
    /// The task's pull request is merged into the workspace base branch.
    PullRequestMerged,
    /// The task's pull request is open and all its checks passed.
    PullRequestOpenChecksPassed,
    /// The task branch has commits and is merged into the workspace base branch in the
    /// repository itself, for workspaces without an `origin` remote.
    BranchMergedLocally,
    /// A GET of the target URL succeeds.
    Url,
    /// The target shell command exits with status 0 in the task worktree.
    Command,
}

impl CheckKind {
    pub const ALL: [Self; 6] = [
        Self::Manual,
        Self::PullRequestMerged,
        Self::PullRequestOpenChecksPassed,
        Self::BranchMergedLocally,
        Self::Url,
        Self::Command,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::PullRequestMerged => "pr_merged",
            Self::PullRequestOpenChecksPassed => "pr_open_ci_green",
            Self::BranchMergedLocally => "branch_merged_locally",
            Self::Url => "url",
            Self::Command => "command",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == raw)
    }

    /// Whether Toodo checks it on its own.
    pub fn is_automatic(self) -> bool {
        self != Self::Manual
    }

    /// Whether the criterion needs a target given by its author: the URL or command to
    /// check.
    pub fn takes_target(self) -> bool {
        matches!(self, Self::Url | Self::Command)
    }

    /// Whether it looks at the task's pull request.
    pub fn is_pull_request(self) -> bool {
        matches!(
            self,
            Self::PullRequestMerged | Self::PullRequestOpenChecksPassed
        )
    }
}

impl fmt::Display for CheckKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CriterionState {
    /// Not met yet, or not checked yet.
    Pending,
    Met,
    /// The last automatic check found it not met for a reason worth showing, e.g. a pull
    /// request closed without merging or a command that failed; it is checked again.
    Failed,
}

impl CriterionState {
    pub const ALL: [Self; 3] = [Self::Pending, Self::Met, Self::Failed];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Met => "met",
            Self::Failed => "failed",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|state| state.as_str() == raw)
    }
}

/// Who checked a criterion last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CheckedBy {
    /// The user, in the app.
    User,
    /// An agent, through MCP.
    Agent,
    /// Toodo's automatic check.
    Toodo,
}

impl CheckedBy {
    pub const ALL: [Self; 3] = [Self::User, Self::Agent, Self::Toodo];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
            Self::Toodo => "toodo",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|by| by.as_str() == raw)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Criterion {
    pub id: CriterionId,
    /// What has to hold, in words.
    pub text: String,
    pub kind: CheckKind,
    /// The URL of a `url` criterion, the command of a `command` criterion, or the commit
    /// a `branch_merged_locally` criterion's branch started from once Toodo knows it.
    pub target: Option<String>,
    pub state: CriterionState,
    /// What showed the last check's result: a link, an output, or the reason it failed.
    pub evidence: Option<String>,
    pub checked_by: Option<CheckedBy>,
    /// Time of the last check that changed the state, in seconds since the Unix epoch.
    pub checked_at: Option<i64>,
}

impl Criterion {
    pub fn is_met(&self) -> bool {
        self.state == CriterionState::Met
    }
}

/// A criterion as its author gives it, before Toodo stores it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCriterion {
    pub text: String,
    pub kind: CheckKind,
    pub target: Option<String>,
}

impl NewCriterion {
    /// Checks and normalizes a criterion from its author: a non-blank text, an `http(s)`
    /// URL for `url`, a non-blank command for `command`, and no target for other kinds.
    pub fn parse(
        text: &str,
        kind: CheckKind,
        target: Option<&str>,
    ) -> Result<Self, InvalidCriterion> {
        let text = text.trim();
        if text.is_empty() {
            return Err(InvalidCriterion("a criterion needs a text".to_owned()));
        }
        let target = target.map(str::trim).filter(|target| !target.is_empty());
        match (kind, target) {
            (CheckKind::Url, Some(url))
                if (url.starts_with("https://") || url.starts_with("http://"))
                    && !url.chars().any(char::is_whitespace) => {}
            (CheckKind::Url, _) => {
                return Err(InvalidCriterion(format!(
                    "url criterion {text:?} needs an http:// or https:// URL as its target"
                )));
            }
            (CheckKind::Command, Some(_)) => {}
            (CheckKind::Command, None) => {
                return Err(InvalidCriterion(format!(
                    "command criterion {text:?} needs the command to run as its target"
                )));
            }
            (_, None) => {}
            (kind, Some(_)) => {
                return Err(InvalidCriterion(format!(
                    "{kind} criterion {text:?} takes no target"
                )));
            }
        }
        Ok(Self {
            text: text.to_owned(),
            kind,
            target: target.map(str::to_owned),
        })
    }

    /// The criterion a git task gets when its author gives none: its pull request is
    /// merged, or, in a repository without an `origin` remote, its branch is merged into
    /// the base branch locally.
    pub fn merge(has_origin: bool) -> Self {
        if has_origin {
            Self {
                text: "Pull request merged into the base branch".to_owned(),
                kind: CheckKind::PullRequestMerged,
                target: None,
            }
        } else {
            Self {
                text: "Branch merged into the base branch locally".to_owned(),
                kind: CheckKind::BranchMergedLocally,
                target: None,
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidCriterion(pub String);

impl fmt::Display for InvalidCriterion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidCriterion {}

/// What the criteria of a task being worked on call for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Some criterion is not met, or the task has none, which only a confirmation
    /// completes.
    Wait,
    /// Every criterion is met and one of them is manual: the task awaits completion until
    /// someone confirms it.
    AwaitConfirmation,
    /// Every criterion is met and checked by Toodo: the task is done.
    Complete,
}

pub fn decide(criteria: &[Criterion]) -> Decision {
    if criteria.is_empty() || !criteria.iter().all(Criterion::is_met) {
        Decision::Wait
    } else if criteria
        .iter()
        .all(|criterion| criterion.kind.is_automatic())
    {
        Decision::Complete
    } else {
        Decision::AwaitConfirmation
    }
}

/// Whether confirming completes the task: every criterion is met, or it has none.
pub fn can_confirm(criteria: &[Criterion]) -> bool {
    criteria.iter().all(Criterion::is_met)
}

/// The `- [ ]` and `- [x]` items of the `Done when` section of a Markdown description,
/// with whether each was checked, in order. The section runs from a `Done when` heading
/// of any level to the next heading.
pub fn done_when_items(description: &str) -> Vec<(String, bool)> {
    let mut items = Vec::new();
    let mut in_section = false;
    let mut in_fence = false;
    for line in description.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(heading) = heading_text(trimmed) {
            in_section = heading
                .trim_end_matches(':')
                .trim()
                .eq_ignore_ascii_case("done when");
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some(item) = checkbox(trimmed) {
            items.push(item);
        }
    }
    items
}

/// The text of an ATX heading (`#` to `######` followed by a space).
fn heading_text(line: &str) -> Option<&str> {
    let hashes = line.chars().take_while(|&c| c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &line[hashes..];
    if rest.is_empty() {
        return Some("");
    }
    rest.strip_prefix([' ', '\t']).map(str::trim)
}

/// A task list item: `-`, `*`, or `+`, a space, `[ ]` or `[x]`, and a non-blank text.
fn checkbox(line: &str) -> Option<(String, bool)> {
    let rest = line
        .strip_prefix(['-', '*', '+'])?
        .strip_prefix([' ', '\t'])?;
    let rest = rest.trim_start();
    let (checked, text) = match rest.strip_prefix("[ ]") {
        Some(text) => (false, text),
        None => (
            true,
            rest.strip_prefix("[x]")
                .or_else(|| rest.strip_prefix("[X]"))?,
        ),
    };
    let text = text.trim();
    (!text.is_empty()).then(|| (text.to_owned(), checked))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn criterion(kind: CheckKind, state: CriterionState) -> Criterion {
        Criterion {
            id: CriterionId(1),
            text: "x".to_owned(),
            kind,
            target: None,
            state,
            evidence: None,
            checked_by: None,
            checked_at: None,
        }
    }

    #[test]
    fn all_met_automatic_criteria_complete_and_a_manual_one_needs_confirmation() {
        use CheckKind::*;
        use CriterionState::*;
        assert_eq!(decide(&[]), Decision::Wait);
        assert_eq!(
            decide(&[criterion(PullRequestMerged, Met), criterion(Command, Met)]),
            Decision::Complete
        );
        assert_eq!(
            decide(&[criterion(PullRequestMerged, Met), criterion(Manual, Met)]),
            Decision::AwaitConfirmation
        );
        assert_eq!(
            decide(&[
                criterion(PullRequestMerged, Met),
                criterion(Manual, Pending)
            ]),
            Decision::Wait
        );
        assert_eq!(
            decide(&[criterion(BranchMergedLocally, Failed)]),
            Decision::Wait
        );
        assert!(can_confirm(&[]));
        assert!(can_confirm(&[criterion(Manual, Met)]));
        assert!(!can_confirm(&[
            criterion(Manual, Met),
            criterion(Url, Failed)
        ]));
    }

    #[test]
    fn new_criteria_need_a_text_and_a_target_only_where_one_is_checked() {
        use CheckKind::*;
        let parse = |kind, target| NewCriterion::parse(" Works ", kind, target);
        assert_eq!(
            parse(Url, Some(" https://example.com/health ")).unwrap(),
            NewCriterion {
                text: "Works".to_owned(),
                kind: Url,
                target: Some("https://example.com/health".to_owned())
            }
        );
        assert_eq!(parse(Manual, Some("  ")).unwrap().target, None);
        assert!(parse(Command, Some("npm test")).is_ok());
        for (kind, target) in [
            (Url, None),
            (Url, Some("ftp://example.com")),
            (Url, Some("https://exa mple.com")),
            (Command, None),
            (Manual, Some("x")),
            (BranchMergedLocally, Some("abc")),
        ] {
            assert!(parse(kind, target).is_err(), "{kind} {target:?}");
        }
        assert!(NewCriterion::parse(" ", Manual, None).is_err());
        assert_eq!(NewCriterion::merge(true).kind, PullRequestMerged);
        assert_eq!(NewCriterion::merge(false).kind, BranchMergedLocally);
    }

    #[test]
    fn done_when_items_come_from_that_section_only() {
        let description = "## Purpose\n- [ ] not a criterion\n\n## Done when\n\
            - [ ] Tests pass\n  - [x] Docs `updated`\n* [X] Reviewed\n- plain item\n\
            ```\n- [ ] in a fence\n```\n- [ ]   \n### Done when:\n+ [ ] Deployed\n\
            ## Notes\n- [ ] later\n";
        assert_eq!(
            done_when_items(description),
            vec![
                ("Tests pass".to_owned(), false),
                ("Docs `updated`".to_owned(), true),
                ("Reviewed".to_owned(), true),
                ("Deployed".to_owned(), false),
            ]
        );
        assert!(done_when_items("Done when\n- [ ] no heading").is_empty());
        assert!(done_when_items("#Done when\n- [ ] not a heading").is_empty());
    }
}
