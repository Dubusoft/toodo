//! Devices of `toodo-server` and the hashes of their access tokens.

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row};

use super::{Result, Storage, StorageError};
use crate::domain::device::{
    Device, DeviceId, DeviceLabel, DeviceScope, LAST_SEEN_PRECISION, expiry,
};

const COLUMNS: &str = "id, label, created_at, last_seen_at, revoked_at, expires_at, scope";

fn device(row: &Row<'_>) -> rusqlite::Result<Device> {
    let label: String = row.get(1)?;
    let label = DeviceLabel::parse(&label).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
    })?;
    let scope: String = row.get(6)?;
    let scope = DeviceScope::parse(&scope).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            6,
            Type::Text,
            format!("unknown device scope {scope:?}").into(),
        )
    })?;
    Ok(Device {
        id: DeviceId(row.get(0)?),
        label,
        created_at: row.get(2)?,
        last_seen_at: row.get(3)?,
        revoked_at: row.get(4)?,
        expires_at: row.get(5)?,
        scope,
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

/// What a token hash stands for, see [`Storage::authenticate_device`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceAuth {
    /// The token of an active device. `seen_is_stale` tells that its last-seen time is
    /// [`LAST_SEEN_PRECISION`] seconds old, so [`Storage::mark_device_seen`] should move it.
    Active { device: Device, seen_is_stale: bool },
    /// The token of a device that is not revoked but has expired.
    Expired(Device),
    /// No device that is not revoked has this token.
    Unknown,
}

impl Storage {
    /// Adds a device whose access token hashes to `token_hash`, with `scope`, expiring
    /// `lifetime_days` days from now (never for `None`); it counts as seen now.
    pub fn create_device(
        &mut self,
        label: &DeviceLabel,
        token_hash: &str,
        scope: DeviceScope,
        lifetime_days: Option<u32>,
    ) -> Result<Device> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO devices (label, token_hash, created_at, last_seen_at, expires_at, scope)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5)",
            rusqlite::params![
                label.as_str(),
                token_hash,
                at,
                expiry(at, lifetime_days),
                scope.as_str()
            ],
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

    /// The device whose token hashes to `token_hash`, as of now. It only reads, so it
    /// runs on a read-only connection and leaves moving the last-seen time to
    /// [`Storage::mark_device_seen`].
    pub fn authenticate_device(&self, token_hash: &str) -> Result<DeviceAuth> {
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
        Ok(match found {
            None => DeviceAuth::Unknown,
            Some(device) if device.is_expired_at(at) => DeviceAuth::Expired(device),
            Some(device) => DeviceAuth::Active {
                seen_is_stale: at - device.last_seen_at >= LAST_SEEN_PRECISION,
                device,
            },
        })
    }

    /// Marks the device as seen now, once its last-seen time is [`LAST_SEEN_PRECISION`]
    /// seconds old; requests that race to it write it once.
    pub fn mark_device_seen(&mut self, id: DeviceId) -> Result<()> {
        self.conn.execute(
            "UPDATE devices SET last_seen_at = ?2 WHERE id = ?1 AND last_seen_at <= ?2 - ?3",
            [id.0, self.now(), LAST_SEEN_PRECISION],
        )?;
        Ok(())
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
    const DAY: i64 = 86_400;

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

    fn add(storage: &mut Storage, name: &str, hash: &str) -> Device {
        storage
            .create_device(&label(name), hash, DeviceScope::Full, None)
            .unwrap()
    }

    fn active(storage: &Storage, hash: &str) -> Option<Device> {
        match storage.authenticate_device(hash).unwrap() {
            DeviceAuth::Active { device, .. } => Some(device),
            _ => None,
        }
    }

    #[test]
    fn a_device_authenticates_by_its_token_hash_until_it_is_revoked() {
        let (mut storage, clock) = storage();
        let phone = add(&mut storage, "Phone", PHONE);
        let laptop = add(&mut storage, "Laptop", LAPTOP);
        assert_eq!(
            (phone.created_at, phone.last_seen_at, phone.revoked_at),
            (1_000, 1_000, None)
        );
        assert_eq!((phone.expires_at, phone.scope), (None, DeviceScope::Full));

        assert_eq!(
            storage.authenticate_device(PHONE).unwrap(),
            DeviceAuth::Active {
                device: phone.clone(),
                seen_is_stale: false
            }
        );
        assert_eq!(
            storage.authenticate_device(&"f".repeat(64)).unwrap(),
            DeviceAuth::Unknown
        );

        clock.store(2_000, Ordering::SeqCst);
        let revoked = storage.revoke_device(phone.id).unwrap();
        assert_eq!(revoked.revoked_at, Some(2_000));
        assert_eq!(
            storage.authenticate_device(PHONE).unwrap(),
            DeviceAuth::Unknown
        );
        assert_eq!(active(&storage, LAPTOP).unwrap().id, laptop.id);

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
    fn a_token_stops_working_once_its_lifetime_is_over() {
        let (mut storage, clock) = storage();
        let phone = storage
            .create_device(&label("Phone"), PHONE, DeviceScope::ReadOnly, Some(2))
            .unwrap();
        assert_eq!(phone.expires_at, Some(1_000 + 2 * DAY));
        assert_eq!(phone.scope, DeviceScope::ReadOnly);
        assert_eq!(
            storage.list_devices().unwrap(),
            std::slice::from_ref(&phone)
        );

        clock.store(1_000 + 2 * DAY - 1, Ordering::SeqCst);
        assert_eq!(active(&storage, PHONE).unwrap().id, phone.id);
        clock.store(1_000 + 2 * DAY, Ordering::SeqCst);
        assert_eq!(
            storage.authenticate_device(PHONE).unwrap(),
            DeviceAuth::Expired(phone)
        );
    }

    #[test]
    fn last_seen_moves_only_once_it_is_stale() {
        let (mut storage, clock) = storage();
        let phone = add(&mut storage, "Phone", PHONE);

        clock.store(1_000 + LAST_SEEN_PRECISION - 1, Ordering::SeqCst);
        assert!(matches!(
            storage.authenticate_device(PHONE).unwrap(),
            DeviceAuth::Active {
                seen_is_stale: false,
                ..
            }
        ));
        storage.mark_device_seen(phone.id).unwrap();
        assert_eq!(storage.list_devices().unwrap()[0].last_seen_at, 1_000);

        clock.store(1_000 + LAST_SEEN_PRECISION, Ordering::SeqCst);
        assert!(matches!(
            storage.authenticate_device(PHONE).unwrap(),
            DeviceAuth::Active {
                seen_is_stale: true,
                ..
            }
        ));
        storage.mark_device_seen(phone.id).unwrap();
        let seen = active(&storage, PHONE).unwrap();
        assert_eq!(seen.last_seen_at, 1_000 + LAST_SEEN_PRECISION);
        assert_eq!(storage.list_devices().unwrap(), [seen]);

        // A second request that saw the same stale time does not move it again.
        clock.store(1_000 + LAST_SEEN_PRECISION + 1, Ordering::SeqCst);
        storage.mark_device_seen(phone.id).unwrap();
        assert_eq!(
            storage.list_devices().unwrap()[0].last_seen_at,
            1_000 + LAST_SEEN_PRECISION
        );
    }

    #[test]
    fn devices_are_listed_active_first_then_by_last_seen() {
        let (mut storage, clock) = storage();
        let phone = add(&mut storage, "Phone", PHONE);
        clock.store(1_100, Ordering::SeqCst);
        let laptop = add(&mut storage, "Laptop", LAPTOP);
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
        add(&mut storage, "Phone", PHONE);
        assert!(matches!(
            storage.create_device(&label("Other"), PHONE, DeviceScope::Full, None),
            Err(StorageError::Sqlite(_))
        ));
        assert_eq!(storage.list_devices().unwrap().len(), 1);
    }
}
