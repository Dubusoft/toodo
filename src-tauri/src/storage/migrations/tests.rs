use rusqlite::params;

use super::*;

#[test]
fn version_24_keeps_task_data_references_search_and_the_id_counter() {
    // Given a version-23 database with references, a deleted ID and searchable data.
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..23] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 23).unwrap();
    conn.execute_batch(
        "INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', '/repo', 'main');
             INSERT INTO tasks (workspace_id, type, title, description, status, resolution,
                 branch, worktree_path, herdr_workspace_id, pull_request_url,
                 pull_request_merged_at, completion_note, issue_number, issue_url,
                 due_date, estimate_unit, estimate_amount)
                VALUES (1, 'feat', 'Original', 'Description', 'done', 'merged',
                    'feat/original-1', '/wt/original', NULL, 'https://example.com/pull/1',
                    50, 'Shipped', 7, 'https://example.com/issues/7', '2026-10-28', 'days', 2);
             INSERT INTO tasks (workspace_id, type, title, status, resolution,
                 merged_with_pull_request_url, merged_with_task_id)
                VALUES (1, 'fix', 'Included', 'done', 'merged', 'https://example.com/pull/1', 1);
             INSERT INTO tasks (workspace_id, type, title, status, branch, herdr_workspace_id)
                VALUES (1, 'chore', 'Active', 'in_progress', 'chore/active-3', 'w3');
             INSERT INTO tasks (workspace_id, type, title, status)
                VALUES (1, 'rnd', 'Deleted', 'planned');
             DELETE FROM tasks WHERE id = 4;
             INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (3, 1);
             INSERT INTO task_events (task_id, status, at) VALUES (1, 'done', 50);
             INSERT INTO commit_records (task_id, position, sha, message, author, committed_at)
                VALUES (1, 0, 'aaa', 'Original commit', 'Ada', 40);
             INSERT INTO task_notes (task_id, kind, body, at) VALUES (1, 'progress', 'Progress', 30);
             INSERT INTO task_relations (task_id, related_id) VALUES (1, 3);
             INSERT INTO task_criteria (task_id, position, text, kind, state, evidence)
                VALUES (1, 0, 'Merged', 'pr_merged', 'met', 'https://example.com/pull/1');
             INSERT INTO pull_request_snapshots (task_id, number, title, additions, deletions,
                 changed_files, review_count, reviewer_count)
                VALUES (1, 1, 'Original PR', 1, 0, 1, 0, 0);",
    )
    .unwrap();
    let tables = [
        "tasks",
        "task_dependencies",
        "task_events",
        "commit_records",
        "task_notes",
        "task_relations",
        "task_criteria",
        "pull_request_snapshots",
    ];
    // The herdr handle moves from `tasks` to the runtime workspaces (version 31).
    let rows = |conn: &Connection, table: &str| {
        let mut statement = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .unwrap();
        let columns: Vec<usize> = (0..statement.column_count())
            .filter(|&column| statement.column_name(column).unwrap() != "herdr_workspace_id")
            .collect();
        statement
            .query_map([], |row| {
                columns
                    .iter()
                    .map(|&column| row.get::<_, rusqlite::types::Value>(column))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let before = tables.map(|table| rows(&conn, table));
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    // When the resolution constraint is upgraded.
    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    // Then every field and reference survives, and new resolutions and search work.
    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    assert_eq!(tables.map(|table| rows(&conn, table)), before);
    let handle: String = conn
        .query_row(
            "SELECT provider_workspace_ref FROM runtime_workspaces
                 WHERE task_id = 3 AND state = 'open'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(handle, "w3");
    conn.execute(
        "INSERT INTO tasks (workspace_id, type, title, status, resolution, completion_note)
             VALUES (1, 'chore', 'Completed configuration', 'done', 'completed', 'Deployed')",
        [],
    )
    .unwrap();
    assert_eq!(conn.last_insert_rowid(), 5);
    for invalid in [
        "UPDATE tasks SET resolution = 'unknown' WHERE id = 5",
        "UPDATE tasks SET status = 'planned' WHERE id = 5",
        "UPDATE tasks SET merged_with_pull_request_url = 'https://example.com/pull/1' WHERE id = 5",
    ] {
        assert!(conn.execute(invalid, []).is_err(), "{invalid}");
    }
    let search = |text: &str| -> i64 {
        conn.query_row(
            "SELECT count(*) FROM task_search WHERE task_search MATCH ?1",
            [text],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(search("Original"), 1);
    assert_eq!(search("Completed"), 1);
    conn.execute("UPDATE tasks SET title = 'Renamed' WHERE id = 5", [])
        .unwrap();
    assert_eq!(search("Completed"), 0);
    assert_eq!(search("Renamed"), 1);
    conn.execute("INSERT INTO task_notes (task_id, kind, body, at) VALUES (5, 'progress', 'New evidence', 60)", []).unwrap();
    assert_eq!(search("evidence"), 1);
    conn.execute("DELETE FROM task_notes WHERE task_id = 5", [])
        .unwrap();
    assert_eq!(search("evidence"), 0);
    conn.execute(
        "UPDATE pull_request_snapshots SET title = 'Revised PR' WHERE task_id = 1",
        [],
    )
    .unwrap();
    assert_eq!(search("Revised"), 1);
    conn.execute("DELETE FROM tasks WHERE id = 5", []).unwrap();
    assert_eq!(search("Renamed"), 0);
    conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
    let linked: Option<i64> = conn
        .query_row(
            "SELECT merged_with_task_id FROM tasks WHERE id = 2",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(linked, None);
    assert_eq!(search("Original"), 0);
}

#[test]
fn version_2_keeps_tasks_their_references_and_the_id_counter() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(MIGRATIONS[0]).unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, status, pull_request_url)
                VALUES (1, 'feat', 'A', 'done', 'https://github.com/acme/toodo/pull/1'),
                       (1, 'fix', 'B', 'ready', NULL),
                       (1, 'chore', 'C', 'ready', NULL);
            INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (2, 1);
            INSERT INTO commit_records (task_id, position, sha, message, author, committed_at)
                VALUES (1, 0, 'aaa', 'Add A', 'Ada', 10);
            DELETE FROM tasks WHERE id = 3;
            ",
    )
    .unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    };
    assert_eq!(
        (
            count("tasks"),
            count("task_dependencies"),
            count("commit_records")
        ),
        (2, 1, 1)
    );
    conn.execute(
        "INSERT INTO tasks (workspace_id, type, title, status) VALUES (1, 'feat', 'D', 'in_review')",
        [],
    )
    .unwrap();
    assert_eq!(conn.last_insert_rowid(), 4);
    conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
    assert_eq!(
        (count("task_dependencies"), count("commit_records")),
        (0, 0)
    );
}

#[test]
fn version_3_adds_an_empty_history_and_no_merge_time_to_existing_tasks() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..2] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 2).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, status, pull_request_url)
                VALUES (1, 'feat', 'A', 'done', 'https://github.com/acme/toodo/pull/1');
            ",
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let merged_at: Option<i64> = conn
        .query_row(
            "SELECT pull_request_merged_at FROM tasks WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(merged_at, None);
    let events = |conn: &Connection| -> i64 {
        conn.query_row("SELECT count(*) FROM task_events", [], |row| row.get(0))
            .unwrap()
    };
    assert_eq!(events(&conn), 0);
    assert!(
        conn.execute(
            "INSERT INTO task_events (task_id, status, at) VALUES (1, 'merged', 1)",
            []
        )
        .is_err()
    );
    conn.execute(
        "INSERT INTO task_events (task_id, status, at) VALUES (1, 'done', 1)",
        [],
    )
    .unwrap();
    conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
    assert_eq!(events(&conn), 0);
}

#[test]
fn version_4_turns_ready_and_cancelled_into_planned_and_drops_readiness_events() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..3] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 3).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, status)
                VALUES (1, 'feat', 'Ready', 'ready'),
                       (1, 'feat', 'Waiting', 'planned'),
                       (1, 'feat', 'Cancelled', 'cancelled'),
                       (1, 'feat', 'Done', 'done');
            INSERT INTO task_events (task_id, status, at)
                VALUES (1, 'ready', 10), (1, 'planned', 20), (1, 'ready', 30),
                       (2, 'planned', 10), (2, 'ready', 20), (2, 'planned', 30),
                       (3, 'ready', 10), (3, 'in_progress', 20), (3, 'cancelled', 30),
                       (3, 'planned', 40), (3, 'ready', 50),
                       (4, 'ready', 10), (4, 'in_progress', 20), (4, 'in_review', 30),
                       (4, 'done', 40);
            ",
    )
    .unwrap();

    migrate(&mut conn).unwrap();

    let statuses: Vec<String> = conn
        .prepare("SELECT status FROM tasks ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(statuses, ["planned", "planned", "planned", "done"]);
    let history = |task: i64| -> Vec<(String, i64)> {
        conn.prepare("SELECT status, at FROM task_events WHERE task_id = ?1 ORDER BY id")
            .unwrap()
            .query_map([task], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let events = |raw: &[(&str, i64)]| -> Vec<(String, i64)> {
        raw.iter()
            .map(|&(status, at)| (status.to_owned(), at))
            .collect()
    };
    assert_eq!(history(1), events(&[("planned", 10)]));
    assert_eq!(history(2), events(&[("planned", 10)]));
    assert_eq!(
        history(3),
        events(&[("planned", 10), ("in_progress", 20), ("planned", 30)])
    );
    assert_eq!(
        history(4),
        events(&[
            ("planned", 10),
            ("in_progress", 20),
            ("in_review", 30),
            ("done", 40)
        ])
    );
}

#[test]
fn version_5_adds_no_note_and_no_snapshot_to_existing_tasks() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..4] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 4).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, status, pull_request_url)
                VALUES (1, 'feat', 'A', 'done', 'https://github.com/acme/toodo/pull/1');
            ",
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let note: Option<String> = conn
        .query_row(
            "SELECT completion_note FROM tasks WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(note, None);
    let snapshots = |conn: &Connection| -> i64 {
        conn.query_row("SELECT count(*) FROM pull_request_snapshots", [], |row| {
            row.get(0)
        })
        .unwrap()
    };
    assert_eq!(snapshots(&conn), 0);
    conn.execute(
        "INSERT INTO pull_request_snapshots (task_id, number, title, additions, deletions,
                 changed_files, review_count, reviewer_count)
             VALUES (1, 1, 'A', 1, 0, 1, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
    assert_eq!(snapshots(&conn), 0);
}

#[test]
fn version_7_links_no_issue_to_existing_tasks() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..6] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 6).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, status) VALUES (1, 'fix', 'A', 'planned');
            ",
    )
    .unwrap();

    migrate(&mut conn).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let issue: (Option<i64>, Option<String>) = conn
        .query_row(
            "SELECT issue_number, issue_url FROM tasks WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(issue, (None, None));
    conn.execute(
        "UPDATE tasks SET issue_number = 12, issue_url = 'https://github.com/acme/toodo/issues/12'
             WHERE id = 1",
        [],
    )
    .unwrap();
    for invalid in [
        "UPDATE tasks SET issue_url = NULL WHERE id = 1",
        "UPDATE tasks SET issue_number = NULL WHERE id = 1",
        "UPDATE tasks SET issue_number = 0 WHERE id = 1",
    ] {
        assert!(conn.execute(invalid, []).is_err(), "{invalid}");
    }
}

#[test]
fn version_8_adds_no_notes_and_drops_them_with_their_task() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..7] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 7).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, status) VALUES (1, 'fix', 'A', 'planned');
            ",
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let notes = |conn: &Connection| -> i64 {
        conn.query_row("SELECT count(*) FROM task_notes", [], |row| row.get(0))
            .unwrap()
    };
    assert_eq!(notes(&conn), 0);
    for invalid in [
        "INSERT INTO task_notes (task_id, kind, body, at) VALUES (1, 'idea', 'x', 1)",
        "INSERT INTO task_notes (task_id, kind, body, at) VALUES (1, 'progress', '', 1)",
        "INSERT INTO task_notes (task_id, kind, body, at) VALUES (9, 'progress', 'x', 1)",
    ] {
        assert!(conn.execute(invalid, []).is_err(), "{invalid}");
    }
    conn.execute(
        "INSERT INTO task_notes (task_id, kind, body, at) VALUES (1, 'blocker', 'No access', 1)",
        [],
    )
    .unwrap();
    conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
    assert_eq!(notes(&conn), 0);
}

#[test]
fn version_9_plans_nothing_for_existing_tasks_and_checks_new_plans() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..8] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 8).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, status) VALUES (1, 'fix', 'A', 'planned');
            ",
    )
    .unwrap();

    migrate(&mut conn).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let plan: (Option<String>, Option<f64>, Option<String>) = conn
        .query_row(
            "SELECT estimate_unit, estimate_amount, due_date FROM tasks WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(plan, (None, None, None));
    conn.execute(
        "UPDATE tasks SET estimate_unit = 'hours', estimate_amount = 1.5,
                 due_date = '2024-02-29' WHERE id = 1",
        [],
    )
    .unwrap();
    for invalid in [
        "UPDATE tasks SET estimate_unit = 'minutes' WHERE id = 1",
        "UPDATE tasks SET estimate_unit = NULL WHERE id = 1",
        "UPDATE tasks SET estimate_amount = NULL WHERE id = 1",
        "UPDATE tasks SET estimate_amount = 0 WHERE id = 1",
        "UPDATE tasks SET due_date = '2026-02-29' WHERE id = 1",
        "UPDATE tasks SET due_date = '2026-10-15 12:00' WHERE id = 1",
        "UPDATE tasks SET due_date = 'tomorrow' WHERE id = 1",
    ] {
        assert!(conn.execute(invalid, []).is_err(), "{invalid}");
    }
}

#[test]
fn version_10_keeps_hour_estimates_clears_points_and_allows_time_units() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..9] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 9).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, status, estimate_unit,
                    estimate_amount, due_date)
                VALUES (1, 'fix', 'A', 'planned', 'hours', 1.5, '2026-10-20'),
                       (1, 'feat', 'B', 'planned', 'points', 3, NULL),
                       (1, 'docs', 'C', 'planned', NULL, NULL, NULL);
            ",
    )
    .unwrap();

    migrate(&mut conn).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let mut statement = conn
        .prepare("SELECT estimate_unit, estimate_amount, due_date FROM tasks ORDER BY id")
        .unwrap();
    let plans: Vec<(Option<String>, Option<f64>, Option<String>)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        plans,
        [
            (
                Some("hours".to_owned()),
                Some(1.5),
                Some("2026-10-20".to_owned())
            ),
            (None, None, None),
            (None, None, None),
        ]
    );
    for unit in ["days", "weeks", "months", "hours"] {
        conn.execute("UPDATE tasks SET estimate_unit = ?1 WHERE id = 1", [unit])
            .unwrap();
    }
    for invalid in [
        "UPDATE tasks SET estimate_unit = 'points' WHERE id = 1",
        "UPDATE tasks SET estimate_unit = NULL WHERE id = 1",
        "UPDATE tasks SET estimate_amount = 0 WHERE id = 1",
        "UPDATE tasks SET estimate_unit = 'days' WHERE id = 2",
    ] {
        assert!(conn.execute(invalid, []).is_err(), "{invalid}");
    }
}

#[test]
fn version_11_indexes_existing_tasks_for_search_and_relates_none() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..10] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 10).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, description, status, resolution,
                    branch, pull_request_url, completion_note)
                VALUES (1, 'feat', 'Ship the server', 'Deploy to the home box', 'done',
                        'merged', 'feat/ship-server-1',
                        'https://github.com/acme/toodo/pull/7', 'Chose systemd'),
                       (1, 'fix', 'Other', '', 'planned', NULL, NULL, NULL, NULL);
            INSERT INTO task_notes (task_id, kind, body, at)
                VALUES (2, 'progress', 'Picked rusqlite over sqlx', 5);
            INSERT INTO pull_request_snapshots (task_id, number, title, additions, deletions,
                    changed_files, review_count, reviewer_count)
                VALUES (1, 7, 'Add toodo-server', 1, 0, 1, 0, 0);
            ",
    )
    .unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let matches = |query: &str| -> Vec<i64> {
        conn.prepare("SELECT rowid FROM task_search WHERE task_search MATCH ?1 ORDER BY rowid")
            .unwrap()
            .query_map([query], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    for (query, found) in [
        ("\"home box\"", vec![1]),
        ("systemd", vec![1]),
        ("\"toodo-server\"", vec![1]),
        ("\"pull/7\"", vec![1]),
        ("\"ship-server\"", vec![1]),
        ("rusqlite", vec![2]),
        // A substring of any word: "Ship the server" and "Other".
        ("\"the\"", vec![1, 2]),
    ] {
        assert_eq!(matches(query), found, "{query}");
    }
    let relations: i64 = conn
        .query_row("SELECT count(*) FROM task_relations", [], |row| row.get(0))
        .unwrap();
    assert_eq!(relations, 0);
    for invalid in [
        "INSERT INTO task_relations (task_id, related_id) VALUES (2, 1)",
        "INSERT INTO task_relations (task_id, related_id) VALUES (1, 1)",
        "INSERT INTO task_relations (task_id, related_id) VALUES (1, 9)",
    ] {
        assert!(conn.execute(invalid, []).is_err(), "{invalid}");
    }
}

#[test]
fn version_6_marks_done_tasks_merged_keeps_their_data_and_allows_rnd() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..5] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 5).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, status, branch, pull_request_url,
                    pull_request_merged_at, completion_note)
                VALUES (1, 'feat', 'A', 'done', 'feat/a-1',
                        'https://github.com/acme/toodo/pull/1', 40, 'Shipped'),
                       (1, 'fix', 'B', 'in_progress', 'fix/b-2', NULL, NULL, NULL),
                       (1, 'chore', 'C', 'planned', NULL, NULL, NULL, NULL);
            INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (2, 1);
            INSERT INTO task_events (task_id, status, at) VALUES (1, 'done', 40);
            INSERT INTO commit_records (task_id, position, sha, message, author, committed_at)
                VALUES (1, 0, 'aaa', 'Add A', 'Ada', 10);
            INSERT INTO pull_request_snapshots (task_id, number, title, additions, deletions,
                    changed_files, review_count, reviewer_count)
                VALUES (1, 1, 'A', 1, 0, 1, 0, 0);
            DELETE FROM tasks WHERE id = 3;
            ",
    )
    .unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    // Status, resolution, completion note, and merge time.
    type Row = (String, Option<String>, Option<String>, Option<i64>);
    let rows: Vec<Row> = conn
        .prepare(
            "SELECT status, resolution, completion_note, pull_request_merged_at
                 FROM tasks ORDER BY id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        rows,
        [
            (
                "done".to_owned(),
                Some("merged".to_owned()),
                Some("Shipped".to_owned()),
                Some(40)
            ),
            ("in_progress".to_owned(), None, None, None),
        ]
    );
    conn.execute(
        "INSERT INTO tasks (workspace_id, type, title, status) VALUES (1, 'rnd', 'D', 'planned')",
        [],
    )
    .unwrap();
    // Deleted task IDs are still never reused.
    assert_eq!(conn.last_insert_rowid(), 4);
    for invalid in [
        "UPDATE tasks SET status = 'done' WHERE id = 2",
        "UPDATE tasks SET resolution = 'merged' WHERE id = 2",
        "UPDATE tasks SET resolution = 'abandoned' WHERE id = 1",
        "UPDATE tasks SET status = 'cancelled' WHERE id = 2",
    ] {
        assert!(conn.execute(invalid, []).is_err(), "{invalid}");
    }
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    };
    assert_eq!(
        [
            "task_dependencies",
            "task_events",
            "commit_records",
            "pull_request_snapshots"
        ]
        .map(count),
        [1, 1, 1, 1]
    );
    conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
    assert_eq!(
        [
            "task_dependencies",
            "task_events",
            "commit_records",
            "pull_request_snapshots"
        ]
        .map(count),
        [0, 0, 0, 0]
    );
}

#[test]
fn version_12_lets_agents_of_existing_workspaces_never_merge() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..11] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 11).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            ",
    )
    .unwrap();

    migrate(&mut conn).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let agent_merge = |conn: &Connection| -> String {
        conn.query_row(
            "SELECT agent_merge FROM workspaces WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(agent_merge(&conn), "never");
    assert!(
        conn.execute("UPDATE workspaces SET agent_merge = 'always'", [])
            .is_err()
    );
    conn.execute("UPDATE workspaces SET agent_merge = 'after_checks'", [])
        .unwrap();
    assert_eq!(agent_merge(&conn), "after_checks");
}

#[test]
fn version_13_keeps_tasks_and_links_only_merged_ones_to_another_pull_request() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..12] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 12).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, description, status, resolution,
                    pull_request_url)
                VALUES (1, 'fix', 'Batch', '', 'done', 'merged',
                    'https://github.com/acme/toodo/pull/1'),
                (1, 'fix', 'Extra', '', 'done', 'not_adopted', NULL);
            ",
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let merged_with = |conn: &Connection| -> (Option<String>, Option<i64>) {
        conn.query_row(
            "SELECT merged_with_pull_request_url, merged_with_task_id FROM tasks WHERE id = 2",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    };
    assert_eq!(merged_with(&conn), (None, None));
    for invalid in [
        // Work that was not adopted did not ship with a pull request.
        "UPDATE tasks SET merged_with_pull_request_url = 'https://github.com/acme/toodo/pull/1'
             WHERE id = 2",
        // A task without a pull request URL is allowed since version 25.
        "UPDATE tasks SET resolution = 'not_adopted', merged_with_task_id = 1 WHERE id = 2",
        "UPDATE tasks SET resolution = 'merged', merged_with_pull_request_url = 'x',
                merged_with_task_id = 9 WHERE id = 2",
    ] {
        assert!(conn.execute(invalid, []).is_err(), "{invalid}");
    }
    conn.execute(
        "UPDATE tasks SET resolution = 'merged',
                 merged_with_pull_request_url = 'https://github.com/acme/toodo/pull/1',
                 merged_with_task_id = 1
             WHERE id = 2",
        [],
    )
    .unwrap();
    // Deleting the task that owns the pull request keeps the link to the pull request.
    conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
    assert_eq!(
        merged_with(&conn),
        (
            Some("https://github.com/acme/toodo/pull/1".to_owned()),
            None
        )
    );
}

#[test]
fn version_16_turns_done_when_items_into_criteria_after_the_pull_request() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..15] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 15).unwrap();
    conn.execute_batch(
        r"
            INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', 'C:\dev\toodo', 'main');
            INSERT INTO tasks (workspace_id, type, title, description, status, resolution,
                    pull_request_url)
                VALUES (1, 'feat', 'Open', '## Purpose
- [ ] not this

## Done when
- [ ] Tests pass
- [x] Docs updated
', 'in_progress', NULL, NULL),
                (1, 'fix', 'Shipped', 'No sections', 'done', 'merged',
                    'https://github.com/acme/toodo/pull/7'),
                (1, 'rnd', 'Dropped', '', 'done', 'not_adopted', NULL);
            INSERT INTO task_events (task_id, status, at) VALUES (2, 'done', 50);
            ",
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    type Row = (String, String, String, Option<String>, Option<i64>);
    let criteria = |task: i64| -> Vec<Row> {
        let mut statement = conn
            .prepare(
                "SELECT text, kind, state, evidence, checked_at FROM task_criteria
                     WHERE task_id = ?1 ORDER BY position",
            )
            .unwrap();
        statement
            .query_map([task], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let merged = "Pull request merged into the base branch".to_owned();
    assert_eq!(
        criteria(1),
        vec![
            (
                merged.clone(),
                "pr_merged".into(),
                "pending".into(),
                None,
                None
            ),
            (
                "Tests pass".into(),
                "manual".into(),
                "pending".into(),
                None,
                None
            ),
            (
                "Docs updated".into(),
                "manual".into(),
                "met".into(),
                Some("Checked in the task description".into()),
                None
            ),
        ]
    );
    assert_eq!(
        criteria(2),
        vec![(
            merged.clone(),
            "pr_merged".into(),
            "met".into(),
            Some("https://github.com/acme/toodo/pull/7".into()),
            Some(50)
        )]
    );
    assert_eq!(
        criteria(3),
        vec![(merged, "pr_merged".into(), "pending".into(), None, None)]
    );
    for invalid in [
        "INSERT INTO task_criteria (task_id, position, text, kind) VALUES (1, 9, 'x', 'url')",
        "INSERT INTO task_criteria (task_id, position, text, kind, target)
                 VALUES (1, 9, 'x', 'manual', 'y')",
        "INSERT INTO task_criteria (task_id, position, text, kind) VALUES (1, 9, ' ', 'manual')",
    ] {
        assert!(conn.execute(invalid, []).is_err(), "{invalid}");
    }
    conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
    assert!(criteria(1).is_empty());
}

#[test]
fn version_36_keeps_subscriptions_without_a_failure() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..35] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 35).unwrap();
    conn.execute(
        "INSERT INTO devices (label, token_hash, created_at, last_seen_at)
             VALUES ('Phone', ?1, 1, 1)",
        ["0".repeat(64)],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at)
             VALUES (1, 'https://push.example/1', ?1, ?2, 2)",
        params![vec![4u8; 65], vec![1u8; 16]],
    )
    .unwrap();

    migrate(&mut conn).unwrap();

    let row: (String, Option<String>, Option<i64>) = conn
        .query_row(
            "SELECT endpoint, last_failure, last_failure_at FROM push_subscriptions",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, ("https://push.example/1".to_owned(), None, None));
}

#[test]
fn version_37_keeps_earlier_device_tokens_working_with_full_access_for_90_days() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..36] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 36).unwrap();
    conn.execute(
        "INSERT INTO devices (label, token_hash, created_at, last_seen_at, revoked_at)
             VALUES ('Phone', ?1, 1, 1, NULL), ('Old', ?2, 1, 1, 5)",
        ["0".repeat(64), "1".repeat(64)],
    )
    .unwrap();
    let before: i64 = conn
        .query_row("SELECT CAST(strftime('%s', 'now') AS INTEGER)", [], |row| {
            row.get(0)
        })
        .unwrap();

    migrate(&mut conn).unwrap();

    let rows: Vec<(String, String, Option<i64>)> = conn
        .prepare("SELECT label, scope, expires_at FROM devices ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let ninety_days = 90 * 86_400;
    let (_, scope, expires_at) = &rows[0];
    assert_eq!(scope, "full");
    let expires_at = expires_at.unwrap();
    assert!(
        (before + ninety_days..before + ninety_days + 60).contains(&expires_at),
        "{expires_at}"
    );
    assert_eq!(rows[1], ("Old".to_owned(), "full".to_owned(), None));
    assert!(
        conn.execute("UPDATE devices SET scope = 'admin' WHERE id = 1", [])
            .is_err()
    );
}

#[test]
fn version_17_keeps_devices_without_subscriptions_and_drops_them_with_the_device() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..16] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 16).unwrap();
    conn.execute(
        "INSERT INTO devices (label, token_hash, created_at, last_seen_at)
             VALUES ('Phone', ?1, 1, 1)",
        ["0".repeat(64)],
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let count = |conn: &Connection| -> i64 {
        conn.query_row("SELECT count(*) FROM push_subscriptions", [], |row| {
            row.get(0)
        })
        .unwrap()
    };
    assert_eq!(count(&conn), 0);
    let insert = |endpoint: &str, p256dh: usize, auth: usize| {
        conn.execute(
            "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at)
                 VALUES (1, ?1, ?2, ?3, 2)",
            params![endpoint, vec![4u8; p256dh], vec![1u8; auth]],
        )
    };
    assert!(insert("http://push.example/1", 65, 16).is_err());
    assert!(insert("https://push.example/1", 64, 16).is_err());
    assert!(insert("https://push.example/1", 65, 15).is_err());
    insert("https://push.example/1", 65, 16).unwrap();
    let settings: (i64, i64, i64) = conn
        .query_row(
            "SELECT agent, pull_requests, completion FROM push_subscriptions",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(settings, (1, 1, 1));
    conn.execute("DELETE FROM devices WHERE id = 1", [])
        .unwrap();
    assert_eq!(count(&conn), 0);
}

#[test]
fn version_18_starts_an_empty_chat_that_keeps_one_message_per_client_id() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..17] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 17).unwrap();

    migrate(&mut conn).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let insert = |author: &str, body: &str, client_id: Option<&str>| {
        conn.execute(
            "INSERT INTO chat_messages (author, body, client_id, at) VALUES (?1, ?2, ?3, 1)",
            params![author, body, client_id],
        )
    };
    assert!(insert("user", "Hi", Some("c1")).is_ok());
    assert!(insert("user", "Hi", Some("c1")).is_err());
    assert!(insert("lead", "Hello", None).is_ok());
    assert!(insert("lead", "Hello", Some("c2")).is_err());
    assert!(insert("user", " ", None).is_err());
    assert!(insert("dori", "Hi", None).is_err());
}

#[test]
fn version_19_counts_earlier_messages_delivered_and_answered_ones_seen() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..18] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 18).unwrap();
    for (author, at) in [("user", 10), ("lead", 20), ("user", 30)] {
        conn.execute(
            "INSERT INTO chat_messages (author, body, at) VALUES (?1, 'Hi', ?2)",
            params![author, at],
        )
        .unwrap();
    }

    migrate(&mut conn).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let rows: Vec<(Option<i64>, Option<i64>)> = conn
        .prepare("SELECT delivered_at, seen_at FROM chat_messages ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(rows, [(Some(10), Some(10)), (None, None), (Some(30), None)]);
    let set = |sql: &str| conn.execute(sql, []);
    assert!(set("UPDATE chat_messages SET delivered_at = 1 WHERE author = 'lead'").is_err());
    assert!(set("UPDATE chat_messages SET delivered_at = NULL WHERE id = 1").is_err());
}

#[test]
fn version_20_counts_earlier_messages_and_events_taken_by_the_lead() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..19] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 19).unwrap();
    conn.execute_batch(
        "INSERT INTO chat_messages (author, body, at, delivered_at) VALUES ('user', 'Hi', 10, 10);
             INSERT INTO chat_messages (author, body, at) VALUES ('lead', 'Hello', 20);
             INSERT INTO workspaces (name, kind, path, default_base_branch)
                 VALUES ('w', 'local', '/w', 'main');
             INSERT INTO tasks (workspace_id, type, title, status) VALUES (1, 'feat', 't', 'planned');
             INSERT INTO task_events (task_id, status, at) VALUES (1, 'planned', 5);",
    )
    .unwrap();

    migrate(&mut conn).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let taken: Vec<Option<i64>> = conn
        .prepare("SELECT taken_at FROM chat_messages ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(taken, [Some(10), None]);
    let event: (i64, Option<i64>) = conn
        .query_row("SELECT for_lead, taken_at FROM task_events", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();
    assert_eq!(event, (0, None));
    let set = |sql: &str| conn.execute(sql, []);
    assert!(set("UPDATE chat_messages SET taken_at = 1 WHERE author = 'lead'").is_err());
    assert!(set("UPDATE task_events SET taken_at = 1").is_err());
    set("UPDATE task_events SET request_id = 'r1'").unwrap();
    let again = "INSERT INTO task_events (task_id, status, at, request_id)
                     VALUES (1, 'in_progress', 6, 'r1')";
    assert!(set(again).is_err());
}

#[test]
fn version_21_keeps_the_chat_and_lets_only_the_system_report_a_finish_once() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..20] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 20).unwrap();
    conn.execute_batch(
        "INSERT INTO chat_messages (author, body, client_id, at, delivered_at, seen_at, taken_at)
                 VALUES ('user', 'Hi', 'c1', 10, 10, 11, 11);
             INSERT INTO chat_messages (author, body, at) VALUES ('lead', 'Hello', 20);
             INSERT INTO workspaces (name, kind, path, default_base_branch)
                 VALUES ('w', 'local', '/w', 'main');
             INSERT INTO tasks (workspace_id, type, title, status) VALUES (1, 'feat', 't', 'planned');",
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    type Kept = (i64, String, Option<String>, Option<i64>, Option<i64>);
    let kept: Vec<Kept> = conn
        .prepare("SELECT id, author, client_id, seen_at, taken_at FROM chat_messages ORDER BY id")
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        kept,
        [
            (1, "user".into(), Some("c1".into()), Some(11), Some(11)),
            (2, "lead".into(), None, None, None)
        ]
    );
    let set = |sql: &str| conn.execute(sql, []);
    assert!(set("INSERT INTO task_results (task_id, kind, at) VALUES (1, 'shipped', 1)").is_err());
    set("INSERT INTO task_results (task_id, kind, at) VALUES (1, 'merged', 1)").unwrap();
    let report = "INSERT INTO chat_messages (author, body, at, result_id)";
    assert!(set(&format!("{report} VALUES ('lead', 'x', 1, 1)")).is_err());
    set(&format!("{report} VALUES ('system', 'Merged', 1, 1)")).unwrap();
    assert!(set(&format!("{report} VALUES ('system', 'Again', 1, 1)")).is_err());
    assert!(set("INSERT INTO chat_messages (author, body, at) VALUES ('user', 'x', 1)").is_ok());
    let id: i64 = conn
        .query_row("SELECT max(id) FROM chat_messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(id, 4, "IDs go on after the copied messages");
    assert!(set("UPDATE chat_messages SET client_id = 'c1' WHERE id = 4").is_err());
    // Deleting the task keeps its report in the chat.
    set("DELETE FROM tasks").unwrap();
    let orphan: Option<i64> = conn
        .query_row(
            "SELECT result_id FROM chat_messages WHERE id = 3",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(orphan, None);
}

#[test]
fn version_22_links_earlier_reports_and_never_counts_earlier_messages_handled() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..21] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 21).unwrap();
    conn.execute_batch(
        "INSERT INTO chat_messages (author, body, at, delivered_at, seen_at, taken_at)
                 VALUES ('user', 'Hi', 10, 10, 11, 11);
             INSERT INTO workspaces (name, kind, path, default_base_branch)
                 VALUES ('w', 'local', '/w', 'main');
             INSERT INTO tasks (workspace_id, type, title, status, resolution)
                 VALUES (1, 'feat', 't', 'done', 'merged');
             INSERT INTO task_events (task_id, status, at) VALUES (1, 'in_review', 30);
             INSERT INTO task_events (task_id, status, at, for_lead) VALUES (1, 'done', 40, 1);
             INSERT INTO task_results (task_id, kind, at) VALUES (1, 'merged', 40);
             INSERT INTO chat_messages (author, body, at, result_id)
                 VALUES ('system', 'Merged', 40, 1);",
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let receipts: (Option<i64>, Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT due_at, acked_at, handled_at FROM chat_messages WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(receipts, (None, None, None));
    let reports: Vec<Option<i64>> = conn
        .prepare("SELECT report_id FROM task_events ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(reports, [None, Some(2)]);
    let set = |sql: &str| conn.execute(sql, []);
    assert!(set("UPDATE task_events SET report_id = 2 WHERE status = 'in_review'").is_err());
    assert!(set("UPDATE chat_messages SET acked_at = 1 WHERE author = 'system'").is_err());
    assert!(set("UPDATE chat_messages SET handled_at = 1 WHERE id = 1").is_err());
    assert!(set("UPDATE chat_messages SET handled_task_id = 1 WHERE id = 1").is_err());
    set(
        "UPDATE chat_messages SET acked_at = 50, handled_at = 51, handled_task_id = 1 WHERE id = 1",
    )
    .unwrap();
    // Deleting the task keeps the receipt without its link.
    set("DELETE FROM tasks").unwrap();
    let kept: (Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT handled_at, handled_task_id FROM chat_messages WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(kept, (Some(51), None));
}

#[test]
fn version_23_keeps_one_message_per_origin_and_only_of_people_and_the_lead() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..22] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 22).unwrap();
    conn.execute_batch("INSERT INTO chat_messages (author, body, at) VALUES ('user', 'Hi', 10)")
        .unwrap();

    migrate(&mut conn).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let origin: Option<String> = conn
        .query_row("SELECT origin FROM chat_messages WHERE id = 1", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(origin, None);
    let add = |author: &str, origin: Option<&str>, id: Option<&str>| {
        conn.execute(
            "INSERT INTO chat_messages (author, body, at, origin, origin_id)
                 VALUES (?1, 'x', 20, ?2, ?3)",
            params![author, origin, id],
        )
    };
    add("user", Some("matrix"), Some("m1")).unwrap();
    add("lead", Some("irc"), Some("m1")).unwrap();
    assert!(
        add("lead", Some("matrix"), Some("m1")).is_err(),
        "one per origin"
    );
    assert!(add("system", Some("matrix"), Some("m2")).is_err());
    assert!(add("user", Some("matrix"), None).is_err());
    assert!(add("user", None, Some("m3")).is_err());
    add("user", None, None).unwrap();
}

#[test]
fn version_25_lets_a_task_ship_through_another_task_without_a_pull_request_url() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..24] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 24).unwrap();
    conn.execute_batch(
        "INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', '/repo', 'main');
             INSERT INTO tasks (workspace_id, type, title, status, resolution, pull_request_url)
                VALUES (1, 'feat', 'Shipped', 'done', 'merged', 'https://example.com/pull/1');
             INSERT INTO tasks (workspace_id, type, title, status, resolution,
                 merged_with_pull_request_url, merged_with_task_id)
                VALUES (1, 'fix', 'Included', 'done', 'merged', 'https://example.com/pull/1', 1);
             INSERT INTO tasks (workspace_id, type, title, status) VALUES (1, 'rnd', 'Next', 'planned');",
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let kept: (Option<String>, Option<i64>) = conn
        .query_row(
            "SELECT merged_with_pull_request_url, merged_with_task_id FROM tasks WHERE id = 2",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(kept, (Some("https://example.com/pull/1".into()), Some(1)));
    let set = |sql: &str| conn.execute(sql, []);
    set("UPDATE tasks SET status = 'done', resolution = 'completed', merged_with_task_id = 1 WHERE id = 3")
        .unwrap();
    set("UPDATE tasks SET resolution = 'merged' WHERE id = 3").unwrap();
    assert!(set("UPDATE tasks SET resolution = 'not_adopted' WHERE id = 3").is_err());
    assert!(
        set("UPDATE tasks SET resolution = 'completed', merged_with_pull_request_url = 'https://example.com/pull/1' WHERE id = 3")
            .is_err()
    );
    set("UPDATE tasks SET title = 'Renamed' WHERE id = 3").unwrap();
    let found: i64 = conn
        .query_row(
            "SELECT count(*) FROM task_search WHERE task_search MATCH 'Renamed'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(found, 1);
}

#[test]
fn version_27_infers_workspace_axes_from_their_tasks() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..26] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 26).unwrap();
    conn.execute_batch(
        "INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('local', 'local', '/local', 'main'),
                       ('criterion', 'local', '/criterion', 'main'),
                       ('url', 'local', '/url', 'main'),
                       ('nothing', 'local', '/nothing', 'main');
             INSERT INTO tasks (workspace_id, type, title, status)
                VALUES (1, 'feat', 'Merge locally', 'planned'),
                       (2, 'feat', 'Open a pull request', 'planned'),
                       (3, 'feat', 'Reviewed', 'in_review'),
                       (4, 'feat', 'By hand', 'planned');
             UPDATE tasks SET pull_request_url = 'https://github.com/a/b/pull/1' WHERE id = 3;
             INSERT INTO task_criteria (task_id, position, text, kind)
                VALUES (1, 0, 'Merged', 'branch_merged_locally'),
                       (2, 0, 'Checks pass', 'pr_open_ci_green'),
                       (4, 0, 'Looks right', 'manual');",
    )
    .unwrap();

    migrate(&mut conn).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let mut statement = conn
        .prepare("SELECT source, completion, runner, axes_detected FROM workspaces ORDER BY id")
        .unwrap();
    let axes: Vec<(String, String, String, i64)> = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let row = |source: &str, completion: &str, detected| {
        (
            source.to_owned(),
            completion.to_owned(),
            "herdr".to_owned(),
            detected,
        )
    };
    assert_eq!(
        axes,
        [
            row("local_git", "local_merge", 1),
            row("github", "pr_merge", 1),
            row("github", "pr_merge", 1),
            row("github", "pr_merge", 0),
        ]
    );
    assert!(
        conn.execute("UPDATE workspaces SET source = 'svn' WHERE id = 1", [])
            .is_err()
    );
}

#[test]
fn version_26_drops_project_memory_and_keeps_workspaces_and_tasks() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..25] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 25).unwrap();
    conn.execute_batch(
        "INSERT INTO workspaces (name, kind, path, default_base_branch)
                VALUES ('toodo', 'local', '/repo', 'main');
             INSERT INTO tasks (workspace_id, type, title, status) VALUES (1, 'feat', 'Plan', 'planned');
             INSERT INTO memory_entries (workspace_id, kind, title, task_id, created_at, updated_at)
                VALUES (NULL, 'rule', 'Reply in English', NULL, 1, 1);
             INSERT INTO memory_entries (workspace_id, kind, title, task_id, created_at, updated_at)
                VALUES (1, 'decision', 'Use SQLite in WAL mode', 1, 2, 2);
             INSERT INTO memory_entries
                 (workspace_id, kind, title, task_id, created_at, updated_at, superseded_by)
                VALUES (1, 'decision', 'Use SQLite', 1, 1, 2, 2);",
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let memory: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name LIKE 'memory_entries%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(memory, 0);
    let kept: (i64, i64) = conn
        .query_row(
            "SELECT (SELECT count(*) FROM workspaces), (SELECT count(*) FROM tasks)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(kept, (1, 1));
}

#[test]
fn version_29_opens_one_runtime_workspace_per_herdr_handle_and_creates_no_runs() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..28] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 28).unwrap();
    conn.execute_batch(
        "INSERT INTO workspaces (name, kind, path, herdr_machine, default_base_branch)
                VALUES ('remote', 'ssh', '/srv/repo', 'devbox', 'main');
             INSERT INTO tasks (workspace_id, type, title, status, branch, worktree_path,
                 herdr_workspace_id)
                VALUES (1, 'feat', 'Open', 'in_progress', 'feat/open-1', '/wt/open-1', 'w1'),
                       (1, 'feat', 'Closed', 'planned', NULL, NULL, NULL);",
    )
    .unwrap();

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let mut statement = conn
        .prepare(
            "SELECT task_id, owner_key, host_ref, runner_kind, provider_instance,
                     provider_workspace_ref, checkout_path, branch, generation
                 FROM runtime_workspaces WHERE state = 'open'",
        )
        .unwrap();
    type Row = (
        i64,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        i64,
    );
    let open: Vec<Row> = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        open,
        [(
            1,
            "implicit".to_owned(),
            "ssh:devbox".to_owned(),
            "herdr".to_owned(),
            None,
            "w1".to_owned(),
            Some("/wt/open-1".to_owned()),
            Some("feat/open-1".to_owned()),
            1,
        )]
    );
    let counts: (i64, i64) = conn
        .query_row(
            "SELECT (SELECT count(*) FROM runtime_workspaces), (SELECT count(*) FROM task_runs)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(counts, (1, 0));
    assert!(
        conn.execute("UPDATE runtime_workspaces SET state = 'paused'", [])
            .is_err()
    );
    assert!(
        conn.execute(
            "INSERT INTO task_runs (task_id, request_key, generation, runner_kind, role,
                     host_ref, state, created_at)
                 VALUES (1, 'k', 1, 'herdr', 'writer', 'local', 'lost', 1)",
            [],
        )
        .is_err()
    );
    conn.execute(
        "INSERT INTO task_runs (task_id, request_key, generation, runner_kind, role,
                 host_ref, state, created_at)
             VALUES (1, 'k', 1, 'herdr', 'writer', 'local', 'reserved', 1)",
        [],
    )
    .unwrap();
    assert!(
        conn.execute(
            "INSERT INTO run_operations (run_id, request_key, kind, state, created_at,
                     updated_at)
                 VALUES (1, 'k', 'launch', 'done', 1, 1)",
            [],
        )
        .is_err()
    );
}

#[test]
fn version_31_keeps_herdr_handles_in_runtime_workspaces_and_drops_the_task_column() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..30] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 30).unwrap();
    // Tasks 1 to 3 got their open rows from the shadow triggers; the rows of tasks 3
    // to 5 were then changed behind them, so they disagree with the handles on `tasks`.
    conn.execute_batch(
        "INSERT INTO workspaces (name, kind, path, herdr_machine, default_base_branch)
                VALUES ('remote', 'ssh', '/srv/repo', 'devbox', 'main');
             INSERT INTO tasks (workspace_id, type, title, status, branch, worktree_path,
                 herdr_workspace_id)
                VALUES (1, 'feat', 'Open', 'in_progress', 'feat/open-1', '/wt/open-1', 'w1'),
                       (1, 'feat', 'Lost row', 'in_progress', 'feat/lost-2', '/wt/lost-2', 'w2'),
                       (1, 'feat', 'Other ref', 'in_progress', 'feat/other-3', '/wt/other-3', 'w3'),
                       (1, 'feat', 'Paused', 'planned', 'feat/paused-4', '/wt/paused-4', NULL),
                       (1, 'feat', 'Moved', 'in_progress', 'feat/moved-5', '/wt/moved-5', 'w5');
             DELETE FROM runtime_workspaces WHERE task_id = 2;
             UPDATE runtime_workspaces SET provider_workspace_ref = 'w-old' WHERE task_id = 3;
             INSERT INTO runtime_workspaces (task_id, host_ref, runner_kind,
                 provider_workspace_ref, checkout_path, branch, generation, state, opened_at)
                VALUES (4, 'ssh:devbox', 'herdr', 'w4', '/wt/paused-4', 'feat/paused-4', 1,
                    'open', 1);
             UPDATE runtime_workspaces SET checkout_path = '/elsewhere' WHERE task_id = 5;",
    )
    .unwrap();

    migrate(&mut conn).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let handle_column: i64 = conn
        .query_row(
            "SELECT count(*) FROM pragma_table_info('tasks')
                 WHERE name = 'herdr_workspace_id'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(handle_column, 0);
    let triggers: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master
                 WHERE type = 'trigger' AND name LIKE 'runtime_workspaces%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(triggers, 0);
    type Row = (
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        i64,
        String,
    );
    let rows: Vec<Row> = conn
        .prepare(
            "SELECT task_id, provider_workspace_ref, host_ref, checkout_path, branch,
                     generation, state
                 FROM runtime_workspaces ORDER BY task_id, generation",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let row = |task, reference: &str, path: &str, branch: &str, generation, state: &str| {
        (
            task,
            reference.to_owned(),
            "ssh:devbox".to_owned(),
            Some(path.to_owned()),
            Some(branch.to_owned()),
            generation,
            state.to_owned(),
        )
    };
    assert_eq!(
        rows,
        [
            row(1, "w1", "/wt/open-1", "feat/open-1", 1, "open"),
            row(2, "w2", "/wt/lost-2", "feat/lost-2", 1, "open"),
            row(3, "w-old", "/wt/other-3", "feat/other-3", 1, "closed"),
            row(3, "w3", "/wt/other-3", "feat/other-3", 2, "open"),
            row(4, "w4", "/wt/paused-4", "feat/paused-4", 1, "closed"),
            row(5, "w5", "/wt/moved-5", "feat/moved-5", 1, "open"),
        ]
    );
    let kept: Vec<(Option<String>, Option<String>)> = conn
        .prepare("SELECT branch, worktree_path FROM tasks ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        kept[3],
        (
            Some("feat/paused-4".to_owned()),
            Some("/wt/paused-4".to_owned())
        )
    );
    assert_eq!(kept.len(), 5);
}

#[test]
fn version_34_preserves_runtime_rows_indexes_and_triggers_and_allows_tmux() {
    fn rows(conn: &Connection, sql: &str) -> Vec<Vec<rusqlite::types::Value>> {
        let mut stmt = conn.prepare(sql).unwrap();
        let columns = stmt.column_count();
        stmt.query_map([], |row| {
            (0..columns).map(|column| row.get(column)).collect()
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    }
    let conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..33] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 33).unwrap();
    conn.execute_batch(
        "INSERT INTO workspaces (name, kind, path, default_base_branch, runner)
                 VALUES ('old', 'local', '/repo', 'main', 'plain'),
                        ('deleted', 'local', '/gone', 'main', 'herdr');
             DELETE FROM workspaces WHERE id = 2;
             INSERT INTO tasks (workspace_id, type, title, status, branch, worktree_path)
                 VALUES (1, 'feat', 'Preserved', 'in_progress', 'feat/old', '/repo/wt');
             INSERT INTO runtime_workspaces (task_id, host_ref, runner_kind,
                 provider_instance, provider_workspace_ref, checkout_path, branch,
                 generation, state, opened_at)
                 VALUES (1, 'local', 'herdr', 'server', 'workspace', '/repo/wt',
                     'feat/old', 1, 'open', 10);
             INSERT INTO agent_conversations (task_id, agent_kind, host_ref, cwd,
                 resume_kind, resume_ref, created_at)
                 VALUES (1, 'claude', 'local', '/repo/wt', 'exact_id', 'session', 10);
             INSERT INTO task_runs (task_id, runtime_workspace_id, conversation_id,
                 request_key, generation, runner_kind, role, host_ref, checkout_path,
                 state, provider_run_ref, created_at, started_at)
                 VALUES (1, 1, 1, 'old', 1, 'plain', 'writer', 'local', '/repo/wt',
                     'running', 'pid:1', 10, 11);
             INSERT INTO run_events VALUES (1, 1, 1, 'started', 'payload', 11);
             INSERT INTO run_operations (run_id, request_key, kind, state, receipt,
                 created_at, updated_at)
                 VALUES (1, 'old', 'launch', 'applied', 'receipt', 10, 11);",
    )
    .unwrap();
    let queries = [
        "SELECT * FROM workspaces",
        "SELECT * FROM tasks",
        "SELECT * FROM runtime_workspaces",
        "SELECT * FROM agent_conversations",
        "SELECT * FROM task_runs",
        "SELECT * FROM run_events",
        "SELECT * FROM run_operations",
        "SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name",
    ];
    let before: Vec<_> = queries.iter().map(|sql| rows(&conn, sql)).collect();
    // Only version 34 itself, as `migrate` runs it: later versions add columns and indexes
    // of their own.
    conn.pragma_update(None, "foreign_keys", false).unwrap();
    conn.execute_batch(MIGRATIONS[33]).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    for (sql, expected) in queries.iter().zip(before) {
        assert_eq!(rows(&conn, sql), expected, "{sql}");
    }
    conn.execute_batch(
        "INSERT INTO workspaces (name, kind, path, default_base_branch, runner)
                 VALUES ('tmux', 'local', '/tmux', 'main', 'tmux');
             INSERT INTO tasks (workspace_id, type, title, status)
                 VALUES (3, 'feat', 'Tmux', 'planned');
             INSERT INTO runtime_workspaces (task_id, host_ref, runner_kind,
                 provider_workspace_ref, generation, state, opened_at)
                 VALUES (2, 'local', 'tmux', 'toodo-run-2', 1, 'open', 20);
             INSERT INTO task_runs (task_id, runtime_workspace_id, request_key,
                 generation, runner_kind, role, host_ref, state, created_at)
                 VALUES (2, 2, 'tmux', 1, 'tmux', 'writer', 'local', 'reserved', 20);",
    )
    .unwrap();
    assert_eq!(
        rows(&conn, "SELECT runner FROM workspaces WHERE id = 3"),
        vec![vec![rusqlite::types::Value::Text("tmux".into())]]
    );
    assert!(
        conn.execute("UPDATE task_runs SET runner_kind = 'invalid'", [])
            .is_err()
    );
    assert!(
        conn.execute("UPDATE runtime_workspaces SET runner_kind = 'invalid'", [])
            .is_err()
    );
    assert!(
        conn.execute(
            "INSERT INTO task_runs (task_id, request_key, generation, runner_kind, role,
             host_ref, checkout_path, state, created_at)
             VALUES (1, 'conflict', 2, 'tmux', 'writer', 'local', '/repo/wt', 'running', 30)",
            [],
        )
        .is_err(),
        "the active writer index still rejects a second writer"
    );
    assert!(rows(&conn, "PRAGMA foreign_key_check").is_empty());
}

#[test]
fn version_38_keeps_runs_without_activity_and_drops_transitions_with_their_task() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..37] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 37).unwrap();
    conn.execute_batch(
        "INSERT INTO workspaces (name, kind, path, default_base_branch, runner)
             VALUES ('old', 'local', '/repo', 'main', 'plain');
         INSERT INTO tasks (workspace_id, type, title, status)
             VALUES (1, 'feat', 'Ran', 'in_progress');
         INSERT INTO task_runs (task_id, request_key, generation, runner_kind, role,
             host_ref, state, created_at)
             VALUES (1, 'old', 1, 'plain', 'writer', 'local', 'settled', 10);",
    )
    .unwrap();
    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    let activity: (Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT last_activity_at, output_tokens FROM task_runs WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(activity, (None, None));
    conn.execute_batch(
        "INSERT INTO agent_status_transitions (task_id, status, at) VALUES (1, 'working', 20);
         INSERT INTO agent_status_transitions (task_id, status, at) VALUES (1, NULL, 30);",
    )
    .unwrap();
    assert!(
        conn.execute(
            "INSERT INTO agent_status_transitions (task_id, status, at) VALUES (1, 'busy', 40)",
            [],
        )
        .is_err()
    );
    conn.execute("DELETE FROM tasks WHERE id = 1", []).unwrap();
    let left: i64 = conn
        .query_row("SELECT count(*) FROM agent_status_transitions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(left, 0);
}

#[test]
fn version_33_keeps_workspaces_their_tasks_and_the_id_counter_and_allows_runner_plain() {
    // Given a version-32 database with a deleted workspace and one with a task.
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..32] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 32).unwrap();
    conn.execute_batch(
        "INSERT INTO workspaces (name, kind, path, herdr_machine, default_base_branch,
                 agent_merge, source, completion, runner, axes_detected)
                VALUES ('gone', 'local', '/gone', NULL, 'main', 'never', 'github',
                    'pr_merge', 'herdr', 1),
                       ('remote', 'ssh', '/srv/repo', 'devbox', 'dev', 'after_checks',
                    'local_git', 'local_merge', 'herdr', 0);
             DELETE FROM workspaces WHERE id = 1;
             INSERT INTO tasks (workspace_id, type, title, status, branch, worktree_path)
                VALUES (2, 'feat', 'Open', 'in_progress', 'feat/open-1', '/wt/open-1');",
    )
    .unwrap();
    assert!(
        conn.execute(
            "INSERT INTO workspaces (name, kind, path, default_base_branch, runner)
                    VALUES ('plain', 'local', '/plain', 'main', 'plain')",
            [],
        )
        .is_err()
    );

    migrate(&mut conn).unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();

    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    let kept: (
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        String,
        String,
        i64,
    ) = conn
        .query_row(
            "SELECT name, kind, herdr_machine, default_base_branch, agent_merge, source,
                        completion, runner, axes_detected
                 FROM workspaces WHERE id = 2",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        kept,
        (
            "remote".to_owned(),
            "ssh".to_owned(),
            Some("devbox".to_owned()),
            "dev".to_owned(),
            "after_checks".to_owned(),
            "local_git".to_owned(),
            "local_merge".to_owned(),
            "herdr".to_owned(),
            0
        )
    );
    conn.execute(
        "INSERT INTO workspaces (name, kind, path, default_base_branch, runner)
                VALUES ('plain', 'local', '/plain', 'main', 'plain')",
        [],
    )
    .unwrap();
    assert_eq!(conn.last_insert_rowid(), 3, "deleted IDs are never reused");
    assert!(
        conn.execute("UPDATE workspaces SET runner = 'invalid' WHERE id = 3", [])
            .is_err()
    );
    // The task still belongs to its workspace and goes with it.
    conn.execute("DELETE FROM workspaces WHERE id = 2", [])
        .unwrap();
    let tasks: i64 = conn
        .query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(tasks, 0);
}
