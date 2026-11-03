//! Web Push subscriptions of devices and their notification settings.

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{Result, Storage, StorageError};
use crate::domain::device::DeviceId;
use crate::domain::push::{PushEndpoint, PushSettings, PushSubscription, subscription_keys};

const COLUMNS: &str =
    "device_id, endpoint, p256dh, auth, agent, pull_requests, completion, created_at";

fn subscription(row: &Row<'_>) -> rusqlite::Result<PushSubscription> {
    let invalid = |column: usize, error: Box<dyn std::error::Error + Send + Sync>| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Blob, error)
    };
    let endpoint: String = row.get(1)?;
    let endpoint = PushEndpoint::parse(&endpoint).map_err(|error| invalid(1, Box::new(error)))?;
    let p256dh: Vec<u8> = row.get(2)?;
    let auth: Vec<u8> = row.get(3)?;
    let (p256dh, auth) =
        subscription_keys(&p256dh, &auth).map_err(|error| invalid(2, Box::new(error)))?;
    Ok(PushSubscription {
        device: DeviceId(row.get(0)?),
        endpoint,
        p256dh,
        auth,
        settings: PushSettings {
            agent: row.get(4)?,
            pull_requests: row.get(5)?,
            completion: row.get(6)?,
        },
        created_at: row.get(7)?,
    })
}

fn find(conn: &Connection, device: DeviceId) -> Result<Option<PushSubscription>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM push_subscriptions WHERE device_id = ?1"),
            [device.0],
            subscription,
        )
        .optional()?)
}

/// What a device subscribes with: its push service URL and its keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPushSubscription {
    pub endpoint: PushEndpoint,
    pub p256dh: [u8; crate::domain::push::P256DH_LEN],
    pub auth: [u8; crate::domain::push::AUTH_LEN],
}

impl Storage {
    /// Subscribes the device, replacing its earlier subscription but keeping its settings.
    /// An endpoint another device had (the same browser signed in again as a new device)
    /// moves to this one.
    pub fn save_push_subscription(
        &mut self,
        device: DeviceId,
        new: &NewPushSubscription,
    ) -> Result<PushSubscription> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let active: bool = tx
            .query_row(
                "SELECT revoked_at IS NULL FROM devices WHERE id = ?1",
                [device.0],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StorageError::DeviceNotFound(device))?;
        if !active {
            return Err(StorageError::DeviceNotFound(device));
        }
        tx.execute(
            "DELETE FROM push_subscriptions WHERE endpoint = ?1 AND device_id <> ?2",
            params![new.endpoint.as_str(), device.0],
        )?;
        tx.execute(
            "INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint,
                 p256dh = excluded.p256dh, auth = excluded.auth,
                 created_at = excluded.created_at",
            params![
                device.0,
                new.endpoint.as_str(),
                &new.p256dh[..],
                &new.auth[..],
                at
            ],
        )?;
        let saved = find(&tx, device)?.ok_or(StorageError::PushSubscriptionNotFound(device))?;
        tx.commit()?;
        Ok(saved)
    }

    pub fn push_subscription(&self, device: DeviceId) -> Result<Option<PushSubscription>> {
        find(&self.conn, device)
    }

    /// Every subscription of a device that is not revoked.
    pub fn active_push_subscriptions(&self) -> Result<Vec<PushSubscription>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {COLUMNS} FROM push_subscriptions
             WHERE device_id IN (SELECT id FROM devices WHERE revoked_at IS NULL)
             ORDER BY device_id"
        ))?;
        let subscriptions = statement
            .query_map([], subscription)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(subscriptions)
    }

    /// Unsubscribes the device; `false` when it had no subscription.
    pub fn delete_push_subscription(&mut self, device: DeviceId) -> Result<bool> {
        Ok(self.conn.execute(
            "DELETE FROM push_subscriptions WHERE device_id = ?1",
            [device.0],
        )? > 0)
    }

    /// Drops the subscription at `endpoint`, which its push service reported gone.
    pub fn delete_push_endpoint(&mut self, endpoint: &PushEndpoint) -> Result<bool> {
        Ok(self.conn.execute(
            "DELETE FROM push_subscriptions WHERE endpoint = ?1",
            [endpoint.as_str()],
        )? > 0)
    }

    pub fn set_push_settings(
        &mut self,
        device: DeviceId,
        settings: PushSettings,
    ) -> Result<PushSubscription> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE push_subscriptions SET agent = ?2, pull_requests = ?3, completion = ?4
             WHERE device_id = ?1",
            params![
                device.0,
                settings.agent,
                settings.pull_requests,
                settings.completion
            ],
        )?;
        let saved = find(&tx, device)?.ok_or(StorageError::PushSubscriptionNotFound(device))?;
        tx.commit()?;
        Ok(saved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::device::DeviceLabel;

    fn new(endpoint: &str, key: u8) -> NewPushSubscription {
        let mut p256dh = [key; 65];
        p256dh[0] = 4;
        NewPushSubscription {
            endpoint: PushEndpoint::parse(endpoint).unwrap(),
            p256dh,
            auth: [key; 16],
        }
    }

    fn storage_with_devices() -> (Storage, DeviceId, DeviceId) {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(|| 100);
        let mut device = |label: &str, hash: char| {
            storage
                .create_device(
                    &DeviceLabel::parse(label).unwrap(),
                    &hash.to_string().repeat(64),
                )
                .unwrap()
                .id
        };
        let phone = device("Phone", '1');
        let laptop = device("Laptop", '2');
        (storage, phone, laptop)
    }

    #[test]
    fn resubscribing_replaces_the_keys_and_keeps_the_settings() {
        let (mut storage, phone, _) = storage_with_devices();
        let first = storage
            .save_push_subscription(phone, &new("https://push.example/a", 1))
            .unwrap();
        assert_eq!(first.settings, PushSettings::default());
        let quiet = PushSettings {
            pull_requests: false,
            ..PushSettings::default()
        };
        storage.set_push_settings(phone, quiet).unwrap();

        let second = storage
            .save_push_subscription(phone, &new("https://push.example/b", 2))
            .unwrap();
        assert_eq!(second.endpoint.as_str(), "https://push.example/b");
        assert_eq!(second.auth, [2; 16]);
        assert_eq!(second.settings, quiet);
        assert_eq!(storage.active_push_subscriptions().unwrap(), [second]);
    }

    #[test]
    fn an_endpoint_moves_to_the_device_that_subscribes_with_it() {
        let (mut storage, phone, laptop) = storage_with_devices();
        storage
            .save_push_subscription(phone, &new("https://push.example/a", 1))
            .unwrap();
        storage
            .save_push_subscription(laptop, &new("https://push.example/a", 1))
            .unwrap();
        assert_eq!(storage.push_subscription(phone).unwrap(), None);
        assert!(storage.push_subscription(laptop).unwrap().is_some());
    }

    #[test]
    fn revoked_devices_get_no_pushes_and_cannot_subscribe() {
        let (mut storage, phone, laptop) = storage_with_devices();
        storage
            .save_push_subscription(phone, &new("https://push.example/a", 1))
            .unwrap();
        storage
            .save_push_subscription(laptop, &new("https://push.example/b", 2))
            .unwrap();
        storage.revoke_device(phone).unwrap();
        let devices: Vec<DeviceId> = storage
            .active_push_subscriptions()
            .unwrap()
            .into_iter()
            .map(|subscription| subscription.device)
            .collect();
        assert_eq!(devices, [laptop]);
        assert_eq!(storage.push_subscription(phone).unwrap(), None);
        assert!(matches!(
            storage.save_push_subscription(phone, &new("https://push.example/a", 1)),
            Err(StorageError::DeviceNotFound(id)) if id == phone
        ));
        assert!(matches!(
            storage.save_push_subscription(DeviceId(99), &new("https://push.example/c", 3)),
            Err(StorageError::DeviceNotFound(_))
        ));
    }

    #[test]
    fn unsubscribing_and_gone_endpoints_remove_the_subscription() {
        let (mut storage, phone, laptop) = storage_with_devices();
        storage
            .save_push_subscription(phone, &new("https://push.example/a", 1))
            .unwrap();
        storage
            .save_push_subscription(laptop, &new("https://push.example/b", 2))
            .unwrap();
        assert!(storage.delete_push_subscription(phone).unwrap());
        assert!(!storage.delete_push_subscription(phone).unwrap());
        assert!(
            storage
                .delete_push_endpoint(&PushEndpoint::parse("https://push.example/b").unwrap())
                .unwrap()
        );
        assert!(storage.active_push_subscriptions().unwrap().is_empty());
        assert!(matches!(
            storage.set_push_settings(phone, PushSettings::default()),
            Err(StorageError::PushSubscriptionNotFound(id)) if id == phone
        ));
    }
}
