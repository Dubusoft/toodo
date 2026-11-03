//! Rules for database backups: file names of the backups Toodo writes on its own, when
//! the next automatic backup is due, and the automatic backup settings.

use std::fmt;

/// Why Toodo wrote a backup into its backup directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BackupKind {
    /// Written on the automatic backup schedule.
    Automatic,
    /// Written right before a restore replaced the data.
    PreRestore,
}

impl BackupKind {
    fn tag(self) -> &'static str {
        match self {
            Self::Automatic => "auto",
            Self::PreRestore => "pre-restore",
        }
    }
}

const PREFIX: &str = "toodo-";
const EXTENSION: &str = ".sqlite3";
const SECONDS_PER_DAY: i64 = 86_400;
const SECONDS_PER_HOUR: i64 = 3_600;

/// File name of a backup of `kind` taken at `at` (seconds since the Unix epoch), e.g.
/// `toodo-auto-20261014-093000.sqlite3`. The time is UTC.
pub fn file_name(kind: BackupKind, at: i64) -> String {
    let (year, month, day) = civil_from_days(at.div_euclid(SECONDS_PER_DAY));
    let seconds = at.rem_euclid(SECONDS_PER_DAY);
    format!(
        "{PREFIX}{}-{year:04}{month:02}{day:02}-{:02}{:02}{:02}{EXTENSION}",
        kind.tag(),
        seconds / SECONDS_PER_HOUR,
        seconds % SECONDS_PER_HOUR / 60,
        seconds % 60,
    )
}

/// File name a snapshot exported at `at` is saved under, e.g.
/// `toodo-backup-2026-10-14.sqlite3`. The date is UTC. It is not a backup name that
/// [`parse_file_name`] accepts, so an export saved into the backup directory is not listed.
pub fn export_file_name(at: i64) -> String {
    let (year, month, day) = civil_from_days(at.div_euclid(SECONDS_PER_DAY));
    format!("{PREFIX}backup-{year:04}-{month:02}-{day:02}{EXTENSION}")
}

/// Kind and time of a backup named by [`file_name`]; `None` for any other file.
pub fn parse_file_name(name: &str) -> Option<(BackupKind, i64)> {
    let rest = name.strip_prefix(PREFIX)?.strip_suffix(EXTENSION)?;
    let (kind, stamp) = [BackupKind::Automatic, BackupKind::PreRestore]
        .into_iter()
        .find_map(|kind| {
            let stamp = rest.strip_prefix(kind.tag())?.strip_prefix('-')?;
            Some((kind, stamp))
        })?;
    let (date, time) = stamp.split_once('-')?;
    if date.len() != 8
        || time.len() != 6
        || !(date.chars().chain(time.chars())).all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let number = |text: &str| text.parse::<i64>().ok();
    let days = days_from_civil(
        number(&date[..4])?,
        number(&date[4..6])?,
        number(&date[6..])?,
    );
    let at = days * SECONDS_PER_DAY
        + number(&time[..2])? * SECONDS_PER_HOUR
        + number(&time[2..4])? * 60
        + number(&time[4..])?;
    // Out-of-range fields such as month 13 or 25 o'clock do not survive the round trip.
    (file_name(kind, at) == name).then_some((kind, at))
}

/// Whether an automatic backup is due at `now`, given the time of the latest one. A
/// latest backup from the future means the clock was turned back, so one is due.
pub fn is_due(latest: Option<i64>, now: i64, interval_hours: u32) -> bool {
    latest.is_none_or(|latest| {
        now < latest || now - latest >= i64::from(interval_hours) * SECONDS_PER_HOUR
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackupSettings {
    pub enabled: bool,
    /// Hours between automatic backups.
    pub interval_hours: u32,
    /// Number of automatic backups kept; older ones are deleted.
    pub keep: u32,
}

impl BackupSettings {
    pub const MAX_INTERVAL_HOURS: u32 = 24 * 30;
    pub const MAX_KEEP: u32 = 100;

    pub fn validate(self) -> Result<Self, BackupSettingsError> {
        if !(1..=Self::MAX_INTERVAL_HOURS).contains(&self.interval_hours) {
            return Err(BackupSettingsError::Interval(self.interval_hours));
        }
        if !(1..=Self::MAX_KEEP).contains(&self.keep) {
            return Err(BackupSettingsError::Keep(self.keep));
        }
        Ok(self)
    }
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 24,
            keep: 7,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupSettingsError {
    Interval(u32),
    Keep(u32),
}

impl fmt::Display for BackupSettingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Interval(hours) => write!(
                f,
                "backup interval must be between 1 and {} hours, not {hours}",
                BackupSettings::MAX_INTERVAL_HOURS
            ),
            Self::Keep(count) => write!(
                f,
                "number of kept backups must be between 1 and {}, not {count}",
                BackupSettings::MAX_KEEP
            ),
        }
    }
}

impl std::error::Error for BackupSettingsError {}

/// Proleptic Gregorian date of a day counted from 1970-01-01 (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_names_carry_the_utc_date_and_are_not_backup_names() {
        let name = export_file_name(1_791_970_205);
        assert_eq!(name, "toodo-backup-2026-10-14.sqlite3");
        assert_eq!(parse_file_name(&name), None);
    }

    #[test]
    fn file_names_carry_kind_and_utc_time() {
        let at = 1_791_970_205;
        assert_eq!(
            file_name(BackupKind::Automatic, at),
            "toodo-auto-20261014-093005.sqlite3"
        );
        assert_eq!(
            file_name(BackupKind::PreRestore, 0),
            "toodo-pre-restore-19700101-000000.sqlite3"
        );
        assert_eq!(
            file_name(BackupKind::Automatic, 951_782_400),
            "toodo-auto-20000229-000000.sqlite3"
        );
    }

    #[test]
    fn file_names_parse_back() {
        for kind in [BackupKind::Automatic, BackupKind::PreRestore] {
            for at in [0, 951_782_400, 1_791_970_205, 4_102_444_799] {
                assert_eq!(parse_file_name(&file_name(kind, at)), Some((kind, at)));
            }
        }
    }

    #[test]
    fn other_file_names_are_not_backups() {
        for name in [
            "toodo.sqlite3",
            "toodo-auto-20261014-093005.sqlite3.partial",
            "toodo-auto-20261014-093005.db",
            "toodo-manual-20261014-093005.sqlite3",
            "toodo-auto-2026101-0930050.sqlite3",
            "toodo-auto-20261314-093005.sqlite3",
            "toodo-auto-20260230-093005.sqlite3",
            "toodo-auto-20261014-253005.sqlite3",
            "toodo-auto-2026+014-093005.sqlite3",
            "notes.txt",
        ] {
            assert_eq!(parse_file_name(name), None, "{name}");
        }
    }

    #[test]
    fn a_backup_is_due_once_the_interval_has_passed() {
        assert!(is_due(None, 0, 24));
        assert!(!is_due(Some(1_000), 1_000 + 24 * 3_600 - 1, 24));
        assert!(is_due(Some(1_000), 1_000 + 24 * 3_600, 24));
        assert!(is_due(Some(1_000), 1_000 + 3_600, 1));
        assert!(is_due(Some(1_000), 999, 24));
    }

    #[test]
    fn settings_are_bounded() {
        assert_eq!(
            BackupSettings::default().validate(),
            Ok(BackupSettings::default())
        );
        let settings = |interval_hours, keep| BackupSettings {
            enabled: true,
            interval_hours,
            keep,
        };
        assert_eq!(
            settings(0, 7).validate(),
            Err(BackupSettingsError::Interval(0))
        );
        assert_eq!(
            settings(721, 7).validate(),
            Err(BackupSettingsError::Interval(721))
        );
        assert_eq!(
            settings(24, 0).validate(),
            Err(BackupSettingsError::Keep(0))
        );
        assert_eq!(
            settings(24, 101).validate(),
            Err(BackupSettingsError::Keep(101))
        );
        assert!(settings(720, 100).validate().is_ok());
    }
}
