//! OAuth persistence. Only SHA-256 digests of credentials reach this module.

use rusqlite::{OptionalExtension, Row, params};

use super::{Result, Storage, StorageError};
use crate::oauth::{OwnerKey, Scopes};

#[derive(Clone, Debug)]
pub struct Client {
    pub client_id: String,
    pub secret_hash: Option<String>,
    pub client_name: Option<String>,
    pub redirect_uris: Vec<String>,
    pub auth_method: String,
    pub created_at: i64,
}

#[derive(Clone, Debug)]
pub struct Grant {
    pub id: i64,
    pub owner_key: OwnerKey,
    pub client_id: String,
    pub client_name: Option<String>,
    pub scopes: Scopes,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

fn grant(row: &Row<'_>) -> rusqlite::Result<Grant> {
    let scopes: String = row.get(4)?;
    Ok(Grant {
        id: row.get(0)?,
        owner_key: OwnerKey(row.get(1)?),
        client_id: row.get(2)?,
        client_name: row.get(3)?,
        scopes: Scopes::parse(Some(&scopes)).map_err(|_| rusqlite::Error::InvalidQuery)?,
        created_at: row.get(5)?,
        last_used_at: row.get(6)?,
    })
}

const GRANT_COLUMNS: &str =
    "g.id, g.owner_key, g.client_id, g.client_name, g.scopes, g.created_at, g.last_used_at";

impl Storage {
    /// Inserts a registered client and bounds clients without a live grant to 200.
    pub fn oauth_register_client(&mut self, client: &Client) -> Result<()> {
        let at = self.now();
        let redirects = serde_json::to_string(&client.redirect_uris)
            .map_err(|e| StorageError::InvalidData(e.to_string()))?;
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO oauth_clients VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                client.client_id,
                client.secret_hash,
                client.client_name,
                redirects,
                client.auth_method,
                client.created_at
            ],
        )?;
        tx.execute(
            "DELETE FROM oauth_clients WHERE client_id IN (
                SELECT c.client_id FROM oauth_clients c WHERE NOT EXISTS (
                    SELECT 1 FROM oauth_grants g JOIN oauth_tokens t ON t.grant_id = g.id
                    WHERE g.client_id = c.client_id AND g.revoked_at IS NULL
                    AND t.expires_at > ?1 AND t.used_at IS NULL)
                ORDER BY c.created_at DESC, c.rowid DESC LIMIT -1 OFFSET 200)",
            [at],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn oauth_client(&self, id: &str) -> Result<Option<Client>> {
        Ok(self
            .conn
            .query_row(
                "SELECT client_id, secret_hash, client_name, redirect_uris, auth_method, created_at
             FROM oauth_clients WHERE client_id = ?1",
                [id],
                |row| {
                    let redirects: String = row.get(3)?;
                    Ok(Client {
                        client_id: row.get(0)?,
                        secret_hash: row.get(1)?,
                        client_name: row.get(2)?,
                        redirect_uris: serde_json::from_str(&redirects)
                            .map_err(|_| rusqlite::Error::InvalidQuery)?,
                        auth_method: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// Creates the grant and its first token pair atomically.
    pub fn oauth_create_grant(
        &mut self,
        owner: &OwnerKey,
        client: &Client,
        scopes: Scopes,
        access_hash: &str,
        refresh_hash: &str,
    ) -> Result<i64> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO oauth_grants (owner_key, client_id, client_name, scopes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                owner.0,
                client.client_id,
                client.client_name,
                scopes.to_string(),
                at
            ],
        )?;
        let id = tx.last_insert_rowid();
        insert_pair(&tx, id, access_hash, refresh_hash, at)?;
        tx.commit()?;
        Ok(id)
    }

    /// Resolves live access and records use. Refresh credentials never authenticate MCP.
    pub fn oauth_access(&mut self, hash: &str) -> Result<Option<Grant>> {
        let at = self.now();
        let found = self
            .conn
            .query_row(
                &format!(
                    "SELECT {GRANT_COLUMNS} FROM oauth_grants g
                JOIN oauth_tokens t ON t.grant_id = g.id WHERE t.token_hash = ?1
                AND t.kind = 'access' AND t.expires_at > ?2 AND g.revoked_at IS NULL"
                ),
                params![hash, at],
                grant,
            )
            .optional()?;
        if let Some(g) = &found {
            self.conn.execute(
                "UPDATE oauth_grants SET last_used_at = ?2 WHERE id = ?1
                 AND (last_used_at IS NULL OR last_used_at <= ?2 - 60)",
                params![g.id, at],
            )?;
        }
        Ok(found)
    }

    /// Rotates a refresh credential under one transaction; a replay revokes its family.
    pub fn oauth_rotate(
        &mut self,
        hash: &str,
        client_id: &str,
        requested: Option<Scopes>,
        access_hash: &str,
        refresh_hash: &str,
    ) -> Result<RefreshResult> {
        let at = self.now();
        let tx = self.conn.transaction()?;
        let found = tx
            .query_row(
                &format!(
                    "SELECT {GRANT_COLUMNS}, t.used_at, t.expires_at FROM oauth_grants g
                JOIN oauth_tokens t ON t.grant_id = g.id
                WHERE t.token_hash = ?1 AND t.kind = 'refresh'
                AND g.client_id = ?2 AND g.revoked_at IS NULL"
                ),
                params![hash, client_id],
                |row| {
                    Ok((
                        grant(row)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, i64>(8)?,
                    ))
                },
            )
            .optional()?;
        let Some((g, used, expires)) = found else {
            return Ok(RefreshResult::Invalid);
        };
        if used.is_some() {
            tx.execute(
                "UPDATE oauth_grants SET revoked_at = ?2 WHERE id = ?1",
                params![g.id, at],
            )?;
            tx.commit()?;
            return Ok(RefreshResult::Invalid);
        }
        if expires <= at {
            return Ok(RefreshResult::Invalid);
        }
        let scopes = requested.unwrap_or(g.scopes);
        if !scopes.is_subset_of(g.scopes) {
            return Ok(RefreshResult::InvalidScope);
        }
        tx.execute(
            "UPDATE oauth_tokens SET used_at = ?2 WHERE token_hash = ?1",
            params![hash, at],
        )?;
        // Scopes live on the grant, so narrowing also removes privilege from older access tokens.
        tx.execute(
            "UPDATE oauth_grants SET scopes = ?2 WHERE id = ?1",
            params![g.id, scopes.to_string()],
        )?;
        insert_pair(&tx, g.id, access_hash, refresh_hash, at)?;
        tx.commit()?;
        Ok(RefreshResult::Issued(scopes))
    }

    pub fn oauth_revoke_grant(&mut self, id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE oauth_grants SET revoked_at = coalesce(revoked_at, ?2) WHERE id = ?1",
            params![id, self.now()],
        )?;
        Ok(())
    }

    pub fn oauth_revoke_token(&mut self, hash: &str, client_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE oauth_grants SET revoked_at = coalesce(revoked_at, ?3)
             WHERE client_id = ?2 AND id IN
             (SELECT grant_id FROM oauth_tokens WHERE token_hash = ?1)",
            params![hash, client_id, self.now()],
        )?;
        Ok(())
    }

    pub fn oauth_list_grants(&self) -> Result<Vec<Grant>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {GRANT_COLUMNS} FROM oauth_grants g WHERE revoked_at IS NULL
             AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id
                         AND t.expires_at > ?1 AND t.used_at IS NULL)
             ORDER BY g.created_at DESC, g.id DESC"
        ))?;
        Ok(stmt
            .query_map([self.now()], grant)?
            .collect::<rusqlite::Result<_>>()?)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum RefreshResult {
    Issued(Scopes),
    Invalid,
    InvalidScope,
}

fn insert_pair(
    tx: &rusqlite::Transaction<'_>,
    id: i64,
    access: &str,
    refresh: &str,
    at: i64,
) -> Result<()> {
    tx.execute(
        "INSERT INTO oauth_tokens (token_hash, grant_id, kind, expires_at)
         VALUES (?1, ?2, 'access', ?3), (?4, ?2, 'refresh', ?5)",
        params![access, id, at + 3600, refresh, at + 30 * 86400],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::hash;

    fn client(id: &str) -> Client {
        Client {
            client_id: id.to_owned(),
            secret_hash: Some(hash("client-secret")),
            client_name: Some("Example".to_owned()),
            redirect_uris: vec!["https://client.example/callback".to_owned()],
            auth_method: "client_secret_post".to_owned(),
            created_at: 1000,
        }
    }

    fn storage() -> Storage {
        let mut storage = Storage::open_in_memory().unwrap();
        storage.set_clock(|| 1000);
        storage
    }

    #[test]
    fn oauth_credentials_are_hashes_and_access_records_last_use() {
        let mut storage = storage();
        let c = client("client");
        storage.oauth_register_client(&c).unwrap();
        let id = storage
            .oauth_create_grant(
                &OwnerKey("owner-from-resolver".to_owned()),
                &c,
                Scopes::ALL,
                &hash("access-secret"),
                &hash("refresh-secret"),
            )
            .unwrap();
        let stored: String = storage
            .conn
            .query_row("SELECT secret_hash FROM oauth_clients", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(stored, hash("client-secret"));
        let hashes = storage
            .conn
            .prepare("SELECT token_hash FROM oauth_tokens")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(hashes.len(), 2);
        assert!(hashes.contains(&hash("access-secret")));
        assert!(hashes.contains(&hash("refresh-secret")));
        assert!(storage.oauth_access("access-secret").unwrap().is_none());
        let g = storage
            .oauth_access(&hash("access-secret"))
            .unwrap()
            .unwrap();
        assert_eq!(g.owner_key, OwnerKey("owner-from-resolver".to_owned()));
        assert_eq!(g.id, id);
        assert_eq!(
            storage.oauth_list_grants().unwrap()[0].last_used_at,
            Some(1000)
        );
        storage.set_clock(|| 4600);
        assert!(
            storage
                .oauth_access(&hash("access-secret"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn oauth_registration_bounds_orphans_but_preserves_live_clients() {
        let mut storage = storage();
        let c = client("live");
        storage.oauth_register_client(&c).unwrap();
        storage
            .oauth_create_grant(&OwnerKey("owner".to_owned()), &c, Scopes::ALL, "a", "r")
            .unwrap();
        for n in 0..201 {
            storage
                .oauth_register_client(&client(&format!("orphan-{n}")))
                .unwrap();
        }
        assert!(storage.oauth_client("live").unwrap().is_some());
        assert!(storage.oauth_client("orphan-0").unwrap().is_none());
        assert!(storage.oauth_client("orphan-200").unwrap().is_some());
        let count: i64 = storage
            .conn
            .query_row("SELECT count(*) FROM oauth_clients", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 201);
    }

    #[test]
    fn oauth_rotation_replay_revokes_all_tokens_and_narrowing_is_atomic() {
        let mut storage = storage();
        let c = client("client");
        storage
            .oauth_create_grant(&OwnerKey("owner".to_owned()), &c, Scopes::READ, "a", "r")
            .unwrap();
        assert_eq!(
            storage
                .oauth_rotate("r", "other-client", None, "a2", "r2")
                .unwrap(),
            RefreshResult::Invalid
        );
        assert_eq!(
            storage
                .oauth_rotate("r", "client", Some(Scopes::ALL), "a2", "r2")
                .unwrap(),
            RefreshResult::InvalidScope
        );
        assert_eq!(
            storage
                .oauth_rotate("r", "client", None, "a2", "r2")
                .unwrap(),
            RefreshResult::Issued(Scopes::READ)
        );
        assert!(storage.oauth_access("a2").unwrap().is_some());
        assert_eq!(
            storage
                .oauth_rotate("r", "client", None, "a3", "r3")
                .unwrap(),
            RefreshResult::Invalid
        );
        assert!(storage.oauth_access("a").unwrap().is_none());
        assert!(storage.oauth_access("a2").unwrap().is_none());
        assert!(storage.oauth_list_grants().unwrap().is_empty());
    }
}
