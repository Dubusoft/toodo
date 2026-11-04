//! Schema migrations. Each entry upgrades the schema by one version; the current
//! version is stored in `PRAGMA user_version`. Never edit a released migration; append
//! a new one instead.

use rusqlite::{Connection, OptionalExtension};

use super::{Result, StorageError};
use data_steps::DATA_STEPS;
use v01_v24::VERSIONS_1_TO_24;
use v25_on::VERSIONS_25_ON;

mod data_steps;
#[cfg(test)]
mod host_events_tests;
#[cfg(test)]
mod tests;
mod v01_v24;
mod v25_on;

/// Every migration in order: entry `i` upgrades the schema to version `i + 1`.
const ALL_MIGRATIONS: [&str; VERSIONS_1_TO_24.len() + VERSIONS_25_ON.len()] = {
    let mut all = [""; VERSIONS_1_TO_24.len() + VERSIONS_25_ON.len()];
    let mut index = 0;
    while index < VERSIONS_1_TO_24.len() {
        all[index] = VERSIONS_1_TO_24[index];
        index += 1;
    }
    while index < all.len() {
        all[index] = VERSIONS_25_ON[index - VERSIONS_1_TO_24.len()];
        index += 1;
    }
    all
};

pub(super) const MIGRATIONS: &[&str] = &ALL_MIGRATIONS;

pub(super) const LATEST_VERSION: i64 = MIGRATIONS.len() as i64;

pub(super) fn schema_version(conn: &Connection) -> Result<i64> {
    Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
}

/// Migrates the schema to [`LATEST_VERSION`] in one transaction. Foreign key enforcement
/// is turned off first, because rebuilding a referenced table would otherwise cascade
/// deletes into its children; the result is checked with `PRAGMA foreign_key_check`
/// instead. The caller turns enforcement back on.
pub(super) fn migrate(conn: &mut Connection) -> Result<()> {
    let version = schema_version(conn)?;
    if version > LATEST_VERSION {
        return Err(StorageError::UnsupportedSchemaVersion {
            found: version,
            supported: LATEST_VERSION,
        });
    }
    conn.pragma_update(None, "foreign_keys", false)?;
    let tx = conn.transaction()?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        tx.execute_batch(sql)?;
        let version = index as i64 + 1;
        for (_, step) in DATA_STEPS.iter().filter(|(after, _)| *after == version) {
            step(&tx)?;
        }
        tx.pragma_update(None, "user_version", version)?;
    }
    let violation: Option<String> = tx
        .query_row("PRAGMA foreign_key_check", [], |row| row.get(0))
        .optional()?;
    if let Some(table) = violation {
        return Err(StorageError::InvalidData(format!(
            "migration left a dangling foreign key in table {table}"
        )));
    }
    tx.commit()?;
    Ok(())
}
