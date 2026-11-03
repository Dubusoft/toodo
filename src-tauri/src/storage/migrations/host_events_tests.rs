use super::*;

#[test]
fn version_32_adds_host_journal_constraints_and_cursor_defaults() {
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..31] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 31).unwrap();
    migrate(&mut conn).unwrap();
    assert_eq!(schema_version(&conn).unwrap(), LATEST_VERSION);
    conn.execute(
        "INSERT INTO runtime_hosts (host_ref, updated_at) VALUES ('local', 'now')",
        [],
    )
    .unwrap();
    let defaults: (String, i64, Option<i64>, String) = conn
        .query_row(
            "SELECT owner_key, last_sequence, reconciled_sequence, state FROM runtime_hosts",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        defaults,
        ("implicit".to_owned(), 0, None, "unknown".to_owned())
    );
    conn.execute(
        "INSERT INTO runtime_host_events (host_ref, sequence, kind, recorded_at)
         VALUES ('local', 1, 'workspace_opened', 'now')",
        [],
    )
    .unwrap();
    for sql in [
        "INSERT INTO runtime_host_events (host_ref, sequence, kind, recorded_at)
         VALUES ('local', 1, 'workspace_closed', 'now')",
        "INSERT INTO runtime_host_events (host_ref, sequence, kind, recorded_at)
         VALUES ('local', 2, 'activity_changed', 'now')",
        "UPDATE runtime_hosts SET state = 'invalid'",
    ] {
        assert!(conn.execute(sql, []).is_err(), "{sql}");
    }
    conn.execute(
        "INSERT INTO runtime_host_events (host_ref, sequence, kind, recorded_at)
         VALUES ('ssh:devbox', 1, 'snapshot_reconciled', 'now')",
        [],
    )
    .unwrap();
}
