use super::*;

#[test]
fn host_journal_cursors_skip_activity_and_repeated_states() {
    let mut storage = Storage::open_in_memory().unwrap();
    let owner = OwnerKey::implicit();
    let host = HostRef::Local;
    assert_eq!(
        storage
            .set_host_state(&owner, &host, HostState::Online)
            .unwrap(),
        Some(1)
    );
    assert_eq!(
        storage
            .set_host_state(&owner, &host, HostState::Online)
            .unwrap(),
        None
    );
    assert_eq!(
        storage
            .append_host_event(&RuntimeEvent {
                owner_key: owner.clone(),
                host_ref: host.clone(),
                kind: RuntimeEventKind::ActivityChanged,
            })
            .unwrap(),
        None
    );
    storage.mark_host_reconciled(&owner, &host).unwrap();
    storage
        .set_host_state(&owner, &host, HostState::Unknown)
        .unwrap();
    storage
        .set_host_state(&owner, &host, HostState::Offline)
        .unwrap();
    assert_eq!(
        storage.host_cursor(&owner, &host).unwrap(),
        HostCursor {
            last_sequence: 4,
            reconciled_sequence: Some(2),
            state: HostState::Offline,
        }
    );
    let rows = storage
        .conn
        .prepare(
            "SELECT sequence, kind FROM runtime_host_events
         WHERE owner_key = 'implicit' AND host_ref = 'local' ORDER BY sequence",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(
        rows,
        [
            (1, "online".to_owned()),
            (2, "snapshot_reconciled".to_owned()),
            (3, "unknown".to_owned()),
            (4, "offline".to_owned()),
        ]
    );
    assert_eq!(
        storage
            .host_cursor(&owner, &HostRef::Ssh("devbox".to_owned()))
            .unwrap(),
        HostCursor {
            last_sequence: 0,
            reconciled_sequence: None,
            state: HostState::Unknown
        }
    );
}
