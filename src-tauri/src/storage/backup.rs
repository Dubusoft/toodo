//! Backups of the database: consistent snapshots written with `VACUUM INTO` and checked
//! with `PRAGMA integrity_check`, restores that check and migrate a backup before it
//! replaces the live data, and the backup directory Toodo keeps automatic, pre-restore,
//! and pre-migration backups in.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};

use super::{BUSY_TIMEOUT, Result, Storage, StorageError, migrations};
use crate::domain::backup::{self, BackupKind};

/// A backup Toodo wrote into its backup directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupFile {
    pub path: PathBuf,
    pub kind: BackupKind,
    /// Seconds since the Unix epoch.
    pub created_at: i64,
    pub size_bytes: u64,
}

/// A backup that was read, migrated to the latest schema, and checked, ready to replace
/// the live data with [`Storage::restore`].
pub struct StagedBackup(Connection);

impl StagedBackup {
    pub(super) fn connection(&self) -> &Connection {
        &self.0
    }
}

impl Storage {
    /// Writes a consistent snapshot of the database to `path`, replacing any file there
    /// (see [`write_snapshot`]).
    pub fn export_to(&self, path: &Path) -> Result<()> {
        write_snapshot(&self.conn, path)
    }

    /// Writes a backup of `kind` into `dir` through this connection (see [`backup_with`]).
    /// Callers hold the storage lock for it, so no write lands between the backup and
    /// what they do next, such as a restore.
    pub fn backup_into(&self, dir: &Path, kind: BackupKind) -> Result<BackupFile> {
        backup_with(&self.conn, dir, kind, self.now())
    }

    /// The database file; `None` for an in-memory database.
    pub fn database_path(&self) -> Option<PathBuf> {
        self.conn
            .path()
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
    }

    /// Replaces all data with a staged backup.
    pub fn restore(&mut self, staged: StagedBackup) -> Result<()> {
        copy_database(&staged.0, &mut self.conn)
    }
}

/// Writes a backup of `kind` of the database file at `database` into `dir` at time `at`,
/// through a connection of its own. The database is in WAL mode, so the backup reads the
/// last committed data without waiting for the writes of other connections, and they do
/// not wait for it.
pub fn backup_database(
    database: &Path,
    dir: &Path,
    kind: BackupKind,
    at: i64,
) -> Result<BackupFile> {
    backup_with(&open_source(database)?, dir, kind, at)
}

/// Writes a consistent snapshot of the database file at `database` to `path` through a
/// connection of its own, like [`backup_database`].
pub fn export_database(database: &Path, path: &Path) -> Result<()> {
    write_snapshot(&open_source(database)?, path)
}

/// Writes a pre-migration backup of the database file at `database` into `dir` when
/// [`Storage::open`] would migrate it to a newer schema; `None` when there is nothing to
/// migrate (no file yet, a new empty database, or the latest schema). A schema newer than
/// this Toodo's is left to [`Storage::open`], which refuses it.
pub fn backup_before_migration(database: &Path, dir: &Path, at: i64) -> Result<Option<BackupFile>> {
    if !database.exists() {
        return Ok(None);
    }
    let conn = open_source(database)?;
    let version = migrations::schema_version(&conn)?;
    if version == 0 || version >= migrations::LATEST_VERSION {
        return Ok(None);
    }
    backup_with(&conn, dir, BackupKind::PreMigration, at).map(Some)
}

/// A connection to read a backup from the existing database file at `database`, without
/// migrating it. It is not opened read-only: SQLite has to be able to create the WAL
/// index of a database in WAL mode that no other connection has open.
fn open_source(database: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}

/// Writes a backup of `kind` of the database of `conn` into `dir`, creating the directory
/// if needed. Names carry the time `at` to the second; a backup never replaces an earlier
/// one from the same second, it takes the next free second instead.
fn backup_with(conn: &Connection, dir: &Path, kind: BackupKind, at: i64) -> Result<BackupFile> {
    fs::create_dir_all(dir)?;
    let mut created_at = at;
    while dir.join(backup::file_name(kind, created_at)).exists() {
        created_at += 1;
    }
    let path = dir.join(backup::file_name(kind, created_at));
    write_snapshot(conn, &path)?;
    Ok(BackupFile {
        size_bytes: fs::metadata(&path)?.len(),
        path,
        kind,
        created_at,
    })
}

/// Writes a consistent snapshot of the database of `conn` to `path`, replacing any file
/// there. The snapshot is written next to `path` first and checked with
/// `PRAGMA integrity_check`, so a failed or damaged snapshot never takes its place.
fn write_snapshot(conn: &Connection, path: &Path) -> Result<()> {
    let target = path.to_str().ok_or_else(|| {
        StorageError::InvalidBackup(format!("{} is not a valid UTF-8 path", path.display()))
    })?;
    let partial = format!("{target}.partial");
    remove_if_exists(Path::new(&partial))?;
    conn.execute("VACUUM INTO ?1", [&partial])?;
    let result = check_integrity(Path::new(&partial))
        .and_then(|()| fs::rename(&partial, path).map_err(StorageError::Io));
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result
}

/// Runs `PRAGMA integrity_check` on the database file at `path`.
fn check_integrity(path: &Path) -> Result<()> {
    let failed = |reason: &dyn std::fmt::Display| {
        StorageError::BackupCheckFailed(format!("{}: {reason}", path.display()))
    };
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| failed(&error))?;
    let result: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| failed(&error))?;
    if result == "ok" {
        Ok(())
    } else {
        Err(failed(&result))
    }
}

/// Reads the backup at `path` into memory, migrates it to the latest schema, and checks
/// its integrity. Fails with [`StorageError::InvalidBackup`] for a file that is not a
/// Toodo database, so the live data stays untouched.
pub fn stage_backup(path: &Path) -> Result<StagedBackup> {
    let invalid = |reason: &dyn std::fmt::Display| {
        StorageError::InvalidBackup(format!("{}: {reason}", path.display()))
    };
    let source = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| invalid(&error))?;
    let version = migrations::schema_version(&source).map_err(|error| invalid(&error))?;
    if version == 0 {
        return Err(invalid(&"not a Toodo database"));
    }
    let mut staged = Connection::open_in_memory()?;
    copy_database(&source, &mut staged).map_err(|error| invalid(&error))?;
    migrations::migrate(&mut staged).map_err(|error| invalid(&error))?;
    let integrity: String = staged.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(invalid(&format!("integrity check failed: {integrity}")));
    }
    Ok(StagedBackup(staged))
}

/// Backups in `dir`, newest first. A missing directory has none; files that Toodo did
/// not name as backups are skipped.
pub fn list_backups(dir: &Path) -> Result<Vec<BackupFile>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut backups = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Some((kind, created_at)) = entry.file_name().to_str().and_then(backup::parse_file_name)
        else {
            continue;
        };
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        backups.push(BackupFile {
            path: entry.path(),
            kind,
            created_at,
            size_bytes: metadata.len(),
        });
    }
    backups.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.path.cmp(&a.path))
    });
    Ok(backups)
}

/// Deletes all but the newest `keep` backups of `kind` in `dir`; returns the deleted ones.
pub fn prune_backups(dir: &Path, kind: BackupKind, keep: usize) -> Result<Vec<BackupFile>> {
    let expired: Vec<BackupFile> = list_backups(dir)?
        .into_iter()
        .filter(|backup| backup.kind == kind)
        .skip(keep)
        .collect();
    for backup in &expired {
        remove_if_exists(&backup.path)?;
    }
    Ok(expired)
}

fn copy_database(source: &Connection, target: &mut Connection) -> Result<()> {
    Backup::new(source, target)?.run_to_completion(256, Duration::ZERO, None)?;
    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::model::TaskType;
    use crate::storage::{NewTask, NewWorkspace};

    fn open(dir: &Path) -> Storage {
        Storage::open(&dir.join("toodo.sqlite3")).unwrap()
    }

    fn add_workspace(storage: &mut Storage, name: &str) {
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: name.to_owned(),
                description: None,
                repository: None,
            })
            .unwrap();
        let first = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: format!("{name} first"),
                description: String::new(),
                estimate: None,
                due_date: None,
                autopilot: false,
                criteria: Vec::new(),
            })
            .unwrap();
        let second = storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Fix,
                title: format!("{name} second"),
                description: String::new(),
                estimate: None,
                due_date: None,
                autopilot: false,
                criteria: Vec::new(),
            })
            .unwrap();
        storage.add_dependency(second.id, first.id).unwrap();
    }

    fn snapshot(storage: &Storage) -> Vec<String> {
        let mut rows = Vec::new();
        for workspace in storage.list_workspaces().unwrap() {
            for task in storage.list_tasks(workspace.id).unwrap() {
                rows.push(format!("{workspace:?} {task:?}"));
            }
        }
        rows
    }

    #[test]
    fn restoring_an_export_brings_back_the_exported_data() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = open(dir.path());
        add_workspace(&mut storage, "toodo");
        let exported = snapshot(&storage);
        let export = dir.path().join("export.sqlite3");
        storage.export_to(&export).unwrap();

        add_workspace(&mut storage, "herdr");
        assert_ne!(snapshot(&storage), exported);
        storage.restore(stage_backup(&export).unwrap()).unwrap();

        assert_eq!(snapshot(&storage), exported);
        drop(storage);
        assert_eq!(snapshot(&open(dir.path())), exported);
    }

    #[test]
    fn exporting_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = open(dir.path());
        let export = dir.path().join("export.sqlite3");
        fs::write(&export, "old").unwrap();
        add_workspace(&mut storage, "toodo");

        storage.export_to(&export).unwrap();

        let mut restored = Storage::open_in_memory().unwrap();
        restored.restore(stage_backup(&export).unwrap()).unwrap();
        assert_eq!(snapshot(&restored), snapshot(&storage));
        assert!(!dir.path().join("export.sqlite3.partial").exists());
    }

    #[test]
    fn files_that_are_not_toodo_databases_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let garbage = dir.path().join("garbage.sqlite3");
        fs::write(&garbage, "plain text, not SQLite ".repeat(300)).unwrap();
        let other = dir.path().join("other.sqlite3");
        Connection::open(&other)
            .unwrap()
            .execute_batch("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('hi');")
            .unwrap();
        let newer = dir.path().join("newer.sqlite3");
        Connection::open(&newer)
            .unwrap()
            .pragma_update(None, "user_version", migrations::LATEST_VERSION + 1)
            .unwrap();
        let missing = dir.path().join("missing.sqlite3");

        for path in [&garbage, &other, &newer, &missing] {
            let error = stage_backup(path).err().expect("backup is rejected");
            assert!(matches!(error, StorageError::InvalidBackup(_)), "{error}");
        }
        assert!(!missing.exists());
    }

    #[test]
    fn backups_of_older_schemas_are_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.sqlite3");
        let conn = Connection::open(&old).unwrap();
        conn.execute_batch(migrations::MIGRATIONS[0]).unwrap();
        conn.execute_batch(
            r"
            PRAGMA user_version = 1;
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            ",
        )
        .unwrap();
        drop(conn);

        let mut storage = Storage::open_in_memory().unwrap();
        storage.restore(stage_backup(&old).unwrap()).unwrap();

        assert_eq!(
            migrations::schema_version(&storage.conn).unwrap(),
            migrations::LATEST_VERSION
        );
        let names: Vec<String> = storage
            .list_workspaces()
            .unwrap()
            .into_iter()
            .map(|workspace| workspace.name)
            .collect();
        assert_eq!(names, ["toodo"]);
        let workspace = storage.list_workspaces().unwrap().pop().unwrap();
        assert_eq!(workspace.repository, None);
        assert_eq!(
            workspace.description.as_deref(),
            Some(r"Former directory: `C:\dev\toodo`")
        );
        assert_eq!(
            storage.get_workspace(workspace.id).unwrap(),
            Some(workspace)
        );
    }

    #[test]
    fn a_backup_keeps_workspace_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = open(dir.path());
        storage
            .create_workspace(&NewWorkspace {
                name: "notes".to_owned(),
                description: None,
                repository: None,
            })
            .unwrap();
        let export = dir.path().join("export.sqlite3");
        storage.export_to(&export).unwrap();

        let mut restored = Storage::open_in_memory().unwrap();
        restored.restore(stage_backup(&export).unwrap()).unwrap();

        assert_eq!(
            restored.list_workspaces().unwrap(),
            storage.list_workspaces().unwrap()
        );
        assert_eq!(restored.list_workspaces().unwrap().len(), 1);
    }

    #[test]
    fn backups_in_the_same_second_keep_each_other() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(|| 1_000);
        let first = storage
            .backup_into(dir.path(), BackupKind::PreRestore)
            .unwrap();
        add_workspace(&mut storage, "toodo");
        let second = storage
            .backup_into(dir.path(), BackupKind::PreRestore)
            .unwrap();

        assert_ne!(first.path, second.path);
        assert_eq!(second.created_at, 1_001);
        let mut restored = Storage::open_in_memory().unwrap();
        restored
            .restore(stage_backup(&first.path).unwrap())
            .unwrap();
        assert!(snapshot(&restored).is_empty());
    }

    #[test]
    fn an_older_schema_is_backed_up_before_it_is_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join("backups");
        let database = dir.path().join("toodo.sqlite3");
        assert_eq!(
            backup_before_migration(&database, &backups, 1_000).unwrap(),
            None
        );
        assert!(!database.exists());
        let conn = Connection::open(&database).unwrap();
        conn.execute_batch(migrations::MIGRATIONS[0]).unwrap();
        conn.execute_batch(
            r"
            PRAGMA user_version = 1;
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            ",
        )
        .unwrap();
        drop(conn);

        let saved = backup_before_migration(&database, &backups, 1_000)
            .unwrap()
            .expect("an older schema is backed up");

        assert_eq!(saved.kind, BackupKind::PreMigration);
        assert_eq!(
            list_backups(&backups).unwrap(),
            std::slice::from_ref(&saved)
        );
        let copy = Connection::open(&saved.path).unwrap();
        assert_eq!(migrations::schema_version(&copy).unwrap(), 1);
        let name: String = copy
            .query_row("SELECT name FROM workspaces", [], |row| row.get(0))
            .unwrap();
        assert_eq!(name, "toodo");
        drop(Storage::open(&database).unwrap());
        assert_eq!(
            backup_before_migration(&database, &backups, 2_000).unwrap(),
            None
        );
        assert_eq!(list_backups(&backups).unwrap(), [saved]);
    }

    #[test]
    fn a_damaged_snapshot_fails_the_integrity_check() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = open(dir.path());
        for index in 0..40 {
            add_workspace(&mut storage, &format!("workspace-{index}"));
        }
        let export = dir.path().join("export.sqlite3");
        storage.export_to(&export).unwrap();
        check_integrity(&export).unwrap();

        let mut bytes = fs::read(&export).unwrap();
        let page = 4096;
        assert!(bytes.len() > 4 * page, "{} bytes", bytes.len());
        bytes[2 * page..3 * page].fill(0x5a);
        fs::write(&export, bytes).unwrap();

        let error = check_integrity(&export).unwrap_err();
        assert!(
            matches!(error, StorageError::BackupCheckFailed(_)),
            "{error}"
        );
    }

    #[test]
    fn a_backup_reads_committed_data_without_waiting_for_an_open_write() {
        let dir = tempfile::tempdir().unwrap();
        let mut storage = open(dir.path());
        add_workspace(&mut storage, "committed");
        let database = storage.database_path().unwrap();
        let writer = Connection::open(&database).unwrap();
        writer
            .execute_batch(
                "BEGIN IMMEDIATE;
                 INSERT INTO workspaces (name) VALUES ('pending');",
            )
            .unwrap();

        let started = std::time::Instant::now();
        let saved = backup_database(
            &database,
            &dir.path().join("backups"),
            BackupKind::Automatic,
            1_000,
        )
        .unwrap();

        assert!(started.elapsed() < BUSY_TIMEOUT, "{:?}", started.elapsed());
        let mut restored = Storage::open_in_memory().unwrap();
        restored
            .restore(stage_backup(&saved.path).unwrap())
            .unwrap();
        let names: Vec<String> = restored
            .list_workspaces()
            .unwrap()
            .into_iter()
            .map(|workspace| workspace.name)
            .collect();
        assert_eq!(names, ["committed"]);
        writer.execute_batch("COMMIT").unwrap();
    }

    #[test]
    fn in_memory_databases_have_no_file() {
        assert_eq!(Storage::open_in_memory().unwrap().database_path(), None);
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            open(dir.path()).database_path(),
            Some(dir.path().join("toodo.sqlite3"))
        );
    }

    #[test]
    fn listing_skips_other_files_and_sorts_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_backups(&dir.path().join("none")).unwrap().is_empty());
        let mut storage = Storage::open_in_memory().unwrap();
        let backups = dir.path().join("backups");
        storage.set_clock(|| 1_000);
        let older = storage
            .backup_into(&backups, BackupKind::Automatic)
            .unwrap();
        storage.set_clock(|| 2_000);
        let newer = storage
            .backup_into(&backups, BackupKind::PreRestore)
            .unwrap();
        fs::write(backups.join("notes.txt"), "").unwrap();
        fs::create_dir(backups.join(backup::file_name(BackupKind::Automatic, 3_000))).unwrap();

        assert_eq!(list_backups(&backups).unwrap(), [newer, older]);
    }
}
