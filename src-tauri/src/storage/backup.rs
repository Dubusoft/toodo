//! Backups of the database: consistent snapshots written with `VACUUM INTO`, restores
//! that check and migrate a backup before it replaces the live data, and the backup
//! directory Toodo keeps automatic and pre-restore backups in.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags};

use super::{Result, Storage, StorageError, migrations};
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
    /// Writes a consistent snapshot of the database to `path`, replacing any file there.
    /// The snapshot is written next to `path` first, so a failed export never leaves a
    /// truncated file in its place.
    pub fn export_to(&self, path: &Path) -> Result<()> {
        let target = path.to_str().ok_or_else(|| {
            StorageError::InvalidBackup(format!("{} is not a valid UTF-8 path", path.display()))
        })?;
        let partial = format!("{target}.partial");
        remove_if_exists(Path::new(&partial))?;
        self.conn.execute("VACUUM INTO ?1", [&partial])?;
        fs::rename(&partial, path).map_err(|error| {
            let _ = fs::remove_file(&partial);
            StorageError::Io(error)
        })
    }

    /// Writes a backup of `kind` into `dir`, creating the directory if needed. Names carry
    /// the time to the second; a backup never replaces an earlier one from the same second,
    /// it takes the next free second instead.
    pub fn backup_into(&self, dir: &Path, kind: BackupKind) -> Result<BackupFile> {
        fs::create_dir_all(dir)?;
        let mut created_at = self.now();
        while dir.join(backup::file_name(kind, created_at)).exists() {
            created_at += 1;
        }
        let path = dir.join(backup::file_name(kind, created_at));
        self.export_to(&path)?;
        Ok(BackupFile {
            size_bytes: fs::metadata(&path)?.len(),
            path,
            kind,
            created_at,
        })
    }

    /// Replaces all data with a staged backup.
    pub fn restore(&mut self, staged: StagedBackup) -> Result<()> {
        copy_database(&staged.0, &mut self.conn)
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
    use crate::domain::model::{TaskType, WorkspaceLocation};
    use crate::domain::path::WindowsPath;
    use crate::storage::{NewTask, NewWorkspace};

    fn open(dir: &Path) -> Storage {
        Storage::open(&dir.join("toodo.sqlite3")).unwrap()
    }

    fn add_workspace(storage: &mut Storage, name: &str) {
        let workspace = storage
            .create_workspace(&NewWorkspace {
                name: name.to_owned(),
                location: WorkspaceLocation::Local {
                    path: WindowsPath::parse(&format!("C:\\dev\\{name}"))
                        .unwrap()
                        .into(),
                },
                default_base_branch: "main".to_owned(),
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
