//! Merging another Toodo database, such as one of the former desktop app, into this one.
//!
//! Workspaces and tasks with their history are added next to the data already here.
//! Imported rows get IDs after every ID this database has used, so nothing here changes;
//! references between imported rows move along. Devices, push subscriptions, connected
//! OAuth apps, settings, saved reviews, and the lead chat of the other database are not
//! imported: they belong to the server that kept them. Tasks forget their herdr workspace: runtime records are not
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
    ("workspaces", &[("id", Some("id + {w}"))]),
    (
        "workspace_guidelines",
        &[("id", None), ("workspace_id", Some("workspace_id + {w}"))],
    ),
    (
        "tasks",
        &[
            ("id", Some("id + {t}")),
            ("workspace_id", Some("workspace_id + {w}")),
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
        "pull_request_snapshots",
        &[("task_id", Some("task_id + {t}"))],
    ),
    (
        "task_activity",
        &[("id", None), ("task_id", Some("task_id + {t}"))],
    ),
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
    ("task_labels", &[("task_id", Some("task_id + {t}"))]),
];

/// Tables that are deliberately left out, see the module documentation. `task_search` is
/// filled by the triggers on the imported tables.
#[cfg(test)]
pub(super) const SKIPPED: &[&str] = &[
    "devices",
    "push_subscriptions",
    "oauth_clients",
    "oauth_grants",
    "oauth_tokens",
    "chat_messages",
    "task_results",
    "task_search",
    // Runtime handles and runs belong to the other server's hosts.
    // Settings and saved reviews belong to the server that kept them.
    "settings",
    "review_snapshots",
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
    use crate::domain::model::{TaskId, TaskType, Workspace, WorkspaceId};
    use crate::storage::{NewTask, NewWorkspace, TaskSearch, stage_backup};

    fn add_workspace(storage: &mut Storage, name: &str, repository: String) -> Workspace {
        storage
            .create_workspace(&NewWorkspace {
                name: name.to_owned(),
                description: None,
                repository: Some(repository),
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

    fn desktop_database(path: &Path) {
        let conn = rusqlite::Connection::open(path).unwrap();
        for sql in &super::super::migrations::MIGRATIONS[..25] {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute_batch(r#"PRAGMA user_version = 25;
            INSERT INTO workspaces (id, name, kind, path, default_base_branch) VALUES (1, 'app', 'local', 'C:\dev\app', 'main');
            INSERT INTO tasks (id, workspace_id, type, title, status, branch, pull_request_url) VALUES (1, 1, 'feat', 'Add storage', 'planned', 'feat/storage', 'https://example.com/pull/1'), (2, 1, 'feat', 'Add sync', 'planned', NULL, NULL);
            INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (2, 1);
            INSERT INTO task_relations (task_id, related_id) VALUES (1, 2);
            INSERT INTO task_events (task_id, status, at) VALUES (1, 'planned', 0), (2, 'planned', 0);
            INSERT INTO task_notes (task_id, kind, body, at) VALUES (1, 'progress', 'Schema drafted', 0);
            INSERT INTO devices (label, token_hash, created_at, last_seen_at) VALUES ('Browser', printf('%064d', 0), 0, 0);
            INSERT INTO machine_settings (kind, label, worktree_root) VALUES ('local', '', 'D:\worktrees');
            INSERT INTO memory_entries (workspace_id, kind, title, created_at, updated_at) VALUES (NULL, 'rule', 'Reply in English', 0, 0);
        "#).unwrap();
    }

    #[test]
    fn imported_workspaces_keep_their_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other.sqlite3");
        let mut other = Storage::open(&source).unwrap();
        add_workspace(&mut other, "site", "repository".to_owned());
        other
            .create_workspace(&NewWorkspace {
                name: "notes".to_owned(),
                description: Some("Task notes".to_owned()),
                repository: Some("notes:repository".to_owned()),
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
        assert_eq!(names(server.list_workspaces().unwrap()), ["site", "notes"]);
        let notes = server
            .list_workspaces()
            .unwrap()
            .into_iter()
            .find(|workspace| workspace.name == "notes")
            .unwrap();
        assert_eq!(notes.name, "notes");
        assert_eq!(notes.repository.as_deref(), Some("notes:repository"));
    }

    #[test]
    fn imports_next_to_the_data_here_with_ids_after_every_used_one() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("desktop.sqlite3");
        desktop_database(&source);

        let mut server = Storage::open(&dir.path().join("server.sqlite3")).unwrap();
        let site = add_workspace(&mut server, "site", "repository".to_owned());
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
        assert_eq!(
            count(
                &server,
                "SELECT count(*) FROM sqlite_master WHERE name = 'machine_settings'"
            ),
            0
        );
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

    #[test]
    fn imported_history_keeps_records_and_remaps_task_ids() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("history.sqlite3");
        {
            let mut other = Storage::open(&source).unwrap();
            let workspace = add_workspace(&mut other, "History", "repository".to_owned());
            let task = add_task(&mut other, &workspace, "Recorded work");
            other.conn.execute(
                "INSERT INTO commit_records (task_id, position, sha, message, author, committed_at)
                 VALUES (?1, 0, 'recorded', 'Recorded commit', 'Ada', 120)",
                [task.0],
            ).unwrap();
            other.conn.execute(
                "INSERT INTO pull_request_snapshots (task_id, number, title, additions, deletions,
                 changed_files, review_count, reviewer_count)
                 VALUES (?1, 7, 'Historical PR', 10, 2, 3, 1, 1)",
                [task.0],
            ).unwrap();
            other.conn.execute(
                "INSERT INTO task_activity (task_id, dedup_key, kind, source, external_ref, title,
                 author, occurred_at, received_at, confirmed_at)
                 VALUES (?1, 'historical', 'commit', 'git_poll', 'polled', 'Polled commit',
                 'Grace', 150, 160, 160)",
                [task.0],
            ).unwrap();
        }
        let mut server = Storage::open_in_memory().unwrap();
        let workspace = add_workspace(&mut server, "Existing", "repository".to_owned());
        let existing = add_task(&mut server, &workspace, "Existing work");
        let summary = server.import(&stage_backup(&source).unwrap()).unwrap();
        assert_eq!(summary.task_id_offset, existing.0);
        let imported = TaskId(summary.task_id_offset + 1);
        let records = server.list_commit_records(imported).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].sha, "recorded");
        assert_eq!(
            server
                .historical_pull_request(imported)
                .unwrap()
                .unwrap()
                .title,
            "Historical PR"
        );
        let records = server
            .list_commit_records_in(crate::domain::review::Period::new(100, 200).unwrap())
            .unwrap();
        assert_eq!(records.len(), 2);
        assert!(records.iter().all(|record| record.task_id == imported));
        assert_eq!(records[1].sha, "polled");
        assert_eq!(
            count(
                &server,
                "SELECT count(*) FROM task_activity WHERE task_id = 1"
            ),
            0
        );
        assert!(server.list_commit_records(existing).unwrap().is_empty());
    }

    #[test]
    fn imported_tasks_have_no_runtime_records() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("other.sqlite3");
        {
            let mut other = Storage::open(&source).unwrap();
            let workspace = add_workspace(&mut other, "site", "repository".to_owned());
            let task = add_task(&mut other, &workspace, "Started");
            other.start_task(task, None, &[]).unwrap();
        }
        let mut server = Storage::open_in_memory().unwrap();

        server.import(&stage_backup(&source).unwrap()).unwrap();

        assert_eq!(count(&server, "SELECT count(*) FROM tasks"), 1);
        assert_eq!(
            count(
                &server,
                "SELECT count(*) FROM sqlite_master WHERE name IN ('runtime_hosts', 'runtime_host_events', 'runtime_workspaces')"
            ),
            0
        );
        let imported = server.list_tasks(WorkspaceId(1)).unwrap();
        assert_eq!(imported.len(), 1);
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
