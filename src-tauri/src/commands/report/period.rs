//! The calendar period a report covers.

use jiff::ToSpan;
use jiff::civil::Date;
use jiff::tz::TimeZone;

use crate::commands::types::{ReportFormat, ReviewPeriodKind};

/// A reviewed period: the calendar days `from` to `to`, both included, and the half-open
/// range `[start, end)` from midnight of `from` to midnight after `to` in its time zone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportPeriod {
    pub kind: ReviewPeriodKind,
    pub from: Date,
    pub to: Date,
    pub start: i64,
    pub end: i64,
}

impl ReportPeriod {
    /// The period of `kind` that starts on `from` (for a week), contains `from` or `date`
    /// (for a month, quarter, or year), or contains `today` when neither is given; a
    /// custom period needs `from` and `to`.
    pub fn resolve(
        kind: ReviewPeriodKind,
        date: Option<Date>,
        from: Option<Date>,
        to: Option<Date>,
        today: Date,
        tz: &TimeZone,
    ) -> Result<Self, String> {
        if date.is_some() && from.is_some() {
            return Err(
                "give either date (a day inside the period) or from (its first day), not both"
                    .to_owned(),
            );
        }
        let out_of_range = || {
            "the period is out of the supported range of days; pick days in the years 1 to 9998"
                .to_owned()
        };
        let (first, last) = match kind {
            ReviewPeriodKind::Custom => {
                if date.is_some() {
                    return Err(
                        "a custom period takes from and to, its first and last day; pass those \
                         instead of date, or pick period week, month, quarter, or year"
                            .to_owned(),
                    );
                }
                let (Some(from), Some(to)) = (from, to) else {
                    return Err(
                        "a custom period needs from and to, its first and last day as \
                         YYYY-MM-DD; or pick period week, month, quarter, or year"
                            .to_owned(),
                    );
                };
                if to < from {
                    return Err(format!(
                        "to {to} is before from {from}; pass a last day on or after the first"
                    ));
                }
                (from, to)
            }
            _ if to.is_some() => {
                return Err(
                    "to is only for a custom period; pass period custom with from and to, or \
                     leave out to"
                        .to_owned(),
                );
            }
            ReviewPeriodKind::Week => {
                let first = match from {
                    Some(from) => from,
                    None => {
                        let day = date.unwrap_or(today);
                        let since_monday = i64::from(day.weekday().to_monday_zero_offset());
                        day.checked_sub(since_monday.days())
                            .map_err(|_| out_of_range())?
                    }
                };
                let last = first.checked_add(6.days()).map_err(|_| out_of_range())?;
                (first, last)
            }
            ReviewPeriodKind::Month | ReviewPeriodKind::Quarter | ReviewPeriodKind::Year => {
                let day = from.or(date).unwrap_or(today);
                let (first_month, months) = match kind {
                    ReviewPeriodKind::Month => (day.month(), 1),
                    ReviewPeriodKind::Quarter => (day.month() - (day.month() - 1) % 3, 3),
                    _ => (1, 12),
                };
                let first = Date::new(day.year(), first_month, 1).map_err(|_| out_of_range())?;
                let last = first
                    .checked_add(months.months())
                    .and_then(|next| next.yesterday())
                    .map_err(|_| out_of_range())?;
                (first, last)
            }
        };
        let midnight = |day: Date| {
            day.to_zoned(tz.clone())
                .map(|zoned| zoned.timestamp().as_second())
                .map_err(|_| out_of_range())
        };
        Ok(Self {
            kind,
            from: first,
            to: last,
            start: midnight(first)?,
            end: midnight(last.tomorrow().map_err(|_| out_of_range())?)?,
        })
    }

    pub(super) fn title(&self) -> &'static str {
        match self.kind {
            ReviewPeriodKind::Week => "Week review",
            ReviewPeriodKind::Month => "Month review",
            ReviewPeriodKind::Quarter => "Quarter review",
            ReviewPeriodKind::Year => "Year review",
            ReviewPeriodKind::Custom => "Review",
        }
    }

    /// The title of the period with its label, e.g. `Year review 2026`.
    pub fn name(&self) -> String {
        format!("{} {}", self.title(), self.label())
    }

    pub(super) fn label(&self) -> String {
        match self.kind {
            ReviewPeriodKind::Month => self.from.strftime("%Y-%m").to_string(),
            ReviewPeriodKind::Quarter => {
                format!("{} Q{}", self.from.year(), (self.from.month() - 1) / 3 + 1)
            }
            ReviewPeriodKind::Year => self.from.year().to_string(),
            ReviewPeriodKind::Week | ReviewPeriodKind::Custom => {
                format!("{} to {}", self.from, self.to)
            }
        }
    }

    pub fn file_name(&self, format: ReportFormat) -> String {
        let extension = match format {
            ReportFormat::Markdown => "md",
            ReportFormat::Csv => "csv",
        };
        format!(
            "toodo-review-{}.{extension}",
            self.label().replace(' ', "-")
        )
    }

    /// The calendar months the period touches, as `YYYY-MM`.
    pub(super) fn months(&self) -> Vec<String> {
        let mut months = Vec::new();
        let mut month = self.from.first_of_month();
        while month <= self.to {
            months.push(month.strftime("%Y-%m").to_string());
            match month.checked_add(1.month()) {
                Ok(next) => month = next,
                Err(_) => break,
            }
        }
        months
    }
}
