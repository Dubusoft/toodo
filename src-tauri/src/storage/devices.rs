//! Devices of `toodo-server` and the hashes of their access tokens.

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row};

use super::{Result, Storage, StorageError};
use crate::domain::device::{Device, DeviceId, DeviceLabel, LAST_SEEN_PRECISION};

const COLUMNS: &str = "id, label, created_at, last_seen_at, revoked_at";

fn device(row: &Row<'_>) -> rusqlite::Result<Device> {
    let label: String = row.get(1)?;
    let label = DeviceLabel::parse(&label).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
    })?;
    Ok(Device {
        id: DeviceId(row.get(0)?),
        label,
        created_at: row.get(2)?,
        last_seen_at: row.get(3)?,
        revoked_at: row.get(4)?,
    })
}

fn find(conn: &Connection, id: DeviceId) -> Result<Device> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM devices WHERE id = ?1"),
        [id.0],
        device,
    )
    .optional()?
    .ok_or(StorageError::DeviceNotFound(id))
}

impl Storage {
    /// Adds a device whose access token hashes to `token_hash`; it counts as seen now.
    pub fn create_device(&mut self, label: &DeviceLabel, token_hash: &str) -> Result<Device> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO devices (label, token_hash, created_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?3)",
            rusqlite::params![label.as_str(), token_hash, at],
        )?;
        let device = find(&tx, DeviceId(tx.last_insert_rowid()))?;
        tx.commit()?;
        Ok(device)
    }

    /// Every device, revoked ones last, then the most recently seen first.
    pub fn list_devices(&self) -> Result<Vec<Device>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM devices
             ORDER BY revoked_at IS NOT NULL, last_seen_at DESC, id DESC"
        ))?;
        let devices = statement
            .query_map([], device)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(devices)
    }

    /// The device that is not revoked and whose token hashes to `token_hash`, marked as
    /// seen now (once its last-seen time is [`LAST_SEEN_PRECISION`] seconds old).
    pub fn authenticate_device(&mut self, token_hash: &str) -> Result<Option<Device>> {
        let at = self.now();
        let found = self
            .conn
            .query_row(
                &format!(
                    "SELECT {COLUMNS} FROM devices WHERE token_hash = ?1 AND revoked_at IS NULL"
                ),
                [token_hash],
                device,
            )
            .optional()?;
        let Some(mut device) = found else {
            return Ok(None);
        };
        if at - device.last_seen_at >= LAST_SEEN_PRECISION {
            self.conn.execute(
                "UPDATE devices SET last_seen_at = ?2 WHERE id = ?1",
                [device.id.0, at],
            )?;
            device.last_seen_at = at;
        }
        Ok(Some(device))
    }

    /// Revokes the device's token for good, and drops its push subscription. Revoking it
    /// again keeps the first time.
    pub fn revoke_device(&mut self, id: DeviceId) -> Result<Device> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE devices SET revoked_at = coalesce(revoked_at, ?2) WHERE id = ?1",
            [id.0, at],
        )?;
        tx.execute(
            "DELETE FROM push_subscriptions WHERE device_id = ?1",
            [id.0],
        )?;
        let device = find(&tx, id)?;
        tx.commit()?;
        Ok(device)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;

    const PHONE: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const LAPTOP: &str = "0000000000000000000000000000000000000000000000000000000000000002";

    fn storage() -> (Storage, Arc<AtomicI64>) {
        let mut storage = Storage::open_in_memory().unwrap();
        let clock = Arc::new(AtomicI64::new(1_000));
        let now = clock.clone();
        storage.set_clock(move || now.load(Ordering::SeqCst));
        (storage, clock)
    }

    fn label(name: &str) -> DeviceLabel {
        DeviceLabel::parse(name).unwrap()
    }

    #[test]
    fn a_device_authenticates_by_its_token_hash_until_it_is_revoked() {
        let (mut storage, clock) = storage();
        let phone = storage.create_device(&label("Phone"), PHONE).unwrap();
        let laptop = storage.create_device(&label("Laptop"), LAPTOP).unwrap();
        assert_eq!(
            (phone.created_at, phone.last_seen_at, phone.revoked_at),
            (1_000, 1_000, None)
        );

        assert_eq!(
            storage.authenticate_device(PHONE).unwrap(),
            Some(phone.clone())
        );
        assert_eq!(storage.authenticate_device(&"f".repeat(64)).unwrap(), None);

        clock.store(2_000, Ordering::SeqCst);
        let revoked = storage.revoke_device(phone.id).unwrap();
        assert_eq!(revoked.revoked_at, Some(2_000));
        assert_eq!(storage.authenticate_device(PHONE).unwrap(), None);
        assert_eq!(
            storage.authenticate_device(LAPTOP).unwrap().unwrap().id,
            laptop.id
        );

        clock.store(3_000, Ordering::SeqCst);
        assert_eq!(
            storage.revoke_device(phone.id).unwrap().revoked_at,
            Some(2_000)
        );
        assert!(matches!(
            storage.revoke_device(DeviceId(99)),
            Err(StorageError::DeviceNotFound(DeviceId(99)))
        ));
    }

    #[test]
    fn last_seen_moves_only_once_it_is_stale() {
        let (mut storage, clock) = storage();
        let phone = storage.create_device(&label("Phone"), PHONE).unwrap();

        clock.store(1_000 + LAST_SEEN_PRECISION - 1, Ordering::SeqCst);
        storage.authenticate_device(PHONE).unwrap();
        assert_eq!(storage.list_devices().unwrap()[0].last_seen_at, 1_000);

        clock.store(1_000 + LAST_SEEN_PRECISION, Ordering::SeqCst);
        let seen = storage.authenticate_device(PHONE).unwrap().unwrap();
        assert_eq!(seen.last_seen_at, 1_000 + LAST_SEEN_PRECISION);
        assert_eq!(storage.list_devices().unwrap(), [seen]);
        assert_eq!(phone.created_at, 1_000);
    }

    #[test]
    fn devices_are_listed_active_first_then_by_last_seen() {
        let (mut storage, clock) = storage();
        let phone = storage.create_device(&label("Phone"), PHONE).unwrap();
        clock.store(1_100, Ordering::SeqCst);
        let laptop = storage.create_device(&label("Laptop"), LAPTOP).unwrap();
        let names = |storage: &Storage| {
            storage
                .list_devices()
                .unwrap()
                .into_iter()
                .map(|device| device.label.as_str().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&storage), ["Laptop", "Phone"]);
        storage.revoke_device(laptop.id).unwrap();
        assert_eq!(names(&storage), ["Phone", "Laptop"]);
        assert_eq!(storage.list_devices().unwrap()[0].id, phone.id);
    }

    #[test]
    fn a_token_hash_belongs_to_one_device() {
        let (mut storage, _) = storage();
        storage.create_device(&label("Phone"), PHONE).unwrap();
        assert!(matches!(
            storage.create_device(&label("Other"), PHONE),
            Err(StorageError::Sqlite(_))
        ));
        assert_eq!(storage.list_devices().unwrap().len(), 1);
    }
}
