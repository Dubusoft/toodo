//! Merging another Toodo database, such as one of the former desktop app, into this one.
//!
//! Workspaces and tasks with their history are added next to the data already here.
//! Imported rows get IDs after every ID this database has used, so nothing here changes;
//! references between imported rows move along. Devices, push subscriptions, connected
//! OAuth apps, and the lead chat of the other database are not imported: they belong to
//! the server that kept them. Tasks forget their herdr workspace: runtime records are not
//! imported, since their IDs only meant something to the other machine's herdr.

use std::time::Duration;

use rusqlite::Transaction;
use rusqlite::backup::Backup;

use super::{Result, StagedBackup, Storage, StorageError};

/// What [`Storage::import`] added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportSummary {
    pub workspaces: i64,
    pub tasks: i64,
    /// Task #N of the imported database is task #(N + offset) here.
    pub task_id_offset: i64,
}

const SOURCE: &str = "import_source";

/// How a column of an imported table gets its value: the expression to select, in which
/// `{w}` and `{t}` are the workspace and task ID offsets, or `None` to leave it to its
/// default (a new row ID, for example).
type Column = (&'static str, Option<&'static str>);

/// The imported tables in the order they are inserted, each with its columns that are
/// not copied as they are.
const TABLES: &[(&str, &[Column])] = &[
    (
        "workspaces",
        &[
            ("id", Some("id + {w}")),
            // The repositories here may differ from the other machine's, so the server
            // detects the source and completion of merge-based git workspaces again at its
            // next start; workspaces completed manually keep what was chosen.
            (
                "axes_detected",
                Some(
                    "CASE WHEN source = 'none' OR completion = 'manual' THEN axes_detected ELSE 0 END",
                ),
            ),
        ],
    ),
    (
        "tasks",
        &[
            ("id", Some("id + {t}")),
            ("workspace_id", Some("workspace_id + {w}")),
            ("merged_with_task_id", Some("merged_with_task_id + {t}")),
        ],
    ),
    (
        "task_dependencies",
        &[
            ("task_id", Some("task_id + {t}")),
            ("depends_on_id", Some("depends_on_id + {t}")),
        ],
    ),
    ("commit_records", &[("task_id", Some("task_id + {t}"))]),
    (
        "task_events",
        &[
            ("id", None),
            ("task_id", Some("task_id + {t}")),
            // What only the lead of the other server used.
            ("for_lead", Some("0")),
            ("taken_at", Some("NULL")),
            ("request_id", Some("NULL")),
            ("report_id", Some("NULL")),
        ],
    ),
    (
        "pull_request_snapshots",
        &[("task_id", Some("task_id + {t}"))],
    ),
    (
        "task_notes",
        &[("id", None), ("task_id", Some("task_id + {t}"))],
    ),
    (
        "task_relations",
        &[
            ("task_id", Some("task_id + {t}")),
            ("related_id", Some("related_id + {t}")),
        ],
    ),
    (
        "task_criteria",
        &[("id", None), ("task_id", Some("task_id + {t}"))],
    ),
    (
        "task_activity",
        &[("id", None), ("task_id", Some("task_id + {t}"))],
    ),
    ("task_labels", &[("task_id", Some("task_id + {t}"))]),
];

/// Tables that are deliberately left out, see the module documentation. `task_search` is
/// filled by the triggers on the imported tables.
#[cfg(test)]
pub(super) const SKIPPED: &[&str] = &[
    "machine_settings",
    "devices",
    "push_subscriptions",
    "oauth_clients",
    "oauth_grants",
    "oauth_tokens",
    "chat_messages",
    "task_results",
    "task_search",
    // Runtime handles and runs belong to the other server's hosts.
    "runtime_workspaces",
    "agent_conversations",
    "task_runs",
    "run_events",
    "run_operations",
    "runtime_host_events",
    "runtime_hosts",
];

impl Storage {
    /// Adds the workspaces and tasks of `staged` to this database in one
    /// transaction. Machine settings stay as they are here: worktree roots of the other
    /// machine would not fit this one.
    pub fn import(&mut self, staged: &StagedBackup) -> Result<ImportSummary> {
        self.conn
            .execute(&format!("ATTACH DATABASE ':memory:' AS {SOURCE}"), [])?;
        let result = Backup::new_with_names(staged.connection(), "main", &mut self.conn, SOURCE)
            .and_then(|backup| backup.run_to_completion(256, Duration::ZERO, None))
            .map_err(StorageError::from)
            .and_then(|()| {
                let tx = self.conn.transaction()?;
                let summary = merge(&tx)?;
                tx.commit()?;
                Ok(summary)
            });
        let detached = self.conn.execute(&format!("DETACH DATABASE {SOURCE}"), []);
        let summary = result?;
        detached?;
        Ok(summary)
    }
}

fn merge(tx: &Transaction<'_>) -> Result<ImportSummary> {
    // Imported rows may refer to rows imported after them, e.g. a task merged with a
    // later one; the references are checked once everything is in.
    tx.pragma_update(None, "defer_foreign_keys", true)?;
    let w = offset(tx, "workspaces")?;
    let t = offset(tx, "tasks")?;
    let count = |table: &str| -> Result<i64> {
        Ok(tx.query_row(
            &format!("SELECT count(*) FROM {SOURCE}.{table}"),
            [],
            |row| row.get(0),
        )?)
    };
    let summary = ImportSummary {
        workspaces: count("workspaces")?,
        tasks: count("tasks")?,
        task_id_offset: t,
    };
    for (table, columns) in TABLES {
        let all = column_names(tx, table)?;
        // Rows without an ID of their own get new ones in their original order.
        let order = if all.iter().any(|name| name == "id") {
            " ORDER BY id"
        } else {
            ""
        };
        let mut names = Vec::new();
        let mut values = Vec::new();
        for name in all {
            let value = match columns.iter().find(|(column, _)| *column == name) {
                Some((_, None)) => continue,
                Some((_, Some(value))) => value
                    .replace("{w}", &w.to_string())
                    .replace("{t}", &t.to_string()),
                None => name.clone(),
            };
            names.push(name);
            values.push(value);
        }
        tx.execute(
            &format!(
                "INSERT INTO main.{table} ({}) SELECT {} FROM {SOURCE}.{table}{order}",
                names.join(", "),
                values.join(", ")
            ),
            [],
        )?;
    }
    Ok(summary)
}

/// The columns of `table` in this database, which the imported one matches since both
/// have the latest schema.
fn column_names(tx: &Transaction<'_>, table: &str) -> Result<Vec<String>> {
    let mut statement = tx.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?;
    let names = statement
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(names)
}

/// The offset that puts imported IDs of `table` after every ID it ever used, including
/// those of deleted rows, which AUTOINCREMENT never hands out again.
fn offset(tx: &Transaction<'_>, table: &str) -> Result<i64> {
    Ok(tx.query_row(
        &format!(
            "SELECT max(
                coalesce((SELECT seq FROM main.sqlite_sequence WHERE name = '{table}'), 0),
                coalesce((SELECT max(id) FROM main.{table}), 0))"
        ),
        [],
        |row| row.get(0),
    )?)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::Path;

    use super::*;
    use crate::domain::model::{
        NoteKind, TaskId, TaskType, Workspace, WorkspaceId, WorkspaceLocation,
    };
    use crate::domain::path::{PosixPath, WindowsPath};
    use crate::storage::{NewTask, NewWorkspace, TaskSearch, stage_backup};

    fn add_workspace(storage: &mut Storage, name: &str, location: WorkspaceLocation) -> Workspace {
        storage
            .create_workspace(&NewWorkspace {
                name: name.to_owned(),
                location,
                default_base_branch: "main".to_owned(),
                source: crate::domain::model::Source::GitHub,
                completion: crate::domain::model::CompletionMode::PullRequestMerge,
                runner: crate::domain::model::Runner::Herdr,
                axes_detected: true,
            })
            .unwrap()
    }

    fn add_task(storage: &mut Storage, workspace: &Workspace, title: &str) -> TaskId {
        storage
            .create_task(&NewTask {
                workspace_id: workspace.id,
                task_type: TaskType::Feat,
                title: title.to_owned(),
                description: String::new(),
                estimate: None,
                due_date: None,
                criteria: Vec::new(),
            })
            .unwrap()
            .id
    }

    fn count(storage: &Storage, sql: &str) -> i64 {
        storage.conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    /// A database like the desktop app's: a Windows workspace whose second task waits on
    /// the first, with history, notes, a related link, and a device, saved at schema
    /// version 25, which still kept project memory entries.
    fn desktop_database(path: &Path) {
        let mut desktop = Storage::open(path).unwrap();
        let workspace = add_workspace(
            &mut desktop,
            "app",
            WorkspaceLocation::Local {
                path: WindowsPath::parse(r"C:\dev\app").unwrap().into(),
            },
        );
        let first = add_task(&mut desktop, &workspace, "Add storage");
        let second = add_task(&mut desktop, &workspace, "Add sync");
        desktop.add_dependency(second, first).unwrap();
        desktop.add_related(first, second).unwrap();
        desktop
            .add_task_note(first, NoteKind::Progress, "Schema drafted")
            .unwrap();
        desktop
            .conn
            .execute_batch(
                r"INSERT INTO devices (label, token_hash, created_at, last_seen_at)
                 VALUES ('Browser', printf('%064d', 0), 0, 0);
                 INSERT INTO machine_settings (kind, label, worktree_root)
                 VALUES ('local', '', 'D:\worktrees');
                 CREATE TABLE memory_entries (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     workspace_id INTEGER REFERENCES workspaces (id) ON DELETE CASCADE,
                     kind TEXT NOT NULL,
                     title TEXT NOT NULL,
                     body TEXT NOT NULL DEFAULT '',
                     task_id INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL,
                     superseded_by INTEGER REFERENCES memory_entries (id) ON DELETE SET NULL
                 );
                 INSERT INTO memory_entries (workspace_id, kind, title, created_at, updated_at)
                 VALUES (NULL, 'rule', 'Reply in English', 0, 0);
                 ALTER TABLE workspaces DROP COLUMN source;
                 ALTER TABLE workspaces DROP COLUMN completion;
                 ALTER TABLE workspaces DROP COLUMN runner;
                 ALTER TABLE workspaces DROP COLUMN axes_detected;
                 DROP TABLE task_activity;
                 DROP TABLE task_labels;
                 ALTER TABLE tasks ADD COLUMN herdr_workspace_id TEXT;
                 UPDATE tasks SET herdr_workspace_id = 'w1' WHERE title = 'Add storage';
                 DROP TABLE run_operations;
                 DROP TABLE run_events;
                 DROP TABLE task_runs;
                 DROP TABLE agent_conversations;
                 DROP TABLE runtime_workspaces;
                 DROP TABLE runtime_host_events;
                 DROP TABLE runtime_hosts;
                 DROP TABLE oauth_tokens;
                 DROP TABLE oauth_grants;
                 DROP TABLE oauth_clients;
                 ALTER TABLE push_subscriptions DROP COLUMN last_failure;
                 ALTER TABLE push_subscriptions DROP COLUMN last_failure_at;
                 PRAGMA user_version = 25;",
            )
            .unwrap();
    }

    #[test]
    fn imported_git_workspaces_are_detected_again_and_manual_ones_keep_their_axes() {
        use crate::domain::model::{CompletionMode, Runner, Source};
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other.sqlite3");
        let mut other = Storage::open(&source).unwrap();
        add_workspace(
            &mut other,
            "site",
            WorkspaceLocation::Local {
                path: PosixPath::parse("/srv/site").unwrap().into(),
            },
        );
        other
            .create_workspace(&NewWorkspace {
                name: "notes".to_owned(),
                location: WorkspaceLocation::Local {
                    path: PosixPath::parse("/srv/notes").unwrap().into(),
                },
                default_base_branch: String::new(),
                source: Source::None,
                completion: CompletionMode::Manual,
                runner: Runner::None,
                axes_detected: true,
            })
            .unwrap();
        drop(other);

        let mut server = Storage::open_in_memory().unwrap();
        server.import(&stage_backup(&source).unwrap()).unwrap();

        let names = |workspaces: Vec<Workspace>| -> Vec<String> {
            workspaces
                .into_iter()
                .map(|workspace| workspace.name)
                .collect()
        };
        assert_eq!(names(server.workspaces_to_detect().unwrap()), ["site"]);
        let notes = server
            .list_workspaces()
            .unwrap()
            .into_iter()
            .find(|workspace| workspace.name == "notes")
            .unwrap();
        assert_eq!(
            (
                notes.name.as_str(),
                notes.source,
                notes.completion,
                notes.runner
            ),
            ("notes", Source::None, CompletionMode::Manual, Runner::None)
        );
    }

    #[test]
    fn imports_next_to_the_data_here_with_ids_after_every_used_one() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("desktop.sqlite3");
        desktop_database(&source);

        let mut server = Storage::open(&dir.path().join("server.sqlite3")).unwrap();
        let site = add_workspace(
            &mut server,
            "site",
            WorkspaceLocation::Local {
                path: PosixPath::parse("/srv/site").unwrap().into(),
            },
        );
        let kept = add_task(&mut server, &site, "Server task");
        let deleted = add_task(&mut server, &site, "Deleted task");
        server.delete_task(deleted).unwrap();

        let summary = server.import(&stage_backup(&source).unwrap()).unwrap();

        assert_eq!(
            summary,
            ImportSummary {
                workspaces: 1,
                tasks: 2,
                task_id_offset: 2,
            }
        );
        let (first, second) = (TaskId(3), TaskId(4));
        let imported = server.get_task(first).unwrap().unwrap();
        assert_eq!(imported.title, "Add storage");
        assert_eq!(imported.workspace_id.0, site.id.0 + 1);
        assert_eq!(imported.herdr_workspace_id, None);
        let waiting = server.get_task(second).unwrap().unwrap();
        assert_eq!(waiting.depends_on, BTreeSet::from([first]));
        assert_eq!(server.list_relations().unwrap(), vec![(first, second)]);
        assert_eq!(server.get_task(kept).unwrap().unwrap().title, "Server task");
        assert_eq!(
            count(
                &server,
                "SELECT count(*) FROM task_events WHERE task_id IN (3, 4)"
            ),
            2
        );
        let found = server
            .search_tasks(&TaskSearch {
                query: "drafted",
                workspace: None,
                status: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(found, vec![first]);
        assert_eq!(
            count(
                &server,
                "SELECT count(*) FROM sqlite_master WHERE name = 'memory_entries'"
            ),
            0
        );
        assert_eq!(count(&server, "SELECT count(*) FROM devices"), 0);
        assert_eq!(count(&server, "SELECT count(*) FROM machine_settings"), 0);
        assert_eq!(add_task(&mut server, &site, "Next task"), TaskId(5));
    }

    #[test]
    fn into_an_empty_database_tasks_keep_their_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("desktop.sqlite3");
        desktop_database(&source);
        let mut server = Storage::open_in_memory().unwrap();

        let summary = server.import(&stage_backup(&source).unwrap()).unwrap();

        assert_eq!(summary.task_id_offset, 0);
        let titles: Vec<_> = server
            .list_all_tasks()
            .unwrap()
            .into_iter()
            .map(|task| (task.id, task.title))
            .collect();
        assert_eq!(
            titles,
            [
                (TaskId(1), "Add storage".to_owned()),
                (TaskId(2), "Add sync".to_owned())
            ]
        );
    }

    /// Imported tasks forget their herdr workspace, so they get no runtime workspace;
    /// the runtime records of the other server stay behind.
    #[test]
    fn imported_tasks_have_no_runtime_records() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other.sqlite3");
        {
            let mut other = Storage::open(&source).unwrap();
            let workspace = add_workspace(
                &mut other,
                "site",
                WorkspaceLocation::Local {
                    path: PosixPath::parse("/srv/site").unwrap().into(),
                },
            );
            let task = add_task(&mut other, &workspace, "Started");
            let checkout = crate::domain::naming::TaskCheckout {
                path: PosixPath::parse("/wt/started").unwrap().into(),
                branch: "feat/started".to_owned(),
            };
            other.start_task(task, &checkout, "w1").unwrap();
            other
                .set_host_state(
                    &crate::domain::runtime::OwnerKey::implicit(),
                    &crate::domain::runtime::HostRef::Local,
                    crate::runtime::events::HostState::Online,
                )
                .unwrap();
            assert_eq!(count(&other, "SELECT count(*) FROM runtime_workspaces"), 1);
            assert_eq!(count(&other, "SELECT count(*) FROM runtime_host_events"), 1);
            assert_eq!(count(&other, "SELECT count(*) FROM runtime_hosts"), 1);
        }
        let mut server = Storage::open_in_memory().unwrap();

        server.import(&stage_backup(&source).unwrap()).unwrap();

        assert_eq!(count(&server, "SELECT count(*) FROM tasks"), 1);
        assert_eq!(count(&server, "SELECT count(*) FROM runtime_workspaces"), 0);
        assert_eq!(
            count(&server, "SELECT count(*) FROM runtime_host_events"),
            0
        );
        assert_eq!(count(&server, "SELECT count(*) FROM runtime_hosts"), 0);
        let imported = server.list_tasks(WorkspaceId(1)).unwrap();
        assert_eq!(imported[0].herdr_workspace_id, None);
    }

    #[test]
    fn connected_oauth_apps_stay_with_the_issuing_server() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other.sqlite3");
        let mut other = Storage::open(&source).unwrap();
        let client = super::super::oauth::Client {
            client_id: "other-client".to_owned(),
            secret_hash: None,
            client_name: Some("Other app".to_owned()),
            redirect_uris: vec!["https://client.example/callback".to_owned()],
            auth_method: "none".to_owned(),
            created_at: 1000,
        };
        other.oauth_register_client(&client).unwrap();
        other
            .oauth_create_grant(
                &crate::oauth::server_owner(),
                &client,
                crate::oauth::Scopes::READ,
                "other-access-hash",
                "other-refresh-hash",
            )
            .unwrap();
        drop(other);

        let mut server = Storage::open_in_memory().unwrap();
        server.import(&stage_backup(&source).unwrap()).unwrap();
        for table in ["oauth_clients", "oauth_grants", "oauth_tokens"] {
            assert_eq!(count(&server, &format!("SELECT count(*) FROM {table}")), 0);
        }
    }

    /// A table a later migration adds has to be imported or skipped on purpose.
    #[test]
    fn every_table_is_imported_or_deliberately_skipped() {
        let storage = Storage::open_in_memory().unwrap();
        let mut statement = storage
            .conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table'
                 AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'task_search_%'",
            )
            .unwrap();
        let tables: BTreeSet<String> = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let handled: BTreeSet<String> = TABLES
            .iter()
            .map(|(table, _)| *table)
            .chain(SKIPPED.iter().copied())
            .map(str::to_owned)
            .collect();
        assert_eq!(tables, handled);
    }
}
