//! What a task was planned to take: an estimate of its size and the day it is due.
//! Both are optional; reviews compare them with the active time and completion day the
//! status history records. Labels group tasks by project or goal for those reviews.

use std::fmt;

/// The unit of time an estimate counts, compared with the time a task spent in progress
/// or in review. A day is 24 hours, a week 7 days, and a month 30 days.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EstimateUnit {
    Hours,
    Days,
    Weeks,
    Months,
}

impl EstimateUnit {
    pub const ALL: [Self; 4] = [Self::Hours, Self::Days, Self::Weeks, Self::Months];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hours => "hours",
            Self::Days => "days",
            Self::Weeks => "weeks",
            Self::Months => "months",
        }
    }
}

/// The expected size of a task. The amount is always finite and positive, so equality
/// is total and `Eq` holds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Estimate {
    unit: EstimateUnit,
    amount: f64,
}

impl Eq for Estimate {}

impl Estimate {
    /// Largest accepted amount, far above any sensible estimate of one task.
    pub const MAX_AMOUNT: f64 = 10_000.0;

    pub fn new(unit: EstimateUnit, amount: f64) -> Result<Self, InvalidEstimate> {
        if !(amount.is_finite() && amount > 0.0 && amount <= Self::MAX_AMOUNT) {
            return Err(InvalidEstimate(amount));
        }
        Ok(Self { unit, amount })
    }

    pub fn unit(self) -> EstimateUnit {
        self.unit
    }

    pub fn amount(self) -> f64 {
        self.amount
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InvalidEstimate(pub f64);

impl fmt::Display for InvalidEstimate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "estimate must be greater than 0 and at most {}, got {}",
            Estimate::MAX_AMOUNT,
            self.0
        )
    }
}

impl std::error::Error for InvalidEstimate {}

/// A calendar day, without a time zone: a task is on time when it is completed on or
/// before this day in the user's local time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DueDate {
    year: u16,
    month: u8,
    day: u8,
}

impl DueDate {
    /// Parses `YYYY-MM-DD`, rejecting days the month does not have.
    pub fn parse(raw: &str) -> Result<Self, InvalidDueDate> {
        let invalid = || InvalidDueDate(raw.to_owned());
        let bytes = raw.as_bytes();
        let well_formed = bytes.len() == 10
            && bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());
        if !well_formed {
            return Err(invalid());
        }
        let year: u16 = raw[0..4].parse().map_err(|_| invalid())?;
        let month: u8 = raw[5..7].parse().map_err(|_| invalid())?;
        let day: u8 = raw[8..10].parse().map_err(|_| invalid())?;
        if year == 0 || !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
            return Err(invalid());
        }
        Ok(Self { year, month, day })
    }
}

fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

impl fmt::Display for DueDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidDueDate(pub String);

impl fmt::Display for InvalidDueDate {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "due date must be a calendar day as YYYY-MM-DD, got {:?}",
            self.0
        )
    }
}

impl std::error::Error for InvalidDueDate {}

/// The most characters a label has.
pub const MAX_LABEL_CHARS: usize = 40;
/// The most labels a task has.
pub const MAX_LABELS: usize = 20;

/// The labels of a task from `raw`: each trimmed, sorted, and without duplicates. A label
/// is non-empty, at most [`MAX_LABEL_CHARS`] characters, and has no comma or line break,
/// so a comma-separated list can name several.
pub fn labels(raw: &[String]) -> Result<Vec<String>, InvalidLabels> {
    let mut labels = Vec::with_capacity(raw.len());
    for label in raw {
        let label = label.trim();
        if label.is_empty() {
            return Err(InvalidLabels::Empty);
        }
        if label.contains([',', '\n', '\r']) {
            return Err(InvalidLabels::Separator(label.to_owned()));
        }
        if label.chars().count() > MAX_LABEL_CHARS {
            return Err(InvalidLabels::TooLong(label.to_owned()));
        }
        labels.push(label.to_owned());
    }
    labels.sort();
    labels.dedup();
    if labels.len() > MAX_LABELS {
        return Err(InvalidLabels::TooMany(labels.len()));
    }
    Ok(labels)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvalidLabels {
    Empty,
    Separator(String),
    TooLong(String),
    TooMany(usize),
}

impl fmt::Display for InvalidLabels {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "labels must not be blank; leave out the empty label"),
            Self::Separator(label) => write!(
                f,
                "label {label:?} has a comma or line break; pass each label as its own list item"
            ),
            Self::TooLong(label) => write!(
                f,
                "label {label:?} is longer than {MAX_LABEL_CHARS} characters; shorten it"
            ),
            Self::TooMany(count) => write!(
                f,
                "a task has at most {MAX_LABELS} labels, got {count}; keep the ones reviews group by"
            ),
        }
    }
}

impl std::error::Error for InvalidLabels {}

/// The most characters a reference has.
pub const MAX_REF_CHARS: usize = 500;
/// The most references a task has.
pub const MAX_REFS: usize = 50;

/// The references of a task after appending `add` to `current` and then dropping
/// `remove`. Toodo keeps references in order and shows them without interpreting them; by
/// convention one reads `<kind>:<value>`, e.g. `lane:search-api` or `pr:123`, or is a URL.
/// Each added reference is trimmed, non-empty, at most [`MAX_REF_CHARS`] characters, and on
/// one line; one the task already has is not added again, and removing one it does not have
/// changes nothing.
pub fn merge_refs(
    current: &[String],
    add: &[String],
    remove: &[String],
) -> Result<Vec<String>, InvalidRefs> {
    let mut refs = current.to_vec();
    for reference in add {
        let reference = reference.trim();
        if reference.is_empty() {
            return Err(InvalidRefs::Empty);
        }
        if reference.contains(['\n', '\r']) {
            return Err(InvalidRefs::LineBreak(reference.to_owned()));
        }
        if reference.chars().count() > MAX_REF_CHARS {
            return Err(InvalidRefs::TooLong(reference.to_owned()));
        }
        if !refs.iter().any(|existing| existing == reference) {
            refs.push(reference.to_owned());
        }
    }
    refs.retain(|existing| !remove.iter().any(|gone| gone.trim() == existing));
    if refs.len() > MAX_REFS {
        return Err(InvalidRefs::TooMany(refs.len()));
    }
    Ok(refs)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvalidRefs {
    Empty,
    LineBreak(String),
    TooLong(String),
    TooMany(usize),
}

impl fmt::Display for InvalidRefs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "refs must not be blank; leave out the empty reference"),
            Self::LineBreak(reference) => write!(
                f,
                "reference {reference:?} has a line break; pass each reference as its own list item"
            ),
            Self::TooLong(reference) => write!(
                f,
                "reference {reference:?} is longer than {MAX_REF_CHARS} characters; shorten it, e.g. to `pr:<number>` or a URL"
            ),
            Self::TooMany(count) => write!(
                f,
                "a task has at most {MAX_REFS} references, got {count}; drop old ones with update_task remove_refs"
            ),
        }
    }
}

impl std::error::Error for InvalidRefs {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_keep_their_order_skip_repeats_and_are_bounded() {
        let raw = |items: &[&str]| {
            items
                .iter()
                .map(|&item| item.to_owned())
                .collect::<Vec<_>>()
        };
        let current = raw(&["lane:a", "pr:1"]);
        assert_eq!(
            merge_refs(&current, &raw(&[" discord:9 ", "lane:a", "discord:9"]), &[]),
            Ok(raw(&["lane:a", "pr:1", "discord:9"]))
        );
        assert_eq!(
            merge_refs(&current, &raw(&["pr:2"]), &raw(&[" lane:a", "gone"])),
            Ok(raw(&["pr:1", "pr:2"]))
        );
        assert_eq!(
            merge_refs(&current, &raw(&[" "]), &[]),
            Err(InvalidRefs::Empty)
        );
        assert!(matches!(
            merge_refs(&current, &raw(&["a\nb"]), &[]),
            Err(InvalidRefs::LineBreak(_))
        ));
        assert!(matches!(
            merge_refs(&current, &["x".repeat(MAX_REF_CHARS + 1)], &[]),
            Err(InvalidRefs::TooLong(_))
        ));
        let many: Vec<String> = (0..MAX_REFS).map(|index| format!("r:{index}")).collect();
        assert_eq!(
            merge_refs(&current, &many, &[]),
            Err(InvalidRefs::TooMany(MAX_REFS + 2))
        );
    }

    #[test]
    fn labels_are_trimmed_sorted_unique_and_bounded() {
        let raw = |items: &[&str]| {
            items
                .iter()
                .map(|&item| item.to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            labels(&raw(&[" toodo ", "goal: speed", "toodo"])).unwrap(),
            ["goal: speed", "toodo"]
        );
        assert_eq!(labels(&raw(&[" "])), Err(InvalidLabels::Empty));
        assert!(matches!(
            labels(&raw(&["a,b"])),
            Err(InvalidLabels::Separator(_))
        ));
        assert!(labels(&raw(&[&"é".repeat(MAX_LABEL_CHARS)])).is_ok());
        assert!(matches!(
            labels(&raw(&[&"x".repeat(MAX_LABEL_CHARS + 1)])),
            Err(InvalidLabels::TooLong(_))
        ));
        let many: Vec<String> = (0..=MAX_LABELS).map(|n| n.to_string()).collect();
        assert_eq!(labels(&many), Err(InvalidLabels::TooMany(MAX_LABELS + 1)));
    }

    #[test]
    fn estimates_must_be_positive_finite_and_bounded() {
        let estimate = Estimate::new(EstimateUnit::Hours, 1.5).unwrap();
        assert_eq!(
            (estimate.unit(), estimate.amount()),
            (EstimateUnit::Hours, 1.5)
        );
        assert!(Estimate::new(EstimateUnit::Weeks, Estimate::MAX_AMOUNT).is_ok());
        for amount in [
            0.0,
            -1.0,
            f64::NAN,
            f64::INFINITY,
            Estimate::MAX_AMOUNT + 1.0,
        ] {
            assert!(
                Estimate::new(EstimateUnit::Days, amount).is_err(),
                "{amount}"
            );
        }
    }

    #[test]
    fn due_dates_are_calendar_days_and_round_trip() {
        for raw in ["2026-10-15", "2024-02-29", "2000-02-29", "2026-12-31"] {
            assert_eq!(DueDate::parse(raw).unwrap().to_string(), raw);
        }
        for raw in [
            "",
            "2026-10-5",
            "2026/10/15",
            "2026-13-01",
            "2026-00-10",
            "2026-02-29",
            "1900-02-29",
            "2026-04-31",
            "0000-01-01",
            "2026-10-15T00:00",
            "+026-10-15",
        ] {
            assert!(DueDate::parse(raw).is_err(), "{raw}");
        }
        assert!(DueDate::parse("2026-01-31").unwrap() < DueDate::parse("2026-02-01").unwrap());
    }
}
